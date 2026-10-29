/*
 * Matcher — turns a list term into a forgiving regex and finds hits in text.
 *   - case-insensitive
 *   - whole words only ("tile" never matches "textile")
 *   - catches common variations: paint → paints/painted/painting/painter,
 *     bid → bidding/bidder, warranty → warranties, revise → revised/revising
 *   - phrases tolerate any spacing, line breaks or hyphens between words
 */
(function (root) {
  'use strict';

  const IRREGULAR = {
    addendum: ['addenda', 'addendums'],
    addenda: ['addendum', 'addendums'],
    criterion: ['criteria'],
    datum: ['data'],
    index: ['indices', 'indexes'],
  };

  const SUFFIX = '(?:s|es|ed|ing|er|ers)?';
  const WORD_CHAR = '[\\p{L}\\p{N}]';
  const SEP = '[\\s\\-\\u2010-\\u2015/]+';

  function escape(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Regex source for one word, including its common variations.
  function wordPattern(word) {
    const w = word.toLowerCase();
    const forms = [escape(w)];
    if (IRREGULAR[w]) IRREGULAR[w].forEach((f) => forms.push(escape(f)));

    // Short words, numbers and codes ("09 21 16", "O&M") match exactly.
    if (w.length <= 2 || /\d/.test(w) || /[^\p{L}]/u.test(w)) {
      return forms.length > 1 ? `(?:${forms.join('|')})` : forms[0];
    }

    // A plural typed in the list ("bonds") should still find "bond".
    let stem = w;
    if (/[^s]s$/.test(w) && w.length > 3) stem = w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.slice(0, -1);

    let variant;
    if (/[^aeiou]y$/.test(stem)) {
      const base = escape(stem.slice(0, -1));
      variant = `${base}(?:y|ies|ied|ier|iers|ying)`;
    } else if (stem.endsWith('e')) {
      variant = `${escape(stem.slice(0, -1))}(?:e|es|ed|ing|er|ers)`;
    } else if (/[^aeiou][aeiou][^aeiouwxy]$/.test(stem)) {
      // bid → bidding, bidder (doubled final consonant)
      variant = `${escape(stem)}(?:${escape(stem.slice(-1))}?(?:ed|ing|er|ers)|s|es)?`;
    } else {
      variant = `${escape(stem)}${SUFFIX}`;
    }
    forms.unshift(variant);
    return `(?:${forms.join('|')})`;
  }

  function termPattern(term) {
    const words = term.trim().split(/[\s\-‐-―/]+/).filter(Boolean);
    if (!words.length) return null;
    return `(?<!${WORD_CHAR})${words.map(wordPattern).join(SEP)}(?!${WORD_CHAR})`;
  }

  function compile(term) {
    const src = termPattern(term);
    return src ? new RegExp(src, 'giu') : null;
  }

  // Periods after these don't end a sentence ("Addendum No. 2", "Sec. 3.1").
  const ABBREV = /(?:^|[^\p{L}])(?:no|nos|sec|div|para|art|fig|ref|approx|incl|min|max|dwg|dwgs|sht|typ|e\.g|i\.e|etc|inc|co|corp|ltd|mr|mrs|ms|dr|st|vol|pg|pp)$/iu;

  // Sentence around [start, end): walk out to sentence punctuation or a blank line.
  function snippet(text, start, end, max = 240) {
    const isBoundary = (i) => {
      const ch = text[i];
      if (ch === '\n' && text[i + 1] === '\n') return true;
      if (!(ch === '.' || ch === '!' || ch === '?' || ch === ';') || !/\s/.test(text[i + 1] || ' ')) return false;
      return ch !== '.' || !ABBREV.test(text.slice(Math.max(0, i - 8), i));
    };
    let s = start;
    while (s > 0 && start - s < 400 && !isBoundary(s - 1)) s--;
    let e = end;
    while (e < text.length && e - end < 400 && !isBoundary(e)) e++;
    if (e < text.length) e++; // keep the closing punctuation

    let before = text.slice(s, start);
    let after = text.slice(end, e);
    const clean = (t) => t.replace(/\s+/g, ' ');
    before = clean(before).trimStart();
    after = clean(after).trimEnd();
    const match = clean(text.slice(start, end));

    const room = Math.max(40, max - match.length);
    if (before.length + after.length > room) {
      const half = Math.floor(room / 2);
      const keepBefore = Math.min(before.length, Math.max(half, room - after.length));
      const keepAfter = Math.min(after.length, room - keepBefore);
      if (keepBefore < before.length) before = '…' + before.slice(before.length - keepBefore).replace(/^\S*\s/, '');
      if (keepAfter < after.length) after = after.slice(0, keepAfter).replace(/\s\S*$/, '') + '…';
    }
    return { before, match, after };
  }

  // terms: [{ term, listId }] → hits per segment: [{ term, listId, start, end }]
  function findAll(text, compiled) {
    const out = [];
    for (const c of compiled) {
      c.re.lastIndex = 0;
      let m;
      while ((m = c.re.exec(text))) {
        if (!m[0].length) { c.re.lastIndex++; continue; }
        out.push({ term: c.term, listId: c.listId, start: m.index, end: m.index + m[0].length });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  function compileTerms(terms) {
    return terms
      .map((t) => ({ ...t, re: compile(t.term) }))
      .filter((t) => t.re);
  }

  const Matcher = { compile, compileTerms, findAll, snippet, termPattern };
  if (typeof module !== 'undefined' && module.exports) module.exports = Matcher;
  else root.Matcher = Matcher;
})(typeof window !== 'undefined' ? window : globalThis);
