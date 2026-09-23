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

const CLASSIFIER_DISPTYPE_KEY = { text: 'dispTypeText', textarea: 'dispTypeTextarea', date: 'dispTypeDate' };

// `editing` is a template id when the form is prefilled for an edit.
async function openClassifierFieldsModal(moduleId, editing = null) {
  const templates = S.classifierData?.moduleId === moduleId ? S.classifierData.templates : await api.classifier.getTemplates(moduleId);
  const cur = editing ? templates.find(tp => tp.id === editing) : null;
  const advancedOpen = !!(cur && (cur.levelable || cur.has_condition));
  openModal(t('clsFieldsOfCategory'), `
    <div>${templates.map(tpl => `
      <div class="prop insp-attr${tpl.id === editing ? ' cls-tpl-editing' : ''}">
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
      <select id="ct-disptype">
        <option value="text" ${cur?.attribute_type === 'text' || !cur ? 'selected' : ''}>${t('dispTypeText')}</option>
        <option value="textarea" ${cur?.attribute_type === 'textarea' ? 'selected' : ''}>${t('dispTypeTextarea')}</option>
        <option value="date" ${cur?.attribute_type === 'date' ? 'selected' : ''}>${t('dispTypeDate')}</option>
      </select>
    </div>
    <details class="cls-adv"${advancedOpen ? ' open' : ''}>
      <summary>${t('clsLevelAndCondition')}</summary>
      <p class="drafter-hint">${t('clsLevelAndConditionHint')}</p>
      <div class="togglerow" onclick="toggleTemplateFlag('lv')"><span class="tg${cur?.levelable ? ' on' : ''}" id="ct-lv-tg"></span>${t('levelable')}</div>
      <div class="togglerow" onclick="toggleTemplateFlag('cond')"><span class="tg${cur?.has_condition ? ' on' : ''}" id="ct-cond-tg"></span>${t('condition')}</div>
    </details>
    <input type="hidden" id="ct-lv" value="${cur?.levelable ? 1 : 0}"><input type="hidden" id="ct-cond" value="${cur?.has_condition ? 1 : 0}">
    <div class="mfoot">
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitClassifierTemplateForm(${moduleId},${editing ?? 'null'})">${t('save')}</button>
    </div>`);
  setTimeout(() => q('#ct-name')?.focus(), 60);
}

function toggleTemplateFlag(key) {
  const hidden = q(`#ct-${key}`);
  const on = hidden.value === '1';
  hidden.value = on ? '0' : '1';
  q(`#ct-${key}-tg`)?.classList.toggle('on', !on);
}

async function submitClassifierTemplateForm(moduleId, editing = null) {
  const name = q('#ct-name').value.trim();
  if (!name) { toast(t('nameRequired'), 'err'); q('#ct-name')?.focus(); return; }
  const dispType = q('#ct-disptype')?.value || 'text';
  const levelable = q('#ct-lv')?.value === '1';
  const hasCondition = q('#ct-cond')?.value === '1';
  if (editing) await api.classifier.updateTemplate(editing, name, dispType, levelable, hasCondition);
  else await api.classifier.createTemplate(moduleId, name, dispType, levelable, hasCondition, null);
  closeModal();
  await refreshClassifier();
  toast(t(editing ? 'saved' : 'created'), 'ok');
}

async function deleteClassifierTemplateRow(moduleId, id) {
  if (!await uiConfirm(t('confirmDeleteField'))) return;
  await api.classifier.deleteTemplate(id);
  await refreshClassifier();
  toast(t('deleted'), 'ok');
  openClassifierFieldsModal(moduleId);
}

// Inline "+ field" under an element's field rows (§7.4) — a shared field,
// so every object in the category gets it, exactly as from the modal.
async function addClassifierFieldInline(moduleId, objectId) {
  const inp = q(`#cls-addfield-${objectId}`);
  const name = inp?.value.trim();
  if (!name) { toast(t('nameRequired'), 'err'); inp?.focus(); return; }
  await api.classifier.createTemplate(moduleId, name, 'text', false, false, null);
  await refreshClassifier();
  toast(t('created'), 'ok');
  setTimeout(() => q(`#cls-addfield-${objectId}`)?.focus(), 60);
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
  if (!await uiConfirm(t('confirmDeleteField'))) return;
  await api.classifier.deleteTemplate(templateId);
  await refreshClassifier();
  toast(t('deleted'), 'ok');
}
