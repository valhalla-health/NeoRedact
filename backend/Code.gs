/************************************************************
 * NeoRedact Sync — v2 (Phase 1: collection, now with per-nurse login)
 * Google Apps Script backend that receives an already-redacted
 * photo + on-device OCR'd printed fields from the NeoRedact PWA,
 * stores the photo in Drive, and logs a row in a Sheet.
 *
 * Auth: Google Sign-In (JWT) for nurses with a Google account, or
 * email+password for everyone else — both funnel into the same
 * CacheService session token, so the submit path only ever checks
 * one thing regardless of how the nurse logged in. Reuses the JWT
 * decode logic proven in NeoFeed/gas-backend.gs; the password path
 * is new here (NeoFeed doesn't actually have one despite older notes
 * suggesting it did).
 *
 * Phase 2 (Claude-vision OCR of the handwritten fields) is a
 * placeholder column here (ocr_status / ocr_data_json) — nothing
 * in this script calls any third-party AI API. That step is
 * gated on hospital approval and will be added later without
 * changing this schema.
 ************************************************************/

const APP = {
  NAME: 'NeoRedact Sync',
  TIMEZONE: Session.getScriptTimeZone() || 'Asia/Bangkok'
};

const SHEET_NAME = 'Submissions';
const STAFF_SHEET_NAME = 'Staff';
const DRIVE_ROOT_NAME = 'NeoRedact Submissions';
const SESSION_TTL_SECONDS = 21600; // 6h — documented practical ceiling for CacheService

// Column order = Sheet column order. Keep in sync with sync.js's payload shape.
// No HN/DOB/name column here by design — the cloud side is only ever supposed
// to learn the codename, never the real patient identity. See CLAUDE.md.
const HEADERS = [
  'syncId', 'submitted_at', 'device_captured_at', 'submitted_by', 'codename',
  'ward', 'fields_json', 'drive_file_url',
  'ocr_status', 'ocr_data_json'
];

// Staff sheet columns
const STAFF_HEADERS = ['email', 'role', 'name', 'active', 'password_hash', 'salt'];

// Fixed rotating pool of codenames (NATO phonetic alphabet minus X-ray and
// Echo, 24). Not an auto-incrementing identity registry — a real patient's
// identity is never stored here. Praew keeps her own private mapping
// (codename + date -> real HN/AN/name) on her desktop, entirely outside this
// system; date is what disambiguates a reused codename on her side, not
// anything this backend tracks. Keep this list identical to ../codenames.js
// in the frontend — a name the frontend can send but this list lacks is
// rejected at submit as 'invalid or missing codename', so the two must move
// together, in the same commit.
//
// TRANSITIONAL (2026-08-10): this list is deliberately one longer than the
// frontend's — it holds BOTH 'November' and 'Nomad' while the rename rolls
// out. The frontend is an installed PWA, so a phone keeps serving its cached
// codenames.js until the service worker picks up the CACHE_VERSION bump; until
// every install has, some clients still offer 'November' and some offer
// 'Nomad', and this backend has to accept whichever arrives. Accepting one
// extra name is harmless (validation only ever rejects the unknown); rejecting
// a name a live phone still shows is not.
// CLEANUP: drop 'November' once all installs are confirmed updated. Safe to
// leave indefinitely if unsure — nothing breaks, it just lingers in the
// dashboard's codename list.
const CODENAMES = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Foxtrot', 'Golf', 'Hotel',
  'India', 'Juliett', 'Kilo', 'Lima', 'Mike', 'Nomad', 'November', 'Oscar',
  'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor',
  'Whiskey', 'Yankee', 'Zulu'
];

// Field labels a nurse might type that would re-identify the patient if they
// ever reached the cloud sheet — stripped server-side regardless of what the
// client already filtered (defense in depth, same pattern as the redact step).
const IDENTIFYING_FIELD_KEYS = /^(hn|dob|name|ชื่อ|an|hn\/an|admission ?number|hospital ?number)$/i;
function stripIdentifyingFields_(fields) {
  const clean = {};
  Object.keys(fields || {}).forEach((k) => {
    if (!IDENTIFYING_FIELD_KEYS.test(k.trim())) clean[k] = fields[k];
  });
  return clean;
}

/********************
 * Web entry
 ********************/
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'ping') {
    return out({ status: 'ok', app: APP.NAME, version: '2.0' });
  }
  return out({ status: 'ok', msg: APP.NAME + ' — POST only' });
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    const action = d.action || 'submit';
    if (action === 'login') return handleLogin_(d);
    if (action === 'list_dashboard') return handleListDashboard_(d);
    return handleSubmit_(d);
  } catch (err) {
    return out({ status: 'error', msg: err.message });
  }
}

/********************
 * Login
 ********************/
function handleLogin_(d) {
  let user = null;

  if (d.googleToken) {
    const email = decodeJwtEmail(d.googleToken);
    if (!email) return out({ status: 'error', msg: 'invalid Google token' });
    user = lookupOrBootstrapStaff_(email);
  } else if (d.email && d.password) {
    user = verifyPassword_(d.email, d.password);
  }

  if (!user) return out({ status: 'error', msg: 'ไม่พบบัญชีนี้ในระบบ หรือรหัสผ่านไม่ถูกต้อง' });

  const token = createSession(user.email, user.role, user.name);
  return out({ status: 'ok', token: token, name: user.name, role: user.role, email: user.email });
}

// Google path: auto-register a first-time verified Google user as admin
// (same convenience NeoFeed uses) — restrict later by setting active=FALSE.
function lookupOrBootstrapStaff_(email) {
  const sh = getSheetStaff_();
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === email.trim().toLowerCase()) {
      const active = rows[i][3];
      if (active !== true && String(active).toUpperCase() !== 'TRUE') return null;
      return { email: email, role: String(rows[i][1] || 'nurse'), name: String(rows[i][2] || email) };
    }
  }
  const name = email.split('@')[0];
  sh.appendRow([email, 'admin', name, true, '', '']);
  return { email: email, role: 'admin', name: name };
}

// Password path: requires a pre-existing row with a hash already set via
// setInitialPassword() — no auto-registration (there's nothing to compare
// a self-submitted password against otherwise).
function verifyPassword_(email, password) {
  const sh = getSheetStaff_();
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === email.trim().toLowerCase()) {
      const active = rows[i][3];
      if (active !== true && String(active).toUpperCase() !== 'TRUE') return null;
      const storedHash = String(rows[i][4] || '');
      const salt = String(rows[i][5] || '');
      if (!storedHash || !salt) return null; // setInitialPassword() never run for this nurse
      if (hashPwd(password, salt) !== storedHash) return null;
      return { email: email, role: String(rows[i][1] || 'nurse'), name: String(rows[i][2] || email) };
    }
  }
  return null;
}

// One-time, run manually from the Apps Script editor per non-Google nurse.
function setInitialPassword(email, password) {
  const sh = getSheetStaff_();
  const rows = sh.getDataRange().getValues();
  const salt = Utilities.getUuid();
  const hash = hashPwd(password, salt);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === email.trim().toLowerCase()) {
      sh.getRange(i + 1, 5, 1, 2).setValues([[hash, salt]]);
      Logger.log('Password set for existing staff row: ' + email);
      return;
    }
  }
  sh.appendRow([email, 'nurse', email.split('@')[0], true, hash, salt]);
  Logger.log('New staff row created with password: ' + email);
}

/********************
 * JWT decode — base64url payload decode, no network call. Does NOT verify
 * the cryptographic signature (acceptable here since every login still goes
 * through the staff whitelist below). Checks issuer, expiry, email_verified.
 * Reused verbatim from NeoFeed/gas-backend.gs.
 ********************/
function decodeJwtEmail(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(Utilities.newBlob(Utilities.base64Decode(b64)).getDataAsString());
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') return null;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.email || payload.email_verified !== true) return null;
    return payload.email;
  } catch (e) { return null; }
}

/********************
 * Sessions (CacheService) — the one thing both login paths produce and the
 * one thing the submit path checks.
 ********************/
function hashPwd(password, salt) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + ':' + salt);
  return digest.map((b) => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}
function createSession(email, role, name) {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify({ email, role, name }), SESSION_TTL_SECONDS);
  return token;
}
function verifySession(token) {
  if (!token) return null;
  const raw = CacheService.getScriptCache().get('sess_' + token);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/********************
 * Submission (the original doPost body, now behind a session check)
 ********************/
function handleSubmit_(d) {
  const user = verifySession(d.token);
  if (!user) return out({ status: 'error', msg: 'not authenticated' });

  if (!d.syncId) return out({ status: 'error', msg: 'syncId required' });
  if (!d.codename || CODENAMES.indexOf(d.codename) === -1) {
    return out({ status: 'error', msg: 'invalid or missing codename' });
  }

  const sh = getSheet_();
  const existingRow = findRowBySyncId_(sh, d.syncId);
  if (existingRow > 0) {
    // Already recorded (retry after a flaky network) — don't duplicate,
    // don't re-save the image either.
    return out({ status: 'duplicate', syncId: d.syncId });
  }

  const fields = stripIdentifyingFields_(d.fields || {});
  const dateStr = Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyy-MM-dd');
  const driveUrl = d.redactedImageBase64
    ? saveImageToDrive_(d.syncId, d.codename, dateStr, d.redactedImageBase64)
    : '';

  const row = HEADERS.map((h) => {
    if (h === 'syncId') return d.syncId;
    if (h === 'submitted_at') return new Date().toISOString();
    if (h === 'device_captured_at') return d.capturedAt || '';
    if (h === 'submitted_by') return user.email;
    if (h === 'codename') return d.codename;
    if (h === 'ward') return d.ward || '';
    if (h === 'fields_json') return JSON.stringify(fields);
    if (h === 'drive_file_url') return driveUrl;
    if (h === 'ocr_status') return 'printed fields only';
    if (h === 'ocr_data_json') return '';
    return '';
  });
  sh.appendRow(row);

  return out({ status: 'ok', syncId: d.syncId, driveUrl: driveUrl });
}

/********************
 * Dashboard (read-only) — groups submissions by codename for the staff-facing
 * dashboard page. Never returns anything beyond what's already in the Sheet
 * (codename, not real identity).
 ********************/
function handleListDashboard_(d) {
  const user = verifySession(d.token);
  if (!user) return out({ status: 'error', msg: 'not authenticated' });

  const sh = getSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return out({ status: 'ok', rows: [], codenames: CODENAMES });

  const idx = {};
  HEADERS.forEach((h, i) => { idx[h] = i; });
  const values = sh.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();

  const rows = values.map((r) => ({
    syncId: r[idx.syncId],
    submittedAt: r[idx.submitted_at],
    capturedAt: r[idx.device_captured_at],
    submittedBy: r[idx.submitted_by],
    codename: r[idx.codename],
    ward: r[idx.ward],
    fields: safeParseJson_(r[idx.fields_json]),
    driveFileUrl: r[idx.drive_file_url],
  })).sort((a, b) => {
    if (a.codename !== b.codename) return a.codename < b.codename ? -1 : 1;
    return String(a.submittedAt) < String(b.submittedAt) ? -1 : 1;
  });

  return out({ status: 'ok', rows: rows, codenames: CODENAMES });
}

function safeParseJson_(s) {
  try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/********************
 * One-time setup — run manually from the Apps Script editor once,
 * then Deploy > New deployment > Web app (or New version, if a deployment
 * already exists).
 ********************/
function setupSpreadsheet() {
  let ss;
  const existingId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (existingId) {
    try { ss = SpreadsheetApp.openById(existingId); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(APP.NAME + ' Data');
    PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  }

  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
      .setFontWeight('bold').setBackground('#14181c').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setColumnWidths(1, HEADERS.length, 150);
  }

  getSheetStaff_(); // auto-creates the Staff tab with headers

  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 2) ss.deleteSheet(defaultSheet);

  getDriveRootFolder_(); // creates + stores DRIVE_ROOT_ID if missing

  Logger.log('Spreadsheet ready: ' + ss.getUrl());
  Logger.log('Add yourself to the Staff sheet (or sign in with Google once to auto-bootstrap as admin), set passwords for non-Google nurses with setInitialPassword(), then Deploy.');
  return ss.getUrl();
}

/********************
 * Sheet helpers
 ********************/
function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Missing SPREADSHEET_ID. Run setupSpreadsheet() once from the Apps Script editor first.');
  return SpreadsheetApp.openById(id);
}
function getSheet_() {
  const sh = getSpreadsheet_().getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('Sheet not found: ' + SHEET_NAME);
  return sh;
}
function getSheetStaff_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(STAFF_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(STAFF_SHEET_NAME);
    sh.getRange(1, 1, 1, STAFF_HEADERS.length).setValues([STAFF_HEADERS])
      .setFontWeight('bold').setBackground('#14181c').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}
function findRowBySyncId_(sh, syncId) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return -1;
  const col = HEADERS.indexOf('syncId') + 1;
  const ids = sh.getRange(2, col, lastRow - 1, 1).getValues().flat();
  const i = ids.indexOf(syncId);
  return i === -1 ? -1 : i + 2;
}

/********************
 * Drive helpers
 ********************/
function getDriveRootFolder_() {
  const id = PropertiesService.getScriptProperties().getProperty('DRIVE_ROOT_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* fall through and recreate */ }
  }
  const folder = DriveApp.createFolder(DRIVE_ROOT_NAME);
  PropertiesService.getScriptProperties().setProperty('DRIVE_ROOT_ID', folder.getId());
  return folder;
}
function getOrCreateSubfolder_(parent, name) {
  const existing = parent.getFoldersByName(name);
  if (existing.hasNext()) return existing.next();
  return parent.createFolder(name);
}
// NeoRedact Submissions/<codename>/<yyyy-MM-dd>/<syncId>.jpg — folder per
// patient codename, dated subfolder inside it. A reused codename (only 26
// exist) just accumulates more dated subfolders; disambiguating which real
// patient a given date belongs to is Praew's own private mapping, not
// anything this backend needs to know.
function getPatientDateFolder_(codename, dateStr) {
  const root = getDriveRootFolder_();
  const patientFolder = getOrCreateSubfolder_(root, codename);
  return getOrCreateSubfolder_(patientFolder, dateStr);
}
function saveImageToDrive_(syncId, codename, dateStr, base64) {
  const cleaned = base64.replace(/^data:image\/\w+;base64,/, '');
  const bytes = Utilities.base64Decode(cleaned);
  const blob = Utilities.newBlob(bytes, 'image/jpeg', syncId + '.jpg');
  const file = getPatientDateFolder_(codename, dateStr).createFile(blob);
  return file.getUrl();
}
