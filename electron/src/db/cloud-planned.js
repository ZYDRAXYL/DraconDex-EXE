'use strict';
// Declared-but-not-implemented cloud backends.
//
// These are real entries in the registry rather than a hardcoded list in the
// settings page, for two reasons: the page then has no knowledge of which
// providers exist, and implementing one is a genuinely small change — write
// ./cloud-<id>.js against the contract in ./cloud.js, require it there, and delete
// its spec from PLANNED_SPECS below. Nothing else moves.
//
// Every method answers { ok:false, code:'not_implemented' } so a caller that
// reaches one by any path (a stale active-provider setting, a direct IPC call)
// gets the same shaped result as any other failure instead of a thrown
// TypeError. The registry additionally refuses to make a planned provider
// active at all.
//
// `capabilities` is not aspirational filler — it records what each backend
// could actually support, which is what decides whether the role toggle
// (backup / sync / both) is even offered once it is built. WebDAV and S3 are
// plain file stores with no notion of accounts, so they can back the sync
// snapshot format as easily as the backup one; Dropbox and OneDrive are the
// same shape as Drive.
const PLANNED_SPECS = [
  { id: 'dropbox',  labelKey: 'cloudProviderDropbox',  capabilities: { backup: true, sync: false }, needsConfig: true },
  { id: 'onedrive', labelKey: 'cloudProviderOnedrive', capabilities: { backup: true, sync: false }, needsConfig: true },
  { id: 'webdav',   labelKey: 'cloudProviderWebdav',   capabilities: { backup: true, sync: true },  needsConfig: true },
  { id: 's3',       labelKey: 'cloudProviderS3',       capabilities: { backup: true, sync: true },  needsConfig: true },
];

const NOT_IMPLEMENTED = { ok: false, code: 'not_implemented' };

function plannedProvider(spec) {
  return {
    ...spec,
    availability: 'planned',
    // `configured:false` and `connected:false` are the truth for a backend
    // with no implementation, and they keep the settings row rendering through
    // the same code path as a real provider.
    getConfig: () => ({ configured: false }),
    setConfig: () => NOT_IMPLEMENTED,
    connect: () => NOT_IMPLEMENTED,
    disconnect: () => NOT_IMPLEMENTED,
    status: () => ({ ok: true, configured: false, connected: false, planned: true }),
  };
}

module.exports = { PLANNED_SPECS, plannedProvider };
