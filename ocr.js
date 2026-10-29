/*
 * OCR — reads scanned (image-only) PDF pages with Tesseract.js, entirely in the
 * browser. Workers are created on first use; the English language data
 * (~10 MB) downloads once and is then cached by the browser.
 */
(function () {
  'use strict';

  const RENDER_SCALE = 2;
  const WORKERS = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
  let schedulerPromise = null;

  function getScheduler() {
    if (!schedulerPromise) {
      schedulerPromise = (async () => {
        const scheduler = Tesseract.createScheduler();
        const workers = await Promise.all(
          Array.from({ length: WORKERS }, () => Tesseract.createWorker('eng'))
        );
        workers.forEach((w) => scheduler.addWorker(w));
        return scheduler;
      })().catch((e) => {
        schedulerPromise = null;
        throw new Error(`OCR engine failed to load (${e.message || e}). Check the internet connection.`);
      });
    }
    return schedulerPromise;
  }

  // A page needs OCR when its text layer is (nearly) empty.
  function needsOcr(pageText) {
    return pageText.replace(/\s/g, '').length < 20;
  }

  /*
   * Returns { text, boxes } in the same shape as the PDF text-layer extractor:
   * boxes are [{ start, end, x, y, w, h }] in scale-1 page coordinates (top-left origin).
   */
  async function ocrPage(page) {
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    const scheduler = await getScheduler();
    const { data } = await scheduler.addJob('recognize', canvas);
    canvas.width = canvas.height = 0; // free memory

    let text = '';
    const boxes = [];
    const paragraphs = data.paragraphs && data.paragraphs.length ? data.paragraphs : [{ lines: data.lines || [] }];
    for (const para of paragraphs) {
      for (const line of para.lines || []) {
        for (const word of line.words || []) {
          const str = word.text.trim();
          if (!str) continue;
          const b = word.bbox;
          boxes.push({
            start: text.length, end: text.length + str.length,
            x: b.x0 / RENDER_SCALE, y: b.y0 / RENDER_SCALE,
            w: (b.x1 - b.x0) / RENDER_SCALE, h: (b.y1 - b.y0) / RENDER_SCALE,
          });
          text += str + ' ';
        }
        text = text.trimEnd() + '\n';
      }
      text += '\n';
    }
    return { text, boxes };
  }

  window.Ocr = { needsOcr, ocrPage };
})();
