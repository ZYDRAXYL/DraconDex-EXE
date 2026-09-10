// Editing an existing module: inline rename, pin, the live icon/color popup,
// the cat-type and kind pickers, the full module form modal and delete.
// ═══ Inline rename — Nest row + module detail header share one flag ════
function startRenameModule(id) {
  S.renamingModuleId = id;
  renderNexusHome();
  focusRenameInput(id);
}

// Waits for the rename <input> to land in the DOM after a re-render, then
// focuses it and selects the whole guideword/name so typing replaces it
// immediately — shared by both the dblclick-to-rename and just-created
// module paths.
function focusRenameInput(id) {
  setTimeout(() => {
    const el = q(S.activeModuleNode?.id === id ? `#rename-head-${id}` : `#rename-nest-${id}`);
    el?.focus(); el?.select();
  }, 30);
}

async function saveModuleRename(id, value) {
  const name = value.trim();
  const m = findModuleNode(id);
  if (name && m && name !== m.name) await api.module.update(id, { name });
  S.renamingModuleId = null;
  await reloadModuleTree();
}

async function toggleModulePin(id) {
  const m = findModuleNode(id);
  if (!m) return;
  await api.module.update(id, { pinned: m.pinned ? 0 : 1 });
  await reloadModuleTree();
}

// ═══ Icon/color quick-popup — live-saves on every pick ═════════════════
async function openModuleIconPopup(id, anchor) {
  closeAllPopups();
  const m = findModuleNode(id);
  if (!m || !anchor) return;
  const pop = document.createElement('div');
  pop.className = 'kind-popup icon-edit-popup';
  pop.innerHTML = await iconPicker(m.icon || null, m.color || null, m.name, kindLabel(m.kind));
  document.body.appendChild(pop);
  pop.addEventListener('click', e => {
    e.stopPropagation();
    if (e.target.closest('.ipk-cell') || e.target.closest('.cswatch')) saveModuleIconLive(id);
  });
  positionPopupNear(pop, anchor.getBoundingClientRect());
}

async function saveModuleIconLive(id) {
  const icon = getIconPickerValue() || null;
  const color = q('#sel-color')?.value || null;
  await api.module.update(id, { icon, color, icon_color: color });
  await reloadModuleTree();
}

function buildCatTypePicker(selected) {
  const sel = selected || 'object';
  return `<div class="fg" id="mm-cattype-section">
    <label>${t('catTypeLabel')}</label>
    <div class="typegrid">
      <div class="typecard${sel === 'object' ? ' sel' : ''}" onclick="pickCatType('object')">
        <h5>${I.layer} ${t('catTypeObject')}</h5><p>${t('catTypeObjectDesc')}</p>
      </div>
      <div class="typecard${sel === 'element' ? ' sel' : ''}" onclick="pickCatType('element')">
        <h5>${I.relation} ${t('catTypeElement')}</h5><p>${t('catTypeElementDesc')}</p>
        <div class="togglerow"><span class="tg on"></span>${t('levelable')}</div>
        <div class="togglerow"><span class="tg"></span>${t('condition')}</div>
      </div>
      <div class="typecard${sel === 'character' ? ' sel' : ''}" onclick="pickCatType('character')">
        <h5>${I.person} ${t('catTypeCharacter')}</h5><p>${t('catTypeCharacterDesc')}</p>
      </div>
    </div>
    <input type="hidden" id="mm-cattype" value="${sel}">
  </div>`;
}

function pickCatType(type) {
  q('#mm-cattype').value = type;
  const cards = document.querySelectorAll('#mm-cattype-section .typecard');
  ['object', 'element', 'character'].forEach((k, i) => cards[i]?.classList.toggle('sel', k === type));
}

// Edit-modal kind display: read-only, one card, since kind can't change
// post-creation (db/module.js has no kind-migration path — quickCreateModule
// is the only place a kind is ever chosen, via the popup card list below).
function buildKindPicker(kind) {
  return `<div class="fg">
    <label>${t('moduleKind')}</label>
    <div class="typegrid kindgrid locked">
      <div class="typecard kindcard sel">
        <h5 style="color:${x(KIND_COLOR[kind])}">${I[KIND_ICON[kind]]} ${x(kindLabel(kind))}</h5>
        <p>${t(KIND_DESC_KEY[kind])}</p>
      </div>
    </div>
    <input type="hidden" id="mm-kind" value="${kind}">
  </div>`;
}

// Edit-only now — creation is instant via the kind-popup (openKindPopup/
// quickCreateModule below); "start from template" never belonged here, it's
// Artisan's own artisanV3Spec/startArtisanWizard flow (src/renderer/artisan.js).
async function moduleFormModal(existing) {
  const isClassifier = existing.kind === 'classifier';
  openModal(t('moduleEdit'), `
    <div class="mm-section-label">${t('moduleIdentitySection')}</div>
    <div class="fg"><label>${t('name')} *</label><input id="mm-name" value="${x(existing.name || '')}"></div>
    <div class="fg"><label>${t('moduleHandle')}</label><input id="mm-handle" value="${x(existing.handle || '')}" placeholder="${t('moduleHandleHint')}"></div>
    ${buildKindPicker(existing.kind)}
    <div class="fg"><label>${t('iconCollection')}</label>${await iconPicker(existing.icon || null, existing.color || null, existing.name || '', kindLabel(existing.kind))}</div>
    ${isClassifier ? '<div class="ctx-sep"></div>' : ''}
    <div id="mm-cattype-wrap" style="display:${isClassifier ? '' : 'none'}">${buildCatTypePicker(existing.cat_type)}</div>
    <div class="mfoot">
      <button class="btn btn-d" onclick="deleteModuleNode(${existing.id})">${t('delete')}</button>
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitModuleForm(${existing.id})">${t('save')}</button>
    </div>`);
  setTimeout(() => q('#mm-name').focus(), 60);
}

async function submitModuleForm(existingId) {
  const name = q('#mm-name').value.trim();
  if (!name) return;
  const kind = q('#mm-kind').value;
  const colorId = q('#sel-color').value || null;
  const icon = getIconPickerValue() || null;
  const handle = q('#mm-handle')?.value.trim() ?? '';
  // A duplicate or malformed handle throws out of the db layer (module.js's
  // assertHandleFree/normalizeHandle). Catching it here is what keeps the
  // modal open with the user's typing intact — without this the throw would
  // escape and the form would just sit there having silently saved nothing.
  try {
    await api.module.update(existingId, { name, color: colorId, icon_color: colorId, icon, handle });
  } catch (e) {
    toast(t(/invalid/.test(e.message) ? 'handleInvalid' : 'handleTaken'), 'err');
    return;
  }
  if (kind === 'classifier') await api.classifier.setCatType(existingId, q('#mm-cattype')?.value || 'object');
  closeModal();
  await reloadModuleTree();
  toast(t('saved'), 'ok');
}

async function deleteModuleNode(id) {
  if (!await uiConfirm(t('moduleDeleteConfirm'))) return;
  await api.module.delete(id);
  closeModal();
  if (S.activeModuleNode?.id === id) S.activeModuleNode = null;
  await reloadModuleTree();
  toast(t('deleted'), 'ok');
}

// A Nest row's single click (open) and its name's double click (rename)
// are the same physical gesture for their first ~250ms — a dblclick is
// preceded by two ordinary 'click' events, so opening the module
// immediately on click would fire (and flash the module open) before the
// browser even recognizes the dblclick. Deferring the open lets the
// rename's dblclick handler cancel it first (Plan part1 #5 — this was the
// "click meant for the rename box lands on the module's body button" bug:
// the leaked open made startRenameModule think the module was already
// active and focus the header's rename box instead of the Nest row's).
let _rowOpenTimer = null;
function scheduleRowOpen(id) {
  clearTimeout(_rowOpenTimer);
  _rowOpenTimer = setTimeout(() => { _rowOpenTimer = null; openModuleNode(id); }, 250);
}
function cancelRowOpen() {
  clearTimeout(_rowOpenTimer);
  _rowOpenTimer = null;
}
