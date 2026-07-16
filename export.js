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

  // Seconds resolution + a short id, not just minute-precision — two photos
  // taken in the same clock-minute (plausible for back-to-back patients)
  // otherwise produce identical filenames and rely on the browser's own
  // dedup suffix instead of a real identifier.
  function timestampSlug() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function shortId(id) {
    const stripped = String(id || '').replace(/-/g, '');
    return stripped ? stripped.slice(0, 8) : 'noid';
  }

  // Every export carries the codename (the only patient identifier this app
  // ever produces) and the same artifactId app.js generated at redact time —
  // the latter also matches the syncId if this same photo is later synced,
  // so a locally-saved file stays cross-referenceable against the Sheet.
  function filenameSlug(codename, id) {
    return `${codename || 'no-codename'}-${timestampSlug()}-${shortId(id)}`;
  }

  // fields: [{ label, text }]
  function exportTxt(fields, codename, id) {
    const lines = [`Codename: ${codename || '(none)'}`, `ID: ${id || '(none)'}`, ''];
    fields.forEach((f) => lines.push(`${f.label}: ${f.text}`));
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
    triggerDownload(blob, `neoredact-${filenameSlug(codename, id)}.txt`);
  }

  function exportJson(fields, codename, id) {
    const values = {};
    let unlabeledCount = 0;
    fields.forEach((f) => {
      const key = f.label && f.label.trim() ? f.label.trim() : `field_${++unlabeledCount}`;
      values[key] = f.text;
    });
    const payload = { capturedAt: new Date().toISOString(), codename: codename || '', syncId: id || '', fields: values };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    triggerDownload(blob, `neoredact-${filenameSlug(codename, id)}.json`);
  }

  // Only ever called with the already-redacted working canvas — see app.js.
  function exportRedactedPng(canvas, codename, id) {
    canvas.toBlob((blob) => {
      if (blob) triggerDownload(blob, `neoredact-photo-${filenameSlug(codename, id)}.png`);
    }, 'image/png');
  }

  window.NeoRedact.exportModule = { exportTxt, exportJson, exportRedactedPng };
})();
