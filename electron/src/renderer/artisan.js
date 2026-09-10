'use strict';
// Artisan (v3) — create-from-template wizard mechanics only (Plan part2 #1:
// the standalone Artisan page/nav-rail entry point was removed; this file's
// old page shell — target picker, migrate-list — was deleted or relocated
// into the Nexus Nest Hub's own "+" popup and "Legacy Import" section, see
// src/renderer/hub.js). What's left here is exactly "the old module's
// structure kept as a template for Nexus Nest": artisanV3Spec describes
// each of the 4 legacy-fixed-module recipes as a Manager + pre-configured
// Minors, and startArtisanWizard walks the user through building one, one
// module at a time, via the same generic module:create/classifier:
// createTemplate/author:createChapter/module:updateDescription IPC any
// other module-creation path already uses. Lazy-loaded on demand from
// hub.js's buildKindListHtml ("Start from template" row) — ARTISAN_TARGETS
// itself lives in hub.js now, so it's available without a lazy-load there.

// ═══ v3 STRUCTURE TEMPLATES (Phase 23) ═════════════════════════════════
// The four legacy fixed modules as built-in Nexus-nest templates: each
// describes a Manager (Main module) + pre-filled child modules, walked step-by-step by
// the create wizard below (startArtisanWizard). Names run through t() at
// call time — the rows become user data in the current language.
function artisanV3Spec(target, name, colorId) {
  const f = (key, type, levelable) => ({ name: t(key), type: type || 'text', levelable: !!levelable });
  const stat = (nm) => ({ name: nm, type: 'number', levelable: true });
  const minors = [];
  if (target === 'director') {
    minors.push(
      { kind: 'classifier', catType: 'character', name: t('worldChars'),
        templates: [f('artFldRole'), f('artFldAge'), f('artFldPersonality', 'textarea'), f('artFldGoal')] },
      { kind: 'classifier', name: t('artLocations'), templates: [f('artFldDescription', 'textarea'), f('artFldHistory', 'textarea')] },
      { kind: 'classifier', name: t('gameItems'), templates: [f('artFldDescription', 'textarea'), f('artFldOwner')] },
      { kind: 'chronicler', name: t('artMainTimeline') },
      { kind: 'drafter', name: t('artFldPremise') },
    );
  } else if (target === 'navigator') {
    minors.push(
      { kind: 'classifier', catType: 'character', name: t('worldChars'),
        templates: [f('artFldRole'), f('artFldAge'), f('artFldPersonality', 'textarea'), f('artFldGoal')] },
      { kind: 'classifier', name: t('artLocations'), templates: [f('artFldDescription', 'textarea'), f('artFldHistory', 'textarea')] },
      { kind: 'classifier', name: t('artFactions'), templates: [f('artFldDescription', 'textarea'), f('artFldGoal')] },
      { kind: 'locator', name: t('kcMap') },
      { kind: 'chronicler', name: t('kcTimeline') },
      { kind: 'drafter', name: t('worldOverview') },
    );
  } else if (target === 'hero') {
    minors.push(
      { kind: 'classifier', catType: 'character', name: t('gameChars'),
        templates: [stat('HP'), stat('MP'), stat('ATK'), stat('DEF'), f('artFldRole'), f('artFldBackstory', 'textarea')] },
      { kind: 'classifier', name: t('gameItems'), templates: [f('artFldDescription', 'textarea'), f('artFldEffect')] },
      { kind: 'narrator', name: t('artMainStory') },
    );
  } else if (target === 'writer') {
    minors.push(
      { kind: 'author', name: t('artBook'), chapters: [1, 2, 3].map(n => `${t('artChapter')} ${n}`) },
      { kind: 'drafter', name: t('artIdeas') },
    );
  }
  return { name, colorId: colorId || null, minors };
}

// ═══ CREATE WIZARD ════════════════════════════════════
// Manager step, then one step per Minor (artisanV3Spec) — each step commits
// its own module row immediately via api.module.create so the user can
// name/re-icon every piece before it's created, instead of the old one-shot
// name+color modal that built the whole tree in a single call.
function startArtisanWizard(target) {
  const spec = artisanV3Spec(target, '');
  S.artisanWizard = { target, spec, idx: -1, managerId: null };
  renderArtisanWizardStep();
}

async function renderArtisanWizardStep() {
  const w = S.artisanWizard;
  if (!w) return;
  const tg = ARTISAN_TARGETS.find(a => a.id === w.target);
  if (w.idx === -1) {
    openModal(`${t(tg.labelKey)} — ${t('artV3Card')} · 1 / ${w.spec.minors.length + 1}`, `
      <div class="fg"><label>${t('name')} *</label><input id="art-wiz-name"></div>
      <div class="fg"><label>${t('iconCollection')}</label>${await iconPicker(null, null, '', kindLabel('manager'))}</div>
      <div class="mfoot">
        <button class="btn btn-s" onclick="closeArtisanWizard()">${t('cancel')}</button>
        <button class="btn btn-p" onclick="submitArtisanWizardStep()">${t('guideNext')}</button>
      </div>`);
  } else {
    const i = w.idx;
    const mn = w.spec.minors[i];
    openModal(`${i + 2} / ${w.spec.minors.length + 1} — ${x(mn.name)}`, `
      <div class="fg"><label>${t('name')} *</label><input id="art-wiz-name" value="${x(mn.name || '')}"></div>
      <div class="fg"><label>${t('iconCollection')}</label>${await iconPicker(null, null, mn.name || '', kindLabel(mn.kind))}</div>
      <div class="mfoot">
        <button class="btn btn-s" onclick="closeArtisanWizard()">${t('cancel')}</button>
        <button class="btn btn-p" onclick="submitArtisanWizardStep()">${i === w.spec.minors.length - 1 ? t('guideDone') : t('guideNext')}</button>
      </div>`);
  }
  setTimeout(() => q('#art-wiz-name').focus(), 60);
}

async function submitArtisanWizardStep() {
  const w = S.artisanWizard;
  if (!w) return;
  if (!S.nexus) { toast(t('nexusSelectFirst'), 'error'); return; }
  const name = q('#art-wiz-name').value.trim();
  if (!name) return;
  const icon = getIconPickerValue() || null;
  const color = q('#sel-color')?.value || null;
  if (w.idx === -1) {
    w.managerId = await api.module.create({ nexus_ref: S.nexus.id, parent_id: null, name, kind: 'manager', color, icon_color: color, icon });
    if (!w.spec.minors.length) { await finishArtisanWizard(); return; }
    w.idx = 0;
    await renderArtisanWizardStep();
  } else {
    const i = w.idx;
    const mn = w.spec.minors[i];
    const minorId = await api.module.create({
      nexus_ref: S.nexus.id, parent_id: w.managerId, name, kind: mn.kind,
      color, icon_color: color, icon,
      cat_type: mn.kind === 'classifier' ? (mn.catType || 'object') : null,
    });
    if (mn.kind === 'classifier') {
      for (const tf of (mn.templates || [])) {
        await api.classifier.createTemplate(minorId, tf.name, tf.type || 'text', !!tf.levelable, false, null);
      }
    }
    if (mn.kind === 'author') {
      for (const ch of (mn.chapters || [])) await api.author.createChapter(minorId, ch);
    }
    if (mn.kind === 'drafter' && mn.content) await api.module.updateDescription(minorId, mn.content);
    if (i === w.spec.minors.length - 1) {
      await finishArtisanWizard();
    } else {
      w.idx = i + 1;
      await renderArtisanWizardStep();
    }
  }
}

function closeArtisanWizard() {
  S.artisanWizard = null;
  closeModal();
}

async function finishArtisanWizard() {
  const managerId = S.artisanWizard.managerId;
  S.artisanWizard = null;
  closeModal();
  toast(t('artisanCreated'), 'ok');
  await returnToNexus();
  await reloadModuleTree();
  await openModuleNode(managerId);
}

