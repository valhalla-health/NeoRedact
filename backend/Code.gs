/************************************************************
 * NeoRedact Sync — v2 (Phase 1: collection, now with per-nurse login)
 * Google Apps Script backend that receives an already-redacted
 * photo + on-device OCR'd printed fields from the NeoRedact PWA,
 * stores the photo in Drive, and logs a row in a Sheet.
 *
 * Auth: Google Sign-In (JWT) for nurses with a Google account, or
 * email+password for everyone else — both funnel into the same
 * CacheService session token, so the submit path only ever checks
 * one thing regardless of how the nurse logged in. The Google token
 * is verified with Google (see verifyGoogleIdToken_); the password
 * path is new here (NeoFeed doesn't actually have one despite older
 * notes suggesting it did).
 *
 * This file was originally copied from a mid-2026 revision of
 * NeoFeed/gas-backend.gs and inherited two holes NeoFeed had already
 * closed on 2026-07-12 (its commit 4e927b9): the Google token was
 * only base64-decoded, never verified, and an unknown address was
 * auto-registered as an admin. Both are fixed here (2026-09-18) and
 * pinned by backend/test/verify-auth.cjs. If you ever port code
 * between these two backends again, port the tests with it.
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

// The Google OAuth client NeoRedact's sign-in button uses. Every ID token we
// accept must carry exactly this `aud`, otherwise a token minted for some
// other app (any Google account, any site) could be replayed here.
//
// THIS IS A FOURTH DUPLICATED CONSTANT, like CODENAMES below: it must equal
// NEOREDACT_CLIENT_ID in ../index.html and ../dashboard.html. Change all three
// in the same commit — a mismatch refuses every genuine nurse login. It is not
// a secret (it ships in the public HTML); it lives here so deploying the
// backend needs no extra console step to remember.
// backend/test/verify-auth.cjs fails if the three ever drift apart.
const GOOGLE_CLIENT_ID = '211053989021-q9r94sd06o33d96k07svus9b688go7lv.apps.googleusercontent.com';

// Roles the Staff sheet may grant. Anything else (blank, a typo, something
// invented) is treated as the least privilege we have, never as admin.
const ADMIN_ROLE = 'admin';
const DEFAULT_ROLE = 'nurse';

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
    const verified = verifyGoogleIdToken_(d.googleToken);
    if (!verified.email) {
      // Google being unreachable is not the nurse's account being wrong —
      // telling her to check her account would send her chasing nothing.
      if (verified.unavailable) {
        return out({ status: 'error', msg: 'ตรวจสอบบัญชี Google ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง', retryable: true });
      }
      Logger.log('Google sign-in refused: ' + verified.reason);
      return out({ status: 'error', msg: 'ข้อมูลเข้าสู่ระบบ Google ไม่ถูกต้อง' });
    }
    user = lookupActiveStaff_(verified.email);
    // An address Google vouches for but the Staff sheet doesn't know is a
    // stranger, not a new colleague. Signing in never creates an account —
    // Praew adds the row first (see backend/README.md, "Adding a nurse").
    if (!user) {
      Logger.log('Google sign-in refused: no active Staff row for ' + verified.email);
      return out({ status: 'error', msg: 'บัญชีนี้ยังไม่มีสิทธิ์ใช้งาน — แจ้งผู้ดูแลระบบให้เพิ่มอีเมลนี้ก่อน' });
    }
  } else if (d.email && d.password) {
    user = verifyPassword_(d.email, d.password);
  }

  if (!user) return out({ status: 'error', msg: 'ไม่พบบัญชีนี้ในระบบ หรือรหัสผ่านไม่ถูกต้อง' });

  const token = createSession(user.email, user.role, user.name);
  return out({ status: 'ok', token: token, name: user.name, role: user.role, email: user.email });
}

// The Staff sheet is the whitelist, and the only thing that grants a role.
// Returns null for an unknown address or one whose row is not active — the
// caller must not tell those two apart to the client.
function lookupActiveStaff_(email) {
  const sh = getSheetStaff_();
  const rows = sh.getDataRange().getValues();
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted) return null;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === wanted) {
      const active = rows[i][3];
      if (active !== true && String(active).toUpperCase() !== 'TRUE') return null;
      return {
        email: String(rows[i][0]).trim(),
        role: normalizeRole_(rows[i][1]),
        name: String(rows[i][2] || rows[i][0]),
      };
    }
  }
  return null;
}

// 'Admin' typed by hand in the sheet means admin; anything unrecognized means
// the least privilege, never more than was intended.
function normalizeRole_(raw) {
  const role = String(raw || '').trim().toLowerCase();
  return role === ADMIN_ROLE ? ADMIN_ROLE : DEFAULT_ROLE;
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
      return { email: email, role: normalizeRole_(rows[i][1]), name: String(rows[i][2] || email) };
    }
  }
  return null;
}

// Run manually from the Apps Script editor to put someone on the Staff sheet.
// This is the only way an account is created now: signing in never makes one,
// which is what stops a stranger's Google address from becoming an admin.
// Use it for the first admin on a fresh deployment, and for Google-account
// nurses (they need no password — they sign in with Google against this row).
// Editing the sheet by hand does exactly the same thing.
function addStaff(email, role, name) {
  const address = String(email || '').trim();
  if (!address) throw new Error('addStaff(email, role, name): email is required');
  const wanted = normalizeRole_(role);
  const sh = getSheetStaff_();
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === address.toLowerCase()) {
      throw new Error(address + ' is already on the Staff sheet (row ' + (i + 1) + ') — edit that row instead.');
    }
  }
  sh.appendRow([address, wanted, String(name || address.split('@')[0]), true, '', '']);
  Logger.log('Staff row added: ' + address + ' as ' + wanted);
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
 * Google ID token verification.
 *
 * This used to be decodeJwtEmail(): it base64-decoded the JWT's middle
 * segment and read the claims out of it. Every claim it checked (iss, exp,
 * email, email_verified) is a claim the sender writes, and the signature —
 * the only part that proves Google wrote them — was never looked at. The
 * comment here used to call that acceptable "since every login still goes
 * through the staff whitelist"; it wasn't, because the whitelist lookup
 * below used to add any unknown address as an admin, and even with that
 * fixed, unverified claims would still let a stranger arrive as any nurse
 * already on the sheet.
 *
 * Apps Script has no RSA/JWKS verification, so — like NeoFeed, PSS:NICU and
 * EOS Smart Alert already do — signature and expiry are delegated to
 * Google's tokeninfo endpoint (Google's documented server-side fallback for
 * environments without a JWT library), and `aud` is checked here so a token
 * minted for a different Google OAuth client cannot be replayed at this app.
 *
 * Needs the script.external_request scope in appsscript.json. Without it
 * UrlFetchApp throws and no Google login can succeed.
 ********************/
function verifyGoogleIdToken_(idToken) {
  if (!idToken || typeof idToken !== 'string') return { email: null, reason: 'no token sent' };
  // A genuine ID token is well under this; the cap keeps a junk payload out
  // of the request URL below.
  if (idToken.length > 4096) return { email: null, reason: 'token too long' };
  try {
    const resp = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
    const code = resp.getResponseCode();
    // Google's own bad day is not a bad token — see handleLogin_.
    if (code >= 500) return { email: null, reason: 'tokeninfo HTTP ' + code, unavailable: true };
    if (code !== 200) return { email: null, reason: 'tokeninfo HTTP ' + code };
    let payload;
    try { payload = JSON.parse(resp.getContentText()); }
    catch (parseErr) { return { email: null, reason: 'tokeninfo body is not JSON', unavailable: true }; }
    if (!payload) return { email: null, reason: 'empty tokeninfo body' };
    if (payload.aud !== GOOGLE_CLIENT_ID) return { email: null, reason: 'aud is not this app' };
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
      return { email: null, reason: 'bad iss' };
    }
    // tokeninfo returns these as strings; a genuine token that has expired is
    // rejected by Google above, this is belt and braces.
    if (!payload.exp || Number(payload.exp) < Math.floor(Date.now() / 1000)) {
      return { email: null, reason: 'token expired' };
    }
    if (payload.email_verified !== true && payload.email_verified !== 'true') {
      return { email: null, reason: 'email not verified' };
    }
    if (!payload.email) return { email: null, reason: 'no email in token' };
    return { email: String(payload.email), reason: null };
  } catch (e) {
    // Includes the missing-scope case: nothing here can tell a network blip
    // from an unauthorized UrlFetchApp, so say "try again" and log the detail.
    return { email: null, reason: 'tokeninfo call failed: ' + e.message, unavailable: true };
  }
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

// Every authenticated request re-reads the Staff sheet instead of trusting the
// name and role frozen into the session at login. Two reasons:
//   • revocation is immediate — setting active=FALSE, or changing a role, takes
//     effect on the next request instead of up to SESSION_TTL_SECONDS later.
//     That matters most right after a clean-up: a session issued before the row
//     was corrected would otherwise keep whatever it was granted for 6h;
//   • the role that decides who reads the dashboard comes from the sheet Praew
//     edits, which is the thing she can actually inspect and audit.
// Costs one read of a small sheet per request, on a path that already opens the
// spreadsheet anyway.
function requireStaffSession_(token) {
  const sess = verifySession(token);
  if (!sess || !sess.email) return null;
  return lookupActiveStaff_(sess.email);
}

/********************
 * Submission (the original doPost body, now behind a session check)
 ********************/
function handleSubmit_(d) {
  // Keep the words "not authenticated" for every unusable-session case,
  // including a row that has just been deactivated: sync.js matches on them to
  // clear the stale session and re-prompt login, instead of dropping a photo
  // the nurse has already taken.
  const user = requireStaffSession_(d.token);
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
 * Dashboard (read-only) — groups submissions by codename for the admin
 * dashboard page. Never returns anything beyond what's already in the Sheet
 * (codename, not real identity).
 *
 * ADMIN ONLY. This is the one endpoint that returns the whole collection in
 * one response: every submitting nurse's email address, every ward, and a
 * Drive link per redacted photo. A nurse needs none of that to do her own job
 * — she submits, she never reads back — so any session used to be enough to
 * pull the lot, which is what made it worth taking. If ward staff ever do need
 * a view, give them one scoped to their own submissions rather than widening
 * this one.
 ********************/
function handleListDashboard_(d) {
  const user = requireStaffSession_(d.token);
  if (!user) return out({ status: 'error', msg: 'not authenticated' });
  if (user.role !== ADMIN_ROLE) {
    Logger.log('Dashboard refused for non-admin: ' + user.email);
    return out({ status: 'error', msg: 'เฉพาะผู้ดูแลระบบเท่านั้นที่เปิดหน้ารวมข้อมูลได้' });
  }

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
  Logger.log('Add yourself with addStaff("you@example.com", "admin", "Your Name") — signing in no longer creates an account. Set passwords for non-Google nurses with setInitialPassword(), then Deploy.');
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
