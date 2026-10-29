/*
 * Viewer — shows the original document at a hit and highlights it.
 *   PDF   → renders the page, draws boxes over every hit on it (the active one stronger)
 *   Word  → shows the rendered document with <mark> around hits, scrolled to the active one
 *   Excel → shows the sheet as a grid with hit cells shaded, scrolled to the active cell
 */
(function () {
  'use strict';

  const BIG_SHEET_CELLS = 60000;
  const SHEET_WINDOW = 300;
  const MAX_CANVAS_PIXELS = 24e6;
  const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];
  let renderTask = null;
  let token = 0;
  // Zoom is relative to "fit to panel width" (1 = fit).
  let zoom = 1;

  function getZoom() { return zoom; }
  function setZoom(z) { zoom = Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], z)); return zoom; }
  function stepZoom(dir) {
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > zoom + 1e-6) : [...ZOOM_STEPS].reverse().find((s) => s < zoom - 1e-6);
    return setZoom(next ?? zoom);
  }

  function show(container, doc, hit, docHits) {
    const my = ++token;
    if (renderTask) { renderTask.cancel(); renderTask = null; }
    if (doc.kind === 'pdf') return showPdf(container, doc, hit, docHits, my);
    if (doc.kind === 'docx') return showDocx(container, doc, hit, docHits);
    if (doc.kind === 'sheet') return showSheet(container, doc, hit, docHits);
  }

  /* ---------- PDF ---------- */

  async function showPdf(container, doc, hit, docHits, my) {
    const pageNo = hit.loc.page;
    const page = await doc.pdf.getPage(pageNo);
    if (my !== token) return;
    const base = page.getViewport({ scale: 1 });
    const cssScale = Math.max(0.3, (container.clientWidth - 24) / base.width) * zoom;
    // Keep very zoomed pages under the browser's canvas size limit.
    const dpr = Math.min(window.devicePixelRatio || 1,
      Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height * cssScale * cssScale)));
    const viewport = page.getViewport({ scale: cssScale * dpr });

    const wrap = document.createElement('div');
    wrap.className = 'pdf-page';
    wrap.style.width = `${base.width * cssScale}px`;
    wrap.style.height = `${base.height * cssScale}px`;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    wrap.appendChild(canvas);

    const seg = doc.segments.find((s) => s.loc.page === pageNo);
    let active = null;
    for (const h of docHits) {
      if (h.loc.page !== pageNo || !seg || !seg.boxes) continue;
      for (const r of rectsFor(seg.boxes, h.start, h.end)) {
        const box = document.createElement('div');
        box.className = 'pdf-mark' + (h === hit ? ' active' : '');
        box.style.setProperty('--c', h.color);
        box.style.left = `${r.x * cssScale - 2}px`;
        box.style.top = `${r.y * cssScale - 1}px`;
        box.style.width = `${r.w * cssScale + 4}px`;
        box.style.height = `${r.h * cssScale + 2}px`;
        box.title = h.term;
        wrap.appendChild(box);
        if (h === hit && !active) active = box;
      }
    }
    container.replaceChildren(wrap);

    renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
    (active || wrap).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    try { await renderTask.promise; } catch (e) { if (e && e.name === 'RenderingCancelledException') return; throw e; }
    renderTask = null;
  }

  // Boxes covering text range [start, end); partial boxes are trimmed by character
  // share along the box's text direction (x, -x, y or -y on screen).
  function rectsFor(boxes, start, end) {
    const out = [];
    for (const b of boxes) {
      if (b.end <= start || b.start >= end) continue;
      const len = Math.max(1, b.end - b.start);
      const a = (Math.max(start, b.start) - b.start) / len;
      const z = (Math.min(end, b.end) - b.start) / len;
      switch (b.dir || 'x') {
        case '-x': out.push({ x: b.x + b.w * (1 - z), y: b.y, w: b.w * (z - a), h: b.h }); break;
        case 'y': out.push({ x: b.x, y: b.y + b.h * a, w: b.w, h: b.h * (z - a) }); break;
        case '-y': out.push({ x: b.x, y: b.y + b.h * (1 - z), w: b.w, h: b.h * (z - a) }); break;
        default: out.push({ x: b.x + b.w * a, y: b.y, w: b.w * (z - a), h: b.h });
      }
    }
    return out;
  }

  /* ---------- Word ---------- */

  function showDocx(container, doc, hit, docHits) {
    const node = doc.docxNode;
    if (node.parentNode !== container) container.replaceChildren(node);
    node.style.zoom = 1;
    const page = node.querySelector('section');
    const pageWidth = (page ? page.offsetWidth : 816) + 40;
    node.style.zoom = Math.min(1, (container.clientWidth - 8) / pageWidth) * zoom;

    node.querySelectorAll('mark.doc-mark').forEach((m) => m.replaceWith(...m.childNodes));
    node.normalize();

    const paras = node.querySelectorAll('p');
    let active = null;
    for (const h of docHits) {
      const p = paras[h.loc.para];
      if (!p) continue;
      const marks = wrapRange(p, h.start, h.end, h.color, h === hit);
      if (h === hit) active = marks[0];
    }
    (active || node).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }

  function wrapRange(el, start, end, color, isActive) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const pieces = [];
    let pos = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const len = n.nodeValue.length;
      const a = Math.max(start, pos), z = Math.min(end, pos + len);
      if (a < z) pieces.push({ node: n, a: a - pos, z: z - pos });
      pos += len;
      if (pos >= end) break;
    }
    return pieces.map(({ node, a, z }) => {
      const range = document.createRange();
      range.setStart(node, a);
      range.setEnd(node, z);
      const mark = document.createElement('mark');
      mark.className = 'doc-mark' + (isActive ? ' active' : '');
      mark.style.setProperty('--c', color);
      range.surroundContents(mark);
      return mark;
    });
  }

  /* ---------- Excel ---------- */

  function showSheet(container, doc, hit, docHits) {
    const { sheet, r: hitRow } = hit.loc;
    const ws = doc.workbook.Sheets[sheet];
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows = range.e.r - range.s.r + 1;
    const cols = range.e.c - range.s.c + 1;

    let r0 = range.s.r, r1 = range.e.r;
    if (rows * cols > BIG_SHEET_CELLS) {
      r0 = Math.max(range.s.r, hitRow - SHEET_WINDOW);
      r1 = Math.min(range.e.r, hitRow + SHEET_WINDOW);
    }

    const hitCells = new Map();
    for (const h of docHits) {
      if (h.loc.sheet === sheet && !hitCells.has(h.loc.cell)) hitCells.set(h.loc.cell, h.color);
    }

    const frag = document.createDocumentFragment();
    const note = document.createElement('div');
    note.className = 'sheet-note';
    note.textContent = `Sheet “${sheet}”` + (r0 > range.s.r || r1 < range.e.r ? ` · showing rows ${r0 + 1}–${r1 + 1} of ${range.e.r + 1}` : '');
    frag.appendChild(note);

    const scroller = document.createElement('div');
    scroller.className = 'sheet-scroll';
    const table = document.createElement('table');
    table.className = 'sheet';
    table.style.zoom = zoom;
    const head = table.createTHead().insertRow();
    head.appendChild(document.createElement('th'));
    for (let c = range.s.c; c <= range.e.c; c++) {
      const th = document.createElement('th');
      th.textContent = XLSX.utils.encode_col(c);
      head.appendChild(th);
    }
    const body = table.createTBody();
    let active = null;
    for (let r = r0; r <= r1; r++) {
      const tr = body.insertRow();
      const th = document.createElement('th');
      th.textContent = r + 1;
      tr.appendChild(th);
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const td = tr.insertCell();
        td.textContent = Extract.cellText(ws[addr]);
        if (hitCells.has(addr)) {
          td.classList.add('cell-hit');
          td.style.setProperty('--c', hitCells.get(addr));
          if (addr === hit.loc.cell) { td.classList.add('active'); active = td; }
        }
      }
    }
    scroller.appendChild(table);
    frag.appendChild(scroller);
    container.replaceChildren(frag);
    if (active) active.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }

  window.Viewer = { show, getZoom, setZoom, stepZoom };
})();
