'use strict';
// ═══ Content-item "minor module" pages (Plan part4) ═══════════════════
// A content item is a row living INSIDE a module's own data — one
// Classifier object, one Chronicler event, one Author chapter, one
// ChatScribe session, one Designer node — NOT a `module`-table row (that's
// the pre-existing "Add Minor Module" feature, a different, already-shipped
// concept). This file is the per-kind registry (ITEM_KIND) plus the shared
// open/render machinery that gives one content item its own Builder tab,
// alongside its existing inline treatment inside the owning module's view.
//
// Every ITEM_KIND entry's list(moduleId) is the single fetch primitive,
// reused by the Nest tree's lazy expand (hub.js's ensureNestItemsLoaded),
// this file's own openItemNode, and fetchOneItem below — the same "fetch
// the parent-scoped list, find by id" convention src/renderer/mod/
// chronicler.js's openChroniclerEventModal already established, generalized
// instead of hand-copied per kind. Both the item's own page and the owning
// module's inline view always re-fetch fresh through this same path, so
// neither ever renders a stale hand-copied object.

const ITEM_KIND = {
  classifier: {
    badgeKey: 'itemBadgeClassifierObject',
    icon: () => I.layer,
    async list(moduleId) { return api.classifier.getObjects(moduleId); },
    nameOf: (o) => o.name,
    async renderBody(o, m) {
      // Single-object variant of getObjectsFull's hydration — 1 object is not a
      // fan-out, so it stays a hand-built shape. Keep the two in step: levels
      // and the link index were added to both in Process 8 part 1.
      await loadModule('src/renderer/timeline.js');
      const [attrs, objTemplates, levels, relations, index] = await Promise.all([
        api.classifier.getAttrs(o.id),
        api.classifier.getObjectTemplates(m.id, o.id),
        api.classifier.getLevels(o.id),
        api.viewer.getRelations(S.nexus.id),
        api.viewer.index(S.nexus.id),
      ]);
      const attrMap = {}, conditionMap = {}, levelMap = {};
      for (const a of attrs) { attrMap[a.template_ref] = a.attribute_value; conditionMap[a.template_ref] = a.condition_value; }
      for (const l of levels) (levelMap[l.template_ref] ||= []).push(l);
      setClassifierLinkData(relations, index);
      const templates = objTemplates.filter(tp => tp.object_ref == null);
      const hydrated = {
        ...o, attrMap, conditionMap, levelMap,
        privateTemplates: objTemplates.filter(tp => tp.object_ref === o.id)
          .map(tp => ({ id: tp.id, description: tp.description, value: attrMap[tp.id] || '' })),
      };
      return renderClassifierObjectDetail(m, hydrated, templates);
    },
  },
  chronicler: {
    badgeKey: 'itemBadgeChroniclerEvent',
    icon: () => I.timeline,
    async list(moduleId) {
      const tls = await api.timeline.getModuleTimelines(moduleId);
      const lists = await Promise.all(tls.map(tl =>
        api.timeline.getEvents(tl.id).then(evs => evs.map(e => ({ ...e, __parentId: tl.id })))));
      return lists.flat();
    },
    nameOf: (e) => e.event_name,
    async renderBody(ev) {
      // The inspector body renders the event's linked-elements section, which
      // reads from module-level caches loadChroniclerData fills. This page can
      // be opened without the module's own view ever having loaded, so prime
      // them here too (same reasoning as the classifier entry above).
      await loadModule('src/renderer/timeline.js');
      await reloadChroniclerLinks();
      return `<div class="chr-insp-body" id="item-chr-insp">${await buildChroniclerEventInspectorHtml(ev, ev.__parentId)}</div>`;
    },
  },
  author: {
    badgeKey: 'itemBadgeAuthorChapter',
    icon: () => I.book,
    async list(moduleId) { return api.author.getChapters(moduleId); },
    nameOf: (c) => c.name,
    async renderBody() { return `<div id="author-item-editor" class="scribe-editor au-editor"></div>`; },
    mount(node) {
      mountAuthorRichEditor(q('#author-item-editor'), node.item);
    },
  },
  scribe: {
    badgeKey: 'itemBadgeChatSession',
    icon: () => I.story,
    async list(moduleId) { return api.chatscribe.getSessions(moduleId); },
    nameOf: (s) => s.name,
    async renderBody(s) {
      const messages = await api.chatscribe.getMessages(s.id);
      return buildChatBubblesHtml(s, messages, {
        streamId: 'item-chs-stream', inputId: 'item-chs-input', onSend: `sendItemChatMessage(${s.id})`,
      });
    },
    mount() {
      const el = q('#item-chs-stream');
      if (el) el.scrollTop = el.scrollHeight;
      bindChatBubbleDrag('item-chs-stream');
    },
  },
  designer: {
    badgeKey: 'itemBadgeDesignNode',
    icon: () => I.relation,
    async list(moduleId) { return api.designer.getNodes(moduleId); },
    // design_node has no dedicated name column — best-effort label from its
    // own short text, else a shape glyph + id (Plan part4 #6).
    nameOf: (n) => n.node_text ? (n.node_text.length > 24 ? n.node_text.slice(0, 24) + '…' : n.node_text) : `${DG_SHAPE_GLYPH[n.shape] || '□'} #${n.id}`,
    async renderBody(n) {
      return `${buildDesignNodeFieldsHtml(n, { prefix: 'item-dn' })}
        <div class="mfoot"><button class="btn btn-p" onclick="saveItemDesignNode(${n.id})">${t('save')}</button></div>`;
    },
  },
};

async function fetchOneItem(itemKind, moduleId, id) {
  const items = await ITEM_KIND[itemKind].list(moduleId);
  return items.find(i => i.id === id);
}

async function openItemNode(itemKind, moduleId, id) {
  const reg = ITEM_KIND[itemKind];
  if (!reg) return;
  const key = builderPageKey({ kind: 'item', itemKind, moduleId, id });
  const item = await fetchOneItem(itemKind, moduleId, id);
  if (!item) {
    // Stale tab — the item was deleted elsewhere while this tab existed.
    const b = builderState();
    b.panes.forEach((pane, idx) => { if (pane.tabs.includes(key)) builderCloseTab(idx, key); });
    toast(t('itemNotFound'), 'error');
    return;
  }
  const m = findModuleNode(moduleId);
  const bodyHtml = await reg.renderBody(item, m);
  S.activeItemNode = { itemKind, moduleId, id, item, m, bodyHtml };
  S.activeModuleNode = null;
  S.filePreview = null;
  S.sageHut = null;
  S.importDockPage = false;
  if (typeof builderNavigate === 'function') builderNavigate({ kind: 'item', itemKind, moduleId, id });
  S.itemNodeCache.set(key, { name: reg.nameOf(item), color: m?.color_code || 'var(--accent)', badge: t(reg.badgeKey), icon: reg.icon() });
  renderNexusHome();
}

function buildItemPageHtml(node) {
  const reg = ITEM_KIND[node.itemKind];
  const col = node.m?.color_code || 'var(--accent)';
  return `<div class="detail-head module-head" style="border-left:4px solid ${x(col)};padding-left:12px">
      <h2 style="margin:0;font-size:1.15em">${x(reg.nameOf(node.item))} <span class="kind-chip" data-no-i18n>${x(t(reg.badgeKey))}</span></h2>
      <div class="drafter-hint">${x(node.m?.name || '')}</div>
    </div>
    <div class="item-page-body">${node.bodyHtml}</div>`;
}

// ── ChatScribe item page: send handler mirroring sendChatMessage, but
// scoped to a specific session id rather than S.chatScribeData's current
// selection, and refreshing via openItemNode instead of renderNexusHome. ──
async function sendItemChatMessage(sessionId) {
  const el = q('#item-chs-input');
  const text = el?.value.trim();
  if (!text) return;
  await api.chatscribe.createMessage(sessionId, text);
  invalidateNestItems(S.activeItemNode.moduleId);
  await openItemNode('scribe', S.activeItemNode.moduleId, sessionId);
}

// ── Designer item page: save handler mirroring submitDesignNode, but
// reading the id-prefixed fields (buildDesignNodeFieldsHtml({prefix:
// 'item-dn'})) and refreshing via openItemNode instead of openModuleNode. ──
async function saveItemDesignNode(id) {
  const n = S.activeItemNode.item;
  const text = q('#item-dn-text')?.value ?? n.node_text;
  const shape = q('#item-dn-shape')?.value || n.shape;
  const colorEl = document.querySelector('#item-dn-colors .sk-swatch.act');
  const color = colorEl ? colorEl.dataset.color : n.color;
  const moduleId = S.activeItemNode.moduleId;
  await api.designer.updateNode(id, shape, text, color);
  invalidateNestItems(moduleId);
  await openItemNode('designer', moduleId, id);
  toast(t('saved'), 'ok');
}
