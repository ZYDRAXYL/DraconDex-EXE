// ═══ Port Link — portable drives in the Welcome list (Procress 32 parts 2–3)
// The main process finds portable DraconDex drives (src/db/portlink-drives.js)
// and pushes the list on every change; this draws each drive's Nexuses under
// the local ones in the Welcome window's left panel.
//
// A drive's Nexus is not opened from here: a window is keyed by the id in
// THIS machine's registry, and a drive's ids are its own (they collide with
// local ones). The way in is a clone (src/db/portlink.js), either way:
// "Clone to this machine" on a drive row, "Clone to <drive>" in a local
// Nexus's ⋯ menu. A linked pair is then ONE row — the local one, with a
// status badge — and its drive twin is not listed again under the drive.

S.portDrives = [];
S.portLinks = [];
S.portMounts = []; // part 3b: drive Nexuses opened straight from the drive (a working copy here)
let _portWatching = false;

// Welcome: the whole list. An app window: just the two places its own Nexus's
// name is shown (title bar, status bar), so the mark follows the drive.
const portRedraw = async () => {
  // a mount closed out or opened elsewhere changes the registry, not only the drives
  if (S.isWelcome) { if (!S.isCreateNexus && S.welcomeStep == null) { await reloadNexuses(); renderWelcomeWindow(); } return; }
  if (!S.nexus) return;
  updateTitlebarVault(); updateStatusBar();
  // the left panel's Nexus header is drawn before the links arrive: a slot
  // (hub/sections.js) filled here instead of redrawing the panel
  document.querySelectorAll('[data-port-nexus]').forEach((el) => { el.innerHTML = portlinkBadgeHtml(Number(el.dataset.portNexus)); });
};
async function portlinkLoadLinks() {
  const [links, mounts] = await Promise.all([api.portlink.links().catch(() => null), api.portlink.mounts().catch(() => null)]);
  S.portLinks = links || [];
  S.portMounts = mounts || [];
}

// Once per window (Welcome and app windows): the current list, then every change main sends.
// Links are re-read with it — their status depends on what is plugged in.
function portlinkWatch() {
  if (_portWatching || !api.portlink) return;
  _portWatching = true;
  const redraw = async (list) => {
    S.portDrives = Array.isArray(list) ? list : [];
    await portlinkLoadLinks();
    portRedraw();
  };
  api.portlink.onDrives(redraw);
  api.portlink.listDrives().then(redraw).catch(() => {});
  // part 5: a sync main ran by itself (a drive in, a window closed) — said once, in Welcome
  if (S.isWelcome && api.portlink.onSynced) api.portlink.onSynced((list) => { for (const r of list || []) portlinkSyncToast(r); });
}

async function portlinkRescan() {
  const list = await api.portlink.rescan().catch(() => null);
  if (!list) return;
  S.portDrives = list;
  await portlinkLoadLinks();
  renderWelcomeWindow();
}

const portDriveOf = (uid) => S.portDrives.find((d) => d.driveUid === uid) || null;
const portLinkOf = (nexusId) => S.portLinks.find((l) => l.nexusId === nexusId) || null;
const portLinkedOnDrive = (uid, id) => S.portLinks.some((l) => l.driveUid === uid && l.driveNexusId === id);
const portDriveName = (uid) => { const d = portDriveOf(uid); return d ? (d.label || d.root) : ''; };
const portMountOf = (nexusId) => S.portMounts.find((m) => m.nexusId === nexusId) || null;

// A working copy (part 3b) is a registry row of ours, but it is the DRIVE's
// Nexus: while its drive is in it is listed under the drive, not here. With
// the drive out (not written back yet) or after a conflict it shows here, so
// the work in it is never out of sight. core/nexus.js recentNexuses() asks.
function portlinkHidesLocal(nexusId) {
  const m = portMountOf(nexusId);
  return !!m && m.state !== 'conflict' && !!portDriveOf(m.driveUid);
}

// ── A local Nexus that is linked: a badge on its own row (nexusRowHtml) ────
const PORT_STATUS_KEY = { synced: 'portStatusSynced', local: 'portStatusLocal', drive: 'portStatusDrive', both: 'portStatusBoth', away: 'portStatusAway' };
const PORT_STATUS_CLS = { synced: 'port-synced', local: 'port-changed', drive: 'port-changed', both: 'port-both', away: 'port-away' };
const PORT_MOUNT_KEY = { open: 'portMountOpen', pending: 'portMountPending', conflict: 'portMountConflict' };
const PORT_MOUNT_CLS = { open: 'port-synced', pending: 'port-away', conflict: 'port-both' };
function portlinkBadgeHtml(nexusId) {
  const m = portMountOf(nexusId);
  if (m) {
    const tip = t(PORT_MOUNT_KEY[m.state] || 'portMountOpen').replace('{d}', portDriveName(m.driveUid) || t('portDrives'));
    return `<span class="port-mark ${PORT_MOUNT_CLS[m.state] || 'port-away'}" title="${x(tip)}" aria-label="${x(tip)}" data-no-i18n>${I.drive}</span>`;
  }
  const l = portLinkOf(nexusId);
  if (!l) return '';
  const tip = t(PORT_STATUS_KEY[l.status] || 'portStatusAway').replace('{d}', portDriveName(l.driveUid));
  return `<span class="port-mark ${PORT_STATUS_CLS[l.status] || 'port-away'}" title="${x(tip)}" aria-label="${x(tip)}" data-no-i18n>${I.link}</span>`;
}

// ── The drive section ──────────────────────────────────────────────────────
function portlinkRowHtml(d, n) {
  const where = t('portOnDrive').replace('{d}', d.root);
  const menu = `portlinkNexusMenu(this,'${x(d.driveUid)}',${Number(n.id)})`;
  // part 3b: a click opens it like any Nexus (a working copy, saved back to the drive)
  const open = n.missing || d.running ? menu : `portlinkOpenFromDrive('${x(d.driveUid)}',${Number(n.id)})`;
  return listRowHtml({
    icon: `<span class="nexus-vault-dot" style="${n.color_code ? `background:${x(n.color_code)}` : ''}"></span>`,
    title: n.name, count: n.project_count,
    // grey name + a drive icon: on the drive only, not on this machine
    state: { disabled: !!n.missing }, cls: 'port-on-drive', trailing: n.missing ? I.alert : `<span class="port-mark" aria-hidden="true">${I.drive}</span>`,
    tip: n.missing ? t('nexusFileMissing') : d.running ? t('portRunning') : where,
    onclick: open, menu, attrs: 'data-no-i18n',
  });
}

// One block per drive: its path as the heading (the user knows their drive by
// its letter), a lock when the portable app on it is open, then the Nexuses
// on it that are NOT already linked here (those are the local row's badge).
function portlinkSectionHtml() {
  if (!S.portDrives.length) return '';
  const head = `<div class="ph"><h4>${t('portDrives')}</h4>
    <button class="btn btn-g btn-i" onclick="portlinkRescan()" title="${x(t('portRescan'))}" aria-label="${x(t('portRescan'))}">${I.refresh}</button></div>`;
  return head + S.portDrives.map((d) => {
    const eject = d.running ? '' : `<button class="btn btn-g btn-i" onclick="portlinkEject('${x(d.driveUid)}')" title="${x(t('portEject'))}" aria-label="${x(t('portEject'))}">${I.arrowUp}</button>`;
    const label = `<div class="welcome-recent-label port-drive-label" data-no-i18n title="${x(d.running ? `${d.root} — ${t('portRunning')}` : d.root)}">${I.drive}<span>${x(d.label || d.root)}</span>${d.running ? I.lock : eject}</div>`;
    const own = d.nexuses.filter((n) => !portLinkedOnDrive(d.driveUid, n.id));
    const body = own.length
      ? listHtml({ list: `port-${d.driveUid}`, aria: d.root, body: own.map((n) => portlinkRowHtml(d, n)).join('') })
      : d.nexuses.length ? '' : `<div class="welcome-side-empty">${t('portEmpty')}</div>`;
    return label + body;
  }).join('');
}

const portMenuRow = (fn, label, off = false) => off
  ? `<div class="kind-list-item ls-off" aria-disabled="true"><span class="kli-name">${label}</span></div>`
  : `<div class="kind-list-item" onclick="closeAllPopups();${fn}"><span class="kli-name">${label}</span></div>`;

function portlinkNexusMenu(anchor, uid, id) {
  closeAllPopups();
  const d = portDriveOf(uid);
  const n = d?.nexuses.find((v) => v.id === id);
  if (!anchor || !n) return;
  openPopover(anchor, `
    <div class="popover-head"><span data-no-i18n>${x(n.name)}</span></div>
    ${portMenuRow(`portlinkOpenFromDrive('${x(uid)}',${Number(id)})`, d.running ? t('portRunning') : t('wmOpenNexus'), !!n.missing || d.running)}
    ${portMenuRow(`portlinkCloneFromDrive('${x(uid)}',${Number(id)})`, t('portCloneHere'), !!n.missing || d.running)}
    ${portMenuRow(`portlinkReveal('${x(uid)}',${Number(id)})`, t('nexusRevealFile'), !!n.missing)}`,
  { cls: 'nexus-options-popup', role: 'menu', keep: true, focus: false });
}

// For a local Nexus's ⋯ menu (nexus-options.js): "Clone to <drive>" per drive
// plugged in, while it is not linked yet. Empty in an app window, which does
// not watch drives.
function portlinkMenuRowsHtml(nexusId) {
  const l = portLinkOf(nexusId);
  // part 5: a linked one syncs, or stops syncing
  if (l) return portMenuRow(`portlinkSyncNow(${Number(nexusId)})`, t('portSyncNow'), l.status === 'away' || l.status === 'synced')
    + portMenuRow(`portlinkUnlink(${Number(nexusId)})`, t('portUnlink')) + '<div class="ctx-sep"></div>';
  if (!S.portDrives.length || portMountOf(nexusId)) return '';
  return S.portDrives.map((d) => portMenuRow(`portlinkCloneToDrive(${Number(nexusId)},'${x(d.driveUid)}')`,
    d.running ? `${x(d.label || d.root)} — ${t('portRunning')}` : t('portCloneTo').replace('{d}', x(d.label || d.root)), d.running)).join('')
    + '<div class="ctx-sep"></div>';
}

async function portlinkAfterClone(r, uid) {
  if (!r?.ok) return toast(r?.code === 'drive_busy' ? t('portRunning') : t('portCloneFailed'), 'error');
  await reloadNexuses();
  S.portDrives = (await api.portlink.listDrives().catch(() => null)) || S.portDrives;
  await portlinkLoadLinks();
  renderWelcomeWindow();
  toast(t('portCloned').replace('{d}', portDriveName(uid)), 'ok');
}
async function portlinkCloneToDrive(nexusId, uid) {
  toast(t('portCloning'));
  portlinkAfterClone(await api.portlink.cloneToDrive(nexusId, uid).catch(() => null), uid);
}
async function portlinkCloneFromDrive(uid, id) {
  toast(t('portCloning'));
  portlinkAfterClone(await api.portlink.cloneFromDrive(uid, id).catch(() => null), uid);
}

// ── Part 5: sync, the conflict chooser, eject, unlink ─────────────────────
const portNexusName = (id) => (S.nexuses.find((n) => n.id === id) || {}).name || '';
function portlinkSyncToast(r) {
  if (r.ok) {
    const s = r.summary || {};
    return toast(t('portSynced').replace('{name}', r.name || portNexusName(r.nexusId))
      .replace('{a}', (s.fromLocal || 0) + (s.driveAdded || 0)).replace('{u}', (s.updated || 0) + (s.driveChanged || 0)).replace('{r}', (s.deleted || 0) + (s.driveRemoved || 0)), 'ok');
  }
  // a choice to make: the toast takes you straight to it
  if (r.code === 'needs_choice') return toastAction(`${r.name || portNexusName(r.nexusId)} — ${t('portStatusBoth')}`, t('portSyncNow'), () => portlinkSyncNow(r.nexusId), '', 9000);
  if (r.code === 'open') return toast(t('portSyncOpen'));
  if (r.code === 'drive_busy') return toast(t('portRunning'), 'error');
  toast(t('portSyncFailed'), 'error');
}
async function portlinkAfterSync(id, r) {
  portlinkSyncToast({ nexusId: id, ...r });
  await reloadNexuses();
  await portlinkLoadLinks();
  portRedraw();
}
async function portlinkSyncNow(id, choices = null) {
  const r = await api.portlink.merge(id, choices || {}).catch(() => null);
  if (r?.code === 'needs_choice') return portlinkChoose(id, r.conflicts || []);
  portlinkAfterSync(id, r || { ok: false });
}

// One row per field both sides changed: the two values, and which to keep.
// Closing the dialog writes nothing — the merge only runs on Apply.
let _portChoice = { id: null, list: [], pick: {} };
function portlinkChoose(id, conflicts) {
  _portChoice = { id, list: conflicts, pick: {} };
  const val = (v) => (v == null || v === '' ? '—' : String(v));
  const rows = conflicts.map((c, i) => `
    <div class="port-choice" data-i="${i}">
      <div class="port-choice-head" data-no-i18n>${x(c.label || c.table)} · ${x(c.col)}</div>
      ${segmentedHtml([
        { value: 'local', text: `${t('portThisMachine')}: ${val(c.local)}`, title: c.localAt || '' },
        { value: 'drive', text: `${t('portTheDrive')}: ${val(c.drive)}`, title: c.driveAt || '' },
      ], null, { role: 'radiogroup', aria: `${c.label || c.table} · ${c.col}`, fill: true, noI18n: true, onclick: (v) => `portlinkPick(this,${i},'${v}')` })}
    </div>`).join('');
  openModal(t('portChooseTitle'), `<div class="port-choices">${rows}</div>`, {
    hint: t('portChooseHint').replace('{n}', conflicts.length), size: 'lg',
    footer: `<button class="btn btn-s" onclick="portlinkPickAll('local')">${t('portUseLocalAll')}</button>
      <button class="btn btn-s" onclick="portlinkPickAll('drive')">${t('portUseDriveAll')}</button>
      <button class="btn btn-p" id="port-apply" disabled onclick="portlinkApplyChoices()">${t('apply')}</button>`,
  });
}
function portlinkPick(btn, i, v) {
  _portChoice.pick[_portChoice.list[i].key] = v;
  segmentedSelect(btn.closest('.seg'), v);
  const ap = q('#port-apply');
  if (ap) ap.disabled = Object.keys(_portChoice.pick).length < _portChoice.list.length;
}
function portlinkPickAll(v) {
  document.querySelectorAll('.port-choice').forEach((row) => {
    const i = Number(row.dataset.i);
    _portChoice.pick[_portChoice.list[i].key] = v;
    segmentedSelect(row.querySelector('.seg'), v);
  });
  const ap = q('#port-apply');
  if (ap) ap.disabled = false;
}
function portlinkApplyChoices() {
  const { id, pick } = _portChoice;
  closeModal();
  portlinkSyncNow(id, pick);
}

async function portlinkUnlink(id) {
  if (!(await uiConfirm(t('portUnlink'), { okText: t('portUnlink'), cancelText: t('cancel'), danger: false }))) return;
  const r = await api.portlink.unlink(id).catch(() => null);
  if (!r?.ok) return toast(t('portSyncFailed'), 'error');
  toast(t('portUnlinked'), 'ok');
  await portlinkLoadLinks();
  portRedraw();
}

async function portlinkEject(uid) {
  const name = portDriveName(uid);
  const r = await api.portlink.eject(uid).catch(() => null);
  for (const s of r?.synced || []) portlinkSyncToast(s);
  if (r?.ok) toast(t('portEjectReady').replace('{d}', name), 'ok');
  else toast(t('portEjectPending').replace('{n}', (r?.pending || []).join(', ')));
  await reloadNexuses();
  await portlinkLoadLinks();
  portRedraw();
}

async function portlinkOpenFromDrive(uid, id) {
  const r = await api.portlink.openFromDrive(uid, id).catch(() => null);
  if (!r?.ok) return toast(r?.code === 'drive_busy' ? t('portRunning') : t('portOpenFailed'), 'error');
  await reloadNexuses();
  await portlinkLoadLinks();
  welcomeOpenNexus(r.nexusId);
}

async function portlinkReveal(uid, id) {
  const r = await api.portlink.reveal(uid, id).catch(() => null);
  if (!r?.ok) toast(t('nexusFileMissing'), 'error');
}
