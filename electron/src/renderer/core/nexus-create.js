'use strict';
// ═══ Create a new Nexus — Unity Hub's "New project" (Procress 25) ══════════
// Its own child window (main.js createNexusCreateWindow, index.html
// ?createNexus=1 → boot.js): the Welcome window is 760x560 and a two-pane form
// does not fit in it, so this window is allowed to be bigger than its parent.
// The same window is used from the app window's Switch Nexus → New Nexus —
// there is one way to create a Nexus, looked after in one place.
//
//   left ~65 %   categories · search · the template grid (the Home gallery's
//                card, templateCardHtml in hub/bundles.js) · what the chosen
//                one makes
//   right ~35 %  the form: name · memo · colour · save location · Locate
//                folder (read-only) · App Docs · tour
//   foot         [Import DB / .ddx] ......... [Cancel] [Create Nexus]
//
// Under 1000 px wide (a small screen gets the whole work area) the two panes
// fold into two steps: pick a template → the form (css/welcome.css).
//
// The Nexus is created HERE; filling it is not. A template, App Docs and the
// tour all act on an open vault, and this window has none — so they are
// written down as "pending work" under NEXUS_PENDING_GUIDE_KEY (state.js),
// window:createNexusDone hands the new id to main, main opens the vault's
// window, and that window does the work at boot (runPendingCreate, below).
// If the template fails there, the Nexus stays and a toast offers the
// template picker again — it is never deleted behind the user's back.

const CN_CATS = ['all', 'blank', 'classic', 'genre'];
const CN_CAT_KEY = { all: 'cnCatAll', blank: 'cnBlank', classic: 'bundleTabClassic', genre: 'bundleTabGenre' };
// The user's own templates ("Save as Artisan bundle…") live inside a Nexus,
// and this window has none open — so there is no "Mine" shelf here.

// One state object per window; this page is the only thing the window shows.
const CN = { cat: 'all', q: '', sel: '', list: [], adjusted: null, step: 'pick', busy: false, root: '' };
const cnIsBlank = () => !CN.sel;
const cnBundle = (id = CN.sel) => CN.list.find((b) => b.id === id) || null;
const cnBlankCard = () => ({ id: '', name: t('cnBlank'), description: t('cnBlankD'), spec: {} });

// The templates for what this app is used for first (Procress 16 part 7),
// then the catalogue's own order — same ranking openBundlePicker uses.
function cnVisible() {
  const pref = (typeof purposeOf === 'function' && purposeOf()?.bundles) || [];
  const rank = (b) => (pref.includes(b.id) ? pref.indexOf(b.id) : 99);
  const grp = (b) => (b.group || 'genre') === 'genre' ? 0 : 1;
  const needle = CN.q.trim().toLowerCase();
  const hit = (b) => !needle || `${b.name} ${b.description || ''}`.toLowerCase().includes(needle);
  const out = [];
  if (['all', 'blank'].includes(CN.cat) && hit(cnBlankCard())) out.push(cnBlankCard());
  if (CN.cat !== 'blank') {
    out.push(...CN.list.filter((b) => (CN.cat === 'all' || (b.group || 'genre') === CN.cat) && hit(b))
      .sort((a, b) => grp(a) - grp(b) || rank(a) - rank(b) || (a.order ?? 0) - (b.order ?? 0)));
  }
  return out;
}

async function renderCreateNexusWindow() {
  document.title = t('cnTitle');
  const tb = q('#titlebar-vault'); if (tb) tb.textContent = t('cnTitle');
  const [list, root] = await Promise.all([
    bundleCatalog().catch(() => []),
    hasLocate() ? api.nexus.locateRoot().catch(() => '') : Promise.resolve(''),
  ]);
  CN.list = list.filter((b) => ['genre', 'classic'].includes(b.group || 'genre'));
  CN.root = root || '';
  const first = S.nexuses.length === 0;
  q('#main-inner').innerHTML = `
    <div class="cn" data-step="pick">
      <div class="cn-left">
        <nav class="cn-cats" aria-label="${x(t('cnCategories'))}">${listHtml({ list: 'cn-cats', aria: t('cnCategories'), body: '' })}</nav>
        <div class="cn-main">
          <input id="cn-search" class="cn-search" type="search" placeholder="${x(t('cnSearch'))}" aria-label="${x(t('cnSearch'))}" oninput="cnSearch(this.value)">
          <div class="cn-scroll"><div id="cn-grid" class="home-tpls cn-grid" role="radiogroup" aria-label="${x(t('cnTemplates'))}" onkeydown="cnGridKey(event)"></div></div>
          <section id="cn-detail" class="cn-detail" aria-live="polite"></section>
        </div>
      </div>
      <form class="cn-form" onsubmit="event.preventDefault();cnSubmit()" autocomplete="off">
        <div class="fg"><label for="nx-name">${t('name')} *</label>
          <input id="nx-name" value="${x(cnDefaultName())}" oninput="cnNameInput()" onkeydown="if(event.key==='Enter'){event.preventDefault();cnSubmit()}" aria-describedby="nx-name-err">
          <div id="nx-name-err" class="help err" role="alert" hidden></div></div>
        <div class="fg"><label for="nx-memo">${t('memo')}</label><textarea id="nx-memo" rows="2"></textarea></div>
        <div class="fg"><label>${t('color')}</label>${await colorPicker(null)}</div>
        ${await nexusSaveLocationHtml()}
        ${CN.root ? `<div class="fg"><label>${t('nexusLocalFolder')}</label>
          <div class="sync-hint">${t('nexusLocalFolderHint')}</div>
          <input id="cn-locate" readonly data-no-i18n></div>` : ''}
        <div class="cn-checks">
          <label class="cn-check"><input id="cn-appdocs" type="checkbox"${first ? ' checked' : ''} onchange="cnSyncTour()">
            <span><b>${t('cnAppDocs')}</b><span class="sync-hint">${t('cnAppDocsHint')}</span></span></label>
          <label class="cn-check"><input id="cn-tour" type="checkbox">
            <span><b>${t('cnTour')}</b><span class="sync-hint">${t('cnTourHint')}</span></span></label>
        </div>
      </form>
      <footer class="cn-foot">
        <button type="button" class="btn btn-s" onclick="importDatabaseFile()">${t('importDb')}</button>
        <button type="button" class="btn btn-s cn-back" onclick="cnStep('pick')">${t('guideBack')}</button>
        <span class="cn-foot-gap"></span>
        <button type="button" class="btn btn-s" onclick="cnCancel()">${t('cancel')}</button>
        <button type="button" class="btn btn-p cn-next" onclick="cnStep('form')">${t('guideNext')}</button>
        <button type="button" id="cn-create" class="btn btn-p cn-create" onclick="cnSubmit()">${t('cnCreate')}</button>
      </footer>
    </div>`;
  cnRenderCats();
  cnRenderGrid();
  cnNameInput();
  cnSyncTour();
  setTimeout(() => { const el = q('#nx-name'); el?.focus(); el?.select(); }, 30);
}

function cnRenderCats() {
  const box = q('#ls-cn-cats');
  if (!box) return;
  box.innerHTML = CN_CATS.map((c) => listRowHtml({ density: 'compact', icon: null, title: t(CN_CAT_KEY[c]),
    state: { selected: CN.cat === c }, onclick: `cnCat('${c}')`, attrs: `data-cn-cat="${c}"` })).join('');
}

function cnCat(c) {
  CN.cat = CN_CATS.includes(c) ? c : 'all';
  cnRenderCats();
  cnRenderGrid();
  q(`#ls-cn-cats [data-cn-cat="${CN.cat}"]`)?.focus();
}

function cnSearch(v) { CN.q = String(v || ''); cnRenderGrid(); }

function cnRenderGrid() {
  const grid = q('#cn-grid');
  if (!grid) return;
  const shown = cnVisible();
  // the selection follows the filter: a hidden card cannot stay chosen
  if (!shown.some((b) => b.id === CN.sel)) CN.sel = shown[0]?.id ?? '';
  grid.innerHTML = shown.length ? shown.map((b) => templateCardHtml(b, {
    on: b.id === CN.sel, icon: b.id ? null : 'plus',
    onclick: `cnPick(${xj(b.id)})`,
    attrs: `role="radio" aria-checked="${b.id === CN.sel}" tabindex="${b.id === CN.sel ? 0 : -1}" data-cn-id="${x(b.id)}" ondblclick="cnPick(${xj(b.id)});cnSubmit()"`,
  })).join('') : emptyStateHtml({ icon: I.search, text: t('cnNoMatch') });
  cnRenderDetail();
}

function cnPick(id, focus = false) {
  if (CN.sel !== id) CN.adjusted = null; // an adjusted copy belongs to the template it came from
  CN.sel = id;
  for (const el of document.querySelectorAll('#cn-grid [data-cn-id]')) {
    const on = el.dataset.cnId === id;
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', String(on));
    el.tabIndex = on ? 0 : -1;
    if (on && focus) el.focus();
  }
  cnRenderDetail();
}

// ←→↑↓ move through the grid by its real columns; Enter creates (Unity's
// double-click, from the keyboard); Space just picks.
function cnGridKey(e) {
  const cards = [...document.querySelectorAll('#cn-grid [data-cn-id]')];
  const i = cards.findIndex((c) => c.dataset.cnId === CN.sel);
  if (e.key === 'Enter') { e.preventDefault(); cnSubmit(); return; }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) || !cards.length) return;
  e.preventDefault();
  const top0 = cards[0].offsetTop;
  const cols = Math.max(1, cards.filter((c) => c.offsetTop === top0).length);
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? cards.length - 1 : Math.max(0, Math.min(cards.length - 1, (i < 0 ? 0 : i) + step));
  cnPick(cards[j].dataset.cnId, true);
}

// What the chosen template makes: its modules — kind, how many examples —
// from the bundle's own spec, plus "Adjust first…" (openBundleAdjust).
function cnRenderDetail() {
  const box = q('#cn-detail');
  if (!box) return;
  const b = cnBundle();
  if (!b) {
    box.innerHTML = `<h3 class="cn-dh">${x(t('cnBlank'))}</h3><p class="cn-dd">${x(t('cnBlankD'))}</p>`;
    return;
  }
  const spec = CN.adjusted?.spec || b.spec;
  const sh = bundleShape(spec);
  const counts = t('artCounts').replace('{f}', sh.folders).replace('{m}', sh.mods.length).replace('{l}', sh.links.length).replace('{s}', sh.samples);
  const rows = sh.mods.map((m) => {
    const n = bundleSamplesOf(m);
    return listRowHtml({ density: 'compact', icon: `<i style="color:${x(KIND_COLOR[m.kind] || 'var(--accent)')}">${I[KIND_ICON[m.kind]] || ''}</i>`,
      title: m.name || '', meta: kindLabel(m.kind), count: n ? `+${n}` : null, attrs: 'data-no-i18n' });
  }).join('');
  box.innerHTML = `<h3 class="cn-dh" data-no-i18n>${x(CN.adjusted ? CN.adjusted.spec.name : b.name)}</h3>
    ${b.description ? `<p class="cn-dd" data-no-i18n>${x(b.description)}</p>` : ''}
    <p class="cn-dc">${x(counts)}${CN.adjusted ? ` · ${x(t('cnAdjusted'))}` : ''}</p>
    ${listHtml({ list: 'cn-mods', aria: t('bundleIncludes'), body: rows })}
    <div class="cn-dacts">
      ${sh.samples && !CN.adjusted ? `<label class="art-check"><input type="checkbox" id="cn-samples" checked> ${t('bundleIncludeSamples')} · ${sh.samples}</label>` : '<span></span>'}
      <button type="button" class="btn btn-s btn-sm" onclick="openBundleAdjust(${xj(b.id)},null)">${t('bundleAdjust')}…</button>
    </div>`;
}

// openBundleAdjust's Create, in this window: keep the adjusted copy for the
// new vault's window instead of making it now (hub/bundles.js submitBundleAdjust).
function cnAdjusted(id, spec) {
  closeModal();
  CN.sel = id;
  CN.adjusted = { id, spec };
  cnPick(id);
}

// The spec the new window will hand to api.bundle.create, or null for Blank.
function cnTemplateSpec() {
  const b = cnBundle();
  if (!b) return null;
  if (CN.adjusted?.id === b.id) return { id: b.id, group: b.group || 'genre', spec: CN.adjusted.spec };
  const box = q('#cn-samples');
  return { id: b.id, group: b.group || 'genre', spec: { ...b.spec, name: b.name, icon: b.icon, ...(box && !box.checked ? { includeSamples: false } : {}) } };
}

const cnNameTaken = (name) => S.nexuses.some((n) => n.name === name);
// Unity's "My project": a name is already there, free and selected, so a
// template is New → card → Create (UX-LAYOUT §13) and typing replaces it.
function cnDefaultName() {
  const base = t('nexusNew');
  for (let i = 1; ; i++) { const n = i === 1 ? base : `${base} ${i}`; if (!cnNameTaken(n)) return n; }
}
function cnNameErr(msg) {
  const el = q('#nx-name-err');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
  q('#nx-name')?.setAttribute('aria-invalid', msg ? 'true' : 'false');
}

// A taken name is said under the field as it is typed (not a toast), and the
// Locate folder line follows the name — <root>/<name>, as db/mirror.js names it.
function cnNameInput() {
  const name = q('#nx-name')?.value.trim() || '';
  cnNameErr(name && cnNameTaken(name) ? t('nexusNameTaken') : '');
  const loc = q('#cn-locate');
  if (loc) {
    const sep = CN.root.includes('\\') ? '\\' : '/';
    const dir = (name || 'Nexus').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim() || '_';
    loc.value = `${CN.root.replace(/[\\/]+$/, '')}${sep}${dir}`;
    loc.title = loc.value;
  }
}

// The tour walks through the Guide folder, so it needs App Docs.
function cnSyncTour() {
  const docs = q('#cn-appdocs'), tour = q('#cn-tour');
  if (!docs || !tour) return;
  tour.disabled = !docs.checked;
  if (!docs.checked) tour.checked = false;
  tour.closest('.cn-check')?.classList.toggle('cn-off', !docs.checked);
}

// Two steps under 1000 px (css); both panes at once above it.
function cnStep(step) {
  const box = q('.cn');
  if (!box) return;
  CN.step = step === 'form' ? 'form' : 'pick';
  box.dataset.step = CN.step;
  if (CN.step === 'form') q('#nx-name')?.focus();
  else q('#cn-grid [tabindex="0"]')?.focus();
}

function cnCancel() {
  api.window.createNexusDone(null);
}

async function cnSubmit() {
  if (CN.busy) return;
  const name = q('#nx-name')?.value.trim() || '';
  if (!name || cnNameTaken(name)) {
    cnNameErr(t(name ? 'nexusNameTaken' : 'nameRequired'));
    cnStep('form');
    return;
  }
  CN.busy = true;
  const btn = q('#cn-create');
  if (btn) btn.disabled = true;
  let id;
  try {
    id = await api.nexus.create(name, q('#nx-memo')?.value.trim() || '', q('#sel-color')?.value || null, S._nexusSavePath || null);
  } catch (_) {
    CN.busy = false;
    if (btn) btn.disabled = false;
    cnNameErr(t('nexusNameTaken'));
    cnStep('form');
    return;
  }
  const appDocs = !!q('#cn-appdocs')?.checked;
  const pending = { nexusId: id, template: cnTemplateSpec(), appDocs, tour: appDocs && !!q('#cn-tour')?.checked };
  try { localStorage.setItem(NEXUS_PENDING_GUIDE_KEY, JSON.stringify(pending)); } catch (_) { /* the vault is made; only the extras are lost */ }
  pushRecentNexus(id);
  await api.window.createNexusDone({ nexusId: id });
}

// The window's chrome: ✕ and Esc are Cancel; the title bar's other buttons
// are the Welcome window's. The modal (openBundleAdjust) gets its own close
// wiring here — bindNav(), which normally does it, never runs in this window.
function bindCreateNexusChrome() {
  q('#win-min')?.addEventListener('click', () => api.window.minimize());
  q('#win-max')?.addEventListener('click', () => api.window.toggleMaximize());
  q('#win-close')?.addEventListener('click', cnCancel);
  q('#modal-close')?.addEventListener('click', closeModal);
  q('#modal-overlay')?.addEventListener('click', (e) => { if (e.target === q('#modal-overlay')) closeModal(); });
  bindModalEscape();
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (!q('#modal-overlay')?.classList.contains('hidden') || q('#confirm-overlay')) return;
    e.preventDefault();
    cnCancel();
  });
}

// ── In the new vault's window ─────────────────────────────────────────────
// The pending work, in order: the template (at the root), App Docs (its own
// "Guide" folder), then the template's start page — or App Docs' when there
// is no template — then the tour. Runs once: the key is cleared first.
// Before Procress 25 the key held only the Nexus id, meaning "guide + tour".
async function runPendingCreate() {
  let raw = null;
  try { raw = localStorage.getItem(NEXUS_PENDING_GUIDE_KEY); } catch (_) { return; }
  if (!raw || !S.nexus) return;
  let p = null;
  try { p = JSON.parse(raw); } catch (_) { /* not JSON */ }
  if (typeof p === 'number' || typeof p === 'string') p = { nexusId: Number(p), appDocs: true, tour: true };
  if (!p || Number(p.nexusId) !== S.nexus.id) return;
  try { localStorage.removeItem(NEXUS_PENDING_GUIDE_KEY); } catch (_) {}
  let start = null, failed = false, made = null;
  if (p.template?.spec) {
    try { made = await api.bundle.create(S.nexus.id, null, p.template.spec); } catch (_) { made = null; }
    if (made?.ok) start = made.homeId || made.managerId || made.folderId;
    else failed = true;
  }
  if (p.appDocs) {
    const g = await Promise.resolve(createGuideBundle({ quiet: true })).catch(() => null);
    if (!start && g?.folderId) start = (findModuleNode(g.folderId)?.children || []).find((m) => m.kind === 'drafter')?.id || g.folderId;
  } else {
    await reloadModuleTree();
  }
  if (start) await openModuleNode(start).catch(() => {});
  if (failed) {
    toastAction(t('cnTemplateFailed'), t('cnRetry'), () => openBundlePicker(null, p.template.group || 'genre', p.template.id), 'err', 15000);
  } else if (made?.ok && !p.appDocs) toast(`${t('bundleCreated')} · ${made.modules}`, 'ok');
  if (p.tour) {
    try { await loadModule('src/renderer/guide.js'); } catch (_) { return; }
    if (typeof startNexusGuide === 'function') startNexusGuide();
  }
}

// Every "New Nexus" button — the Welcome window's, the app window's — opens
// this window; main parents it to whichever window asked.
function openCreateNexusWindow() {
  closeAllPopups();
  return api.window.openCreateNexus();
}
