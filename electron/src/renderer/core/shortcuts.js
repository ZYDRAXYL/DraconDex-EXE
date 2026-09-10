// Global keyboard shortcuts (Ctrl+P quick switch, tab cycling, …) and
// returnToNexus().
// ═══ GLOBAL SHORTCUTS ═════════════════════════════════════
function bindGlobalShortcuts() {
  document.addEventListener('keydown', async (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    const modalOpen = !q('#modal-overlay')?.classList.contains('hidden') || q('#confirm-overlay');
    const inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (key === 'p') { // quick switcher — always available
      e.preventDefault();
      try {
        if (typeof openQuickSwitcher !== 'function') await loadModule('src/renderer/quickswitch.js');
        openQuickSwitcher();
      } catch (_) {}
      return;
    }
    if (modalOpen) return;
    if (key === 'w') { // close active tab (builder pane tab in nexus view)
      e.preventDefault();
      if (!S.activeModule && S.view === 'nexus' && typeof builderCloseActiveTab === 'function') await builderCloseActiveTab();
      else if (S.activeEntityTabKey) await closeEntityTab(S.activeEntityTabKey);
      return;
    }
    if (key === 'tab') { // cycle tabs (focused pane in nexus view, else legacy)
      e.preventDefault();
      if (!S.activeModule && S.view === 'nexus' && typeof builderCycleTab === 'function') {
        await builderCycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      const ring = S.entityTabs.map(tb => tb.key);
      if (!ring.length) return;
      const cur = ring.indexOf(S.activeEntityTabKey);
      const next = ring[(cur + (e.shiftKey ? -1 : 1) + ring.length) % ring.length];
      await switchEntityTab(next);
      return;
    }
    if (inInput && !['e', 'n'].includes(key)) return;
    // Process 7 part 2: app-wide session undo/redo. Skipped while inInput
    // (the `z` guard above already excludes it) so a focused textarea's own
    // native undo (mdeditor.js) is never hijacked.
    if (key === 'z' && S.nexus) {
      e.preventDefault();
      await handleHistoryShortcut(e.shiftKey ? 'redo' : 'undo');
      return;
    }
    if (key === 'n' && S.activeModule === 'scribe' && S.nexus) { // new note
      e.preventDefault();
      openNoteModal();
      return;
    }
    // Ctrl+E is handled by the focused editor itself (mdeditor.js); this is
    // the fallback when focus is outside it.
    if (key === 'e' && typeof _mdActive?.toggleMode === 'function' && !inInput) {
      e.preventDefault();
      _mdActive.toggleMode();
    }
  });
}

// Process 7 part 2 — app-wide session undo/redo. history:undo/history:redo
// (main.js) resolve the active vault and reverse/reapply the last tracked
// change (electron/src/db/undo.js); this just refreshes whatever's visible
// afterward, since an arbitrary undone change could touch the module tree,
// the currently open module's items, or both.
async function handleHistoryShortcut(direction) {
  const result = direction === 'redo' ? await api.history.redo() : await api.history.undo();
  if (!result.ok) {
    if (result.reason === 'irreversible') toast(t('historyIrreversible'), 'error');
    return;
  }
  await reloadModuleTree();
  if (S.activeModuleNode && typeof loadInspectorData === 'function') {
    try { await loadInspectorData(S.activeModuleNode.id); } catch (_) {}
  }
  // The tree and the inspector were the only things repainted, so the open
  // module's own body kept showing pre-undo content until something else
  // re-rendered it. Re-running the kind's loader and repainting is what makes
  // an undo visible where the edit actually happened — the Custom-calendar
  // made this obvious (undoing a month-length change left the old grid up),
  // but it applies to every kind.
  if (S.activeModuleNode) {
    try {
      await openModuleNode(S.activeModuleNode.id);
    } catch (_) { renderNexusHome(); }
  }
  toast(t(direction === 'redo' ? 'historyRedone' : 'historyUndone'), 'ok');
}

function returnToNexus() {
  S.activeModule = null;
  S.view = 'nexus';
  renderProjectTabs();
  renderNexusHome();
}

