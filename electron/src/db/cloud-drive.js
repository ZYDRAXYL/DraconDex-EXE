'use strict';
// Google Drive, as seen through the cloud-provider contract (./cloud.js).
//
// This is an ADAPTER, not a move: every line of the actual implementation
// stays in src/db/drive.js, and the drive:* IPC surface the Backup settings
// page uses is untouched. Drive backup behaves exactly as it did before the
// registry existed — this file only lets it appear in the Cloud Storage list
// alongside the not-yet-implemented backends, so the list is honest about
// what the app can do today rather than showing four stubs and hiding the one
// thing that works.
const {
  getDriveConfig, setDriveConfig, driveConnect, driveDisconnect, driveStatus,
} = require('./drive');

module.exports = {
  id: 'gdrive',
  labelKey: 'cloudProviderGdrive',
  availability: 'available',
  // Drive backs up the layout profile and the database file; it has never been
  // a sync backend (that was Token Sync's job, disabled since v4.5.0).
  capabilities: { backup: true, sync: false },
  // The user pastes their own Google Cloud "Desktop app" client id/secret —
  // the app ships no credentials of its own, which is the same principle the
  // whole registry exists to generalise.
  needsConfig: true,

  getConfig: () => getDriveConfig(),
  setConfig: (cfg) => setDriveConfig(cfg?.clientId, cfg?.clientSecret),
  connect: () => driveConnect(),
  disconnect: () => driveDisconnect(),
  status: () => driveStatus(),
};
