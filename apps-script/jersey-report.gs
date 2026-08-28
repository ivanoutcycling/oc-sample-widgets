/**
 * OutCycling — Jersey pickup report
 * ---------------------------------------------------------------------------
 * Writes "who has received what jersey" — one row per registrant, with the size
 * they are down for and, when they have collected it, the timestamp and the
 * volunteer who handed it over — into a dedicated tab of a Google Sheet.
 *
 * Source of truth is the dashboard's Firebase Realtime Database, so the report
 * matches exactly what volunteers see:
 *     /eventRoster/{eventId}   rider name, route, registered jersey size
 *     /jerseys/{eventId}       pickup record  { pickedUp, by, at }
 *     /overrides/{eventId}     day-of size / route corrections (win over roster)
 *     /checkins/{eventId}      rider number, for cross-referencing at the table
 *
 * The report tab is REBUILT from scratch on every run; the master orders sheet
 * that Squarespace syncs into is never touched. No email, phone, billing or
 * payment data is read — the only email in the output is the volunteer's, from
 * the pickup record the dashboard already shows in its activity log.
 *
 * ── Setup ──────────────────────────────────────────────────────────────────
 * 1. Add this file to the SAME Apps Script project as roster-sync.gs — it reuses
 *    that file's prop_() / getAccessToken_() / rtdbGet_() helpers and its
 *    SERVICE_ACCOUNT_JSON, DATABASE_URL and EVENT_ID script properties.
 * 2. Optional Script Properties:
 *      JERSEY_REPORT_SHEET   tab to write   (default "Jersey Pickups"; created if missing)
 *      JERSEY_REPORT_SS_ID   spreadsheet id (default: the sheet this project is bound to)
 * 3. Run buildJerseyReport() from the editor, or reload the sheet and use
 *    OutCycling → Build jersey report. Optionally run installJerseyReportTrigger()
 *    once to also refresh it hourly.
 * ---------------------------------------------------------------------------
 */

var JR_HEADERS = [
  'Rider', 'Order #', 'Rider #', 'Route', 'Jersey size', 'Size edited',
  'Status', 'Picked up at', 'Picked up by'
];

/** roster-sync.gs must be in this project — it owns the credentials and RTDB helpers. */
function jrRequireHelpers_() {
  if (typeof prop_ !== 'function' || typeof getAccessToken_ !== 'function' || typeof rtdbGet_ !== 'function') {
    throw new Error('jersey-report.gs needs roster-sync.gs in the same Apps Script project ' +
                    '(it reuses prop_, getAccessToken_ and rtdbGet_).');
  }
}

/** The spreadsheet the report is written to. */
function jrSpreadsheet_() {
  var id = prop_('JERSEY_REPORT_SS_ID', null);
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No active spreadsheet — set the JERSEY_REPORT_SS_ID script property.');
  return ss;
}

/** ms epoch → "2026-08-28 09:41" in the spreadsheet's timezone (blank if unset). */
function jrFormatTs_(ms, tz) {
  if (!ms || typeof ms !== 'number') return '';
  return Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd HH:mm');
}

/**
 * Merge roster + overrides + pickups into report rows.
 * Riders who have collected come first, oldest pickup first (the record of the
 * day as it happened); everyone still owed a jersey follows, sorted by name.
 */
function jrBuildRows_(roster, jerseys, overrides, checkins, tz) {
  var rows = Object.keys(roster).map(function (key) {
    var r = roster[key] || {};
    var ov = overrides[key] || {};
    var j = jerseys[key] || {};
    var c = checkins[key] || {};
    var picked = j.pickedUp === true;
    var sizeOverridden = ov.jerseySize != null;

    return {
      picked: picked,
      at: (typeof j.at === 'number') ? j.at : 0,
      name: String(r.name || '(no name)'),
      cells: [
        r.name || '(no name)',
        r.orderNumber || key,
        (typeof c.number === 'number' && c.number > 0) ? c.number : '',
        (ov.route != null ? ov.route : (r.route || '')),
        (sizeOverridden ? ov.jerseySize : (r.jerseySize || '')),
        sizeOverridden ? 'yes' : '',
        picked ? 'Picked up' : 'Not picked up',
        picked ? jrFormatTs_(j.at, tz) : '',
        picked ? (j.by || '') : ''
      ]
    };
  });

  rows.sort(function (a, b) {
    if (a.picked !== b.picked) return a.picked ? -1 : 1;       // collected first
    if (a.picked) return (a.at - b.at) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });

  return rows;
}

/** Main entry point: read the records and (re)write the report tab. */
function buildJerseyReport() {
  jrRequireHelpers_();

  var eventId = prop_('EVENT_ID', 'default');
  var token = getAccessToken_();
  var roster    = rtdbGet_(token, 'eventRoster/' + eventId) || {};
  var jerseys   = rtdbGet_(token, 'jerseys/' + eventId)     || {};
  var overrides = rtdbGet_(token, 'overrides/' + eventId)   || {};
  var checkins  = rtdbGet_(token, 'checkins/' + eventId)    || {};

  var ss = jrSpreadsheet_();
  var tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  var rows = jrBuildRows_(roster, jerseys, overrides, checkins, tz);
  var pickedCount = rows.filter(function (row) { return row.picked; }).length;

  var sheetName = prop_('JERSEY_REPORT_SHEET', 'Jersey Pickups');
  var sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  sheet.clear();

  var title = 'Jersey pickups — event "' + eventId + '" — ' + pickedCount + ' of ' +
              rows.length + ' collected — generated ' + jrFormatTs_(Date.now(), tz);
  sheet.getRange(1, 1, 1, JR_HEADERS.length).merge()
       .setValue(title).setFontWeight('bold');
  sheet.getRange(2, 1, 1, JR_HEADERS.length)
       .setValues([JR_HEADERS]).setFontWeight('bold');

  if (rows.length) {
    sheet.getRange(3, 1, rows.length, JR_HEADERS.length)
         .setValues(rows.map(function (row) { return row.cells; }));
  }

  sheet.setFrozenRows(2);
  sheet.autoResizeColumns(1, JR_HEADERS.length);

  Logger.log('Jersey report: %s riders, %s picked up → "%s"', rows.length, pickedCount, sheetName);
  return { total: rows.length, pickedUp: pickedCount, sheet: sheetName };
}

/** Sheet menu: OutCycling → Build jersey report. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('OutCycling')
    .addItem('Build jersey report', 'buildJerseyReport')
    .addToUi();
}

/** Optional: refresh the report hourly. Re-runnable; clears its own duplicates first. */
function installJerseyReportTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'buildJerseyReport') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('buildJerseyReport').timeBased().everyHours(1).create();
  Logger.log('Trigger installed: buildJerseyReport (hourly).');
}
