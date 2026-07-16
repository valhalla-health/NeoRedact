// Rectangle-drawing UI on a transparent overlay canvas layered above the
// working image canvas. Never touches the image canvas's pixels — it only
// tracks region metadata (coordinates in IMAGE-PIXEL space, not CSS pixels)
// and draws preview outlines on its own layer. Actual pixel redaction happens
// later, in redactor.js, directly on the working canvas.
window.NeoRedact = window.NeoRedact || {};

(function () {
  'use strict';

  const MIN_REGION_SIZE = 12; // image px; smaller drags are treated as accidental taps
  let nextId = 1;

  function createAnnotator(imageCanvas, overlayCanvas, callbacks) {
    callbacks = callbacks || {};
    const onChange = callbacks.onChange || function () {};

    let regions = [];
    let dragStart = null; // {x,y} in image-pixel space
    let dragCurrent = null;
    let activePointerId = null;

    function syncOverlaySize() {
      overlayCanvas.width = imageCanvas.width;
      overlayCanvas.height = imageCanvas.height;
    }

    // Maps a pointer event's client coordinates to image-pixel coordinates,
    // accounting for the CSS-scaled display size vs the canvas's real pixel buffer.
    function toImageCoords(evt) {
      const rect = overlayCanvas.getBoundingClientRect();
      const scaleX = overlayCanvas.width / rect.width;
      const scaleY = overlayCanvas.height / rect.height;
      const x = (evt.clientX - rect.left) * scaleX;
      const y = (evt.clientY - rect.top) * scaleY;
      return {
        x: Math.max(0, Math.min(overlayCanvas.width, x)),
        y: Math.max(0, Math.min(overlayCanvas.height, y)),
      };
    }

    function normalizedRect(a, b) {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(a.x - b.x);
      const h = Math.abs(a.y - b.y);
      return { x, y, w, h };
    }

    function redrawOverlay() {
      const ctx = overlayCanvas.getContext('2d');
      ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      ctx.lineWidth = Math.max(2, overlayCanvas.width * 0.004);
      ctx.font = `${Math.max(16, overlayCanvas.width * 0.028)}px sans-serif`;
      ctx.textBaseline = 'top';

      regions.forEach((r) => {
        const color = r.redact ? '#e0605a' : '#4fb3a9';
        ctx.strokeStyle = color;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        const text = (r.label || '(unlabeled)') + (r.redact ? ' · REDACT' : '');
        const textWidth = ctx.measureText(text).width;
        ctx.fillStyle = color;
        ctx.fillRect(r.x, Math.max(0, r.y - 22), textWidth + 10, 20);
        ctx.fillStyle = '#0b0e11';
        ctx.fillText(text, r.x + 5, Math.max(0, r.y - 21));
      });

      if (dragStart && dragCurrent) {
        const r = normalizedRect(dragStart, dragCurrent);
        ctx.strokeStyle = '#d9a441';
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.setLineDash([]);
      }
    }

    function handlePointerDown(evt) {
      if (activePointerId !== null) return;
      activePointerId = evt.pointerId;
      overlayCanvas.setPointerCapture(activePointerId);
      dragStart = toImageCoords(evt);
      dragCurrent = dragStart;
      redrawOverlay();
    }

    function handlePointerMove(evt) {
      if (evt.pointerId !== activePointerId || !dragStart) return;
      dragCurrent = toImageCoords(evt);
      redrawOverlay();
    }

    function handlePointerUp(evt) {
      if (evt.pointerId !== activePointerId || !dragStart) return;
      const rect = normalizedRect(dragStart, dragCurrent || dragStart);
      dragStart = null;
      dragCurrent = null;
      activePointerId = null;

      if (rect.w >= MIN_REGION_SIZE && rect.h >= MIN_REGION_SIZE) {
        regions.push({
          id: nextId++,
          x: rect.x, y: rect.y, w: rect.w, h: rect.h,
          label: regions.length === 0 ? 'name' : '',
          redact: regions.length === 0,
        });
        onChange(getRegions());
      }
      redrawOverlay();
    }

    overlayCanvas.addEventListener('pointerdown', handlePointerDown);
    overlayCanvas.addEventListener('pointermove', handlePointerMove);
    overlayCanvas.addEventListener('pointerup', handlePointerUp);
    overlayCanvas.addEventListener('pointercancel', handlePointerUp);

    function getRegions() {
      // Defensive copy — callers must go through setLabel/toggleRedact/removeRegion
      // to mutate state, never edit the array returned here directly.
      return regions.map((r) => Object.assign({}, r));
    }

    function setLabel(id, label) {
      const r = regions.find((r) => r.id === id);
      if (r) { r.label = label; onChange(getRegions()); redrawOverlay(); }
    }

    function toggleRedact(id) {
      const r = regions.find((r) => r.id === id);
      if (r) { r.redact = !r.redact; onChange(getRegions()); redrawOverlay(); }
    }

    function removeRegion(id) {
      regions = regions.filter((r) => r.id !== id);
      onChange(getRegions());
      redrawOverlay();
    }

    function reset() {
      regions = [];
      dragStart = null;
      dragCurrent = null;
      activePointerId = null;
      syncOverlaySize();
      redrawOverlay();
      onChange(getRegions());
    }

    syncOverlaySize();

    return {
      syncOverlaySize,
      getRegions,
      setLabel,
      toggleRedact,
      removeRegion,
      reset,
      redrawOverlay,
    };
  }

  window.NeoRedact.annotator = { createAnnotator };
})();
