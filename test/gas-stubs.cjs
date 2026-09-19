// gas-stubs.cjs — an Apps Script double for the backend harnesses.
// Not a harness itself: run test/verify-*.cjs.
//
// Loads the REAL backend/Code.gs into a Node vm and gives it just enough of
// Apps Script to run the login / submit / dashboard paths:
//   • Sheets: appendRow, getDataRange, getRange().getValues()/setValues(),
//     getLastRow() = last row WITH content — so "was a Staff row appended?"
//     is an observable fact, not a stub assertion. Writes behave as Sheets
//     treats a string: one starting with = + - @ (and not a plain number)
//     becomes a live FORMULA, recorded in env.injections; a leading apostrophe
//     forces text and is not part of the stored value, so it reads back
//     without it. Rows passed to boot() are stored as given, which is how a
//     test plants what a sheet would hand back;
//   • CacheService / PropertiesService: real state a later request has to
//     look up (sessions, lockout counters);
//   • LockService: a script lock that can be told to time out
//     (env.lockTimeout), counting waits and releases, so a test can see what
//     the lock was held around;
//   • UrlFetchApp: scripted per test (this is what token verification uses),
//     recording every call so a test can prove the network check happened
//     rather than trusting that it did;
//   • Utilities: real SHA-256/HMAC-SHA256/base64 via node:crypto, GAS-style
//     signed bytes. Every hash call is counted and its input passed to
//     env.onHash, so a test can see how much hashing a request did and fire
//     an overlapping request from inside it.
//
// The source under test is ../backend/Code.gs, or the file named by
// NEOREDACT_GAS_SRC (used to run a harness against an older revision to prove
// it fails there).
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');

const SRC_PATH = process.env.NEOREDACT_GAS_SRC || path.join(__dirname, '..', 'backend', 'Code.gs');

const STAFF_HEADER = ['email', 'role', 'name', 'active', 'password_hash', 'salt'];
const SUBMISSION_HEADER = [
  'syncId', 'submitted_at', 'device_captured_at', 'submitted_by', 'codename',
  'ward', 'fields_json', 'drive_file_url', 'ocr_status', 'ocr_data_json',
];

// A plain number is stored as a number whatever its sign, so "-5" is data;
// "-A1", "+SUM(…)", "=…" and "@…" are formulas.
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

function makeSheet(name, rows, env) {
  const data = (rows || []).map((r) => r.slice());
  // What Sheets makes of one value written to a cell. rowIdx/colIdx are 0-based.
  function store(v, rowIdx, colIdx) {
    if (typeof v !== 'string') return v;
    if (v.charAt(0) === "'") return v.slice(1);
    if (/^[=+\-@]/.test(v) && !PLAIN_NUMBER.test(v)) {
      env.injections.push({ sheet: name, row: rowIdx + 1, col: colIdx + 1, value: v });
    }
    return v;
  }
  const sh = {
    getName: () => name,
    _data: data,
    _lastRow() {
      for (let i = data.length - 1; i >= 0; i--) {
        if ((data[i] || []).some((v) => v !== '' && v != null)) return i + 1;
      }
      return 0;
    },
    getLastRow() { return sh._lastRow(); },
    appendRow(row) {
      const rowIdx = data.length;
      data.push(row.map((v, j) => store(v, rowIdx, j)));
    },
    getDataRange() {
      return {
        getValues() {
          const lr = sh._lastRow();
          if (!lr) return [[]];
          const width = Math.max(...data.slice(0, lr).map((r) => r.length), 1);
          return data.slice(0, lr).map((r) => {
            const out = r.slice();
            while (out.length < width) out.push('');
            return out;
          });
        },
      };
    },
    getRange(r, c, nr, nc) {
      nr = nr == null ? 1 : nr;
      nc = nc == null ? 1 : nc;
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const src = data[r - 1 + i] || [];
            const line = [];
            for (let j = 0; j < nc; j++) {
              const v = src[c - 1 + j];
              line.push(v === undefined || v === null ? '' : v);
            }
            out.push(line);
          }
          return out;
        },
        setValues(vals) {
          vals.forEach((line, i) => {
            const rowIdx = r - 1 + i;
            while (data.length <= rowIdx) data.push([]);
            const row = data[rowIdx];
            line.forEach((v, j) => {
              const colIdx = c - 1 + j;
              while (row.length < colIdx) row.push('');
              row[colIdx] = store(v, rowIdx, colIdx);
            });
          });
          return this;
        },
        setFontWeight() { return this; },
        setBackground() { return this; },
        setFontColor() { return this; },
      };
    },
    setFrozenRows() {},
    setColumnWidths() {},
  };
  return sh;
}

// opts.staff / opts.submissions: data rows (WITHOUT the header row).
// opts.urlFetch: (url, params) => { code, body } — scripted token verification.
function boot(opts) {
  opts = opts || {};

  const env = {
    urlFetchCalls: [],
    logs: [],
    props: Object.assign({ SPREADSHEET_ID: 'sheet-under-test' }, opts.props || {}),
    cache: new Map(),
    driveFiles: [],
    uuidSeq: 0,
    injections: [], // cells a write turned into a live formula — see makeSheet
    lockTimeout: false, // true: every waitLock() times out, as under contention
    lockWaits: 0,
    lockHeld: 0,
    lockReleases: 0,
    hmacCalls: 0,
    digestCalls: 0,
    onHash: null, // (input) => void, called before every hash is computed
  };

  const sheets = {
    Staff: makeSheet('Staff', [STAFF_HEADER].concat(opts.staff || []), env),
    Submissions: makeSheet('Submissions', [SUBMISSION_HEADER].concat(opts.submissions || []), env),
  };
  env.sheets = sheets;

  // Default: Google rejects the token. A test that wants a good token says so.
  const urlFetch = opts.urlFetch || (() => ({ code: 400, body: '{"error":"invalid_token"}' }));

  const spreadsheet = {
    getId: () => 'sheet-under-test',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/sheet-under-test',
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = makeSheet(n, [], env); return sheets[n]; },
    getSheets: () => Object.values(sheets),
    deleteSheet: () => {},
  };

  const sandbox = {
    console,
    JSON,
    Math,
    Date,
    String,
    Number,
    Object,
    Array,
    RegExp,
    Error,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,

    Logger: { log: (m) => env.logs.push(String(m)) },

    Session: { getScriptTimeZone: () => 'Asia/Bangkok' },

    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in env.props ? env.props[k] : null),
        setProperty: (k, v) => { env.props[k] = v; },
        deleteProperty: (k) => { delete env.props[k]; },
      }),
    },

    CacheService: {
      getScriptCache: () => ({
        get: (k) => (env.cache.has(k) ? env.cache.get(k) : null),
        put: (k, v) => { env.cache.set(k, v); },
        remove: (k) => { env.cache.delete(k); },
      }),
    },

    LockService: {
      getScriptLock: () => ({
        waitLock: () => {
          env.lockWaits++;
          if (env.lockTimeout) throw new Error('Lock timeout: another process was holding the lock for too long.');
          env.lockHeld++;
        },
        tryLock: () => {
          env.lockWaits++;
          if (env.lockTimeout) return false;
          env.lockHeld++;
          return true;
        },
        hasLock: () => env.lockHeld > 0,
        releaseLock: () => {
          env.lockReleases++;
          if (env.lockHeld > 0) env.lockHeld--;
        },
      }),
    },

    SpreadsheetApp: {
      openById: () => spreadsheet,
      create: () => spreadsheet,
    },

    UrlFetchApp: {
      fetch: (url, params) => {
        env.urlFetchCalls.push({ url: String(url), params: params || {} });
        const r = urlFetch(String(url), params || {});
        if (r && r.throws) throw new Error(r.throws);
        return {
          getResponseCode: () => r.code,
          getContentText: () => r.body,
        };
      },
    },

    DriveApp: {
      getFolderById: () => { throw new Error('no such folder'); },
      createFolder: (n) => makeFolder(n),
    },

    Utilities: {
      getUuid: () => 'uuid-' + (++env.uuidSeq),
      base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')).map((b) => (b > 127 ? b - 256 : b)),
      newBlob: (bytes) => ({
        getDataAsString: () => Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b))).toString('utf8'),
        getBytes: () => bytes,
      }),
      computeDigest: (_alg, value) => {
        env.digestCalls++;
        if (env.onHash) env.onHash(String(value));
        const h = crypto.createHash('sha256').update(String(value), 'utf8').digest();
        return Array.from(h).map((b) => (b > 127 ? b - 256 : b));
      },
      computeHmacSha256Signature: (value, key) => {
        env.hmacCalls++;
        if (env.onHash) env.onHash(String(value));
        const h = crypto.createHmac('sha256', Buffer.from(String(key), 'utf8')).update(String(value), 'utf8').digest();
        return Array.from(h).map((b) => (b > 127 ? b - 256 : b));
      },
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8', US_ASCII: 'US_ASCII' },
      formatDate: (d, _tz, fmt) => {
        const iso = new Date(d).toISOString();
        if (fmt === 'yyyy-MM-dd') return iso.slice(0, 10);
        return iso;
      },
    },

    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({
        _text: text,
        setMimeType() { return this; },
        getContent() { return this._text; },
      }),
    },
  };

  function makeFolder(name) {
    return {
      getName: () => name,
      getId: () => 'folder-' + name,
      getFoldersByName: () => ({ hasNext: () => false, next: () => null }),
      createFolder: (n) => makeFolder(n),
      createFile: (blob) => {
        env.driveFiles.push({ folder: name, blob });
        return { getUrl: () => 'https://drive.google.com/file/d/fake/view' };
      },
    };
  }

  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  vm.runInContext(src, ctx, { filename: SRC_PATH });

  // Calls the real doPost the way the web app does, and parses its JSON reply.
  function post(body) {
    return postRaw(JSON.stringify(body));
  }
  // The same, with the request body exactly as given — for bodies no client
  // would build, like one that isn't JSON at all.
  function postRaw(contents) {
    ctx.__body = contents;
    const out = vm.runInContext('doPost({ postData: { contents: __body } })', ctx);
    return JSON.parse(out.getContent());
  }

  return {
    env,
    ctx,
    post,
    postRaw,
    staffRows: () => sheets.Staff.getDataRange().getValues().slice(1),
    submissionRows: () => sheets.Submissions.getDataRange().getValues().slice(1),
    tokenInfoCalls: () => env.urlFetchCalls.filter((c) => /tokeninfo/.test(c.url)),
  };
}

// A syntactically well-formed Google ID token whose signature is meaningless.
// Only a real verification step can tell this apart from a genuine token.
function unsignedToken(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64(payload) + '.' + 'not-a-real-signature';
}

// Runs fn with Date.now() pinned to `ms`. The sandbox shares this realm's Date,
// so this is the clock the backend reads too.
function withNow(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

module.exports = { boot, unsignedToken, withNow, STAFF_HEADER, SUBMISSION_HEADER, SRC_PATH };
