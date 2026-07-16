// Wizard controller. Owns the one piece of state that must never be faked:
// `state.redacted`. Nothing can reach the OCR step without it, and
// ocr-engine.js independently re-checks it too (see CLAUDE.md).
(function () {
  'use strict';

  const NR = window.NeoRedact;

  const steps = ['capture', 'annotate', 'ocr', 'review', 'codename', 'export'];
  const stepLabels = {
    capture: 'ถ่ายรูป', annotate: 'ทำเครื่องหมาย', ocr: 'กำลังอ่าน', review: 'ตรวจสอบ',
    codename: 'เลือกรหัส', export: 'ส่งออก',
  };

  const state = {
    redacted: false,
    regions: [],
    results: [], // [{id, label, text}]
    codename: '',
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
    codenameGrid: document.getElementById('codenameGrid'),
    btnBackToReview: document.getElementById('btnBackToReview'),
    btnGoExportFromCodename: document.getElementById('btnGoExportFromCodename'),
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
    el.loginError.textContent = msg || 'เข้าสู่ระบบไม่สำเร็จ';
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
    if (!email || !password) { onLoginError('กรุณากรอกทั้งอีเมลและรหัสผ่าน'); return; }
    el.btnPasswordLogin.disabled = true;
    el.btnPasswordLogin.textContent = 'กำลังเข้าสู่ระบบ…';
    try {
      const result = await NR.auth.loginWithPassword(email, password);
      if (result.status === 'ok') onLoginSuccess();
      else onLoginError(result.msg);
    } catch (err) {
      onLoginError(err.message);
    } finally {
      el.btnPasswordLogin.disabled = false;
      el.btnPasswordLogin.textContent = 'เข้าสู่ระบบ';
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
      input.placeholder = 'ชื่อข้อมูล (เช่น HN, DOB)';
      input.value = r.label;
      input.addEventListener('input', () => annotatorCtrl.setLabel(r.id, input.value));

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'redact-toggle' + (r.redact ? ' on' : '');
      toggle.textContent = r.redact ? 'ปิดชื่อ' : 'อ่านค่า';
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
      `การดำเนินการนี้จะปิดทับถาวร ${redactCount} ตำแหน่ง และอ่านค่า ${ocrCount} ตำแหน่งเป็นข้อความ ` +
      `การปิดทับไม่สามารถย้อนกลับได้ ดำเนินการต่อหรือไม่?`;
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
    el.ocrProgressLine.textContent = 'กำลังเริ่มเครื่องมือ OCR…';
    try {
      const results = await NR.ocrEngine.recognizeRegions(el.workCanvas, state.regions, {
        redacted: state.redacted, // must be true — set only by the confirm handler above
        lang: 'tha+eng',
        onProgress: ({ index, total, label }) => {
          el.ocrProgressLine.textContent = `กำลังอ่าน "${label}" (${index + 1}/${total})…`;
        },
      });
      state.results = results;
      renderResults();
      showStep('review');
    } catch (err) {
      el.ocrProgressLine.textContent = 'OCR ล้มเหลว: ' + err.message +
        ' — หากเป็นการใช้งานครั้งแรก แอปอาจต้องเชื่อมต่อ Wi-Fi หนึ่งครั้งเพื่อเตรียมเครื่องมือ OCR แบบออฟไลน์';
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
      retry.textContent = 'อ่านซ้ำอีกครั้ง';
      retry.addEventListener('click', async () => {
        retry.textContent = 'กำลังอ่าน…';
        const region = state.regions.find((reg) => reg.id === r.id);
        const [single] = await NR.ocrEngine.recognizeRegions(el.workCanvas, [region], {
          redacted: state.redacted,
          lang: 'tha+eng',
        });
        r.text = single.text;
        textarea.value = single.text;
        retry.textContent = 'อ่านซ้ำอีกครั้ง';
      });

      wrap.append(label, textarea, retry);
      el.resultList.appendChild(wrap);
    });
  }

  el.btnStartOver.addEventListener('click', resetAll);
  el.btnGoExport.addEventListener('click', () => {
    renderCodenameGrid();
    showStep('codename');
  });

  // --- Step 5: Codename ----------------------------------------------------
  // The only patient identifier that ever leaves the device — a fixed pool of
  // 26, no real name/HN/DOB attached. See codenames.js / CLAUDE.md.

  function renderCodenameGrid() {
    el.codenameGrid.innerHTML = '';
    NR.CODENAMES.forEach((name) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'codename-btn' + (state.codename === name ? ' selected' : '');
      btn.textContent = name;
      btn.addEventListener('click', () => {
        state.codename = name;
        renderCodenameGrid();
      });
      el.codenameGrid.appendChild(btn);
    });
    el.btnGoExportFromCodename.disabled = !state.codename;
  }

  el.btnBackToReview.addEventListener('click', () => showStep('review'));
  el.btnGoExportFromCodename.addEventListener('click', () => {
    showStep('export');
    el.syncStatusLine.style.display = 'none';
    renderSyncUI();
  });

  // --- Step 6: Export ---------------------------------------------------

  function renderSyncUI() {
    if (!NR.sync.isConfigured()) {
      el.btnSync.style.display = 'none';
      el.btnLoginToSync.style.display = 'none';
      el.syncHint.textContent = 'อุปกรณ์นี้ยังไม่ได้ตั้งค่า sync — ใช้การดาวน์โหลดด้านล่างแทน';
      return;
    }
    const session = NR.auth.getSession();
    if (!session) {
      el.btnSync.style.display = 'none';
      el.btnLoginToSync.style.display = 'block';
      el.syncHint.textContent = 'เข้าสู่ระบบเพื่อส่งรูปที่ปิดชื่อแล้วและข้อมูลไปยัง NICU Sheet';
      return;
    }
    el.btnSync.style.display = 'block';
    el.btnLoginToSync.style.display = 'none';
    el.btnSync.disabled = false;
    const queued = NR.sync.queueLength();
    el.syncHint.textContent =
      `เข้าสู่ระบบในชื่อ ${session.name} ` +
      (queued > 0
        ? `ส่งรูปที่ปิดชื่อแล้วและข้อมูลไปยัง NICU Sheet (มี ${queued} รายการก่อนหน้ายังค้างอยู่แบบออฟไลน์)`
        : 'ส่งรูปที่ปิดชื่อแล้วและข้อมูลไปยัง NICU Sheet');
  }

  el.btnSync.addEventListener('click', async () => {
    el.btnSync.disabled = true;
    el.syncStatusLine.style.display = 'block';
    el.syncStatusLine.textContent = 'กำลัง sync…';
    const result = await NR.sync.syncNow(el.workCanvas, state.results, '', state.codename);
    if (result.status === 'synced') {
      el.syncStatusLine.textContent = 'Sync ไปยัง NICU Sheet เรียบร้อยแล้ว';
    } else if (result.status === 'needs-login') {
      el.syncStatusLine.textContent = 'บันทึกไว้ในเครื่องนี้แล้ว — การเข้าสู่ระบบหมดอายุ กรุณาเข้าสู่ระบบใหม่เพื่อส่งข้อมูล';
      NR.auth.logout();
    } else if (result.status === 'queued-offline') {
      el.syncStatusLine.textContent = 'ขณะนี้ไม่มีการเชื่อมต่อ — บันทึกไว้ในเครื่องนี้แล้ว และจะส่งอัตโนมัติเมื่อกลับมาออนไลน์';
    } else if (result.status === 'missing-codename') {
      el.syncStatusLine.textContent = 'กรุณาเลือกรหัสผู้ป่วยก่อน sync';
    } else {
      el.syncStatusLine.textContent = 'อุปกรณ์นี้ยังไม่ได้ตั้งค่า sync';
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
    state.codename = '';
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
      swStatus.textContent = 'กำลังเตรียมเครื่องมือ OCR แบบออฟไลน์ (ดาวน์โหลดครั้งเดียว ต้องใช้ Wi-Fi)…';
    }
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('NeoRedact: service worker registration failed', err);
        swStatus.style.display = 'block';
        swStatus.textContent = 'เตรียมเครื่องมือ OCR แบบออฟไลน์ไม่สำเร็จ — ตรวจสอบการเชื่อมต่อแล้วโหลดใหม่';
      });
    });
    navigator.serviceWorker.ready.then(() => {
      swStatus.style.display = 'none';
    });
  }
})();
