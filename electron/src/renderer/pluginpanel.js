'use strict';
// ═══ Plugin panels (v4.3.0) ════════════════════════════════════════════════
// An installed plugin may declare `panels` in its manifest; each one becomes a
// button next to the Module Inspector toggle and, when opened, replaces the
// Inspector dock with the plugin's own page. This is the generic contribution
// point — nothing here knows about any particular plugin.
//
// The page runs in a <webview>, i.e. its own webContents with
// preload-plugin.js and no window.api, exactly like a plugin WINDOW. main.js's
// hardenWebviewAttach vets every attach; this file only decides what to render.
//
// Panel HTML mirrors versions.js's Version History panel: same
// `.module-inspector` root class (so the dock's resize handle and collapse
// toggle keep working for free) plus a modifier class, and the same
// early-return hook in buildInspectorHtml.

// Cached from api.plugin.list(). Refreshed at boot and whenever the plugin
// list changes (install/uninstall/launch/stop) — see pluginRefreshSection()
// in plugin.js, which calls this.
async function loadPluginPanels() {
  try {
    const list = await api.plugin.list();
    S.pluginPanels = list
      // A plugin missing a declared dependency contributes no panel button —
      // same gate as plugin:launch. Opening its page would run a plugin whose
      // requirements aren't met, with no way for the user to see why from the
      // pane head; the Plugins settings page is where that's explained.
      .filter((p) => Array.isArray(p.panels) && p.panels.length && !(p.missingDeps || []).length)
      .map((p) => ({ pluginKey: p.plugin_key, pluginName: p.name, dir: p.dir, contextKinds: p.contextKinds || [], panels: p.panels }));
  } catch (e) {
    // A plugin list that fails to load must not take the whole Nexus down —
    // the panel buttons simply don't appear.
    console.error('plugin panel load error:', e);
    S.pluginPanels = [];
  }
  // Drop an open panel whose plugin just went away (uninstall while open).
  if (S.pluginPanel && !findPluginPanel(S.pluginPanel.pluginKey, S.pluginPanel.panelId)) S.pluginPanel = null;
}

function findPluginPanel(pluginKey, panelId) {
  const owner = (S.pluginPanels || []).find((p) => p.pluginKey === pluginKey);
  if (!owner) return null;
  const panel = owner.panels.find((p) => p.id === panelId);
  return panel ? { owner, panel } : null;
}

// ═══ Open / close ══════════════════════════════════════════════════════════
// Same shape as openVersionPanel: set state, full re-render. No data to fetch
// first — the plugin loads its own state through pluginApi once it boots.
function openPluginPanel(pluginKey, panelId) {
  if (!S.activeModuleNode) return;
  if (!findPluginPanel(pluginKey, panelId)) return;
  S.pluginPanel = { pluginKey, panelId, moduleId: S.activeModuleNode.id };
  renderNexusHome();
}

function closePluginPanel() {
  S.pluginPanel = null;
  renderNexusHome();
}

function togglePluginPanel(pluginKey, panelId) {
  const open = S.pluginPanel && S.pluginPanel.pluginKey === pluginKey && S.pluginPanel.panelId === panelId;
  if (open) closePluginPanel(); else openPluginPanel(pluginKey, panelId);
}

// ═══ Pane-head buttons ═════════════════════════════════════════════════════
// Rendered by builderPaneHeadHtml immediately before the Module Inspector
// toggle. Only while a module is open, because the panel replaces that
// module's Inspector dock — with no module there is no dock to replace.
function pluginPanelButtonsHtml() {
  if (!S.activeModuleNode) return '';
  let html = '';
  for (const owner of S.pluginPanels || []) {
    for (const panel of owner.panels) {
      const active = S.pluginPanel?.pluginKey === owner.pluginKey && S.pluginPanel?.panelId === panel.id;
      // title/icon come from a downloaded manifest: escape them, and keep the
      // auto-translator off a name the plugin author chose.
      const label = panel.icon ? x(panel.icon) : I.layer;
      html += `<button class="btn btn-g btn-i bnav plgp-btn ${active ? 'active' : ''}" data-no-i18n
        onclick="togglePluginPanel(${xj(owner.pluginKey)},${xj(panel.id)})"
        title="${t('openPluginPanel')} — ${x(panel.title)}">${label}</button>`;
    }
  }
  return html;
}

// ═══ The dock replacement ══════════════════════════════════════════════════
// buildInspectorHtml swaps to this when a panel is open for the module.
// Width is baked into the template string for the same reason the Inspector
// bakes it (inspector.js's comment): the dock gets outerHTML-replaced, which
// would wipe an inline style applied after render.
function buildPluginPanelHtml(m) {
  const found = findPluginPanel(S.pluginPanel.pluginKey, S.pluginPanel.panelId);
  if (!found) return '';
  const { owner, panel } = found;
  const src = pluginPanelSrc(owner.dir, panel.entry);
  return `<aside class="module-inspector plugin-panel" style="width:${S.inspectorWidth}px">
    <div class="insp-head">${panel.icon ? `<span data-no-i18n>${x(panel.icon)}</span>` : I.layer}
      <span class="plgp-title" data-no-i18n>${x(panel.title)} — ${x(m.name)}</span>
      <button class="btn btn-g btn-i" onclick="closePluginPanel()" title="${t('closePluginPanel')}">&times;</button>
    </div>
    <webview id="plgp-view" class="plgp-view" src="${x(src)}" partition="persist:plugin-${x(owner.pluginKey)}"></webview>
  </aside>`;
}

// file:// URL for a panel entry. `dir` is the absolute plugin directory the
// main process reported — the renderer never composes the data-dir layout
// itself. Each segment is encoded so a space or '#' in the data path can't
// truncate the URL.
function pluginPanelSrc(dir, entry) {
  const base = String(dir).replace(/\\/g, '/');
  const encoded = base.split('/').map(encodeURIComponent).join('/');
  const lead = encoded.startsWith('/') ? '' : '/';
  return `file://${lead}${encoded}/${entry.split('/').map(encodeURIComponent).join('/')}`;
}

// ═══ Mount hook (core/views.js runBuilderMounts) ═══════════════════════════
// Wires the host<->panel message channel. `ipc-message` is the webview's own
// event for ipcRenderer.sendToHost from the guest — it never reaches the main
// process, so nothing here can widen what the plugin can touch.
function mountPluginPanel() {
  const d = S.pluginPanel;
  if (!d || S.activeModuleNode?.id !== d.moduleId) return;
  const view = q('#plgp-view');
  if (!view || view.dataset.wired === '1') return;
  view.dataset.wired = '1';

  const found = findPluginPanel(d.pluginKey, d.panelId);
  const sharesModule = !!found?.owner.contextKinds.includes('module');

  view.addEventListener('ipc-message', (ev) => {
    if (ev.channel === 'plugin:close') { closePluginPanel(); return; }
    if (ev.channel !== 'plugin:msg') return;
    const msg = ev.args?.[0];
    // The only host->plugin data today, and only for a plugin whose manifest
    // declared `permissions.context: ["module"]` and had it shown at install.
    // Deliberately minimal: identity and kind, never the module's content.
    if (msg?.type === 'getContext') {
      const m = S.activeModuleNode;
      view.send('pluginhost:msg', {
        type: 'context',
        context: sharesModule && m ? { moduleId: m.id, moduleName: m.name, kind: m.kind } : null,
      });
    }
  });
}
