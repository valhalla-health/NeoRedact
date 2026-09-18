// verify-dashboard-escaping.cjs — the dashboard must render submitted text as
// text. Run: node test/verify-dashboard-escaping.cjs
//
// Why this sits next to the auth harness: making the dashboard admin-only is
// only worth something if a non-admin cannot reach it indirectly. Every value
// the table draws — ward, field labels, field text — is typed on a phone by
// whoever submitted the row, and the dashboard is opened by the one account
// that may read the whole collection. Building those cells as HTML hands a
// submitter script execution in the admin's browser, where the admin session
// token lives; the admin-only check would then be a formality.
//
// The invariant is deliberately about the sink, not about one payload: no
// string a submitter controls is ever handed to innerHTML. Escaping or
// textContent both satisfy it; string-concatenating a row into innerHTML does
// not, however the value happens to be spelled.
'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// A value a nurse could type into the ward box on the Review step.
const MARKER = '<img src=x onerror=alert(1)>';

function makeEl(tag) {
  const el = {
    tagName: tag,
    style: {},
    children: [],
    _innerHTML: '',
    _textContent: '',
    get innerHTML() { return el._innerHTML; },
    set innerHTML(v) { el._innerHTML = String(v); htmlWrites.push(String(v)); },
    get textContent() { return el._textContent; },
    set textContent(v) { el._textContent = String(v); },
    appendChild(child) { el.children.push(child); return child; },
    setAttribute(k, v) { el[k] = v; },
    addEventListener() {},
    value: '',
  };
  return el;
}

let htmlWrites = [];

function run(rows) {
  htmlWrites = [];
  const ids = {};
  const document = {
    getElementById: (id) => (ids[id] = ids[id] || makeEl('div')),
    createElement: (tag) => makeEl(tag),
  };

  const session = { token: 'admin-token', name: 'Praew', role: 'admin', email: 'praew@example.com' };
  const sandbox = {
    console,
    JSON,
    Object,
    String,
    document,
    NEOREDACT_GAS_URL: 'https://script.google.com/macros/s/fake/exec',
    NEOREDACT_CLIENT_ID: 'fake.apps.googleusercontent.com',
    window: { NeoRedact: { auth: {
      getSession: () => session,
      renderGoogleButton: () => {},
      loginWithPassword: async () => ({ status: 'ok' }),
    } } },
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok', rows, codenames: [] }) }),
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8'), ctx, { filename: 'dashboard.js' });
  // loadDashboard() is async; let its promise chain settle.
  return new Promise((resolve) => setImmediate(() => setImmediate(() => resolve())));
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n         ' + err.message.split('\n')[0]);
  }
}

(async () => {
  console.log('\ndashboard.js — submitted text is rendered as text\n');

  await test('a ward value is never written into the page as HTML', async () => {
    await run([{
      syncId: 's1', submittedAt: '2026-09-18', capturedAt: '2026-09-18',
      submittedBy: 'nurse@example.com', codename: 'Alpha',
      ward: MARKER, fields: {}, driveFileUrl: '',
    }]);
    const offending = htmlWrites.filter((h) => h.includes(MARKER));
    assert.strictEqual(offending.length, 0,
      'ward text reached innerHTML verbatim: ' + JSON.stringify(offending[0] || '').slice(0, 120));
  });

  await test('field text is never written into the page as HTML', async () => {
    await run([{
      syncId: 's1', submittedAt: '2026-09-18', capturedAt: '2026-09-18',
      submittedBy: 'nurse@example.com', codename: 'Alpha',
      ward: 'NICU', fields: { weight: MARKER }, driveFileUrl: '',
    }]);
    assert.ok(!htmlWrites.some((h) => h.includes(MARKER)), 'field text reached innerHTML verbatim');
  });

  await test('a field label is never written into the page as HTML', async () => {
    await run([{
      syncId: 's1', submittedAt: '2026-09-18', capturedAt: '2026-09-18',
      submittedBy: 'nurse@example.com', codename: 'Alpha',
      ward: 'NICU', fields: { [MARKER]: 'ok' }, driveFileUrl: '',
    }]);
    assert.ok(!htmlWrites.some((h) => h.includes(MARKER)), 'field label reached innerHTML verbatim');
  });

  await test('a codename group header is never written into the page as HTML', async () => {
    await run([{
      syncId: 's1', submittedAt: '2026-09-18', capturedAt: '2026-09-18',
      submittedBy: 'nurse@example.com', codename: MARKER,
      ward: 'NICU', fields: {}, driveFileUrl: '',
    }]);
    assert.ok(!htmlWrites.some((h) => h.includes(MARKER)), 'codename reached innerHTML verbatim');
  });

  await test('a photo link is only ever a real Drive URL', async () => {
    await run([{
      syncId: 's1', submittedAt: '2026-09-18', capturedAt: '2026-09-18',
      submittedBy: 'nurse@example.com', codename: 'Alpha',
      ward: 'NICU', fields: {}, driveFileUrl: 'javascript:alert(1)',
    }]);
    assert.ok(!htmlWrites.some((h) => h.includes('javascript:')),
      'a non-Drive URL must not become a clickable link');
  });

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed\n');
  process.exit(failures.length ? 1 : 0);
})();
