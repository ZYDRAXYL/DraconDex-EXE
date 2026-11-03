'use strict';
// ═══ Fields strip (APP src/design/no-modal, rule 1) ═══════════════════════
// A thing's own fields on its own page, in place of the modal that edited
// them: label left, value right, saved as each one changes — a text field on
// Enter or blur, a select on change, a colour on its pick. Esc puts a text
// field back. No Save / Cancel buttons.
//
//   fieldsStripHtml(rows)          rows: [{ key, title, type, value, ... }]
//     type 'text'    value, placeholder, hint
//     type 'select'  value, options: [{ value, text }]
//     type 'color'   value = a use_color id, hex = its colour (S.colors)
//     type 'check'   value = true/false (saved as '1' / '0')
//     type 'area'    several lines (Enter is a new line; saves on blur)
//     any: disabled (shown, not edited); text: list = suggestions (datalist)
//   fieldsStripMount(root, onSave)  onSave(key, value) → true, or a message
//                                   to toast (the old value is put back)
//   fieldsFocus(key)               focus + select a field once it is drawn
//
// onSave usually redraws the page (the name is in its head and the Nest);
// the field the user had moved on to gets its focus back after that.
// ponytail: renderBody hosts it, not a page block of its own — a
// `<kind>.fields` block that Page edit can move is the upgrade (rule 2).

function fieldsStripHtml(rows) {
  const ctl = (r) => {
    const a = `data-fkey="${x(r.key)}" aria-label="${x(r.title)}"`;
    if (r.type === 'select') {
      return `<select ${a} data-orig="${x(r.value ?? '')}">${r.options.map((o) => `<option value="${x(o.value)}"${String(o.value) === String(r.value ?? '') ? ' selected' : ''}>${x(o.text)}</option>`).join('')}</select>`;
    }
    if (r.type === 'area') {
      return `<textarea ${a} rows="2" data-orig="${x(r.value ?? '')}"${r.placeholder ? ` placeholder="${x(r.placeholder)}"` : ''} data-no-i18n>${x(r.value ?? '')}</textarea>`;
    }
    if (r.type === 'check') {
      return `<input type="checkbox" ${a} data-orig="${r.value ? '1' : '0'}"${r.value ? ' checked' : ''}${r.disabled ? ' disabled' : ''}>`;
    }
    if (r.type === 'color') {
      return `<button type="button" class="btn fstrip-color" ${a} data-orig="${x(r.value ?? '')}" data-hex="${x(r.hex || '')}"><span class="fstrip-dot"></span><span data-no-i18n>${x(r.hex || '—')}</span></button>`;
    }
    const list = r.list ? `fstrip-list-${x(r.key)}` : '';
    return `<input ${a} value="${x(r.value ?? '')}" data-orig="${x(r.value ?? '')}"${r.placeholder ? ` placeholder="${x(r.placeholder)}"` : ''}${r.disabled ? ' disabled' : ''}${list ? ` list="${list}" autocomplete="off"` : ''} data-no-i18n>${list
      ? `<datalist id="${list}">${r.list.map((v) => `<option value="${x(v)}">`).join('')}</datalist>` : ''}`;
  };
  return `<div class="fstrip">${rows.filter((r) => !r.hidden).map((r) => `<label class="fstrip-pair">
      <span class="fstrip-k">${x(r.title)}</span>
      <span class="fstrip-v">${ctl(r)}${r.hint ? `<span class="fstrip-hint">${x(r.hint)}</span>` : ''}</span>
    </label>`).join('')}</div>`;
}

function fieldsStripMount(root, onSave) {
  const strip = root?.querySelector('.fstrip');
  if (!strip) return;
  const save = async (el, value, moving = null) => {
    if (String(value) === el.dataset.orig) return;
    // focus has already moved on (Tab, a click) — keep it there across the redraw
    const ae = moving || document.activeElement; // on blur, focus is still on its way (relatedTarget)
    // by its place among the page's focusables — the redraw makes new elements
    const at = ae && ae !== el ? fieldsFocusables().indexOf(ae) : -1;
    const r = await onSave(el.dataset.fkey, value);
    if (r !== true) {
      if (r) toast(r, 'err');
      if (el.isConnected && el.type === 'checkbox') el.checked = el.dataset.orig === '1';
      else if (el.isConnected && el.tagName !== 'BUTTON') el.value = el.dataset.orig;
      return;
    }
    el.dataset.orig = String(value);
    updateStatusBar({ saveState: t('saved') });
    if (at >= 0 && !el.isConnected) setTimeout(() => fieldsFocusables()[at]?.focus(), 0); // onSave redrew the page
  };
  strip.addEventListener('keydown', (e) => {
    const el = e.target;
    const area = el.tagName === 'TEXTAREA';
    if ((el.tagName !== 'INPUT' && !area) || el.type === 'checkbox') return;
    e.stopPropagation(); // the page's shortcuts are not for this box
    if (e.key === 'Enter' && !area) { e.preventDefault(); el.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); el.value = el.dataset.orig; el.blur(); }
  });
  strip.addEventListener('focusout', (e) => { if ((e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') || e.target.tagName === 'TEXTAREA') save(e.target, e.target.value.trim(), e.relatedTarget); });
  strip.addEventListener('change', (e) => {
    if (e.target.tagName === 'SELECT') save(e.target, e.target.value);
    else if (e.target.type === 'checkbox') save(e.target, e.target.checked ? '1' : '0');
  });
  strip.addEventListener('click', (e) => {
    const btn = e.target.closest('.fstrip-color');
    if (!btn) return;
    e.preventDefault();
        // the palette's own swatches (core/pickers.js); #sel-color is what pickColor marks
    const pop = openPopover(btn, `<div class="cpicker-wrap fstrip-swatches"><input type="hidden" id="sel-color">${buildColorSwatches(sortColorsByHex(S.colors), Number(btn.dataset.orig))}</div>`, { cls: 'fstrip-color-pop' });
    pop?.addEventListener('click', (ev) => {
      const sw = ev.target.closest('[data-cid]');
      if (!sw) return;
      closeAllPopups();
      save(btn, sw.dataset.cid);
    });
  });
  strip.querySelectorAll('.fstrip-color[data-hex]').forEach((b) => { if (b.dataset.hex) b.style.setProperty('--fc', b.dataset.hex); });
}

const fieldsFocusables = () => [...document.querySelectorAll('#main-inner :is(input, select, textarea, button, [tabindex="0"]):not([disabled])')];

// Wait for the field to be drawn (a new thing's page opens asynchronously),
// then focus it — selecting its text, ready to type over.
function fieldsFocus(key, select = true) {
  return focusWhenSettled(`#main-inner .fstrip [data-fkey="${CSS.escape(key)}"]`, select);
}

// Focus `sel` once it is drawn — and keep it there until the page has been
// still for a moment: a save or an open is often followed by one more
// redraw (the Nest's, a module reload) that would drop it.
async function focusWhenSettled(sel, select = true) {
  let still = 0;
  for (let i = 0; i < 50 && still < 4; i++) {
    const el = document.querySelector(sel);
    if (el && document.activeElement !== el) { el.focus(); if (select) el.select?.(); still = 0; }
    else if (el) still++;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// A one-line label typed where it is shown — the label on a board's line
// (APP src/design/no-modal #10, #14), in place of a modal with one box.
// Enter or clicking away saves; Esc leaves it as it was. onDelete adds a
// delete button (it confirms, if it wants to).
//   labelEditPopover(anchor, value, { onSave(text), onDelete, placeholder })
function labelEditPopover(anchor, value, { onSave, onDelete = null, placeholder = '' } = {}) {
  const pop = openPopover(anchor, `<div class="lbl-edit"><input class="rename-input" value="${x(value || '')}" placeholder="${x(placeholder)}" aria-label="${x(placeholder)}" data-no-i18n>
    ${onDelete ? `<button type="button" class="btn btn-g btn-i" data-del title="${x(t('delete'))}" aria-label="${x(t('delete'))}">${I.delete}</button>` : ''}</div>`,
  { cls: 'lbl-edit-pop', placement: 'bottom-center', focus: '.rename-input', onClose: () => window.removeEventListener('keydown', esc, true) });
  if (!pop) return;
  const inp = pop.querySelector('.rename-input');
  let done = false;
  // Esc: the popover engine closes it (and moves focus away, which would read
  // as "clicked away"); window capture runs before it, so mark it cancelled
  function esc(e) { if (e.key === 'Escape' && pop.contains(document.activeElement)) done = true; }
  window.addEventListener('keydown', esc, true);
  const commit = async () => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    closeAllPopups();
    if (v !== (value || '')) await onSave(v);
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  // clicking away saves
  inp.addEventListener('focusout', (e) => { if (pop.isConnected && !pop.contains(e.relatedTarget)) commit(); });
  pop.querySelector("[data-del]")?.addEventListener('click', () => { done = true; closeAllPopups(); onDelete(); });
  setTimeout(() => inp.select(), 0);
}

// Rename in place: `el`'s text becomes a box with `value` selected. Enter or
// clicking away saves (onSave(text) — only when it changed and is not
// empty), Esc leaves it; onDone() runs either way (redraw the row back).
//   inlineRename(el, value, { onSave, onDone })
function inlineRename(el, value, { onSave, onDone }) {
  if (!el || el.querySelector('input')) return;
  const inp = document.createElement('input');
  inp.className = 'rename-input';
  inp.value = value || '';
  inp.setAttribute('aria-label', t('name'));
  el.textContent = '';
  el.appendChild(inp);
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    if (save && v && v !== (value || '')) await onSave(v);
    onDone();
  };
  for (const ev of ['pointerdown', 'click', 'dblclick']) inp.addEventListener(ev, (e) => e.stopPropagation()); // not the row's open / drag
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
  inp.focus();
  inp.select();
}
