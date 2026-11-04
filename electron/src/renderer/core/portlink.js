// ═══ Port Link — portable drives in the Welcome list (Procress 32 part 2) ══
// The main process finds portable DraconDex drives (src/db/portlink-drives.js)
// and pushes the list on every change; this draws each drive's Nexuses under
// the local ones in the Welcome window's left panel.
//
// A drive's Nexus is not opened from here: a window is keyed by the id in
// THIS machine's registry, and a drive's ids are its own (they collide with
// local ones). The way in is cloning it to this machine (part 3), which then
// keeps the two in sync — the row's menu gets that action there.

S.portDrives = [];
let _portWatching = false;

// Once per Welcome window: the current list, then every change main sends.
function portlinkWatch() {
  if (_portWatching || !api.portlink) return;
  _portWatching = true;
  const redraw = (list) => {
    S.portDrives = Array.isArray(list) ? list : [];
    if (S.isWelcome && !S.isCreateNexus && S.welcomeStep == null) renderWelcomeWindow();
  };
  api.portlink.onDrives(redraw);
  api.portlink.listDrives().then(redraw).catch(() => {});
}

async function portlinkRescan() {
  const list = await api.portlink.rescan().catch(() => null);
  if (list) { S.portDrives = list; renderWelcomeWindow(); }
}

const portDriveOf = (uid) => S.portDrives.find((d) => d.driveUid === uid) || null;

function portlinkRowHtml(d, n) {
  const where = t('portOnDrive').replace('{d}', d.root);
  const open = `portlinkNexusMenu(this,'${x(d.driveUid)}',${Number(n.id)})`;
  return listRowHtml({
    icon: `<span class="nexus-vault-dot" style="${n.color_code ? `background:${x(n.color_code)}` : ''}"></span>`,
    title: n.name, count: n.project_count,
    state: { disabled: !!n.missing }, trailing: n.missing ? I.alert : '',
    tip: n.missing ? t('nexusFileMissing') : d.running ? t('portRunning') : where,
    onclick: open, menu: open, attrs: 'data-no-i18n',
  });
}

// One block per drive: its path as the heading (the user knows their drive by
// its letter), a lock when the portable app on it is open, then its Nexuses.
function portlinkSectionHtml() {
  if (!S.portDrives.length) return '';
  const head = `<div class="ph"><h4>${t('portDrives')}</h4>
    <button class="btn btn-g btn-i" onclick="portlinkRescan()" title="${x(t('portRescan'))}" aria-label="${x(t('portRescan'))}">${I.refresh}</button></div>`;
  return head + S.portDrives.map((d) => {
    const label = `<div class="welcome-recent-label port-drive-label" data-no-i18n title="${x(d.running ? `${d.root} — ${t('portRunning')}` : d.root)}">${I.drive}<span>${x(d.label || d.root)}</span>${d.running ? I.lock : ''}</div>`;
    const body = d.nexuses.length
      ? listHtml({ list: `port-${d.driveUid}`, aria: d.root, body: d.nexuses.map((n) => portlinkRowHtml(d, n)).join('') })
      : `<div class="welcome-side-empty">${t('portEmpty')}</div>`;
    return label + body;
  }).join('');
}

function portlinkNexusMenu(anchor, uid, id) {
  closeAllPopups();
  const d = portDriveOf(uid);
  const n = d?.nexuses.find((v) => v.id === id);
  if (!anchor || !n) return;
  const row = (fn, label, off = false) => off
    ? `<div class="kind-list-item ls-off" aria-disabled="true"><span class="kli-name">${label}</span></div>`
    : `<div class="kind-list-item" onclick="closeAllPopups();${fn}"><span class="kli-name">${label}</span></div>`;
  openPopover(anchor, `
    <div class="popover-head"><span data-no-i18n>${x(n.name)}</span></div>
    ${row(`portlinkReveal('${x(uid)}',${Number(id)})`, t('nexusRevealFile'), !!n.missing)}`,
  { cls: 'nexus-options-popup', role: 'menu', keep: true, focus: false });
}

async function portlinkReveal(uid, id) {
  const r = await api.portlink.reveal(uid, id).catch(() => null);
  if (!r?.ok) toast(t('nexusFileMissing'), 'error');
}
