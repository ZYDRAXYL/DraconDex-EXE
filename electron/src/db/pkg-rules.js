'use strict';
// The pure half of pkg.js's validation (Procress 23): what a uistyle package
// may set, and whether this app is new enough for a package. Split out so a
// plain `node --test` can load it — pkg.js itself reaches for electron at load.
//
// Must match DraconDex-PKG's tools/build-packages.mjs (UISTYLE_TOKENS,
// GLASS_TOKENS, their ranges, CSS_VALUE, verGte). Duplicated rather than
// shared because the app cannot read that repo at runtime, and the app is the
// side that must not be fooled.

// The 7 shape/elevation tokens css/ui-style.css assigns per
// body[data-ui-style="<name>"] — all 7 required.
const UISTYLE_TOKENS = ['--r','--rs','--rl','--shadow-pop','--shadow-float','--shadow-menu','--shadow-modal'];
// The optional glass group on top of them: all four or none. A half-set group
// would draw some panes glass and others not.
const GLASS_TOKENS = ['--glass-blur','--glass-tint','--glass-stroke','--glass-shadow'];
const CSS_VALUE = /^[#a-zA-Z0-9\s(),.%/-]{1,80}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

/** null when `vars` is a valid uistyle payload, else the reason. */
function validateUistyleVars(vars) {
  if (!vars || typeof vars !== 'object') return 'uistyle has no vars';
  for (const [k, v] of Object.entries(vars)) {
    if (!UISTYLE_TOKENS.includes(k) && !GLASS_TOKENS.includes(k)) return `unknown ui-style token "${k}"`;
    if (typeof v !== 'string' || !CSS_VALUE.test(v)) return `unsafe value for "${k}"`;
  }
  for (const req of UISTYLE_TOKENS) if (!vars[req]) return `missing required token ${req}`;
  if (GLASS_TOKENS.some(k => k in vars)) {
    for (const req of GLASS_TOKENS) if (!vars[req]) return `glass tokens are all-or-nothing — missing ${req}`;
    const blur = /^(\d+(?:\.\d+)?)px$/.exec(vars['--glass-blur']);
    if (!blur || +blur[1] > 40) return `--glass-blur "${vars['--glass-blur']}" must be 0–40px`;
    const tint = /^(\d+(?:\.\d+)?)%$/.exec(vars['--glass-tint']);
    if (!tint || +tint[1] < 50 || +tint[1] > 100) return `--glass-tint "${vars['--glass-tint']}" must be 50–100%`;
  }
  return null;
}

/** a >= b for x.y.z versions (a pre-release suffix on `a` is ignored). */
function verGte(a, b) {
  const [x, y] = [a, b].map(v => String(v).split('-')[0].split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return true;
}

/** Whether an app at `appVersion` may install a package asking for `minAppVersion`.
 *  No minimum (or a malformed one the catalog should never carry) = any app. */
function meetsMinApp(minAppVersion, appVersion) {
  if (!minAppVersion) return true;
  if (!SEMVER.test(String(minAppVersion))) return false;
  return verGte(appVersion, minAppVersion);
}

module.exports = { UISTYLE_TOKENS, GLASS_TOKENS, CSS_VALUE, validateUistyleVars, verGte, meetsMinApp };
