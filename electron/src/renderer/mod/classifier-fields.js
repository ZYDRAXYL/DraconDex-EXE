'use strict';
// ═══ Classifier fields (v5 Part 3, APP docs/V5.md §7.4) ═════════════════
// "Fields of this category" — what "Edit Template" was — plus the two ways a
// field is added without opening it: inline under an element's fields, and
// the element's own private fields.
//
// What changed from the old Edit Template modal:
//   - the name says what it is, and Save closes the modal (§7.10 Sheets: one
//     task, then done) instead of re-opening it on itself
//   - Level & Condition live in this same form, behind a disclosure that is
//     folded unless the field already uses one of them
//   - an empty name toasts instead of silently doing nothing (§7.5 bug #8)
//   - delete names the thing being deleted (§7.5 bug #4)

// The ten field types and their per-type settings live in
// mod/cls-field-types.js (v5 Part 7, §11.3).

// `editing` is a template id when the form is prefilled for an edit.
async function openClassifierFieldsModal(moduleId, editing = null) {
  const templates = CLS[moduleId] ? CLS[moduleId].templates : await api.classifier.getTemplates(moduleId);
  const cur = editing ? templates.find(tp => tp.id === editing) : null;
  openModal(t('clsFieldsOfCategory'), `
    <div>${templates.map(tpl => `
      <div class="prop insp-attr${tpl.id === editing ? ' cls-tpl-editing' : ''}" data-cls-tid="${tpl.id}" tabindex="0" onkeydown="clsFieldRowKey(event,this,${moduleId},${tpl.id})">
        ${reorderGripHtml(`clsFieldRowDown(event,this.closest('[data-cls-tid]'),${moduleId},${tpl.id})`)}
        <span class="pk">${x(tpl.description)}</span>
        <span class="pv ghost">${[t(CLASSIFIER_DISPTYPE_KEY[tpl.attribute_type] || 'dispTypeText'), tpl.levelable ? t('levelable') : '', tpl.has_condition ? t('condition') : ''].filter(Boolean).join(' · ')}</span>
        <span class="acts">
          <button class="btn btn-g btn-i" onclick="openClassifierFieldsModal(${moduleId},${tpl.id})" title="${t('edit')}">${I.edit}</button>
          <button class="btn btn-g btn-i" onclick="deleteClassifierTemplateRow(${moduleId},${tpl.id})" title="${t('delete')}">${I.delete}</button>
        </span>
      </div>`).join('') || `<p class="cls-lv-empty">${t('clsFieldsEmpty')}</p>`}
    </div>
    <div class="fg" style="margin-top:10px"><label>${cur ? t('editAttribute') : t('addAttribute')}</label><input id="ct-name" placeholder="${t('name')}" value="${x(cur?.description || '')}"></div>
    <div class="fg"><label>${t('displayType')}</label>
      <select id="ct-disptype" onchange="onClsTypeChange(this)">
        ${CLS_FIELD_TYPES.map(ty => `<option value="${ty}" ${clsType(cur) === ty ? 'selected' : ''}>${t(CLASSIFIER_DISPTYPE_KEY[ty])}</option>`).join('')}
      </select>
    </div>
    ${clsFieldOptionsHtml(cur)}
    <fieldset class="cls-adv cls-flags">
      <legend>${t('clsLevelAndCondition')}</legend>
      <p class="drafter-hint">${t('clsLevelAndConditionHint')}</p>
      <label class="fv-useimg"><input type="checkbox" id="ct-lv"${cur?.levelable ? ' checked' : ''}> ${t('levelable')}</label>
      <p class="drafter-hint cls-flag-hint">${t('clsLevelableHint')}</p>
      <label class="fv-useimg"><input type="checkbox" id="ct-cond"${cur?.has_condition ? ' checked' : ''}> ${t('condition')}</label>
      <p class="drafter-hint cls-flag-hint">${t('clsConditionHint')}</p>
    </fieldset>
    <div class="mfoot">
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitClassifierTemplateForm(${moduleId},${editing ?? 'null'})">${t('save')}</button>
    </div>`);
  setTimeout(() => q('#ct-name')?.focus(), 60);
}

// Procress 27 part 2: drag a field to move its column — in this modal, so the
// order can be set where the fields are listed. The modal is not re-rendered
// (a half-typed field form would be lost); the row moves in place, and the
// table behind it follows through clsReorder.
function clsFieldRowDown(ev, row, moduleId, id) {
  reorderDrag(ev, row, {
    move: true,
    items: () => [...row.parentElement.children].filter((n) => n.dataset.clsTid != null),
    onDrop: ({ target, before }) => clsFieldMove(row, moduleId, id, target, before),
  });
}
// Alt+↑ / Alt+↓ on a focused row, as in the table.
function clsFieldRowKey(ev, row, moduleId, id) {
  if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
  const up = ev.key === 'ArrowUp';
  const other = up ? row.previousElementSibling : row.nextElementSibling;
  if (other?.dataset.clsTid == null) return;
  ev.preventDefault();
  if (up) other.before(row); else other.after(row);
  row.focus();
  clsFieldMove(row, moduleId, id, other, up);
}
async function clsFieldMove(row, moduleId, id, target, before) {
  if (CLS[moduleId]) return clsReorder('tpl', moduleId, id, Number(target.dataset.clsTid), before);
  await api.classifier.moveTemplates(moduleId, [...row.parentElement.children].map((n) => Number(n.dataset.clsTid)).filter(Boolean));
}

async function submitClassifierTemplateForm(moduleId, editing = null) {
  const name = q('#ct-name').value.trim();
  if (!name) { toast(t('nameRequired'), 'err'); q('#ct-name')?.focus(); return; }
  const dispType = q('#ct-disptype')?.value || 'text';
  const levelable = !!q('#ct-lv')?.checked;
  const hasCondition = !!q('#ct-cond')?.checked;
  let options = readClsFieldOptions(dispType);
  // Two settings are not in the form — a field's role (a story variable's
  // type / default, §11.6) and a bundle's target category (§11.7). Keep
  // them through an edit, or Narrator / the picker would stop seeing them.
  const cur = editing ? clsFindTemplate(editing) : null;
  const { role, targetModuleId } = cur ? clsFieldOpts(cur) : {};
  if (role) options = { ...(options || {}), role };
  if (targetModuleId && dispType === 'relation') options = { ...(options || {}), targetModuleId };
  if (editing) await api.classifier.updateTemplate(editing, name, dispType, levelable, hasCondition, options);
  else await api.classifier.createTemplate(moduleId, name, dispType, levelable, hasCondition, null, options);
  closeModal();
  await refreshClassifier();
  toast(t(editing ? 'saved' : 'created'), 'ok');
}

// Procress 17 I3: a field (and its value in every object) goes now; Undo in the toast brings it all back.
async function deleteClassifierFieldUndoable(id, after) {
  const snap = await api.undoDelete.capture('field', id);
  await api.classifier.deleteTemplate(id);
  await refreshClassifier();
  toastAction(t('deleted'), t('scUndo'), async () => { await api.undoDelete.restore(snap); await refreshClassifier(); after?.(); });
  after?.();
}
async function deleteClassifierTemplateRow(moduleId, id) {
  await deleteClassifierFieldUndoable(id, () => openClassifierFieldsModal(moduleId));
}

// Inline "+ field" under an element's field rows (§7.4) — a shared field,
// so every object in the category gets it, exactly as from the modal.
// `el` is the input or its button — the box is found beside it, so this
// works in any instance, in any pane, and on the element's own page.
async function addClassifierFieldInline(moduleId, objectId, el) {
  const inp = el?.closest('.cls-addfield')?.querySelector('[data-r="addfield"]');
  const name = inp?.value.trim();
  if (!name) { toast(t('nameRequired'), 'err'); inp?.focus(); return; }
  // Focus comes back to the same instance's box after the re-render.
  const iid = el.closest('.pblock')?.dataset.iid;
  await api.classifier.createTemplate(moduleId, name, 'text', false, false, null);
  await refreshClassifier();
  toast(t('created'), 'ok');
  setTimeout(() => (iid ? pbRoot(iid) : document)?.querySelector('[data-r="addfield"]')?.focus(), 60);
}

// ── Private fields: this object only, any number (§7.4) ─────────────────
function openClassifierCustomAttrModal(moduleId, objectId) {
  openModal(t('customAttribute'), `
    <div class="fg"><label>${t('name')} *</label><input id="cca-name"
      onkeydown="if(event.key==='Enter'){event.preventDefault();submitClassifierCustomAttr(${moduleId},${objectId})}"></div>
    <div class="mfoot">
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitClassifierCustomAttr(${moduleId},${objectId})">${t('create')}</button>
    </div>`);
  setTimeout(() => q('#cca-name').focus(), 60);
}

async function submitClassifierCustomAttr(moduleId, objectId) {
  const name = q('#cca-name').value.trim();
  if (!name) { toast(t('nameRequired'), 'err'); return; }
  await api.classifier.createTemplate(moduleId, name, 'text', false, false, objectId);
  closeModal();
  await refreshClassifier();
  toast(t('created'), 'ok');
}

async function deleteClassifierPrivateField(templateId) {
  await deleteClassifierFieldUndoable(templateId);
}
