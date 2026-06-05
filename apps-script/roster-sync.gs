/**
 * OutCycling — Volunteer Dashboard roster sync
 * ---------------------------------------------------------------------------
 * Runs inside the Google Sheet that Squarespace syncs orders into. On a timer
 * (and on edit) it copies ONLY a safe allowlist of columns into the dashboard's
 * Firebase Realtime Database. Sensitive PII (email, phone, billing address,
 * payment/financial data) is NEVER read into the payload.
 *
 * Emergency contacts and the rider's own phone are the exceptions: they ARE pulled,
 * but written ONLY to the access-restricted /restricted/emergencyContacts and
 * /restricted/riderPhones nodes (readable only by authorized volunteers/super-admins
 * per the security rules), never to /eventRoster.
 *
 * Security model: the allowlist below is the single source of truth for what
 * leaves this spreadsheet. Adding a new column to the sheet does nothing until
 * it is explicitly added here — so new PII columns cannot leak by accident.
 *
 * ── One-time setup ─────────────────────────────────────────────────────────
 * 1. In the dedicated OutCycling.org Firebase project, create a service account
 *    (IAM & Admin → Service Accounts) with the "Firebase Realtime Database Admin"
 *    role, and download its JSON key.
 * 2. In this Apps Script: Project Settings → Script Properties, add:
 *      SERVICE_ACCOUNT_JSON = <paste the entire service-account JSON>
 *      DATABASE_URL         = https://<project>-default-rtdb.firebaseio.com
 *      EVENT_ID             = default            (must match the dashboard's ?event=)
 *      SHEET_NAME           = <tab name of the orders sheet>   (optional; defaults to first sheet)
 *    NEVER commit these values to the repo; they live only in Script Properties.
 * 3. Run installTriggers() once (authorize when prompted) to schedule the sync.
 * ---------------------------------------------------------------------------
 */

// Maps a safe output field → the exact spreadsheet header it comes from.
// Only these columns are ever read into the roster. Everything else stays in the sheet.
var ALLOWLIST = {
  name:         'Product Form: Name',
  route:        'Product Form: Route',
  jerseySize:   'Product Form: Jersey Size',
  lineItemName: 'Line Item Name',
  quantity:     'Line Item Quantity',
  createdAt:    'Created at'
};

// Header for the order id (the base of each record key) and the waiver checkbox.
// NOTE: an order number is NOT unique per rider — a single checkout can register
// several people (group registration), so the key is order number + a per-registrant
// suffix when needed. See buildRoster_() for how registrants are split out.
var ORDER_HEADER  = 'Order Number';
var WAIVER_HEADER = 'Product Form: I have read and acknowledge the ride waiver at https://www.outcycling.org/terms';

// Emergency contact columns. SENSITIVE: written ONLY to the access-restricted
// /restricted/emergencyContacts node, never to /eventRoster.
var EMERGENCY_NAME_HEADER  = 'Product Form: Emergency Contact Name';
var EMERGENCY_PHONE_HEADER = 'Product Form: Emergency Contact Phone';

// Rider's own phone. SENSITIVE: written ONLY to the access-restricted
// /restricted/riderPhones node, never to /eventRoster.
var PHONE_HEADER = 'Product Form: Phone';

// Columns consulted ONLY to drop cancelled/refunded rows — never written out.
var CANCELLED_HEADER = 'Cancelled at';
var FINANCIAL_HEADER = 'Financial Status';

function props_() { return PropertiesService.getScriptProperties(); }
function prop_(k, dflt) { var v = props_().getProperty(k); return (v === null || v === '') ? dflt : v; }

/** Sanitize an order number into a valid RTDB key (no . # $ / [ ]). */
function sanitizeKey_(s) {
  return String(s).trim().replace(/[.#$/\[\]]/g, '_').replace(/\s+/g, '_');
}

/** Coerce a checkbox/text waiver cell to a boolean. */
function toBool_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === '') return false;
  return !/^(no|false|0|unchecked|n)$/.test(s);
}

/**
 * Build one safe roster record (and its restricted emergency entry) from a set of
 * spreadsheet rows that all belong to the SAME registrant, and store them under `key`.
 *
 * A single registrant can span several rows because Squarespace splits multi-line-item
 * orders across rows and the form fields live on whichever row carried them — so we merge
 * across the given rows, preferring the first non-empty value seen.
 */
function addRecord_(roster, emergency, phones, col, key, orderNumber, rows) {
  var rec = { orderNumber: orderNumber, waiver: false };
  var em = {};
  var phone = '';

  rows.forEach(function (row) {
    Object.keys(ALLOWLIST).forEach(function (field) {
      var header = ALLOWLIST[field];
      if (!(header in col)) return;
      var val = row[col[header]];
      if (val instanceof Date) val = val.toISOString();
      val = (val == null) ? '' : (typeof val === 'string' ? val.trim() : val);
      if (rec[field] == null || rec[field] === '') rec[field] = val;
    });

    if (WAIVER_HEADER in col && toBool_(row[col[WAIVER_HEADER]])) rec.waiver = true;

    // Emergency contact → restricted map only (first non-empty value wins).
    if (EMERGENCY_NAME_HEADER in col && !em.name) {
      var nm = String(row[col[EMERGENCY_NAME_HEADER]] == null ? '' : row[col[EMERGENCY_NAME_HEADER]]).trim();
      if (nm) em.name = nm;
    }
    if (EMERGENCY_PHONE_HEADER in col && !em.phone) {
      var ph = String(row[col[EMERGENCY_PHONE_HEADER]] == null ? '' : row[col[EMERGENCY_PHONE_HEADER]]).trim();
      if (ph) em.phone = ph;
    }

    // Rider's own phone → restricted map only (first non-empty value wins).
    if (PHONE_HEADER in col && !phone) {
      var rp = String(row[col[PHONE_HEADER]] == null ? '' : row[col[PHONE_HEADER]]).trim();
      if (rp) phone = rp;
    }
  });

  roster[key] = rec;
  if (em.name || em.phone) emergency[key] = em;
  if (phone) phones[key] = { phone: phone };
}

/** Read the orders sheet and build the safe roster + the restricted emergency map. */
function buildRoster_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = prop_('SHEET_NAME', null);
  var sheet = sheetName ? ss.getSheetByName(sheetName) : ss.getSheets()[0];
  if (!sheet) throw new Error('Sheet not found: ' + sheetName);

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return { roster: {}, emergency: {}, phones: {} };

  var headers = values[0].map(function (h) { return String(h).trim(); });
  var col = {};
  headers.forEach(function (h, i) { if (!(h in col)) col[h] = i; });

  if (!(ORDER_HEADER in col)) throw new Error('Missing "' + ORDER_HEADER + '" column');

  // ── Pass 1 ────────────────────────────────────────────────────────────────
  // Keep surviving rows, grouped by order number in first-seen (sheet) order.
  var orderKeys = [];                 // preserves the order in which orders appear
  var rowsByOrder = {};               // orderKey → { orderNumber, rows: [...] }
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var rawOrder = row[col[ORDER_HEADER]];
    if (rawOrder === '' || rawOrder == null) continue;

    // Drop cancelled / refunded registrations (these columns are NOT exported).
    if (CANCELLED_HEADER in col && String(row[col[CANCELLED_HEADER]]).trim() !== '') continue;
    if (FINANCIAL_HEADER in col) {
      var fin = String(row[col[FINANCIAL_HEADER]]).trim().toLowerCase();
      if (fin === 'refunded' || fin === 'voided' || fin === 'partially_refunded') continue;
    }

    var okey = sanitizeKey_(rawOrder);
    if (!(okey in rowsByOrder)) {
      rowsByOrder[okey] = { orderNumber: String(rawOrder).trim(), rows: [] };
      orderKeys.push(okey);
    }
    rowsByOrder[okey].rows.push(row);
  }

  // ── Pass 2 ────────────────────────────────────────────────────────────────
  // Emit one roster record PER REGISTRANT, not per order. A row carries a
  // registrant when it has a non-empty "Product Form: Name"; group registrations
  // (one checkout, several riders) put multiple such rows under one order number.
  // Keying by order number alone collapsed those riders into one and silently
  // dropped the rest — this splits them back out so nobody is lost.
  var nameCol = (ALLOWLIST.name in col) ? col[ALLOWLIST.name] : -1;
  var roster = {};
  var emergency = {};
  var phones = {};

  orderKeys.forEach(function (okey) {
    var grp = rowsByOrder[okey];
    var rows = grp.rows;

    // Rows that actually represent a registrant (have a name on them).
    var registrantRows = (nameCol < 0) ? [] : rows.filter(function (row) {
      return String(row[nameCol] == null ? '' : row[nameCol]).trim() !== '';
    });

    if (registrantRows.length <= 1) {
      // Zero or one registrant: one record per order, merging every row — this
      // preserves the original behaviour (and the bare order-number key, so any
      // existing check-in / jersey state stays attached) for the common case.
      addRecord_(roster, emergency, phones, col, okey, grp.orderNumber, rows);
    } else {
      // Group registration: one record per registrant row. The first registrant
      // keeps the plain order key (check-in continuity); the rest get a stable
      // "__2", "__3" … suffix so each rider has a distinct, repeatable identity.
      registrantRows.forEach(function (row, i) {
        var key = (i === 0) ? okey : okey + '__' + (i + 1);
        addRecord_(roster, emergency, phones, col, key, grp.orderNumber, [row]);
      });
    }
  });

  return { roster: roster, emergency: emergency, phones: phones };
}

/** Exchange the service-account JSON for an OAuth access token (RTDB + userinfo scopes). */
function getAccessToken_() {
  var sa = JSON.parse(prop_('SERVICE_ACCOUNT_JSON', ''));
  if (!sa || !sa.client_email) throw new Error('SERVICE_ACCOUNT_JSON script property is missing or invalid');

  var now = Math.floor(Date.now() / 1000);
  var header = Utilities.base64EncodeWebSafe(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claim = Utilities.base64EncodeWebSafe(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  var toSign = header + '.' + claim;
  var sig = Utilities.computeRsaSha256Signature(toSign, sa.private_key);
  var jwt = toSign + '.' + Utilities.base64EncodeWebSafe(sig);

  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt },
    muteHttpExceptions: true
  });
  var body = JSON.parse(res.getContentText());
  if (!body.access_token) throw new Error('Token exchange failed: ' + res.getContentText());
  return body.access_token;
}

/** PUT a value to a path in the Realtime Database. */
function rtdbPut_(token, path, value) {
  var base = prop_('DATABASE_URL', '').replace(/\/$/, '');
  if (!base) throw new Error('DATABASE_URL script property is missing');
  var url = base + '/' + path + '.json?access_token=' + encodeURIComponent(token);
  var res = UrlFetchApp.fetch(url, {
    method: 'put',
    contentType: 'application/json',
    payload: JSON.stringify(value),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('RTDB write failed (' + res.getResponseCode() + '): ' + res.getContentText());
  }
}

/** GET a path from the Realtime Database; returns the parsed value (or null). */
function rtdbGet_(token, path) {
  var base = prop_('DATABASE_URL', '').replace(/\/$/, '');
  if (!base) throw new Error('DATABASE_URL script property is missing');
  var url = base + '/' + path + '.json?access_token=' + encodeURIComponent(token);
  var res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) {
    throw new Error('RTDB read failed (' + res.getResponseCode() + '): ' + res.getContentText());
  }
  var txt = res.getContentText();
  return (txt && txt !== 'null') ? JSON.parse(txt) : null;
}

/** Append an audit-log entry via the admin token (POST to a list = push with generated key). */
function rtdbAudit_(token, eventId, action, target) {
  var base = prop_('DATABASE_URL', '').replace(/\/$/, '');
  var url = base + '/restricted/auditLog/' + eventId + '.json?access_token=' + encodeURIComponent(token);
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ ts: Date.now(), actor: 'sync', action: action, target: String(target) }),
    muteHttpExceptions: true
  });
}

/** Main entry point: build the safe roster and overwrite it in the database. */
function syncRoster() {
  var eventId = prop_('EVENT_ID', 'default');
  var built = buildRoster_();
  var roster = built.roster, emergency = built.emergency, phones = built.phones;
  var token = getAccessToken_();

  // Diff against the previous roster so we can audit-log newly added registrations.
  var prev = rtdbGet_(token, 'eventRoster/' + eventId) || {};

  // Overwrite the roster node (registrations removed from the sheet disappear here too).
  // Check-in state lives under a separate /checkins node and is untouched.
  rtdbPut_(token, 'eventRoster/' + eventId, roster);
  // Emergency contacts and rider phones go ONLY to the access-restricted nodes,
  // never to /eventRoster.
  rtdbPut_(token, 'restricted/emergencyContacts/' + eventId, emergency);
  rtdbPut_(token, 'restricted/riderPhones/' + eventId, phones);
  rtdbPut_(token, 'meta/' + eventId + '/lastSync', Date.now());
  rtdbPut_(token, 'meta/' + eventId + '/count', Object.keys(roster).length);

  // Audit-log each new rider (order key present now but not in the previous snapshot).
  Object.keys(roster).forEach(function (key) {
    if (!(key in prev)) {
      rtdbAudit_(token, eventId, 'rider_added', roster[key].name || roster[key].orderNumber || key);
    }
  });

  Logger.log('Synced %s registrations to event "%s"', Object.keys(roster).length, eventId);
}

/** onEdit installable trigger target — sync shortly after a manual edit. */
function onSheetEdit(e) { syncRoster(); }

/** Run once to schedule the sync (every 5 min + on edit). Re-runnable; clears dupes first. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncRoster' || t.getHandlerFunction() === 'onSheetEdit') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('syncRoster').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onEdit().create();
  Logger.log('Triggers installed: syncRoster (5 min) + onSheetEdit.');
}
