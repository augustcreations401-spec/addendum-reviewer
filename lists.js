/*
 * Lists — the saved word/phrase lists. Kept in this browser's storage, with
 * JSON export/import as the real backup (browser storage can be cleared).
 */
(function () {
  'use strict';

  const KEY = 'addendum-reviewer.lists.v1';
  const PALETTE = ['#d9480f', '#1c7ed6', '#2b8a3e', '#9c36b5', '#e8590c', '#0c8599', '#c2255c', '#5c940d'];

  const STARTER = [
    {
      name: 'Contract Risk',
      color: '#d9480f',
      terms: [
        'liquidated damages', 'retainage', 'performance bond', 'payment bond', 'bid bond',
        'pay when paid', 'pay if paid', 'indemnify', 'hold harmless', 'no damage for delay',
        'consequential damages', 'warranty', 'prevailing wage', 'additional insured',
        'waiver of subrogation', 'time is of the essence', 'termination for convenience', 'back charge',
      ],
    },
    {
      name: 'Addendum Changes',
      color: '#1c7ed6',
      terms: [
        'addendum', 'revised', 'deleted', 'added', 'replace', 'substitution', 'approved equal',
        'or equal', 'bid date', 'pre-bid', 'clarification', 'alternate', 'allowance', 'unit price',
        'value engineering',
      ],
    },
  ];

  const uid = () => Math.random().toString(36).slice(2, 10);

  function normalize(list, i) {
    const terms = Array.isArray(list.terms) ? list.terms : String(list.terms || '').split('\n');
    return {
      id: list.id || uid(),
      name: String(list.name || `List ${i + 1}`).slice(0, 80),
      color: /^#[0-9a-f]{6}$/i.test(list.color) ? list.color : PALETTE[i % PALETTE.length],
      enabled: list.enabled !== false,
      terms: [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))],
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(normalize);
      }
    } catch (e) { /* storage blocked or corrupt — fall back to starters */ }
    return STARTER.map(normalize);
  }

  function save(lists) {
    try { localStorage.setItem(KEY, JSON.stringify(lists)); return true; } catch (e) { return false; }
  }

  function exportJson(lists) {
    const data = { app: 'addendum-reviewer', version: 1, exported: new Date().toISOString(),
      lists: lists.map(({ name, color, enabled, terms }) => ({ name, color, enabled, terms })) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `word-lists-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Accepts our export format, a bare array of lists, or a plain text file (one term per line).
  async function importFile(file) {
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      const lists = Array.isArray(data) ? data : data.lists;
      if (!Array.isArray(lists)) throw new Error('No lists in file');
      return lists.map((l, i) => normalize({ ...l, id: undefined }, i));
    } catch (e) {
      if (/\.json$/i.test(file.name)) throw new Error(`Could not read ${file.name}: ${e.message}`);
      return [normalize({ name: file.name.replace(/\.[^.]+$/, ''), terms: text.split(/\r?\n/) }, 0)];
    }
  }

  window.Lists = { load, save, exportJson, importFile, normalize, uid, PALETTE };
})();
