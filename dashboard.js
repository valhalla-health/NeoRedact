// Read-only staff dashboard: groups synced submissions by codename. Never
// shows anything beyond what's already in the cloud sheet — codename, date,
// ward, non-identifying fields, and a link to the redacted photo. There is no
// real patient identity here by design (see codenames.js / CLAUDE.md).
(function () {
  'use strict';

  const NR = window.NeoRedact;

  const el = {
    googleSignInContainer: document.getElementById('googleSignInContainer'),
    btnTogglePasswordForm: document.getElementById('btnTogglePasswordForm'),
    passwordLoginForm: document.getElementById('passwordLoginForm'),
    loginEmail: document.getElementById('loginEmail'),
    loginPassword: document.getElementById('loginPassword'),
    btnPasswordLogin: document.getElementById('btnPasswordLogin'),
    loginError: document.getElementById('loginError'),
    dashLogin: document.getElementById('dashLogin'),
    dashContent: document.getElementById('dashContent'),
    dashStatus: document.getElementById('dashStatus'),
    dashTable: document.getElementById('dashTable'),
    btnRefresh: document.getElementById('btnRefresh'),
  };

  function onLoginSuccess() {
    el.loginError.style.display = 'none';
    el.dashLogin.style.display = 'none';
    el.dashContent.style.display = 'block';
    loadDashboard();
  }

  function onLoginError(msg) {
    el.loginError.style.display = 'block';
    el.loginError.textContent = msg || 'เข้าสู่ระบบไม่สำเร็จ';
  }

  el.btnTogglePasswordForm.addEventListener('click', () => {
    el.passwordLoginForm.style.display = 'block';
    el.btnTogglePasswordForm.style.display = 'none';
  });

  el.btnPasswordLogin.addEventListener('click', async () => {
    el.loginError.style.display = 'none';
    const email = el.loginEmail.value.trim();
    const password = el.loginPassword.value;
    if (!email || !password) { onLoginError('กรุณากรอกทั้งอีเมลและรหัสผ่าน'); return; }
    el.btnPasswordLogin.disabled = true;
    try {
      const result = await NR.auth.loginWithPassword(email, password);
      if (result.status === 'ok') onLoginSuccess();
      else onLoginError(result.msg);
    } catch (err) {
      onLoginError(err.message);
    } finally {
      el.btnPasswordLogin.disabled = false;
    }
  });

  async function fetchDashboard(token) {
    const res = await fetch(NEOREDACT_GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'list_dashboard', token }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function fieldsToText(fields) {
    return Object.keys(fields || {}).map((k) => `${k}: ${fields[k]}`).join(', ');
  }

  function renderTable(rows) {
    el.dashTable.innerHTML = '';
    if (!rows.length) {
      el.dashStatus.textContent = 'ยังไม่มีข้อมูล';
      return;
    }
    el.dashStatus.textContent = `ทั้งหมด ${rows.length} รายการ`;

    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>วันที่</th><th>ward</th><th>ข้อมูล</th><th>รูป</th></tr>';
    el.dashTable.appendChild(thead);

    const tbody = document.createElement('tbody');
    let lastCodename = null;
    rows.forEach((r) => {
      if (r.codename !== lastCodename) {
        lastCodename = r.codename;
        const groupRow = document.createElement('tr');
        groupRow.className = 'codename-group-header';
        const cell = document.createElement('td');
        cell.colSpan = 4;
        cell.textContent = r.codename;
        groupRow.appendChild(cell);
        tbody.appendChild(groupRow);
      }
      const tr = document.createElement('tr');
      const date = (r.capturedAt || r.submittedAt || '').toString().slice(0, 10);
      const linkCell = r.driveFileUrl
        ? `<a href="${r.driveFileUrl}" target="_blank" rel="noopener">เปิดรูป</a>`
        : '';
      tr.innerHTML =
        `<td>${date}</td><td>${r.ward || ''}</td><td>${fieldsToText(r.fields)}</td><td>${linkCell}</td>`;
      tbody.appendChild(tr);
    });
    el.dashTable.appendChild(tbody);
  }

  async function loadDashboard() {
    el.dashStatus.textContent = 'กำลังโหลด…';
    const session = NR.auth.getSession();
    if (!session) { el.dashLogin.style.display = 'block'; el.dashContent.style.display = 'none'; return; }
    try {
      const result = await fetchDashboard(session.token);
      if (result.status !== 'ok') {
        el.dashStatus.textContent = 'โหลดไม่สำเร็จ: ' + (result.msg || '');
        return;
      }
      renderTable(result.rows || []);
    } catch (err) {
      el.dashStatus.textContent = 'โหลดไม่สำเร็จ: ' + err.message;
    }
  }

  el.btnRefresh.addEventListener('click', loadDashboard);

  const existing = NR.auth.getSession();
  if (existing) {
    el.dashLogin.style.display = 'none';
    el.dashContent.style.display = 'block';
    loadDashboard();
  } else {
    NR.auth.renderGoogleButton(el.googleSignInContainer, onLoginSuccess, onLoginError);
  }
})();
