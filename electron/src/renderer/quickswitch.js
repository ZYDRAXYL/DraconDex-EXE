'use strict';
// ═══ SEARCH LINK OVERLAY (progress.md Phase 20, was the v2.8 quick
// switcher) ═════════════════════════════════════════════════════════════
// Ctrl+P opens an Obsidian-style overlay (mockup docs/mockups/
// 24-searchlink.png) that searches EVERYTHING: v3 content items from
// db.viewerIndex (objects · events · dialogues · chapters · chats ·
// modules) merged with the legacy quickIndex entities, each row showing
// icon + name + 🔗 backlink count + `Major › Minor` breadcrumb + kind
// badge. Scope chips narrow by module-tree position relative to the
// focused pane's module (whole vault / same folder + same level /
// current subtree), a kind dropdown narrows by badge. Enter opens in the
// builder; Ctrl+Enter inserts `[[name]]` at the caret of the field that
// was focused before the overlay opened; Alt+Enter (or the 📌 action)
// pins the result onto the open Sketcher/Designer canvas — the deferred
// "pin from Search Link" hook from M5.

let _qsItems = [];    // merged, annotated result pool
let _qsShown = [];
let _qsIdx = 0;
let _qsScope = 'vault';           // 'vault' | 'level' | 'subtree'
let _qsKind = '';                 // '' = all badges
let _qsFocusEl = null;            // caret target for Ctrl+Enter
const QS_SCOPES = ['vault', 'level', 'subtree'];

// Subsequence fuzzy score: higher is better, -1 = no match.
// Bonuses for start-of-word hits and consecutive runs; light length penalty.
function fuzzyScore(query, name) {
  const nq = query.toLowerCase(), nn = name.toLowerCase();
  if (!nq) return 0;
  let qi = 0, score = 0, run = 0;
  for (let i = 0; i < nn.length && qi < nq.length; i++) {
    if (nn[i] === nq[qi]) {
      run++;
      score += 2 + run; // consecutive matches compound
      if (i === 0 || nn[i - 1] === ' ' || nn[i - 1] === '-' || nn[i - 1] === '_') score += 8;
      qi++;
    } else {
      run = 0;
    }
  }
  if (qi < nq.length) return -1;
  return score - Math.floor(nn.length / 4);
}

const QS_BADGE = { object: 'Object', event: 'Event', dialogue: 'Dialogue', chapter: 'Chapter', chat: 'Chat', module: 'Module' };
const QS_ICON_BY_KIND = { object: 'person', event: 'timeline', dialogue: 'narrator', chapter: 'book', chat: 'story', module: 'layer' };

async function qsBuildPool() {
  const [vi, qi, counts] = await Promise.all([
    api.viewer.index(S.nexus.id),
    api.wiki.quickIndex(S.nexus.id),
    api.wiki.linkCounts(S.nexus.id),
  ]);
  const items = [];
  const seen = new Set();
  for (const it of vi) {
    seen.add(it.key);
    const src = typeof findModuleNode === 'function' ? findModuleNode(it.moduleId) : null;
    const major = src && src.parent_id != null ? findModuleNode(src.parent_id) : null;
    items.push({
      key: it.key, name: it.name, color: it.color, handle: it.handle || '',
      badge: QS_BADGE[it.kind] || it.kind,
      icon: I[QS_ICON_BY_KIND[it.kind]] || I.layer,
      moduleId: it.moduleId,
      crumb: it.kind === 'module'
        ? (major ? `${major.name} › ${src?.name ?? it.name}` : (src && src.parent_id != null ? src.name : '—'))
        : (major ? `${major.name} › ${it.moduleName}` : it.moduleName),
      count: counts[it.key] || 0,
    });
  }
  // Legacy entities the viewer index doesn't carry (notes, legacy projects…)
  for (const e2 of qi) {
    if (seen.has(e2.key)) continue;
    items.push({
      key: e2.key, name: e2.name, color: e2.color,
      badge: e2.type.charAt(0).toUpperCase() + e2.type.slice(1),
      icon: I[e2.module] || I.layer,
      moduleId: null, legacy: e2.module,
      crumb: t(e2.module) || e2.module,
      count: counts[e2.key] || 0,
    });
  }
  return items;
}

// ── Scope evaluation against the module tree ────────────────────────────
function qsDescendants(id) {
  const out = new Set([id]);
  const m = findModuleNode(id);
  for (const c of (m?.children || [])) out.add(c.id);
  return out;
}

function qsInScope(item) {
  if (_qsScope === 'vault') return true;
  const ctx = S.activeModuleNode;
  if (!ctx || item.moduleId == null) return _qsScope === 'vault';
  if (_qsScope === 'level') {
    const src = findModuleNode(item.moduleId);
    if (!src) return false;
    return (src.parent_id ?? null) === (ctx.parent_id ?? null);
  }
  // subtree: the context module and everything below it
  return qsDescendants(ctx.id).has(item.moduleId);
}

// ── Actions ─────────────────────────────────────────────────────────────
function qsInsertLink(name) {
  const el = _qsFocusEl;
  if (!el || !/^(TEXTAREA|INPUT)$/.test(el.tagName) || !document.contains(el)) {
    toast(t('qsNoInsertTarget'), 'error');
    return false;
  }
  const s = el.selectionStart ?? el.value.length, en = el.selectionEnd ?? s;
  el.value = el.value.slice(0, s) + `[[${name}]]` + el.value.slice(en);
  el.selectionStart = el.selectionEnd = s + name.length + 4;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  return true;
}

async function qsPinToCanvas(item) {
  const m = S.activeModuleNode;
  if (m?.kind === 'sketcher' && S.sketcherData?.pageId) {
    const board = q('#sk-board');
    const zoom = (typeof skTool !== 'undefined' && skTool.zoom[m.id]) || 1;
    const px = board ? (board.scrollLeft + board.clientWidth / 2) / zoom : 800;
    const py = board ? (board.scrollTop + board.clientHeight / 2) / zoom : 550;
    await api.sketcher.addPin(S.sketcherData.pageId, item.key, px, py);
    await openModuleNode(m.id);
    toast(t('created'), 'ok');
    return true;
  }
  if (m?.kind === 'designer') {
    const c = typeof designViewportCenter === 'function' ? designViewportCenter() : { x: 1000, y: 700 };
    await api.designer.createNode(m.id, 'box', c.x, c.y, '', '#38bdf8', item.key);
    await openModuleNode(m.id);
    toast(t('created'), 'ok');
    return true;
  }
  toast(t('qsPinHint'), 'error');
  return false;
}

async function qsOpenItem(item) {
  if (/^(tlev|sdlg)_/.test(item.key)) {
    if (item.moduleId != null) await openModuleNode(item.moduleId);
    return;
  }
  await openEntityByKey(item.key);
}

// ── Overlay ─────────────────────────────────────────────────────────────
// `seed` pre-fills the query — used by the sidebar search box, which hands its
// text over rather than rendering its own (legacy-only) result list.
async function openQuickSwitcher(seed = '') {
  if (!S.nexus) { toast(t('nexusSelectFirst'), 'error'); return; }
  document.getElementById('qs-overlay')?.remove();
  const ae = document.activeElement;
  _qsFocusEl = ae && /^(TEXTAREA|INPUT)$/.test(ae.tagName) ? ae : null;

  _qsItems = await qsBuildPool();
  const byKey = new Map(_qsItems.map(e => [e.key, e]));
  const badges = [...new Set(_qsItems.map(e => e.badge))].sort();
  const canPin = ['sketcher', 'designer'].includes(S.activeModuleNode?.kind);

  const ov = document.createElement('div');
  ov.id = 'qs-overlay';
  ov.innerHTML = `
    <div id="qs-box">
      <div class="qs-inputrow">
        <span class="qs-glass">${I.search || '🔍'}</span>
        <input id="qs-input" placeholder="${t('qsPlaceholder')}" autocomplete="off" spellcheck="false">
        <span class="qs-kbd" data-no-i18n>Ctrl+P</span>
      </div>
      <div class="qs-filters">
        <span class="qs-flabel">${t('qsScope')}:</span>
        <span class="qs-chip" data-scope="vault">${t('qsScopeVault')}</span>
        <span class="qs-chip" data-scope="level">${t('qsScopeLevel')}</span>
        <span class="qs-chip" data-scope="subtree">${t('qsScopeSubtree')}</span>
        <span class="qs-flabel" style="margin-left:auto">${t('qsKind')}:</span>
        <select id="qs-kind">
          <option value="">${t('qsAllKinds')}</option>
          ${badges.map(b => `<option value="${x(b)}" ${b === _qsKind ? 'selected' : ''}>${x(b)}</option>`).join('')}
        </select>
      </div>
      <div id="qs-list"></div>
      <div class="qs-foot">
        <span data-no-i18n>↑↓ ${t('qsSelectHint')}</span>
        <span><b data-no-i18n>Enter</b> ${t('qsOpenHint')}</span>
        <span><b data-no-i18n>Ctrl+Enter</b> ${t('qsInsertHint')}</span>
        ${canPin ? `<span><b data-no-i18n>Alt+Enter</b> ${t('qsPinHint')}</span>` : ''}
        <span><b data-no-i18n>Tab</b> ${t('qsScopeHint')}</span>
        <span class="qs-count" id="qs-count"></span>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const input = ov.querySelector('#qs-input');
  const list = ov.querySelector('#qs-list');

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    ov.remove();
  };

  const paintChips = () => {
    ov.querySelectorAll('.qs-chip').forEach(el =>
      el.classList.toggle('act', el.dataset.scope === _qsScope));
  };

  const paint = () => {
    if (!_qsShown.length) {
      list.innerHTML = `<div class="qs-empty">${t('qsNoResults')}</div>`;
    } else {
      list.innerHTML = _qsShown.map((e, i) => `
        <div class="qs-item ${i === _qsIdx ? 'active' : ''}" data-i="${i}">
          <span class="qs-icon">${e.icon}</span>
          <span class="dot" style="background:${e.color || 'var(--accent)'}"></span>
          <span class="name">${x(e.name)}</span>
          ${e.handle ? `<span class="qs-handle" data-no-i18n>@${x(e.handle)}</span>` : ''}
          ${e.count ? `<span class="qs-lc" data-no-i18n>🔗 ${e.count}</span>` : ''}
          ${canPin ? `<span class="qs-pin" data-i="${i}" title="${t('qsPinHint')}">📌</span>` : ''}
          <span class="qs-crumb" data-no-i18n>${x(e.crumb)}</span>
          <span class="ek" data-no-i18n>${x(e.badge)}</span>
        </div>`).join('');
      list.querySelector('.qs-item.active')?.scrollIntoView({ block: 'nearest' });
    }
    const cnt = ov.querySelector('#qs-count');
    if (cnt) cnt.textContent = `${_qsShown.length} ${t('qsResults')}`;
    paintChips();
  };

  const update = () => {
    const qv = input.value.trim();
    const pool = _qsItems.filter(e => qsInScope(e) && (!_qsKind || e.badge === _qsKind));
    if (!qv) {
      const recent = (S.recentEntities || []).map(k => byKey.get(k))
        .filter(e => e && qsInScope(e) && (!_qsKind || e.badge === _qsKind));
      _qsShown = (recent.length ? recent : pool).slice(0, 20);
    } else {
      // Process 8 part 1: a module can also be found by its handle. Scored as
      // a separate candidate and the better of the two wins, rather than
      // fuzzy-matching over "name handle" as one string — that would let a
      // query straddle the boundary and match neither field on its own.
      _qsShown = pool
        .map(e => ({ e, s: Math.max(fuzzyScore(qv, e.name), e.handle ? fuzzyScore(qv, e.handle) : -1) }))
        .filter(r => r.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
        .map(r => r.e);
    }
    _qsIdx = 0;
    paint();
  };

  const accept = async (mode) => {
    const e = _qsShown[_qsIdx];
    if (!e) return;
    if (mode === 'insert') {
      close();
      qsInsertLink(e.name);
      return;
    }
    if (mode === 'pin') {
      close();
      await qsPinToCanvas(e);
      return;
    }
    close();
    await qsOpenItem(e);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); _qsIdx = Math.min(_qsIdx + 1, _qsShown.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _qsIdx = Math.max(_qsIdx - 1, 0); paint(); }
    else if (e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation();
      _qsScope = QS_SCOPES[(QS_SCOPES.indexOf(_qsScope) + (e.shiftKey ? -1 : 1) + QS_SCOPES.length) % QS_SCOPES.length];
      update();
    }
    else if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      accept(e.ctrlKey || e.metaKey ? 'insert' : e.altKey ? 'pin' : 'open');
    }
  };

  document.addEventListener('keydown', onKey, true);
  input.addEventListener('input', update);
  ov.querySelectorAll('.qs-chip').forEach(el =>
    el.addEventListener('click', () => { _qsScope = el.dataset.scope; update(); input.focus(); }));
  ov.querySelector('#qs-kind').addEventListener('change', (e) => { _qsKind = e.target.value; update(); input.focus(); });
  list.addEventListener('click', (e) => {
    const pin = e.target.closest('.qs-pin');
    if (pin) { _qsIdx = Number(pin.dataset.i); accept('pin'); return; }
    const row = e.target.closest('.qs-item');
    if (row) { _qsIdx = Number(row.dataset.i); accept('open'); }
  });
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

  if (seed) input.value = seed;
  update();
  input.focus();
  // Caret to the end so the seeded text reads as "already typed" and the next
  // keystroke continues it instead of replacing a selection.
  if (seed) input.setSelectionRange(seed.length, seed.length);
}
