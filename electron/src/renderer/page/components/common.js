'use strict';
// ═══ Page components — shared bits (Procress 14, APP docs/TEMPLATES.md §2) ══
// The components a page template names (SDB templates/components.json) draw
// in two steps: render() leaves a shell, mount() fetches through the
// existing api.* calls and fills it. So a borrowed block (c.source is
// another module) and a block on its own module read the same way, and a
// slow read never holds up the rest of the page.

function pcShell(cls = '') {
  const k = cls ? `pc ${cls}` : 'pc';
  return `<div class="${k}" data-r="pc"><div class="pc-loading">${t('loading')}</div></div>`;
}

// Fill the shell with what fn() resolves to. A read that fails leaves a
// quiet line instead of a broken block.
async function pcFill(c, fn) {
  const el = c.root?.querySelector('[data-r="pc"]');
  if (!el) return;
  let html;
  try { html = await fn(); } catch (_) { html = pcEmpty(t('pcLoadFailed')); }
  if (el.isConnected) el.innerHTML = html;
}

const pcEmpty = (text) => `<div class="pc-empty">${x(text)}</div>`;

// A Classifier field by its key (Procress 14: a template's config.field) —
// the key rides in the field's options — or, for an older field, its name.
function pcFieldKeyOf(tpl) {
  try { return JSON.parse(tpl?.options || '{}')?.key || null; } catch (_) { return null; }
}
const pcFindField = (templates, key) => (templates || []).find((tp) => pcFieldKeyOf(tp) === key)
  || (templates || []).find((tp) => tp.description === key) || null;

const pcObjectId = (itemKey) => (/^cobj_\d+$/.test(itemKey || '') ? Number(itemKey.slice(5)) : null);
const pcPad = (n) => String(n ?? 0).padStart(2, '0');
const pcDate = (r, p = 's_') => (r?.[`${p}years`] == null ? '' : `${r[`${p}years`]}.${pcPad(r[`${p}month`])}.${pcPad(r[`${p}day`])}`);
const pcWords = (html) => String(html || '').replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
const pcOpen = (key) => `onclick="openEntityByKey(${xj(key)})"`;
const pcOpenModule = (id) => `onclick="openModuleNode(${Number(id)})"`;

// A labelled bar row, for counts (breakdown, eras, progress).
function pcBarsHtml(rows, max = null) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.n));
  return `<div class="pc-bars">${rows.map((r) => `<div class="pc-bar-row"${r.attrs ? ` ${r.attrs}` : ''}>
    <span class="pc-bar-label">${x(r.label)}</span>
    <span class="pc-bar"><span class="pc-bar-fill" style="width:${Math.round((r.n / top) * 100)}%${r.color ? `;background:${x(r.color)}` : ''}"></span></span>
    <span class="pc-bar-n">${r.n}</span></div>`).join('')}</div>`;
}

// registerComponent for a component that fills itself after mount.
function registerFilled(id, spec, fill) {
  registerComponent(id, {
    ...spec,
    render: () => pcShell(spec.cls || ''),
    mount: (c) => {
      if (spec.needsSource !== false && !c.source) return;
      pcFill(c, () => fill(c));
    },
  });
}
