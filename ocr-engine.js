// Tesseract.js worker lifecycle + per-region OCR. Deliberately never receives
// the full working canvas — only pre-cropped regions built from an
// already-redacted canvas (see redactor.js and app.js's state machine).
window.NeoRedact = window.NeoRedact || {};

(function () {
  'use strict';

  let workerPromise = null;

  function getWorker(lang) {
    if (!workerPromise) {
      // gzip:true because traineddata is vendored as .gz; cacheMethod:'none'
      // stops Tesseract.js from maintaining its own IndexedDB cache of
      // traineddata — the service worker already caches these same-origin
      // files, and one offline-cache mechanism is enough (see CLAUDE.md).
      workerPromise = Tesseract.createWorker(lang, 1, {
        workerPath: 'vendor/tesseract/worker.min.js',
        corePath: 'vendor/tesseract/',
        langPath: 'vendor/tesseract/',
        gzip: true,
        cacheMethod: 'none',
      });
    }
    return workerPromise;
  }

  // Crops `region` out of `canvas` into a small fresh canvas. This is the only
  // way image data ever reaches Tesseract — never the full page.
  function cropRegion(canvas, region) {
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round(region.w));
    crop.height = Math.max(1, Math.round(region.h));
    const ctx = crop.getContext('2d');
    ctx.drawImage(
      canvas,
      region.x, region.y, region.w, region.h,
      0, 0, crop.width, crop.height
    );
    return crop;
  }

  // opts.redacted must be === true, set by the caller only after
  // redactor.applyRedaction() has actually run. This is a defensive re-check,
  // not the only guard — app.js's state machine should already prevent
  // reaching this step otherwise.
  async function recognizeRegions(canvas, regions, opts) {
    opts = opts || {};
    if (opts.redacted !== true) {
      throw new Error(
        'NeoRedact: refusing to run OCR — image has not been marked as redacted yet.'
      );
    }

    const targets = regions.filter((r) => !r.redact);
    const worker = await getWorker(opts.lang || 'tha+eng');
    const results = [];

    for (let i = 0; i < targets.length; i++) {
      const region = targets[i];
      if (typeof opts.onProgress === 'function') {
        opts.onProgress({ index: i, total: targets.length, label: region.label });
      }
      const cropCanvas = cropRegion(canvas, region);
      const { data } = await worker.recognize(cropCanvas);
      results.push({ id: region.id, label: region.label, text: (data.text || '').trim() });
    }

    return results;
  }

  async function terminate() {
    if (workerPromise) {
      const worker = await workerPromise;
      await worker.terminate();
      workerPromise = null;
    }
  }

  window.NeoRedact.ocrEngine = { recognizeRegions, terminate };
})();
