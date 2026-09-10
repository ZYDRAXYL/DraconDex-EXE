'use strict';
// Cloud sync — Token Sync (Supabase). Snapshot-based: push serializes the
// whole vault (v3 module tree + notes + relations) into one JSON payload
// stored in the cloud under a 16-digit token; pull wipes the local vault
// content and rebuilds it from the snapshot with id remapping. Last-write-
// wins — no merging. The account (Google login via Supabase Auth) gets N
// upload slots by tier (free: 1 slot/10MB, pro: 3 slots/20MB, enforced
// server-side) and can always manage/pull/delete its OWN slots without a
// token; a token + optional password is the door for any OTHER account.
// All HTTP lives here in the main process (renderer never fetches); the
// server side is the RPC set in
// supabase/migrations/20260730000000_dracondex_token_sync.sql.
const crypto = require('crypto');
const { app } = require('electron');
// getVaultDB(nexusId), not getDB(), in the three functions below. Each already
// receives the nexus it operates on, and each is reachable from a handler that
// awaits a file dialog or a network call BEFORE touching the database — so
// resolving the vault from the explicit argument removes any dependence on the
// ambient context surviving that await. applySnapshotCore in particular can
// wipe a nexus; it must never be able to wipe the wrong one.
const { getDB, getVaultDB } = require('./core');
const { getAppSetting, setAppSetting } = require('./versions');
const { getSecret, setSecret } = require('./secret-store');
const { makePkcePair, runOAuthLoopback } = require('./oauth-loopback');

const SNAPSHOT_FORMAT = 'dracondex-vault-snapshot';
const SNAPSHOT_VERSION = 1;

// Build-mode gate: packaged builds (portable + installer) talk to the real
// Supabase backend configured by the user; an unpackaged run (`npm start`,
// drivers) is pinned to the in-process dev prototype server instead
// (src/db/sync-devserver.js) — zero setup, loopback-only, JSON persistence.
const IS_DEV = !app.isPackaged;
let devUrl = null;

async function ensureDevBackend() {
  if (!IS_DEV || devUrl) return;
  devUrl = await require('./sync-devserver').ensureDevSyncServer();
}

// ---------------------------------------------------------------------------
// Config (app_setting K/V)
// ---------------------------------------------------------------------------
function getSyncConfig() {
  if (IS_DEV) {
    // Dev runs never use (or require) the stored Supabase config.
    return { url: devUrl || '', anonKey: 'dev-local', configured: true, dev: true };
  }
  const url = (getAppSetting('sync:url') || '').replace(/\/+$/, '');
  const anonKey = getSecret('sync:anonKey') || '';
  return { url, anonKey, configured: !!(url && anonKey), dev: false };
}

// The stored URL is string-interpolated into every outbound sync request —
// the token exchange and the full vault snapshot both go to `${url}/...` — so
// whatever lands here is where this app's auth tokens and the user's entire
// vault get sent. It was previously stored after nothing but a trim, meaning a
// single renderer-side call could silently repoint sync at an attacker's host
// (or downgrade it to plaintext http, or aim it at an internal address).
// https only, except loopback for the local dev backend.
function isAllowedSyncUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (_) { return false; }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
}

function setSyncConfig(url, anonKey) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (clean && !isAllowedSyncUrl(clean)) return { ok: false, error: 'invalid_url' };
  setAppSetting('sync:url', clean);
  setSecret('sync:anonKey', String(anonKey || '').trim());
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Local, best-effort "which slot did I last push THIS nexus to" hint. Never
// trusted as ground truth — the server's own upload list is authoritative;
// this only lets the renderer pre-select the right slot for push/pull.
// ---------------------------------------------------------------------------
const SLOT_MAP_KEY = 'sync:slotMap'; // JSON { [nexusId]: vaultId }

function getSlotMap() {
  try { return JSON.parse(getAppSetting(SLOT_MAP_KEY) || '{}') || {}; }
  catch (_) { return {}; }
}

function setSlotForNexus(nexusId, vaultId) {
  const map = getSlotMap();
  map[String(nexusId)] = vaultId;
  setAppSetting(SLOT_MAP_KEY, JSON.stringify(map));
}

function clearSlot(vaultId) {
  const map = getSlotMap();
  let changed = false;
  for (const k of Object.keys(map)) {
    if (map[k] === vaultId) { delete map[k]; changed = true; }
  }
  if (changed) setAppSetting(SLOT_MAP_KEY, JSON.stringify(map));
}

// ---------------------------------------------------------------------------
// 16-digit tokens — "1234-5678-9012-3456" as displayed; the wire/hash form
// is digits-only. A fresh one is generated on every push (see syncPushVault).
// ---------------------------------------------------------------------------
function generateToken() {
  return Array.from({ length: 16 }, () => crypto.randomInt(10)).join('');
}

// ---------------------------------------------------------------------------
// Google login via Supabase Auth (GoTrue), PKCE + system-browser loopback
// redirect. In dev mode this is skipped entirely — no browser, no Google
// account needed — in favor of a fabricated session so the whole flow is
// testable locally (src/db/sync-devserver.js trusts the fabricated
// `<uid>:<tier>` bearer token as-is).
// ---------------------------------------------------------------------------
const REFRESH_TOKEN_KEY = 'google:refreshToken';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

let memSession = null; // { accessToken, accessTokenExp (epoch ms or Infinity), uid, email }

async function syncGoogleLogin(devUid, devTier) {
  if (IS_DEV) {
    const uid = String(devUid || 'dev-user-1');
    const tier = devTier === 'pro' ? 'pro' : 'free';
    memSession = { accessToken: `${uid}:${tier}`, accessTokenExp: Infinity, uid, email: `${uid}@local.test` };
    return { ok: true, email: memSession.email };
  }
  const { url, anonKey, configured } = getSyncConfig();
  if (!configured) return { ok: false, code: 'no_config' };
  const { verifier, challenge } = makePkcePair();
  // No `state` here, unlike drive.js and plugin.js. GoTrue's /auth/v1/authorize
  // runs its own state through the Google handshake and redirects to
  // `redirect_to` with only `?code=`; a custom state param is not echoed back,
  // so enforcing one would reject every legitimate login. PKCE plus the
  // ephemeral random loopback port carry the CSRF weight on this flow. If a
  // future GoTrue passes state through, add it here and to the call below.
  let code;
  try {
    ({ code } = await runOAuthLoopback(
      (redirectTo) => `${url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`
        + `&code_challenge=${challenge}&code_challenge_method=s256`,
      { timeoutMs: LOGIN_TIMEOUT_MS },
    ));
  } catch (e) {
    return { ok: false, code: e.message === 'login_timeout' ? 'login_timeout' : 'auth', error: String(e?.message || e) };
  }
  let res;
  try {
    res = await fetch(`${url}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return { ok: false, code: 'network', error: String(e?.message || e) };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, code: 'auth', error: body.error_description || body.msg || `HTTP ${res.status}` };
  }
  const data = await res.json();
  memSession = {
    accessToken: data.access_token,
    accessTokenExp: Date.now() + (data.expires_in || 3600) * 1000,
    uid: data.user?.id,
    email: data.user?.email,
  };
  setSecret(REFRESH_TOKEN_KEY, data.refresh_token || '');
  return { ok: true, email: memSession.email };
}

async function syncGoogleLogout() {
  if (!IS_DEV) {
    const { url, anonKey, configured } = getSyncConfig();
    if (configured && memSession?.accessToken) {
      try {
        await fetch(`${url}/auth/v1/logout`, {
          method: 'POST',
          headers: { apikey: anonKey, Authorization: `Bearer ${memSession.accessToken}` },
          signal: AbortSignal.timeout(10000),
        });
      } catch (_) { /* best-effort */ }
    }
    setSecret(REFRESH_TOKEN_KEY, '');
  }
  memSession = null;
  return { ok: true };
}

// Refreshes the access token from the stored refresh token when needed.
// A network failure must NOT silently log the user out — only an explicit
// invalid-grant/401 response clears the stored refresh token.
async function ensureAccessToken() {
  if (IS_DEV) return memSession ? memSession.accessToken : null;
  if (memSession && memSession.accessTokenExp > Date.now() + 5000) return memSession.accessToken;
  const refreshToken = getSecret(REFRESH_TOKEN_KEY);
  if (!refreshToken) { memSession = null; return null; }
  const { url, anonKey, configured } = getSyncConfig();
  if (!configured) return null;
  let res;
  try {
    res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (_) {
    return memSession ? memSession.accessToken : null; // network hiccup — stay logged in
  }
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      setSecret(REFRESH_TOKEN_KEY, '');
      memSession = null;
    }
    return null;
  }
  const data = await res.json();
  memSession = {
    accessToken: data.access_token,
    accessTokenExp: Date.now() + (data.expires_in || 3600) * 1000,
    uid: data.user?.id,
    email: data.user?.email,
  };
  if (data.refresh_token) setSecret(REFRESH_TOKEN_KEY, data.refresh_token); // GoTrue rotates refresh tokens
  return memSession.accessToken;
}

async function syncAuthStatus() {
  const { configured, dev } = getSyncConfig();
  if (IS_DEV) return { ok: true, configured: true, dev: true, loggedIn: !!memSession, email: memSession?.email || null };
  if (!configured) return { ok: true, configured: false, dev: false, loggedIn: false, email: null };
  const token = await ensureAccessToken();
  return { ok: true, configured: true, dev: false, loggedIn: !!token, email: memSession?.email || null };
}

// ---------------------------------------------------------------------------
// PostgREST RPC wrapper. Public sync functions never throw — they return
// { ok:true, ... } or { ok:false, code, error } so IPC never has to
// serialize an Error.
// ---------------------------------------------------------------------------
const RPC_KNOWN_ERRORS = [
  'not_authenticated', 'bad_token', 'bad_password', 'locked',
  'token_collision', 'no_upload', 'too_large', 'quota_exceeded', 'not_owner',
];

async function rpc(fn, params) {
  try { await ensureDevBackend(); } catch (e) {
    return { ok: false, code: 'network', error: `dev sync server failed: ${String(e?.message || e)}` };
  }
  const { url, anonKey, configured } = getSyncConfig();
  if (!configured || !url) return { ok: false, code: 'no_config' };
  const accessToken = await ensureAccessToken();
  let res;
  try {
    res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken || anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { ok: false, code: 'network', error: String(e?.message || e) };
  }
  if (res.ok) {
    try { return { ok: true, data: await res.json() }; }
    catch (e) { return { ok: false, code: 'server', error: 'bad response body' }; }
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: 'auth', error: body.message || `HTTP ${res.status}` };
  }
  const code = RPC_KNOWN_ERRORS.includes(body.message) ? body.message : 'server';
  return { ok: false, code, error: body.message || `HTTP ${res.status}` };
}

// ---------------------------------------------------------------------------
// serializeVault(nexusId) — the whole vault closure as one JSON object.
// Lookup FKs (use_color/hashtag/timeline_date) are resolved to natural keys
// here; every snapshot `id` field is the exporting DB's row id and is used
// ONLY as a remap key on import, never re-inserted.
// Excluded on purpose: module_version (history), import_file (local paths),
// wiki_link (rebuilt after pull), and all legacy project trees.
// ---------------------------------------------------------------------------
const dateKey = (d) => `${d.day}|${d.month}|${d.years}|${d.hour}|${d.minute}`;

// moduleIds (optional): scopes the snapshot to one module subtree instead of
// the whole nexus — used by exportModuleFile (src/db/db-transfer.js). Every
// query below reaches `module m` via a JOIN and filters `m.nexus_ref=?`; in
// scoped mode that one literal substring is swapped for `m.id IN (...)` so
// all ~25 of them narrow together with no other change. relations/notes are
// vault-global (not owned by any module) so scoped mode omits them entirely
// via allGlobal() rather than trying to force them through the same
// substitution — a module import has nowhere sensible to put a vault-wide
// note or an arbitrary-entity relation anyway.
function serializeVault(nexusId, moduleIds = null) {
  const db = getVaultDB(nexusId);
  const nexus = db.prepare(`
    SELECT n.name, n.memo, c.color_code AS colorCode
    FROM nexus n LEFT JOIN use_color c ON n.color = c.id WHERE n.id=?`).get(nexusId);
  if (!nexus) return null;

  const scoped = Array.isArray(moduleIds) && moduleIds.length > 0;
  const all = (sql) => {
    if (scoped) {
      const inClause = `m.id IN (${moduleIds.map(() => '?').join(',')})`;
      return db.prepare(sql.replace('m.nexus_ref=?', inClause)).all(...moduleIds);
    }
    return db.prepare(sql).all(nexusId);
  };
  const allGlobal = (sql) => (scoped ? [] : db.prepare(sql).all(nexusId));

  const modules = all(`
    SELECT m.id, m.parent_id AS parentId, m.name, m.kind, m.icon,
           ic.color_code AS iconColorCode, cc.color_code AS colorCode,
           m.description, m.display_order AS displayOrder, m.pinned,
           m.cat_type AS catType, m.handle, m.create_at AS createAt, m.update_at AS updateAt
    FROM module m
    LEFT JOIN use_color ic ON m.icon_color = ic.id
    LEFT JOIN use_color cc ON m.color = cc.id
    WHERE m.nexus_ref=? ORDER BY m.id`);

  const moduleAttrs = all(`
    SELECT a.module_ref AS moduleId, a.attr_name AS name, a.attr_value AS value,
           a.display_order AS displayOrder
    FROM module_attribute a JOIN module m ON a.module_ref=m.id
    WHERE m.nexus_ref=? ORDER BY a.id`);

  const moduleUi = all(`
    SELECT u.module_ref AS moduleId, u.ui_key AS key, u.ui_value AS value
    FROM module_ui u JOIN module m ON u.module_ref=m.id WHERE m.nexus_ref=?`);

  const moduleTags = all(`
    SELECT mh.module_ref AS moduleId, h.tag_name AS tagName, hc.color_code AS colorCode
    FROM module_hashtag mh
    JOIN module m ON mh.module_ref=m.id
    JOIN hashtag h ON mh.hashtag_id=h.id
    LEFT JOIN use_color hc ON h.tag_color=hc.id
    WHERE m.nexus_ref=?`);

  const classifier = {
    objects: all(`
      SELECT o.id, o.module_ref AS moduleId, o.name, c.color_code AS colorCode,
             o.note, o.display_order AS displayOrder
      FROM classifier_object o JOIN module m ON o.module_ref=m.id
      LEFT JOIN use_color c ON o.color=c.id WHERE m.nexus_ref=? ORDER BY o.id`),
    templates: all(`
      SELECT t.id, t.module_ref AS moduleId, t.object_ref AS objectId, t.description,
             t.attribute_type AS attributeType, t.levelable, t.has_condition AS hasCondition,
             t.display_order AS displayOrder
      FROM classifier_template t JOIN module m ON t.module_ref=m.id
      WHERE m.nexus_ref=? ORDER BY t.id`),
    attributes: all(`
      SELECT a.object_ref AS objectId, a.template_ref AS templateId,
             a.attribute_value AS value
      FROM classifier_attribute a
      JOIN classifier_object o ON a.object_ref=o.id
      JOIN module m ON o.module_ref=m.id WHERE m.nexus_ref=?`),
  };

  // v3 Locator/Chronicler rows have module_ref set (project_id NULL) — select
  // via the module join only so legacy project maps/timelines never leak in.
  const locator = {
    maps: all(`
      SELECT mp.id, mp.module_ref AS moduleId, mp.map_name AS name, c.color_code AS colorCode
      FROM map mp JOIN module m ON mp.module_ref=m.id
      LEFT JOIN use_color c ON mp.color=c.id WHERE m.nexus_ref=? ORDER BY mp.id`),
    areas: all(`
      SELECT a.id, a.map_id AS mapId, a.area_name AS name, c.color_code AS colorCode
      FROM map_area a JOIN map mp ON a.map_id=mp.id JOIN module m ON mp.module_ref=m.id
      LEFT JOIN use_color c ON a.color=c.id WHERE m.nexus_ref=? ORDER BY a.id`),
    points: all(`
      SELECT p.area_id AS areaId, p.point_order AS "order", p.x, p.y
      FROM map_point p JOIN map_area a ON p.area_id=a.id
      JOIN map mp ON a.map_id=mp.id JOIN module m ON mp.module_ref=m.id
      WHERE m.nexus_ref=? ORDER BY p.id`),
  };

  const chronicler = {
    timelines: all(`
      SELECT t.id, t.module_ref AS moduleId, t.line_name AS name, c.color_code AS colorCode
      FROM timeline t JOIN module m ON t.module_ref=m.id
      LEFT JOIN use_color c ON t.color=c.id WHERE m.nexus_ref=? ORDER BY t.id`),
    events: all(`
      SELECT e.id, e.timeline_id AS timelineId, e.event_name AS name,
             sd.day AS sDay, sd.month AS sMonth, sd.years AS sYears, sd.hour AS sHour, sd.minute AS sMinute,
             ed.day AS eDay, ed.month AS eMonth, ed.years AS eYears, ed.hour AS eHour, ed.minute AS eMinute,
             c.color_code AS colorCode, e.story
      FROM timeline_event e
      JOIN timeline t ON e.timeline_id=t.id JOIN module m ON t.module_ref=m.id
      JOIN timeline_date sd ON e.start_at=sd.id
      LEFT JOIN timeline_date ed ON e.end_at=ed.id
      LEFT JOIN use_color c ON e.color=c.id
      WHERE m.nexus_ref=? ORDER BY e.id`).map((e) => ({
        id: e.id, timelineId: e.timelineId, name: e.name,
        startKey: dateKey({ day: e.sDay, month: e.sMonth, years: e.sYears, hour: e.sHour, minute: e.sMinute }),
        endKey: e.eDay == null ? null
          : dateKey({ day: e.eDay, month: e.eMonth, years: e.eYears, hour: e.eHour, minute: e.eMinute }),
        colorCode: e.colorCode, story: e.story,
      })),
  };

  const dates = all(`
    SELECT DISTINCT d.day, d.month, d.years, d.hour, d.minute
    FROM timeline_date d
    JOIN timeline_event e ON e.start_at=d.id OR e.end_at=d.id
    JOIN timeline t ON e.timeline_id=t.id JOIN module m ON t.module_ref=m.id
    WHERE m.nexus_ref=?`).map((d) => ({ key: dateKey(d), ...d }));

  const wanderer = {
    mapEvents: all(`
      SELECT me.module_ref AS moduleId, me.event_ref AS eventId, me.area_ref AS areaId,
             me.label, me.x, me.y
      FROM map_event me JOIN module m ON me.module_ref=m.id
      WHERE m.nexus_ref=? ORDER BY me.id`),
  };

  const narrator = {
    dialogues: all(`
      SELECT d.id, d.module_ref AS moduleId, d.name, c.color_code AS colorCode,
             d.pos_x AS posX, d.pos_y AS posY
      FROM story_dialogue d JOIN module m ON d.module_ref=m.id
      LEFT JOIN use_color c ON d.color=c.id WHERE m.nexus_ref=? ORDER BY d.id`),
    edges: all(`
      SELECT e.module_ref AS moduleId, e.from_ref AS fromId, e.to_ref AS toId, e.label
      FROM story_edge e JOIN module m ON e.module_ref=m.id WHERE m.nexus_ref=?`),
    talks: all(`
      SELECT tk.id, tk.dialogue_ref AS dialogueId, tk.speaker, tk.talk_sentence AS sentence,
             tk.row_type AS rowType, tk.talk_order AS "order"
      FROM story_talk tk JOIN story_dialogue d ON tk.dialogue_ref=d.id
      JOIN module m ON d.module_ref=m.id WHERE m.nexus_ref=? ORDER BY tk.id`),
    // Without these a choice would round-trip as a plain line (row_type
    // defaults to 'talk' on re-insert) and its options would be gone.
    choiceOptions: all(`
      SELECT o.talk_ref AS talkId, o.option_text AS text, o.effect_kind AS effectKind,
             o.effect_text AS effectText, o.jump_ref AS jumpId, o.option_order AS "order"
      FROM story_choice_option o
      JOIN story_talk tk ON o.talk_ref=tk.id JOIN story_dialogue d ON tk.dialogue_ref=d.id
      JOIN module m ON d.module_ref=m.id WHERE m.nexus_ref=? ORDER BY o.id`),
  };

  const author = {
    chapters: all(`
      SELECT ch.id, ch.module_ref AS moduleId, ch.name, ch.chapter_content AS content,
             ch.chapter_order AS "order"
      FROM book_chapter ch JOIN module m ON ch.module_ref=m.id
      WHERE m.nexus_ref=? ORDER BY ch.id`),
  };

  const chatscribe = {
    sessions: all(`
      SELECT s.id, s.module_ref AS moduleId, s.name, s.session_order AS "order",
             s.create_at AS createAt
      FROM chat_session s JOIN module m ON s.module_ref=m.id
      WHERE m.nexus_ref=? ORDER BY s.id`),
    messages: all(`
      SELECT msg.session_ref AS sessionId, msg.message, msg.create_at AS createAt
      FROM chat_message msg JOIN chat_session s ON msg.session_ref=s.id
      JOIN module m ON s.module_ref=m.id WHERE m.nexus_ref=? ORDER BY msg.id`),
  };

  const sketcher = {
    pages: all(`
      SELECT p.id, p.module_ref AS moduleId, p.name, p.page_order AS "order"
      FROM sketch_page p JOIN module m ON p.module_ref=m.id
      WHERE m.nexus_ref=? ORDER BY p.id`),
    strokes: all(`
      SELECT st.page_ref AS pageId, st.color, st.width, st.points
      FROM sketch_stroke st JOIN sketch_page p ON st.page_ref=p.id
      JOIN module m ON p.module_ref=m.id WHERE m.nexus_ref=? ORDER BY st.id`),
    pins: all(`
      SELECT pn.page_ref AS pageId, pn.linker_key AS linkerKey, pn.x, pn.y
      FROM sketch_pin pn JOIN sketch_page p ON pn.page_ref=p.id
      JOIN module m ON p.module_ref=m.id WHERE m.nexus_ref=? ORDER BY pn.id`),
  };

  const designer = {
    nodes: all(`
      SELECT n.id, n.module_ref AS moduleId, n.shape, n.x, n.y, n.node_text AS text,
             n.color, n.linker_key AS linkerKey
      FROM design_node n JOIN module m ON n.module_ref=m.id
      WHERE m.nexus_ref=? ORDER BY n.id`),
    edges: all(`
      SELECT e.module_ref AS moduleId, e.from_ref AS fromId, e.to_ref AS toId, e.label
      FROM design_edge e JOIN module m ON e.module_ref=m.id WHERE m.nexus_ref=?`),
  };

  const relations = allGlobal(`
    SELECT from_key AS fromKey, to_key AS toKey, label
    FROM entity_relation WHERE nexus_ref=? ORDER BY id`);

  // Nexus-scoped like relations, so allGlobal (skipped for a module-scoped
  // export — a single module can't carry the whole vault's templates).
  const calendarTemplates = allGlobal(`
    SELECT name, spec, builtin FROM calendar_template WHERE nexus_ref=? ORDER BY id`);

  const notes = {
    folders: allGlobal(`
      SELECT f.id, f.parent_ref AS parentId, f.name, c.color_code AS colorCode
      FROM note_folder f LEFT JOIN use_color c ON f.color=c.id
      WHERE f.nexus_ref=? ORDER BY f.id`),
    notes: allGlobal(`
      SELECT n.id, n.folder_ref AS folderId, n.title, n.content,
             c.color_code AS colorCode, n.pinned
      FROM note n LEFT JOIN use_color c ON n.color=c.id
      WHERE n.nexus_ref=? ORDER BY n.id`),
  };

  // Every color code referenced anywhere above, deduped.
  const colors = new Set();
  const addColor = (c) => { if (c) colors.add(c); };
  addColor(nexus.colorCode);
  modules.forEach((m) => { addColor(m.iconColorCode); addColor(m.colorCode); });
  moduleTags.forEach((t) => addColor(t.colorCode));
  classifier.objects.forEach((o) => addColor(o.colorCode));
  locator.maps.forEach((r) => addColor(r.colorCode));
  locator.areas.forEach((r) => addColor(r.colorCode));
  chronicler.timelines.forEach((r) => addColor(r.colorCode));
  chronicler.events.forEach((r) => addColor(r.colorCode));
  narrator.dialogues.forEach((r) => addColor(r.colorCode));
  notes.folders.forEach((r) => addColor(r.colorCode));
  notes.notes.forEach((r) => addColor(r.colorCode));

  const hashtags = [];
  const seenTags = new Set();
  moduleTags.forEach((t) => {
    if (!seenTags.has(t.tagName)) {
      seenTags.add(t.tagName);
      hashtags.push({ name: t.tagName, colorCode: t.colorCode || null });
    }
  });

  let pkgVersion = null;
  // '../../package.json' resolved to electron/package.json, which has never
  // existed — the catch swallowed it, so every exported snapshot recorded
  // app: null. Pre-existing since before the multi-repo split; the layout is
  // unchanged here, so the fix is the same either side of it.
  try { pkgVersion = require('../../../package.json').version; } catch (_) {}

  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    app: pkgVersion,
    exportedAt: new Date().toISOString(),
    nexus: { name: nexus.name, memo: nexus.memo, colorCode: nexus.colorCode },
    lookups: { colors: [...colors], hashtags, dates },
    modules, moduleAttrs, moduleUi, moduleTags,
    classifier, locator, chronicler, wanderer, narrator, author,
    chatscribe, sketcher, designer, relations, notes, calendarTemplates,
  };
}

// "This module + every descendant" — walked in memory (mirrors the
// parents-first BFS pattern applySnapshotCore itself uses below) rather than
// a SQL recursive CTE, so it doesn't depend on the WASM SQLite build
// supporting WITH RECURSIVE. Used by exportModuleFile/importModuleFile
// (src/db/db-transfer.js) to scope serializeVault to one module subtree.
function collectModuleSubtreeIds(nexusId, moduleId) {
  const db = getVaultDB(nexusId);
  const rows = db.prepare(`SELECT id, parent_id AS parentId FROM module WHERE nexus_ref=?`).all(nexusId);
  const byParent = new Map();
  for (const r of rows) {
    if (!byParent.has(r.parentId)) byParent.set(r.parentId, []);
    byParent.get(r.parentId).push(r.id);
  }
  const out = [];
  const stack = [moduleId];
  while (stack.length) {
    const id = stack.pop();
    out.push(id);
    for (const child of byParent.get(id) || []) stack.push(child);
  }
  return out;
}

// ---------------------------------------------------------------------------
// applySnapshot(nexusId, payload) — wipe-and-rebuild with id remap.
// Preserving snapshot ids is impossible (autoincrement collisions with other
// vaults), so children are re-keyed through in-memory old→new Maps.
// ---------------------------------------------------------------------------
function validateSnapshot(p) {
  if (!p || p.format !== SNAPSHOT_FORMAT || p.version !== SNAPSHOT_VERSION) return false;
  return Array.isArray(p.modules) && p.nexus && typeof p.nexus === 'object';
}

// "module_12" → "module_57" through the per-kind maps; null = unmappable
// (legacy kinds or a row the snapshot no longer contains).
function remapEntityKey(key, maps) {
  const m = /^([a-z]+)_(\d+)$/.exec(String(key || ''));
  if (!m) return null;
  const map = maps[m[1]];
  if (!map) return null;
  const mapped = map.get(Number(m[2]));
  return mapped == null ? null : `${m[1]}_${mapped}`;
}

// Shared by applySnapshot (whole-nexus wipe-and-rebuild, Token Sync pull)
// and importModuleSnapshot (module-subtree merge-in, Setting window →
// Appdata → Database). Only 3 things differ between the two callers:
//   wipe            — clear the nexus's existing module/relation/note/
//                      wiki_link rows first (whole-nexus only; a module
//                      import must never touch anything already there)
//   updateNexusMeta — overwrite the nexus row's memo/color (whole-nexus
//                      only; a module import is going INTO an existing
//                      nexus, whose own memo/color must stay untouched)
//   reparentRootTo  — id (or null) every snapshot module with no parent of
//                      its own gets re-pointed to. null for a whole-nexus
//                      replace (they really are top-level); the chosen
//                      target parent for a module import.
// Everything else — lookups, the modules BFS insert, every per-kind child
// insert, relation/note insert, module_ui remap — is identical either way.
function applySnapshotCore(nexusId, payload, opts = {}) {
  const { wipe = false, updateNexusMeta = false, reparentRootTo = null } = opts;
  if (!validateSnapshot(payload)) return { ok: false, code: 'bad_snapshot' };
  const db = getVaultDB(nexusId);
  const arr = (a) => (Array.isArray(a) ? a : []);
  const sect = (s) => (s && typeof s === 'object' ? s : {});

  const summary = db.transaction(() => {
    if (wipe) {
      // Wipe the vault's synced content. module CASCADEs to every per-kind
      // child incl. v3 map→map_area→map_point and timeline→timeline_event.
      db.prepare(`DELETE FROM module WHERE nexus_ref=?`).run(nexusId);
      db.prepare(`DELETE FROM entity_relation WHERE nexus_ref=?`).run(nexusId);
      db.prepare(`DELETE FROM note WHERE nexus_ref=?`).run(nexusId);
      db.prepare(`DELETE FROM note_folder WHERE nexus_ref=?`).run(nexusId);
      db.prepare(`DELETE FROM wiki_link WHERE nexus_ref=?`).run(nexusId);
      db.prepare(`DELETE FROM calendar_template WHERE nexus_ref=?`).run(nexusId);
    }

    // 2. Lookups by natural key (same pattern as importDatabaseMerge).
    const lookups = sect(payload.lookups);
    const colorMap = new Map(); // color_code → id
    for (const code of arr(lookups.colors)) {
      if (!code) continue;
      db.prepare(`INSERT OR IGNORE INTO use_color (color_code) VALUES (?)`).run(code);
      colorMap.set(code, db.prepare(`SELECT id FROM use_color WHERE color_code=?`).get(code).id);
    }
    const colorId = (code) => (code && colorMap.has(code) ? colorMap.get(code) : null);

    const tagMap = new Map(); // tag_name → id
    for (const tg of arr(lookups.hashtags)) {
      if (!tg?.name) continue;
      db.prepare(`INSERT OR IGNORE INTO hashtag (tag_name, tag_color) VALUES (?,?)`)
        .run(tg.name, colorId(tg.colorCode));
      tagMap.set(tg.name, db.prepare(`SELECT id FROM hashtag WHERE tag_name=?`).get(tg.name).id);
    }

    const dateMap = new Map(); // "d|m|y|h|min" → id
    for (const d of arr(lookups.dates)) {
      db.prepare(`INSERT OR IGNORE INTO timeline_date (day,month,years,hour,minute) VALUES (?,?,?,?,?)`)
        .run(d.day, d.month, d.years, d.hour, d.minute);
      dateMap.set(d.key, db.prepare(
        `SELECT id FROM timeline_date WHERE day=? AND month=? AND years=? AND hour=? AND minute=?`)
        .get(d.day, d.month, d.years, d.hour, d.minute).id);
    }

    // 3. Nexus row: memo/color only — the local vault NAME is kept (UNIQUE
    //    across vaults; the cloud name is display info in the sync state).
    if (updateNexusMeta) {
      db.prepare(`UPDATE nexus SET memo=?, color=?, update_at=datetime('now') WHERE id=?`)
        .run(payload.nexus.memo ?? null, colorId(payload.nexus.colorCode), nexusId);
    }

    // 4. Modules, parents-first (BFS so a child never lands before its parent).
    const modMap = new Map();
    let pending = arr(payload.modules).slice();
    while (pending.length) {
      const next = [];
      let progressed = false;
      for (const m of pending) {
        if (m.parentId != null && !modMap.has(m.parentId)) { next.push(m); continue; }
        const parentId = m.parentId != null ? modMap.get(m.parentId) : reparentRootTo;
        // A handle is unique per vault, and an import lands in a vault that
        // may already use this one. Dropping the clash to NULL keeps the
        // module (and every module after it) importable — throwing here would
        // abort the whole transaction over a cosmetic field, and silently
        // renaming it would invent a handle the user never chose.
        let handle = m.handle ?? null;
        if (handle != null && db.prepare(`SELECT id FROM module WHERE nexus_ref=? AND handle=? COLLATE NOCASE`).get(nexusId, handle)) handle = null;
        const r = db.prepare(`
          INSERT INTO module (nexus_ref, parent_id, name, kind, icon, icon_color, color,
                              description, display_order, pinned, cat_type, handle, create_at, update_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,datetime('now')),COALESCE(?,datetime('now')))`)
          .run(nexusId, parentId, m.name, m.kind,
               m.icon ?? null, colorId(m.iconColorCode), colorId(m.colorCode),
               m.description ?? null, m.displayOrder ?? 0, m.pinned ?? 0, m.catType ?? null, handle,
               m.createAt ?? null, m.updateAt ?? null);
        modMap.set(m.id, r.lastInsertRowid);
        progressed = true;
      }
      if (!progressed) break; // orphaned parentIds — drop the remainder
      pending = next;
    }
    const mod = (oldId) => modMap.get(oldId);

    // 5. Per-kind children, dependency order, each building its own map.
    for (const a of arr(payload.moduleAttrs)) {
      if (mod(a.moduleId) == null) continue;
      db.prepare(`INSERT INTO module_attribute (module_ref, attr_name, attr_value, display_order) VALUES (?,?,?,?)`)
        .run(mod(a.moduleId), a.name, a.value ?? null, a.displayOrder ?? 0);
    }
    for (const tg of arr(payload.moduleTags)) {
      if (mod(tg.moduleId) == null || !tagMap.has(tg.tagName)) continue;
      db.prepare(`INSERT OR IGNORE INTO module_hashtag (module_ref, hashtag_id) VALUES (?,?)`)
        .run(mod(tg.moduleId), tagMap.get(tg.tagName));
    }

    const cls = sect(payload.classifier);
    const cobjMap = new Map();
    for (const o of arr(cls.objects)) {
      if (mod(o.moduleId) == null) continue;
      const r = db.prepare(`INSERT INTO classifier_object (module_ref, name, color, note, display_order) VALUES (?,?,?,?,?)`)
        .run(mod(o.moduleId), o.name, colorId(o.colorCode), o.note ?? null, o.displayOrder ?? 0);
      cobjMap.set(o.id, r.lastInsertRowid);
    }
    const ctplMap = new Map();
    for (const t of arr(cls.templates)) {
      if (mod(t.moduleId) == null) continue;
      if (t.objectId != null && !cobjMap.has(t.objectId)) continue;
      const r = db.prepare(`
        INSERT INTO classifier_template (module_ref, object_ref, description, attribute_type,
                                         levelable, has_condition, display_order)
        VALUES (?,?,?,?,?,?,?)`)
        .run(mod(t.moduleId), t.objectId != null ? cobjMap.get(t.objectId) : null,
             t.description, t.attributeType ?? 'text', t.levelable ?? 0,
             t.hasCondition ?? 0, t.displayOrder ?? 0);
      ctplMap.set(t.id, r.lastInsertRowid);
    }
    for (const a of arr(cls.attributes)) {
      if (!cobjMap.has(a.objectId) || !ctplMap.has(a.templateId)) continue;
      db.prepare(`INSERT OR IGNORE INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?,?,?)`)
        .run(cobjMap.get(a.objectId), ctplMap.get(a.templateId), a.value ?? null);
    }

    const loc = sect(payload.locator);
    const mapMap = new Map();
    for (const r0 of arr(loc.maps)) {
      if (mod(r0.moduleId) == null) continue;
      const r = db.prepare(`INSERT INTO map (map_name, module_ref, color) VALUES (?,?,?)`)
        .run(r0.name ?? null, mod(r0.moduleId), colorId(r0.colorCode));
      mapMap.set(r0.id, r.lastInsertRowid);
    }
    const areaMap = new Map();
    for (const r0 of arr(loc.areas)) {
      if (!mapMap.has(r0.mapId)) continue;
      const r = db.prepare(`INSERT INTO map_area (map_id, area_name, color) VALUES (?,?,?)`)
        .run(mapMap.get(r0.mapId), r0.name ?? null, colorId(r0.colorCode));
      areaMap.set(r0.id, r.lastInsertRowid);
    }
    for (const p of arr(loc.points)) {
      if (!areaMap.has(p.areaId)) continue;
      db.prepare(`INSERT INTO map_point (area_id, point_order, x, y) VALUES (?,?,?,?)`)
        .run(areaMap.get(p.areaId), p.order ?? 0, p.x, p.y);
    }

    const chr = sect(payload.chronicler);
    const tlMap = new Map();
    for (const t of arr(chr.timelines)) {
      if (mod(t.moduleId) == null) continue;
      const r = db.prepare(`INSERT INTO timeline (line_name, module_ref, color) VALUES (?,?,?)`)
        .run(t.name ?? null, mod(t.moduleId), colorId(t.colorCode));
      tlMap.set(t.id, r.lastInsertRowid);
    }
    const evtMap = new Map();
    for (const e of arr(chr.events)) {
      if (!tlMap.has(e.timelineId) || !dateMap.has(e.startKey)) continue;
      const r = db.prepare(`
        INSERT INTO timeline_event (timeline_id, event_name, start_at, end_at, color, story)
        VALUES (?,?,?,?,?,?)`)
        .run(tlMap.get(e.timelineId), e.name ?? null, dateMap.get(e.startKey),
             e.endKey != null && dateMap.has(e.endKey) ? dateMap.get(e.endKey) : null,
             colorId(e.colorCode), e.story ?? null);
      evtMap.set(e.id, r.lastInsertRowid);
    }

    for (const me of arr(sect(payload.wanderer).mapEvents)) {
      if (mod(me.moduleId) == null) continue;
      db.prepare(`INSERT INTO map_event (module_ref, event_ref, area_ref, label, x, y) VALUES (?,?,?,?,?,?)`)
        .run(mod(me.moduleId),
             me.eventId != null && evtMap.has(me.eventId) ? evtMap.get(me.eventId) : null,
             me.areaId != null && areaMap.has(me.areaId) ? areaMap.get(me.areaId) : null,
             me.label ?? null, me.x ?? 0, me.y ?? 0);
    }

    const nar = sect(payload.narrator);
    const dlgMap = new Map();
    for (const d of arr(nar.dialogues)) {
      if (mod(d.moduleId) == null) continue;
      const r = db.prepare(`INSERT INTO story_dialogue (module_ref, name, color, pos_x, pos_y) VALUES (?,?,?,?,?)`)
        .run(mod(d.moduleId), d.name, colorId(d.colorCode), d.posX ?? 0, d.posY ?? 0);
      dlgMap.set(d.id, r.lastInsertRowid);
    }
    for (const e of arr(nar.edges)) {
      if (mod(e.moduleId) == null || !dlgMap.has(e.fromId) || !dlgMap.has(e.toId)) continue;
      db.prepare(`INSERT OR IGNORE INTO story_edge (module_ref, from_ref, to_ref, label) VALUES (?,?,?,?)`)
        .run(mod(e.moduleId), dlgMap.get(e.fromId), dlgMap.get(e.toId), e.label ?? null);
    }
    const talkMap = new Map();
    for (const tk of arr(nar.talks)) {
      if (!dlgMap.has(tk.dialogueId)) continue;
      const r = db.prepare(`INSERT INTO story_talk (dialogue_ref, speaker, talk_sentence, row_type, talk_order) VALUES (?,?,?,?,?)`)
        .run(dlgMap.get(tk.dialogueId), tk.speaker ?? null, tk.sentence ?? null,
          tk.rowType === 'choice' ? 'choice' : 'talk', tk.order ?? 0);
      if (tk.id != null) talkMap.set(tk.id, r.lastInsertRowid);
    }
    for (const op of arr(nar.choiceOptions)) {
      if (!talkMap.has(op.talkId)) continue;
      db.prepare(`INSERT INTO story_choice_option (talk_ref, option_text, effect_kind, effect_text, jump_ref, option_order) VALUES (?,?,?,?,?,?)`)
        .run(talkMap.get(op.talkId), op.text ?? null, op.effectKind ?? 'none', op.effectText ?? null,
          op.jumpId != null ? (dlgMap.get(op.jumpId) ?? null) : null, op.order ?? 0);
    }

    const bchpMap = new Map();
    for (const ch of arr(sect(payload.author).chapters)) {
      if (mod(ch.moduleId) == null) continue;
      const r = db.prepare(`INSERT INTO book_chapter (module_ref, name, chapter_content, chapter_order) VALUES (?,?,?,?)`)
        .run(mod(ch.moduleId), ch.name, ch.content ?? null, ch.order ?? 0);
      bchpMap.set(ch.id, r.lastInsertRowid);
    }

    const cht = sect(payload.chatscribe);
    const chssMap = new Map();
    for (const s of arr(cht.sessions)) {
      if (mod(s.moduleId) == null) continue;
      const r = db.prepare(`
        INSERT INTO chat_session (module_ref, name, session_order, create_at)
        VALUES (?,?,?,COALESCE(?,datetime('now')))`)
        .run(mod(s.moduleId), s.name, s.order ?? 0, s.createAt ?? null);
      chssMap.set(s.id, r.lastInsertRowid);
    }
    for (const msg of arr(cht.messages)) {
      if (!chssMap.has(msg.sessionId)) continue;
      db.prepare(`INSERT INTO chat_message (session_ref, message, create_at) VALUES (?,?,COALESCE(?,datetime('now')))`)
        .run(chssMap.get(msg.sessionId), msg.message, msg.createAt ?? null);
    }

    const skt = sect(payload.sketcher);
    const pageMap = new Map();
    for (const p of arr(skt.pages)) {
      if (mod(p.moduleId) == null) continue;
      const r = db.prepare(`INSERT INTO sketch_page (module_ref, name, page_order) VALUES (?,?,?)`)
        .run(mod(p.moduleId), p.name, p.order ?? 0);
      pageMap.set(p.id, r.lastInsertRowid);
    }
    for (const st of arr(skt.strokes)) {
      if (!pageMap.has(st.pageId)) continue;
      db.prepare(`INSERT INTO sketch_stroke (page_ref, color, width, points) VALUES (?,?,?,?)`)
        .run(pageMap.get(st.pageId), st.color ?? null, st.width ?? 3, st.points);
    }

    const dsg = sect(payload.designer);
    const dnodeMap = new Map();
    // Nodes first WITHOUT linker_key remap (the target maps are complete by
    // now, but keep one code path: remap inline since all maps exist here).
    const keyMaps = { module: modMap, cobj: cobjMap, bchp: bchpMap, chss: chssMap };

    let droppedPins = 0;
    for (const pn of arr(skt.pins)) {
      if (!pageMap.has(pn.pageId)) continue;
      const k = remapEntityKey(pn.linkerKey, keyMaps);
      if (!k) { droppedPins++; continue; } // linker_key NOT NULL — drop unmappable pins
      db.prepare(`INSERT INTO sketch_pin (page_ref, linker_key, x, y) VALUES (?,?,?,?)`)
        .run(pageMap.get(pn.pageId), k, pn.x ?? 0, pn.y ?? 0);
    }

    for (const n of arr(dsg.nodes)) {
      if (mod(n.moduleId) == null) continue;
      const k = n.linkerKey ? remapEntityKey(n.linkerKey, keyMaps) : null;
      const r = db.prepare(`
        INSERT INTO design_node (module_ref, shape, x, y, node_text, color, linker_key)
        VALUES (?,?,?,?,?,?,?)`)
        .run(mod(n.moduleId), n.shape ?? 'box', n.x ?? 0, n.y ?? 0,
             n.text ?? null, n.color ?? null, k);
      dnodeMap.set(n.id, r.lastInsertRowid);
    }
    for (const e of arr(dsg.edges)) {
      if (mod(e.moduleId) == null || !dnodeMap.has(e.fromId) || !dnodeMap.has(e.toId)) continue;
      db.prepare(`INSERT OR IGNORE INTO design_edge (module_ref, from_ref, to_ref, label) VALUES (?,?,?,?)`)
        .run(mod(e.moduleId), dnodeMap.get(e.fromId), dnodeMap.get(e.toId), e.label ?? null);
    }

    // Notes (folder tree parents-first), then relations — noteMap joins the
    // key maps so note_<id> relation endpoints remap too.
    const nts = sect(payload.notes);
    const nfMap = new Map();
    let pendingF = arr(nts.folders).slice();
    while (pendingF.length) {
      const next = [];
      let progressed = false;
      for (const f of pendingF) {
        if (f.parentId != null && !nfMap.has(f.parentId)) { next.push(f); continue; }
        const r = db.prepare(`INSERT INTO note_folder (nexus_ref, parent_ref, name, color) VALUES (?,?,?,?)`)
          .run(nexusId, f.parentId != null ? nfMap.get(f.parentId) : null, f.name, colorId(f.colorCode));
        nfMap.set(f.id, r.lastInsertRowid);
        progressed = true;
      }
      if (!progressed) break;
      pendingF = next;
    }
    const noteMap = new Map();
    for (const n of arr(nts.notes)) {
      const r = db.prepare(`
        INSERT OR IGNORE INTO note (nexus_ref, folder_ref, title, content, color, pinned)
        VALUES (?,?,?,?,?,?)`)
        .run(nexusId, n.folderId != null && nfMap.has(n.folderId) ? nfMap.get(n.folderId) : null,
             n.title, n.content ?? '', colorId(n.colorCode), n.pinned ?? 0);
      if (r.changes) noteMap.set(n.id, r.lastInsertRowid);
    }
    keyMaps.note = noteMap;

    let droppedRelations = 0;
    for (const rel of arr(payload.relations)) {
      const fk = remapEntityKey(rel.fromKey, keyMaps);
      const tk = remapEntityKey(rel.toKey, keyMaps);
      if (!fk || !tk) { droppedRelations++; continue; }
      db.prepare(`INSERT OR IGNORE INTO entity_relation (nexus_ref, from_key, to_key, label) VALUES (?,?,?,?)`)
        .run(nexusId, fk, tk, rel.label ?? null);
    }

    // Templates carry no entity ids, so unlike relations they need no remap —
    // the spec is self-contained JSON. Name collisions keep the target's own
    // copy rather than overwriting a calendar the user may already be using.
    for (const ct of arr(payload.calendarTemplates)) {
      if (!ct || !ct.name || !ct.spec) continue;
      db.prepare(`INSERT OR IGNORE INTO calendar_template (nexus_ref, name, spec, builtin) VALUES (?,?,?,?)`)
        .run(nexusId, ct.name, ct.spec, ct.builtin ? 1 : 0);
    }

    // module_ui last: Wanderer's mapModule/timelineModule values are module
    // ids and must go through modMap. Other ui values are copied verbatim —
    // any entity id embedded in them (e.g. viewer filter defs) stays stale;
    // documented prototype limitation.
    for (const u of arr(payload.moduleUi)) {
      if (mod(u.moduleId) == null) continue;
      let value = u.value;
      if (u.key === 'mapModule' || u.key === 'timelineModule') {
        const target = modMap.get(Number(u.value));
        if (target == null) continue;
        value = String(target);
      }
      db.prepare(`INSERT OR IGNORE INTO module_ui (module_ref, ui_key, ui_value) VALUES (?,?,?)`)
        .run(mod(u.moduleId), u.key, value ?? null);
    }

    return {
      modules: modMap.size,
      notes: noteMap.size,
      relations: arr(payload.relations).length - droppedRelations,
      droppedRelations,
      droppedPins,
    };
  })();

  // Regenerate the wiki-link index (global — fine at prototype scale).
  try { require('./wiki').rebuildWikiIndex(); } catch (e) {
    console.error('sync: wiki rebuild after pull failed:', e);
  }

  return { ok: true, summary };
}

// Whole-nexus wipe-and-rebuild — Token Sync pull's only caller, same
// behavior as before applySnapshotCore existed.
function applySnapshot(nexusId, payload) {
  return applySnapshotCore(nexusId, payload, { wipe: true, updateNexusMeta: true, reparentRootTo: null });
}

// Module-subtree merge-in (Setting window → Appdata → Database "import
// module") — additive, never wipes the target nexus, and reparents the
// snapshot's root module(s) under parentModuleId (or to top-level if null).
function importModuleSnapshot(nexusId, parentModuleId, payload) {
  return applySnapshotCore(nexusId, payload, { wipe: false, updateNexusMeta: false, reparentRootTo: parentModuleId ?? null });
}

// ---------------------------------------------------------------------------
// Public sync operations (IPC surface)
// ---------------------------------------------------------------------------
async function syncStatus(nexusId) {
  const { configured, dev } = getSyncConfig();
  const auth = await syncAuthStatus();
  const out = {
    ok: true, configured, dev, loggedIn: auth.loggedIn, email: auth.email,
    tier: null, maxSlots: 0, maxBytes: 0, uploads: [], mappedVaultId: null,
  };
  if (!configured && !dev) return out;
  if (!auth.loggedIn) return out;
  const r = await rpc('token_sync_status', {});
  if (!r.ok) { out.remoteError = r.code; return out; }
  out.tier = r.data.tier;
  out.maxSlots = r.data.max_slots;
  out.maxBytes = r.data.max_bytes;
  out.uploads = (r.data.uploads || []).map((u) => ({
    vaultId: u.vault_id, name: u.name, snapshotAt: u.snapshot_at, expiresAt: u.expires_at,
    sizeBytes: u.size_bytes, hasPassword: u.has_password,
  }));
  const mapped = getSlotMap()[String(nexusId)];
  out.mappedVaultId = out.uploads.some((u) => u.vaultId === mapped) ? mapped : null;
  return out;
}

// Pushes to this nexus's previously-mapped slot if one exists, else asks the
// server for a new slot (rejected with quota_exceeded once the account's
// tier limit is reached — the caller must free a slot first).
async function syncPushVault(nexusId, password) {
  const snapshot = serializeVault(nexusId);
  if (!snapshot) return { ok: false, code: 'bad_snapshot', error: 'nexus not found' };
  const existingVaultId = getSlotMap()[String(nexusId)] || null;
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateToken();
    const r = await rpc('token_sync_push', {
      p_snapshot: snapshot, p_name: snapshot.nexus.name, p_token: token,
      p_password: password ? String(password) : null,
      p_vault_id: existingVaultId,
    });
    if (r.ok) {
      setSlotForNexus(nexusId, r.data.vault_id);
      return { ok: true, token, vaultId: r.data.vault_id, pushedAt: r.data.snapshot_at, expiresAt: r.data.expires_at };
    }
    if (r.code !== 'token_collision') return r;
    lastErr = r;
  }
  return lastErr || { ok: false, code: 'server' };
}

function applyPulledSnapshot(nexusId, vaultId, data) {
  let applied;
  try { applied = applySnapshot(nexusId, data.snapshot); }
  catch (e) {
    console.error('sync: applySnapshot failed:', e);
    return { ok: false, code: 'bad_snapshot', error: String(e?.message || e) };
  }
  if (!applied.ok) return applied;
  if (vaultId) setSlotForNexus(nexusId, vaultId);
  return { ok: true, pulledAt: new Date().toISOString(), cloudName: data.name, summary: applied.summary };
}

// Pulls one of the CALLER'S OWN slots (picked from the list syncStatus
// returns) into nexusId — no token needed.
async function syncPullVault(nexusId, vaultId) {
  if (!vaultId) return { ok: false, code: 'no_upload' };
  const r = await rpc('token_sync_pull_own', { p_vault_id: vaultId });
  if (!r.ok) return r;
  return applyPulledSnapshot(nexusId, vaultId, r.data);
}

// Cross-account/cross-device entry point via the shared 16-digit token.
async function syncPullByToken(nexusId, token, password) {
  const tok = String(token || '').replace(/[^0-9]/g, '');
  if (!/^\d{16}$/.test(tok)) return { ok: false, code: 'bad_token' };
  const r = await rpc('token_sync_pull_by_token', { p_token: tok, p_password: password ? String(password) : null });
  if (!r.ok) return r;
  return applyPulledSnapshot(nexusId, r.data.vault_id || null, r.data);
}

async function syncDeleteUpload(vaultId) {
  if (!vaultId) return { ok: false, code: 'no_upload' };
  const r = await rpc('token_sync_delete', { p_vault_id: vaultId });
  if (!r.ok) return r;
  clearSlot(vaultId);
  return { ok: true };
}

module.exports = {
  // isAllowedSyncUrl is exported for src/db/supabase-setup.js, which writes the
  // same sync:url row from the setup page — one copy of the rule, not two.
  getSyncConfig, setSyncConfig, isAllowedSyncUrl, serializeVault, applySnapshot,
  collectModuleSubtreeIds, importModuleSnapshot,
  syncGoogleLogin, syncGoogleLogout, syncAuthStatus,
  syncStatus, syncPushVault, syncPullVault, syncPullByToken, syncDeleteUpload,
};
