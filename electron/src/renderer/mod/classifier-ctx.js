'use strict';
// ═══ Classifier — right-click, object CRUD, quick start (v5 Part 3) ═════
// APP docs/V5.md §7.4 "right-click everywhere", on the menu engine in
// hub/ctxmenu.js. Three surfaces:
//   classifier.object    list row · table row · grid card · graph node ·
//                        detail heading → open · rename · colour/icon ·
//                        duplicate · link · move · delete
//   classifier.category  empty list / grid / toolbar area → add object ·
//                        fields · colour/icon · delete
//   classifier.level     a level row → insert above/below · duplicate · delete

const clsObjectById = (id) => S.classifierData?.objects.find(o => o.id === id)
  || (S.activeItemNode?.itemKind === 'classifier' && S.activeItemNode.id === id ? { id, name: S.activeItemNode.item?.name } : null);

CTX_PROVIDERS['classifier.object'] = ({ moduleId, objectId }) => {
  const others = flattenModuleTree(S.moduleTree, 0).filter(({ m }) => m.kind === 'classifier' && m.id !== moduleId);
  return [
    { label: t('open'), icon: 'eye', onClick: () => openItemNode('classifier', moduleId, objectId) },
    { sep: true },
    { label: t('rename'), icon: 'edit', onClick: () => openClassifierObjectModal(moduleId, objectId) },
    { label: t('clsColorIcon'), icon: 'colors', onClick: () => openClassifierObjectModal(moduleId, objectId) },
    { label: t('duplicate'), icon: 'copy', onClick: () => duplicateClassifierObject(objectId) },
    { label: t('openInExhibitor'), icon: 'relation', onClick: () => openExhibitorFor(moduleId, `cobj_${objectId}`) },
    {
      label: t('moveTo'), icon: 'move', disabled: !others.length,
      sub: () => others.map(({ m, depth }) => ({ label: `${'  '.repeat(depth)}${m.name}`, onClick: () => moveClassifierObject(objectId, m.id) })),
    },
    { sep: true },
    { label: t('delete'), icon: 'delete', danger: true, onClick: () => deleteClassifierObjectRow(objectId) },
  ];
};

CTX_PROVIDERS['classifier.category'] = ({ moduleId }) => [
  { label: t('addObject'), icon: 'plus', onClick: () => openClassifierObjectModal(moduleId) },
  { label: t('clsFieldsOfCategory'), icon: 'edit', onClick: () => openClassifierFieldsModal(moduleId) },
  { label: t('clsColorIcon'), icon: 'colors', onClick: () => openModuleIconPopup(moduleId, ctxAnchor()) },
  { sep: true },
  { label: t('delete'), icon: 'delete', danger: true, onClick: () => deleteModuleNode(moduleId) },
];

CTX_PROVIDERS['classifier.level'] = ({ objectId, templateId, levelId }) => [
  { label: t('clsInsertAbove'), onClick: () => insertClassifierLevel(objectId, templateId, levelId, 'before') },
  { label: t('clsInsertBelow'), onClick: () => insertClassifierLevel(objectId, templateId, levelId, 'after') },
  { label: t('duplicate'), icon: 'copy', onClick: () => insertClassifierLevel(objectId, templateId, levelId, 'after', levelId) },
  { sep: true },
  { label: t('delete'), icon: 'delete', danger: true, onClick: () => deleteClassifierLevelRow(levelId) },
];

// ── Quick start (§7.4) ──────────────────────────────────────────────────
// An empty category to "1 object, 1 field, ready to type into" in one
// click — what used to be ~10 clicks, 4 typed names and two modals.
async function classifierQuickStart(moduleId) {
  const oid = await api.classifier.createObject(moduleId, t('clsFirstObjectName'), null, null);
  const templates = await api.classifier.getTemplates(moduleId);
  if (!templates.length) await api.classifier.createTemplate(moduleId, t('clsFirstFieldName'), 'text', false, false, null);
  S.classifierSelectedObject = oid;
  await api.module.setUi(moduleId, 'activeView', 'listDetail');
  await loadClassifierData(S.activeModuleNode);
  invalidateNestItems(moduleId, 1);
  toast(t('created'), 'ok');
}

// ── Object CRUD ─────────────────────────────────────────────────────────
async function openClassifierObjectModal(moduleId, objectId) {
  const m = findModuleNode(moduleId) || S.activeModuleNode;
  const o = objectId ? S.classifierData?.objects.find(x2 => x2.id === objectId) : null;
  openModal(o ? t('moduleEdit') : t('addObject'), `
    <div class="fg"><label>${t('name')} *</label><input id="co-name" value="${x(o?.name || '')}"
      onkeydown="if(event.key==='Enter'){event.preventDefault();submitClassifierObjectForm(${moduleId},${o ? o.id : 'null'})}"></div>
    <div class="fg"><label>${t('iconCollection')}</label>${await iconPicker(o?.icon || null, o?.color || null, o?.name || '', m?.cat_type === 'character' ? t('catTypeCharacter') : t('catTypeObject'))}</div>
    <div class="mfoot">
      ${o ? `<button class="btn btn-d" onclick="deleteClassifierObjectRow(${o.id})">${t('delete')}</button>` : ''}
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitClassifierObjectForm(${moduleId},${o ? o.id : 'null'})">${o ? t('save') : t('create')}</button>
    </div>`);
  setTimeout(() => q('#co-name').focus(), 60);
}

async function submitClassifierObjectForm(moduleId, objectId) {
  const name = q('#co-name').value.trim();
  // §7.5 bug #8: an empty name used to do nothing at all.
  if (!name) { toast(t('nameRequired'), 'err'); q('#co-name')?.focus(); return; }
  const colorId = q('#sel-color').value || null;
  const icon = typeof getIconPickerValue === 'function' ? getIconPickerValue() : null;
  if (objectId) await api.classifier.updateObject(objectId, name, colorId, icon);
  else S.classifierSelectedObject = await api.classifier.createObject(moduleId, name, colorId, icon);
  closeModal();
  if (S.activeModuleNode?.id === moduleId) await loadClassifierData(S.activeModuleNode);
  // No renderNexusHome() here — invalidateNestItems schedules a coalesced
  // one (Plan part2 #2.5), so this path repaints once instead of twice.
  invalidateNestItems(moduleId, objectId ? 0 : 1);
  toast(objectId ? t('saved') : t('created'), 'ok');
}

async function deleteClassifierObjectRow(objectId) {
  // §7.5 bug #4: this said "Delete this module?".
  if (!await uiConfirm(t('confirmDeleteObject'))) return;
  const moduleId = S.classifierData?.moduleId ?? S.activeItemNode?.moduleId ?? S.activeModuleNode?.id;
  await api.classifier.deleteObject(objectId);
  closeModal();
  if (S.classifierSelectedObject === objectId) S.classifierSelectedObject = null;
  if (S.activeItemNode?.itemKind === 'classifier' && S.activeItemNode.id === objectId && moduleId != null) {
    await openModuleNode(moduleId);
  } else if (S.activeModuleNode?.kind === 'classifier') {
    await loadClassifierData(S.activeModuleNode);
  }
  if (moduleId != null) invalidateNestItems(moduleId, -1);
  else renderNexusHome();
  toast(t('deleted'), 'ok');
}

async function duplicateClassifierObject(objectId) {
  const src = clsObjectById(objectId);
  const nid = await api.classifier.duplicateObject(objectId, src ? `${src.name} ${t('clsCopySuffix')}` : null);
  const moduleId = S.classifierData?.moduleId ?? S.activeItemNode?.moduleId;
  if (nid) S.classifierSelectedObject = nid;
  await refreshClassifier();
  if (moduleId != null) invalidateNestItems(moduleId, 1);
  toast(t('created'), 'ok');
}

async function moveClassifierObject(objectId, targetModuleId) {
  const from = S.classifierData?.moduleId ?? S.activeItemNode?.moduleId;
  const ok = await api.classifier.moveObject(objectId, targetModuleId);
  if (!ok) return;
  if (S.classifierSelectedObject === objectId) S.classifierSelectedObject = null;
  if (S.activeItemNode?.itemKind === 'classifier' && S.activeItemNode.id === objectId) {
    await openItemNode('classifier', targetModuleId, objectId);
  } else {
    await refreshClassifier();
  }
  if (from != null) invalidateNestItems(from, -1);
  invalidateNestItems(targetModuleId, 1);
  toast(t('saved'), 'ok');
}
