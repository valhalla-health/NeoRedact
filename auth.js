// Per-nurse login against neoredact-sync's GAS backend — Google Sign-In or
// email/password, both produce the same session object. Login is optional:
// redaction and field entry work fully offline without it (see app.js) — a
// session is only needed to reach sync.js's Sync button.
window.NeoRedact = window.NeoRedact || {};

(function () {
  'use strict';

  const SESSION_KEY = 'neoredact_session_v1';

  function isConfigured() {
    return typeof NEOREDACT_GAS_URL === 'string' && NEOREDACT_GAS_URL.length > 10;
  }

  function getSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function setSession(session) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function logout() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  async function postLogin(payload) {
    const res = await fetch(NEOREDACT_GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight to GAS
      body: JSON.stringify(Object.assign({ action: 'login' }, payload)),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function loginWithGoogleToken(idToken) {
    const result = await postLogin({ googleToken: idToken });
    if (result.status === 'ok') {
      setSession({ token: result.token, name: result.name, role: result.role, email: result.email });
    }
    return result;
  }

  async function loginWithPassword(email, password) {
    const result = await postLogin({ email, password });
    if (result.status === 'ok') {
      setSession({ token: result.token, name: result.name, role: result.role, email: result.email });
    }
    return result;
  }

  // Renders the Google Sign-In button into `container` once Google Identity
  // Services has finished loading (it's tagged async/defer, so it may not be
  // ready yet when this first runs — poll briefly rather than assume).
  function renderGoogleButton(container, onSuccess, onError) {
    if (!isConfigured()) {
      container.textContent = 'อุปกรณ์นี้ยังไม่ได้ตั้งค่า sync';
      return;
    }
    if (!NEOREDACT_CLIENT_ID) {
      container.textContent = 'ยังไม่ได้ตั้งค่า Google Sign-In บนอุปกรณ์นี้ — ใช้อีเมลและรหัสผ่านแทน';
      return;
    }
    let attempts = 0;
    function tryInit() {
      if (!(window.google && window.google.accounts && window.google.accounts.id)) {
        if (++attempts > 40) { container.textContent = 'โหลด Google Sign-In ไม่สำเร็จ — ตรวจสอบการเชื่อมต่อ'; return; }
        setTimeout(tryInit, 250);
        return;
      }
      google.accounts.id.initialize({
        client_id: NEOREDACT_CLIENT_ID,
        callback: async (resp) => {
          try {
            const result = await loginWithGoogleToken(resp.credential);
            if (result.status === 'ok') onSuccess(result);
            else onError(result.msg || 'Login failed');
          } catch (err) {
            onError(err.message);
          }
        },
      });
      google.accounts.id.renderButton(container, { theme: 'filled_black', size: 'large', width: 280 });
    }
    tryInit();
  }

  window.NeoRedact.auth = {
    isConfigured,
    getSession,
    setSession,
    logout,
    loginWithPassword,
    renderGoogleButton,
  };
})();
