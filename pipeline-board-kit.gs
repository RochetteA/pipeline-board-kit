/**
 * PIPELINE BOARD KIT — a Trello-style lead pipeline inside your own Google Sheet.
 *
 * One script does everything:
 *   • Builds two tabs: "Pipeline" (your working list) + "Pipeline Board" (a
 *     color-coded kanban that redraws itself — you never edit it directly).
 *   • Auto-imports new leads from your lead tab(s) — name, email, form answers —
 *     landing everyone at the first stage.
 *   • Stamps follow-up dates for you: change someone's Stage and Last Touch
 *     becomes today, Next FU becomes +2 days. A DUE flag (and ⚠ on their card)
 *     appears when a follow-up is overdue.
 *   • Optional daily ~8 AM email listing everyone who's due.
 *
 * INSTALL (10 minutes, one time):
 *   1. Open your Google Sheet → Extensions → Apps Script.
 *   2. Delete whatever is in the editor, paste this whole file, press Ctrl+S
 *      (Cmd+S on a Mac).
 *   3. Reload the spreadsheet tab in your browser.
 *   4. Use the new "Pipeline board" menu → "1. Build the board".
 *      Google will ask you to authorize — it's your own script, in your own
 *      sheet, running as you. Review and allow.
 *   5. If you filled in FORM_TABS below: menu → "2. Add checkbox columns",
 *      then "3. Turn ON automation".
 *
 * EVERYTHING you might want to change lives in the CONFIG section right below.
 * Don't edit anything past the "no edits needed below" line unless you know why.
 */

// ============================== CONFIG ======================================

var PIPELINE_TAB = 'Pipeline';
var BOARD_TAB = 'Pipeline Board';

// Your stages, in order, left to right on the board. First one = where every
// new person lands. Max 26 stages. Colors: solid = board header + stage chip,
// text = lettering on the solid, tint = the stage's column background.
var STAGES = [
  { name: 'Lead Form Fill Out',          solid: '#7E9C85', text: '#FFF8EF', tint: '#EFF3F0' },
  { name: 'Follow-Up #1',                solid: '#729377', text: '#FFF8EF', tint: '#EDF1ED' },
  { name: 'Follow-Up #2',                solid: '#5F836B', text: '#FFF8EF', tint: '#E8EEE9' },
  { name: 'Follow-Up #3',                solid: '#4B7259', text: '#FFF8EF', tint: '#E3EAE5' },
  { name: 'Sent MC FU #1',               solid: '#3E6850', text: '#FFF8EF', tint: '#E0E8E3' },
  { name: 'Sent MC FU #2',               solid: '#366049', text: '#FFF8EF', tint: '#DDE6E0' },
  { name: 'Sent MC FU #3',               solid: '#2C4F3C', text: '#FFF8EF', tint: '#DAE3DD' },
  { name: 'Watched MC FU',               solid: '#C6A664', text: '#2B1A1E', tint: '#F7F0DF' },
  { name: 'Sent Next Steps',             solid: '#A98944', text: '#FFF8EF', tint: '#F3EBD6' },
  { name: 'Sent DP Link',                solid: '#9C3B52', text: '#FFF8EF', tint: '#F5E6EA' },
  { name: 'DP Sign-Up',                  solid: '#800020', text: '#FFF8EF', tint: '#F0DCE1' },
  { name: 'DP Sign-Up then ?',           solid: '#6E2639', text: '#FFF8EF', tint: '#EDDDE1' },
  { name: 'Call Needs Rescheduling',     solid: '#6B4A54', text: '#FFF8EF', tint: '#EBE3E5' },
  { name: 'Call Scheduled',              solid: '#533945', text: '#FFF8EF', tint: '#E7DFE2' },
  { name: 'Ghost/Canceled Call',         solid: '#3E2A32', text: '#FFF8EF', tint: '#E3DCDF' },
  { name: 'Post-call Check-in',          solid: '#5A4632', text: '#FFF8EF', tint: '#EAE5DE' },
  { name: 'Downline Post-call Check-in', solid: '#463628', text: '#FFF8EF', tint: '#E6E0D8' },
  { name: 'Post-Call No-Go',             solid: '#332720', text: '#FFF8EF', tint: '#E2DCD5' },
  { name: 'My Team',                     solid: '#8A6D2F', text: '#FFF8EF', tint: '#F1EAD8' },
  { name: 'Leads Archive',               solid: '#857A7E', text: '#FFF8EF', tint: '#EDEAEB' },
];

// Stages where nobody owes a follow-up (Due? shows "—" unless you set a Next FU date)
var NO_DUE_STAGES = ['My Team', 'Leads Archive', 'Post-Call No-Go', 'Call Scheduled'];

// Headers for the form-answer columns on the Pipeline tab. ONE HEADER PER
// QUESTION on your instant form: 3 questions = 3 entries, 5 questions = 5.
// Every column position in the sheet adjusts automatically to this list.
// Generic on purpose, since everyone's form asks different questions. You can
// also just type your real questions over these header cells on the sheet later.
var ANSWER_HEADERS = ['Form Q1', 'Form Q2', 'Form Q3', 'Form Q4'];

// Days after a touch before the next follow-up is due
var FU_GAP_DAYS = 2;

// Your lead tab(s) — where new people appear in this spreadsheet (e.g. synced
// from a Meta instant form). All column numbers are 1-indexed (A=1, B=2, ...).
//   checkboxCol : empty column to hold the "→ Pipeline" checkboxes
//   nameCol / emailCol : where the person's name and email live
//   answerCols  : the form-answer columns, one per ANSWER_HEADERS entry
//                 (fewer is fine; underscores in answers become spaces)
//   firstDataRow: 2 if the tab has a header row, 1 if data starts at the top
//   autoImport  : true = every new row is added to the Pipeline automatically
//                 (when automation is ON); false = you tick the checkbox yourself
// Delete the example and add one block per lead tab. No lead tabs yet? Leave it
// empty ( var FORM_TABS = {}; ) — you can still add people by typing them in.
var FORM_TABS = {
  'My Lead Tab': { checkboxCol: 21, nameCol: 18, emailCol: 17, answerCols: [13, 14, 15, 16], firstDataRow: 2, autoImport: true },
};

// ===================== no edits needed below this line ======================

var LANDING_STAGE = STAGES[0].name;
var NUM_Q = ANSWER_HEADERS.length;
var HEADERS = ['Name', 'Email'].concat(ANSWER_HEADERS).concat(['Stage', 'Last Touch', 'Next FU', 'Due?', 'Notes']);
// Column positions all derive from how many answer columns you have:
// 1 Name | 2 Email | 3..(2+NUM_Q) answers | Stage | Last Touch | Next FU | Due? | Notes
var STAGE_COL = 3 + NUM_Q, TOUCH_COL = 4 + NUM_Q, NEXTFU_COL = 5 + NUM_Q, DUE_COL = 6 + NUM_Q, NOTES_COL = 7 + NUM_Q;
var DATA_ROWS = 1000, BOARD_ROWS = 400;
var HEADER_BG = '#366049', HEADER_TEXT = '#FFF8EF', DUE_TEXT = '#800020', DUE_BG = '#F7F0DF', INK = '#2B1A1E';

// ---------- menu ----------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Pipeline board')
    .addItem('1. Build the board', 'buildPipelineBoard')
    .addItem('2. Add checkbox columns to lead tabs', 'addCheckboxColumns')
    .addItem('3. Turn ON automation (auto-import + daily 8 AM reminder)', 'installAutomation')
    .addSeparator()
    .addItem('Sync lead tabs now', 'syncNow')
    .addItem('Send selected row to Pipeline', 'sendSelected')
    .addItem('Turn OFF automation', 'removeAutomation')
    .addToUi();
}

// ---------- build ----------

function buildPipelineBoard() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  if (STAGES.length > 26) { ui.alert('Max 26 stages — trim the STAGES list.'); return; }
  if (NUM_Q < 1 || NUM_Q > 8) { ui.alert('ANSWER_HEADERS needs 1 to 8 entries.'); return; }
  var old = [ss.getSheetByName(PIPELINE_TAB), ss.getSheetByName(BOARD_TAB)].filter(Boolean);
  if (old.length) {
    var a = ui.alert('Rebuild?', 'Tabs "' + PIPELINE_TAB + '" / "' + BOARD_TAB + '" already exist. Delete and rebuild them? ANYONE ON THE BOARD WILL BE ERASED.', ui.ButtonSet.YES_NO);
    if (a !== ui.Button.YES) return;
    old.forEach(function (s) { ss.deleteSheet(s); });
  }

  // --- Pipeline tab ---
  var pipe = ss.insertSheet(PIPELINE_TAB);
  pipe.setTabColor(HEADER_BG);
  if (pipe.getMaxColumns() > HEADERS.length) pipe.deleteColumns(HEADERS.length + 1, pipe.getMaxColumns() - HEADERS.length);
  if (pipe.getMaxRows() > DATA_ROWS) pipe.deleteRows(DATA_ROWS + 1, pipe.getMaxRows() - DATA_ROWS);
  pipe.setFrozenRows(1);
  pipe.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setBackground(HEADER_BG).setFontColor(HEADER_TEXT).setFontWeight('bold').setFontFamily('Montserrat').setVerticalAlignment('middle');
  var widths = [180, 200];
  for (var w = 0; w < NUM_Q; w++) widths.push(w === NUM_Q - 1 ? 240 : 140);
  widths = widths.concat([185, 105, 105, 70, 320]);
  widths.forEach(function (px, i) { pipe.setColumnWidth(i + 1, px); });

  var stageNames = STAGES.map(function (s) { return s.name; });
  pipe.getRange(2, STAGE_COL, DATA_ROWS - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(stageNames, true).setAllowInvalid(false).build());
  pipe.getRange(2, TOUCH_COL, DATA_ROWS - 1, 2).setNumberFormat('yyyy-mm-dd');

  var ST = colLetter(STAGE_COL - 1), TO = colLetter(TOUCH_COL - 1), NF = colLetter(NEXTFU_COL - 1);
  var pat = NO_DUE_STAGES.map(escRe).join('|');
  pipe.getRange(2, DUE_COL).setFormula(
    '=ARRAYFORMULA(IF($A$2:$A="","",IF($' + NF + '$2:$' + NF + '<>"",IF(TODAY()>=N($' + NF + '$2:$' + NF + '),"DUE",""),' +
    'IF(REGEXMATCH($' + ST + '$2:$' + ST + '&"","^(' + pat + ')$"),"—",IF(TODAY()-N($' + TO + '$2:$' + TO + ')>=' + FU_GAP_DAYS + ',"DUE","")))))');

  var rules = STAGES.map(function (s) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(s.name)
      .setBackground(s.solid).setFontColor(s.text).setBold(true)
      .setRanges([pipe.getRange(2, STAGE_COL, DATA_ROWS - 1, 1)]).build();
  });
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('DUE')
    .setBackground(DUE_BG).setFontColor(DUE_TEXT).setBold(true)
    .setRanges([pipe.getRange(2, DUE_COL, DATA_ROWS - 1, 1)]).build());
  pipe.setConditionalFormatRules(rules);

  pipe.getRange(2, DUE_COL, DATA_ROWS - 1, 1).protect().setWarningOnly(true)
    .setDescription('Due? fills itself from one formula — no need to type here.');
  pipe.getRange(1, STAGE_COL).setNote('Move someone through the pipeline by changing this dropdown — the board redraws itself. Everyone starts at "' + LANDING_STAGE + '".');
  pipe.getRange(1, NEXTFU_COL).setNote('Optional due date — set it and Due? flips to DUE that day (always wins). Blank = due ' + FU_GAP_DAYS + ' days after last touch. With automation on, changing a Stage fills these dates for you.');
  pipe.getRange(1, DUE_COL).setNote('Auto: DUE = follow-up owed. "—" = ' + NO_DUE_STAGES.join(', ') + '.');
  pipe.getRange(1, 3).setNote('Answer columns from your instant form, one per question. The headers are generic because every form asks different questions. Type your own questions right over these header cells, no code changes needed.');

  // --- Board tab ---
  var n = STAGES.length;
  var board = ss.insertSheet(BOARD_TAB);
  board.setTabColor(HEADER_BG);
  if (board.getMaxColumns() > n) board.deleteColumns(n + 1, board.getMaxColumns() - n);
  if (board.getMaxRows() > BOARD_ROWS) board.deleteRows(BOARD_ROWS + 1, board.getMaxRows() - BOARD_ROWS);
  board.setFrozenRows(2);
  var DL = colLetter(DUE_COL - 1);
  board.getRange(1, 1, 1, n).setValues([stageNames]);
  board.getRange(2, 1, 1, n).setFormulas([STAGES.map(function (_, i) {
    return '=SUMPRODUCT(--(\'' + PIPELINE_TAB + '\'!$' + ST + '$2:$' + ST + '=' + colLetter(i) + '$1))';
  })]);
  board.getRange(3, 1, 1, n).setFormulas([STAGES.map(function (_, i) {
    return '=IFERROR(FILTER(\'' + PIPELINE_TAB + '\'!$A$2:$A&IF(\'' + PIPELINE_TAB + '\'!$' + DL + '$2:$' + DL + '="DUE"," ⚠",""),' +
      '\'' + PIPELINE_TAB + '\'!$' + ST + '$2:$' + ST + '=' + colLetter(i) + '$1,\'' + PIPELINE_TAB + '\'!$A$2:$A<>""))';
  })]);
  STAGES.forEach(function (s, i) {
    board.getRange(1, i + 1).setBackground(s.solid).setFontColor(s.text).setFontWeight('bold')
      .setFontFamily('Montserrat').setFontSize(9).setHorizontalAlignment('center')
      .setVerticalAlignment('middle').setWrap(true);
    board.getRange(2, i + 1).setBackground(s.tint).setFontColor(s.text === INK ? '#8A6D2F' : s.solid)
      .setFontWeight('bold').setFontFamily('Montserrat').setHorizontalAlignment('center');
    board.getRange(3, i + 1, BOARD_ROWS - 2, 1).setBackground(s.tint).setFontColor(INK);
  });
  board.setColumnWidths(1, n, 160);
  board.setRowHeight(1, 44);
  board.setRowHeights(3, BOARD_ROWS - 2, 26);
  board.getRange(3, 1, BOARD_ROWS - 2, n).protect().setWarningOnly(true)
    .setDescription('The board redraws itself — move people via the Stage dropdown on the ' + PIPELINE_TAB + ' tab.');
  board.getRange(1, 1).setNote('This board redraws itself from the ' + PIPELINE_TAB + ' tab. To move a card, change that person\'s Stage dropdown there. ⚠ = due for a follow-up. Row 2 = count per stage.');

  ss.setActiveSheet(board);
  toast('Board built! Next: menu → "2. Add checkbox columns", then "3. Turn ON automation".');
}

function addCheckboxColumns() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var done = 0;
  Object.keys(FORM_TABS).forEach(function (title) {
    var cfg = FORM_TABS[title];
    var sheet = ss.getSheetByName(title);
    if (!sheet) return;
    while (sheet.getMaxColumns() < cfg.checkboxCol) sheet.insertColumnAfter(sheet.getMaxColumns());
    if (cfg.firstDataRow > 1) {
      sheet.getRange(1, cfg.checkboxCol).setValue('→ Pipeline').setFontWeight('bold')
        .setFontColor(HEADER_BG).setHorizontalAlignment('center');
    }
    sheet.getRange(1, cfg.checkboxCol).setNote('Tick = send this person to the Pipeline at "' + LANDING_STAGE + '".');
    sheet.getRange(cfg.firstDataRow, cfg.checkboxCol, sheet.getMaxRows() - cfg.firstDataRow + 1, 1).insertCheckboxes();
    sheet.setColumnWidth(cfg.checkboxCol, 90);
    done++;
  });
  toast(done ? 'Checkbox column ready on ' + done + ' tab(s).' : 'No FORM_TABS matched a tab name — check the CONFIG spelling.');
}

// ---------- triggers ----------

function onEdit(e) {
  if (!e || !e.range || e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;
  var sheet = e.range.getSheet();
  var name = sheet.getName();
  if (name === PIPELINE_TAB) { stampPipelineEdit(e, sheet); return; }
  var cfg = FORM_TABS[name];
  if (!cfg || e.range.getColumn() !== cfg.checkboxCol) return;
  if (e.value !== 'TRUE' && e.value !== true) return;
  var row = e.range.getRow();
  if (row < cfg.firstDataRow) return;
  sendRow(sheet, row, cfg);
}

function stampPipelineEdit(e, sheet) {
  var col = e.range.getColumn();
  var row = e.range.getRow();
  if (row < 2) return;
  if (col === STAGE_COL) {
    var stage = e.value || '';
    if (!stage) return;
    sheet.getRange(row, TOUCH_COL).setValue(dateOnly(new Date()));
    if (NO_DUE_STAGES.indexOf(stage) >= 0) sheet.getRange(row, NEXTFU_COL).clearContent();
    else sheet.getRange(row, NEXTFU_COL).setValue(addDays(dateOnly(new Date()), FU_GAP_DAYS));
  } else if (col === TOUCH_COL && e.value) {
    var touch = dateOnly(new Date(e.value));
    if (isNaN(touch)) return;
    var next = sheet.getRange(row, NEXTFU_COL).getValue();
    if (!next || (next instanceof Date && next <= touch)) {
      sheet.getRange(row, NEXTFU_COL).setValue(addDays(touch, FU_GAP_DAYS));
    }
  }
}

// ---------- adding people ----------

function extractLead(vals, cfg) {
  var pick = function (c) { return c && vals[c - 1] != null ? String(vals[c - 1]).trim() : ''; };
  var email = pick(cfg.emailCol);
  var name = cfg.nameCol ? pick(cfg.nameCol) : (pick(cfg.firstNameCol) + ' ' + pick(cfg.lastNameCol)).trim();
  if (!name || name.toLowerCase() === 'x x' || name.toLowerCase() === 'x' || name === 'full_name') name = email;
  var answers = [];
  for (var i = 0; i < NUM_Q; i++) {
    var c = (cfg.answerCols || [])[i];
    answers.push(c ? pick(c).replace(/_/g, ' ') : '');
  }
  return { name: name, email: email, answers: answers };
}

function leadRow(lead) {
  return [lead.name, lead.email].concat(lead.answers).concat([LANDING_STAGE]);
}

function existingKeys(pipe) {
  var keys = {};
  var last = pipe.getLastRow();
  if (last >= 2) {
    pipe.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
      if (String(r[0]).trim()) keys[String(r[0]).trim().toLowerCase()] = 1;
      if (String(r[1]).trim()) keys[String(r[1]).trim().toLowerCase()] = 1;
    });
  }
  return keys;
}

function nextFreeRow(pipe) {
  var last = pipe.getLastRow();
  if (last < 2) return 2;
  var colA = pipe.getRange(2, 1, last - 1, 1).getValues();
  for (var i = colA.length - 1; i >= 0; i--) {
    if (String(colA[i][0]).trim()) return i + 3;
  }
  return 2;
}

function sendRow(sheet, row, cfg) {
  var lead = extractLead(sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0], cfg);
  if (!lead.name) { toast('No name or email found on that row — nothing sent.'); return; }
  var pipe = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PIPELINE_TAB);
  if (!pipe) { toast('Pipeline tab not found — run "1. Build the board" first.'); return; }
  var keys = existingKeys(pipe);
  if (keys[lead.name.toLowerCase()] || (lead.email && keys[lead.email.toLowerCase()])) {
    toast(lead.name + ' is already on the board — not added again.');
    return;
  }
  var target = nextFreeRow(pipe);
  pipe.getRange(target, 1, 1, 3 + NUM_Q).setValues([leadRow(lead)]);
  pipe.getRange(target, NOTES_COL).setValue('Added from "' + sheet.getName() + '" ' + fmt(new Date()));
  sheet.getRange(row, cfg.checkboxCol).setValue(true);
  toast(lead.name + ' → Pipeline (' + LANDING_STAGE + ')');
}

function autoSync() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return 0;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var pipe = ss.getSheetByName(PIPELINE_TAB);
    if (!pipe) return 0;
    var keys = existingKeys(pipe);
    var added = 0;
    Object.keys(FORM_TABS).forEach(function (title) {
      var cfg = FORM_TABS[title];
      if (!cfg.autoImport) return;
      var sheet = ss.getSheetByName(title);
      if (!sheet) return;
      var lastRow = sheet.getLastRow();
      if (lastRow < cfg.firstDataRow) return;
      var vals = sheet.getRange(cfg.firstDataRow, 1, lastRow - cfg.firstDataRow + 1, sheet.getLastColumn()).getValues();
      var newRows = [], notes = [];
      vals.forEach(function (v) {
        var lead = extractLead(v, cfg);
        if (!lead.email || lead.email.indexOf('@') < 0) return;
        if (keys[lead.email.toLowerCase()] || keys[lead.name.toLowerCase()]) return;
        keys[lead.email.toLowerCase()] = 1;
        keys[lead.name.toLowerCase()] = 1;
        newRows.push(leadRow(lead));
        notes.push(['Auto-added from "' + title + '" ' + fmt(new Date())]);
      });
      if (newRows.length) {
        var start = nextFreeRow(pipe);
        pipe.getRange(start, 1, newRows.length, 3 + NUM_Q).setValues(newRows);
        pipe.getRange(start, NOTES_COL, newRows.length, 1).setValues(notes);
        added += newRows.length;
      }
    });
    if (added) toast(added + ' new lead' + (added === 1 ? '' : 's') + ' added to the Pipeline.');
    return added;
  } finally { lock.releaseLock(); }
}

// ---------- reminders ----------

function syncNow() {
  var added = autoSync();
  if (!added) toast('No new leads — Pipeline is up to date.');
}

function sendSelected() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var cfg = FORM_TABS[sheet.getName()];
  if (!cfg) { toast("This tab isn't in FORM_TABS — add it to the CONFIG first."); return; }
  var row = sheet.getActiveRange().getRow();
  if (row < cfg.firstDataRow) { toast('Select a lead row first.'); return; }
  sendRow(sheet, row, cfg);
}

function dailyDigest() {
  autoSync();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var pipe = ss.getSheetByName(PIPELINE_TAB);
  if (!pipe) return;
  var last = pipe.getLastRow();
  if (last < 2) return;
  var rows = pipe.getRange(2, 1, last - 1, NOTES_COL).getValues().filter(function (r) {
    return String(r[DUE_COL - 1]) === 'DUE' && String(r[0]).trim();
  });
  if (!rows.length) return;
  var lines = rows.map(function (r) {
    return '• ' + r[0] + (r[1] ? ' (' + r[1] + ')' : '') + ' — ' + r[STAGE_COL - 1] +
      (r[NOTES_COL - 1] ? ' — ' + r[NOTES_COL - 1] : '');
  });
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
    'Follow-ups due today (' + rows.length + ')',
    'Due on the Pipeline board this morning:\n\n' + lines.join('\n') + '\n\nOpen the board: ' + ss.getUrl());
}

function installAutomation() {
  removeAutomation(true);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.newTrigger('autoSync').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('dailyDigest').timeBased().atHour(8).everyDays(1).create();
  var added = autoSync();
  toast('Automation ON — auto-import live, daily reminder ~8 AM.' + (added ? ' Imported ' + added + ' waiting lead(s).' : ''));
}

function removeAutomation(silent) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'dailyDigest' || fn === 'autoSync') ScriptApp.deleteTrigger(t);
  });
  if (silent !== true) toast('Automation OFF — checkboxes and stage-stamping still work.');
}

// ---------- helpers ----------

function toast(msg) { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Pipeline board', 6); }
function fmt(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function dateOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
function colLetter(i) { return String.fromCharCode(65 + i); }
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
