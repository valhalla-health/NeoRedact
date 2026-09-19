// verify-auth.cjs — the security contract of the sync backend's login,
// submit and dashboard paths. Run: node test/verify-auth.cjs
//
// Every test here is written against a specific way the backend could let the
// wrong person in, or tell a stranger something. The behavioural ones are
// regression tests and fail against the revision before their fix:
//
//   NEOREDACT_GAS_SRC=<old Code.gs> node test/verify-auth.cjs
//
// What they pin down (1–5 since PR #8; 6–7 since its follow-up, which ported
// the password path and the error text from NeoFeed's 4e927b9 and 8ca0f74):
//   1. a Google ID token is only trusted after Google says it is genuine,
//      and only if it was issued for THIS app (aud);
//   2. signing in never creates a staff account — least of all an admin one;
//   3. the dashboard (every nurse's email, ward and photo link) is admin-only;
//   4. the Staff sheet is authority on every request, so deactivating a row
//      takes effect at once instead of after the session's 6h TTL;
//   5. the wording sync.js keys on ("not authenticated") still comes back,
//      because that is what makes a phone re-login instead of dropping a photo;
//   6. a password can't be guessed over HTTP: five failures lock an address
//      for 15 minutes, each attempt counted before its password is checked;
//      an address that isn't a password account answers the same way at the
//      same cost; passwords are stored stretched, old ones upgraded on login;
//   7. an unexpected failure tells the caller nothing about the server.
// A few guards pass on the old revisions too. They pin what a fix must not
// break: a nurse can still log in and submit, a password stored the old way
// still works, and typos spread over a shift don't add up to a lockout.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { boot, unsignedToken, withNow } = require('./gas-stubs.cjs');

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
  const res = app.post({ action: 'submit', token, syncId: crypto.randomUUID(), codename: 'Alpha' });
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
  const res = app.post({ action: 'submit', token: 'stale-token', syncId: crypto.randomUUID(), codename: 'Alpha' });
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
  const res = app.post({ action: 'submit', token, syncId: crypto.randomUUID(), codename: 'Alpha', ward: 'NICU' });
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
  const res = app.post({ action: 'submit', token, syncId: crypto.randomUUID(), codename: 'Xenon' });
  assert.notStrictEqual(res.status, 'ok');
});

// ── 7. The password path: guessing, probing, and what is stored ──────────
// For nurses without a Google account. The only thing between the public
// /exec URL and a session is an address and a password, so these pin what
// someone holding a list of addresses can do with that endpoint.

// What setInitialPassword() stored until this change, and so what every
// password row on the live Staff sheet holds: one round of SHA-256 over
// password + ':' + salt, as lowercase hex.
const legacyHash = (password, salt) =>
  crypto.createHash('sha256').update(password + ':' + salt, 'utf8').digest('hex');

// The stretched format, NeoFeed's hashPwdV2: 3000 rounds of HMAC-SHA256 keyed
// by the salt, starting from password + ':' + salt. Written out here instead
// of borrowed from Code.gs, so that changing the stored format — which would
// lock every account set up in it out — fails a test instead of agreeing
// with it.
function v2Hash(password, salt) {
  let data = password + ':' + salt;
  for (let i = 0; i < 3000; i++) {
    data = crypto.createHmac('sha256', salt).update(data, 'utf8').digest('hex');
  }
  return 'v2$' + data;
}

const passwordRow = (email, password, salt) =>
  [email, 'nurse', 'Nurse ' + email, true, legacyHash(password, salt), salt];
const pwLogin = (app, email, password) => app.post({ action: 'login', email, password });
const hashWork = (app) => app.env.hmacCalls + app.env.digestCalls;
const MINUTE = 60 * 1000;

test('a new password is stored stretched, not as one round of SHA-256', () => {
  const app = boot({ staff: [nurseRow('pw@example.com')] });
  app.ctx.setInitialPassword('pw@example.com', 'Correct-Horse-1');
  const row = app.staffRows()[0];
  assert.strictEqual(row[4], v2Hash('Correct-Horse-1', row[5]),
    'a copied Staff sheet must cost 3000 HMAC rounds per guess, not one SHA-256');
  assert.strictEqual(pwLogin(app, 'pw@example.com', 'Correct-Horse-1').status, 'ok',
    'and the nurse can log in with it');
});

test('a password stored the old way still logs in, and is re-stored stretched', () => {
  const app = boot({ staff: [passwordRow('old@example.com', 'Old-Password-1', 'salt-old')] });
  const res = pwLogin(app, 'old@example.com', 'Old-Password-1');
  assert.strictEqual(res.status, 'ok',
    'every password row on the live sheet is in the old format — those nurses must not be locked out by the deploy');
  assert.strictEqual(app.staffRows()[0][4], v2Hash('Old-Password-1', 'salt-old'),
    'a successful login is when the weak hash gets replaced: the password has just been proven');
  assert.strictEqual(pwLogin(app, 'old@example.com', 'Old-Password-1').status, 'ok',
    'and the upgraded row still logs in');
});

test('re-storing an old hash never lands on a row that moved into its place', () => {
  const app = boot({
    staff: [
      passwordRow('old@example.com', 'Old-Password-1', 'salt-old'),
      passwordRow('other@example.com', 'Other-Password-1', 'salt-other'),
    ],
  });
  // Praew inserts a row at the top of the sheet by hand while the login is
  // hashing, so every row below moves down one.
  let inserted = false;
  app.env.onHash = () => {
    if (inserted) return;
    inserted = true;
    app.env.sheets.Staff._data.splice(1, 0, ['new@example.com', 'nurse', 'New', true, '', '']);
  };
  const res = pwLogin(app, 'old@example.com', 'Old-Password-1');
  app.env.onHash = null;
  assert.strictEqual(res.status, 'ok', 'the login itself is fine');
  const hashOf = (email) => app.staffRows().find((r) => r[0] === email)[4];
  assert.strictEqual(hashOf('new@example.com'), '',
    'the upgrade was written to whichever row now sits where old@ was: a hash under someone else\'s salt locks them out');
  assert.strictEqual(hashOf('other@example.com'), legacyHash('Other-Password-1', 'salt-other'));
  assert.strictEqual(pwLogin(app, 'old@example.com', 'Old-Password-1').status, 'ok',
    'and old@ still logs in — the upgrade just waits for a later login');
});

test('a wrong password never rewrites the stored hash', () => {
  const app = boot({ staff: [passwordRow('old@example.com', 'Old-Password-1', 'salt-old')] });
  pwLogin(app, 'old@example.com', 'attackers-guess');
  assert.strictEqual(app.staffRows()[0][4], legacyHash('Old-Password-1', 'salt-old'),
    'rehashing an unproven password would hand the account to whoever typed it');
  assert.notStrictEqual(pwLogin(app, 'old@example.com', 'attackers-guess').status, 'ok');
});

test('five wrong passwords lock the address: the right one is refused next', () => {
  const app = boot({ staff: [passwordRow('pw@example.com', 'Right-Password-1', 'salt-a')] });
  for (let i = 1; i <= 5; i++) {
    assert.notStrictEqual(pwLogin(app, 'pw@example.com', 'guess-' + i).status, 'ok');
  }
  const res = pwLogin(app, 'pw@example.com', 'Right-Password-1');
  assert.notStrictEqual(res.status, 'ok', 'with no limit, a weak password falls to guessing over HTTP');
  assert.ok(!res.token, 'no session may be issued while locked');
});

test('overlapping guesses are each counted before their password is hashed', () => {
  const app = boot({ staff: [passwordRow('pw@example.com', 'Right-Password-1', 'salt-a')] });
  const hashed = new Set();
  let fired = 0;
  let remaining = 19;
  const guess = () => { fired++; return pwLogin(app, 'pw@example.com', 'guess-' + fired); };
  // Each request fires the next from inside its own password hash, so they
  // overlap the way a parallel burst does. A count that is read, then hashed,
  // then written lets every one of them through. (Hashing the address itself,
  // for a counter's key, is not checking a password, so it fires nothing.)
  app.env.onHash = (input) => {
    if (input.indexOf('pw@example.com') !== -1) return;
    const m = /guess-\d+/.exec(input);
    if (m) hashed.add(m[0]);
    if (remaining > 0) { remaining--; guess(); }
  };
  guess();
  app.env.onHash = null;
  assert.strictEqual(fired, 20, 'setup: twenty overlapping guesses were fired');
  assert.ok(hashed.size <= 5,
    hashed.size + ' of 20 overlapping guesses reached the password hash — at most 5 may');
  assert.notStrictEqual(pwLogin(app, 'pw@example.com', 'Right-Password-1').status, 'ok',
    'and the address is locked afterwards');
});

test('the script lock is held while counting, never while hashing', () => {
  const app = boot({ staff: [passwordRow('pw@example.com', 'Right-Password-1', 'salt-a')] });
  const heldWhileHashing = [];
  app.env.onHash = (input) => {
    if (/guess-1|Right-Password-1/.test(input)) heldWhileHashing.push(app.env.lockHeld);
  };
  pwLogin(app, 'pw@example.com', 'guess-1');
  pwLogin(app, 'pw@example.com', 'Right-Password-1');
  app.env.onHash = null;
  assert.ok(app.env.lockWaits >= 2, 'each attempt must take the script lock to count itself');
  assert.strictEqual(app.env.lockHeld, 0, 'and give it back');
  assert.ok(heldWhileHashing.length >= 2 && heldWhileHashing.every((n) => n === 0),
    'lock held during the hash: [' + heldWhileHashing + '] — a ~1 s hash under the lock queues every other login behind it');
});

test('a login that cannot take the lock is refused, its password unchecked', () => {
  const app = boot({ staff: [passwordRow('pw@example.com', 'Right-Password-1', 'salt-a')] });
  app.env.lockTimeout = true;
  let checked = false;
  app.env.onHash = (input) => { if (input.indexOf('Right-Password-1') !== -1) checked = true; };
  const res = pwLogin(app, 'pw@example.com', 'Right-Password-1');
  app.env.onHash = null;
  assert.notStrictEqual(res.status, 'ok',
    'an attempt that could not be counted must not go through — contention would be a way around the limit');
  assert.ok(!res.token);
  assert.ok(!checked, 'the password was checked without being counted');
});

test('not staff, Google-only, or deactivated: the same answer at the same cost as a wrong password', () => {
  const app = boot({
    staff: [
      passwordRow('pw@example.com', 'Right-Password-1', 'salt-a'),
      ['google@example.com', 'nurse', 'Google Nurse', true, '', ''],
      ['off@example.com', 'nurse', 'Off', false, legacyHash('Off-Password-1', 'salt-off'), 'salt-off'],
    ],
  });
  const probe = (email, password) => {
    const before = hashWork(app);
    const res = pwLogin(app, email, password);
    return { res, work: hashWork(app) - before };
  };
  const wrong = probe('pw@example.com', 'guess-1');
  assert.ok(wrong.work > 0, 'setup: checking a real password hashes it');
  [
    ['nobody@example.com', 'guess-1', 'an address that is not on the Staff sheet'],
    ['google@example.com', 'guess-1', 'a Google-only row, which has no password'],
    ['off@example.com', 'Off-Password-1', 'a deactivated row, even given its right password'],
  ].forEach(([email, password, what]) => {
    const p = probe(email, password);
    assert.notStrictEqual(p.res.status, 'ok', what + ' must not log in');
    assert.strictEqual(p.res.msg, wrong.res.msg, what + ' must get the same answer as a wrong password');
    assert.ok(Math.abs(p.work - wrong.work) <= 0.1 * wrong.work,
      what + ' did ' + p.work + ' hash steps, a wrong password ' + wrong.work +
      ' — a refusal that is quicker or slower tells a stranger which addresses are password accounts');
  });
});

test('an invented address locks out like a real one, and leaves no Script Property behind', () => {
  const app = boot({ staff: [passwordRow('pw@example.com', 'Right-Password-1', 'salt-a')] });
  const first = pwLogin(app, 'pw@example.com', 'guess-0');
  for (let i = 1; i <= 4; i++) pwLogin(app, 'pw@example.com', 'guess-' + i);
  const realLocked = pwLogin(app, 'pw@example.com', 'guess-5');
  assert.notStrictEqual(realLocked.msg, first.msg, 'the sixth try on a real account is told it is locked out');

  const propsBefore = Object.keys(app.env.props).sort();
  for (let i = 0; i < 5; i++) pwLogin(app, 'ghost@example.com', 'guess-' + i);
  const ghost = pwLogin(app, 'ghost@example.com', 'guess-5');
  assert.strictEqual(ghost.msg, realLocked.msg,
    'an address that is not staff must lock out the same way, or the lockout itself tells staff from strangers');
  assert.deepStrictEqual(Object.keys(app.env.props).sort(), propsBefore,
    'an invented address must not create a Script Property — a stranger could invent them without limit');
  const keys = Object.keys(app.env.props).concat(Array.from(app.env.cache.keys()));
  assert.ok(!keys.some((k) => /ghost|pw@|example\.com/i.test(k)),
    'a counter key names the address: ' + keys.join(', '));
});

test('a login with a non-string email or password is refused like a wrong password', () => {
  const app = boot({ staff: [passwordRow('pw@example.com', 'Right-Password-1', 'salt-a')] });
  const wrong = pwLogin(app, 'pw@example.com', 'guess-1');
  [[42, 'x'], [{ '$ne': '' }, 'x'], ['pw@example.com', 42], ['pw@example.com', ['Right-Password-1']]]
    .forEach(([email, password]) => {
      const res = app.post({ action: 'login', email, password });
      assert.notStrictEqual(res.status, 'ok', JSON.stringify([email, password]) + ' logged in');
      assert.strictEqual(res.msg, wrong.msg, JSON.stringify([email, password]) + ' was answered ' + JSON.stringify(res.msg));
    });
});

test('a correct password clears the count, so typos spread over a shift never add up', () => {
  const app = boot({ staff: [passwordRow('pw@example.com', 'Right-Password-1', 'salt-a')] });
  for (let round = 1; round <= 3; round++) {
    for (let i = 1; i <= 4; i++) pwLogin(app, 'pw@example.com', 'typo-' + round + '-' + i);
    assert.strictEqual(pwLogin(app, 'pw@example.com', 'Right-Password-1').status, 'ok',
      'round ' + round + ': four typos, then the right password, must still sign in');
  }
});

test('the lockout lifts after fifteen minutes, with a fresh count', () => {
  const app = boot({ staff: [passwordRow('pw@example.com', 'Right-Password-1', 'salt-a')] });
  const t0 = Date.UTC(2026, 8, 18, 8, 0, 0);
  withNow(t0, () => { for (let i = 1; i <= 5; i++) pwLogin(app, 'pw@example.com', 'guess-' + i); });
  assert.notStrictEqual(withNow(t0 + 14 * MINUTE, () => pwLogin(app, 'pw@example.com', 'Right-Password-1')).status, 'ok',
    'still locked 14 minutes after the fifth failure');
  const after = withNow(t0 + 16 * MINUTE, () => {
    for (let i = 1; i <= 4; i++) pwLogin(app, 'pw@example.com', 'typo-' + i);
    return pwLogin(app, 'pw@example.com', 'Right-Password-1');
  });
  assert.strictEqual(after.status, 'ok',
    'once lifted, four typos then the right password must sign in — a lockout that never lifts, or re-locks on the first typo, turns five typos into a disabled account');
});

// ── 8. Nothing internal reaches a caller ─────────────────────────────────
// The /exec URL answers anyone. What a request that blew up is told must not
// describe the server — the missing-SPREADSHEET_ID message names the Script
// Property and the setup function — and must not read as "not authenticated",
// which sync.js takes as a dead session and signs the phone out.
test('an internal failure gets one generic answer, and its detail goes to the log', () => {
  const failures = [
    ['a login while SPREADSHEET_ID is missing', /SPREADSHEET_ID|setupSpreadsheet/, (app) => {
      delete app.env.props.SPREADSHEET_ID;
      return pwLogin(app, 'pw@example.com', 'Right-Password-1');
    }],
    ['a submit while SPREADSHEET_ID is missing', /SPREADSHEET_ID|setupSpreadsheet/, (app) => {
      const token = loggedIn(app, 'nurse@example.com');
      delete app.env.props.SPREADSHEET_ID;
      return app.post({ action: 'submit', token, syncId: crypto.randomUUID(), codename: 'Alpha' });
    }],
    ['a body that is not JSON', /JSON/, (app) => app.postRaw('{"action":"login","email":')],
    ['a body that is JSON null', /null/, (app) => app.postRaw('null')],
  ];
  const answers = failures.map(([what, detail, provoke]) => {
    const app = boot({
      staff: [passwordRow('pw@example.com', 'Right-Password-1', 'salt-a'), nurseRow('nurse@example.com')],
      urlFetch: googleSays({ email: 'nurse@example.com' }),
    });
    const res = provoke(app);
    assert.strictEqual(res.status, 'error', what);
    assert.ok(!detail.test(res.msg || ''), what + ': the caller was told ' + JSON.stringify(res.msg));
    assert.ok(!/not authenticated/i.test(res.msg || ''), what + ': would sign the phone out');
    assert.ok(app.env.logs.some((line) => detail.test(line)),
      what + ': the detail must still reach the execution log, where Praew can read it');
    return res.msg;
  });
  assert.ok(answers.every((m) => m === answers[0]),
    'every internal failure must get the same answer: ' + answers.map((m) => JSON.stringify(m)).join(' | '));
});

// ── 9. Deploy-time facts the fix depends on ──────────────────────────────
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
