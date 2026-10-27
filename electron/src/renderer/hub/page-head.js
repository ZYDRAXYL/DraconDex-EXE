'use strict';
// ═══ Page head (v5 Part 4, APP docs/V5.md §8.2; v5 Part 8, §12.10) ═══════
// The one builder for the header every page opens with — the module page,
// an element (item) page, a file, the Import Dock, Sage Hut, Wyvern and
// Dragon each carried their own copy of the same `.detail-head.module-head`
// markup before.
//
// Since v5 Part 8 it is two parts: the ADDRESS ROW (page/address.js) is the
// sticky one — the scroller is .bpane-body / #main-inner, so it pins to the
// top of the pane while the page scrolls under it — and the title below it
// scrolls away with the page. The old sticky title and its fold toggle
// went: a one-line address row has nothing to fold.
//
//   o.addr       which page this is, for the address row (page/address.js)
//   o.color      accent for the left rule and the icon
//   o.icon       icon HTML; o.iconOnclick makes it a button
//   o.title      title HTML (already escaped — may be an inline input)
//   o.titleText  plain title
//   o.after      HTML after the title on the same line (handle, kind chip)
//   o.sub        a second line (hint text)
//   o.tags       the chips row (.mtags)
//   o.acts       the page's own buttons, at the end of the address row
//   o.cls        extra class names
//   o.bare       o.sub is the whole head (Wyvern / Dragon breadcrumbs —
//                those workspaces have no panes, so no address row)
//   o.layout     {align, cover, icon} from pageHeadLayout() — the title's
//                own layout, set per page (Procress 13 part 4, below)
//   o.bigIcon    the icon shown above the title when layout.icon is on
//                (default o.icon) — an element page passes its own

function pageHeadHtml(o = {}) {
  const col = o.color || 'var(--accent)';
  const lay = o.layout || null;
  // Procress 28 part 2: "icon above the title" is the page's own icon, large —
  // the small one beside the name then goes (one icon, not two).
  const big = lay?.icon ? (o.bigIcon || o.icon) : '';
  const icon = o.icon && !big ? `<span class="kicon" style="color:${x(col)}${o.iconOnclick ? ';cursor:pointer' : ''}"${o.iconOnclick ? ` onclick="event.stopPropagation();${o.iconOnclick}"` : ''} data-no-i18n>${o.icon}</span>` : '';
  const cls = ['detail-head', 'module-head', o.cls || ''].filter(Boolean).join(' ');
  if (o.bare) {
    return `<div class="${cls} page-navbar" style="border-left:4px solid ${x(col)}">
      <div class="navbar-row"><div class="navbar-grow">${o.sub || ''}</div></div>
    </div>`;
  }
  const layCls = lay ? ` ph--${lay.align}${lay.cover ? ' has-cover' : ''}${lay.icon ? ' has-icon' : ''}` : '';
  if (lay?.cover) watchPageCovers();
  // Procress 18 part 1: the address row is ◀ ▶ + where the page lives; the
  // identity row under it is icon · name · kind · save state · the page's
  // one primary button · ⋯ (o.acts) — the name is not said twice.
  const addr = o.addr ? { ...o.addr, short: true } : { label: o.titleText };
  return `<div class="page-navbar addr-bar">${addressRowHtml(addr, '')}</div>
    ${lay?.cover ? `<div class="ph-cover" data-cover-sha="${x(lay.cover)}" style="background-position:${pbFocusCss(lay.focus)}"></div>` : ''}
    <div class="${cls} page-title${layCls}" style="border-left:4px solid ${x(col)};--ph-col:${x(col)}">
      ${big ? `<div class="ph-icon"${o.iconOnclick ? ` onclick="event.stopPropagation();${o.iconOnclick}"` : ''} aria-hidden="true">${big}</div>` : ''}
      <div class="navbar-row"><h2 class="navbar-h">${icon}${o.title || ''}${o.after || ''}</h2>
        <span class="ph-save" aria-live="polite"></span>${o.acts ? `<span class="navbar-acts">${o.acts}</span>` : ''}</div>
      ${o.sub ? `<div class="drafter-hint navbar-sub">${o.sub}</div>` : ''}
      ${o.tags ? `<div class="mtags">${o.tags}</div>` : ''}
    </div>`;
}

// ═══ Title layout per page (Procress 13 part 4, APP docs/REDESIGN.md C6) ══
// Stored in module_ui like the readable flag (page/focus.js): "pageHead" for
// a module page, "pageHead:<itemKey>" for an element page, value
// {align, cover, showIcon}. Procress 28 part 2: showIcon puts the page's own
// icon above the title; the older {icon:"<emoji>"} reads as on (the emoji
// is not shown any more), and an app that predates showIcon simply shows no
// icon instead of printing a marker. No row = today's look (left, no cover, no icon);
// setting everything back to that stores '' — the same "off" the readable
// flag uses — which reads back as the default.
// The cover is an Asset Nest image named by its sha256, not its id — ids
// differ on every device a vault is synced to, the hash does not. The key
// of an element page is remapped on snapshot import (db/sync.js).
const PAGE_HEAD_ALIGN = ['left', 'center', 'right'];
const pageHeadUiKey = (itemKey) => (itemKey ? `pageHead:${itemKey}` : 'pageHead');

function pageHeadLayout(moduleId, itemKey = null) {
  let v = null;
  try { v = JSON.parse(pageOf(moduleId, itemKey)?.props?.ui?.[pageHeadUiKey(itemKey)] || 'null'); } catch (_) {}
  return {
    align: PAGE_HEAD_ALIGN.includes(v?.align) ? v.align : 'left',
    // sha256, or file_<id> for a picture the vault has not hashed yet
    // (EXPORT-DECOR D3) — a hash is what survives a sync to another device
    cover: typeof v?.cover === 'string' && /^([a-f0-9]{64}|file_\d+)$/.test(v.cover) ? v.cover : null,
    focus: v?.focus && typeof v.focus === 'object' ? pbFocusOf(v.focus) : null,
    icon: v?.showIcon === true || (typeof v?.icon === 'string' && !!v.icon.trim()),
  };
}

async function setPageHeadLayout(moduleId, itemKey, patch) {
  const { icon, ...next } = { ...pageHeadLayout(moduleId, itemKey), ...patch };
  if (!next.cover) next.focus = null;
  if (!next.focus) delete next.focus;
  if (icon) next.showIcon = true;
  const val = next.align === 'left' && !next.cover && !icon ? '' : JSON.stringify(next);
  const key = pageHeadUiKey(itemKey);
  await api.module.setUi(moduleId, key, val);
  for (const p of Object.values(S.pages || {})) if (p.moduleId === moduleId && p.props?.ui) p.props.ui[key] = val;
  if (S.inspectorData?.moduleId === moduleId && S.inspectorData.ui) S.inspectorData.ui[key] = val;
  renderNexusHome();
}

// The page the layout command acts on: the open element page, else the
// open module page.
function pageHeadTarget() {
  const it = S.activeItemNode;
  if (it?.itemKey) return { moduleId: it.moduleId, itemKey: it.itemKey };
  return S.activeModuleNode ? { moduleId: S.activeModuleNode.id, itemKey: null } : null;
}

// ── covers: sha256 → the image's id on THIS machine, once per vault ────
let PH_ASSETS = null;
async function pageHeadImages(force = false) {
  const nx = S.nexus?.id;
  if (nx == null) return { images: [], bySha: new Map() };
  if (!force && PH_ASSETS?.nx === nx) return PH_ASSETS;
  const files = await api.importdock.list(nx).catch(() => []);
  const images = (files || []).filter((f) => assetClass(f) === 'image' && f.sha256 && !f.missing);
  PH_ASSETS = { nx, images, bySha: new Map(images.map((f) => [f.sha256, f.id])) };
  return PH_ASSETS;
}
// A cover is drawn as a placeholder in the page HTML and filled in once
// its id is known. The HTML is built as a string and inserted by whichever
// renderer called pageHeadHtml(), sometimes after an await — so watch the
// DOM for new covers instead of guessing when that insertion happens.
let PH_OBSERVER = null;
function watchPageCovers() {
  if (PH_OBSERVER || typeof MutationObserver !== 'function') return;
  PH_OBSERVER = new MutationObserver(() => { if (document.querySelector('.ph-cover:not([data-ph])')) hydratePageCovers(); });
  PH_OBSERVER.observe(document.body, { childList: true, subtree: true });
  setTimeout(hydratePageCovers, 0);
}
async function hydratePageCovers() {
  const els = [...document.querySelectorAll('.ph-cover:not([data-ph])')];
  if (!els.length) return;
  for (const el of els) el.dataset.ph = 'pending';
  const { bySha } = await pageHeadImages();
  for (const el of els) {
    const ref = el.dataset.coverSha;
    const id = /^file_\d+$/.test(ref) ? Number(ref.slice(5)) : bySha.get(ref);
    // A deleted or never-synced image is simply no cover (C6), not an error.
    if (id == null) { el.dataset.ph = 'gone'; continue; }
    el.style.backgroundImage = `url("${displayImageUrl(id)}")`;
    el.dataset.ph = 'ok';
  }
}

// ── the popover ──────────────────────────────────────────────────────────
async function openPageLayoutPopup(anchor) {
  const tgt = pageHeadTarget();
  if (!tgt) return;
  closeAllPopups();
  const { images } = await pageHeadImages(true);
  const lay = pageHeadLayout(tgt.moduleId, tgt.itemKey);
  const seg = PAGE_HEAD_ALIGN.map((a) => `<button type="button" class="seg-opt${lay.align === a ? ' on' : ''}" aria-pressed="${lay.align === a}" data-align="${a}">${t(`align${a[0].toUpperCase()}${a.slice(1)}`)}</button>`).join('');
  const covers = images.slice(0, 24).map((f) => `<div role="button" tabindex="0" class="ph-cover-opt${lay.cover === f.sha256 ? ' active' : ''}" data-cover="${x(f.sha256)}" title="${x(f.file_name)}" style="background-image:url(&quot;${x(displayImageUrl(f.id))}&quot;)"></div>`).join('');
  const pop = openPopover(anchor || document.querySelector('.page-title') || pointAnchor(200, 80), `<div class="ph-pop-h">${t('pageLayout')}</div>
    <div class="ph-pop-label">${t('titleAlign')}</div>
    <div class="seg seg-sm seg-fill" role="group" aria-label="${t('titleAlign')}">${seg}</div>
    <label class="fv-useimg ph-icon-cb"><input type="checkbox"${lay.icon ? ' checked' : ''}> ${t('pageIcon')}</label>
    <div class="ph-pop-label">${t('pageCover')}</div>
    ${images.length
      ? `<div class="ph-covers"><div role="button" tabindex="0" class="ph-cover-opt ph-cover-none${lay.cover ? '' : ' active'}" data-cover="" title="${t('pageCoverNone')}">${I.close}</div>${covers}</div>`
      : `<div class="ph-pop-hint">${t('pageCoverEmpty')}</div>`}
    <div class="ph-acts"><button type="button" class="btn btn-s btn-sm" data-more="1">${t('pageCoverMore')}</button>
      ${lay.cover ? `<button type="button" class="btn btn-s btn-sm" data-focus="1">${t('pbFocusTitle')}</button>` : ''}</div>
    <div class="ph-pop-hint">${t('pageLayoutScope')}</div>`, { cls: 'ph-pop', keep: true, focus: false, aria: t('pageLayout') });
  pop.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-align]');
    const c = e.target.closest('[data-cover]');
    if (e.target.closest('[data-more]')) { pop.remove(); pageCoverPick(tgt); return; }
    if (e.target.closest('[data-focus]')) { pop.remove(); pageCoverFocus(tgt); return; }
    if (a) await setPageHeadLayout(tgt.moduleId, tgt.itemKey, { align: a.dataset.align });
    else if (c) await setPageHeadLayout(tgt.moduleId, tgt.itemKey, { cover: c.dataset.cover || null, focus: null });
    else return;
    openPageLayoutPopup(anchor); // redraw with the new state, same anchor
  });
  const cb = pop.querySelector('.ph-icon-cb input');
  cb.addEventListener('change', async () => { await setPageHeadLayout(tgt.moduleId, tgt.itemKey, { icon: cb.checked }); openPageLayoutPopup(anchor); });
}

// Any picture in the Nexus as the cover, through the picture picker (D4):
// stored by its hash when it has one, else by id (D3).
function pageCoverPick(tgt) {
  openPbImagePicker({ moduleId: tgt.moduleId, onPick: async ([id]) => {
    if (id == null) return;
    const { images } = await pageHeadImages(true);
    const sha = images.find((f) => f.id === id)?.sha256;
    await setPageHeadLayout(tgt.moduleId, tgt.itemKey, { cover: sha || `file_${id}`, focus: null });
    renderNexusHome();
  } });
}

// Where the cover keeps its subject when the band crops it.
async function pageCoverFocus(tgt) {
  const lay = pageHeadLayout(tgt.moduleId, tgt.itemKey);
  if (!lay.cover) return;
  const id = /^file_\d+$/.test(lay.cover) ? Number(lay.cover.slice(5)) : (await pageHeadImages()).bySha.get(lay.cover);
  if (id == null) return;
  pbFocusPicker(id, lay.focus, async (focus) => {
    await setPageHeadLayout(tgt.moduleId, tgt.itemKey, { focus });
    renderNexusHome();
  });
}

// ═══ Linked modules, from the page head (Procress 28 part 2) ═══════════
// The 🔗 on every module page: which modules this one is linked to, and a
// search to link another. A link made here is a module ↔ module relation
// (entity_relation, the row an Exhibitor draws too); one that comes from a
// [[link]] (part 6, db/viewer.js linkedModules) is listed but not removable
// here — it goes when the [[…]] does. Narrator, Author's point of view and
// the Classifier relation view all read the same list.
function pageLinkBtnHtml(moduleId) {
  // the count arrives after the page is drawn (the head is built as a string)
  requestAnimationFrame(() => api.module.linked(moduleId).then((ls) => {
    const n = document.querySelector(`.module-page[data-module="${moduleId}"] .ph-link-n`);
    if (n) n.textContent = ls.length ? String(ls.length) : '';
  }).catch(() => {}));
  return `<button class="btn btn-g btn-sm ph-links-open" aria-haspopup="dialog" title="${x(t('pageLinksTitle'))}" aria-label="${x(t('pageLinksTitle'))}"
    onclick="event.stopPropagation();openPageLinksPopup(${moduleId},this)">${I.relation}<span class="ph-link-n" data-no-i18n></span></button>`;
}

async function openPageLinksPopup(moduleId, anchor, query = '') {
  const linked = await api.module.linked(moduleId);
  const byId = new Map(linked.map((e) => [e.id, e]));
  const all = flattenModulesByKind(S.moduleTree, []).filter((m) => m.id !== moduleId && m.kind !== 'collector');
  const q0 = query.trim().toLowerCase();
  const row = (m) => {
    const e = byId.get(m.id);
    const meta = e ? [e.relationId ? t('pageLinkDirect') : '', e.wiki ? t('pageLinkViaWiki') : ''].filter(Boolean).join(' · ') : '';
    return listRowHtml({ density: 'compact', icon: moduleIconHtml(m),
      title: m.name, meta, state: { selected: !!e }, attrs: `data-link-mid="${m.id}" data-no-i18n`,
      actions: e?.relationId ? listActHtml({ icon: I.close, name: t('pageLinkRemove'), onclick: `pageLinkRemove(${moduleId},${e.relationId})` }) : '',
      onclick: e ? `openModuleNode(${m.id})` : `pageLinkAdd(${moduleId},${m.id})` });
  };
  const mine = all.filter((m) => byId.has(m.id));
  const others = q0 ? all.filter((m) => !byId.has(m.id) && m.name.toLowerCase().includes(q0)).slice(0, 30) : [];
  const body = (mine.length ? listGroupHtml({ list: 'page-links', id: 'mine', title: t('pageLinksTitle'), count: mine.length, rows: mine.map(row).join(''), collapsible: false })
    : emptyStateHtml({ icon: I.relation, text: t('pageLinksNone') }))
    + (others.length ? listGroupHtml({ list: 'page-links', id: 'add', title: t('pageLinkAddGroup'), rows: others.map(row).join(''), collapsible: false }) : '');
  const html = `<div class="ph-pop-h">${t('pageLinksTitle')}</div>
    <div class="fg"><input class="ph-link-q" value="${x(query)}" placeholder="${x(t('pageLinkSearch'))}" aria-label="${x(t('pageLinkSearch'))}"></div>
    ${listHtml({ list: 'page-links', aria: t('pageLinksTitle'), body })}`;
  let pop = document.querySelector('.ph-links-pop');
  if (pop) { pop.innerHTML = html; } else {
    pop = openPopover(anchor, html, { cls: 'ph-pop ph-links-pop', keep: false, focus: false, aria: t('pageLinksTitle') });
  }
  pop._linkAnchor = anchor;
  const inp = pop.querySelector('.ph-link-q');
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
  inp.addEventListener('input', () => { clearTimeout(pop._qT); pop._qT = setTimeout(() => openPageLinksPopup(moduleId, anchor, inp.value), 120); });
}
async function pageLinkAdd(moduleId, otherId) {
  await api.viewer.createRelation(S.nexus.id, `module_${moduleId}`, `module_${otherId}`, null, null, {});
  await pageLinksChanged(moduleId);
}
async function pageLinkRemove(moduleId, relationId) {
  await api.viewer.deleteRelation(relationId);
  await pageLinksChanged(moduleId);
}
// Redraw the popup (keeping what was typed) and the count on the page.
async function pageLinksChanged(moduleId) {
  const pop = document.querySelector('.ph-links-pop');
  if (pop) await openPageLinksPopup(moduleId, pop._linkAnchor, pop.querySelector('.ph-link-q')?.value || '');
  const ls = await api.module.linked(moduleId);
  document.querySelectorAll(`.module-page[data-module="${moduleId}"] .ph-link-n`).forEach((n) => { n.textContent = ls.length ? String(ls.length) : ''; });
}
