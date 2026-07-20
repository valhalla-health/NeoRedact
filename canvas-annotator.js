// Rectangle-drawing UI on a transparent overlay canvas layered above the
// working image canvas. Never touches the image canvas's pixels — it only
// tracks region metadata (coordinates in IMAGE-PIXEL space, not CSS pixels)
// and draws preview outlines on its own layer. Actual pixel redaction happens
// later, in redactor.js, directly on the working canvas.
window.NeoRedact = window.NeoRedact || {};

(function () {
  'use strict';

  const MIN_REGION_SIZE = 12; // image px; smaller drags are treated as accidental taps
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 4;
  let nextId = 1;

  // zoomSurface (optional): the element that gets CSS-transformed for pinch
  // zoom/pan. Purely a view transform on the overlay/image canvases' CSS
  // box — never touches canvas pixel buffers or region coordinates, which
  // stay in image-pixel space throughout (see toImageCoords).
  function createAnnotator(imageCanvas, overlayCanvas, callbacks, zoomSurface) {
    callbacks = callbacks || {};
    const onChange = callbacks.onChange || function () {};

    let regions = [];
    let dragStart = null; // {x,y} in image-pixel space
    let dragCurrent = null;
    let activePointerId = null; // the single finger/mouse currently drawing, if any

    // One finger draws a redact/read box; a second finger switches to
    // pinch-zoom instead (see handlePointerDown). `pointers` tracks every
    // currently-down pointer in client coords; `pinch` holds the gesture's
    // starting state while exactly 2+ fingers are down.
    const pointers = new Map();
    let pinch = null;
    let zoom = { scale: 1, tx: 0, ty: 0 };

    function applyZoom() {
      if (zoomSurface) zoomSurface.style.transform = `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`;
    }

    function resetZoom() {
      zoom = { scale: 1, tx: 0, ty: 0 };
      applyZoom();
    }

    function distance(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function cancelDraw() {
      if (dragStart) {
        dragStart = null;
        dragCurrent = null;
        redrawOverlay();
      }
      activePointerId = null;
    }

    function startPinch() {
      const ids = Array.from(pointers.keys());
      const p1 = pointers.get(ids[0]);
      const p2 = pointers.get(ids[1]);
      const wrapRect = (zoomSurface ? zoomSurface.parentElement : overlayCanvas).getBoundingClientRect();
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      pinch = {
        startDist: distance(p1, p2),
        startScale: zoom.scale,
        wrapRect,
        // Content-space point (in the wrap's own unscaled CSS pixels)
        // currently under the pinch midpoint — kept anchored under the
        // fingers as scale/translate change.
        contentX: (mid.x - wrapRect.left - zoom.tx) / zoom.scale,
        contentY: (mid.y - wrapRect.top - zoom.ty) / zoom.scale,
      };
    }

    function updatePinch() {
      const ids = Array.from(pointers.keys());
      const p1 = pointers.get(ids[0]);
      const p2 = pointers.get(ids[1]);
      const dist = distance(p1, p2);
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinch.startScale * (dist / pinch.startDist)));
      let tx = mid.x - pinch.wrapRect.left - pinch.contentX * scale;
      let ty = mid.y - pinch.wrapRect.top - pinch.contentY * scale;
      // Clamp so the zoomed content always fully covers the frame — no
      // panning past its edges into empty space.
      tx = Math.max((1 - scale) * pinch.wrapRect.width, Math.min(0, tx));
      ty = Math.max((1 - scale) * pinch.wrapRect.height, Math.min(0, ty));
      zoom = { scale, tx, ty };
      applyZoom();
    }

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
        const color = r.redact ? '#e0605a' : '#f2a3c6';
        ctx.strokeStyle = color;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        const text = r.label || (r.redact ? 'พื้นที่ปิดทึบ' : '(unlabeled)');
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
      pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
      overlayCanvas.setPointerCapture(evt.pointerId);

      if (pointers.size === 2) {
        // Second finger down: this is a pinch-zoom, not a draw — abandon
        // any in-progress single-finger box.
        cancelDraw();
        startPinch();
        return;
      }
      if (pointers.size > 2 || pinch) return; // extra fingers during a pinch: ignore

      if (activePointerId !== null) return;
      activePointerId = evt.pointerId;
      dragStart = toImageCoords(evt);
      dragCurrent = dragStart;
      redrawOverlay();
    }

    function handlePointerMove(evt) {
      if (!pointers.has(evt.pointerId)) return;
      pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });

      if (pinch) {
        if (pointers.size >= 2) updatePinch();
        return;
      }
      if (evt.pointerId !== activePointerId || !dragStart) return;
      dragCurrent = toImageCoords(evt);
      redrawOverlay();
    }

    function handlePointerUp(evt) {
      pointers.delete(evt.pointerId);
      try { overlayCanvas.releasePointerCapture(evt.pointerId); } catch (e) { /* already released */ }

      if (pinch) {
        // Gesture ends as soon as a finger lifts — a fresh touch is
        // required to draw or to pinch again, rather than silently
        // resuming a draw with whichever finger is still down.
        if (pointers.size < 2) pinch = null;
        return;
      }

      if (evt.pointerId !== activePointerId || !dragStart) return;
      const rect = normalizedRect(dragStart, dragCurrent || dragStart);
      dragStart = null;
      dragCurrent = null;
      activePointerId = null;

      if (rect.w >= MIN_REGION_SIZE && rect.h >= MIN_REGION_SIZE) {
        regions.push({
          id: nextId++,
          x: rect.x, y: rect.y, w: rect.w, h: rect.h,
          label: '',
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
      pointers.clear();
      pinch = null;
      resetZoom();
      syncOverlaySize();
      redrawOverlay();
      onChange(getRegions());
    }

    // Pre-populates regions from a page template (templates.js), converting
    // its %-of-image-size boxes to real pixel coordinates against the
    // *current* imageCanvas size. Appends to whatever regions already exist
    // (normally called right after reset(), so that's an empty list) rather
    // than replacing them outright, so it composes with manual drawing.
    // Seeded regions are ordinary regions afterwards — draggable-away by
    // remove, toggleable — nothing downstream needs to know they came from a
    // template instead of a hand-drawn box.
    function seedFromTemplate(templateRegions) {
      (templateRegions || []).forEach((t) => {
        regions.push({
          id: nextId++,
          x: Math.round(t.xPct * imageCanvas.width),
          y: Math.round(t.yPct * imageCanvas.height),
          w: Math.round(t.wPct * imageCanvas.width),
          h: Math.round(t.hPct * imageCanvas.height),
          label: t.label || '',
          redact: t.redact !== false,
        });
      });
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
      seedFromTemplate,
      redrawOverlay,
    };
  }

  window.NeoRedact.annotator = { createAnnotator };
})();
