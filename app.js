/*
 * App — state, drop zone, scan queue, word-list editor, dashboard, hit list
 * and the viewer panel. Everything runs in this browser tab; files are never uploaded.
 */
(function () {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') Object.entries(v).forEach(([p, val]) => el.style.setProperty(p, val));
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && !k.includes('-')) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : String(kid));
    }
    return el;
  }

  const KIND_LABEL = { pdf: 'PDF', docx: 'DOCX', sheet: 'XLS', 'legacy-doc': 'DOC', unsupported: '?' };
  const GROUP_CAP = 20;
  const keyOf = (listId, term) => `${listId}\u0000${term}`;
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

  const state = {
    lists: Lists.load(),
    docs: [],
    compiled: [],
    filter: { text: '', listId: '', term: '' },
    openLists: new Set(),
    expanded: new Set(),
    closedFiles: new Set(),
    active: null,
  };
  let docSeq = 0;
  const queue = [];
  let busy = false;

  /* ---------- matching ---------- */

  function compileLists() {
    const terms = [];
    for (const l of state.lists) if (l.enabled) for (const t of l.terms) terms.push({ term: t, listId: l.id });
    state.compiled = Matcher.compileTerms(terms);
  }

  function listById(id) { return state.lists.find((l) => l.id === id); }

  function matchDoc(doc) {
    const hits = [];
    for (const seg of doc.segments) {
      for (const m of Matcher.findAll(seg.text, state.compiled)) {
        const list = listById(m.listId);
        hits.push({
          id: `${doc.id}:${hits.length}`, doc, seg, loc: seg.loc,
          term: m.term, listId: m.listId, key: keyOf(m.listId, m.term), color: list ? list.color : '#888',
          start: m.start, end: m.end, ocr: !!seg.ocr,
          snip: Matcher.snippet(seg.text, m.start, m.end),
        });
      }
    }
    doc.hits = hits;
  }

  const allHits = () => state.docs.flatMap((d) => d.hits);

  function visibleHits() {
    const f = state.filter;
    const q = f.text.trim().toLowerCase();
    return allHits().filter((x) =>
      (!f.listId || x.listId === f.listId) &&
      (!f.term || x.key === f.term) &&
      (!q || `${x.snip.before}${x.snip.match}${x.snip.after} ${x.doc.name} ${x.seg.label || ''}`.toLowerCase().includes(q)));
  }

  function locLabel(x) {
    const l = x.loc;
    if (l.page) return `Page ${l.page}`;
    if (l.para != null) return `Paragraph ${l.para + 1}`;
    if (l.sheet) return `${l.sheet} · ${l.cell}`;
    return '';
  }

  /* ---------- word lists ---------- */

  let rematchTimer = null;
  function listsChanged({ structure = false } = {}) {
    if (!Lists.save(state.lists)) toast('Could not save lists in this browser — use Export to keep a copy.');
    if (structure) renderLists();
    clearTimeout(rematchTimer);
    rematchTimer = setTimeout(rematchAll, 250);
  }

  function rematchAll() {
    compileLists();
    const prev = state.active;
    state.docs.filter((d) => d.status === 'done').forEach(matchDoc);
    if (prev) {
      const same = prev.doc.hits.find((x) => x.seg === prev.seg && x.start === prev.start && x.term === prev.term);
      if (same) state.active = same; else closeViewer();
    }
    if (state.filter.term && !state.lists.some((l) => l.enabled && l.terms.some((t) => keyOf(l.id, t) === state.filter.term))) {
      state.filter.term = '';
    }
    renderFiles();
    renderResults();
    if (state.active) showActive();
  }

  function renderLists() {
    $('#lists').replaceChildren(...state.lists.map(listCard));
    renderListFilter();
  }

  function listCard(list) {
    const open = state.openLists.has(list.id);
    const count = h('span', { class: 'list-count', title: 'Words / phrases' }, list.terms.length);
    const card = h('section', { class: `list-card${open ? ' open' : ''}${list.enabled ? '' : ' off'}`, style: { '--c': list.color } },
      h('div', { class: 'list-head' },
        h('input', { type: 'checkbox', checked: list.enabled, title: 'Include this list in the scan', 'aria-label': `Include ${list.name}`,
          onchange: (e) => { list.enabled = e.target.checked; card.classList.toggle('off', !list.enabled); listsChanged(); } }),
        h('input', { type: 'color', class: 'swatch', value: list.color, title: 'Highlight color', 'aria-label': 'Highlight color',
          oninput: (e) => { list.color = e.target.value; card.style.setProperty('--c', list.color); listsChanged(); } }),
        h('input', { class: 'list-name', value: list.name, 'aria-label': 'List name', spellcheck: false,
          oninput: (e) => { list.name = e.target.value; listsChanged(); renderListFilter(); } }),
        count,
        h('button', { class: 'icon-btn chev', title: open ? 'Close' : 'Edit words', 'aria-expanded': String(open),
          onclick: () => { open ? state.openLists.delete(list.id) : state.openLists.add(list.id); renderLists(); } }, icon('chevron'))),
      open && h('div', { class: 'list-body' },
        h('textarea', { class: 'terms', rows: Math.min(16, Math.max(6, list.terms.length + 1)), value: list.terms.join('\n'),
          placeholder: 'One word or phrase per line', spellcheck: false, 'aria-label': `Words in ${list.name}`,
          oninput: (e) => {
            list.terms = [...new Set(e.target.value.split('\n').map((t) => t.trim()).filter(Boolean))];
            count.textContent = list.terms.length;
            listsChanged();
          } }),
        h('div', { class: 'list-actions' },
          h('span', { class: 'hint' }, 'One per line. Plurals, -ed, -ing are found automatically.'),
          h('button', { class: 'link danger', onclick: () => {
            if (!confirm(`Delete the list “${list.name}”?`)) return;
            state.lists = state.lists.filter((l) => l !== list);
            if (state.filter.listId === list.id) state.filter.listId = '';
            listsChanged({ structure: true });
          } }, 'Delete list'))));
    return card;
  }

  function newList() {
    const color = Lists.PALETTE[state.lists.length % Lists.PALETTE.length];
    const list = Lists.normalize({ name: 'New list', color, terms: [] }, state.lists.length);
    state.lists.push(list);
    state.openLists.add(list.id);
    listsChanged({ structure: true });
    const cards = document.querySelectorAll('.list-card');
    const name = cards[cards.length - 1].querySelector('.list-name');
    name.focus();
    name.select();
  }

  async function importLists(file) {
    try {
      const lists = await Lists.importFile(file);
      state.lists.push(...lists);
      listsChanged({ structure: true });
      toast(`Imported ${plural(lists.length, 'list')}.`);
    } catch (e) { toast(e.message); }
  }

  function renderListFilter() {
    const sel = $('#filter-list');
    sel.replaceChildren(h('option', { value: '' }, 'All lists'),
      ...state.lists.map((l) => h('option', { value: l.id }, l.name || 'Untitled')));
    sel.value = state.filter.listId;
  }

  /* ---------- files & scan queue ---------- */

  function addFiles(files) {
    let added = 0;
    for (const file of files) {
      if (state.docs.some((d) => d.name === file.name && d.file.size === file.size && d.file.lastModified === file.lastModified)) continue;
      const doc = { id: `d${++docSeq}`, name: file.name, file, kind: Extract.kindOf(file.name),
        status: 'queued', message: 'Waiting…', segments: [], hits: [], forceOcr: false };
      state.docs.push(doc);
      queue.push(doc);
      added++;
    }
    if (!added) return;
    renderFiles();
    renderResults();
    pump();
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const doc = queue.shift();
      if (!state.docs.includes(doc)) continue;
      doc.status = 'working';
      doc.message = 'Opening…';
      renderFileRow(doc);
      try {
        doc.segments = await Extract.extract(doc, (msg) => { doc.message = msg; renderFileRow(doc); });
        doc.status = 'done';
        matchDoc(doc);
      } catch (e) {
        console.error(e);
        doc.status = 'error';
        doc.message = e.message || String(e);
      }
      if (!state.docs.includes(doc)) { disposeDoc(doc); continue; }
      renderFileRow(doc);
      renderResults();
    }
    busy = false;
  }

  function disposeDoc(doc) {
    if (doc.pdf) doc.pdf.destroy();
    if (doc.docxNode) doc.docxNode.remove();
    if (doc.docxStyles) doc.docxStyles.remove();
    doc.pdf = doc.docxNode = doc.docxStyles = doc.workbook = null;
    doc.segments = [];
    doc.hits = [];
  }

  function removeDoc(doc) {
    state.docs = state.docs.filter((d) => d !== doc);
    if (state.active && state.active.doc === doc) closeViewer();
    if (doc.status !== 'working') disposeDoc(doc);
    renderFiles();
    renderResults();
  }

  function rescan(doc, forceOcr) {
    if (state.active && state.active.doc === doc) closeViewer();
    disposeDoc(doc);
    doc.forceOcr = forceOcr;
    doc.status = 'queued';
    doc.message = 'Waiting…';
    queue.push(doc);
    renderFiles();
    renderResults();
    pump();
  }

  function statusText(doc) {
    if (doc.status === 'done') {
      let s = plural(doc.hits.length, 'hit');
      if (doc.kind === 'pdf') s += ` · ${plural(doc.pageCount, 'page')}`;
      if (doc.ocrPageCount) s += ` · ${doc.ocrPageCount} OCR`;
      return s;
    }
    return doc.message;
  }

  function fileRow(doc) {
    const ext = (doc.name.split('.').pop() || '').toUpperCase();
    return h('li', { class: `file-row ${doc.status}`, 'data-doc': doc.id },
      h('span', { class: `kind kind-${doc.kind}` }, doc.kind === 'sheet' ? ext.slice(0, 4) : KIND_LABEL[doc.kind]),
      h('span', { class: 'fname', title: doc.name }, doc.name),
      h('span', { class: 'fstatus' }, doc.status === 'working' && h('span', { class: 'spinner', 'aria-hidden': 'true' }), statusText(doc)),
      doc.kind === 'pdf' && (doc.status === 'done' || doc.forceOcr) && h('label', { class: 'ocr-toggle',
        title: 'Re-read every page with OCR — use for scans that only have a thin text layer (e.g. a title block)' },
        h('input', { type: 'checkbox', checked: doc.forceOcr, disabled: doc.status !== 'done',
          onchange: (e) => rescan(doc, e.target.checked) }), 'Force OCR'),
      h('button', { class: 'icon-btn', title: 'Remove file', 'aria-label': `Remove ${doc.name}`, onclick: () => removeDoc(doc) }, icon('x')));
  }

  function renderFileRow(doc) {
    const old = document.querySelector(`.file-row[data-doc="${doc.id}"]`);
    if (old) old.replaceWith(fileRow(doc)); else renderFiles();
  }

  function renderFiles() {
    const has = state.docs.length > 0;
    $('#app').classList.toggle('has-files', has);
    document.body.classList.toggle('files-loaded', has);
    $('#files').replaceChildren(...state.docs.map(fileRow));
    $('#files-head').hidden = !has;
    $('#file-count').textContent = plural(state.docs.length, 'file');
  }

  /* ---------- dashboard & hits ---------- */

  function renderResults() {
    const done = state.docs.filter((d) => d.status === 'done');
    const out = $('#results');
    $('#toolbar').hidden = !done.length;
    if (!done.length) { out.replaceChildren(); return; }
    if (!state.compiled.length) {
      out.replaceChildren(h('div', { class: 'empty' }, 'No words to search for. Turn on a word list, or add words to one, in the panel on the left.'));
      return;
    }
    out.replaceChildren(dashboard(done), hitList());
    markActiveRow();
  }

  function dashboard(done) {
    const hits = allHits();
    const counts = new Map();
    for (const x of hits) counts.set(x.key, (counts.get(x.key) || 0) + 1);

    const terms = [];
    for (const l of state.lists) if (l.enabled) for (const t of l.terms) terms.push({ list: l, term: t, key: keyOf(l.id, t), n: counts.get(keyOf(l.id, t)) || 0 });
    const found = terms.filter((t) => t.n).sort((a, b) => b.n - a.n);
    const missing = terms.filter((t) => !t.n);
    const maxN = found.length ? found[0].n : 1;
    const ocrPages = done.reduce((s, d) => s + (d.ocrPageCount || 0), 0);

    const tile = (label, value, sub) => h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), sub && h('div', { class: 'tile-sub' }, sub));

    const fileCounts = done.map((d) => ({ d, n: d.hits.length })).sort((a, b) => b.n - a.n);
    const maxF = Math.max(1, ...fileCounts.map((f) => f.n));

    return h('section', { class: 'dash', 'aria-label': 'Summary' },
      h('div', { class: 'tiles' },
        tile('Total hits', hits.length.toLocaleString()),
        tile('Keywords found', `${found.length} / ${terms.length}`, missing.length ? `${missing.length} not found` : 'all found'),
        tile('Files scanned', done.length, state.docs.length > done.length ? `${state.docs.length - done.length} pending or failed` : null),
        tile('Pages read by OCR', ocrPages, ocrPages ? 'check these hits closely' : null)),
      h('div', { class: 'panels' },
        h('div', { class: 'panel' },
          h('h3', null, 'Hits by keyword', h('span', { class: 'muted' }, ' — click to filter')),
          found.length ? h('div', { class: 'bars' }, found.map((t) =>
            h('button', { class: `bar-row${state.filter.term === t.key ? ' selected' : ''}`, style: { '--c': t.list.color }, title: `${t.term} (${t.list.name})`,
              onclick: () => setTermFilter(state.filter.term === t.key ? '' : t.key) },
              h('span', { class: 'bar-label' }, t.term),
              h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: { width: `${(t.n / maxN) * 100}%` } })),
              h('span', { class: 'bar-n' }, t.n.toLocaleString())))) : h('p', { class: 'muted' }, 'No keywords found in these files.')),
        h('div', { class: 'panel' },
          h('h3', null, 'Hits by file'),
          h('div', { class: 'bars' }, fileCounts.map(({ d, n }) =>
            h('button', { class: 'bar-row file', title: d.name, onclick: () => jumpToFile(d) },
              h('span', { class: 'bar-label' }, d.name),
              h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: { width: `${(n / maxF) * 100}%` } })),
              h('span', { class: 'bar-n' }, n.toLocaleString())))),
          h('h3', { class: 'nf-head' }, 'Not found', h('span', { class: 'muted' }, ` — ${missing.length}`)),
          missing.length ? h('div', { class: 'chips' }, missing.map((t) =>
            h('span', { class: 'chip ghost', style: { '--c': t.list.color }, title: t.list.name }, t.term)))
            : h('p', { class: 'muted' }, 'Every keyword appears at least once.'))));
  }

  function hitList() {
    const vis = visibleHits();
    const f = state.filter;
    const wrap = h('section', { class: 'hits', 'aria-label': 'Hits' });
    const filtered = f.text || f.listId || f.term;
    wrap.append(h('div', { class: 'hits-head' },
      h('h2', null, filtered ? `${plural(vis.length, 'hit')} match the filters` : plural(vis.length, 'hit')),
      f.term && h('button', { class: 'chip removable', style: { '--c': colorOfKey(f.term) }, onclick: () => setTermFilter('') },
        f.term.split('\u0000')[1], icon('x'))));

    if (!vis.length) {
      wrap.append(h('div', { class: 'empty' }, filtered ? 'Nothing matches these filters.' : 'No hits yet.'));
      return wrap;
    }

    for (const doc of state.docs) {
      const docHits = vis.filter((x) => x.doc === doc);
      if (!docHits.length) continue;
      const groups = new Map();
      for (const x of docHits) {
        if (!groups.has(x.key)) groups.set(x.key, []);
        groups.get(x.key).push(x);
      }
      const details = h('details', { class: 'file-group', open: !state.closedFiles.has(doc.id), 'data-doc': doc.id,
        ontoggle: (e) => { e.target.open ? state.closedFiles.delete(doc.id) : state.closedFiles.add(doc.id); } },
        h('summary', null,
          h('span', { class: `kind kind-${doc.kind}` }, KIND_LABEL[doc.kind]),
          h('span', { class: 'fname' }, doc.name),
          h('span', { class: 'count' }, plural(docHits.length, 'hit'))));
      for (const [key, xs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
        const gid = `${doc.id}|${key}`;
        const showAll = state.expanded.has(gid);
        const shown = showAll ? xs : xs.slice(0, GROUP_CAP);
        details.append(h('div', { class: 'kw-group' },
          h('div', { class: 'kw-head' },
            h('span', { class: 'chip', style: { '--c': xs[0].color } }, xs[0].term),
            h('span', { class: 'muted' }, plural(xs.length, 'hit'))),
          h('ul', { class: 'hit-rows' }, shown.map(hitRow)),
          xs.length > GROUP_CAP && h('button', { class: 'link more', onclick: () => {
            showAll ? state.expanded.delete(gid) : state.expanded.add(gid); renderResults();
          } }, showAll ? 'Show fewer' : `Show ${xs.length - GROUP_CAP} more`)));
      }
      wrap.append(details);
    }
    return wrap;
  }

  function hitRow(x) {
    return h('li', null, h('button', { class: 'hit-row', 'data-hit': x.id, style: { '--c': x.color }, onclick: () => openHit(x) },
      h('span', { class: 'loc' }, locLabel(x), x.ocr && h('span', { class: 'tag', title: 'Found by OCR — the scan may be misread' }, 'OCR')),
      h('span', { class: 'snip' },
        x.seg.label && h('span', { class: 'row-label' }, `${x.seg.label}: `),
        x.snip.before, h('mark', null, x.snip.match), x.snip.after)));
  }

  function colorOfKey(key) {
    const l = listById(key.split('\u0000')[0]);
    return l ? l.color : '#888';
  }

  function setTermFilter(key) {
    state.filter.term = key;
    renderResults();
  }

  function jumpToFile(doc) {
    state.closedFiles.delete(doc.id);
    const f = state.filter;
    if (f.text || f.listId || f.term) {
      Object.assign(f, { text: '', listId: '', term: '' });
      $('#filter-text').value = '';
      $('#filter-list').value = '';
    }
    renderResults();
    const el = document.querySelector(`.file-group[data-doc="${doc.id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- viewer ---------- */

  function navList() {
    const vis = visibleHits();
    return state.active && vis.includes(state.active) ? vis : allHits();
  }

  function openHit(x) {
    state.active = x;
    $('#app').classList.add('viewing');
    $('#viewer').hidden = false;
    const w = parseFloat($('#app').style.getPropertyValue('--viewer-w'));
    if (w) setViewerWidth(w, { rerender: false }); // re-clamp a saved width to this window
    markActiveRow();
    showActive();
  }

  function showActive() {
    const x = state.active;
    const nav = navList();
    const i = nav.indexOf(x);
    const inFile = nav.filter((y) => y.doc === x.doc);

    $('#v-file').textContent = x.doc.name;
    $('#v-file').title = x.doc.name;
    $('#v-loc').replaceChildren(...[
      h('span', { class: 'chip', style: { '--c': x.color } }, x.term),
      h('span', null, locLabel(x)),
      x.seg.label && h('span', { class: 'muted' }, `Row: ${x.seg.label}`),
      x.ocr && h('span', { class: 'tag', title: 'Found by OCR — the scan may be misread' }, 'OCR'),
      h('span', { class: 'muted' }, `Hit ${inFile.indexOf(x) + 1} of ${inFile.length} in this file`),
    ].filter(Boolean));
    $('#v-prev').disabled = i <= 0;
    $('#v-next').disabled = i < 0 || i >= nav.length - 1;

    const body = $('#viewer-body');
    Promise.resolve()
      .then(() => Viewer.show(body, x.doc, x, x.doc.hits))
      .catch((e) => { console.error(e); body.replaceChildren(h('div', { class: 'empty' }, `Could not show this document: ${e.message || e}`)); });
  }

  function step(dir) {
    if (!state.active) return;
    const nav = navList();
    const next = nav[nav.indexOf(state.active) + dir];
    if (next) {
      if (state.closedFiles.has(next.doc.id)) { state.closedFiles.delete(next.doc.id); renderResults(); }
      openHit(next);
      const row = document.querySelector(`.hit-row[data-hit="${CSS.escape(next.id)}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }

  const ZOOM_KEY = 'addendum-reviewer.zoom';
  try { Viewer.setZoom(parseFloat(localStorage.getItem(ZOOM_KEY)) || 1); } catch (e) { /* storage blocked */ }

  function updateZoomUi() {
    const z = Viewer.getZoom();
    $('#z-level').textContent = `${Math.round(z * 100)}%`;
    $('#z-out').disabled = z <= 0.5;
    $('#z-in').disabled = z >= 4;
    $('#z-fit').disabled = z === 1;
  }

  function applyZoom() {
    updateZoomUi();
    try { localStorage.setItem(ZOOM_KEY, String(Viewer.getZoom())); } catch (e) { /* storage blocked */ }
    if (state.active) showActive();
  }
  function zoomBy(dir) { Viewer.stepZoom(dir); applyZoom(); }
  function zoomTo(z) { Viewer.setZoom(z); applyZoom(); }

  /* Drag handle on the viewer's left edge: drag left for a bigger document view. */
  const WIDTH_KEY = 'addendum-reviewer.viewer-width';
  const MIN_VIEWER = 360;
  const MIN_MAIN = 320;

  function clampViewerWidth(w) {
    const app = $('#app');
    const overlay = getComputedStyle($('#viewer')).position === 'fixed';
    const side = overlay ? 0 : $('aside.side').offsetWidth;
    const max = overlay ? window.innerWidth - 40 : app.clientWidth - side - MIN_MAIN;
    return Math.round(Math.max(MIN_VIEWER, Math.min(max, w)));
  }

  function setViewerWidth(w, { save = false, rerender = true } = {}) {
    const app = $('#app');
    if (w == null) {
      app.style.removeProperty('--viewer-w');
      try { localStorage.removeItem(WIDTH_KEY); } catch (e) { /* storage blocked */ }
    } else {
      app.style.setProperty('--viewer-w', `${clampViewerWidth(w)}px`);
      if (save) try { localStorage.setItem(WIDTH_KEY, String(clampViewerWidth(w))); } catch (e) { /* storage blocked */ }
    }
    if (rerender && state.active) showActive();
  }

  function wireResizer() {
    const handle = $('#v-resize');
    try {
      const saved = parseFloat(localStorage.getItem(WIDTH_KEY));
      if (saved) $('#app').style.setProperty('--viewer-w', `${saved}px`);
    } catch (e) { /* storage blocked */ }

    let dragging = false;
    let frame = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      cancelAnimationFrame(frame);
      const x = e.clientX;
      frame = requestAnimationFrame(() => setViewerWidth(window.innerWidth - x, { rerender: false }));
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      cancelAnimationFrame(frame);
      document.body.classList.remove('resizing');
      setViewerWidth(window.innerWidth - e.clientX, { save: true });
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', () => setViewerWidth(null));
    handle.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const delta = (e.key === 'ArrowLeft' ? 1 : -1) * (e.shiftKey ? 120 : 40);
      setViewerWidth($('#viewer').offsetWidth + delta, { save: true });
    });
  }

  function closeViewer() {
    state.active = null;
    $('#app').classList.remove('viewing');
    $('#viewer').hidden = true;
    const body = $('#viewer-body');
    // Keep rendered Word documents alive for next time; just detach them.
    body.replaceChildren();
    markActiveRow();
  }

  function markActiveRow() {
    document.querySelectorAll('.hit-row.active').forEach((el) => el.classList.remove('active'));
    if (!state.active) return;
    const row = document.querySelector(`.hit-row[data-hit="${CSS.escape(state.active.id)}"]`);
    if (row) row.classList.add('active');
  }

  /* ---------- misc UI ---------- */

  const ICONS = {
    chevron: '<path d="M6 9l6 6 6-6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/>',
  };
  function icon(name) {
    const span = document.createElement('span');
    span.className = 'icon';
    span.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return span;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  function checkLibraries() {
    const missing = [['pdfjsLib', 'PDF reader'], ['docx', 'Word reader'], ['XLSX', 'Excel reader'], ['Tesseract', 'OCR engine']]
      .filter(([g]) => !window[g]).map(([, label]) => label);
    if (missing.length) {
      const banner = $('#banner');
      banner.textContent = `Could not load: ${missing.join(', ')}. This app needs an internet connection the first time it opens — check the connection and reload.`;
      banner.hidden = false;
    }
  }

  function wireDropZone() {
    const input = $('#file-input');
    input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
    $('#drop').addEventListener('click', () => input.click());
    $('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    $('#add-more').addEventListener('click', () => input.click());

    let depth = 0;
    const isFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => { if (!isFiles(e)) return; depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    window.addEventListener('dragover', (e) => { if (isFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      addFiles([...e.dataTransfer.files]);
    });
  }

  function init() {
    checkLibraries();
    compileLists();
    renderLists();
    renderFiles();
    wireDropZone();

    $('#new-list').addEventListener('click', newList);
    $('#export-lists').addEventListener('click', () => Lists.exportJson(state.lists));
    $('#import-lists').addEventListener('click', () => $('#import-input').click());
    $('#import-input').addEventListener('change', (e) => { if (e.target.files[0]) importLists(e.target.files[0]); e.target.value = ''; });
    $('#clear-files').addEventListener('click', () => {
      if (!confirm('Remove all files from this session?')) return;
      [...state.docs].forEach(removeDoc);
    });

    let textTimer = null;
    $('#filter-text').addEventListener('input', (e) => {
      clearTimeout(textTimer);
      textTimer = setTimeout(() => { state.filter.text = e.target.value; renderResults(); }, 150);
    });
    $('#filter-list').addEventListener('change', (e) => { state.filter.listId = e.target.value; renderResults(); });

    $('#v-prev').addEventListener('click', () => step(-1));
    $('#v-next').addEventListener('click', () => step(1));
    $('#v-close').addEventListener('click', closeViewer);
    $('#z-in').addEventListener('click', () => zoomBy(1));
    $('#z-out').addEventListener('click', () => zoomBy(-1));
    $('#z-fit').addEventListener('click', () => zoomTo(1));
    updateZoomUi();
    wireResizer();
    document.addEventListener('keydown', (e) => {
      if (!state.active || e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); step(-1); }
      else if (e.key === '+' || e.key === '=') zoomBy(1);
      else if (e.key === '-' || e.key === '_') zoomBy(-1);
      else if (e.key === '0') zoomTo(1);
      else if (e.key === 'Escape') closeViewer();
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const w = parseFloat($('#app').style.getPropertyValue('--viewer-w'));
        if (w && state.active) setViewerWidth(w);
        else if (state.active) showActive();
      }, 200);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
