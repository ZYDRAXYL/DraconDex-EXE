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

async function openBundlePicker(parentId = null) {
  closeAllPopups();
  const bundles = await bundleCatalog();
  const guideCard = `<div class="bundle-card bundle-guide">
      <div class="bundle-head"><span class="kicon">${I.info}</span><b>${t('guideBundle')}</b></div>
      <p class="drafter-hint">${t('guideBundleD')}</p>
      <div class="bundle-acts">${cmdBtn('app.createGuide', {}, { cls: 'btn-p btn-sm' })}</div>
    </div>`;
  openModal(t('bundleTitle'), `<div class="bundle-grid">${guideCard}${bundles.map(b => {
    const mods = b.spec.modules;
    return `<div class="bundle-card">
      <div class="bundle-head"><span class="kicon">${I[b.icon] || I.folder}</span><b>${x(b.name)}</b></div>
      <p class="drafter-hint">${x(b.description)}</p>
      <div class="bundle-mods">${mods.map(m => `<span class="bundle-mod">${I[KIND_ICON[m.kind]] || ''} ${x(m.name)}</span>`).join('')}</div>
      <div class="bundle-acts">
        <button class="btn btn-s btn-sm" onclick="openBundleAdjust('${b.id}',${parentId ?? 'null'})">${t('bundleAdjust')}</button>
        <button class="btn btn-p btn-sm" onclick="createBundleNow('${b.id}',${parentId ?? 'null'})">${t('bundleCreate')}</button>
      </div>
    </div>`;
  }).join('')}</div>`);
}

async function createBundleNow(id, parentId, spec = null) {
  const b = await bundleById(id);
  if (!b || !S.nexus) return;
  const full = spec || { name: b.name, icon: b.icon, ...b.spec };
  const r = await api.bundle.create(S.nexus.id, parentId, full);
  if (!r?.ok) { toast(t(r?.code === 'name_required' ? 'nameRequired' : 'driveErrServer'), 'err'); return; }
  closeModal();
  await reloadModuleTree();
  await openModuleNode(r.managerId || r.folderId);
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
  const b = await bundleById(id);
  if (!b) return;
  const mods = b.spec.modules;
  openModal(`${x(b.name)} · ${t('bundleAdjust')}`, `
    <div class="fg"><label>${t('bundleProjectName')} *</label><input id="bd-name" value="${x(b.name)}"></div>
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

async function submitBundleAdjust(id, parentId) {
  const b = await bundleById(id);
  const name = q('#bd-name')?.value.trim();
  if (!b || !name) { toast(t('nameRequired'), 'err'); return; }
  const mods = b.spec.modules;
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
  // A relation field into a module the user left out has nothing to point at.
  for (const m of out) if (m.fields) m.fields = m.fields.map(f => (f.relTo && !kept.has(f.relTo) ? { ...f, relTo: undefined } : f));
  await createBundleNow(id, parentId, { name, icon: b.icon, modules: out });
}
