// verify-auth.cjs — the security contract of the sync backend's login,
// submit and dashboard paths. Run: node test/verify-auth.cjs
//
// Every test here is written against a specific way the backend could let the
// wrong person in. They are regression tests for the 2026-09-18 fix, and each
// one fails against the revision before it:
//
//   NEOREDACT_GAS_SRC=<old Code.gs> node test/verify-auth.cjs
//
// What they pin down:
//   1. a Google ID token is only trusted after Google says it is genuine,
//      and only if it was issued for THIS app (aud);
//   2. signing in never creates a staff account — least of all an admin one;
//   3. the dashboard (every nurse's email, ward and photo link) is admin-only;
//   4. the Staff sheet is authority on every request, so deactivating a row
//      takes effect at once instead of after the session's 6h TTL;
//   5. the wording sync.js keys on ("not authenticated") still comes back,
//      because that is what makes a phone re-login instead of dropping a photo.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, unsignedToken } = require('./gas-stubs.cjs');

const ROOT = path.join(__dirname, '..');
const CLIENT_ID = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .match(/NEOREDACT_CLIENT_ID\s*=\s*"([^"]+)"/) || [])[1];
assert.ok(CLIENT_ID, 'index.html must define NEOREDACT_CLIENT_ID');

const FUTURE = Math.floor(Date.now() / 1000) + 3600;

// What Google's tokeninfo endpoint returns for a genuine, current ID token.
const googleSays = (payload) => () => ({
  code: 200,
  body: JSON.stringify(Object.assign({
    aud: CLIENT_ID,
    iss: 'https://accounts.google.com',
    exp: String(FUTURE),
    email_verified: 'true',
  }, payload)),
});

const GOOGLE_REJECTS = () => ({ code: 400, body: '{"error_description":"Invalid Value"}' });

// The token an attacker would actually send: every claim a local decoder looks
// at is present and correct, and only the signature is worthless. Handing the
// backend anything less well-formed would let it refuse on a technicality and
// hide whether it checks authenticity at all.
const tokenFor = (email) => unsignedToken({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  exp: FUTURE,
  email,
  email_verified: true,
});

const nurseRow = (email) => [email, 'nurse', 'Nurse ' + email, true, '', ''];
const adminRow = (email) => [email, 'admin', 'Admin', true, '', ''];

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL ' + name + '\n         ' + err.message.split('\n')[0]);
  }
}

console.log('\nbackend/Code.gs — auth contract\n');

// ── 1. Token authenticity ────────────────────────────────────────────────
test('a token Google rejects does not produce a session', () => {
  const app = boot({ staff: [adminRow('praew@example.com')], urlFetch: GOOGLE_REJECTS });
  const res = app.post({
    action: 'login',
    googleToken: tokenFor('praew@example.com'),
  });
  assert.notStrictEqual(res.status, 'ok', 'a token Google rejects must not log anyone in');
  assert.ok(!res.token, 'no session token may be issued');
});

test('the backend actually asks Google about the token', () => {
  const app = boot({ staff: [adminRow('praew@example.com')], urlFetch: GOOGLE_REJECTS });
  app.post({
    action: 'login',
    googleToken: tokenFor('praew@example.com'),
  });
  assert.ok(app.tokenInfoCalls().length > 0,
    'login must verify the token with Google, not just decode it locally');
});

test('a token issued for a different app is refused', () => {
  const app = boot({
    staff: [adminRow('praew@example.com')],
    urlFetch: googleSays({ aud: '999-someone-elses-app.apps.googleusercontent.com', email: 'praew@example.com' }),
  });
  const res = app.post({ action: 'login', googleToken: tokenFor('praew@example.com') });
  assert.notStrictEqual(res.status, 'ok', 'aud must match this app\'s client ID');
});

test('a token for an unverified Google address is refused', () => {
  const app = boot({
    staff: [adminRow('praew@example.com')],
    urlFetch: googleSays({ email: 'praew@example.com', email_verified: 'false' }),
  });
  const res = app.post({ action: 'login', googleToken: tokenFor('praew@example.com') });
  assert.notStrictEqual(res.status, 'ok', 'email_verified must be true');
});

// ── 2. Signing in never creates an account ───────────────────────────────
test('a genuine Google account with no Staff row cannot log in', () => {
  const app = boot({
    staff: [adminRow('praew@example.com')],
    urlFetch: googleSays({ email: 'stranger@gmail.com' }),
  });
  const res = app.post({ action: 'login', googleToken: tokenFor('stranger@gmail.com') });
  assert.notStrictEqual(res.status, 'ok', 'only addresses already on the Staff sheet may sign in');
});

test('a refused login adds no row to the Staff sheet', () => {
  const app = boot({
    staff: [adminRow('praew@example.com')],
    urlFetch: googleSays({ email: 'stranger@gmail.com' }),
  });
  const before = app.staffRows().length;
  app.post({ action: 'login', googleToken: tokenFor('stranger@gmail.com') });
  assert.strictEqual(app.staffRows().length, before,
    'signing in must never append a staff row (this is how strangers became admins)');
});

test('no login path can hand out the admin role by itself', () => {
  const app = boot({
    staff: [adminRow('praew@example.com')],
    urlFetch: googleSays({ email: 'stranger@gmail.com' }),
  });
  const res = app.post({ action: 'login', googleToken: tokenFor('stranger@gmail.com') });
  assert.notStrictEqual(res.role, 'admin', 'a first-time address must not come back as admin');
});

// ── 3. Existing staff still work ─────────────────────────────────────────
test('a nurse on the Staff sheet logs in as a nurse', () => {
  const app = boot({
    staff: [adminRow('praew@example.com'), nurseRow('nurse@example.com')],
    urlFetch: googleSays({ email: 'nurse@example.com' }),
  });
  const res = app.post({ action: 'login', googleToken: tokenFor('nurse@example.com') });
  assert.strictEqual(res.status, 'ok', 'a whitelisted nurse must still be able to log in');
  assert.strictEqual(res.role, 'nurse');
  assert.ok(res.token, 'a session token is issued');
});

test('a deactivated staff row cannot log in', () => {
  const app = boot({
    staff: [['off@example.com', 'nurse', 'Off', false, '', '']],
    urlFetch: googleSays({ email: 'off@example.com' }),
  });
  const res = app.post({ action: 'login', googleToken: tokenFor('off@example.com') });
  assert.notStrictEqual(res.status, 'ok', 'active=FALSE must refuse the login');
});

// ── 4. The dashboard is admin-only ───────────────────────────────────────
function loggedIn(app, email) {
  const res = app.post({ action: 'login', googleToken: tokenFor(email) });
  assert.strictEqual(res.status, 'ok', 'setup: ' + email + ' should have logged in (' + res.msg + ')');
  return res.token;
}

test('a nurse session cannot read the dashboard', () => {
  const app = boot({
    staff: [adminRow('praew@example.com'), nurseRow('nurse@example.com')],
    submissions: [['s1', '2026-09-18', '2026-09-18', 'nurse@example.com', 'Alpha', 'NICU', '{}', 'url', '', '']],
    urlFetch: googleSays({ email: 'nurse@example.com' }),
  });
  const token = loggedIn(app, 'nurse@example.com');
  const res = app.post({ action: 'list_dashboard', token });
  assert.notStrictEqual(res.status, 'ok',
    'the dashboard lists every nurse\'s email, ward and photo link — nurses must not get it');
  assert.ok(!res.rows, 'no rows may come back');
});

test('an admin session can read the dashboard', () => {
  const app = boot({
    staff: [adminRow('praew@example.com')],
    submissions: [['s1', '2026-09-18', '2026-09-18', 'nurse@example.com', 'Alpha', 'NICU', '{}', 'url', '', '']],
    urlFetch: googleSays({ email: 'praew@example.com' }),
  });
  const token = loggedIn(app, 'praew@example.com');
  const res = app.post({ action: 'list_dashboard', token });
  assert.strictEqual(res.status, 'ok', 'an admin must still see the dashboard');
  assert.strictEqual(res.rows.length, 1);
});

test('the dashboard refuses a session with no token at all', () => {
  const app = boot({ staff: [adminRow('praew@example.com')] });
  const res = app.post({ action: 'list_dashboard', token: 'made-up-token' });
  assert.notStrictEqual(res.status, 'ok');
});

// ── 5. The Staff sheet is authority on every request ─────────────────────
test('deactivating a nurse ends her existing session at once', () => {
  const app = boot({
    staff: [nurseRow('nurse@example.com')],
    urlFetch: googleSays({ email: 'nurse@example.com' }),
  });
  const token = loggedIn(app, 'nurse@example.com');
  // Praew sets active=FALSE in the Staff sheet (column D).
  app.env.sheets.Staff.getRange(2, 4, 1, 1).setValues([[false]]);
  const res = app.post({ action: 'submit', token, syncId: 'x1', codename: 'Alpha' });
  assert.notStrictEqual(res.status, 'ok',
    'a revoked nurse must not keep submitting until her 6h session expires');
});

test('demoting an admin ends her dashboard access at once', () => {
  const app = boot({
    staff: [adminRow('praew@example.com')],
    urlFetch: googleSays({ email: 'praew@example.com' }),
  });
  const token = loggedIn(app, 'praew@example.com');
  app.env.sheets.Staff.getRange(2, 2, 1, 1).setValues([['nurse']]); // role column
  const res = app.post({ action: 'list_dashboard', token });
  assert.notStrictEqual(res.status, 'ok',
    'the role must be re-read from the sheet, not trusted from the cached session');
});

// ── 6. Contracts the fix must not break ──────────────────────────────────
test('an unusable session still answers "not authenticated"', () => {
  const app = boot({ staff: [nurseRow('nurse@example.com')] });
  const res = app.post({ action: 'submit', token: 'stale-token', syncId: 'x1', codename: 'Alpha' });
  assert.strictEqual(res.status, 'error');
  assert.ok(/not authenticated/i.test(res.msg || ''),
    'sync.js keys on this wording to re-login instead of dropping a queued photo');
});

test('a logged-in nurse can still submit', () => {
  const app = boot({
    staff: [nurseRow('nurse@example.com')],
    urlFetch: googleSays({ email: 'nurse@example.com' }),
  });
  const token = loggedIn(app, 'nurse@example.com');
  const res = app.post({ action: 'submit', token, syncId: 'x1', codename: 'Alpha', ward: 'NICU' });
  assert.strictEqual(res.status, 'ok', 'the whole point of the app must keep working');
  assert.strictEqual(app.submissionRows().length, 1);
  assert.strictEqual(app.submissionRows()[0][3], 'nurse@example.com', 'submitted_by is the audit trail');
});

test('an unknown codename is still rejected', () => {
  const app = boot({
    staff: [nurseRow('nurse@example.com')],
    urlFetch: googleSays({ email: 'nurse@example.com' }),
  });
  const token = loggedIn(app, 'nurse@example.com');
  const res = app.post({ action: 'submit', token, syncId: 'x1', codename: 'Xenon' });
  assert.notStrictEqual(res.status, 'ok');
});

// ── 7. Deploy-time facts the fix depends on ──────────────────────────────
test('appsscript.json allows the outbound call token verification needs', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'backend', 'appsscript.json'), 'utf8'));
  assert.ok((manifest.oauthScopes || []).includes('https://www.googleapis.com/auth/script.external_request'),
    'without this scope UrlFetchApp throws and every Google login fails after deploy');
});

test('the backend and both front-end pages name the same OAuth client', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8');
  const backendId = (code.match(/GOOGLE_CLIENT_ID\s*=\s*'([^']+)'/) || [])[1];
  assert.strictEqual(backendId, CLIENT_ID,
    'Code.gs\'s GOOGLE_CLIENT_ID must match index.html — a mismatch refuses every real token');
  const dash = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
  assert.ok(dash.includes(CLIENT_ID), 'dashboard.html must use the same client ID');
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed\n');
process.exit(failures.length ? 1 : 0);
