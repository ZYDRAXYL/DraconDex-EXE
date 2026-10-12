'use strict';
// ═══ Shared controls (Procress 22, APP docs/COMPONENTS.md) ═══════════════
// One way to write each small control, so it looks and behaves the same on
// every page. CSS: css/controls.css. APK: flutter/lib/widgets/ — DdxChip,
// DdxSegmented, DdxCard, DdxIconButton, DdxField.
//
//   chipHtml       tag (#name, the user's colour as a dot) · link · filter
//                  (toggles, aria-pressed) · status (ok/warn/info/danger dot)
//                  · count — optional remove ✕
//   segmentedHtml  one choice out of 2–5, one row, the chosen one filled
//   cardHtml       info (static) · link (opens / picks) · preview (media on top)
//   iconBtnHtml    the one icon button (.btn-i); always has a name
//   fieldHtml      label + control + hint / error (aria-invalid,
//                  aria-describedby), disabled, read-only, --ctl-* sizes
//
// Colour contract (SDB tokens.mjs keeps every pair ≥ 4.5:1 in all 32
// themes): chip/segment text is --t1 on --raised/--hover; a selected filter
// or segment is --on-accent on --accent; status is --t1 + a coloured dot.

const _attr = (v) => x(String(v ?? ''));

// o: { label, variant: 'tag'|'link'|'filter'|'status'|'count'|null, color,
//      status, on, onclick, title, remove (inline JS), removeLabel, icon, attrs, noI18n, cls }
function chipHtml(o) {
  const variant = o.variant || null;
  const cls = ['chip', variant ? `chip-${variant}` : '', variant === 'filter' && o.on ? 'on' : '', o.cls || ''].filter(Boolean).join(' ');
  const style = o.color ? ` style="--chip-c:${_attr(o.color)}"` : '';
  const status = variant === 'status' && o.status ? ` data-status="${_attr(o.status)}"` : '';
  const title = o.title ? ` title="${_attr(o.title)}"` : '';
  const ni = o.noI18n ? ' data-no-i18n' : '';
  const text = `${o.icon ? (I[o.icon] || '') : ''}<span class="chip-t">${x(o.label ?? '')}</span>`;
  const rm = o.remove ? `<button type="button" class="chip-x" onclick="event.stopPropagation();${o.remove}" aria-label="${_attr(o.removeLabel || t('remove'))}">${I.close}</button>` : '';
  if (variant === 'filter') {
    return `<button type="button" class="${cls}" aria-pressed="${!!o.on}"${o.onclick ? ` onclick="${o.onclick}"` : ''}${title}${ni} ${o.attrs || ''}>${text}</button>`;
  }
  const click = o.onclick ? ` role="link" tabindex="0" onclick="${o.onclick}" onkeydown="if(event.key==='Enter'){event.preventDefault();this.click()}"` : '';
  return `<span class="${cls}"${style}${status}${click}${title}${ni} ${o.attrs || ''}>${text}${rm}</span>`;
}

// items: [{ value, text, icon, title }]; o: { onclick: (value) => js, aria,
// size: 'sm'|'md', fill, role: 'group'|'tablist'|'radiogroup', noI18n, cls }
function segmentedHtml(items, active, o = {}) {
  const role = o.role || 'group';
  const pressed = role === 'tablist' ? 'aria-selected' : role === 'radiogroup' ? 'aria-checked' : 'aria-pressed';
  const itemRole = role === 'tablist' ? ' role="tab"' : role === 'radiogroup' ? ' role="radio"' : '';
  const cls = ['seg', o.size === 'sm' ? 'seg-sm' : '', o.fill ? 'seg-fill' : '', o.cls || ''].filter(Boolean).join(' ');
  return `<div class="${cls}" role="${role}"${o.aria ? ` aria-label="${_attr(o.aria)}"` : ''}>${items.map((it) => {
    const on = it.value === active;
    const name = it.text ?? it.label ?? '';
    return `<button type="button" class="seg-opt${on ? ' on' : ''}"${itemRole} ${pressed}="${on}" data-value="${_attr(it.value)}"${o.onclick ? ` onclick="${o.onclick(it.value)}"` : ''}${it.title ? ` title="${_attr(it.title)}"` : ''}${!name && it.title ? ` aria-label="${_attr(it.title)}"` : ''}${o.noI18n ? ' data-no-i18n' : ''}>${it.icon ? (I[it.icon] || '') : ''}${name ? x(name) : ''}</button>`;
  }).join('')}</div>`;
}
// Mark the chosen segment after a click, without a re-render.
function segmentedSelect(seg, value) {
  if (!seg) return;
  for (const b of seg.querySelectorAll(':scope > .seg-opt')) {
    const on = b.dataset.value === String(value);
    b.classList.toggle('on', on);
    for (const a of ['aria-pressed', 'aria-selected', 'aria-checked']) if (b.hasAttribute(a)) b.setAttribute(a, String(on));
  }
}

// o: { kind: 'info'|'link'|'preview', title, meta, body (HTML), media (HTML
//      for a preview's top), onclick, on, attrs, cls }
function cardHtml(o) {
  const kind = o.kind || 'info';
  const cls = ['card', `card-${kind}`, o.on ? 'on' : '', o.cls || ''].filter(Boolean).join(' ');
  const inner = `${o.title ? `<div class="card-title">${x(o.title)}</div>` : ''}${o.meta ? `<div class="card-meta">${x(o.meta)}</div>` : ''}${o.body || ''}`;
  const content = kind === 'preview' ? `${o.media || ''}<div class="card-body">${inner}</div>` : inner;
  if (kind === 'link' || (kind === 'preview' && o.onclick)) {
    return `<div class="${cls}" role="button" tabindex="0"${o.onclick ? ` onclick="${o.onclick}"` : ''} onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}" ${o.attrs || ''}>${content}</div>`;
  }
  return `<div class="${cls}" ${o.attrs || ''}>${content}</div>`;
}

// The one icon button: always named (aria-label + title). size: 'sm' (24) | 'md' (28)
function iconBtnHtml(icon, label, onclick, o = {}) {
  const cls = ['btn', o.variant || 'btn-g', 'btn-i', o.size === 'sm' ? 'btn-i-sm' : '', o.on ? 'act' : '', o.cls || ''].filter(Boolean).join(' ');
  return `<button type="button" class="${cls}" onclick="${onclick}" title="${_attr(label)}" aria-label="${_attr(label)}"${o.disabled ? ' disabled' : ''} ${o.attrs || ''}>${I[icon] || ''}</button>`;
}

// A colour dot that is a button (Procress 24): a tag's or a category's own
// colour — user data, so a dot, never text colour — and clicking it picks one.
function colorDotBtnHtml(color, label, onclick) {
  return `<button type="button" class="btn btn-g btn-i btn-i-sm" onclick="event.stopPropagation();${onclick}" title="${_attr(label)}" aria-label="${_attr(label)}"><span class="color-dot" style="--dot-c:${_attr(color || 'transparent')}"></span></button>`;
}

// o: { id, label, value, type, placeholder, hint, error, disabled, readOnly,
//      size: 'sm'|'md'|'lg', textarea, attrs }
function fieldHtml(o) {
  const id = o.id || `fg-${Math.random().toString(36).slice(2, 8)}`;
  const desc = o.error ? `${id}-err` : o.hint ? `${id}-hint` : '';
  const sizeCls = { sm: ' class="ctl-sm"', lg: ' class="ctl-lg"' }[o.size] || '';
  const common = `id="${_attr(id)}"${sizeCls}${o.placeholder ? ` placeholder="${_attr(o.placeholder)}"` : ''}${o.disabled ? ' disabled' : ''}${o.readOnly ? ' readonly' : ''}${o.error ? ' aria-invalid="true"' : ''}${desc ? ` aria-describedby="${desc}"` : ''} ${o.attrs || ''}`;
  const ctl = o.textarea ? `<textarea ${common}>${x(o.value ?? '')}</textarea>` : `<input type="${_attr(o.type || 'text')}" value="${_attr(o.value ?? '')}" ${common}>`;
  return `<div class="fg">${o.label ? `<label for="${_attr(id)}">${x(o.label)}</label>` : ''}${ctl}${o.error ? `<div class="fg-error" id="${id}-err" role="alert">${x(o.error)}</div>` : o.hint ? `<div class="fg-hint" id="${id}-hint">${x(o.hint)}</div>` : ''}</div>`;
}
// Show / clear an error under a field that is already on screen.
function setFieldError(input, msg) {
  const el = typeof input === 'string' ? q(input) : input;
  if (!el) return;
  const fg = el.closest('.fg');
  const id = `${el.id || 'fg'}-err`;
  fg?.querySelector('.fg-error')?.remove();
  if (!msg) { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); return; }
  el.setAttribute('aria-invalid', 'true');
  el.setAttribute('aria-describedby', id);
  const err = document.createElement('div');
  err.className = 'fg-error'; err.id = id; err.setAttribute('role', 'alert'); err.textContent = msg;
  (fg || el.parentElement).appendChild(err);
}
