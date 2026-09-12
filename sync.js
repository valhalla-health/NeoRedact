// Sends the already-redacted result to the NeoRedact Sync GAS backend.
// Only ever called with the already-redacted canvas and its manually-typed
// field values — see app.js's state machine. Nothing here is a substitute
// for the local export in export.js; sync is additive.
window.NeoRedact = window.NeoRedact || {};

(function () {
  'use strict';

  // The offline retry queue lives in IndexedDB, not localStorage. A queued
  // payload carries a full-resolution redacted JPEG as base64 — measured at
  // ~2.3 MB of JPEG, so ~3.1 MB of base64 — against a localStorage budget of
  // about 5 MB per origin. The old localStorage queue therefore held exactly
  // ONE photo: the second consecutive failed sync threw QuotaExceededError out
  // of the write, out of enqueue(), and out of syncNow() into an app.js click
  // handler with no catch, which left the Sync button stuck disabled and lost
  // the photo outright. IndexedDB has no comparable cap, and every write below
  // is failure-tolerant regardless — see enqueue().
  const DB_NAME = 'neoredact-sync';
  const DB_VERSION = 1;
  const STORE = 'queue';
  // Legacy localStorage queue: drained into IndexedDB once at startup, then
  // removed. Also the fallback store if IndexedDB is unavailable at all.
  const QUEUE_KEY = 'neoredact_sync_queue_v1';

  // A queue record wraps the payload rather than extending it, so what gets
  // POSTed stays byte-identical to what a direct (unqueued) sync would send.
  function makeRecord(payload) {
    return { syncId: payload.syncId, queuedAt: Date.now(), payload: payload };
  }

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req;
      try {
        if (!self.indexedDB) return resolve(null);
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        return resolve(null); // e.g. storage disabled entirely by browser policy
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'syncId' });
      };
      req.onsuccess = () => resolve(req.result);
      // Private-browsing modes and blocked upgrades land here. Null means
      // "fall back to localStorage", never "throw at the caller".
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  function idbRequest(db, mode, run) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
  }

  function lsRead() {
    try {
      const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
      // Pre-IndexedDB installs stored bare payloads; newer fallback writes store
      // records. Normalize so every caller sees one shape.
      return raw.map((item) => (item && item.payload ? item : makeRecord(item)));
    } catch (e) {
      return [];
    }
  }

  function lsWrite(records) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(records)); // may throw — callers handle
  }

  // queueLength() is read synchronously by app.js's renderSyncUI, so the count is
  // mirrored here rather than awaited. Every mutation below keeps it current, and
  // init() seeds it before a nurse can reach the Export step.
  let cachedCount = 0;

  async function readQueue() {
    const db = await openDb();
    let records;
    if (db) {
      try {
        records = await idbRequest(db, 'readonly', (store) => store.getAll());
      } catch (e) {
        records = [];
      }
    } else {
      records = lsRead();
    }
    // IndexedDB returns rows in key (UUID) order, which is arbitrary — restore
    // the FIFO order the localStorage array used to give for free.
    records.sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
    cachedCount = records.length;
    return records;
  }

  // Returns true if the payload is safely stored, false if it could not be
  // stored at all. Never throws: the caller is already on a failure path, and a
  // second failure here used to be what actually destroyed the photo.
  async function enqueue(payload) {
    const record = makeRecord(payload);
    const db = await openDb();
    try {
      if (db) {
        await idbRequest(db, 'readwrite', (store) => store.put(record));
      } else {
        const records = lsRead();
        records.push(record);
        lsWrite(records);
      }
      cachedCount++;
      return true;
    } catch (e) {
      return false;
    }
  }

  async function removeFromQueue(syncId) {
    const db = await openDb();
    try {
      if (db) {
        await idbRequest(db, 'readwrite', (store) => store.delete(syncId));
      } else {
        lsWrite(lsRead().filter((r) => r.syncId !== syncId));
      }
      if (cachedCount > 0) cachedCount--;
    } catch (e) {
      /* leave it queued; a later flush dedupes server-side by syncId anyway */
    }
  }

  function isConfigured() {
    return typeof NEOREDACT_GAS_URL === 'string' && NEOREDACT_GAS_URL.length > 10;
  }

  // Field labels that would re-identify the patient if they ever reached the
  // cloud sheet — stripped here before anything leaves the device. The
  // backend independently re-filters the same way (defense in depth, same
  // pattern as the redact step never trusting a single check).
  const IDENTIFYING_FIELD_KEYS = /^(hn|dob|name|ชื่อ|an|hn\/an|admission ?number|hospital ?number)$/i;

  // fields: [{ label, text }] from app.js's review step. `id`, when given, is
  // the same artifactId app.js generated at redact time and may already be
  // baked into a local export's filename/content — reusing it here (instead
  // of minting a fresh one) keeps a locally-saved file and its later-synced
  // Sheet row cross-referenceable by the same id.
  function buildPayload(canvas, fields, ward, codename, sessionToken, id) {
    const fieldsObj = {};
    fields.forEach((f) => {
      const label = f.label && f.label.trim();
      if (label && !IDENTIFYING_FIELD_KEYS.test(label)) fieldsObj[label] = f.text;
    });
    return {
      syncId: id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
      capturedAt: new Date().toISOString(),
      ward: ward || '',
      codename: codename || '',
      fields: fieldsObj,
      redactedImageBase64: canvas.toDataURL('image/jpeg', 0.85),
      token: sessionToken || '',
    };
  }

  async function postPayload(payload) {
    const res = await fetch(NEOREDACT_GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight to GAS
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function isAuthError(result) {
    return result.status === 'error' && /not authenticated/i.test(result.msg || '');
  }

  // Returns { status: 'synced' | 'queued-offline' | 'needs-login' | 'queue-failed'
  //           | 'missing-codename' | 'not-configured', detail }
  //
  // 'queue-failed' is the one status that means data is at risk: the send failed
  // AND the device would not store the payload for a retry. app.js must tell the
  // nurse to download the photo locally instead of assuming it was kept.
  async function syncNow(canvas, fields, ward, codename, id) {
    if (!isConfigured()) {
      return { status: 'not-configured' };
    }
    if (!codename) {
      return { status: 'missing-codename' };
    }
    const session = window.NeoRedact.auth.getSession();
    if (!session) {
      return { status: 'needs-login' };
    }
    const payload = buildPayload(canvas, fields, ward, codename, session.token, id);
    try {
      const result = await postPayload(payload);
      if (isAuthError(result)) {
        // keep the data — just needs a fresh login to send
        const kept = await enqueue(payload);
        return kept ? { status: 'needs-login' } : { status: 'queue-failed', detail: 'not authenticated' };
      }
      if (result.status === 'error') {
        const kept = await enqueue(payload);
        return kept
          ? { status: 'queued-offline', detail: result.msg }
          : { status: 'queue-failed', detail: result.msg };
      }
      return { status: 'synced', detail: result };
    } catch (err) {
      const kept = await enqueue(payload);
      return kept
        ? { status: 'queued-offline', detail: err.message }
        : { status: 'queue-failed', detail: err.message };
    }
  }

  // Retries everything in the queue; safe to call repeatedly (server-side
  // dedupe by syncId means a double-flush is harmless). Queued payloads were
  // built with whatever session token was current at capture time — if that
  // session has since expired, this stops and reports needsLogin rather than
  // silently dropping the data; it stays queued either way.
  async function flushQueue() {
    if (!isConfigured()) return { flushed: 0, remaining: cachedCount, needsLogin: false };
    const records = await readQueue();
    let flushed = 0;
    let needsLogin = false;
    for (const record of records) {
      try {
        const result = await postPayload(record.payload);
        if (result.status === 'ok' || result.status === 'duplicate') {
          await removeFromQueue(record.syncId);
          flushed++;
        } else if (isAuthError(result)) {
          needsLogin = true;
          break; // this and later items need a fresh login; stop here
        }
      } catch (err) {
        // still offline — leave it queued, stop trying the rest this pass
        break;
      }
    }
    return { flushed, remaining: cachedCount, needsLogin };
  }

  function queueLength() {
    return cachedCount;
  }

  window.NeoRedact.sync = { isConfigured, syncNow, flushQueue, queueLength };

  // One-time drain of any queue left behind by a pre-IndexedDB install. Runs
  // before the first flush so an upgrading phone doesn't strand the photo it was
  // holding. The localStorage key is cleared only after every record is safely
  // in IndexedDB.
  async function migrateLegacyQueue() {
    const db = await openDb();
    if (!db) return; // still on localStorage; nothing to migrate to
    let legacy;
    try {
      legacy = lsRead();
    } catch (e) {
      return;
    }
    if (!legacy.length) return;
    for (const record of legacy) {
      try {
        await idbRequest(db, 'readwrite', (store) => store.put(record));
      } catch (e) {
        return; // leave localStorage intact so nothing is lost
      }
    }
    try {
      localStorage.removeItem(QUEUE_KEY);
    } catch (e) {
      /* harmless: records are already in IndexedDB and keyed by syncId */
    }
  }

  async function flushAndHandleAuth() {
    await migrateLegacyQueue();
    await readQueue(); // seeds cachedCount for the synchronous queueLength()
    const result = await window.NeoRedact.sync.flushQueue();
    if (result.needsLogin) {
      // Session on file is stale — clear it so the UI naturally asks for a
      // fresh login next time (see app.js's renderSyncUI), instead of
      // silently retrying with a token that will never work again.
      window.NeoRedact.auth.logout();
    }
  }

  window.addEventListener('online', flushAndHandleAuth);
  window.addEventListener('load', flushAndHandleAuth);
})();
