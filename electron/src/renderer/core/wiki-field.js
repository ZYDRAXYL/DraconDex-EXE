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
  if (el.isContentEditable) {
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

// ── Procress 27 part 1: a field shows its links as links ───────────────
// While a data-wiki field is not being edited it shows each [[link]] the way
// a markdown page does — the name alone, highlighted, with the hover card
// (page/links.js): [[Module]] reads "Module", [[obj:Module/Object]] reads
// "Object". Focus it and the raw [[…]] text is back for editing; what is
// saved is always the raw text.
//   contenteditable  wikiViewAttrs(raw) on the element, wikiViewHtml(raw) inside
//   <textarea>       wikiTextareaHtml(attrs, raw) — a view box beside it
function wikiViewHtml(raw) {
  const s = String(raw ?? '');
  if (!s.includes('[[')) return x(s);
  if (!_wikiCache) wikiViewsWhenLoaded();
  let out = '', at = 0;
  for (const m of s.matchAll(MD_WIKILINK_RE)) {
    out += x(s.slice(at, m.index)) + mdWikiLinkHtml(m[1], m[2], resolveWikiNameCached);
    at = m.index + m[0].length;
  }
  return out + x(s.slice(at));
}
const wikiViewAttrs = (raw) => `data-wiki data-wiki-view data-raw="${x(raw ?? '')}"`;
function wikiTextareaHtml(attrs, raw) {
  return `<span class="wiki-view-wrap"><textarea ${attrs} data-wiki>${x(raw ?? '')}</textarea>`
    + `<div class="pv-textarea wiki-view" data-wiki-box tabindex="0">${wikiViewHtml(raw)}</div></span>`;
}

// Links drawn before the name list loaded could not be resolved; draw them
// again once it has.
let _wikiViewsPending = false;
function wikiViewsWhenLoaded() {
  if (_wikiViewsPending || !S.nexus) return;
  _wikiViewsPending = true;
  warmWikiFieldCache().then(() => {
    _wikiViewsPending = false;
    document.querySelectorAll('[data-wiki-view]:not([data-editing])').forEach((el) => { el.innerHTML = wikiViewHtml(el.dataset.raw); });
    document.querySelectorAll('.wiki-view-wrap:not(.editing) [data-wiki-box]').forEach((box) => { box.innerHTML = wikiViewHtml(box.previousElementSibling.value); });
  });
}

function initWikiViews() {
  if (window.__wikiViews) return;
  window.__wikiViews = true;
  // A click on a link follows it (core/router.js) instead of entering the field.
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest?.('[data-wiki-view]:not([data-editing]) .wikilink, [data-wiki-box] .wikilink')) e.preventDefault();
  }, true);
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el.matches?.('[data-wiki-box]')) {
      const wrap = el.parentElement, ta = wrap.querySelector('textarea');
      wrap.classList.add('editing');
      ta.focus();
      return;
    }
    if (!el.matches?.('[data-wiki-view]') || el.dataset.editing) return;
    el.dataset.editing = '1';
    if (el.textContent === el.dataset.raw) return; // nothing drawn as a link — keep the caret where it was put
    el.textContent = el.dataset.raw;
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  // After the field's own onblur has saved (blur runs before focusout).
  document.addEventListener('focusout', (e) => {
    const el = e.target;
    if (el.matches?.('.wiki-view-wrap textarea')) {
      const wrap = el.parentElement;
      wrap.classList.remove('editing');
      wrap.querySelector('[data-wiki-box]').innerHTML = wikiViewHtml(el.value);
      return;
    }
    if (!el.matches?.('[data-wiki-view]') || !el.dataset.editing) return;
    delete el.dataset.editing;
    el.dataset.raw = el.textContent.trim();
    el.innerHTML = wikiViewHtml(el.dataset.raw);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { initWikiFields(); initWikiViews(); });
else { initWikiFields(); initWikiViews(); }
