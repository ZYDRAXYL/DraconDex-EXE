'use strict';
// Extensions (Procress 10 part 1) — a Settings page listing GitHub repos
// generated from the ZYDRAXYL/DraconDex-EXT-Template template, so a user can
// discover available extensions without already having a repo URL. This is
// its own concept from Plugins (plugin.js): a Plugin is downloaded and run
// inside this app; an Extension here is just discovered and opened on
// GitHub — nothing about install/sandboxing applies. See plugin.js's
// pluginListOrgRepos for the sibling pattern this mirrors.
const { isTemplateRepoName } = require('./plugin-manifest');

const EXT_TEMPLATE_FULL_NAME = 'ZYDRAXYL/DraconDex-EXT-Template';

// GitHub's REST API has no "list repos generated from template X" endpoint —
// only a per-repo `template_repository` field on GET /repos/{owner}/{repo},
// absent from the list-repos response used below. So, same scope as
// pluginListOrgRepos, this only ever sees the ZYDRAXYL account's own repos
// and pays one secondary fetch per candidate to read that field — it cannot
// discover a third-party repo made from the template under another account.
async function repoTemplateFullName(repoName) {
  try {
    const res = await fetch(`https://api.github.com/repos/ZYDRAXYL/${encodeURIComponent(repoName)}`, {
      headers: { 'User-Agent': 'DraconDex', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.template_repository?.full_name || null;
  } catch (e) { return null; }
}

async function extensionListRepos() {
  let res;
  try {
    res = await fetch('https://api.github.com/users/ZYDRAXYL/repos?per_page=100&sort=updated', {
      headers: { 'User-Agent': 'DraconDex', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { return { ok: false }; }
  if (!res.ok) return { ok: false };
  let repos;
  try { repos = await res.json(); } catch (e) { return { ok: false }; }
  if (!Array.isArray(repos)) return { ok: false };
  // The template itself is excluded the same way pluginListOrgRepos excludes
  // DraconDex-PGI-Template: recommending the template back as an "extension"
  // to install would be nonsense.
  const candidates = repos.filter((repo) => !repo.is_template && !repo.archived && !isTemplateRepoName(repo.name));
  const templateNames = await Promise.all(candidates.map((repo) => repoTemplateFullName(repo.name)));
  return {
    ok: true,
    repos: candidates
      .filter((_, i) => templateNames[i] === EXT_TEMPLATE_FULL_NAME)
      .map((repo) => ({ name: repo.name, description: repo.description || '', stars: repo.stargazers_count || 0 })),
  };
}

module.exports = { extensionListRepos };
