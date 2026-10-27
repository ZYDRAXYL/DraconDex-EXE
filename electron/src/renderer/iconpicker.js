'use strict';
// ═══ Icon Collection picker (progress.md Phase 5) ═════════════════════
// Embedded markup (no modal chrome of its own) used to pick a module's
// icon + color, with a live nest-row preview — hosted inside the module's
// live-save icon popup (openModuleIconPopup) and the object forms. Three
// working tabs — Icons (this app's `I.*` SVG dict), Symbols (the
// existing `symbol_collection`, already user-extendable via Navigator),
// and Uploaded (native <input type=file> + canvas circular crop, no libs).
//
// Selection is stored as `svg:<I-key>`, `sym:<glyph>` or `img:<dataURI>`
// in `module.icon`; see moduleIconHtml() in hub.js for how it's rendered
// back out.

// Procress 14 (EXPORT-DECOR D1): every icon in core/icon-catalog.js, by
// category and findable by word, instead of a hand-picked 32; an Emoji tab
// (stored as sym:, like a symbol); and the ones used last on top.

// Upload-crop module-scope state (iconpicker.js has no shared store beyond
// DOM queries — a few `let`s is the right amount of state for this).
let icropImg = null;       // loaded Image (or null before a file is picked)
let icropRoot = null;      // the .ipk-wrap the image was picked in
let icropZoom = 1;         // 1..3
let icropPanX = 0;         // px offset, clamped to keep image covering the canvas
let icropPanY = 0;
let icropDragging = false;
let icropDragStartX = 0, icropDragStartY = 0;
let icropPanStartX = 0, icropPanStartY = 0;
const ICROP_CANVAS = 220;  // preview/crop canvas size
const ICROP_OUTPUT = 128;  // stored icon size

// Procress 29 part 5: everything below works inside ONE picker — the
// .ipk-wrap an event came from — never through document-wide ids. A picker
// used to be read with q('#sel-color') / q('#ipk-icon-value'), which is the
// FIRST such element in the document: with a second picker or colour field
// open (a modal, the Properties panel, another popover) a pick could read or
// toggle the other one's.
const ipkRoot = (el) => el?.closest?.('.ipk-wrap') || null;
const ipkQ = (root, sel) => root?.querySelector(sel) || null;

// Procress 29 part 5: Icons offers the app's own set and three open ones
// (core/icon-sets.js — Lucide, Phosphor, Tabler), one at a time by a chip,
// every icon of it in the grid (rendered as it scrolls) and searchable across
// all of them. "Custom icon" (was "Uploaded") takes a typed letter or emoji,
// the images already uploaded in this Nexus, or a new upload. The square
// after "Colour" opens a colour of your own (core/color-panel.js).
const IPK_APP_SET = 'app';
const ipkSetOf = (key) => (isSetIconRef(key) ? key.split('/')[0] : IPK_APP_SET);

function ipkCellHtml(ref, sel, svg, title) {
  return `<div class="ipk-cell${sel === ref ? ' sel' : ''}" data-name="${x(ref)}" onclick="pickIconPickerIcon(this,${xj(ref)})" title="${x(title || ref)}">${svg}</div>`;
}

// The cells of one set (or of a search over all), through lazyRows.
function ipkGridHtml(root, set, query, sel) {
  const st = (root._ipkLazy ||= {});
  const q0 = String(query || '').trim().toLowerCase();
  let refs;
  if (q0) {
    const words = q0.split(/\s+/);
    const hit = (name, extra) => words.every((w) => name.includes(w) || (extra || '').includes(w));
    refs = iconCatalogKeys().filter(({ key }) => iconMatches(key, q0)).map(({ key }) => key);
    for (const { id } of ICON_SET_LIST) {
      const icons = ICON_SETS[id]?.icons || {};
      for (const name in icons) if (hit(name, icons[name][1])) refs.push(`${id}/${name}`);
    }
  } else refs = set === IPK_APP_SET ? iconCatalogKeys().map(({ key }) => key) : Object.keys(ICON_SETS[set]?.icons || {}).map((n) => `${set}/${n}`);
  const key = `${set}|${q0}`;
  if (st.key !== key) { st.key = key; st.shown = 0; }
  if (!refs.length) return `<p class="drafter-hint">${t('pbNoMatch')}</p>`;
  return lazyRows(refs, (r) => ipkCellHtml(r, sel, I[r] || setIconSvg(r) || '', r), st, { step: 240 });
}

async function iconPicker(selIcon, selColorId, previewName, previewKind) {
  const [symbols, uploads] = await Promise.all([api.color.getSymbolCollection(), S.nexus ? api.module.uploadedIcons(S.nexus.id).catch(() => []) : []]);
  const selImg = selIcon && selIcon.startsWith('img:') ? selIcon.slice(4) : null;
  const selKey = selIcon && selIcon.startsWith('svg:') ? selIcon.slice(4) : (selIcon && !selIcon.startsWith('sym:') && !selImg ? selIcon : null);
  const selSym = selIcon && selIcon.startsWith('sym:') ? selIcon.slice(4) : null;
  const set = ipkSetOf(selKey);
  if (set !== IPK_APP_SET) await loadIconSet(set);
  const tab = (id, key, on) => `<button type="button" class="seg-opt${on ? ' on' : ''}" role="tab" aria-selected="${on}" data-ipktab="${id}" onclick="switchIconPickerTab(this,'${id}')">${t(key)}</button>`;
  const fake = { _ipkLazy: {} };
  const selColor = (S.colors.find(c=>c.id===selColorId)||{}).color_code;
  return `<div class="ipk-wrap" data-set="${set}">
    <div class="ipk-preview-row">
      <span class="pk">${t('preview')}</span>
      <div class="li ipk-preview" style="pointer-events:none;display:inline-flex;width:auto">
        <span class="kicon ipk-preview-icon" aria-hidden="true" style="color:${x(selColor || 'var(--accent)')}">${selSym ? `<span class="kicon-glyph" aria-hidden="true">${x(selSym)}</span>` : (selImg ? `<img src="${x(selImg)}" class="icrop-preview-img">` : (iconRefHtml(selKey ? `svg:${selKey}` : null, I.layer)))}</span>
        <span class="name">${x(previewName||'')}</span>
        ${previewKind ? `<span class="kind">${x(previewKind)}</span>` : ''}
      </div>
    </div>
    <div class="seg seg-sm seg-fill ipk-tabs" role="tablist">
      ${tab('icons', 'iconTabIcons', true)}${tab('emoji', 'iconTabEmoji', false)}${tab('symbols', 'iconTabSymbols', false)}${tab('uploaded', 'iconTabUploaded', false)}
    </div>
    <div class="ipk-pane" data-pane="icons">
      <div class="ipk-sets">${segmentedHtml([{ value: IPK_APP_SET, text: 'DraconDex' }, ...ICON_SET_LIST.map((s) => ({ value: s.id, text: s.label }))], set, { size: 'sm', aria: t('iconSet'), noI18n: true, onclick: (v) => `ipkShowSet(this,'${v}')` })}</div>
      <input type="search" class="ipk-search" placeholder="${x(t('iconSearchPh'))}" aria-label="${x(t('iconSearchPh'))}" oninput="filterIconPicker(this,this.value)">
      <div class="ipk-scroll">
      ${iconRecent().length ? `<div class="ipk-recent"><span class="pk">${t('iconRecent')}</span>${iconRecent().map((r) => r.startsWith('sym:')
        ? `<div class="ipk-cell ipk-symbol${selSym === r.slice(4) ? ' sel' : ''}" onclick="pickIconPickerSymbol(this,${xj(r.slice(4))})">${x(r.slice(4))}</div>`
        : (I[r.slice(4)] || isSetIconRef(r.slice(4)) ? ipkCellHtml(r.slice(4), selKey, iconRefHtml(r, ''), r.slice(4)) : '')).join('')}</div>` : ''}
      <div class="ipk-grid ipk-icon-grid">${ipkGridHtml(fake, set, '', selKey)}</div>
      </div>
    </div>
    <div class="ipk-pane ipk-scroll" data-pane="emoji" hidden>
      <div class="ipk-grid">${emojiList().map((e) => `<div class="ipk-cell ipk-symbol${selSym===e?' sel':''}" onclick="pickIconPickerSymbol(this,${xj(e)})" data-no-i18n>${e}</div>`).join('')}</div>
    </div>
    <div class="ipk-pane ipk-scroll" data-pane="symbols" hidden>
      <div class="ipk-grid">${symbols.map(s => `<div class="ipk-cell ipk-symbol${selSym===s.glyph?' sel':''}" data-name="${x((s.label||'').toLowerCase())}" onclick="pickIconPickerSymbol(this,${xj(s.glyph)})" title="${x(s.label||'')}">${x(s.glyph)}</div>`).join('')}</div>
    </div>
    <div class="ipk-pane ipk-scroll" data-pane="uploaded" hidden>
      <label class="ipk-custom"><span class="pk">${t('iconCustomText')}</span>
        <input class="ipk-custom-text" maxlength="16" placeholder="${x(t('iconCustomTextPh'))}" aria-label="${x(t('iconCustomText'))}" value="${x(selSym && !emojiList().includes(selSym) ? selSym : '')}"
          onkeydown="if(event.key==='Enter'){event.preventDefault();this.nextElementSibling.click()}" data-no-i18n>
        <button type="button" class="btn btn-g btn-sm ipk-custom-use" onclick="pickIconPickerText(this.previousElementSibling)">${t('useThisIcon')}</button></label>
      ${uploads.length ? `<span class="pk">${t('iconUploadedHere')}</span><div class="ipk-grid ipk-uploads">${uploads.map((u) => `<div class="ipk-cell ipk-upload${selIcon === u ? ' sel' : ''}" onclick="pickIconPickerImage(this)" data-ref="${x(u)}"><img src="${x(u.slice(4))}" alt=""></div>`).join('')}</div>` : ''}
      <div class="ipk-upload-pane">${icropUploadPromptHtml()}</div>
    </div>
    <input type="file" accept="image/*" class="icrop-file-input" style="display:none" onchange="handleIconUpload(this)">
    <div class="ipk-color-row">
      <span class="pk">${t('color')}</span>
      <div class="ipk-colors"><button type="button" class="btn btn-g ipk-color-custom" title="${x(t('colorCustom'))}" aria-label="${x(t('colorCustom'))}" aria-expanded="false" onclick="ipkToggleColorPanel(this)">${I.plus}</button>${ipkSwatchesHtml(selColorId)}</div>
    </div>
    <div class="ipk-color-panel" hidden></div>
    <input type="hidden" class="ipk-icon-value" value="${x(selIcon||'')}">
    <input type="hidden" class="ipk-color-value" value="${selColorId||''}">
  </div>`;
}

const ipkSwatchesHtml = (selColorId) => sortColorsByHex(S.colors).map(c =>
  `<div class="cswatch${selColorId===c.id?' sel':''}" style="background:${c.color_code}" data-cid="${c.id}" onclick="pickIconPickerColor(this,${c.id})"></div>`).join('');

async function ipkShowSet(btn, set) {
  const root = ipkRoot(btn);
  btn.parentElement.querySelectorAll('.seg-opt').forEach((b) => { const on = b.dataset.value === set; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  root.dataset.set = set;
  if (set !== IPK_APP_SET) await loadIconSet(set);
  ipkRenderGrid(root);
}

function ipkRenderGrid(root) {
  const grid = ipkQ(root, '.ipk-icon-grid');
  if (!grid) return;
  const sel = (ipkQ(root, '.ipk-icon-value').value || '').replace(/^svg:/, '');
  grid.innerHTML = ipkGridHtml(root, root.dataset.set || IPK_APP_SET, ipkQ(root, '.ipk-search')?.value, sel);
  const sc = grid.closest('.ipk-scroll');
  if (sc) sc.scrollTop = 0;
}

// A typed letter or emoji is stored like a symbol (sym:) — one or two
// characters as the eye sees them (a flag or a family emoji is one).
function pickIconPickerText(inp) {
  const g = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(inp.value.trim())].map((s) => s.segment).slice(0, 2).join('');
  if (!g) return;
  inp.value = g;
  const root = ipkRoot(inp);
  root.querySelectorAll('.ipk-cell').forEach(b => b.classList.remove('sel'));
  ipkQ(root, '.ipk-icon-value').value = `sym:${g}`;
  iconRecentPush(`sym:${g}`);
  ipkSetPreview(root, `<span class="kicon-glyph" aria-hidden="true">${x(g)}</span>`);
}

function pickIconPickerImage(el) {
  const root = ipkRoot(el);
  root.querySelectorAll('.ipk-cell').forEach(b => b.classList.remove('sel'));
  el.classList.add('sel');
  ipkQ(root, '.ipk-icon-value').value = el.dataset.ref;
  ipkSetPreview(root, `<img src="${x(el.dataset.ref.slice(4))}" class="icrop-preview-img">`);
}

function ipkToggleColorPanel(btn) {
  const root = ipkRoot(btn);
  const panel = ipkQ(root, '.ipk-color-panel');
  const open = panel.hidden;
  btn.setAttribute('aria-expanded', String(open));
  root.classList.toggle('ipk-color-open', open); // the panel takes the grid's place while it is open
  if (!open) { panel.hidden = true; panel.innerHTML = ''; return; }
  const cur = (S.colors || []).find((c) => String(c.id) === ipkQ(root, '.ipk-color-value').value)?.color_code || '#6366f1';
  panel.innerHTML = colorPanelHtml(cur, 'await ipkAddCustomColor(this, hex)');
  panel.hidden = false;
  colorPanelMount(panel);
}

// A colour of your own joins the palette (use_color — the same table every
// colour picker reads) and is picked like any swatch, so a live-saving popup
// saves it through its usual path.
async function ipkAddCustomColor(el, hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
  const root = ipkRoot(el);
  await api.color.add(hex);
  S.colors = await api.color.getAll();
  const nc = S.colors.find((c) => c.color_code.toLowerCase() === hex.toLowerCase());
  if (!nc) return;
  const box = ipkQ(root, '.ipk-colors');
  box.querySelectorAll('.cswatch').forEach((s) => s.remove());
  box.insertAdjacentHTML('beforeend', ipkSwatchesHtml(Number(ipkQ(root, '.ipk-color-value').value) || null));
  ipkToggleColorPanel(ipkQ(root, '.ipk-color-custom'));
  box.querySelector(`.cswatch[data-cid="${nc.id}"]`)?.click(); // picks it, and a live popup saves it
}

function switchIconPickerTab(el, tabName) {
  const root = ipkRoot(el);
  if (!root) return;
  root.querySelectorAll('.ipk-tabs [data-ipktab]').forEach(b => { const on = b.dataset.ipktab === tabName; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  root.querySelectorAll('.ipk-pane').forEach((p) => { p.hidden = p.dataset.pane !== tabName; });
}

// Uploaded-tab pane states ────────────────────────────────────────────

function icropUploadPromptHtml() {
  return `<div class="icrop-empty" onclick="ipkQ(ipkRoot(this),'.icrop-file-input').click()">
    ${I.folder || ''}
    <span>${t('iconUploadPrompt')}</span>
  </div>`;
}

// A search looks through every set, so the first one typed loads them all.
async function filterIconPicker(el, query) {
  const root = ipkRoot(el);
  clearTimeout(root._ipkT);
  root._ipkT = setTimeout(async () => {
    if (String(query).trim()) await Promise.all(ICON_SET_LIST.map((s) => loadIconSet(s.id)));
    if (root.isConnected) ipkRenderGrid(root);
  }, 150);
}

function ipkSetPreview(root, html) {
  const prevIcon = ipkQ(root, '.ipk-preview-icon');
  if (prevIcon) prevIcon.innerHTML = html;
}

function pickIconPickerIcon(el, key) {
  const root = ipkRoot(el);
  root.querySelectorAll('.ipk-cell').forEach(b => b.classList.remove('sel'));
  el.classList.add('sel');
  ipkQ(root, '.ipk-icon-value').value = `svg:${key}`;
  iconRecentPush(`svg:${key}`);
  ipkSetPreview(root, iconRefHtml(`svg:${key}`, I.layer));
}

function pickIconPickerSymbol(el, glyph) {
  const root = ipkRoot(el);
  root.querySelectorAll('.ipk-cell').forEach(b => b.classList.remove('sel'));
  el.classList.add('sel');
  ipkQ(root, '.ipk-icon-value').value = `sym:${glyph}`;
  iconRecentPush(`sym:${glyph}`);
  ipkSetPreview(root, `<span class="kicon-glyph" aria-hidden="true">${x(glyph)}</span>`);
}

async function pickIconPickerColor(el, id) {
  const root = ipkRoot(el);
  root.querySelectorAll('.ipk-colors .cswatch').forEach(s => s.classList.remove('sel'));
  el.classList.add('sel');
  ipkQ(root, '.ipk-color-value').value = id;
  const code = (S.colors || []).find(c => c.id === id)?.color_code;
  const prevIcon = ipkQ(root, '.ipk-preview-icon');
  if (prevIcon && code) prevIcon.style.color = code;
  await api.color.markUsed(id);
}

// What a picker holds now. `root` is the .ipk-wrap (or anything inside it,
// or the popover/modal around it).
const ipkWrapOf = (root) => (root?.classList?.contains('ipk-wrap') ? root : root?.querySelector?.('.ipk-wrap')) || ipkRoot(root);
const getIconPickerValue = (root) => ipkQ(ipkWrapOf(root), '.ipk-icon-value')?.value || '';
const getIconPickerColor = (root) => ipkQ(ipkWrapOf(root), '.ipk-color-value')?.value || '';

// Which half of the pick a click inside a live-saving picker changed — a
// colour swatch changes ONLY the colour, an icon cell or a confirmed upload
// ONLY the icon (Procress 29 part 5: they used to be written together, so
// one could overwrite the other). null = the click picked nothing.
function iconPickerChange(e) {
  if (e.target.closest('.cswatch')) return 'color';
  if (e.target.closest('.ipk-cell') || e.target.closest('.icrop-confirm') || e.target.closest('.ipk-custom-use')) return 'icon';
  return null;
}

// ═══ Uploaded tab: native <input type=file> + FileReader + <canvas> ═══
// circular crop, no libs. Crop state lives in the module-scope `let`s
// declared above (icropImg/icropZoom/icropPanX/icropPanY).

function handleIconUpload(inputEl) {
  const file = inputEl.files && inputEl.files[0];
  if (!file) return;
  icropRoot = ipkRoot(inputEl);
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      icropImg = img;
      icropZoom = 1;
      icropPanX = 0;
      icropPanY = 0;
      icropRenderCropUI();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
  inputEl.value = ''; // allow re-picking the same file later
}

function icropRenderCropUI() {
  const pane = ipkQ(icropRoot, '.ipk-upload-pane');
  if (!pane || !icropImg) return;
  pane.innerHTML = `
    <div class="icrop-stage">
      <canvas class="icrop-canvas" width="${ICROP_CANVAS}" height="${ICROP_CANVAS}" onmousedown="icropStartDrag(event)"></canvas>
      <div class="icrop-mask"></div>
    </div>
    <input type="range" class="icrop-zoom" min="1" max="3" step="0.01" value="${icropZoom}" oninput="icropOnZoom(this.value)">
    <div class="icrop-actions">
      <button type="button" class="btn btn-s icrop-cancel" onclick="icropReset()">${t('cancel')}</button>
      <button type="button" class="btn btn-p icrop-confirm" onclick="icropConfirm()">${t('save')}</button>
    </div>`;
  icropRedraw();
}

// Scale/size the image would be drawn at for the current zoom — a "cover"
// base fit (like CSS background-size:cover) times the zoom factor, so any
// source image size always fills the circular mask at zoom 1.
function icropDrawSize() {
  const baseScale = Math.max(ICROP_CANVAS / icropImg.naturalWidth, ICROP_CANVAS / icropImg.naturalHeight);
  const scale = baseScale * icropZoom;
  return { scale, w: icropImg.naturalWidth * scale, h: icropImg.naturalHeight * scale };
}

function icropClampPan() {
  const { w, h } = icropDrawSize();
  const maxX = Math.max(0, (w - ICROP_CANVAS) / 2);
  const maxY = Math.max(0, (h - ICROP_CANVAS) / 2);
  icropPanX = Math.max(-maxX, Math.min(maxX, icropPanX));
  icropPanY = Math.max(-maxY, Math.min(maxY, icropPanY));
}

function icropRedraw() {
  const canvas = ipkQ(icropRoot, '.icrop-canvas');
  if (!canvas || !icropImg) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, ICROP_CANVAS, ICROP_CANVAS);
  const { w, h } = icropDrawSize();
  const dx = (ICROP_CANVAS - w) / 2 + icropPanX;
  const dy = (ICROP_CANVAS - h) / 2 + icropPanY;
  ctx.drawImage(icropImg, dx, dy, w, h);
}

function icropOnZoom(val) {
  icropZoom = parseFloat(val) || 1;
  icropClampPan();
  icropRedraw();
}

function icropStartDrag(e) {
  if (!icropImg) return;
  icropDragging = true;
  icropDragStartX = e.clientX;
  icropDragStartY = e.clientY;
  icropPanStartX = icropPanX;
  icropPanStartY = icropPanY;
  document.addEventListener('mousemove', icropOnDrag);
  document.addEventListener('mouseup', icropStopDrag);
}

function icropOnDrag(e) {
  if (!icropDragging) return;
  icropPanX = icropPanStartX + (e.clientX - icropDragStartX);
  icropPanY = icropPanStartY + (e.clientY - icropDragStartY);
  icropClampPan();
  icropRedraw();
}

function icropStopDrag() {
  icropDragging = false;
  document.removeEventListener('mousemove', icropOnDrag);
  document.removeEventListener('mouseup', icropStopDrag);
}

function icropConfirm() {
  if (!icropImg) return;
  const out = document.createElement('canvas');
  out.width = ICROP_OUTPUT;
  out.height = ICROP_OUTPUT;
  const ctx = out.getContext('2d');
  ctx.save();
  ctx.beginPath();
  ctx.arc(ICROP_OUTPUT / 2, ICROP_OUTPUT / 2, ICROP_OUTPUT / 2, 0, Math.PI * 2);
  ctx.clip();
  const outScale = ICROP_OUTPUT / ICROP_CANVAS;
  const { w, h } = icropDrawSize();
  const dx = ((ICROP_CANVAS - w) / 2 + icropPanX) * outScale;
  const dy = ((ICROP_CANVAS - h) / 2 + icropPanY) * outScale;
  ctx.drawImage(icropImg, dx, dy, w * outScale, h * outScale);
  ctx.restore();
  const dataUrl = out.toDataURL('image/png');

  ipkQ(icropRoot, '.ipk-icon-value').value = 'img:' + dataUrl;
  icropRoot.querySelectorAll('.ipk-cell').forEach(b => b.classList.remove('sel'));
  ipkSetPreview(icropRoot, `<img src="${dataUrl}" class="icrop-preview-img">`);

  icropShowResult(dataUrl);
}

function icropShowResult(dataUrl) {
  const pane = ipkQ(icropRoot, '.ipk-upload-pane');
  if (!pane) return;
  pane.innerHTML = `<div class="icrop-result">
    <img src="${dataUrl}" class="icrop-result-img">
    <button type="button" class="btn btn-s icrop-change" onclick="icropReset()">${t('iconUploadPrompt')}</button>
  </div>`;
}

// Discards any in-progress crop (Cancel) and returns the pane to the
// initial upload-prompt state — also reused as "change image" from the
// post-confirm result state.
function icropReset() {
  icropImg = null;
  icropZoom = 1;
  icropPanX = 0;
  icropPanY = 0;
  const pane = ipkQ(icropRoot, '.ipk-upload-pane');
  if (pane) pane.innerHTML = icropUploadPromptHtml();
}
