'use strict';
// ═══ Custom colour panel (Procress 29 part 5, D4) ═════════════════════════
// The app's own colour chooser, for a colour that is not in the palette yet:
// a colour WHEEL (hue round the rim, saturation to the centre, a brightness
// slider under it), RGB/HEX (three sliders and a hex box), or a GRID of
// ready colours — one mode at a time, switched by a segmented control.
// Chromium's <input type=color> has neither a wheel nor a grid, so this is
// drawn here. Pure HSV maths below; the canvas is drawn on open.
//   colorPanelHtml(hex, okJs)   the markup; okJs runs with `hex` in scope
//   colorPanelMount(el)         draw it (call once it is in the document)

const CPANEL_WHEEL = 168;
const CPANEL_MODES = [{ value: 'wheel', key: 'colorWheel' }, { value: 'rgb', key: 'colorRgb' }, { value: 'grid', key: 'colorGrid' }];

function cpHsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1)];
}
function cpRgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return [(h + 360) % 360, max === 0 ? 0 : d / max, max];
}
const cpRgbToHex = (rgb) => `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
const cpHexToRgb = (hex) => (/^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : null);

// The grid: 12 hues × 4 shades, then a row of greys.
function cpanelGridColors() {
  const out = [];
  for (const [s, v] of [[0.35, 1], [0.65, 0.95], [0.85, 0.8], [0.9, 0.55]]) for (let h = 0; h < 360; h += 30) out.push(cpRgbToHex(cpHsvToRgb(h, s, v)));
  for (let i = 0; i < 12; i++) out.push(cpRgbToHex(cpHsvToRgb(0, 0, 1 - i / 11)));
  return out;
}

function colorPanelHtml(hex, okJs) {
  const rgb = cpHexToRgb(hex) || [99, 102, 241];
  const cur = cpRgbToHex(rgb);
  const slider = (i, label) => `<label class="cpanel-rgb"><span>${label}</span><input type="range" min="0" max="255" value="${rgb[i]}" data-rgb="${i}" oninput="cpanelFromRgb(this)" aria-label="${label}"><output data-no-i18n>${rgb[i]}</output></label>`;
  return `<div class="cpanel" data-mode="wheel" data-hex="${cur}">
    ${segmentedHtml(CPANEL_MODES.map((m) => ({ value: m.value, text: t(m.key) })), 'wheel', { size: 'sm', fill: true, onclick: (v) => `cpanelMode(this,'${v}')` })}
    <div class="cpanel-body" data-for="wheel">
      <canvas class="cpanel-wheel" width="${CPANEL_WHEEL}" height="${CPANEL_WHEEL}" onpointerdown="cpanelWheelDown(event,this)" aria-label="${x(t('colorWheel'))}"></canvas>
      <input type="range" class="cpanel-v" min="0" max="100" value="${Math.round(cpRgbToHsv(...rgb)[2] * 100)}" oninput="cpanelFromWheel(this)" aria-label="${x(t('colorBrightness'))}">
    </div>
    <div class="cpanel-body" data-for="rgb" hidden>${slider(0, 'R')}${slider(1, 'G')}${slider(2, 'B')}
      <label class="cpanel-rgb"><span>HEX</span><input class="cpanel-hex" value="${cur}" maxlength="7" spellcheck="false" oninput="cpanelFromHex(this)" data-no-i18n></label></div>
    <div class="cpanel-body cpanel-grid" data-for="grid" hidden>${cpanelGridColors().map((c) => `<button type="button" class="btn cpanel-cell" style="background:${c}" title="${c}" aria-label="${c}" onclick="cpanelSet(this,'${c}')"></button>`).join('')}</div>
    <div class="cpanel-foot"><span class="cpanel-swatch" style="background:${cur}"></span><span class="cpanel-code" data-no-i18n>${cur}</span>
      <button type="button" class="btn btn-p btn-sm cpanel-ok" onclick="(async(hex)=>{${okJs}})(this.closest('.cpanel').dataset.hex)">${t('add')}</button></div>
  </div>`;
}

const cpanelOf = (el) => el.closest('.cpanel');

function colorPanelMount(el) {
  const p = el.matches?.('.cpanel') ? el : el.querySelector('.cpanel');
  if (!p) return;
  const cv = p.querySelector('.cpanel-wheel');
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(CPANEL_WHEEL, CPANEL_WHEEL);
  const r0 = CPANEL_WHEEL / 2;
  for (let y = 0; y < CPANEL_WHEEL; y++) for (let x0 = 0; x0 < CPANEL_WHEEL; x0++) {
    const dx = x0 - r0, dy = y - r0, d = Math.hypot(dx, dy) / r0;
    const i = (y * CPANEL_WHEEL + x0) * 4;
    if (d > 1) { img.data[i + 3] = 0; continue; }
    const [r, g, b] = cpHsvToRgb((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, d, 1);
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function cpanelMode(btn, mode) {
  const p = cpanelOf(btn);
  p.dataset.mode = mode;
  p.querySelectorAll('.seg .seg-opt').forEach((b) => { const on = b.dataset.value === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  p.querySelectorAll('.cpanel-body').forEach((b) => { b.hidden = b.dataset.for !== mode; });
}

// One place that sets the colour and keeps every mode showing it.
function cpanelSet(el, hex) {
  const p = cpanelOf(el);
  const rgb = cpHexToRgb(hex);
  if (!p || !rgb) return;
  p.dataset.hex = hex.toLowerCase();
  p.querySelector('.cpanel-swatch').style.background = hex;
  p.querySelector('.cpanel-code').textContent = hex.toLowerCase();
  p.querySelectorAll('[data-rgb]').forEach((s) => { s.value = rgb[s.dataset.rgb]; s.nextElementSibling.textContent = rgb[s.dataset.rgb]; });
  const hx = p.querySelector('.cpanel-hex');
  if (hx && document.activeElement !== hx) hx.value = hex.toLowerCase();
  const v = p.querySelector('.cpanel-v');
  if (v && document.activeElement !== v) v.value = Math.round(cpRgbToHsv(...rgb)[2] * 100);
}

function cpanelFromRgb(el) {
  const p = cpanelOf(el);
  cpanelSet(el, cpRgbToHex([...p.querySelectorAll('[data-rgb]')].map((s) => Number(s.value))));
}
function cpanelFromHex(el) { if (/^#[0-9a-f]{6}$/i.test(el.value)) cpanelSet(el, el.value); }

// The wheel gives hue + saturation, the slider brightness.
function cpanelFromWheel(el, hs) {
  const p = cpanelOf(el);
  const cur = cpRgbToHsv(...cpHexToRgb(p.dataset.hex));
  const [h, s] = hs || cur;
  cpanelSet(el, cpRgbToHex(cpHsvToRgb(h, s, Number(p.querySelector('.cpanel-v').value) / 100)));
}
function cpanelWheelDown(ev, cv) {
  const at = (e) => {
    const r = cv.getBoundingClientRect();
    const dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2;
    cpanelFromWheel(cv, [(Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, Math.min(1, Math.hypot(dx, dy) / (r.width / 2))]);
  };
  at(ev);
  cv.setPointerCapture?.(ev.pointerId);
  cv.onpointermove = (e) => { if (e.buttons) at(e); };
  cv.onpointerup = () => { cv.onpointermove = null; };
}
