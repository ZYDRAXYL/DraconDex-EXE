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

const clsObjectById = (id) => clsFindObject(id)
  || (S.activeItemNode?.itemKind === 'classifier' && S.activeItemNode.id === id ? { id, name: S.activeItemNode.item?.name } : null);

// v5 Part 6: rows are commands (core/commands.js). The selected object is
// the palette's target for the object commands; a level row has none.
// Procress 24: a table column's head → that field (type · name · delete) —
// the Structure tab's ✎ / delete, one click from the table.
CTX_PROVIDERS['classifier.field'] = ({ moduleId, tplId }) => {
  const c = { moduleId, tplId };
  return [cmdItem('classifier.fieldType', c), cmdItem('classifier.fieldRename', c), { sep: true }, cmdItem('classifier.fieldDelete', c)];
};
function openClsFieldMenu(btn, moduleId, tplId) {
  ctxMenu(null, CTX_PROVIDERS['classifier.field']({ moduleId, tplId }), { anchor: btn });
}

CTX_PROVIDERS['classifier.object'] = ({ moduleId, objectId }) => {
  const c = { moduleId, objectId };
  return [
    cmdItem('classifier.openObject', c),
    { sep: true },
    cmdItem('classifier.renameObject', c),
    cmdItem('classifier.objectIcon', c),
    cmdItem('classifier.duplicateObject', c),
    cmdItem('classifier.objectExhibitor', c),
    cmdItem('classifier.moveObject', c),
    { sep: true },
    cmdItem('classifier.deleteObject', c),
  ];
};

CTX_PROVIDERS['classifier.category'] = ({ moduleId }) => [
  cmdItem('classifier.addObject', { moduleId }),
  cmdItem('classifier.fields', { moduleId }),
  cmdItem('module.icon', { moduleId }),
  { sep: true },
  cmdItem('module.delete', { moduleId }),
];

CTX_PROVIDERS['classifier.level'] = ({ objectId, templateId, levelId }) => {
  const c = { objectId, templateId, levelId };
  return [
    cmdItem('classifier.levelAbove', c),
    cmdItem('classifier.levelBelow', c),
    cmdItem('classifier.levelDuplicate', c),
    { sep: true },
    cmdItem('classifier.levelDelete', c),
  ];
};

// ── Quick start (§7.4) ──────────────────────────────────────────────────
// An empty category to "1 object, 1 field, ready to type into" in one
// click — what used to be ~10 clicks, 4 typed names and two modals.
async function classifierQuickStart(moduleId) {
  const templates = await api.classifier.getTemplates(moduleId);
  if (!templates.length) await api.classifier.createTemplate(moduleId, t('clsFirstFieldName'), 'text', false, false, null);
  await clsSeedFirstObject(moduleId);
  const m = findModuleNode(moduleId);
  if (m) await loadClassifierData(m);
  toast(t('created'), 'ok');
}

// One object, opened in the detail view on the next render — the quick start
// and a preset/template start (hub/presets.js shapeModule) both land here.
async function clsSeedFirstObject(moduleId) {
  S.clsPendingSelect = await api.classifier.createObject(moduleId, t('clsFirstObjectName'), null, null);
  await api.module.setUi(moduleId, 'activeView', 'listDetail');
  invalidateNestItems(moduleId, 1);
}

// ── Object CRUD ─────────────────────────────────────────────────────────
async function openClassifierObjectModal(moduleId, objectId) {
  const m = findModuleNode(moduleId) || S.activeModuleNode;
  const o = objectId ? clsFindObject(objectId) : null;
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
  else S.clsPendingSelect = await api.classifier.createObject(moduleId, name, colorId, icon);
  closeModal();
  const mod = findModuleNode(moduleId);
  if (mod && CLS[moduleId]) await loadClassifierData(mod);
  // No renderNexusHome() here — invalidateNestItems schedules a coalesced
  // one (Plan part2 #2.5), so this path repaints once instead of twice.
  invalidateNestItems(moduleId, objectId ? 0 : 1);
  toast(objectId ? t('saved') : t('created'), 'ok');
}

async function deleteClassifierObjectRow(objectId) {
  // Procress 17 I3: no "are you sure?" — deleted now, Undo in the toast (the
  // rows it takes, values and levels included, come back under the same ids).
  const moduleId = clsModuleOfObject(objectId) ?? S.activeItemNode?.moduleId ?? S.activeModuleNode?.id;
  const snap = await api.undoDelete.capture('object', objectId);
  await api.classifier.deleteObject(objectId);
  closeModal();
  if (S.classifierSelectedObject === objectId) S.classifierSelectedObject = null;
  if (S.activeItemNode?.itemKind === 'classifier' && S.activeItemNode.id === objectId && moduleId != null) {
    await openModuleNode(moduleId);
  } else if (moduleId != null && CLS[moduleId]) {
    await loadClassifierData(findModuleNode(moduleId));
  }
  if (moduleId != null) invalidateNestItems(moduleId, -1);
  else renderNexusHome();
  toastAction(t('deleted'), t('scUndo'), async () => {
    await api.undoDelete.restore(snap);
    if (moduleId != null) invalidateNestItems(moduleId, 1);
    await refreshClassifier();
  });
}

async function duplicateClassifierObject(objectId) {
  const src = clsObjectById(objectId);
  const nid = await api.classifier.duplicateObject(objectId, src ? `${src.name} ${t('clsCopySuffix')}` : null);
  const moduleId = clsModuleOfObject(objectId) ?? S.activeItemNode?.moduleId;
  if (nid) S.clsPendingSelect = nid;
  await refreshClassifier();
  if (moduleId != null) invalidateNestItems(moduleId, 1);
  toast(t('created'), 'ok');
}

async function moveClassifierObject(objectId, targetModuleId) {
  const from = clsModuleOfObject(objectId) ?? S.activeItemNode?.moduleId;
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

// ── Procress 26 part 3: add without a form, rename in place ─────────────
// [+ Add object] makes "Object N" at once and, in the table, puts its name in
// edit mode (✎ / F2 still open the form for the icon and colour). Esc on a
// name made a moment ago takes the object back, as a new module does
// (hub/edit.js cancelNewModule).
async function createClassifierObjectQuick(moduleId) {
  const m = findModuleNode(moduleId) || S.activeModuleNode;
  const base = t(m?.cat_type === 'character' ? 'catTypeCharacter' : 'catTypeObject');
  const objs = clsData(moduleId).objects;
  const names = new Set(objs.map((o) => o.name));
  let n = objs.length + 1;
  while (names.has(`${base} ${n}`)) n++;
  const id = await api.classifier.createObject(moduleId, `${base} ${n}`, null, null);
  S.clsPendingSelect = id;
  S.clsJustCreated = id;
  S.clsRenamingObject = id;
  S.clsRenameDraft = null;
  if (m) await loadClassifierData(m);
  invalidateNestItems(moduleId, 1);
  setTimeout(() => focusClsRename(id), 0); // after the render it queued
}

function startRenameClsObject(id) {
  S.clsRenamingObject = id;
  S.clsRenameDraft = null;
  renderNexusHome();
  focusClsRename(id);
}

// The input lands on the next render; a view with no name cell (grid, the
// detail list) never shows one, so stop waiting and drop the flag. After a
// re-render (S.clsRenameDraft) the text and the selection come back as they were.
function focusClsRename(id, tries = 0) {
  const el = q(`#rename-cobj-${id}`);
  if (el) {
    el.focus();
    if (S.clsRenameDraft?.id === id) {
      el.value = S.clsRenameDraft.value;
      el.setSelectionRange(...S.clsRenameDraft.sel);
    } else el.select();
    return;
  }
  if (tries < 20) { setTimeout(() => focusClsRename(id, tries + 1), 30); return; }
  if (S.clsRenamingObject === id) S.clsRenamingObject = null;
  if (S.clsJustCreated === id) S.clsJustCreated = null;
}

// Optimistic, like saveModuleRename: the new name shows at once and a failed
// save puts the old one back. A focused input that a re-render removes blurs
// too (the Nest reloads its items ~40 ms after an add), and Chromium fires
// that blur while it is still attached — so look one tick later: gone means a
// re-render, not the user leaving, and the rename carries on in the new input.
async function saveClsObjectRename(id, value, el = null) {
  if (S.clsRenamingObject !== id) return; // Esc already handled it
  if (el) {
    const sel = [el.selectionStart, el.selectionEnd];
    await new Promise((r) => setTimeout(r, 0));
    if (S.clsRenamingObject !== id) return;
    if (!el.isConnected) {
      S.clsRenameDraft = { id, value, sel };
      focusClsRename(id);
      return;
    }
  }
  S.clsRenamingObject = null;
  S.clsJustCreated = null;
  S.clsRenameDraft = null;
  const o = clsFindObject(id);
  const name = value.trim();
  if (!o || !name || name === o.name) { renderNexusHome(); return; }
  const old = o.name;
  o.name = name;
  renderNexusHome();
  try {
    await api.classifier.updateObject(id, name, o.color ?? null, o.icon ?? null);
  } catch (_) {
    o.name = old;
    renderNexusHome();
    toast(t('srSaveFailed'), 'err');
    return;
  }
  invalidateNestItems(o.module_ref, 0);
}

function clsRenameKey(ev, el, id) {
  if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); return; }
  if (ev.key !== 'Escape') return;
  ev.preventDefault();
  if (S.clsJustCreated === id) { discardNewClsObject(id); return; }
  el.value = clsFindObject(id)?.name ?? el.defaultValue;
  el.blur();
}

// Never used, so a real delete — no trash, no Undo toast.
async function discardNewClsObject(id) {
  const moduleId = clsModuleOfObject(id);
  S.clsRenamingObject = null;
  S.clsJustCreated = null;
  S.clsRenameDraft = null;
  await api.classifier.deleteObject(id);
  if (moduleId != null) {
    await loadClassifierData(findModuleNode(moduleId));
    invalidateNestItems(moduleId, -1);
  }
  renderNexusHome();
}

// ── Procress 26 part 3: drag to reorder objects and fields ──────────────
// Objects in every view (table row grip · detail-list row · grid card) and
// the shared fields by their column heads. The new order is computed from the
// cached list, not the DOM — lazyRows (core/lazy-rows.js) may not have
// rendered the rows a drag passes over. Alt+↑ / Alt+↓ move the object you
// are in by one.
// Procress 27 part 5: core/reorder.js does the dragging — the row (or
// column) follows the pointer on one axis and the others slide aside.
// `el` is the item: a table row / list row / grid card ('obj'), or a
// column head ('tpl', which carries its column's cells with it).
function clsDragDown(ev, el, kind, moduleId, id, axis = 'y') {
  const attr = kind === 'obj' ? 'clsOid' : 'clsTid';
  const table = el.closest('table');
  reorderDrag(ev, el, {
    axis,
    items: () => [...el.parentElement.children].filter((n) => n.dataset[attr] != null),
    linked: kind === 'tpl' ? (th) => [...table.querySelectorAll('tr[data-cls-oid]')].map((tr) => tr.cells[th.cellIndex]) : null,
    onDrop: ({ target, before }) => clsReorder(kind, moduleId, id, Number(target.dataset[attr]), before),
  });
}

// kind 'obj' → d.objects / moveObjects, 'tpl' → d.templates / moveTemplates.
async function clsReorder(kind, moduleId, id, targetId, before) {
  const d = clsData(moduleId);
  const list = kind === 'obj' ? d.objects : d.templates;
  const ids = list.map((r) => r.id).filter((x) => x !== id);
  const at = ids.indexOf(targetId);
  if (at < 0 || !list.some((r) => r.id === id)) return;
  ids.splice(before ? at : at + 1, 0, id);
  const pos = new Map(ids.map((x, i) => [x, i]));
  list.sort((a, b) => pos.get(a.id) - pos.get(b.id));
  renderNexusHome();
  if (kind === 'obj') {
    await api.classifier.moveObjects(moduleId, ids);
    invalidateNestItems(moduleId, 0); // the Nest lists objects in this order too
  } else {
    await api.classifier.moveTemplates(moduleId, ids);
  }
}

document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  const holder = document.activeElement?.closest?.('[data-cls-oid]');
  const id = holder ? Number(holder.dataset.clsOid) : S.classifierSelectedObject;
  const moduleId = id != null ? clsModuleOfObject(id) : null;
  if (moduleId == null || (!holder && !document.querySelector(`[data-cls-oid="${id}"]`))) return;
  const objs = clsData(moduleId).objects;
  const at = objs.findIndex((o) => o.id === id);
  const other = objs[at + (e.key === 'ArrowUp' ? -1 : 1)];
  if (!other) return;
  e.preventDefault();
  // Keep the caret's cell: the row re-renders under it.
  const cell = document.activeElement?.dataset?.tid;
  clsReorder('obj', moduleId, id, other.id, e.key === 'ArrowUp').then(() => setTimeout(() => {
    q(cell ? `[data-oid="${id}"][data-tid="${cell}"]` : `[data-cls-oid="${id}"]`)?.focus();
  }, 0));
});
