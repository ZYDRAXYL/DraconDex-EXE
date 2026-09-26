'use strict';
// ═══ Genre bundles — Artisan as the one template system (v5 Part 7, §11.7) ═
// A bundle makes a whole project in one click: a folder named after it, the
// modules a genre needs inside, and a Manager giving the overview (§8.10).
// These four replace the legacy director / navigator / hero / writer recipes
// as the thing a new user starts from. ARTISAN_TARGETS (hub/kinds.js) is left
// alone because Legacy Import's MIGRATE_TARGETS is built from it.
//
// A bundle is DATA (db/bundle.js has the shape). Since Procress 12 part 0
// the four live in DraconDex-SDB (templates/), vendored to
// electron/templates/bundles.json — the phone makes the same projects from
// the same file. The main side resolves every name in the UI language
// (db/bundle-catalog.js), so the rows become the user's own, in their
// language. "Adjust first" is the old step wizard folded into one form: tick
// modules, rename them, rename or drop fields — then the same single create
// call.

// [{ id, icon, name, description, spec }] in the UI language, fetched once
// per language.
let _bundleCat = null;
async function bundleCatalog() {
  const loc = S.settings?.language || 'en';
  if (!_bundleCat || _bundleCat.loc !== loc) _bundleCat = { loc, list: (await api.bundle.catalog(loc)) || [] };
  return _bundleCat.list;
}
const bundleById = async (id) => (await bundleCatalog()).find((b) => b.id === id) || null;

// The user's own bundles ("Save as Artisan bundle…" on a folder — db/
// bundle-capture.js), as catalog entries with a `u:` id.
async function mineBundles() {
  if (!S.nexus) return [];
  const rows = (await api.bundle.listMine(S.nexus.id)) || [];
  S._mineBundles = rows.map((r) => ({ id: `u:${r.id}`, group: 'mine', icon: r.spec.icon || 'folder', name: r.name, description: '', spec: r.spec }));
  return S._mineBundles;
}
const bundleOrMine = async (id) => (String(id).startsWith('u:') ? (S._mineBundles || []).find((b) => b.id === id) : bundleById(id)) || null;

// Procress 14 (TEMPLATES.md §4, mockup 08-artisan.html): three shelves —
// the four Classic projects (the old Director/Navigator/Hero/Writer), the
// genres, and the user's own. The shelf is a per-viewer convenience.
const BUNDLE_TABS = ['classic', 'genre', 'mine'];
async function openBundlePicker(parentId = null, tab = null) {
  closeAllPopups();
  let cur = tab;
  if (!cur) { try { cur = localStorage.getItem('ddx.bundleTab'); } catch (_) {} }
  if (!BUNDLE_TABS.includes(cur)) cur = 'genre';
  try { localStorage.setItem('ddx.bundleTab', cur); } catch (_) {}
  const all = cur === 'mine' ? await mineBundles() : (await bundleCatalog()).filter((b) => (b.group || 'genre') === cur);
  const pid = parentId ?? 'null';
  const tabs = viewBarHtml(BUNDLE_TABS, cur, (v) => `openBundlePicker(${pid},'${v}')`,
    (v) => t({ classic: 'bundleTabClassic', genre: 'bundleTabGenre', mine: 'bundleTabMine' }[v]));
  const guideCard = cur !== 'genre' ? '' : `<div class="bundle-card bundle-guide">
      <div class="bundle-head"><span class="kicon">${I.info}</span><b>${t('guideBundle')}</b></div>
      <p class="drafter-hint">${t('guideBundleD')}</p>
      <div class="bundle-acts">${cmdBtn('app.createGuide', {}, { cls: 'btn-p btn-sm' })}</div>
    </div>`;
  const cards = all.map((b) => {
    const mods = b.spec.modules || [];
    const samples = mods.reduce((n, m) => n + ['objects', 'events', 'chapters', 'dialogues', 'sessions']
      .reduce((k, c) => k + (m.samples ? (m[c] || []).length : (m[c] || []).filter((o) => o?.sample).length), 0), 0);
    return `<div class="bundle-card">
      <div class="bundle-head"><span class="kicon">${I[b.icon] || I.folder}</span><b>${x(b.name)}</b></div>
      ${b.description ? `<p class="drafter-hint">${x(b.description)}</p>` : ''}
      <div class="bundle-mods">${mods.map((m) => `<span class="bundle-mod">${I[KIND_ICON[m.kind]] || ''} ${x(m.name)}</span>`).join('')}</div>
      ${samples ? `<div class="bundle-samples">${t('bundleSampleCount')} · ${samples}</div>` : ''}
      <div class="bundle-acts">
        <button class="btn btn-s btn-sm" onclick="openBundleAdjust('${b.id}',${pid})">${t('bundleAdjust')}</button>
        <button class="btn btn-p btn-sm" onclick="createBundleNow('${b.id}',${pid})">${t('bundleCreate')}</button>
      </div>
    </div>`;
  }).join('');
  const empty = cur === 'mine' && !all.length ? `<div class="empty"><p>${t('bundleMineEmpty')}</p></div>` : '';
  openModal(t('bundleTitle'), `<div class="bundle-tabs">${tabs}</div><div class="bundle-grid">${guideCard}${cards}</div>${empty}`);
}

async function createBundleNow(id, parentId, spec = null) {
  const b = await bundleOrMine(id);
  if (!b || !S.nexus) return;
  const full = spec || { ...b.spec, name: b.name, icon: b.icon };
  const r = await api.bundle.create(S.nexus.id, parentId, full);
  if (!r?.ok) { toast(t(r?.code === 'name_required' ? 'nameRequired' : 'driveErrServer'), 'err'); return; }
  closeModal();
  await reloadModuleTree();
  await openModuleNode(r.homeId || r.managerId || r.folderId);
  toast(`${t('bundleCreated')} · ${r.modules}`, 'ok');
}

// ── The in-app guide (§11.8) ────────────────────────────────────────────
// Made in the open Nexus, at the top level, in the UI language — or in
// English when this language has no guide yet, saying where to get one.
// Never rewritten afterwards: making it again makes a second folder.
async function createGuideBundle({ quiet = false } = {}) {
  if (!S.nexus) return null;
  const g = await api.bundle.guide(S.settings?.language || 'en');
  if (!g?.ok) { if (!quiet) toast(t('driveErrServer'), 'err'); return null; }
  const r = await api.bundle.create(S.nexus.id, null, g.spec);
  if (!r?.ok) { if (!quiet) toast(t('driveErrServer'), 'err'); return null; }
  closeModal();
  await reloadModuleTree();
  if (!quiet) {
    const start = (findModuleNode(r.folderId)?.children || []).find(m => m.kind === 'drafter');
    await openModuleNode(start?.id || r.folderId);
  }
  toast(g.fallback ? t('guideFallback') : t('guideCreated'), g.fallback ? 'warn' : 'ok');
  return r;
}

// ── Adjust first ────────────────────────────────────────────────────────
async function openBundleAdjust(id, parentId) {
  const b = await bundleOrMine(id);
  if (!b) return;
  const mods = b.spec.modules || [];
  const hasSamples = mods.some((m) => m.samples || ['objects', 'events', 'chapters', 'dialogues', 'sessions'].some((c) => (m[c] || []).some((o) => o?.sample)));
  openModal(`${x(b.name)} · ${t('bundleAdjust')}`, `
    <div class="fg"><label>${t('bundleProjectName')} *</label><input id="bd-name" value="${x(b.name)}"></div>
    ${hasSamples ? `<label class="bundle-adj-samples"><input type="checkbox" id="bd-samples" checked> ${t('bundleIncludeSamples')}</label>` : ''}
    <div class="fg"><label>${t('bundleIncludes')}</label>
      ${mods.map((m, i) => `<div class="bundle-adj-row">
        <label class="bundle-adj-mod"><input type="checkbox" data-bd-on="${i}" checked> ${I[KIND_ICON[m.kind]] || ''}</label>
        <input data-bd-name="${i}" value="${x(m.name)}">
        ${m.fields?.length ? `<details class="bundle-adj-fields"><summary>${t('bundleFields')} (${m.fields.length})</summary>
          ${m.fields.map((f, k) => `<input data-bd-field="${i}:${k}" value="${x(f.name)}">`).join('')}
        </details>` : ''}
      </div>`).join('')}
    </div>
    <div class="mfoot">
      <button class="btn btn-s" onclick="openBundlePicker(${parentId ?? 'null'})">${t('guideBack')}</button>
      <button class="btn btn-p" onclick="submitBundleAdjust('${id}',${parentId ?? 'null'})">${t('bundleCreate')}</button>
    </div>`);
}

// Blocks that borrow a module the user left out have nothing to show.
function keepBorrows(blocks, kept) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.filter((bl) => typeof bl?.borrow !== 'string' || kept.has(bl.borrow))
    .map((bl) => (Array.isArray(bl.children) ? { ...bl, children: bl.children.map((c) => keepBorrows(c, kept)) } : bl));
}

async function submitBundleAdjust(id, parentId) {
  const b = await bundleOrMine(id);
  const name = q('#bd-name')?.value.trim();
  if (!b || !name) { toast(t('nameRequired'), 'err'); return; }
  const mods = b.spec.modules || [];
  const kept = new Set();
  const out = [];
  mods.forEach((m, i) => {
    if (!q(`[data-bd-on="${i}"]`)?.checked) return;
    const nm = q(`[data-bd-name="${i}"]`)?.value.trim() || m.name;
    const fields = (m.fields || []).map((f, k) => ({ ...f, name: q(`[data-bd-field="${i}:${k}"]`)?.value.trim() ?? f.name }))
      .filter(f => f.name);
    if (m.ref) kept.add(m.ref);
    out.push({ ...m, name: nm, ...(m.fields ? { fields } : {}) });
  });
  const folderRefs = new Set((b.spec.folders || []).map((f) => f.ref));
  // Anything pointing at a module the user left out has nothing to point at:
  // a relation field, a selection, a Wanderer's map/time, a borrowed block.
  for (const m of out) {
    if (m.fields) m.fields = m.fields.map(f => (f.relTo && !kept.has(f.relTo) ? { ...f, relTo: undefined } : f));
    if (m.selects) m.selects = m.selects.filter((r) => kept.has(r) || folderRefs.has(r));
    if (m.uses) m.uses = m.uses.filter((r) => kept.has(r));
    if (Array.isArray(m.page)) m.page = keepBorrows(m.page, kept);
    if (Array.isArray(m.itemPage)) m.itemPage = keepBorrows(m.itemPage, kept);
  }
  const spec = { ...b.spec, name, icon: b.icon, modules: out };
  if (spec.home && !kept.has(spec.home)) delete spec.home;
  if (q('#bd-samples') && !q('#bd-samples').checked) spec.includeSamples = false;
  await createBundleNow(id, parentId, spec);
}

// ── Save as Artisan bundle (§4.4) ───────────────────────────────────────
function openSaveBundleModal(folderId) {
  const m = findModuleNode(folderId);
  if (!m) return;
  openModal(t('bundleSaveMine'), `
    <div class="fg"><label>${t('name')} *</label><input id="bds-name" value="${x(m.name)}"
      onkeydown="if(event.key==='Enter'){event.preventDefault();submitSaveBundle(${folderId})}"></div>
    <div class="fg"><label>${t('bundleSaveData')}</label>
      <select id="bds-data"><option value="none">${t('bundleDataNone')}</option><option value="samples">${t('bundleDataSamples')}</option></select></div>
    <div class="sync-hint">${t('bundleSaveHint')}</div>
    <div class="mfoot">
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitSaveBundle(${folderId})">${t('save')}</button>
    </div>`);
  setTimeout(() => { const el = q('#bds-name'); el?.focus(); el?.select(); }, 60);
}

async function submitSaveBundle(folderId) {
  const name = q('#bds-name')?.value.trim();
  if (!name) { toast(t('nameRequired'), 'err'); q('#bds-name')?.focus(); return; }
  let r;
  try { r = await api.bundle.saveMine(S.nexus.id, folderId, name, { data: q('#bds-data')?.value || 'none' }); }
  catch (_) { toast(t('driveErrServer'), 'err'); return; }
  closeModal();
  toast(`${t('bundleSaved')} · ${r?.modules ?? 0}`, 'ok');
}
