// Sends the already-redacted result to the NeoRedact Sync GAS backend.
// Only ever called with the already-redacted canvas and its OCR results —
// see app.js's state machine. Nothing here is a substitute for the local
// export in export.js; sync is additive.
window.NeoRedact = window.NeoRedact || {};

(function () {
  'use strict';

  const QUEUE_KEY = 'neoredact_sync_queue_v1';

  function isConfigured() {
    return typeof NEOREDACT_GAS_URL === 'string' && NEOREDACT_GAS_URL.length > 10;
  }

  function readQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function writeQueue(queue) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  }

  function enqueue(payload) {
    const queue = readQueue();
    queue.push(payload);
    writeQueue(queue);
  }

  function removeFromQueue(syncId) {
    writeQueue(readQueue().filter((p) => p.syncId !== syncId));
  }

  // fields: [{ label, text }] from app.js's review step
  function buildPayload(canvas, fields, ward, sessionToken) {
    const fieldsObj = {};
    fields.forEach((f) => {
      if (f.label && f.label.trim()) fieldsObj[f.label.trim()] = f.text;
    });
    return {
      syncId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
      capturedAt: new Date().toISOString(),
      ward: ward || '',
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

  // Returns { status: 'synced' | 'queued-offline' | 'needs-login' | 'not-configured', detail }
  async function syncNow(canvas, fields, ward) {
    if (!isConfigured()) {
      return { status: 'not-configured' };
    }
    const session = window.NeoRedact.auth.getSession();
    if (!session) {
      return { status: 'needs-login' };
    }
    const payload = buildPayload(canvas, fields, ward, session.token);
    try {
      const result = await postPayload(payload);
      if (isAuthError(result)) {
        enqueue(payload); // keep the data — just needs a fresh login to send
        return { status: 'needs-login' };
      }
      if (result.status === 'error') {
        enqueue(payload);
        return { status: 'queued-offline', detail: result.msg };
      }
      return { status: 'synced', detail: result };
    } catch (err) {
      enqueue(payload);
      return { status: 'queued-offline', detail: err.message };
    }
  }

  // Retries everything in the queue; safe to call repeatedly (server-side
  // dedupe by syncId means a double-flush is harmless). Queued payloads were
  // built with whatever session token was current at capture time — if that
  // session has since expired, this stops and reports needsLogin rather than
  // silently dropping the data; it stays queued either way.
  async function flushQueue() {
    if (!isConfigured()) return { flushed: 0, remaining: readQueue().length, needsLogin: false };
    const queue = readQueue();
    let flushed = 0;
    let needsLogin = false;
    for (const payload of queue) {
      try {
        const result = await postPayload(payload);
        if (result.status === 'ok' || result.status === 'duplicate') {
          removeFromQueue(payload.syncId);
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
    return { flushed, remaining: readQueue().length, needsLogin };
  }

  function queueLength() {
    return readQueue().length;
  }

  window.NeoRedact.sync = { isConfigured, syncNow, flushQueue, queueLength };

  async function flushAndHandleAuth() {
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
