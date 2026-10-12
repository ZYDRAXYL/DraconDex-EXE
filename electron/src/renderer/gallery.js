'use strict';
// ═══ Component gallery (Procress 22, dev only — APP docs/COMPONENTS.md) ══
// Every shared component, every variant and state, on one page — what
// electron/test/ui-audit.driver.mjs shoots and measures in each built-in
// theme (contrast, ≥ 24 px targets, accessible names, keyboard) instead of
// walking every page that happens to use them. Opened by `--gallery` on the
// command line or Ctrl+P → "Component gallery" (dev.gallery), and only when
// the app is not packaged (S.devMode, from api.window.devInfo()).
// Lazy-loaded (loadModule) — nothing here ships into a normal session.
// The words on this page are fixture text, not UI: data-no-i18n throughout.

function galleryHtml() {
  const sec = (id, title, body) => `<section class="gal-sec" id="gal-${id}" aria-labelledby="gal-${id}-h">
    <h3 class="gal-h" id="gal-${id}-h">${title}</h3><div class="gal-set">${body}</div></section>`;
  const sw = 'var(--info)'; // a tag colour is user data — the gallery stands in for one
  return `<div class="module-page gal" id="gallery" data-no-i18n>
    <div class="ch"><h2>${I.list} Component gallery</h2>
      <span class="chip chip-status" data-status="info">dev only</span></div>
    <p class="drafter-hint">APP docs/COMPONENTS.md — every component, variant and state. Audited in every built-in theme.</p>

    ${sec('btn', 'Button', `
      <button class="btn btn-p">Primary</button><button class="btn btn-s">Secondary</button>
      <button class="btn btn-g">Ghost</button><button class="btn btn-d">Delete</button>
      <button class="btn btn-p btn-sm">Small</button><button class="btn btn-s" disabled>Disabled</button>`)}
    ${sec('ibtn', 'Icon button', `
      ${iconBtnHtml('edit', 'Edit', 'void 0')} ${iconBtnHtml('delete', 'Delete', 'void 0', { variant: 'btn-d' })}
      ${iconBtnHtml('pin', 'Pin (on)', 'void 0', { on: true })} ${iconBtnHtml('options', 'Options (small)', 'void 0', { size: 'sm' })}
      ${iconBtnHtml('close', 'Close (disabled)', 'void 0', { disabled: true })}`)}
    ${sec('chip', 'Chip', `
      ${chipHtml({ label: 'Plain' })}
      ${chipHtml({ label: '#harbor', variant: 'tag', color: sw })}
      ${chipHtml({ label: '#removable', variant: 'tag', color: sw, remove: 'this.closest(\'.chip\').remove()' })}
      ${chipHtml({ label: '[[Mira]]', variant: 'link', onclick: 'void 0' })}
      ${chipHtml({ label: 'Filter off', variant: 'filter', onclick: 'galleryToggleChip(this)' })}
      ${chipHtml({ label: 'Filter on', variant: 'filter', on: true, onclick: 'galleryToggleChip(this)' })}
      ${chipHtml({ label: 'Synced', variant: 'status', status: 'ok' })}
      ${chipHtml({ label: 'Needs a look', variant: 'status', status: 'warn' })}
      ${chipHtml({ label: 'New', variant: 'status', status: 'info' })}
      ${chipHtml({ label: 'Missing', variant: 'status', status: 'danger' })}
      ${chipHtml({ label: '12', variant: 'count' })}`)}
    ${sec('seg', 'Segmented', `
      ${segmentedHtml([{ value: 'a', text: 'Grid' }, { value: 'b', text: 'List' }, { value: 'c', text: 'Graph' }], 'a', { aria: 'View', onclick: (v) => `segmentedSelect(this.parentElement,'${v}')` })}
      ${segmentedHtml([{ value: 'l', text: 'Left' }, { value: 'c', text: 'Center' }, { value: 'r', text: 'Right' }], 'c', { aria: 'Align', size: 'sm', onclick: (v) => `segmentedSelect(this.parentElement,'${v}')` })}
      ${segmentedHtml([{ value: 'i', text: 'Icons' }, { value: 'e', text: 'Emoji' }], 'i', { aria: 'Tabs', role: 'tablist', size: 'sm', onclick: (v) => `segmentedSelect(this.parentElement,'${v}')` })}`)}
    ${sec('card', 'Card', `<div class="gal-grid">
      ${cardHtml({ kind: 'info', title: 'Info card', meta: 'Facts, not clickable', body: '<p class="gal-p">Born in the harbor town.</p>' })}
      ${cardHtml({ kind: 'link', title: 'Link card', meta: 'Opens something', onclick: 'void 0' })}
      ${cardHtml({ kind: 'link', title: 'Link card (chosen)', meta: 'aria-checked', on: true, onclick: 'void 0' })}
      ${cardHtml({ kind: 'preview', title: 'Preview card', meta: 'Media on top', media: '<div class="card-media gal-media" aria-hidden="true"></div>', onclick: 'void 0' })}</div>`)}
    ${sec('field', 'Field', `<div class="gal-fields">
      ${fieldHtml({ id: 'gal-f1', label: 'Name', value: 'Mira', hint: 'One line of help under the field' })}
      ${fieldHtml({ id: 'gal-f2', label: 'Required', value: '', error: 'Fill this in' })}
      ${fieldHtml({ id: 'gal-f3', label: 'Disabled', value: 'Locked', disabled: true })}
      ${fieldHtml({ id: 'gal-f4', label: 'Read-only', value: 'module_12', readOnly: true })}
      ${fieldHtml({ id: 'gal-f5', label: 'Small', value: '', size: 'sm', placeholder: 'ctl-sm' })}
      ${fieldHtml({ id: 'gal-f6', label: 'Large', value: '', size: 'lg', placeholder: 'ctl-lg' })}
      <div class="fg"><label for="gal-f7">Select</label><select id="gal-f7"><option>One</option><option>Two</option></select></div>
      ${fieldHtml({ id: 'gal-f8', label: 'Text area', value: 'Notes', textarea: true })}</div>`)}
    ${sec('list', 'List', `<div class="gal-list">${listHtml({ list: 'gallery', aria: 'Gallery list', body:
      listRowHtml({ icon: I.person, title: 'Comfortable row', meta: 'meta line', count: 3, onclick: 'void 0' })
      + listRowHtml({ icon: I.person, title: 'Selected row', meta: 'meta', state: { current: true }, onclick: 'void 0' })
      + listRowHtml({ density: 'compact', icon: I.folder, title: 'Compact row', onclick: 'void 0' }) })}
      ${emptyStateHtml({ icon: I.info, text: 'Nothing here yet — one sentence says what will be.', action: { label: 'Add one', onclick: 'void 0' } })}</div>`)}
    ${sec('layer', 'Popover · Modal · Toast', `
      <button class="btn btn-s" id="gal-pop" onclick="galleryPopover(this)">${I.chevronDown}Popover</button>
      <button class="btn btn-s" id="gal-menu" onclick="galleryMenu(this)">${I.options}Menu</button>
      <button class="btn btn-s" id="gal-modal-sm" onclick="galleryModal('sm')">Modal sm</button>
      <button class="btn btn-s" id="gal-modal-md" onclick="galleryModal('md')">Modal md</button>
      <button class="btn btn-s" id="gal-modal-lg" onclick="galleryModal('lg')">Modal lg</button>
      <button class="btn btn-s" id="gal-confirm" onclick="uiConfirm('Delete this module?')">Confirm</button>
      <button class="btn btn-s" id="gal-toast" onclick="toastAction('Moved to trash','Undo',()=>{})">Toast + Undo</button>`)}
    ${sec('icon', 'Icons (I.*)', `<div class="gal-icons">${Object.keys(I).map((k) => `<span class="gal-icon" title="${k}">${I[k]}<small>${k}</small></span>`).join('')}</div>`)}
  </div>`;
}

function openGallery() {
  if (!S.devMode) return;
  closeAllPopups();
  S.view = 'gallery';
  const host = q('#main-inner');
  if (!host) return;
  host.innerHTML = galleryHtml();
  host.scrollTop = 0;
}

function galleryToggleChip(el) {
  const on = el.getAttribute('aria-pressed') !== 'true';
  el.setAttribute('aria-pressed', String(on));
  el.classList.toggle('on', on);
}
function galleryPopover(btn) {
  openPopover(btn, `<div class="popover-head">Pick a value</div>
    ${segmentedHtml([{ value: 's', text: 'Small' }, { value: 'm', text: 'Medium' }], 's', { size: 'sm', fill: true, aria: 'Size', onclick: (v) => `segmentedSelect(this.parentElement,'${v}')` })}
    <div class="fg"><label for="gal-pop-in">Label</label><input id="gal-pop-in" value="Harbor"></div>
    <div class="popover-foot"><button class="btn btn-p btn-sm" onclick="closeAllPopups()">Done</button></div>`,
  { size: 'lg', aria: 'Gallery popover'});
}
function galleryMenu(btn) {
  ctxMenu(null, [{ head: 'Organise' }, { label: 'Rename', icon: 'edit', onClick: () => {} }, { label: 'Pin', icon: 'pin', checked: true, onClick: () => {} },
    { label: 'Move to', icon: 'move', sub: [{ label: 'Folder A', onClick: () => {} }] }, { sep: true }, { label: 'Delete', icon: 'delete', danger: true, onClick: () => {} }], { anchor: btn });
}
function galleryModal(size) {
  openModal(`Modal ${size}`, `<div class="fg"><label for="gal-m-name">Name</label><input id="gal-m-name" value="Mira"></div>
    <div class="mfoot"><button class="btn btn-d" onclick="closeModal()">Delete</button><button class="btn btn-s" onclick="closeModal()">Cancel</button><button class="btn btn-p" onclick="closeModal()">Save</button></div>`,
  { size, hint: 'A modal is a full form: head, body, and a foot whose primary button is rightmost.' });
}
