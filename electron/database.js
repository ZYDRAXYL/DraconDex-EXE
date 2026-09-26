'use strict';
const core      = require('./src/db/core');
const nexus     = require('./src/db/nexus');
const teach     = require('./src/db/teach');
const preset    = require('./src/db/preset');
const trash     = require('./src/db/trash');
const search    = require('./src/db/search');
const mdExport  = require('./src/db/md-export');
const diviner   = require('./src/db/diviner');
const bundle    = require('./src/db/bundle');
const guide     = require('./src/db/guide');
const problems  = require('./src/db/problems');
const csvImport = require('./src/db/csv-import');
const pageBlock = require('./src/db/page-block');
const htmlExport = require('./src/db/html-export');
const bundleCatalog = require('./src/db/bundle-catalog');
const pageTemplate = require('./src/db/page-template');
const bundleCapture = require('./src/db/bundle-capture');
const scribe    = require('./src/db/scribe');
const wiki      = require('./src/db/wiki');
const color     = require('./src/db/color');
const timeline  = require('./src/db/timeline');
const map       = require('./src/db/map');
const hashtag   = require('./src/db/hashtag');
const sage      = require('./src/db/sage');
const artisan   = require('./src/db/artisan');
const module_   = require('./src/db/module');
const classifier = require('./src/db/classifier');
const wanderer  = require('./src/db/wanderer');
const narrator  = require('./src/db/narrator');
const author    = require('./src/db/author');
const chatscribe = require('./src/db/chatscribe');
const viewer    = require('./src/db/viewer');
const exhibitor = require('./src/db/exhibitor');
const calendar  = require('./src/db/calendar');
const sketcher  = require('./src/db/sketcher');
const designer  = require('./src/db/designer');
const importdock = require('./src/db/importdock');
const versions  = require('./src/db/versions');
const migrate   = require('./src/db/migrate_v3');
const sync      = require('./src/db/sync');
const supabaseSetup = require('./src/db/supabase-setup');
const drive     = require('./src/db/drive');
const update    = require('./src/db/update');
const plugin    = require('./src/db/plugin');
const extension = require('./src/db/extension');
const pkg       = require('./src/db/pkg');
const dbTransfer = require('./src/db/db-transfer');
const mirror    = require('./src/db/mirror');
const vaults    = require('./src/db/vaults');
const transfer  = require('./src/db/transfer');
const cloud     = require('./src/db/cloud');

module.exports = {
  ...core,
  ...nexus,
  ...teach,
  ...preset,
  ...trash,
  ...search,
  ...mdExport,
  ...diviner,
  ...bundle,
  ...guide,
  ...problems,
  ...csvImport,
  ...pageBlock,
  ...htmlExport,
  bundleCatalog: bundleCatalog.bundleCatalog,
  pageCatalog: pageTemplate.pageCatalog, applyTemplate: pageTemplate.applyTemplate,
  restorePageLayout: pageTemplate.restorePageLayout, captureTemplate: pageTemplate.captureTemplate,
  ...bundleCapture,
  ...scribe,
  ...wiki,
  ...color,
  ...timeline,
  ...map,
  ...hashtag,
  ...sage,
  ...artisan,
  ...module_,
  ...classifier,
  ...wanderer,
  ...narrator,
  ...author,
  ...chatscribe,
  ...viewer,
  ...exhibitor,
  ...calendar,
  ...sketcher,
  ...designer,
  ...importdock,
  ...versions,
  ...migrate,
  ...sync,
  ...supabaseSetup,
  ...drive,
  ...update,
  ...plugin,
  ...extension,
  ...pkg,
  ...dbTransfer,
  ...mirror,
  setVaultLocateDir: vaults.setVaultLocateDir,
  ...transfer,
  ...cloud,
};
