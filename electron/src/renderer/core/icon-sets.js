'use strict';
// ═══ Icon sets beside the app's own (Procress 29 part 5) ══════════════════
// Lucide, Phosphor and Tabler, vendored offline in electron/vendor/icons/
// (tools/icon-sets.mjs). A set is a ~0.5–1.5 MB script, so none loads at
// boot: the picker loads the one it shows, and an icon drawn somewhere is a
// placeholder until its set has loaded, then filled in place. A reference is
// `svg:<set>/<name>` — the `svg:<key>` of the app's own icons is unchanged, so
// every value stored before reads as it did. APK draws the same references.

const ICON_SET_LIST = [
  { id: 'lucide', label: 'Lucide' },
  { id: 'phosphor', label: 'Phosphor' },
  { id: 'tabler', label: 'Tabler' },
];
const ICON_SETS = {};      // id -> { label, viewBox, attrs, icons: { name: [inner, words] } }
const _iconSetLoad = {};   // id -> Promise

// Called by each generated vendor/icons/<set>.js
function iconSetAdd(id, meta, icons) { ICON_SETS[id] = { ...meta, icons }; }

function loadIconSet(id) {
  if (ICON_SETS[id]) return Promise.resolve(ICON_SETS[id]);
  if (!ICON_SET_LIST.some((s) => s.id === id)) return Promise.resolve(null);
  return (_iconSetLoad[id] ||= loadModule(`vendor/icons/${id}.js`).then(() => ICON_SETS[id] || null).catch(() => null));
}

const isSetIconRef = (key) => /^[a-z]+\/[a-z0-9-]+$/.test(key || '');

function setIconSvg(key) {
  const [id, name] = key.split('/');
  const set = ICON_SETS[id];
  const icon = set?.icons[name];
  return icon ? `<svg class="icon" aria-hidden="true" viewBox="${set.viewBox}" ${set.attrs}>${icon[0]}</svg>` : null;
}

// The icon if its set is here; otherwise a placeholder of the same size,
// filled once the set has loaded (a missing name stays an empty square).
function setIconHtml(key) {
  const svg = setIconSvg(key);
  if (svg) return svg;
  queueSetIconFill();
  return `<span class="icon set-icon-pending" data-set-icon="${x(key)}" aria-hidden="true"></span>`;
}

let _setIconFillQueued = false;
function queueSetIconFill() {
  if (_setIconFillQueued) return;
  _setIconFillQueued = true;
  requestAnimationFrame(async () => {
    _setIconFillQueued = false;
    const els = [...document.querySelectorAll('[data-set-icon]')];
    await Promise.all([...new Set(els.map((e) => e.dataset.setIcon.split('/')[0]))].map(loadIconSet));
    for (const el of document.querySelectorAll('[data-set-icon]')) {
      const svg = setIconSvg(el.dataset.setIcon);
      if (svg) el.outerHTML = svg;
    }
  });
}
