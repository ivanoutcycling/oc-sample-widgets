/**
 * OutCycling — Volunteer Dashboard roster sync
 * ---------------------------------------------------------------------------
 * Runs inside the Google Sheet that Squarespace syncs orders into. On a timer
 * (and on edit) it copies ONLY a safe allowlist of columns into the dashboard's
 * Firebase Realtime Database. Sensitive PII (email, phone, billing address,
 * emergency contact, payment/financial data) is NEVER read into the payload.
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
// Only these columns are ever read. Everything else stays in the sheet.
var ALLOWLIST = {
  name:         'Product Form: Name',
  route:        'Product Form: Route',
  jerseySize:   'Product Form: Jersey Size',
  lineItemName: 'Line Item Name',
  quantity:     'Line Item Quantity',
  createdAt:    'Created at'
};

// Header for the order id (used as the record key) and the waiver checkbox.
var ORDER_HEADER  = 'Order Number';
var WAIVER_HEADER = 'Product Form: I have read and acknowledge the ride waiver at https://www.outcycling.org/terms';

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

/** Read the orders sheet and build the safe roster object keyed by order number. */
function buildRoster_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = prop_('SHEET_NAME', null);
  var sheet = sheetName ? ss.getSheetByName(sheetName) : ss.getSheets()[0];
  if (!sheet) throw new Error('Sheet not found: ' + sheetName);

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return {};

  var headers = values[0].map(function (h) { return String(h).trim(); });
  var col = {};
  headers.forEach(function (h, i) { if (!(h in col)) col[h] = i; });

  if (!(ORDER_HEADER in col)) throw new Error('Missing "' + ORDER_HEADER + '" column');

  var roster = {};
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

    var key = sanitizeKey_(rawOrder);
    var rec = roster[key] || { orderNumber: String(rawOrder).trim(), waiver: false };

    // Copy only allowlisted fields; prefer the first non-empty value seen for the order
    // (Squarespace splits multi-line-item orders across rows; the registrant form fields
    // live on the row that has them).
    Object.keys(ALLOWLIST).forEach(function (field) {
      var header = ALLOWLIST[field];
      if (!(header in col)) return;
      var val = row[col[header]];
      if (val instanceof Date) val = val.toISOString();
      val = (val == null) ? '' : (typeof val === 'string' ? val.trim() : val);
      if (rec[field] == null || rec[field] === '') rec[field] = val;
    });

    if (WAIVER_HEADER in col && toBool_(row[col[WAIVER_HEADER]])) rec.waiver = true;

    roster[key] = rec;
  }
  return roster;
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

/** Main entry point: build the safe roster and overwrite it in the database. */
function syncRoster() {
  var eventId = prop_('EVENT_ID', 'default');
  var roster = buildRoster_();
  var token = getAccessToken_();
  // Overwrite the roster node (registrations removed from the sheet disappear here too).
  // Check-in state lives under a separate /checkins node and is untouched.
  rtdbPut_(token, 'eventRoster/' + eventId, roster);
  rtdbPut_(token, 'meta/' + eventId + '/lastSync', Date.now());
  rtdbPut_(token, 'meta/' + eventId + '/count', Object.keys(roster).length);
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
