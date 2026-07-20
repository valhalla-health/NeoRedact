// Wizard controller. Owns the one piece of state that must never be faked:
// `state.redacted`. Nothing can reach the Review step until it, and
// redactor.js's own caller (see below) never lets a region's pixels reach
// anywhere else beforehand (see CLAUDE.md).
(function () {
  'use strict';

  const NR = window.NeoRedact;

  const steps = ['codename', 'capture', 'annotate', 'review', 'export'];
  const stepLabels = {
    codename: 'เลือกรหัส', capture: 'ถ่ายรูป', annotate: 'ทำเครื่องหมาย',
    review: 'ตรวจสอบ', export: 'ส่งออก',
  };

  const state = {
    redacted: false,
    regions: [],
    results: [], // [{id, label, text}]
    codename: '',
    templateId: 'manual', // which KCMH page template (if any) auto-seeds redact boxes
    artifactId: '', // one id per photo — see btnRedactConfirm handler
    photoCount: 0, // photos captured for the current codename this session — see btnAddAnotherPhoto
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
    codenameGrid: document.getElementById('codenameGrid'),
    btnBackToLoginFromCodename: document.getElementById('btnBackToLoginFromCodename'),
    btnCodenameContinue: document.getElementById('btnCodenameContinue'),
    templateSelect: document.getElementById('templateSelect'),
    templateHint: document.getElementById('templateHint'),
    fileInputCamera: document.getElementById('fileInputCamera'),
    fileInputGallery: document.getElementById('fileInputGallery'),
    btnTakePhoto: document.getElementById('btnTakePhoto'),
    btnChooseGallery: document.getElementById('btnChooseGallery'),
    btnBackToCodenameFromCapture: document.getElementById('btnBackToCodenameFromCapture'),
    workCanvas: document.getElementById('workCanvas'),
    overlayCanvas: document.getElementById('overlayCanvas'),
    zoomSurface: document.getElementById('zoomSurface'),
    regionList: document.getElementById('regionList'),
    btnRetakePhoto: document.getElementById('btnRetakePhoto'),
    btnGoRedact: document.getElementById('btnGoRedact'),
    redactModalBackdrop: document.getElementById('redactModalBackdrop'),
    redactModalBody: document.getElementById('redactModalBody'),
    btnRedactCancel: document.getElementById('btnRedactCancel'),
    btnRedactConfirm: document.getElementById('btnRedactConfirm'),
    reviewThumb: document.getElementById('reviewThumb'),
    resultList: document.getElementById('resultList'),
    btnBackToAnnotate: document.getElementById('btnBackToAnnotate'),
    btnStartOver: document.getElementById('btnStartOver'),
    btnGoExport: document.getElementById('btnGoExport'),
    btnBackToReviewFromExport: document.getElementById('btnBackToReviewFromExport'),
    syncCard: document.getElementById('syncCard'),
    syncHint: document.getElementById('syncHint'),
    btnSync: document.getElementById('btnSync'),
    syncStatusLine: document.getElementById('syncStatusLine'),
    btnExportPng: document.getElementById('btnExportPng'),
    photoCountHint: document.getElementById('photoCountHint'),
    btnAddAnotherPhoto: document.getElementById('btnAddAnotherPhoto'),
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
    if (name === 'codename') renderCodenameGrid();
    renderAuthFooter();
  }

  function renderAuthFooter() {
    const session = NR.auth.getSession();
    document.querySelector('footer.bottombar').style.display = session ? 'block' : 'none';
    el.btnLogout.style.display = session ? 'block' : 'none';
  }

  // --- Step 0: Login (optional — redact/field-entry work fully offline without it) --

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
    showStep(returnTo || 'codename');
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
  el.btnSkipLogin.addEventListener('click', () => showStep('codename'));
  el.btnLoginToSync.addEventListener('click', () => {
    state.pendingReturnStep = 'export';
    showStep('login');
  });
  el.btnLogout.addEventListener('click', () => {
    NR.auth.logout();
    renderAuthFooter();
    showStep('codename');
  });

  renderLoginStep(); // set up the Google button once, regardless of which step is shown first

  // --- Step 1 (shown first): Codename --------------------------------------
  // The only patient identifier that ever leaves the device — a fixed pool of
  // 24, no real name/HN/DOB attached. Picked before Capture so every artifact
  // produced downstream (redacted image, manually-typed field values, local
  // export, Sync payload) is already tagged. See codenames.js / CLAUDE.md.

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
    el.btnCodenameContinue.disabled = !state.codename;
  }

  el.btnBackToLoginFromCodename.addEventListener('click', () => showStep('login'));
  el.btnCodenameContinue.addEventListener('click', () => showStep('capture'));

  // --- Step 2: Capture -----------------------------------------------------

  const MANUAL_TEMPLATE_HINT = 'ไม่วางกรอบอัตโนมัติ — ลากกรอบทับชื่อผู้ป่วยเองตามปกติ';
  const KCMH_TEMPLATE_HINT =
    'ระบบจะวางกรอบปิดทึบตำแหน่งโลโก้โรงพยาบาลและสติกเกอร์ (ชื่อ/HN/AN) ให้อัตโนมัติ — ' +
    'ตำแหน่งเป็นค่าประมาณ ตรวจสอบและลบ/วาดใหม่ได้เสมอก่อนกดดำเนินการต่อ';

  function renderTemplateOptions() {
    if (!el.templateSelect) return;
    el.templateSelect.innerHTML = '';
    const manualOpt = document.createElement('option');
    manualOpt.value = 'manual';
    manualOpt.textContent = 'อื่นๆ / ป้ายชื่อ (วาดกรอบเอง)';
    el.templateSelect.appendChild(manualOpt);

    NR.templates.list.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.title;
      el.templateSelect.appendChild(opt);
    });

    el.templateSelect.value = state.templateId;
    updateTemplateHint();
  }

  function updateTemplateHint() {
    if (!el.templateHint) return;
    el.templateHint.textContent = state.templateId === 'manual' ? MANUAL_TEMPLATE_HINT : KCMH_TEMPLATE_HINT;
  }

  el.templateSelect.addEventListener('change', () => {
    state.templateId = el.templateSelect.value;
    updateTemplateHint();
  });

  renderTemplateOptions();

  el.btnTakePhoto.addEventListener('click', () => el.fileInputCamera.click());
  el.btnChooseGallery.addEventListener('click', () => el.fileInputGallery.click());
  el.btnBackToCodenameFromCapture.addEventListener('click', () => showStep('codename'));

  async function handleFileChosen(evt) {
    const file = evt.target.files && evt.target.files[0];
    evt.target.value = ''; // allow choosing the same file again later
    if (!file) return;

    await NR.cameraCapture.loadImageOntoCanvas(file, el.workCanvas);

    if (!annotatorCtrl) {
      annotatorCtrl = NR.annotator.createAnnotator(el.workCanvas, el.overlayCanvas, {
        onChange: (regions) => { state.regions = regions; renderRegionList(); },
      }, el.zoomSurface);
    } else {
      annotatorCtrl.reset();
      annotatorCtrl.syncOverlaySize();
    }

    if (state.templateId !== 'manual') {
      const template = NR.templates.getTemplate(state.templateId);
      if (template) annotatorCtrl.seedFromTemplate(template.regions);
    }

    state.redacted = false;
    state.results = [];
    renderRegionList();
    showStep('annotate');
  }

  el.fileInputCamera.addEventListener('change', handleFileChosen);
  el.fileInputGallery.addEventListener('change', handleFileChosen);

  // --- Step 3: Annotate -----------------------------------------------------

  function renderRegionList() {
    el.regionList.innerHTML = '';
    state.regions.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'region-row';

      // A redact box's label is never read (redactor.js ignores it, and the
      // redact-confirm handler below filters redact regions out of
      // state.results entirely) — it's purely a display convenience so the
      // nurse can tell boxes apart while checking them (e.g. template-seeded
      // "KCMH logo" vs "Sticker"), so editing it here is optional. Left
      // blank, it falls back to the generic "พื้นที่ปิดทึบ" caption instead
      // of asking for a name.
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = r.redact ? 'พื้นที่ปิดทึบ' : 'ชื่อข้อมูล (เช่น HN, DOB)';
      input.value = r.label;
      input.addEventListener('input', () => annotatorCtrl.setLabel(r.id, input.value));
      row.appendChild(input);

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'redact-toggle' + (r.redact ? ' on' : '');
      toggle.textContent = r.redact ? 'ปิดทึบทั้งหมด' : 'อ่านค่า';
      toggle.addEventListener('click', () => annotatorCtrl.toggleRedact(r.id));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove-btn';
      remove.textContent = '✕';
      remove.addEventListener('click', () => annotatorCtrl.removeRegion(r.id));

      row.append(toggle, remove);
      el.regionList.appendChild(row);
    });

    const hasRedactRegion = state.regions.some((r) => r.redact);
    const fieldRegions = state.regions.filter((r) => !r.redact);
    const allLabeled = fieldRegions.every((r) => r.label && r.label.trim());
    el.btnGoRedact.disabled = !(hasRedactRegion && allLabeled);
  }

  el.btnRetakePhoto.addEventListener('click', () => showStep('capture'));

  el.btnGoRedact.addEventListener('click', () => {
    const redactCount = state.regions.filter((r) => r.redact).length;
    const fieldCount = state.regions.length - redactCount;
    el.redactModalBody.textContent =
      `การดำเนินการนี้จะปิดทับถาวร ${redactCount} ตำแหน่ง และเปิดให้กรอกข้อมูล ${fieldCount} ตำแหน่งด้วยตนเอง ` +
      `การปิดทับไม่สามารถย้อนกลับได้ ดำเนินการต่อหรือไม่?`;
    el.redactModalBackdrop.classList.add('active');
  });

  el.btnRedactCancel.addEventListener('click', () => {
    el.redactModalBackdrop.classList.remove('active');
  });

  el.btnRedactConfirm.addEventListener('click', () => {
    el.redactModalBackdrop.classList.remove('active');

    // The invariant step: mutate the one working canvas in place. No copy of
    // the pre-redaction pixels is made before or after this call.
    NR.redactor.applyRedaction(el.workCanvas, state.regions);
    state.redacted = true;
    // One id per photo, generated here and reused by every downstream
    // artifact (local export filenames/content and the eventual sync
    // payload) so they can all be cross-referenced against each other.
    state.artifactId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    state.photoCount += 1;
    annotatorCtrl.redrawOverlay(); // regions still shown as outlines; pixels underneath are now black

    // No OCR anymore — the nurse types each non-redact field's value by hand
    // on the Review step, starting from a blank textarea per region.
    state.results = state.regions.filter((r) => !r.redact).map((r) => ({ id: r.id, label: r.label, text: '' }));
    renderResults();
    showStep('review');
  });

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
      textarea.placeholder = 'พิมพ์ค่าที่เห็นในรูป';
      textarea.addEventListener('input', () => { r.text = textarea.value; });

      wrap.append(label, textarea);
      el.resultList.appendChild(wrap);
    });
  }

  el.btnBackToAnnotate.addEventListener('click', () => showStep('annotate'));
  el.btnStartOver.addEventListener('click', resetAll);
  el.btnGoExport.addEventListener('click', () => {
    showStep('export');
    el.syncStatusLine.style.display = 'none';
    renderSyncUI();
    renderPhotoCountHint();
  });

  // --- Step 5: Export ---------------------------------------------------

  function renderPhotoCountHint() {
    el.photoCountHint.textContent = `รูปที่ ${state.photoCount} สำหรับรหัส ${state.codename} — ถ่ายเพิ่มได้หากผู้ป่วยรายนี้มีหลายหน้า/หลายรูป`;
  }

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
    const result = await NR.sync.syncNow(el.workCanvas, state.results, '', state.codename, state.artifactId);
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

  el.btnBackToReviewFromExport.addEventListener('click', () => showStep('review'));
  el.btnExportPng.addEventListener('click', () => NR.exportModule.exportRedactedPng(el.workCanvas, state.codename, state.artifactId));

  // Clears everything about the *current photo* — regions, results, the
  // working canvas — without touching state.codename or state.photoCount,
  // so a nurse can capture several photos in a row for the same patient
  // (e.g. multiple chart pages) without re-picking the codename each time.
  function resetPhotoState() {
    state.redacted = false;
    state.regions = [];
    state.results = [];
    state.artifactId = '';
    if (annotatorCtrl) annotatorCtrl.reset();
    const ctx = el.workCanvas.getContext('2d');
    ctx.clearRect(0, 0, el.workCanvas.width, el.workCanvas.height);
  }

  el.btnAddAnotherPhoto.addEventListener('click', () => {
    resetPhotoState();
    showStep('capture');
  });

  el.btnDone.addEventListener('click', resetAll);

  function resetAll() {
    resetPhotoState();
    state.codename = '';
    state.photoCount = 0;
    showStep('codename');
  }

  showStep(NR.auth.getSession() ? 'codename' : 'login');

  // First-run (or cache-cleared) offline-shell warm-up indicator. The service
  // worker's install step precaches the whole app shell before it activates,
  // so `serviceWorker.ready` resolving is a reliable signal that the
  // one-time download has finished — see sw.js.
  const swStatus = document.getElementById('swStatus');
  if ('serviceWorker' in navigator) {
    if (!navigator.serviceWorker.controller) {
      swStatus.style.display = 'block';
      swStatus.textContent = 'กำลังเตรียมแอปสำหรับใช้งานออฟไลน์ (ดาวน์โหลดครั้งเดียว ต้องใช้ Wi-Fi)…';
    }
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('NeoRedact: service worker registration failed', err);
        swStatus.style.display = 'block';
        swStatus.textContent = 'เตรียมแอปสำหรับใช้งานออฟไลน์ไม่สำเร็จ — ตรวจสอบการเชื่อมต่อแล้วโหลดใหม่';
      });
    });
    navigator.serviceWorker.ready.then(() => {
      swStatus.style.display = 'none';
    });
  }
})();
