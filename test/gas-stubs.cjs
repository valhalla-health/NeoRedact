// gas-stubs.cjs — an Apps Script double for the backend harnesses.
// Not a harness itself: run backend/test/verify-*.cjs.
//
// Loads the REAL backend/Code.gs into a Node vm and gives it just enough of
// Apps Script to run the login / submit / dashboard paths:
//   • Sheets: appendRow, getDataRange, getRange().getValues()/setValues(),
//     getLastRow() = last row WITH content — so "was a Staff row appended?"
//     is an observable fact, not a stub assertion;
//   • CacheService: put/get/remove, so a session is real state a later
//     request has to look up;
//   • UrlFetchApp: scripted per test (this is what token verification uses),
//     recording every call so a test can prove the network check happened
//     rather than trusting that it did;
//   • Utilities: real SHA-256/base64 via node:crypto, GAS-style signed bytes.
//
// The source under test is ../Code.gs, or the file named by NEOREDACT_GAS_SRC
// (used to run a harness against an older revision to prove it fails there).
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

function makeSheet(name, rows) {
  const data = (rows || []).map((r) => r.slice());
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
    appendRow(row) { data.push(row.slice()); },
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
              row[colIdx] = v;
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
  };

  const sheets = {
    Staff: makeSheet('Staff', [STAFF_HEADER].concat(opts.staff || [])),
    Submissions: makeSheet('Submissions', [SUBMISSION_HEADER].concat(opts.submissions || [])),
  };
  env.sheets = sheets;

  // Default: Google rejects the token. A test that wants a good token says so.
  const urlFetch = opts.urlFetch || (() => ({ code: 400, body: '{"error":"invalid_token"}' }));

  const spreadsheet = {
    getId: () => 'sheet-under-test',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/sheet-under-test',
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = makeSheet(n, []); return sheets[n]; },
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
        const h = crypto.createHash('sha256').update(String(value), 'utf8').digest();
        return Array.from(h).map((b) => (b > 127 ? b - 256 : b));
      },
      DigestAlgorithm: { SHA_256: 'SHA_256' },
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
    ctx.__body = JSON.stringify(body);
    const out = vm.runInContext('doPost({ postData: { contents: __body } })', ctx);
    return JSON.parse(out.getContent());
  }

  return {
    env,
    ctx,
    post,
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

module.exports = { boot, unsignedToken, STAFF_HEADER, SUBMISSION_HEADER, SRC_PATH };
