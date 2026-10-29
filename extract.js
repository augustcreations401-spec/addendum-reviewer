/*
 * Extract — turns each dropped file into searchable "segments", each tagged
 * with where it lives so the viewer can jump back to it:
 *   PDF   → one segment per page   { page }        (+ word boxes for highlighting)
 *   Word  → one per paragraph      { para }        (index into the rendered <p> list)
 *   Excel → one per non-empty cell { sheet, cell, r, c }
 */
(function () {
  'use strict';

  const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  // Start pdf.js's worker from a blob so it also works when index.html is opened as a local file.
  let workerReady = false;
  function ensurePdfWorker() {
    if (workerReady) return;
    const blob = new Blob([`importScripts(${JSON.stringify(PDF_WORKER)});`], { type: 'text/javascript' });
    pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(blob));
    workerReady = true;
  }

  function kindOf(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (ext === 'pdf') return 'pdf';
    if (ext === 'docx' || ext === 'docm') return 'docx';
    if (['xlsx', 'xlsm', 'xls', 'xlsb', 'csv', 'ods'].includes(ext)) return 'sheet';
    if (ext === 'doc') return 'legacy-doc';
    return 'unsupported';
  }

  /* ---------- PDF ---------- */

  /*
   * Build page text from pdf.js text items, remembering each item's box.
   * Everything is measured along the item's own text direction, then mapped to
   * the viewport, so rotated pages (e.g. landscape sheets saved as portrait +
   * /Rotate 90) and sideways text get correct boxes and word spacing.
   */
  function pageTextFromItems(items, viewport) {
    let text = '';
    const boxes = [];
    let prev = null;
    const toView = (x, y) => viewport.convertToViewportPoint(x, y);

    for (const item of items) {
      if (!('str' in item)) continue;
      const [a, b, c, d, e, f] = item.transform;
      const fontH = item.height || Math.hypot(c, d) || 10;
      const ul = Math.hypot(a, b) || 1;
      const nl = Math.hypot(c, d) || 1;
      const u = [a / ul, b / ul]; // text direction (PDF space)
      const n = [c / nl, d / nl]; // "up" direction (PDF space)

      // Start/end of the baseline in viewport space, plus the viewport text direction.
      const s = toView(e, f);
      const t = toView(e + u[0] * item.width, f + u[1] * item.width);
      const dir = [t[0] - s[0], t[1] - s[1]];
      const dlen = Math.hypot(dir[0], dir[1]) || 1;
      const ud = [dir[0] / dlen, dir[1] / dlen];

      if (prev && item.str && !/\s$/.test(text)) {
        // Offset from the previous item's end, split into along-line gap and across-line drift.
        const ox = s[0] - prev.end[0], oy = s[1] - prev.end[1];
        const gap = ox * prev.ud[0] + oy * prev.ud[1];
        const drift = Math.abs(-ox * prev.ud[1] + oy * prev.ud[0]);
        if (drift > fontH * 0.5) text += '\n';
        else if (gap > fontH * 0.15 && !/^\s/.test(item.str)) text += ' ';
      }

      if (item.str) {
        const lo = -0.22 * fontH, hi = 0.9 * fontH;
        const corners = [[0, lo], [item.width, lo], [item.width, hi], [0, hi]].map(([along, up]) =>
          toView(e + u[0] * along + n[0] * up, f + u[1] * along + n[1] * up));
        const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
        boxes.push({
          start: text.length, end: text.length + item.str.length,
          x: Math.min(...xs), y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
          dir: Math.abs(ud[0]) >= Math.abs(ud[1]) ? (ud[0] >= 0 ? 'x' : '-x') : (ud[1] >= 0 ? 'y' : '-y'),
        });
        text += item.str;
        prev = { end: t, ud };
      }
      if (item.hasEOL) { text += '\n'; prev = null; }
    }
    return { text, boxes };
  }

  async function extractPdf(doc, onProgress) {
    ensurePdfWorker();
    const data = new Uint8Array(await doc.file.arrayBuffer());
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({ data }).promise;
    } catch (e) {
      if (e && e.name === 'PasswordException') throw new Error('PDF is password protected');
      throw new Error(`Could not open PDF (${e.message || e})`);
    }
    doc.pdf = pdf;
    doc.pageCount = pdf.numPages;

    const segments = [];
    const ocrPages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const { text, boxes } = pageTextFromItems(tc.items, viewport);
      if (doc.forceOcr || Ocr.needsOcr(text)) ocrPages.push(p);
      else segments.push({ loc: { page: p }, text, boxes });
      onProgress(`Reading page ${p} of ${pdf.numPages}`);
    }

    if (ocrPages.length) {
      let done = 0;
      onProgress(`OCR page 1 of ${ocrPages.length}…`);
      const results = await Promise.all(ocrPages.map(async (p) => {
        const page = await pdf.getPage(p);
        const r = await Ocr.ocrPage(page);
        done++;
        onProgress(`OCR page ${Math.min(done + 1, ocrPages.length)} of ${ocrPages.length}…`);
        return { loc: { page: p }, text: r.text, boxes: r.boxes, ocr: true };
      }));
      segments.push(...results);
      segments.sort((a, b) => a.loc.page - b.loc.page);
    }
    doc.ocrPageCount = ocrPages.length;
    return segments;
  }

  /* ---------- Word ---------- */

  let stash = null;
  function getStash() {
    if (!stash) {
      stash = document.createElement('div');
      stash.setAttribute('aria-hidden', 'true');
      stash.style.cssText = 'position:absolute;left:-100000px;top:0;width:1000px;visibility:hidden;';
      document.body.appendChild(stash);
    }
    return stash;
  }

  async function extractDocx(doc, onProgress) {
    onProgress('Reading document…');
    const buf = await doc.file.arrayBuffer();
    const body = document.createElement('div');
    body.className = 'docx-host';
    const styles = document.createElement('div');
    getStash().append(styles, body);
    try {
      await docx.renderAsync(buf, body, styles, {
        className: `docx_${doc.id}`, inWrapper: true, breakPages: true,
        renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
        experimental: true,
      });
    } catch (e) {
      body.remove(); styles.remove();
      throw new Error(`Could not open Word file (${e.message || e})`);
    }
    // Styles stay in the stash (they apply document-wide); the body moves into the viewer on demand.
    doc.docxNode = body;
    doc.docxStyles = styles;
    const paras = body.querySelectorAll('p');
    const segments = [];
    paras.forEach((p, i) => {
      const text = p.textContent;
      if (text.trim()) segments.push({ loc: { para: i }, text });
    });
    return segments;
  }

  /* ---------- Excel / CSV ---------- */

  async function extractSheet(doc, onProgress) {
    onProgress('Reading workbook…');
    const buf = await doc.file.arrayBuffer();
    let wb;
    try {
      wb = XLSX.read(buf, { type: 'array', cellDates: true });
    } catch (e) {
      throw new Error(`Could not open spreadsheet (${e.message || e})`);
    }
    doc.workbook = wb;
    const segments = [];
    for (const sheet of wb.SheetNames) {
      const ws = wb.Sheets[sheet];
      if (!ws || !ws['!ref']) continue;
      const first = XLSX.utils.decode_range(ws['!ref']).s.c;
      const cells = Object.keys(ws)
        .filter((k) => k[0] !== '!')
        .map((k) => ({ k, ...XLSX.utils.decode_cell(k) }))
        .sort((a, b) => a.r - b.r || a.c - b.c);
      for (const { k, r, c } of cells) {
        const text = cellText(ws[k]);
        if (!text.trim()) continue;
        let label = '';
        if (c !== first) label = cellText(ws[XLSX.utils.encode_cell({ r, c: first })]).trim().slice(0, 60);
        segments.push({ loc: { sheet, cell: k, r, c }, text, label });
      }
    }
    return segments;
  }

  function cellText(cell) {
    if (!cell) return '';
    if (cell.w != null) return String(cell.w);
    if (cell.v instanceof Date) return cell.v.toLocaleDateString();
    return cell.v != null ? String(cell.v) : '';
  }

  /* ---------- dispatcher ---------- */

  async function extract(doc, onProgress) {
    switch (doc.kind) {
      case 'pdf': return extractPdf(doc, onProgress);
      case 'docx': return extractDocx(doc, onProgress);
      case 'sheet': return extractSheet(doc, onProgress);
      case 'legacy-doc': throw new Error('Old .doc format — open it in Word and Save As .docx');
      default: throw new Error('File type not supported (PDF, Word .docx, Excel or CSV only)');
    }
  }

  window.Extract = { extract, kindOf, cellText, ensurePdfWorker };
})();
