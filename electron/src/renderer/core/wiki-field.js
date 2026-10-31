'use strict';
// ═══ [[wikilinks]] in plain text fields (v5 Part 4, APP docs/V5.md §8.4) ═
// The markdown editor (mdeditor.js) has had [[ autocomplete since v2.8; the
// other free-text fields — Classifier values, event stories, dialogue
// descriptions, Exhibitor notes, chat messages — were plain <input>,
// <textarea> and contenteditable cells with none. Any of them opts in with a
// `data-wiki` attribute; one delegated listener set serves them all, so a
// field is a one-attribute change in its template.
//
// Two ways to make a link, per the requirement:
//   type [[        a suggestion list of the vault's names (the same
//                  quickIndex cache mdeditor uses — refreshWikiCache)
//   select → right-click → "Connect link"   wraps the selection in [[ ]]
// Both only edit the TEXT. wiki_link rows are still written by the db layer
// when the field saves (§8.11.3 — this is a typing shortcut, not a second
// authoring surface), and only for fields registered in db/wiki-sources.js.

const WIKI_FIELD_SEL = '[data-wiki]';
const WIKI_AC_MAX = 8;
let _wikiAc = null; // { el, items, idx, pop }

// Text before the caret, and a writer that replaces [start, caret) — the
// same two operations for a form control and a plain-text contenteditable.
function wikiFieldCaret(el) {
  if (el.matches('[data-wiki-view][data-editing]')) {
    const c = wikiRawCaret(el);
    return c && { text: wikiRawOf(el), pos: c.pos };
  }
  if (el.isContentEditable) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !el.contains(sel.anchorNode)) return null;
    const r = sel.getRangeAt(0).cloneRange();
    r.selectNodeContents(el);
    r.setEnd(sel.anchorNode, sel.anchorOffset);
    return { text: el.textContent, pos: r.toString().length };
  }
  return { text: el.value, pos: el.selectionStart };
}

function wikiFieldWrite(el, text, caret) {
  if (el.matches('[data-wiki-view][data-editing]')) {
    wikiEditRender(el, text, caret, null);
  } else if (el.isContentEditable) {
    el.textContent = text;
    const node = el.firstChild || el;
    const r = document.createRange();
    r.setStart(node, Math.min(caret, node.textContent.length));
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  } else {
    el.value = text;
    el.selectionStart = el.selectionEnd = caret;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  // Form controls save on change; a scripted value change does not fire it,
  // so fire it here — the insert is the user's edit.
  if (!el.isContentEditable) el.dispatchEvent(new Event('change', { bubbles: true }));
}

// The name list is mdeditor.js's quickIndex cache. Refreshed on the first
// [[ in a field after 15s or a Nexus switch, so a name created a moment ago
// is offered without a quickIndex round trip on every keystroke.
let _wikiFieldCacheAt = { nexus: null, at: 0 };
async function warmWikiFieldCache() {
  const nx = S.nexus?.id ?? null;
  if (_wikiCacheList.length && _wikiFieldCacheAt.nexus === nx && Date.now() - _wikiFieldCacheAt.at < 15000) return;
  await refreshWikiCache();
  _wikiFieldCacheAt = { nexus: nx, at: Date.now() };
}

function hideWikiAc() {
  _wikiAc?.pop.remove();
  _wikiAc = null;
}

function paintWikiAc() {
  const a = _wikiAc;
  a.pop.innerHTML = a.items.map((it, i) => `
    <div class="mded-ac-item ${i === a.idx ? 'active' : ''}" data-i="${i}">
      <span class="dot" style="background:${x(it.color || 'var(--accent)')}"></span>
      <span class="name" data-no-i18n>${x(it.name)}</span><span class="mded-linktype" data-no-i18n>${x(it.type)}</span>
    </div>`).join('');
}

async function updateWikiAc(el) {
  const c = wikiFieldCaret(el);
  const m = c && c.text.slice(0, c.pos).match(/\[\[([^\[\]\n]*)$/);
  if (!m) { hideWikiAc(); return; }
  await warmWikiFieldCache();
  const frag = m[1].toLowerCase();
  const items = wikiAcItems(frag, WIKI_AC_MAX);
  if (!items.length) { hideWikiAc(); return; }
  if (!_wikiAc || _wikiAc.el !== el) {
    hideWikiAc();
    const pop = document.createElement('div');
    pop.className = 'mded-ac wiki-field-ac';
    pop.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus (and the caret) in the field
      const row = e.target.closest('.mded-ac-item');
      if (row && _wikiAc) { _wikiAc.idx = Number(row.dataset.i); acceptWikiAc(); }
    });
    document.body.appendChild(pop);
    _wikiAc = { el, items, idx: 0, pop };
  }
  _wikiAc.items = items;
  _wikiAc.idx = Math.min(_wikiAc.idx, items.length - 1);
  paintWikiAc();
  placeFloating(_wikiAc.pop, el, { gap: 4 }); // core/popover.js — flips above near the bottom
}

function acceptWikiAc() {
  const a = _wikiAc;
  const it = a?.items[a.idx];
  if (!it) return;
  const choices = wikiAcChoices(it); // an object: which page the link opens (mdeditor.js)
  if (choices) { a.items = choices; a.idx = 0; paintWikiAc(); return; }
  const text = it.insert ?? it.name;
  const c = wikiFieldCaret(a.el);
  const m = c && c.text.slice(0, c.pos).match(/\[\[([^\[\]\n]*)$/);
  hideWikiAc();
  if (!m) return;
  const start = c.pos - m[1].length;
  const after = c.text.slice(c.pos);
  const closing = after.startsWith(']]') ? '' : ']]';
  wikiFieldWrite(a.el, c.text.slice(0, start) + text + closing + after, start + text.length + 2);
}

// "Connect link": wrap the selected words in [[ ]].
function wrapWikiSelection(el) {
  if (el.matches('[data-wiki-view][data-editing]')) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !el.contains(sel.anchorNode)) return;
    const rg = sel.getRangeAt(0);
    const raw = wikiRawOf(el);
    const s = wikiRawOffset(el, rg.startContainer, rg.startOffset), e = wikiRawOffset(el, rg.endContainer, rg.endOffset);
    const picked = raw.slice(s, e);
    if (!picked.trim()) return;
    wikiFieldWrite(el, `${raw.slice(0, s)}[[${picked}]]${raw.slice(e)}`, e + 4);
    return;
  }
  if (el.isContentEditable) {
    const sel = window.getSelection();
    const picked = sel.toString();
    if (!picked.trim() || !el.contains(sel.anchorNode)) return;
    const c = wikiFieldCaret(el);
    const r = sel.getRangeAt(0).cloneRange();
    r.selectNodeContents(el);
    r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
    const s = r.toString().length;
    wikiFieldWrite(el, `${c.text.slice(0, s)}[[${picked}]]${c.text.slice(s + picked.length)}`, s + picked.length + 4);
    return;
  }
  const s = el.selectionStart, e = el.selectionEnd;
  const picked = el.value.slice(s, e);
  if (!picked.trim()) return;
  wikiFieldWrite(el, `${el.value.slice(0, s)}[[${picked}]]${el.value.slice(e)}`, e + 4);
}

const wikiFieldHasSelection = (el) => (el.isContentEditable
  ? !!window.getSelection().toString().trim()
  : el.selectionEnd > el.selectionStart);

function initWikiFields() {
  if (window.__wikiFields) return;
  window.__wikiFields = true;
  document.addEventListener('input', (e) => {
    const el = e.target.closest?.(WIKI_FIELD_SEL);
    if (el) updateWikiAc(el);
  });
  // Capture phase: the list owns the arrows / Enter / Tab / Escape while it
  // is open, before the field's own onkeydown (Enter-to-blur) sees them.
  document.addEventListener('keydown', (e) => {
    if (!_wikiAc || e.target !== _wikiAc.el) return;
    const a = _wikiAc;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      a.idx = (a.idx + (e.key === 'ArrowDown' ? 1 : -1) + a.items.length) % a.items.length;
      paintWikiAc();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation();
      acceptWikiAc();
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      hideWikiAc();
    }
  }, true);
  document.addEventListener('focusout', (e) => {
    if (_wikiAc && e.target === _wikiAc.el) setTimeout(hideWikiAc, 150);
  });
  document.addEventListener('contextmenu', (e) => {
    const el = e.target.closest?.(WIKI_FIELD_SEL);
    if (!el) return;
    const pop = ctxMenu(e, [cmdItem('text.wikiLink', { el, always: true })]);
    // Keep the field focused while the menu is used: a blur would run the
    // field's own save-and-re-render and take the selection (and the
    // element) away before the wrap lands.
    pop?.addEventListener('mousedown', (ev) => ev.preventDefault());
  });
}

// ── Procress 27 part 1 + 31 part 5: a field shows its links as links ────
// A data-wiki-view field (contenteditable) shows each [[link]] the way a
// markdown page does — the name alone, in the link colour, with the hover
// card (page/links.js): [[Module]] reads "Module", [[obj:Module/Object]]
// reads "Object". Procress 31 part 5 (D2, the Obsidian way): it STAYS so
// while the field is edited. Each link is one non-editable piece; moving the
// caret into it with ← / → shows that one link's [[…]] text to edit, and the
// caret leaving draws it as a link again. A click on a link opens it. Typing
// a closing ]] makes a link. What the field saves is always the raw text —
// wikiRawOf() reads it back from the links' data-src, and a capture-phase
// blur puts it in place before the field's own onblur reads textContent.
//   wikiViewAttrs(raw) on the element, wikiViewHtml(raw) inside.
function wikiViewHtml(raw) {
  const s = String(raw ?? '');
  if (!s.includes('[[')) return x(s);
  if (!_wikiCache) wikiViewsWhenLoaded();
  let out = '', at = 0;
  for (const m of s.matchAll(MD_WIKILINK_RE)) {
    out += x(s.slice(at, m.index)) + mdWikiLinkHtml(...wikiLinkSplit(m[1], m[2]), resolveWikiNameCached, m[0]);
    at = m.index + m[0].length;
  }
  return out + x(s.slice(at));
}
const wikiViewAttrs = (raw) => `data-wiki data-wiki-view data-raw="${x(raw ?? '')}"`;

// The field's text with every link as its [[…]] source — textContent, except
// that a link counts as what it was written as, not as the name it shows.
function wikiRawOf(el) {
  let out = '';
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out += c.data;
      else if (c.nodeType === 1) { if (c.dataset.src != null) out += c.dataset.src; else walk(c); }
    }
  };
  walk(el);
  return out.replace(/\u00a0/g, ' '); // a typed trailing space is an nbsp in contenteditable
}

// A DOM point (node, offset) inside el as an offset into wikiRawOf(el).
// A point inside a link's label is that link's start.
function wikiRawOffset(el, node, offset) {
  let pos = 0, hit = null;
  const walk = (n) => {
    for (let i = 0; i < n.childNodes.length && hit == null; i++) {
      if (n === node && i === offset) { hit = pos; return; }
      const c = n.childNodes[i];
      if (c.nodeType === 3) { if (c === node) { hit = pos + offset; return; } pos += c.data.length; }
      else if (c.nodeType === 1 && c.dataset.src != null) { if (c.contains(node)) { hit = pos; return; } pos += c.dataset.src.length; }
      else if (c.nodeType === 1) walk(c);
    }
    if (hit == null && n === node) hit = pos;
  };
  walk(el);
  return hit ?? pos;
}
function wikiRawCaret(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return null;
  return { pos: wikiRawOffset(el, sel.anchorNode, sel.anchorOffset) };
}
const wikiLinkRanges = (raw) => [...String(raw).matchAll(MD_WIKILINK_RE)].map((m) => ({ start: m.index, end: m.index + m[0].length }));

// Draw `raw` into the field being edited — every link a link except `open`
// ({start,end}: its [[…]] text, editable) — and put the caret at raw `caret`.
function wikiEditRender(el, raw, caret, open) {
  let out = '', at = 0;
  for (const m of String(raw).matchAll(MD_WIKILINK_RE)) {
    out += x(raw.slice(at, m.index));
    out += open && open.start === m.index
      ? `<span class="wikilink-src">${x(m[0])}</span>`
      : mdWikiLinkHtml(...wikiLinkSplit(m[1], m[2]), resolveWikiNameCached, m[0]);
    at = m.index + m[0].length;
  }
  el.innerHTML = out + x(raw.slice(at));
  wikiPlaceCaret(el, caret);
}
function wikiPlaceCaret(el, pos) {
  const r = document.createRange();
  let rem = pos, done = false;
  const walk = (n) => {
    for (const c of [...n.childNodes]) {
      if (done) return;
      if (c.nodeType === 3) {
        if (rem <= c.data.length) { r.setStart(c, rem); done = true; return; }
        rem -= c.data.length;
      } else if (c.nodeType === 1 && c.dataset.src != null) {
        if (rem <= 0) { r.setStartBefore(c); done = true; return; }
        rem -= c.dataset.src.length;
        if (rem <= 0) { r.setStartAfter(c); done = true; return; } // never inside a link
      } else if (c.nodeType === 1) walk(c);
    }
  };
  walk(el);
  if (!done) { r.selectNodeContents(el); r.collapse(false); } else r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

// Links drawn before the name list loaded could not be resolved; draw them
// again once it has (fields not being edited — an edited one redraws itself).
let _wikiViewsPending = false;
function wikiViewsWhenLoaded() {
  if (_wikiViewsPending || !S.nexus) return;
  _wikiViewsPending = true;
  warmWikiFieldCache().then(() => {
    _wikiViewsPending = false;
    document.querySelectorAll('[data-wiki-view]:not([data-editing])').forEach((el) => { el.innerHTML = wikiViewHtml(el.dataset.raw); });
  });
}

const WIKI_EDITING = '[data-wiki-view][data-editing]';
function initWikiViews() {
  if (window.__wikiViews) return;
  window.__wikiViews = true;
  // A click on a link follows it (core/router.js) — editing or not.
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest?.('[data-wiki-view] .wikilink')) e.preventDefault();
  }, true);
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el.matches?.('[data-wiki-view]') && !el.dataset.editing) el.dataset.editing = '1';
  });
  // Before the field's own onblur saves (capture runs first): the raw text.
  document.addEventListener('blur', (e) => {
    const el = e.target;
    if (el.matches?.(WIKI_EDITING)) el.textContent = wikiRawOf(el);
  }, true);
  // After the field's own onblur has saved (blur runs before focusout).
  document.addEventListener('focusout', (e) => {
    const el = e.target;
    if (!el.matches?.(WIKI_EDITING)) return;
    delete el.dataset.editing;
    el.dataset.raw = el.textContent.trim();
    el.innerHTML = wikiViewHtml(el.dataset.raw);
  });
  // ← / → onto a link: show that link's [[…]] text, the caret just inside it.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const el = e.target.closest?.(WIKI_EDITING);
    if (!el || _wikiAc || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || el.querySelector('.wikilink-src')) return;
    const c = wikiRawCaret(el);
    if (!c) return;
    const raw = wikiRawOf(el);
    const right = e.key === 'ArrowRight';
    const link = wikiLinkRanges(raw).find((l) => (right ? l.start === c.pos : l.end === c.pos));
    if (!link) return;
    e.preventDefault();
    wikiEditRender(el, raw, right ? link.start + 2 : link.end - 2, link);
  });
  // The caret left the open link: draw it as a link again.
  document.addEventListener('selectionchange', () => {
    const el = document.activeElement;
    if (!el?.matches?.(WIKI_EDITING) || el._wikiComposing) return;
    const span = el.querySelector('.wikilink-src');
    if (!span) return;
    const sel = window.getSelection();
    if (sel.rangeCount && sel.isCollapsed && span.contains(sel.anchorNode)) return;
    if (!sel.isCollapsed) return; // a selection being made: leave it alone
    const c = wikiRawCaret(el);
    wikiEditRender(el, wikiRawOf(el), c?.pos ?? 0, null);
  });
  // A ]] just typed closes a link: draw it (the caret stays where it was).
  document.addEventListener('compositionstart', (e) => { if (e.target.matches?.(WIKI_EDITING)) e.target._wikiComposing = true; });
  document.addEventListener('compositionend', (e) => { if (e.target.matches?.(WIKI_EDITING)) e.target._wikiComposing = false; });
  document.addEventListener('input', (e) => {
    const el = e.target.closest?.(WIKI_EDITING);
    if (!el || e.isComposing || el._wikiComposing || el.querySelector('.wikilink-src')) return;
    const raw = wikiRawOf(el), c = wikiRawCaret(el);
    const inside = (l) => c && l.start < c.pos && c.pos < l.end;
    const links = wikiLinkRanges(raw);
    if (links.filter((l) => !inside(l)).length === el.querySelectorAll('.wikilink[data-src]').length) return;
    wikiEditRender(el, raw, c?.pos ?? raw.length, links.find(inside) || null);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { initWikiFields(); initWikiViews(); });
else { initWikiFields(); initWikiViews(); }
