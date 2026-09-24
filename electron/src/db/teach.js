'use strict';
// Just-in-time tips (v5 Part 6, APP docs/V5.md §10.4) — the vault side of
// core/teach.js. nexus.taught is a JSON object, tip id -> 'shown' | 'done' |
// 'dismissed', kept in the vault's own nexus row so it travels with the file.
const { getVaultDB } = require('./core');

const TAUGHT_STATES = new Set(['shown', 'done', 'dismissed']);

function getTaught(nexusId) {
  const raw = getVaultDB(nexusId).prepare(`SELECT taught FROM nexus WHERE id=?`).get(nexusId)?.taught;
  try { const o = JSON.parse(raw || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }
  catch (_) { return {}; }
}

function markTaught(nexusId, tipId, state) {
  const id = String(tipId || '');
  if (!/^[a-z][a-zA-Z0-9]{0,40}$/.test(id) || !TAUGHT_STATES.has(state)) throw new Error('bad tip');
  const cur = getTaught(nexusId);
  // 'shown' never overwrites a final answer.
  if (state === 'shown' && cur[id]) return cur;
  cur[id] = state;
  getVaultDB(nexusId).prepare(`UPDATE nexus SET taught=? WHERE id=?`).run(JSON.stringify(cur), nexusId);
  return cur;
}

module.exports = { getTaught, markTaught };
