'use strict';
// ═══ The one list (Procress 21, APP docs/UX-LAYOUT.md §12) ════════════════
// Every list in the app is built from these, so a list learnt on one page
// reads and behaves the same on every other. The APK sibling is
// flutter/lib/widgets/ddx_list.dart (DdxListTile / DdxListSection /
// DdxListHeader / DdxEmptyState) — same anatomy, same words, same two heights.
//
//   listRowHtml     one row: icon · title (one line, …) · meta · count · actions · ⋯
//   listActHtml     a row button (shown on hover / focus / selected)
//   listGroupHtml   a group: sticky header with its count, folds, remembered per list
//   listHeadHtml    filter · sort · total — in that order, in that place, on every list
//   listHtml        the list box itself (role=listbox) — the keyboard lives on it
//   emptyStateHtml  icon + one sentence + at most one button
//   listRowsHtml    the rows, through lazyRows (core/lazy-rows.js) past LIST_LAZY_AT
//   listView        a list's items filtered + sorted by its own header
//
// Two densities only (§12.2): 'compact' (--row-compact, 28: the tree, menus,
// lists in a panel) and 'comfy' (--row-comfy, 40: a list that is the page).
// Every size is a token from src/design/generated/tokens.css (DraconDex-SDB);
// the CSS is css/list.css.
//
// The keyboard (§12.7) is the Nest tree's (Procress 17 I4) — listKeyNav below
// is that handler, moved here so hub/tree.js and every list share one: roving
// tabindex (Tab enters a list once), ↑ ↓ Home End, Enter opens (or runs the
// row's data-ls-key="Enter" button), F2 renames, Delete deletes (a row's
// button marked data-ls-key="Delete" — the same action
// as the click, so its undo toast or its confirm comes with it, Procress 17
// I3), Shift+F10 / the Menu key = the row's ⋯ menu.

const LIST_LAZY_AT = 100; // §12.8: past this, rows are added as they scroll in
const LIST_SORTS = ['name', 'edited', 'created', 'kind'];
const LIST_SORT_KEY = { manual: 'listSortManual', name: 'listSortName', edited: 'listSortEdited', created: 'listSortCreated', kind: 'listSortKind' };
const LIST_FOLD_KEY = 'dracondex-list-folds';

// Per-list state that outlives a re-render: filter text, sort, lazy window,
// and the function that redraws the list's body when the header changes.
const _lists = new Map();
function listState(list) {
  if (!_lists.has(list)) _lists.set(list, { q: '', sort: null, lazy: {}, render: null });
  return _lists.get(list);
}
// `render` redraws only the list's body (listHtml's #ls-<list>), so the
// filter field keeps its focus and caret while typing.
function listRegister(list, render, { sort = null } = {}) {
  const s = listState(list);
  s.render = render;
  if (s.sort == null && sort) s.sort = sort;
  return s;
}

const _lsAttr = (v) => x(v == null ? '' : String(v));

// A row's ⋯ / act button. `key` binds a keyboard key to it (Delete, F2).
// Text buttons ('Restore') and icon buttons are both ctl-sm, so they fit a
// compact row and never grow a comfy one.
// `hidden`: a key binding only — no button on the row (a compact row in a
// panel whose ⋯ already carries the command), still clicked by its key.
function listActHtml({ icon = '', name = '', onclick = '', key = '', text = false, danger = false, disabled = false, tip = '', hidden = false } = {}) {
  if (hidden) return `<button class="btn btn-g btn-i ls-act" hidden tabindex="-1" data-ls-key="${_lsAttr(key)}" onclick="event.stopPropagation();${onclick}" aria-label="${_lsAttr(name)}"></button>`;
  const cls = text ? 'btn btn-s btn-sm' : 'btn btn-g btn-i';
  const aria = tip || name;
  return `<button class="${cls} ls-act${danger ? ' ls-danger' : ''}" tabindex="-1"${key ? ` data-ls-key="${_lsAttr(key)}"` : ''}
    ${disabled ? 'disabled' : `onclick="event.stopPropagation();${onclick}"`} title="${_lsAttr(aria)}" aria-label="${_lsAttr(aria)}">${text ? `${icon}${x(name)}` : icon}</button>`;
}

// One row (§12.1).
//   icon       leading HTML (already safe); '' keeps an empty slot so titles
//              line up with rows that have one; null = no slot at all
//   title      text (escaped here) — or titleHtml, already safe
//   meta       secondary text (escaped) — or metaHtml; comfy rows put it on a
//              second line, compact rows at the end, before the count
//   count      a count or badge, always shown
//   trailing   other always-visible HTML (a chip)
//   actions    listActHtml() buttons, shown on hover / focus / selected
//   menu       JS for the ⋯ button AND the right click — the same menu both
//              ways, never right-click only (§12.1)
//   state      { selected, disabled, current }
//   density    'comfy' | 'compact'
//   onclick    JS run on click / Enter
//   attrs      extra attributes (data-*, draggable + drag handlers)
//   cls        extra classes (a page's own hook)
//   drag       a drag handle first in the row (reorderable lists, §12 part 3)
//   lead       HTML before the icon (a tree's fold chevron)
//   expanded   true / false: the row opens a body under it (an accordion)
function listRowHtml({
  icon = null, title = '', titleHtml = null, meta = '', metaHtml = null, count = null, trailing = '',
  actions = '', menu = '', state = {}, density = 'comfy', onclick = '', attrs = '', cls = '', tip = null, drag = false, lead = '', expanded = null,
} = {}) {
  const compact = density === 'compact';
  const titleIn = titleHtml ?? x(title);
  const metaIn = metaHtml ?? (meta ? x(meta) : '');
  const label = [title || (titleHtml ? String(titleHtml).replace(/<[^>]*>/g, '') : ''), meta].filter(Boolean).join(' · ');
  const tipText = tip ?? (title || '');
  const st = [state.selected ? ' sel' : '', state.disabled ? ' ls-off' : '', state.current ? ' ls-current' : ''].join('');
  const more = menu ? `<button class="btn btn-g btn-i ls-act ls-more" tabindex="-1" onclick="event.stopPropagation();${menu}"
      title="${_lsAttr(t('moreActions'))}" aria-label="${_lsAttr(t('moreActions'))}" aria-haspopup="menu">${I.options}</button>` : '';
  const rowCls = ['ls-row', compact ? 'ls-compact' : 'ls-comfy', st.trim(), cls].filter(Boolean).join(' ');
  return `<div class="${rowCls}" role="option" tabindex="-1"
    aria-selected="${state.selected ? 'true' : 'false'}"${state.disabled ? ' aria-disabled="true"' : ''} aria-label="${_lsAttr(label)}"${tipText ? ` title="${_lsAttr(tipText)}"` : ''}${expanded == null ? '' : ` aria-expanded="${!!expanded}"`}
    ${onclick && !state.disabled ? `onclick="${onclick}"` : ''}${menu ? ` oncontextmenu="${menu}"` : ''} ${attrs}>
    ${drag ? `<span class="ls-grip" aria-hidden="true">${I.grip}</span>` : ''}${lead}${icon == null ? '' : `<span class="ls-icon" aria-hidden="true">${icon}</span>`}
    <span class="ls-main"><span class="ls-title">${titleIn}</span>${!compact && metaIn ? `<span class="ls-meta">${metaIn}</span>` : ''}</span>
    ${compact && metaIn ? `<span class="ls-meta ls-side">${metaIn}</span>` : ''}${count != null && count !== '' ? `<span class="ls-count" data-no-i18n>${x(count)}</span>` : ''}${trailing}${expanded == null ? '' : `<span class="ls-chev${expanded ? '' : ' ls-shut'}" aria-hidden="true">${I.chevronDown}</span>`}${actions || more ? `<span class="ls-acts">${actions}${more}</span>` : ''}
  </div>`;
}

// A relation row (Classifier, Chronicler, Exhibitor, Narrator — the one
// relation surface): arrow · the other end (the row opens it) · where it
// lives (meta) · the relation's label (chip). `own` is this end, named when
// one list holds the relations of many (the Classifier's Relations view).
function listLinkRowHtml({ arrow = '', name = '', onclick = '', meta = '', label = '', own = null, actions = '' }) {
  const ownHtml = own ? `<span class="ls-link-own" onclick="event.stopPropagation();${own.onclick}">${x(own.name)}</span> ` : '';
  return listRowHtml({ density: 'compact', onclick, meta, actions, attrs: 'data-no-i18n',
    title: [own?.name, arrow, name].filter(Boolean).join(' '),
    titleHtml: `${ownHtml}${arrow ? `<span class="ls-link-arrow" aria-hidden="true">${x(arrow)}</span> ` : ''}${x(name)}`,
    trailing: label ? `<span class="ls-chip ls-on">${x(label)}</span>` : '' });
}
// The box a relation list sits in, with its empty state.
function listLinksHtml(rows) {
  return `<div class="cls-link-list ls-list" role="listbox" aria-label="${_lsAttr(t('linkedElements'))}">${rows || emptyStateHtml({ icon: I.relation, text: t('noLinkedElements') })}</div>`;
}

// Which groups of a list are folded, kept across sessions (§12.4).
function listFolds() {
  try { const v = JSON.parse(localStorage.getItem(LIST_FOLD_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}
const listFolded = (list, id) => (listFolds()[list] || []).includes(String(id));
function listGroupToggle(el) {
  const g = el.closest('.ls-group');
  if (!g) return;
  const folded = !g.classList.contains('ls-folded');
  g.classList.toggle('ls-folded', folded);
  el.setAttribute('aria-expanded', String(!folded));
  const all = listFolds();
  const set = new Set(all[g.dataset.lsList] || []);
  if (folded) set.add(g.dataset.lsGroup); else set.delete(g.dataset.lsGroup);
  all[g.dataset.lsList] = [...set];
  try { localStorage.setItem(LIST_FOLD_KEY, JSON.stringify(all)); } catch (_) {}
}

// A group (§12.4): its name and how many it holds, sticky over its rows while
// they pass under it, folding on a click / Enter. `rows` is the rows' HTML.
function listGroupHtml({ list, id, title, count = null, rows = '', collapsible = true }) {
  const folded = collapsible && listFolded(list, id);
  return `<div class="ls-group${folded ? ' ls-folded' : ''}" role="group" aria-label="${_lsAttr(title)}" data-ls-list="${_lsAttr(list)}" data-ls-group="${_lsAttr(id)}">
    <div class="ls-group-head" ${collapsible ? `role="button" tabindex="-1" aria-expanded="${!folded}" onclick="listGroupToggle(this)"` : ''}>
      ${collapsible ? `<span class="ls-chev" aria-hidden="true">${I.chevronDown}</span>` : ''}<span class="ls-group-title">${x(title)}</span>${count != null ? `<span class="ls-count" data-no-i18n>${x(count)}</span>` : ''}
    </div>
    <div class="ls-group-body">${rows}</div>
  </div>`;
}

// The list box. `aria` names it for a screen reader; `head` is listHeadHtml
// (or ''); `body` the rows / groups / empty state.
function listHtml({ list, aria = '', head = '', body = '', cls = '' }) {
  const boxCls = cls ? `ls ${cls}` : 'ls';
  return `<div class="${boxCls}" data-ls="${_lsAttr(list)}">${head}<div class="ls-list" role="listbox" id="ls-${_lsAttr(list)}" aria-label="${_lsAttr(aria)}">${body}</div></div>`;
}

// Redraw a registered list's body in place (its header stays).
function listRefresh(list) {
  const s = listState(list);
  const box = document.getElementById(`ls-${list}`);
  if (!box || !s.render) return;
  box.innerHTML = s.render();
  const total = document.querySelector(`[data-ls="${CSS.escape(list)}"] .ls-total`);
  if (total && s.shownCount != null) { total.textContent = s.shownCount; total.setAttribute('aria-label', t('listCount').replace('{n}', s.shownCount)); }
}

// The header (§12.4): filter → sort → total. `sorts` are the orders this
// list's rows have data for; `manual` offers "As arranged" (a list with an
// order of its own). A list without a filter shows `title` there instead.
function listHeadHtml({ list, count, filter = true, sorts = [], manual = false, title = '' }) {
  const s = listState(list);
  const opts = [...(manual ? ['manual'] : []), ...sorts.filter((k) => LIST_SORTS.includes(k))];
  const cur = s.sort || opts[0];
  return `<div class="ls-head">
    ${filter ? `<input class="ls-filter" type="search" value="${_lsAttr(s.q)}" placeholder="${_lsAttr(t('listFilterHint'))}" aria-label="${_lsAttr(t('listFilterHint'))}"
      oninput="listSetQuery(${xj(list)},this.value)" autocomplete="off">` : `<span class="ls-head-title">${x(title)}</span>`}
    ${opts.length > 1 ? `<select class="ls-sort" aria-label="${_lsAttr(t('listSort'))}" title="${_lsAttr(t('listSort'))}" onchange="listSetSort(${xj(list)},this.value)">
      ${opts.map((k) => `<option value="${k}"${k === cur ? ' selected' : ''}>${x(t(LIST_SORT_KEY[k]))}</option>`).join('')}</select>` : ''}
    <span class="ls-total" data-no-i18n aria-label="${_lsAttr(t('listCount').replace('{n}', count))}">${x(count)}</span>
  </div>`;
}
function listSetQuery(list, v) { listState(list).q = String(v || ''); listState(list).lazy = {}; listRefresh(list); }
function listSetSort(list, v) { listState(list).sort = v; listState(list).lazy = {}; listRefresh(list); }

// `items` as the list's header wants them (APK ddxMatches + ddxSorted):
// filtered on `text` (fields, any containing the query, case-insensitive),
// then names A→Z, dates newest first, kinds A→Z then by name; 'manual' (or a
// key with no getter) keeps the given order. Stable.
function listView(list, items, { name = (it) => it.name, text = null, edited = null, created = null, kind = null } = {}) {
  const s = listState(list);
  const qy = s.q.trim().toLowerCase();
  let out = qy ? items.filter((it) => (text ? text(it) : [name(it)]).some((f) => f != null && String(f).toLowerCase().includes(qy))) : [...items];
  const byName = (a, b) => String(name(a) || '').localeCompare(String(name(b) || ''), undefined, { sensitivity: 'base' });
  const cmp = { name: byName,
    edited: edited && ((a, b) => String(edited(b) || '').localeCompare(String(edited(a) || ''))),
    created: created && ((a, b) => String(created(b) || '').localeCompare(String(created(a) || ''))),
    kind: kind && ((a, b) => String(kind(a) || '').localeCompare(String(kind(b) || '')) || byName(a, b)) }[s.sort];
  if (cmp) out = out.map((it, i) => [it, i]).sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]).map(([it]) => it);
  s.shownCount = out.length;
  return out;
}

// The rows of a list, lazily past LIST_LAZY_AT (§12.8) — lazyRows windows them
// past 1,000 (Procress 19 F10). `key` names the lazy state when one list
// renders several groups.
function listRowsHtml(list, items, rowHtml, { keep = -1, key = '' } = {}) {
  if (items.length <= LIST_LAZY_AT) return items.map(rowHtml).join('');
  const lz = listState(list).lazy;
  return lazyRows(items, rowHtml, lz[key] || (lz[key] = {}), { step: LIST_LAZY_AT, keep });
}

// An empty list or page (§12.5): an icon, ONE sentence, at most one button.
function emptyStateHtml({ icon = I.info, text = '', action = null }) {
  return `<div class="ls-empty" role="status">
    <span class="ls-empty-icon" aria-hidden="true">${icon}</span><p>${x(text)}</p>
    ${action ? `<button class="btn btn-p btn-sm" onclick="${action.onclick}">${action.icon || ''}${x(action.label)}</button>` : ''}
  </div>`;
}

// The time groups of a list ordered by when (§12.4: Trash, version history):
// a database time ("YYYY-MM-DD HH:MM:SS", UTC) seen from now. The week starts
// on Monday, like the APK's default.
function listDateGroup(dbTime, now = new Date()) {
  const s = String(dbTime || '');
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`);
  if (isNaN(d)) return 'older';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (d >= today) return 'today';
  const weekStart = new Date(today); weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return d >= weekStart ? 'week' : 'older';
}
const LIST_DATE_GROUPS = [['today', 'listGroupToday'], ['week', 'listGroupThisWeek'], ['older', 'listGroupOlder']];

// Items split into the date groups, empty groups dropped: [[id, label, items]].
function listByDate(items, when) {
  return LIST_DATE_GROUPS.map(([id, key]) => [id, t(key), items.filter((it) => listDateGroup(when(it)) === id)]).filter(([, , g]) => g.length);
}

// ═══ Keyboard (§12.7) — one handler for the Nest tree and every list ═══════
// `rows` = the visible rows in order. `on` holds what this list does that the
// default does not: open (Enter), rename (F2), remove (Delete), menu.
function listRovingGo(rows, r) {
  if (!r) return;
  rows.forEach((x2) => { x2.tabIndex = -1; });
  r.tabIndex = 0;
  r.focus();
  r.scrollIntoView?.({ block: 'nearest' });
}
function listRowMenu(row) {
  const b = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.bottom }));
}
function listKeyNav(e, row, rows, on = {}) {
  const i = rows.indexOf(row);
  switch (e.key) {
    case 'ArrowDown': listRovingGo(rows, rows[i + 1]); break;
    case 'ArrowUp': listRovingGo(rows, rows[i - 1]); break;
    case 'Home': listRovingGo(rows, rows[0]); break;
    case 'End': listRovingGo(rows, rows[rows.length - 1]); break;
    case 'Enter': (on.open || ((r) => r.click()))(row); break;
    case 'F2': if (!on.rename) return false; on.rename(row); break;
    case 'Delete': if (!on.remove) return false; on.remove(row); break;
    case 'F10': if (!e.shiftKey) return false; (on.menu || listRowMenu)(row); break;
    case 'ContextMenu': (on.menu || listRowMenu)(row); break;
    default: return false;
  }
  e.preventDefault();
  return true;
}

// The lists' own use of it: rows and group headers of any .ls-list.
const LIST_STOPS = '.ls-row, .ls-group-head[role="button"]';
document.addEventListener('keydown', (e) => {
  const row = e.target.closest?.(LIST_STOPS);
  const box = row?.closest('.ls-list');
  if (!box || e.target.closest('input, select, textarea') || e.altKey || e.ctrlKey || e.metaKey) return;
  // Enter / Space on a button inside the row is that button's (a colour dot, Download)
  if (e.target !== row && (e.key === 'Enter' || e.key === ' ') && e.target.closest('button, [role="button"]')) return;
  const rows = [...box.querySelectorAll(LIST_STOPS)].filter((r) => r.offsetParent);
  const head = row.classList.contains('ls-group-head');
  if (head && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); listGroupToggle(row); return; }
  const keyed = (k) => () => row.querySelector(`[data-ls-key="${k}"]:not([disabled])`)?.click();
  listKeyNav(e, row, rows, {
    // a row with a button marked data-ls-key="Enter" (Launch, Restore) runs
    // that; otherwise Enter is the row's own click
    open: (r) => { if (r.getAttribute('aria-disabled') === 'true') return; const b = r.querySelector('[data-ls-key="Enter"]:not([disabled])'); if (b) b.click(); else r.click(); },
    rename: head ? null : row.querySelector('[data-ls-key="F2"]') ? keyed('F2') : null,
    remove: head ? null : row.querySelector('[data-ls-key="Delete"]') ? keyed('Delete') : null,
    menu: (r) => { if (r.hasAttribute('oncontextmenu')) listRowMenu(r); else r.querySelector('.ls-more')?.click(); },
  });
});
// Whatever row has focus is the list's tab stop (a click moves it too).
document.addEventListener('focusin', (e) => {
  const row = e.target.closest?.(LIST_STOPS);
  const box = row?.closest('.ls-list');
  if (!box || row.tabIndex === 0) return;
  box.querySelectorAll(LIST_STOPS).forEach((r) => { r.tabIndex = -1; });
  row.tabIndex = 0;
});
// Each list keeps exactly one tab stop — the selected row, else the first —
// however it was rendered (a re-render, a lazy chunk, a filter). Once a frame
// at most, and only over the lists on screen.
let _lsStopFrame = 0;
function listSyncStops() {
  _lsStopFrame = 0;
  for (const box of document.querySelectorAll('.ls-list')) {
    if (box.querySelector('[tabindex="0"]:is(.ls-row, .ls-group-head)')) continue;
    const stop = box.querySelector('.ls-row.sel') || box.querySelector(LIST_STOPS);
    if (stop) stop.tabIndex = 0;
  }
}
new MutationObserver(() => { if (!_lsStopFrame) _lsStopFrame = requestAnimationFrame(listSyncStops); })
  .observe(document.documentElement, { childList: true, subtree: true });
