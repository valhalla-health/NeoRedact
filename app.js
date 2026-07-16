// Wizard controller. Owns the one piece of state that must never be faked:
// `state.redacted`. Nothing can reach the OCR step without it, and
// ocr-engine.js independently re-checks it too (see CLAUDE.md).
(function () {
  'use strict';

  const NR = window.NeoRedact;

  const steps = ['capture', 'annotate', 'ocr', 'review', 'export'];
  const stepLabels = { capture: 'Capture', annotate: 'Annotate', ocr: 'Reading', review: 'Review', export: 'Export' };

  const state = {
    redacted: false,
    regions: [],
    results: [], // [{id, label, text}]
    pendingReturnStep: null, // where to go after a login triggered mid-flow
  };

  let annotatorCtrl = null;

  const el = {
    stepBadge: document.getElementById('stepBadge'),
    googleSignInContainer: document.getElementById('googleSignInContainer'),
    btnTogglePasswordForm: document.getElementById('btnTogglePasswordForm'),
    passwordLoginForm: document.getElementById('passwordLoginForm'),
    loginEmail: document.getElementById('loginEmail'),
    loginPassword: document.getElementById('loginPassword'),
    btnPasswordLogin: document.getElementById('btnPasswordLogin'),
    btnBackToGoogle: document.getElementById('btnBackToGoogle'),
    loginError: document.getElementById('loginError'),
    btnSkipLogin: document.getElementById('btnSkipLogin'),
    btnLoginToSync: document.getElementById('btnLoginToSync'),
    btnLogout: document.getElementById('btnLogout'),
    fileInputCamera: document.getElementById('fileInputCamera'),
    fileInputGallery: document.getElementById('fileInputGallery'),
    btnTakePhoto: document.getElementById('btnTakePhoto'),
    btnChooseGallery: document.getElementById('btnChooseGallery'),
    workCanvas: document.getElementById('workCanvas'),
    overlayCanvas: document.getElementById('overlayCanvas'),
    regionList: document.getElementById('regionList'),
    btnRetakePhoto: document.getElementById('btnRetakePhoto'),
    btnGoRedact: document.getElementById('btnGoRedact'),
    redactModalBackdrop: document.getElementById('redactModalBackdrop'),
    redactModalBody: document.getElementById('redactModalBody'),
    btnRedactCancel: document.getElementById('btnRedactCancel'),
    btnRedactConfirm: document.getElementById('btnRedactConfirm'),
    redactedThumb: document.getElementById('redactedThumb'),
    ocrProgressLine: document.getElementById('ocrProgressLine'),
    reviewThumb: document.getElementById('reviewThumb'),
    resultList: document.getElementById('resultList'),
    btnStartOver: document.getElementById('btnStartOver'),
    btnGoExport: document.getElementById('btnGoExport'),
    syncCard: document.getElementById('syncCard'),
    syncHint: document.getElementById('syncHint'),
    btnSync: document.getElementById('btnSync'),
    syncStatusLine: document.getElementById('syncStatusLine'),
    btnExportTxt: document.getElementById('btnExportTxt'),
    btnExportJson: document.getElementById('btnExportJson'),
    btnExportPng: document.getElementById('btnExportPng'),
    btnDone: document.getElementById('btnDone'),
  };

  const ALL_SECTIONS = ['login'].concat(steps);

  function showStep(name) {
    ALL_SECTIONS.forEach((s) => {
      document.getElementById(`step-${s}`).classList.toggle('active', s === name);
    });
    if (steps.includes(name)) {
      const idx = steps.indexOf(name) + 1;
      el.stepBadge.style.display = '';
      el.stepBadge.textContent = `${idx} / ${steps.length} · ${stepLabels[name]}`;
    } else {
      el.stepBadge.style.display = 'none';
    }
    renderAuthFooter();
  }

  function renderAuthFooter() {
    const session = NR.auth.getSession();
    el.btnLogout.style.display = session ? 'block' : 'none';
  }

  // --- Step 0: Login (optional — redact/OCR work fully offline without it) --

  let googleButtonRendered = false;

  function renderLoginStep() {
    if (googleButtonRendered) return;
    googleButtonRendered = true;
    NR.auth.renderGoogleButton(el.googleSignInContainer, onLoginSuccess, onLoginError);
  }

  function onLoginSuccess() {
    el.loginError.style.display = 'none';
    const returnTo = state.pendingReturnStep;
    state.pendingReturnStep = null;
    showStep(returnTo || 'capture');
    if (returnTo === 'export') renderSyncUI();
  }

  function onLoginError(msg) {
    el.loginError.style.display = 'block';
    el.loginError.textContent = msg || 'Login failed.';
  }

  el.btnTogglePasswordForm.addEventListener('click', () => {
    el.passwordLoginForm.style.display = 'block';
    el.btnTogglePasswordForm.style.display = 'none';
  });
  el.btnBackToGoogle.addEventListener('click', () => {
    el.passwordLoginForm.style.display = 'none';
    el.btnTogglePasswordForm.style.display = 'block';
    el.loginError.style.display = 'none';
  });
  el.btnPasswordLogin.addEventListener('click', async () => {
    el.loginError.style.display = 'none';
    const email = el.loginEmail.value.trim();
    const password = el.loginPassword.value;
    if (!email || !password) { onLoginError('Enter both email and password.'); return; }
    el.btnPasswordLogin.disabled = true;
    el.btnPasswordLogin.textContent = 'Signing in…';
    try {
      const result = await NR.auth.loginWithPassword(email, password);
      if (result.status === 'ok') onLoginSuccess();
      else onLoginError(result.msg);
    } catch (err) {
      onLoginError(err.message);
    } finally {
      el.btnPasswordLogin.disabled = false;
      el.btnPasswordLogin.textContent = 'Sign in';
    }
  });
  el.btnSkipLogin.addEventListener('click', () => showStep('capture'));
  el.btnLoginToSync.addEventListener('click', () => {
    state.pendingReturnStep = 'export';
    showStep('login');
  });
  el.btnLogout.addEventListener('click', () => {
    NR.auth.logout();
    renderAuthFooter();
    showStep('capture');
  });

  renderLoginStep(); // set up the Google button once, regardless of which step is shown first

  // --- Step 1: Capture ---------------------------------------------------

  el.btnTakePhoto.addEventListener('click', () => el.fileInputCamera.click());
  el.btnChooseGallery.addEventListener('click', () => el.fileInputGallery.click());

  async function handleFileChosen(evt) {
    const file = evt.target.files && evt.target.files[0];
    evt.target.value = ''; // allow choosing the same file again later
    if (!file) return;

    await NR.cameraCapture.loadImageOntoCanvas(file, el.workCanvas);

    if (!annotatorCtrl) {
      annotatorCtrl = NR.annotator.createAnnotator(el.workCanvas, el.overlayCanvas, {
        onChange: (regions) => { state.regions = regions; renderRegionList(); },
      });
    } else {
      annotatorCtrl.reset();
      annotatorCtrl.syncOverlaySize();
    }
    state.redacted = false;
    state.results = [];
    renderRegionList();
    showStep('annotate');
  }

  el.fileInputCamera.addEventListener('change', handleFileChosen);
  el.fileInputGallery.addEventListener('change', handleFileChosen);

  // --- Step 2: Annotate ---------------------------------------------------

  function renderRegionList() {
    el.regionList.innerHTML = '';
    state.regions.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'region-row';

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Field label (e.g. HN, DOB)';
      input.value = r.label;
      input.addEventListener('input', () => annotatorCtrl.setLabel(r.id, input.value));

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'redact-toggle' + (r.redact ? ' on' : '');
      toggle.textContent = r.redact ? 'REDACT' : 'OCR';
      toggle.addEventListener('click', () => annotatorCtrl.toggleRedact(r.id));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove-btn';
      remove.textContent = '✕';
      remove.addEventListener('click', () => annotatorCtrl.removeRegion(r.id));

      row.append(input, toggle, remove);
      el.regionList.appendChild(row);
    });

    const hasRedactRegion = state.regions.some((r) => r.redact);
    const allLabeled = state.regions.length > 0 && state.regions.every((r) => r.label && r.label.trim());
    el.btnGoRedact.disabled = !(hasRedactRegion && allLabeled);
  }

  el.btnRetakePhoto.addEventListener('click', () => showStep('capture'));

  el.btnGoRedact.addEventListener('click', () => {
    const redactCount = state.regions.filter((r) => r.redact).length;
    const ocrCount = state.regions.length - redactCount;
    el.redactModalBody.textContent =
      `This will permanently black out ${redactCount} region(s) and read ${ocrCount} region(s) as text. ` +
      `The blackout cannot be undone. Continue?`;
    el.redactModalBackdrop.classList.add('active');
  });

  el.btnRedactCancel.addEventListener('click', () => {
    el.redactModalBackdrop.classList.remove('active');
  });

  el.btnRedactConfirm.addEventListener('click', async () => {
    el.redactModalBackdrop.classList.remove('active');

    // The invariant step: mutate the one working canvas in place. No copy of
    // the pre-redaction pixels is made before or after this call.
    NR.redactor.applyRedaction(el.workCanvas, state.regions);
    state.redacted = true;
    annotatorCtrl.redrawOverlay(); // regions still shown as outlines; pixels underneath are now black

    const redactedDataUrl = el.workCanvas.toDataURL('image/png');
    el.redactedThumb.src = redactedDataUrl;

    showStep('ocr');
    await runOcr();
  });

  // --- Step 3: OCR ---------------------------------------------------

  async function runOcr() {
    el.ocrProgressLine.textContent = 'Starting OCR engine…';
    try {
      const results = await NR.ocrEngine.recognizeRegions(el.workCanvas, state.regions, {
        redacted: state.redacted, // must be true — set only by the confirm handler above
        lang: 'tha+eng',
        onProgress: ({ index, total, label }) => {
          el.ocrProgressLine.textContent = `Reading "${label}" (${index + 1}/${total})…`;
        },
      });
      state.results = results;
      renderResults();
      showStep('review');
    } catch (err) {
      el.ocrProgressLine.textContent = 'OCR failed: ' + err.message +
        ' — if this is the first run, the app may need one connection to Wi-Fi to prepare the offline OCR engine.';
    }
  }

  // --- Step 4: Review ---------------------------------------------------

  function renderResults() {
    el.reviewThumb.src = el.workCanvas.toDataURL('image/png');
    el.resultList.innerHTML = '';
    state.results.forEach((r) => {
      const wrap = document.createElement('div');
      wrap.className = 'field-result';

      const label = document.createElement('label');
      label.textContent = r.label;

      const textarea = document.createElement('textarea');
      textarea.value = r.text;
      textarea.addEventListener('input', () => { r.text = textarea.value; });

      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'retry-btn';
      retry.textContent = 'Retry OCR on this field';
      retry.addEventListener('click', async () => {
        retry.textContent = 'Reading…';
        const region = state.regions.find((reg) => reg.id === r.id);
        const [single] = await NR.ocrEngine.recognizeRegions(el.workCanvas, [region], {
          redacted: state.redacted,
          lang: 'tha+eng',
        });
        r.text = single.text;
        textarea.value = single.text;
        retry.textContent = 'Retry OCR on this field';
      });

      wrap.append(label, textarea, retry);
      el.resultList.appendChild(wrap);
    });
  }

  el.btnStartOver.addEventListener('click', resetAll);
  el.btnGoExport.addEventListener('click', () => {
    showStep('export');
    el.syncStatusLine.style.display = 'none';
    renderSyncUI();
  });

  // --- Step 5: Export ---------------------------------------------------

  function renderSyncUI() {
    if (!NR.sync.isConfigured()) {
      el.btnSync.style.display = 'none';
      el.btnLoginToSync.style.display = 'none';
      el.syncHint.textContent = 'Sync isn’t set up on this device yet — use the downloads below instead.';
      return;
    }
    const session = NR.auth.getSession();
    if (!session) {
      el.btnSync.style.display = 'none';
      el.btnLoginToSync.style.display = 'block';
      el.syncHint.textContent = 'Log in to send the redacted photo and fields to the NICU Sheet.';
      return;
    }
    el.btnSync.style.display = 'block';
    el.btnLoginToSync.style.display = 'none';
    el.btnSync.disabled = false;
    const queued = NR.sync.queueLength();
    el.syncHint.textContent =
      `Signed in as ${session.name}. ` +
      (queued > 0
        ? `Send the redacted photo and fields to the NICU Sheet. (${queued} earlier submission${queued === 1 ? '' : 's'} still queued offline.)`
        : 'Send the redacted photo and fields to the NICU Sheet.');
  }

  el.btnSync.addEventListener('click', async () => {
    el.btnSync.disabled = true;
    el.syncStatusLine.style.display = 'block';
    el.syncStatusLine.textContent = 'Syncing…';
    const result = await NR.sync.syncNow(el.workCanvas, state.results, '');
    if (result.status === 'synced') {
      el.syncStatusLine.textContent = 'Synced to the NICU Sheet.';
    } else if (result.status === 'needs-login') {
      el.syncStatusLine.textContent = 'Saved on this phone — your login expired, sign in again to send it.';
      NR.auth.logout();
    } else if (result.status === 'queued-offline') {
      el.syncStatusLine.textContent = 'No connection right now — saved on this phone and will send automatically once back online.';
    } else {
      el.syncStatusLine.textContent = 'Sync isn’t configured on this device.';
    }
    renderSyncUI();
  });

  el.btnExportTxt.addEventListener('click', () => NR.exportModule.exportTxt(state.results));
  el.btnExportJson.addEventListener('click', () => NR.exportModule.exportJson(state.results));
  el.btnExportPng.addEventListener('click', () => NR.exportModule.exportRedactedPng(el.workCanvas));
  el.btnDone.addEventListener('click', resetAll);

  function resetAll() {
    state.redacted = false;
    state.regions = [];
    state.results = [];
    if (annotatorCtrl) annotatorCtrl.reset();
    const ctx = el.workCanvas.getContext('2d');
    ctx.clearRect(0, 0, el.workCanvas.width, el.workCanvas.height);
    showStep('capture');
  }

  showStep(NR.auth.getSession() ? 'capture' : 'login');

  // First-run (or cache-cleared) offline-engine warm-up indicator. The service
  // worker's install step precaches both the app shell and the ~15-20MB OCR
  // engine tier before it activates, so `serviceWorker.ready` resolving is a
  // reliable signal that the one-time download has finished — see sw.js.
  const swStatus = document.getElementById('swStatus');
  if ('serviceWorker' in navigator) {
    if (!navigator.serviceWorker.controller) {
      swStatus.style.display = 'block';
      swStatus.textContent = 'Preparing offline OCR engine (one-time download, needs Wi-Fi)…';
    }
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('NeoRedact: service worker registration failed', err);
        swStatus.style.display = 'block';
        swStatus.textContent = 'Could not prepare the offline OCR engine — check your connection and reload.';
      });
    });
    navigator.serviceWorker.ready.then(() => {
      swStatus.style.display = 'none';
    });
  }
})();
