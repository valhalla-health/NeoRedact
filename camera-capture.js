// Loads a user-picked image file onto the shared working canvas, correcting
// EXIF orientation so mobile photos aren't sideways. Exposes a single function;
// the rest of the app owns the canvas element and its 2D context.
window.NeoRedact = window.NeoRedact || {};

(function () {
  'use strict';

  // Decodes `file` and draws it onto `canvas`, sized to the image's natural
  // pixel dimensions (not the CSS display size) so annotation coordinates map
  // 1:1 to real pixels regardless of devicePixelRatio or CSS scaling.
  async function loadImageOntoCanvas(file, canvas) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (err) {
      // Fallback for browsers without imageOrientation support in createImageBitmap.
      bitmap = await createImageBitmap(file);
    }

    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);

    bitmap.close();
    return { width: canvas.width, height: canvas.height };
  }

  window.NeoRedact.cameraCapture = { loadImageOntoCanvas };
})();
