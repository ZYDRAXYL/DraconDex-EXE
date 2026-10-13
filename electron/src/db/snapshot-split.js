'use strict';
// ═══ One snapshot pass, cut per module (Procress 20 part 1) ═════════════════
// The Locate mirror writes every module as its own .ddata + .dpage — the
// snapshot serializeVault(nexusId, [id]) gives for that one module. Asking
// for it module by module costs ~30 queries each (6–7 ms; 3.5 s for 520
// modules), which is what made every sync take seconds. One pass over the
// whole vault (or over a set of ids) is ~30 queries in total; this cuts its
// result into the per-module snapshots that pass would have given one by one.
//
// Keep this next to the shape it cuts: a section added to serializeVault
// must be added to SECTIONS below. test/locate.test.mjs compares the cut
// against serializeVault(nexusId, [id]) for every kind, so a section that is
// missed here fails a test rather than silently leaving the mirror short.
//
// exportedAt is left out on purpose: it is the time of the pass, so a file
// that carried it would differ on every sync and be rewritten every time.

// [section, child, how a row finds its module]: 'm' = its own moduleId,
// otherwise the name of the sibling list whose ids it points at, and the key.
const SECTIONS = {
  classifier: [['objects', 'm'], ['templates', 'm'], ['attributes', 'objects', 'objectId'], ['levels', 'objects', 'objectId']],
  locator: [['maps', 'm'], ['areas', 'maps', 'mapId'], ['points', 'areas', 'areaId']],
  chronicler: [['timelines', 'm'], ['events', 'timelines', 'timelineId']],
  wanderer: [['mapEvents', 'm']],
  narrator: [['dialogues', 'm'], ['edges', 'm'], ['talks', 'dialogues', 'dialogueId'], ['choiceOptions', 'talks', 'talkId']],
  author: [['chapters', 'm']],
  chatscribe: [['sessions', 'm'], ['messages', 'sessions', 'sessionId']],
  sketcher: [['pages', 'm'], ['strokes', 'pages', 'pageId'], ['pins', 'pages', 'pageId']],
  designer: [['nodes', 'm'], ['edges', 'm']],
  exhibitor: [['nodes', 'm'], ['views', 'm']],
  diviner: [['tables', 'm'], ['entries', 'tables', 'tableId'], ['rolls', 'tables', 'tableId']],
};
const TOP = ['pageBlocks', 'moduleUi', 'moduleTags'];
// Lists whose query has no ORDER BY: a scoped pass and a whole pass may
// return them in different orders, and the mirror compares bytes — so they
// are put in one order here.
const cmp = (...keys) => (a, b) => {
  for (const k of keys) {
    const x = a[k] ?? '', y = b[k] ?? '';
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
};
const SORT = {
  moduleUi: cmp('key'), moduleTags: cmp('tagName'), 'classifier.attributes': cmp('objectId', 'templateId'),
  'narrator.edges': cmp('fromId', 'toId', 'label'), 'designer.edges': cmp('fromId', 'toId', 'label'),
};

function splitByModule(snap) {
  const out = new Map();
  if (!snap || !Array.isArray(snap.modules)) return out;
  const ids = snap.modules.map((m) => m.id);
  const group = (rows, keyOf) => {
    const g = new Map();
    for (const r of rows || []) {
      const k = keyOf(r);
      if (k == null) continue;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(r);
    }
    return g;
  };
  const top = {};
  for (const k of TOP) top[k] = group(snap[k], (r) => r.moduleId);
  const parts = {}; // section -> child -> Map(moduleId -> rows)
  for (const [sec, children] of Object.entries(SECTIONS)) {
    parts[sec] = {};
    const ownerOf = {}; // child -> Map(row id -> moduleId)
    for (const [child, via, key] of children) {
      const rows = snap[sec]?.[child] || [];
      const owner = via === 'm' ? (r) => r.moduleId : (r) => ownerOf[via]?.get(r[key]);
      parts[sec][child] = group(rows, owner);
      ownerOf[child] = new Map(rows.map((r) => [r.id, owner(r)]));
    }
  }
  const dateByKey = new Map((snap.lookups?.dates || []).map((d) => [d.key, d]));
  for (const id of ids) {
    const pick = (g, sortKey) => {
      const rows = (g.get(id) || []).slice();
      return SORT[sortKey] ? rows.sort(SORT[sortKey]) : rows;
    };
    const m = {};
    for (const k of TOP) m[k] = pick(top[k], k);
    for (const [sec, children] of Object.entries(SECTIONS)) {
      m[sec] = {};
      for (const [child] of children) m[sec][child] = pick(parts[sec][child], `${sec}.${child}`);
    }
    const mod = snap.modules.find((x) => x.id === id);
    // lookups, exactly as serializeVault builds them for a one-module pass
    const colors = new Set();
    const add = (c) => { if (c) colors.add(c); };
    add(snap.nexus?.colorCode);
    add(mod.iconColorCode); add(mod.colorCode);
    m.moduleTags.forEach((r) => add(r.colorCode));
    m.classifier.objects.forEach((r) => add(r.colorCode));
    m.locator.maps.forEach((r) => add(r.colorCode));
    m.locator.areas.forEach((r) => add(r.colorCode));
    m.chronicler.timelines.forEach((r) => add(r.colorCode));
    m.chronicler.events.forEach((r) => add(r.colorCode));
    m.narrator.dialogues.forEach((r) => add(r.colorCode));
    const hashtags = [];
    const seen = new Set();
    for (const r of m.moduleTags) if (!seen.has(r.tagName)) { seen.add(r.tagName); hashtags.push({ name: r.tagName, colorCode: r.colorCode || null }); }
    const dateKeys = new Set(m.chronicler.events.flatMap((e) => [e.startKey, e.endKey]).filter(Boolean));
    const dates = [...dateKeys].sort().map((k) => dateByKey.get(k)).filter(Boolean);
    out.set(id, {
      format: snap.format, version: snap.version, app: snap.app,
      nexus: snap.nexus,
      lookups: { colors: [...colors], hashtags, dates },
      modules: [mod], pageBlocks: m.pageBlocks, moduleUi: m.moduleUi, moduleTags: m.moduleTags,
      classifier: m.classifier, locator: m.locator, chronicler: m.chronicler, wanderer: m.wanderer,
      narrator: m.narrator, author: m.author, chatscribe: m.chatscribe, sketcher: m.sketcher,
      designer: m.designer, relations: [], notes: { folders: [], notes: [] }, calendarTemplates: [],
      exhibitor: m.exhibitor, modulePresets: [], diviner: m.diviner,
    });
  }
  return out;
}

// The per-module snapshots of `ids` (null = every module) — one scoped
// serializeVault pass per 400 ids (SQLite's bound-parameter limit).
function serializeModules(nexusId, ids = null) {
  const { serializeVault } = require('./sync');
  if (ids == null) return splitByModule(serializeVault(nexusId));
  const list = [...ids];
  const out = new Map();
  // never an empty list: serializeVault reads [] as "the whole vault"
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    for (const [id, s] of splitByModule(serializeVault(nexusId, chunk))) out.set(id, s);
  }
  return out;
}

module.exports = { splitByModule, serializeModules, SECTIONS };
