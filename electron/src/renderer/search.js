// With a vault open, #left-panel-inner IS the Nexus Nest tree, so the search
// box hands off to the quick switcher, which searches the whole vault (v3
// module tree + Scribe notes). With no vault open there's nothing to search
// (Director's own global-search results list was deleted with it, Process 2
// Part 2).
let _searchTimeout;
function bindSearch() {
  const inp=q('#search-input'); if(!inp) return;
  inp.addEventListener('input',()=>{
    clearTimeout(_searchTimeout);
    _searchTimeout=setTimeout(async()=>{
      const val=inp.value.trim();
      if(!val){ if(!S.nexus) switchView(S.view); return; }
      if(!S.nexus) return;
      inp.value='';
      if(typeof openQuickSwitcher!=='function') await loadModule('src/renderer/quickswitch.js');
      openQuickSwitcher(val);
    },300);
  });
}

// All functions declared in regular <script> tags are already global.
// No Object.assign needed — lazy-loaded modules (timeline/relation/map/hashtag)
// register their own globals when first loaded.

// ═══ START ═════════════════════════════════════════════
// The .catch is what guarantees the boot splash comes down: init() ends with
// __splash.finish(), so a throw anywhere above would otherwise leave the
// full-window overlay covering the app until its 20s watchdog fires.
init().catch(err => { console.error('init failed', err); window.__splash?.finish(); });
