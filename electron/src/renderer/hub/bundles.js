'use strict';
// ═══ Genre bundles — Artisan as the one template system (v5 Part 7, §11.7) ═
// A bundle makes a whole project in one click: a folder named after it, the
// modules a genre needs inside, and a Manager giving the overview (§8.10).
// These four replace the legacy director / navigator / hero / writer recipes
// as the thing a new user starts from. ARTISAN_TARGETS (hub/kinds.js) is left
// alone because Legacy Import's MIGRATE_TARGETS is built from it.
//
// A bundle is DATA (db/bundle.js has the shape), built here with every name
// through t() — the rows become the user's own, in their language. Module
// shapes reuse the Classifier presets (hub/presets.js) where one fits, so a
// preset and a bundle cannot drift apart. "Adjust first" is the old step
// wizard folded into one form: tick modules, rename them, rename or drop
// fields — then the same single create call.

const bF = (key, type = 'text', extra = {}) => ({ name: t(key), type, ...extra });
const bStat = (nm) => ({ name: nm, type: 'number', levelable: true });
// A built-in Classifier preset's fields, translated (hub/presets.js).
const bPresetFields = (id) => presetSpec('classifier', `b:${id}`)?.fields || [];

const BUNDLES = [
  { id: 'fantasy', icon: 'sword', nameKey: 'bundleFantasy', descKey: 'bundleFantasyD',
    spec: () => ({ modules: [
      { ref: 'chars', kind: 'classifier', catType: 'character', name: t('worldChars'),
        fields: [bF('artFldRole'), bF('artFldAge'), bF('artFldPersonality', 'textarea'), bF('artFldGoal'), bF('pfWeapon', 'relation', { relTo: 'items' })] },
      { ref: 'items', kind: 'classifier', name: t('gameItems'), fields: [bF('artFldDescription', 'textarea'), bF('artFldOwner')] },
      { ref: 'places', kind: 'classifier', name: t('artLocations'), fields: [bF('artFldDescription', 'textarea'), bF('artFldHistory', 'textarea')] },
      { ref: 'factions', kind: 'classifier', name: t('artFactions'), fields: [bF('artFldDescription', 'textarea'), bF('artFldGoal')] },
      { ref: 'magic', kind: 'classifier', catType: 'element', name: t('artMagic'), fields: [bF('artFldRules', 'textarea'), bF('pfCost')] },
      { kind: 'locator', name: t('kcMap') },
      { kind: 'chronicler', name: t('artMainTimeline') },
      { kind: 'author', name: t('artBook'), chapters: [1, 2, 3].map(n => ({ name: `${t('artChapter')} ${n}` })) },
    ] }) },
  { id: 'ttrpg', icon: 'dice', nameKey: 'bundleTtrpg', descKey: 'bundleTtrpgD',
    spec: () => ({ modules: [
      { ref: 'npcs', kind: 'classifier', catType: 'character', name: t('bdNpcs'),
        fields: [bF('artFldRole'), bF('artFldPersonality', 'textarea'), bF('pfHome', 'relation', { relTo: 'places' })] },
      { ref: 'monsters', kind: 'classifier', name: t('artCreatures'),
        fields: [{ name: 'HP', type: 'number' }, { name: 'AC', type: 'number' }, { name: 'CR', type: 'number' }, bF('artFldDescription', 'textarea')] },
      { ref: 'places', kind: 'classifier', name: t('artLocations'), fields: [bF('artFldDescription', 'textarea')] },
      { kind: 'locator', name: t('kcMap') },
      { kind: 'diviner', name: t('bdEncounters'), tables: [
        { name: t('bdEncounters'), dice: '1d20', entries: [[1, 8], [9, 14], [15, 19], [20, 20]].map(([lo, hi]) => ({ lo, hi })) },
        { name: t('bdLoot'), entries: [{ weight: 5 }, { weight: 3 }, { weight: 1 }] },
      ] },
      { kind: 'scribe', name: t('bdSessions'), sessions: [{ name: `${t('bdSession')} 1`, messages: [] }] },
    ] }) },
  { id: 'rpg', icon: 'hero', nameKey: 'bundleRpg', descKey: 'bundleRpgD',
    spec: () => ({ modules: [
      { ref: 'chars', kind: 'classifier', catType: 'character', name: t('gameChars'),
        fields: [bStat('HP'), bStat('MP'), bStat('ATK'), bStat('DEF'), bF('artFldRole'), bF('artFldBackstory', 'textarea')] },
      { ref: 'skills', kind: 'classifier', catType: 'element', name: t('artSkills'), fields: bPresetFields('skills').map(f => (f.type === 'relation' ? { ...f, relTo: 'chars' } : f)) },
      { ref: 'items', kind: 'classifier', name: t('gameItems'), fields: [bF('artFldDescription', 'textarea'), bF('artFldEffect')] },
      { ref: 'quests', kind: 'classifier', catType: 'element', name: t('artQuests'),
        fields: bPresetFields('quests').map(f => (f.name === t('pfQuestGiver') ? { ...f, relTo: 'chars' } : f)) },
      { kind: 'narrator', name: t('artMainStory') },
      { kind: 'diviner', name: t('bdDrops'), tables: [{ name: t('bdDrops'), entries: [{ weight: 6 }, { weight: 3 }, { weight: 1 }] }] },
    ] }) },
  { id: 'mystery', icon: 'search', nameKey: 'bundleMystery', descKey: 'bundleMysteryD',
    spec: () => ({ modules: [
      { ref: 'chars', kind: 'classifier', catType: 'character', name: t('worldChars'), fields: [bF('artFldRole'), bF('artFldPersonality', 'textarea')] },
      { ref: 'clues', kind: 'classifier', name: t('artClues'),
        fields: [bF('artFldDescription', 'textarea'), bF('pfInChapter', 'relation', { options: { targetKinds: ['chapter'] } }), bF('pfPointsTo', 'relation', { relTo: 'suspects' })] },
      { ref: 'suspects', kind: 'classifier', catType: 'character', name: t('bdSuspects'), fields: [bF('artFldMotive'), bF('pfMeans'), bF('pfAlibi', 'textarea')] },
      { kind: 'author', name: t('artBook'), chapters: [1, 2, 3].map(n => ({ name: `${t('artChapter')} ${n}` })) },
      { kind: 'chronicler', name: t('artMainTimeline') },
      { kind: 'drafter', name: t('artIdeas') },
    ] }) },
];

function openBundlePicker(parentId = null) {
  closeAllPopups();
  const guideCard = `<div class="bundle-card bundle-guide">
      <div class="bundle-head"><span class="kicon">${I.info}</span><b>${t('guideBundle')}</b></div>
      <p class="drafter-hint">${t('guideBundleD')}</p>
      <div class="bundle-acts">${cmdBtn('app.createGuide', {}, { cls: 'btn-p btn-sm' })}</div>
    </div>`;
  openModal(t('bundleTitle'), `<div class="bundle-grid">${guideCard}${BUNDLES.map(b => {
    const mods = b.spec().modules;
    return `<div class="bundle-card">
      <div class="bundle-head"><span class="kicon">${I[b.icon] || I.folder}</span><b>${t(b.nameKey)}</b></div>
      <p class="drafter-hint">${t(b.descKey)}</p>
      <div class="bundle-mods">${mods.map(m => `<span class="bundle-mod">${I[KIND_ICON[m.kind]] || ''} ${x(m.name)}</span>`).join('')}</div>
      <div class="bundle-acts">
        <button class="btn btn-s btn-sm" onclick="openBundleAdjust('${b.id}',${parentId ?? 'null'})">${t('bundleAdjust')}</button>
        <button class="btn btn-p btn-sm" onclick="createBundleNow('${b.id}',${parentId ?? 'null'})">${t('bundleCreate')}</button>
      </div>
    </div>`;
  }).join('')}</div>`);
}

async function createBundleNow(id, parentId, spec = null) {
  const b = BUNDLES.find(bb => bb.id === id);
  if (!b || !S.nexus) return;
  const full = spec || { name: t(b.nameKey), icon: b.icon, ...b.spec() };
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
function openBundleAdjust(id, parentId) {
  const b = BUNDLES.find(bb => bb.id === id);
  if (!b) return;
  const mods = b.spec().modules;
  openModal(`${t(b.nameKey)} · ${t('bundleAdjust')}`, `
    <div class="fg"><label>${t('bundleProjectName')} *</label><input id="bd-name" value="${x(t(b.nameKey))}"></div>
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
  const b = BUNDLES.find(bb => bb.id === id);
  const name = q('#bd-name')?.value.trim();
  if (!b || !name) { toast(t('nameRequired'), 'err'); return; }
  const mods = b.spec().modules;
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
