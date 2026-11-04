'use strict';
// ═══ Port Link — when a sync runs (Procress 32 part 5) ═════════════════════
// The merge (portlink-merge.js) is one call; this decides when it is made:
//   a drive plugged in      every link on it that changed since its last sync
//   a window closed         that Nexus, if linked and its drive is in
//   Welcome's "Sync now"    one Nexus, with the user's choices if it asked
//   "Eject"                 everything on that drive, then: safe to unplug?
//   the app quitting        everything, as on Eject
// A merge that needs the user's choice is NOT made automatically — it is
// reported, and the link keeps saying "changed on both" until they choose.
// A Nexus with a window open is never merged (its file would be replaced
// under it); it syncs when that window closes.
const drives = require('./portlink-drives');
const pl = require('./portlink');
const { mergeLink } = require('./portlink-merge');
const mount = require('./portlink-mount');
const { getVault } = require('./vaults');

let busy = false;

// → [{ nexusId, name, ok, code?, summary?, conflicts? }] for every link it tried.
function syncLinks({ isOpen = () => false, driveUid = null, only = null } = {}) {
  if (busy) return [];
  busy = true;
  try {
    const out = [];
    const present = new Set(drives.listDrives().map((d) => d.driveUid));
    for (const l of pl.listLinks()) {
      if (only != null && l.nexusId !== only) continue;
      if (driveUid && l.driveUid !== driveUid) continue;
      if (!present.has(l.driveUid) || isOpen(l.nexusId)) continue;
      if (pl.linkStatus(l) === 'synced') continue;
      const r = mergeLink(l.nexusId, { isOpen });
      out.push({ nexusId: l.nexusId, name: getVault(l.nexusId)?.name || '', ...r });
    }
    return out;
  } finally { busy = false; }
}

// Everything on one drive written to it, then whether it is safe to pull.
// pending: what still is not on the drive (a window open, a choice to make,
// a mount still in use) — by name, for the message.
function ejectDrive(driveUid, isOpen = () => false) {
  const pending = [];
  for (const m of mount.listMounts()) {
    if (m.driveUid !== driveUid) continue;
    const r = isOpen(m.nexusId) ? mount.writeBack(m.nexusId) : mount.closeMount(m.nexusId);
    if (isOpen(m.nexusId) || !r.ok) pending.push(getVault(m.nexusId)?.name || '');
  }
  const synced = syncLinks({ isOpen, driveUid });
  for (const r of synced) if (!r.ok) pending.push(r.name);
  for (const l of pl.listLinks()) if (l.driveUid === driveUid && isOpen(l.nexusId)) pending.push(getVault(l.nexusId)?.name || '');
  return { ok: !pending.length, synced, pending: [...new Set(pending)].filter(Boolean) };
}

module.exports = { syncLinks, ejectDrive };
