'use strict';
// ═══ Classifier fields (v5 Part 3, APP docs/V5.md §7.4) ═════════════════
// "Fields of this category" — what "Edit Template" was — plus the two ways a
// field is added without opening it: inline under an element's fields, and
// the element's own private fields. Since no-modal #02 / #03 none of it is a
// modal: the fields are edited in the category page's Structure tab, and a
// private field is typed in at the end of the object's own fields.

// The ten field types and their per-type settings live in
// mod/cls-field-types.js (v5 Part 7, §11.3).

// ── No modal (APP src/design/no-modal #02) ──────────────────────────────
// The fields are edited where they are listed: the Structure tab of the
// category's page. A row is grip · name · type · ⚙ · delete; the name saves
// on Enter / blur, the type on change. ⚙ unfolds the one row's settings — its
// type's options (mod/cls-field-types.js) and Level & Condition — which save
// as they change too. "+ field" under the list adds one by name.
const CLS_FIELD_OPEN = {}; // moduleId → the template id whose settings are unfolded

// The command / menu way in: the category's page, Structure tab, the field
// (if one) unfolded and its name — or the type — focused.
async function openClassifierFields(moduleId, tplId = null, focus = 'name') {
  if (S.activeModuleNode?.id !== moduleId || S.activeItemNode) await openModuleNode(moduleId);
  CLS_FIELD_OPEN[moduleId] = tplId;
  setPageTab(moduleId, 'structure');
  const sel = tplId ? `.cls-fe [data-cls-tid="${tplId}"] [data-f="${focus}"]` : '.cls-fe-add [data-r="addfield"]';
  await focusWhenSettled(`#main-inner ${sel}`, focus === 'name'); // core/fields.js
}

function toggleClassifierFieldSettings(moduleId, tplId) {
  CLS_FIELD_OPEN[moduleId] = CLS_FIELD_OPEN[moduleId] === tplId ? null : tplId;
  renderNexusHome();
}

function clsFieldsEditorHtml(m) {
  const open = CLS_FIELD_OPEN[m.id];
  const rows = clsData(m.id).templates.map((tpl) => {
    const unfolded = open === tpl.id;
    return `<div class="prop insp-attr${unfolded ? ' open' : ''}" data-cls-tid="${tpl.id}" tabindex="0" onkeydown="clsFieldRowKey(event,this,${m.id},${tpl.id})">
      ${reorderGripHtml(`clsFieldRowDown(event,this.closest('[data-cls-tid]'),${m.id},${tpl.id})`)}
      <input class="cls-fe-name" data-f="name" value="${x(tpl.description)}" aria-label="${x(t('name'))}" data-no-i18n
        onkeydown="event.stopPropagation();if(event.key==='Enter')this.blur();if(event.key==='Escape'){this.value=${xj(tpl.description)};this.blur()}"
        onchange="saveClassifierField(${m.id},${tpl.id},{name:this.value.trim()},event)">
      <select data-f="type" aria-label="${x(t('displayType'))}" onchange="saveClassifierField(${m.id},${tpl.id},{type:this.value},event)">
        ${CLS_FIELD_TYPES.map((ty) => `<option value="${ty}" ${clsType(tpl) === ty ? 'selected' : ''}>${t(CLASSIFIER_DISPTYPE_KEY[ty])}</option>`).join('')}
      </select>
      <span class="acts">
        <button class="btn btn-g btn-i${unfolded ? ' active' : ''}" onclick="toggleClassifierFieldSettings(${m.id},${tpl.id})" title="${x(t('clsLevelAndCondition'))}" aria-label="${x(t('clsLevelAndCondition'))}" aria-expanded="${unfolded}">${I.settings}</button>
        <button class="btn btn-g btn-i" onclick="deleteClassifierFieldUndoable(${tpl.id})" title="${t('delete')}" aria-label="${t('delete')}">${I.delete}</button>
      </span>
    </div>${unfolded ? `<div class="cls-fe-more" onchange="saveClassifierField(${m.id},${tpl.id},{form:true},event)">
      ${clsFieldOptionsHtml(tpl)}
      <label class="fv-useimg"><input type="checkbox" id="ct-lv"${tpl.levelable ? ' checked' : ''}> ${t('levelable')}</label>
      <p class="drafter-hint cls-flag-hint">${t('clsLevelableHint')}</p>
      <label class="fv-useimg"><input type="checkbox" id="ct-cond"${tpl.has_condition ? ' checked' : ''}> ${t('condition')}</label>
      <p class="drafter-hint cls-flag-hint">${t('clsConditionHint')}</p>
    </div>` : ''}`;
  }).join('');
  return `<div class="cls-fe">${rows || `<p class="drafter-hint">${t('clsFieldsEmpty')}</p>`}
    <div class="cls-addfield cls-fe-add">
      <input class="cls-addfield-inp" data-r="addfield" placeholder="${x(t('clsAddFieldPlaceholder'))}"
        onkeydown="if(event.key==='Enter'){event.preventDefault();addClassifierFieldInline(${m.id},null,this)}">
      <button class="btn btn-g btn-sm" onclick="addClassifierFieldInline(${m.id},null,this)" title="${x(t('clsAddFieldShared'))}">${I.plus} ${t('clsAddField')}</button>
    </div></div>`;
}

// One field, one change: { name } | { type } | { form: true } (the unfolded
// settings). Settings the form does not show — a field's role (a story
// variable, §11.6) and a bundle's target category (§11.7) — are kept.
async function saveClassifierField(moduleId, id, patch, ev = null) {
  const cur = clsFindTemplate(id);
  if (!cur) return;
  const name = patch.name ?? cur.description;
  if (!name) { toast(t('nameRequired'), 'err'); renderNexusHome(); return; }
  const dispType = patch.type ?? clsType(cur);
  const kept = clsFieldOpts(cur);
  let options;
  if (patch.form) options = readClsFieldOptions(dispType);
  else options = dispType === clsType(cur) ? (Object.keys(kept).length ? kept : null) : null;
  if (kept.role) options = { ...(options || {}), role: kept.role };
  if (kept.targetModuleId && dispType === 'relation') options = { ...(options || {}), targetModuleId: kept.targetModuleId };
  const levelable = patch.form ? !!q('#ct-lv')?.checked : !!cur.levelable;
  const hasCondition = patch.form ? !!q('#ct-cond')?.checked : !!cur.has_condition;
  // focus may have moved on (Tab) — put it back there after the redraw
  const all = () => [...document.querySelectorAll('#main-inner :is(input, select, textarea, button):not([disabled])')];
  const at = ev?.target === document.activeElement ? all().indexOf(ev.target) : all().indexOf(document.activeElement);
  await api.classifier.updateTemplate(id, name, dispType, levelable, hasCondition, options);
  await refreshClassifier();
  updateStatusBar({ saveState: t('saved') });
  if (at >= 0) setTimeout(() => all()[at]?.focus(), 0);
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

// Procress 17 I3: a field (and its value in every object) goes now; Undo in the toast brings it all back.
async function deleteClassifierFieldUndoable(id, after) {
  const snap = await api.undoDelete.capture('field', id);
  await api.classifier.deleteTemplate(id);
  await refreshClassifier();
  toastAction(t('deleted'), t('scUndo'), async () => { await api.undoDelete.restore(snap); await refreshClassifier(); after?.(); });
  after?.();
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
  focusWhenSettled(iid ? `.pblock[data-iid="${iid}"] [data-r="addfield"]` : '#main-inner [data-r="addfield"]', false);
}

// ── Private fields: this object only, any number (§7.4) ─────────────────
// Which objects' private fields the user has unfolded (or just added to) — a
// redraw keeps them open, so the box is still there for the next one.
const CLS_PRIV_OPEN = new Set();
function clsPrivToggle(objectId, open) { if (open) CLS_PRIV_OPEN.add(objectId); else CLS_PRIV_OPEN.delete(objectId); }

// No modal (#03): typed into a box at the end of the object's own fields,
// exactly like "+ field" above them — Enter adds it, focus stays for the next.
async function addClassifierPrivateFieldInline(moduleId, objectId, el) {
  const inp = el?.closest('.cls-addfield')?.querySelector('[data-r="addprivfield"]');
  const name = inp?.value.trim();
  if (!name) { toast(t('nameRequired'), 'err'); inp?.focus(); return; }
  const iid = el.closest('.pblock')?.dataset.iid;
  CLS_PRIV_OPEN.add(objectId);
  await api.classifier.createTemplate(moduleId, name, 'text', false, false, objectId);
  await refreshClassifier();
  toast(t('created'), 'ok');
  focusWhenSettled(iid ? `.pblock[data-iid="${iid}"] [data-r="addprivfield"]` : '#main-inner [data-r="addprivfield"]', false);
}

async function deleteClassifierPrivateField(templateId) {
  await deleteClassifierFieldUndoable(templateId);
}
