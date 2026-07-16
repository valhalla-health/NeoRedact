// Builds local-only file downloads. Nothing here ever performs a network
// request — every export is a Blob turned into an <a download> click.
window.NeoRedact = window.NeoRedact || {};

(function () {
  'use strict';

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke shortly after; immediate revoke can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function timestampSlug() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  // fields: [{ label, text }]
  function exportTxt(fields) {
    const lines = fields.map((f) => `${f.label}: ${f.text}`);
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
    triggerDownload(blob, `neoredact-${timestampSlug()}.txt`);
  }

  function exportJson(fields) {
    const values = {};
    let unlabeledCount = 0;
    fields.forEach((f) => {
      const key = f.label && f.label.trim() ? f.label.trim() : `field_${++unlabeledCount}`;
      values[key] = f.text;
    });
    const payload = { capturedAt: new Date().toISOString(), fields: values };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    triggerDownload(blob, `neoredact-${timestampSlug()}.json`);
  }

  // Only ever called with the already-redacted working canvas — see app.js.
  function exportRedactedPng(canvas) {
    canvas.toBlob((blob) => {
      if (blob) triggerDownload(blob, `neoredact-photo-${timestampSlug()}.png`);
    }, 'image/png');
  }

  window.NeoRedact.exportModule = { exportTxt, exportJson, exportRedactedPng };
})();
