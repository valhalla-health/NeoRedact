// PRIVACY-CRITICAL MODULE. Keep this file small and easy to audit in isolation.
//
// Invariant this module exists to uphold: once applyRedaction() returns, every
// region flagged redact:true is permanently blacked out on the ONE working
// canvas — no copy of the pre-redaction pixels is made or kept anywhere. There
// is nothing to "undo" by design: undo would require a pre-redaction copy,
// which is exactly what this tool must never retain.
window.NeoRedact = window.NeoRedact || {};

(function () {
  'use strict';

  // Extra margin (image px) painted beyond the user's drawn box on every side,
  // so a slightly-loose rectangle still fully covers the name (avoids leaking
  // a sliver of text at the edge). Scales a little with region size.
  function paddingFor(region) {
    return Math.max(6, Math.round(Math.min(region.w, region.h) * 0.08));
  }

  // Mutates `canvas` in place. Returns nothing — callers must not treat this
  // as producing a new image; there is only ever the one canvas.
  function applyRedaction(canvas, regions) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';

    regions
      .filter((r) => r.redact)
      .forEach((r) => {
        const pad = paddingFor(r);
        const x = Math.max(0, r.x - pad);
        const y = Math.max(0, r.y - pad);
        const w = Math.min(canvas.width - x, r.w + pad * 2);
        const h = Math.min(canvas.height - y, r.h + pad * 2);
        ctx.fillRect(x, y, w, h);
      });
  }

  window.NeoRedact.redactor = { applyRedaction };
})();
