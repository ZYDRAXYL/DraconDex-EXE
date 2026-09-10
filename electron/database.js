'use strict';
const core      = require('./src/db/core');
const nexus     = require('./src/db/nexus');
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
const pkg       = require('./src/db/pkg');
const dbTransfer = require('./src/db/db-transfer');
const cloud     = require('./src/db/cloud');

module.exports = {
  ...core,
  ...nexus,
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
  ...pkg,
  ...dbTransfer,
  ...cloud,
};
