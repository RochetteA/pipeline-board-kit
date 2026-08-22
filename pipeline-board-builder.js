#!/usr/bin/env node
/*
 * PIPELINE BOARD BUILDER
 * Builds the Pipeline Board directly inside a Google Sheet through the Google
 * Sheets API, using a service account ("robot account"). Nothing is pasted into
 * the spreadsheet, no Apps Script involved. Node 18+, zero npm packages.
 *
 * Usage:  node pipeline-board-builder.js <command> [args] [--config pipeline-config.json]
 *
 *   check                 confirm the key works + the robot can open the sheet; list tabs
 *   inspect <tab>         print a tab's header row + first data row with column numbers
 *   build [--rebuild]     create the Pipeline + Pipeline Board tabs (--rebuild wipes them first)
 *   import                pull every lead from the configured lead tabs onto the board
 *                         (safe to re-run any time: skips anyone already on the board)
 *   import-csv <file>     add people from a CSV (header row: name,email,<one column per
 *                         answer>,stage,last_touch[,next_fu,notes]); skips duplicates
 *   export <file>         save the whole Pipeline tab to a CSV (do this before a rebuild)
 *   due                   list everyone whose Due? says DUE right now
 *
 * pipeline-config.json:
 * {
 *   "spreadsheetId": "paste the sheet URL or its id",
 *   "keyFile": "service-account.json",          // the robot's key, kept in this folder
 *   "answerHeaders": ["Form Q1", "Form Q2", "Form Q3"],   // one per instant-form question
 *   "stages": [ { "name": "...", "solid": "#hex", "text": "#hex", "tint": "#hex" }, ... ],  // optional
 *   "noDue": ["My Team", "Leads Archive", "Post-Call No-Go", "Call Scheduled"],           // optional
 *   "fuGapDays": 2,                                                                        // optional
 *   "leadTabs": [ { "tab": "Instant Form", "nameCol": 18, "emailCol": 17,
 *                   "answerCols": [13, 14, 15], "firstDataRow": 2 } ]   // 1-indexed columns
 * }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ---------------------------------------------------------------- defaults
const DEFAULT_STAGES = [
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
const DEFAULT_NO_DUE = ['My Team', 'Leads Archive', 'Post-Call No-Go', 'Call Scheduled'];
const DEFAULT_ANSWERS = ['Form Q1', 'Form Q2', 'Form Q3', 'Form Q4'];
const FOREST = '#366049', CREAM = '#FFF8EF', BURGUNDY = '#800020', INK = '#2B1A1E', DUE_BG = '#F7F0DF';
const DATA_ROWS = 1000, BOARD_ROWS = 400;

// ---------------------------------------------------------------- args + config
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--config') flags.config = argv[++i];
  else if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = true;
  else positional.push(argv[i]);
}
const command = positional[0];
const configPath = path.resolve(flags.config || 'pipeline-config.json');

function fail(msg) { console.error('\n✗ ' + msg + '\n'); process.exit(1); }

function loadConfig() {
  if (!fs.existsSync(configPath)) fail('Config not found: ' + configPath + '\nCreate pipeline-config.json first (see the header of this file).');
  let c;
  try { c = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { fail('pipeline-config.json is not valid JSON: ' + e.message); }
  if (!c.spreadsheetId) fail('pipeline-config.json needs "spreadsheetId" (the sheet URL or id).');
  const m = String(c.spreadsheetId).match(/\/d\/([a-zA-Z0-9_-]+)/);
  c.spreadsheetId = m ? m[1] : String(c.spreadsheetId).trim();
  c.pipelineTab = c.pipelineTab || 'Pipeline';
  c.boardTab = c.boardTab || 'Pipeline Board';
  c.stages = (c.stages && c.stages.length) ? c.stages : DEFAULT_STAGES;
  c.noDue = c.noDue || DEFAULT_NO_DUE;
  c.answerHeaders = (c.answerHeaders && c.answerHeaders.length) ? c.answerHeaders : DEFAULT_ANSWERS;
  c.fuGapDays = c.fuGapDays || 2;
  c.leadTabs = c.leadTabs || [];
  if (c.stages.length > 26) fail('Max 26 stages.');
  if (c.answerHeaders.length < 1 || c.answerHeaders.length > 8) fail('answerHeaders needs 1 to 8 entries.');
  // derived layout (0-indexed columns)
  c.N = c.answerHeaders.length;
  c.STAGE = 2 + c.N; c.TOUCH = 3 + c.N; c.NEXTFU = 4 + c.N; c.DUE = 5 + c.N; c.NOTES = 6 + c.N; c.COLS = 7 + c.N;
  c.HEADERS = ['Name', 'Email'].concat(c.answerHeaders).concat(['Stage', 'Last Touch', 'Next FU', 'Due?', 'Notes']);
  return c;
}

function loadKey(c) {
  const keyPath = path.resolve(path.dirname(configPath), c.keyFile || 'service-account.json');
  let raw;
  if (fs.existsSync(keyPath)) raw = fs.readFileSync(keyPath, 'utf8');
  else if (process.env.GOOGLE_SHEETS_SA_JSON) raw = process.env.GOOGLE_SHEETS_SA_JSON;
  else fail('Robot key not found: ' + keyPath + '\nDownload the service account JSON key from Google Cloud and save it there.');
  let sa;
  try { sa = JSON.parse(raw); } catch (e) { fail('The key file is not valid JSON: ' + e.message); }
  if (!sa.client_email || !sa.private_key) fail('The key file is missing client_email / private_key. Download a fresh JSON key.');
  return sa;
}

// ---------------------------------------------------------------- google api
function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (ch) => (data += ch));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
let _token = null;
async function token(sa) {
  if (_token && _token.exp > Date.now() + 60000) return _token.t;
  const now = Math.floor(Date.now() / 1000);
  const input = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(input).sign(sa.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const form = 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(input + '.' + sig);
  const res = await request({ method: 'POST', host: 'oauth2.googleapis.com', path: '/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) } }, form);
  if (res.status !== 200) fail('Google rejected the robot key (' + res.status + '). Re-download the JSON key and try again.\n' + res.body);
  _token = { t: JSON.parse(res.body).access_token, exp: Date.now() + 3500 * 1000 };
  return _token.t;
}
function makeApi(sa, spreadsheetId) {
  const api = async (method, p, body) => {
    const t = await token(sa);
    const res = await request({ method, host: 'sheets.googleapis.com', path: p, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, body);
    if (res.status === 403) fail('The robot is not allowed into this spreadsheet yet.\nShare the sheet with ' + sa.client_email + ' as an EDITOR (Share button, paste that address, untick "Notify").\nIf the sheet belongs to someone else and you cannot share it, ask the owner to add that address.');
    if (res.status === 404) fail('Spreadsheet not found. Check "spreadsheetId" in pipeline-config.json (paste the full sheet URL).');
    if (res.status < 200 || res.status >= 300) fail('Google Sheets API ' + method + ' failed (' + res.status + '): ' + res.body);
    return res.body ? JSON.parse(res.body) : {};
  };
  return {
    meta: () => api('GET', `/v4/spreadsheets/${spreadsheetId}?fields=properties.title,sheets.properties(title,sheetId,gridProperties(rowCount,columnCount))`),
    get: async (range) => (await api('GET', `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`)).values || [],
    write: (data) => api('POST', `/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, JSON.stringify({ valueInputOption: 'USER_ENTERED', data })),
    structural: (requests) => api('POST', `/v4/spreadsheets/${spreadsheetId}:batchUpdate`, JSON.stringify({ requests })),
  };
}

// ---------------------------------------------------------------- helpers
function colLetter(i) { let s = '', n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function hex(h) { const n = parseInt(h.slice(1), 16); return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 }; }
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const today = () => new Date().toISOString().slice(0, 10);
const pretty = (s) => String(s == null ? '' : s).replace(/_/g, ' ').trim();

function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}
function toCsv(rows) {
  return rows.map((r) => r.map((v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n') + '\n';
}

async function pipelineRows(api, c) {
  const last = colLetter(c.COLS - 1);
  return api.get(`'${c.pipelineTab}'!A2:${last}${DATA_ROWS}`);
}
function takenKeys(rows) {
  const keys = new Set();
  rows.forEach((r) => { if ((r[0] || '').trim()) keys.add(r[0].trim().toLowerCase()); if ((r[1] || '').trim()) keys.add(r[1].trim().toLowerCase()); });
  return keys;
}
function firstFreeRow(rows) {
  let free = 2;
  rows.forEach((r, i) => { if ((r[0] || '').trim()) free = i + 3; });
  return free;
}
async function appendPeople(api, c, people) {
  if (!people.length) return { start: 0, end: 0 };
  const existing = await pipelineRows(api, c);
  const start = firstFreeRow(existing);
  const end = start + people.length - 1;
  if (end > DATA_ROWS) fail('The Pipeline tab is full (' + DATA_ROWS + ' rows).');
  const main = people.map((p) => [p.name, p.email].concat(p.answers).concat([p.stage, p.lastTouch || '', p.nextFu || '']));
  const notes = people.map((p) => [p.note || '']);
  await api.write([
    { range: `'${c.pipelineTab}'!A${start}:${colLetter(c.NEXTFU)}${end}`, values: main },
    { range: `'${c.pipelineTab}'!${colLetter(c.NOTES)}${start}:${colLetter(c.NOTES)}${end}`, values: notes },
  ]);
  return { start, end };
}

// ---------------------------------------------------------------- commands
async function cmdCheck(api, c, sa) {
  const m = await api.meta();
  console.log('\n✓ Robot key OK: ' + sa.client_email);
  console.log('✓ Spreadsheet: "' + m.properties.title + '"');
  console.log('  Tabs:');
  m.sheets.forEach((s) => console.log('   - ' + s.properties.title + ' (' + s.properties.gridProperties.rowCount + ' rows × ' + s.properties.gridProperties.columnCount + ' cols)'));
  const has = (t) => m.sheets.some((s) => s.properties.title === t);
  console.log('\n  Board built: ' + (has(c.pipelineTab) && has(c.boardTab) ? 'yes' : 'not yet (run: build)'));
  c.leadTabs.forEach((lt) => console.log('  Lead tab "' + lt.tab + '": ' + (has(lt.tab) ? 'found' : 'NOT FOUND — check the exact tab name')));
  console.log('');
}

async function cmdInspect(api, c, tab) {
  if (!tab) fail('Usage: inspect <tab name>');
  const rows = await api.get(`'${tab}'!A1:ZZ3`);
  if (!rows.length) fail('Tab "' + tab + '" is empty or does not exist.');
  const width = Math.max(...rows.map((r) => r.length));
  console.log('\nTab "' + tab + '" — first rows (column numbers are 1-indexed):\n');
  for (let i = 0; i < width; i++) {
    const cells = rows.map((r) => (r[i] == null ? '' : String(r[i]))).map((v) => (v.length > 48 ? v.slice(0, 45) + '…' : v));
    console.log('  ' + String(i + 1).padStart(2) + ' (' + colLetter(i).padEnd(2) + ')  ' + cells.join('   |   '));
  }
  console.log('\nIf row 1 looks like headers, firstDataRow is 2. If row 1 is already a person, firstDataRow is 1.\n');
}

async function cmdBuild(api, c) {
  const m = await api.meta();
  const existing = m.sheets.filter((s) => s.properties.title === c.pipelineTab || s.properties.title === c.boardTab);
  if (existing.length && !flags.rebuild) fail('Tabs already exist: ' + existing.map((s) => s.properties.title).join(', ') + '.\nRun "export backup.csv" first if there are people on the board, then "build --rebuild".');
  if (existing.length) await api.structural(existing.map((s) => ({ deleteSheet: { sheetId: s.properties.sheetId } })));

  const created = await api.structural([
    { addSheet: { properties: { title: c.pipelineTab, tabColorStyle: { rgbColor: hex(FOREST) }, gridProperties: { rowCount: DATA_ROWS, columnCount: c.COLS, frozenRowCount: 1 } } } },
    { addSheet: { properties: { title: c.boardTab, tabColorStyle: { rgbColor: hex(FOREST) }, gridProperties: { rowCount: BOARD_ROWS, columnCount: c.stages.length, frozenRowCount: 2 } } } },
  ]);
  const dataId = created.replies[0].addSheet.properties.sheetId;
  const boardId = created.replies[1].addSheet.properties.sheetId;

  const ST = colLetter(c.STAGE), TO = colLetter(c.TOUCH), NF = colLetter(c.NEXTFU), DL = colLetter(c.DUE);
  const pat = c.noDue.map(escRe).join('|');
  const dueFormula = `=ARRAYFORMULA(IF($A$2:$A="","",IF($${NF}$2:$${NF}<>"",IF(TODAY()>=N($${NF}$2:$${NF}),"DUE",""),IF(REGEXMATCH($${ST}$2:$${ST}&"","^(${pat})$"),"—",IF(TODAY()-N($${TO}$2:$${TO})>=${c.fuGapDays},"DUE","")))))`;
  const names = c.stages.map((s) => s.name);
  const counts = c.stages.map((_, i) => `=SUMPRODUCT(--('${c.pipelineTab}'!$${ST}$2:$${ST}=${colLetter(i)}$1))`);
  const cards = c.stages.map((_, i) => `=IFERROR(FILTER('${c.pipelineTab}'!$A$2:$A&IF('${c.pipelineTab}'!$${DL}$2:$${DL}="DUE"," ⚠",""),'${c.pipelineTab}'!$${ST}$2:$${ST}=${colLetter(i)}$1,'${c.pipelineTab}'!$A$2:$A<>""))`);
  await api.write([
    { range: `'${c.pipelineTab}'!A1:${colLetter(c.COLS - 1)}1`, values: [c.HEADERS] },
    { range: `'${c.pipelineTab}'!${DL}2`, values: [[dueFormula]] },
    { range: `'${c.boardTab}'!A1:${colLetter(c.stages.length - 1)}3`, values: [names, counts, cards] },
  ]);

  const reqs = [];
  const mont = (extra) => ({ fontFamily: 'Montserrat', ...extra });
  reqs.push({ repeatCell: { range: { sheetId: dataId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: c.COLS },
    cell: { userEnteredFormat: { backgroundColor: hex(FOREST), textFormat: mont({ foregroundColor: hex(CREAM), bold: true }), verticalAlignment: 'MIDDLE' } },
    fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)' } });
  const widths = [180, 200];
  for (let i = 0; i < c.N; i++) widths.push(i === c.N - 1 ? 240 : 140);
  widths.push(185, 105, 105, 70, 320);
  widths.forEach((px, i) => reqs.push({ updateDimensionProperties: { range: { sheetId: dataId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } }));
  reqs.push({ setDataValidation: { range: { sheetId: dataId, startRowIndex: 1, endRowIndex: DATA_ROWS, startColumnIndex: c.STAGE, endColumnIndex: c.STAGE + 1 },
    rule: { condition: { type: 'ONE_OF_LIST', values: names.map((n) => ({ userEnteredValue: n })) }, strict: true, showCustomUi: true } } });
  reqs.push({ repeatCell: { range: { sheetId: dataId, startRowIndex: 1, endRowIndex: DATA_ROWS, startColumnIndex: c.TOUCH, endColumnIndex: c.NEXTFU + 1 },
    cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } }, fields: 'userEnteredFormat.numberFormat' } });
  c.stages.forEach((s, i) => reqs.push({ addConditionalFormatRule: { index: i, rule: {
    ranges: [{ sheetId: dataId, startRowIndex: 1, endRowIndex: DATA_ROWS, startColumnIndex: c.STAGE, endColumnIndex: c.STAGE + 1 }],
    booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: s.name }] }, format: { backgroundColor: hex(s.solid), textFormat: { foregroundColor: hex(s.text), bold: true } } } } } }));
  reqs.push({ addConditionalFormatRule: { index: c.stages.length, rule: {
    ranges: [{ sheetId: dataId, startRowIndex: 1, endRowIndex: DATA_ROWS, startColumnIndex: c.DUE, endColumnIndex: c.DUE + 1 }],
    booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'DUE' }] }, format: { backgroundColor: hex(DUE_BG), textFormat: { foregroundColor: hex(BURGUNDY), bold: true } } } } } });
  c.stages.forEach((s, i) => {
    reqs.push({ repeatCell: { range: { sheetId: boardId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
      cell: { userEnteredFormat: { backgroundColor: hex(s.solid), textFormat: mont({ foregroundColor: hex(s.text), bold: true, fontSize: 9 }), horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' } },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)' } });
    reqs.push({ repeatCell: { range: { sheetId: boardId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: i, endColumnIndex: i + 1 },
      cell: { userEnteredFormat: { backgroundColor: hex(s.tint), textFormat: mont({ foregroundColor: hex(s.text.toUpperCase() === INK ? '#8A6D2F' : s.solid), bold: true }), horizontalAlignment: 'CENTER' } },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } });
    reqs.push({ repeatCell: { range: { sheetId: boardId, startRowIndex: 2, endRowIndex: BOARD_ROWS, startColumnIndex: i, endColumnIndex: i + 1 },
      cell: { userEnteredFormat: { backgroundColor: hex(s.tint), textFormat: { foregroundColor: hex(INK) } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
  });
  reqs.push({ updateDimensionProperties: { range: { sheetId: boardId, dimension: 'COLUMNS', startIndex: 0, endIndex: c.stages.length }, properties: { pixelSize: 160 }, fields: 'pixelSize' } });
  reqs.push({ updateDimensionProperties: { range: { sheetId: boardId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 44 }, fields: 'pixelSize' } });
  reqs.push({ updateDimensionProperties: { range: { sheetId: boardId, dimension: 'ROWS', startIndex: 2, endIndex: BOARD_ROWS }, properties: { pixelSize: 26 }, fields: 'pixelSize' } });
  reqs.push({ addProtectedRange: { protectedRange: { range: { sheetId: boardId, startRowIndex: 2, endRowIndex: BOARD_ROWS, startColumnIndex: 0, endColumnIndex: c.stages.length }, description: 'The board redraws itself — move people via the Stage dropdown on the ' + c.pipelineTab + ' tab.', warningOnly: true } } });
  reqs.push({ addProtectedRange: { protectedRange: { range: { sheetId: dataId, startRowIndex: 1, endRowIndex: DATA_ROWS, startColumnIndex: c.DUE, endColumnIndex: c.DUE + 1 }, description: 'Due? is one formula in ' + DL + '2 — no need to type here.', warningOnly: true } } });
  const note = (sheetId, row, col, text) => ({ updateCells: { range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: col, endColumnIndex: col + 1 }, rows: [{ values: [{ note: text }] }], fields: 'note' } });
  reqs.push(note(dataId, 0, 2, 'Answer columns from your instant form, one per question. Type your own questions over these header cells any time; nothing else needs to change.'));
  reqs.push(note(dataId, 0, c.STAGE, 'Move someone through the pipeline by changing this dropdown — the board redraws itself. Everyone starts at "' + c.stages[0].name + '".'));
  reqs.push(note(dataId, 0, c.NEXTFU, 'Optional due date. Set it and Due? flips to DUE that day (always wins). Blank = due ' + c.fuGapDays + ' days after Last Touch.'));
  reqs.push(note(dataId, 0, c.DUE, 'Auto: DUE = follow-up owed. "—" = ' + c.noDue.join(', ') + '. One formula in ' + DL + '2 fills the column.'));
  reqs.push(note(boardId, 0, 0, 'This board redraws itself from the ' + c.pipelineTab + ' tab. To move a card, change that person\'s Stage dropdown there. ⚠ = due for a follow-up. Row 2 = count per stage.'));
  await api.structural(reqs);
  console.log('\n✓ Built "' + c.pipelineTab + '" (' + c.COLS + ' columns: ' + c.HEADERS.join(' | ') + ')');
  console.log('✓ Built "' + c.boardTab + '" (' + c.stages.length + ' stage columns)');
  console.log('  Board: https://docs.google.com/spreadsheets/d/' + c.spreadsheetId + '/edit#gid=' + boardId + '\n');
}

async function cmdImport(api, c) {
  if (!c.leadTabs.length) fail('No "leadTabs" in pipeline-config.json. Add the tab where your leads land (use "inspect <tab>" to find the columns).');
  const existing = await pipelineRows(api, c);
  const taken = takenKeys(existing);
  const people = [];
  for (const lt of c.leadTabs) {
    const first = lt.firstDataRow || 2;
    const rows = await api.get(`'${lt.tab}'!A${first}:ZZ${DATA_ROWS + first}`);
    let count = 0, dupes = 0;
    for (const r of rows) {
      const email = String(r[lt.emailCol - 1] || '').trim();
      let name = lt.nameCol ? String(r[lt.nameCol - 1] || '').trim() : (String(r[lt.firstNameCol - 1] || '') + ' ' + String(r[lt.lastNameCol - 1] || '')).trim();
      if (!name || /^x( x)?$/i.test(name) || name === 'full_name') name = email;
      if (!email.includes('@') || !name) continue;
      const key = email.toLowerCase();
      if (taken.has(key) || taken.has(name.toLowerCase())) { dupes++; continue; }
      taken.add(key); taken.add(name.toLowerCase());
      const answers = [];
      for (let i = 0; i < c.N; i++) { const col = (lt.answerCols || [])[i]; answers.push(col ? pretty(r[col - 1]) : ''); }
      people.push({ name, email, answers, stage: c.stages[0].name, note: 'Imported from "' + lt.tab + '" ' + today() });
      count++;
    }
    console.log('  "' + lt.tab + '": ' + count + ' new' + (dupes ? ', ' + dupes + ' already on the board' : ''));
  }
  if (!people.length) { console.log('\n✓ Nothing new to import — the board already has everyone.\n'); return; }
  const r = await appendPeople(api, c, people);
  console.log('\n✓ Imported ' + people.length + ' people into ' + c.pipelineTab + ' rows ' + r.start + '-' + r.end + ' at "' + c.stages[0].name + '" (Last Touch blank, so they all show DUE until you touch them).\n');
}

async function cmdImportCsv(api, c, file) {
  if (!file) fail('Usage: import-csv <file.csv>');
  const rows = parseCsv(fs.readFileSync(path.resolve(file), 'utf8'));
  if (rows.length < 2) fail('CSV needs a header row plus at least one person.');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (n) => head.indexOf(n);
  const iName = idx('name'), iEmail = idx('email'), iStage = idx('stage'), iTouch = idx('last_touch'), iNext = idx('next_fu'), iNotes = idx('notes');
  if (iName < 0) fail('CSV header must include "name" (and ideally email, stage, last_touch).');
  const known = new Set(['name', 'email', 'stage', 'last_touch', 'next_fu', 'notes', 'due?']);
  const answerIdx = head.map((h, i) => (known.has(h) ? -1 : i)).filter((i) => i >= 0).slice(0, c.N);
  const stageNames = new Set(c.stages.map((s) => s.name));
  const existing = await pipelineRows(api, c);
  const taken = takenKeys(existing);
  const people = [];
  let dupes = 0, badStage = 0;
  for (const r of rows.slice(1)) {
    const name = String(r[iName] || '').trim();
    const email = iEmail >= 0 ? String(r[iEmail] || '').trim() : '';
    if (!name && !email) continue;
    const key = (email || name).toLowerCase();
    if (taken.has(key) || taken.has(name.toLowerCase())) { dupes++; continue; }
    taken.add(key); if (name) taken.add(name.toLowerCase());
    let stage = iStage >= 0 ? String(r[iStage] || '').trim() : '';
    if (!stageNames.has(stage)) { if (stage) badStage++; stage = c.stages[0].name; }
    const answers = [];
    for (let i = 0; i < c.N; i++) answers.push(answerIdx[i] != null ? String(r[answerIdx[i]] || '').trim() : '');
    people.push({ name: name || email, email, answers, stage,
      lastTouch: iTouch >= 0 ? String(r[iTouch] || '').trim() : '',
      nextFu: iNext >= 0 ? String(r[iNext] || '').trim() : '',
      note: iNotes >= 0 ? String(r[iNotes] || '').trim() : 'Imported from ' + path.basename(file) + ' ' + today() });
  }
  if (!people.length) { console.log('\n✓ Nothing to add' + (dupes ? ' (' + dupes + ' already on the board)' : '') + '.\n'); return; }
  const res = await appendPeople(api, c, people);
  console.log('\n✓ Added ' + people.length + ' people (rows ' + res.start + '-' + res.end + ')' + (dupes ? ', skipped ' + dupes + ' already on the board' : '') +
    (badStage ? ', ' + badStage + ' had an unknown stage and landed at "' + c.stages[0].name + '"' : '') + '.\n');
}

async function cmdExport(api, c, file) {
  if (!file) fail('Usage: export <file.csv>');
  const rows = (await pipelineRows(api, c)).filter((r) => (r[0] || '').trim());
  const head = ['name', 'email'].concat(c.answerHeaders).concat(['stage', 'last_touch', 'next_fu', 'due?', 'notes']);
  const out = rows.map((r) => head.map((_, i) => r[i] == null ? '' : r[i]));
  fs.writeFileSync(path.resolve(file), toCsv([head].concat(out)));
  console.log('\n✓ Exported ' + rows.length + ' people to ' + path.resolve(file) + '\n');
}

async function cmdDue(api, c) {
  const rows = (await pipelineRows(api, c)).filter((r) => (r[0] || '').trim() && String(r[c.DUE] || '') === 'DUE');
  if (!rows.length) { console.log('\n✓ Nobody is due right now.\n'); return; }
  console.log('\nDue for a follow-up today (' + rows.length + '):\n');
  rows.forEach((r) => console.log('  • ' + r[0] + (r[1] ? ' (' + r[1] + ')' : '') + ' — ' + (r[c.STAGE] || '') + (r[c.NOTES] ? ' — ' + r[c.NOTES] : '')));
  console.log('');
}

// ---------------------------------------------------------------- main
(async () => {
  if (!command || flags.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\s*/, ''));
    process.exit(command ? 0 : 2);
  }
  const c = loadConfig();
  const sa = loadKey(c);
  const api = makeApi(sa, c.spreadsheetId);
  switch (command) {
    case 'check': return cmdCheck(api, c, sa);
    case 'inspect': return cmdInspect(api, c, positional.slice(1).join(' '));
    case 'build': return cmdBuild(api, c);
    case 'import': return cmdImport(api, c);
    case 'import-csv': return cmdImportCsv(api, c, positional[1]);
    case 'export': return cmdExport(api, c, positional[1]);
    case 'due': return cmdDue(api, c);
    default: fail('Unknown command "' + command + '". Run without arguments to see the list.');
  }
})().catch((e) => fail(e.message || String(e)));
