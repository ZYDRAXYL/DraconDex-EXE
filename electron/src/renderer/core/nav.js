// Nav rail + tab bars: nav-button visibility, the entity tab strip (now
// Scribe-note-only — Director/Navigator/Hero/Writer physically deleted,
// Process 2 Part 2) and its open/switch/close paths, the layout menu button
// and the title-bar vault label.

function updateTopNavButton(){
  const logoBtn = q('#nav-logo-btn');
  const inModule = !!S.activeModule;
  if(logoBtn){
    // process2 part1 #3: a collapsed hub always wins the logo slot, even
    // inside a legacy module — it's the app icon's only way back to expand
    // #left-panel now that #hub-toggle-btn lives inside it (see views.js's
    // #nav-logo-btn click handler for the matching click-priority change).
    if(S.leftPanelCollapsed){
      logoBtn.innerHTML = I.panelLeft;
      logoBtn.setAttribute('title', t('toggleHub'));
      logoBtn.classList.remove('is-return');
    } else {
      logoBtn.innerHTML = inModule
        ? I.return
        : `<img src="../src/assets/brand/DraconDex_WhiteOut.png" class="brand-img" alt="DraconDex">`;
      const title = !inModule ? 'DraconDex' : tr('Back to Nexus');
      logoBtn.setAttribute('title', title);
      logoBtn.classList.toggle('is-return', inModule);
    }
  }
  document.querySelectorAll('.nav-btn.nexus-only').forEach(btn => {
    btn.style.display = (!S.activeModule) ? '' : 'none';
  });
}

// Tabs stay visible across every module. The tab strip lives inline in the
// title bar (#builder-tabs, moved up from a second row below it),
// left-aligned with #main-area via #title-left-zone. It's Scribe's own note
// tabs now (Director/Navigator/Hero/Writer physically deleted, Process 2
// Part 2); v3 module tabs stay per-pane (Phase 19 — builder.js). The
// split-layout control lives next to it as its own #layout-menu-wrap button
// (renderLayoutMenuBtn below).
function renderProjectTabs(){
  updateTitlebarVault();
  const el = q('#builder-tabs');
  if(el){
    const entTabs = S.entityTabs.map(tab => `
      <button class="project-tab ${S.activeModule===tab.module && S.activeEntityTabKey===tab.key?'active':''}" onclick="switchEntityTab(${xj(tab.key)})" title="${x(tab.name)}">
        <span class="tab-dot" style="background:${tab.color}"></span>
        <span class="tab-name">${x(tab.name)}</span>
        <span class="tab-close" onclick="event.stopPropagation();closeEntityTab(${xj(tab.key)})" title="${t('closeTab')}">&times;</span>
      </button>
    `).join('');
    el.innerHTML = entTabs;
    el.classList.toggle('empty', !entTabs.trim());
  }
  renderLayoutMenuBtn();
}

// Title-bar split-layout picker: one trigger button + an overlay list of
// named preset shapes (Plan part4 #2 — builderResetToPreset resets the
// whole tree to a fresh named shape; arbitrary further splitting/closing
// happens per-pane via buttons in builderPaneHeadHtml, builder.js).
// Labels are numeric/symbolic ("1×"/"2×"/"3×"), matching the original
// 3-item menu's own data-no-i18n convention — no new i18n keys needed
// since there's nothing language-specific to translate. With an arbitrary
// tree there's no longer a single "current preset" to highlight against,
// so (unlike the old menu) no item shows an active state.
function renderLayoutMenuBtn(){
  const wrap = q('#layout-menu-wrap');
  const btn = q('#layout-menu-btn');
  const menu = q('#layout-menu');
  if(!wrap || !btn || !menu) return;
  wrap.style.display = S.nexus ? '' : 'none';
  if(!S.nexus) return;
  btn.textContent = '⊞';
  const items = [
    { name: '1',  glyph: '▢', label: '1×' },
    { name: '2h', glyph: '◫', label: '2×' },
    { name: '2v', glyph: '⬓', label: '2×' },
    { name: '3',  glyph: '⊟', label: '3×' },
  ];
  menu.innerHTML = items.map(it => `
    <button class="layout-menu-item" data-no-i18n onclick="builderResetToPreset('${it.name}');toggleLayoutMenu(false)">
      <span>${it.glyph}</span><span>${it.label}</span>
    </button>`).join('');
}

function toggleLayoutMenu(force){
  const menu = q('#layout-menu');
  const btn = q('#layout-menu-btn');
  if(!menu || !btn) return;
  const open = typeof force === 'boolean' ? force : menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  btn.classList.toggle('active', open);
  btn.setAttribute('aria-expanded', String(open));
}

function updateTitlebarVault(){
  const el = q('#titlebar-vault');
  if(el) el.textContent = S.nexus ? `${S.nexus.name} — DraconDex` : 'DraconDex';
}

// v3 module tabs are pane-scoped now (Phase 19): opening a module books it
// into the focused builder pane's tab row + history stack.
function upsertModuleTab(id){
  if (typeof builderNavigate === 'function') builderNavigate({ kind: 'module', id });
  renderProjectTabs();
}

// Legacy views rewrite #main-inner wholesale — drop the builder grid so
// their layout isn't trapped inside it (panes rebuild on return to nexus).
function leaveBuilderGrid(){
  q('#main-inner')?.classList.remove('builder-grid','bl-1','bl-2','bl-4');
}

function upsertEntityTab(entity, type, module) {
  const key = `${type}-${entity.id}`;
  const moduleColors = { note:'#0ea5e9' };
  const tab = { key, id:entity.id, type, module, name:entity.name, color: entity.color_code || moduleColors[type] || '#6366f1' };
  const idx = S.entityTabs.findIndex(t => t.key === key);
  if (idx >= 0) S.entityTabs[idx] = tab;
  else S.entityTabs.push(tab);
  S.activeEntityTabKey = key;
  renderProjectTabs();
}

async function switchEntityTab(key) {
  const tab = S.entityTabs.find(t => t.key === key);
  if (!tab) return;
  S.activeEntityTabKey = key;
  if (tab.type === 'note') {
    S.activeModule = 'scribe';
    S.view = 'scribe';
    document.querySelectorAll('.nav-btn[data-panel]').forEach(b => b.classList.remove('active'));
    q('.nav-btn[data-panel="scribe"]')?.classList.add('active');
    updateTopNavButton();
    await loadModule('src/renderer/scribe.js');
    S.scribeNote = await api.note.get(tab.id);
    await renderScribeView();
  } else {
    renderProjectTabs();
  }
}

async function closeEntityTab(key) {
  const idx = S.entityTabs.findIndex(t => t.key === key);
  if (idx < 0) return;
  const closing = S.entityTabs[idx];
  const wasActive = S.activeModule === closing.module && S.activeEntityTabKey === key;
  S.entityTabs.splice(idx, 1);
  if (!wasActive) { renderProjectTabs(); return; }
  const sameMod = S.entityTabs.filter(t => t.module === closing.module);
  if (sameMod.length > 0) {
    await switchEntityTab(sameMod[Math.min(idx, sameMod.length - 1)].key);
    return;
  }
  S.activeEntityTabKey = null;
  if (closing.type === 'note') { S.scribeNote = null; if (S.activeModule==='scribe') await renderScribeView(); }
  renderProjectTabs();
}

