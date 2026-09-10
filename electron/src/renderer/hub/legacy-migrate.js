'use strict';
// Plan process2 part2: legacy Director/Navigator/Hero/Writer/Scribe data
// converts into real Nexus Nest modules (src/db/migrate_v3.js) instead of
// staying in the old legacy tables forever. This file owns the whole new
// flow: a one-time boot-time detection + choice prompt (export the vault as
// a standalone .ddx vs auto-convert now), and a comparison-list preview
// shown before the actual conversion runs — reused by both the boot-detected
// path here and the pre-existing post-merge-import path
// (chooseImportAsNexusNest, hub/sections.js — called directly from
// core/views.js's importDatabaseFile() when a merge brings in legacy-shaped
// data, now that the old two-card import-choice modal is gone).

// ═══ Boot-time detection ══════════════════════════════════════════════════
// Fired once per (vault, app version) — mirrors update.js's initVersionCheck
// in shape and in its boot.js call site. Only the "seen" gate is per-vault
// (migrate:getPromptSeen/setPromptSeen, src/db/migrate_v3.js) since a fresh
// vault opened later could still have its own un-migrated legacy data.
async function initLegacyDataCheck() {
  if (S.isPopup || !S.nexus) return;
  let seen;
  try { seen = await api.migrate.getPromptSeen(S.nexus.id); } catch (_) { return; }
  if (seen) return;
  let hasLegacy = false;
  for (const tg of MIGRATE_TARGETS) {
    try { if ((await api.migrate.list(tg.id, S.nexus.id)).length) { hasLegacy = true; break; } }
    catch (_) { /* keep checking the other targets */ }
  }
  try { await api.migrate.setPromptSeen(S.nexus.id); } catch (_) {}
  if (hasLegacy) openLegacyMigrateChoiceModal();
}

// ═══ Choice modal: export vs auto-convert ═════════════════════════════════
// Same "decide between two paths" 2-card pattern as openImportChoiceModal
// (hub/sections.js) — .typegrid/.typecard, css/inspector.css.
function openLegacyMigrateChoiceModal() {
  openModal(t('legacyPromptTitle'), `
    <p class="drafter-hint">${t('legacyPromptBody')}</p>
    <div class="typegrid" style="grid-template-columns:1fr 1fr">
      <div class="typecard" onclick="legacyPromptExportClick(this)">
        <h5>${I.export} ${t('legacyPromptExportOption')}</h5><p>${t('legacyPromptExportDesc')}</p>
      </div>
      <div class="typecard" onclick="legacyPromptConvertClick(this)">
        <h5>${I.layer} ${t('legacyPromptConvertOption')}</h5><p>${t('legacyPromptConvertDesc')}</p>
      </div>
    </div>`);
}
async function legacyPromptExportClick(cardEl) {
  if (cardEl) cardEl.style.pointerEvents = 'none';
  if (S.nexus?.id && typeof nexusExportFile === 'function') await nexusExportFile(S.nexus.id);
  closeModal();
}
function legacyPromptConvertClick() {
  openLegacyMigratePreviewModal();
}

// ═══ Comparison-list preview ═══════════════════════════════════════════════
// api.migrate.preview() (src/db/migrate_v3.js's previewLegacyMigration) does
// the read-only lookup; this just renders it grouped by target, one
// .li-head per target (Director/Navigator/.../Scribe) with .li rows
// underneath — same skeleton the old, now-orphaned Hub "Legacy Import"
// section used (css/layout.css's .legacy-target-group/.li-head).
async function openLegacyMigratePreviewModal() {
  openModal(t('legacyPreviewTitle'), `<div id="legacy-preview-body">${t('syncWorking')}</div>`);
  const nexusId = S.nexus?.id || S.nexuses?.[0]?.id;
  if (!nexusId) { closeModal(); return; }
  let rows;
  try { rows = await api.migrate.preview(nexusId); } catch (_) { rows = null; }
  const el = q('#legacy-preview-body');
  if (!el) return; // modal closed while this was in flight
  el.innerHTML = legacyPreviewBodyHtml(rows);
}
function legacyPreviewBodyHtml(rows) {
  if (!rows || !rows.length) {
    return `<div class="modal-hint">${I.info}<span>${t('legacyPreviewEmpty')}</span></div>
      <div class="mfoot"><button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button></div>`;
  }
  const groups = {};
  for (const r of rows) (groups[r.target] ||= []).push(r);
  const sections = MIGRATE_TARGETS.filter(tg => groups[tg.id]?.length).map(tg => `
    <div class="legacy-target-group">
      <div class="li-head">${I[tg.icon]} ${t(tg.labelKey)}</div>
      ${groups[tg.id].map(legacyPreviewRowHtml).join('')}
    </div>`).join('');
  return `${sections}
    <div class="mfoot">
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="legacyPreviewConfirmClick(this)">${t('legacyPreviewConfirm')}</button>
    </div>`;
}
function legacyPreviewRowHtml(r) {
  const tag = r.willMergeInto ? t('legacyPreviewMerge') : t('legacyPreviewNew');
  const becomes = r.willMergeInto || r.legacyName;
  return `<div class="li" style="cursor:default">
    <span class="name" data-no-i18n>${x(r.legacyName)}${r.summary ? ` <span class="sync-hint">— ${x(r.summary)}</span>` : ''}</span>
    <span class="sync-hint" data-no-i18n>→ ${x(becomes)}</span>
    <span class="cnt" data-no-i18n>${tag}</span>
  </div>`;
}
async function legacyPreviewConfirmClick(btnEl) {
  if (btnEl) btnEl.style.pointerEvents = 'none';
  await runLegacyMigration();
}

// ═══ The actual conversion run ═════════════════════════════════════════════
// Factored out of the old chooseImportAsNexusNest (hub/sections.js), which
// now just opens the preview modal above instead of running immediately —
// this is the "reused by the app's import db system" sub-bullet: the same
// preview-then-run step now sits in front of both entry points.
async function runLegacyMigration() {
  const nexusId = S.nexus?.id || S.nexuses?.[0]?.id;
  if (!nexusId) { toast(t('nexusSelectFirst'), 'error'); return; }
  const totals = { modules: 0, objects: 0, events: 0, chapters: 0, dialogues: 0, relations: 0 };
  let firstOpenedId = null;
  let batchCtx = {};
  // Unbounded N×M migration — pointer-events:none alone left the modal
  // looking frozen for the whole run.
  setBusy('#modal-body', true);
  try {
    for (const tg of MIGRATE_TARGETS) {
      const rows = await api.migrate.list(tg.id, nexusId);
      for (const row of rows) {
        const res = await api.migrate.run(nexusId, tg.id, row.id, batchCtx);
        batchCtx = res.batchCtx || batchCtx;
        const c = res.counts || {};
        for (const k of Object.keys(totals)) totals[k] += c[k] || 0;
        if (!firstOpenedId && res.id) firstOpenedId = res.id;
      }
    }
  } finally {
    setBusy('#modal-body', false);
  }
  closeModal();
  toast(`${t('artMigrateDone')} — ${totals.modules} modules · ${totals.objects} objects · ${totals.events} events · ${totals.chapters} chapters · ${totals.dialogues} dialogues · ${totals.relations} relations`, 'ok');
  if (S.nexus?.id === nexusId) {
    await reloadModuleTree();
    if (firstOpenedId) await openModuleNode(firstOpenedId);
  }
}
