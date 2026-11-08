// Génère public/digest.json : résumé quotidien + hebdomadaire de l'activité GitHub d'une organisation.
// Node 20+, aucune dépendance. Résumé 100 % règles (gratuit) ; IA gratuite optionnelle (USE_LLM=1).
import { writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ORG    = process.env.ORG || 'GeniusVentures';
const DAYS   = Number(process.env.DAYS || 7);
const TZ     = process.env.TZ_NAME || 'Europe/Zurich';   // fuseau utilisé pour découper les jours
const TOKEN  = process.env.GITHUB_TOKEN || '';
const API    = 'https://api.github.com';

/* ---------------- GitHub API ---------------- */
async function gh(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: {
    Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'gnus-digest',
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) } });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${url.pathname}`);
  return res.json();
}
async function ghAll(path, params = {}, maxPages = 5) {
  let out = [];
  for (let page = 1; page <= maxPages; page++) {
    const d = await gh(path, { ...params, per_page: 100, page });
    out = out.concat(d);
    if (d.length < 100) break;
  }
  return out;
}

async function ghql(query, variables) {
  if (!TOKEN) throw new Error('GITHUB_TOKEN is required (GraphQL API needs authentication)');
  const res = await fetch(API + '/graphql', { method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'gnus-digest' },
    body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}`);
  const j = await res.json();
  if (j.errors) throw new Error('GitHub GraphQL: ' + j.errors.map(e => e.message).join('; '));
  return j.data;
}

// Commits de TOUTES les branches d'un repo depuis `since` (1 requête par page de 100 branches)
const COMMITS_QUERY = `query($owner:String!,$name:String!,$since:GitTimestamp!,$after:String){
  repository(owner:$owner,name:$name){
    refs(refPrefix:"refs/heads/",first:100,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{ name target{ ... on Commit{ history(since:$since,first:100){ nodes{ oid url message committedDate author{ name user{login} } } } } } }
    }
  }
}`;
async function fetchCommitsAllBranches(name, since) {
  const byOid = new Map();
  let after = null;
  for (let page = 0; page < 3; page++) {
    const d = await ghql(COMMITS_QUERY, { owner: ORG, name, since: since.toISOString(), after });
    const refs = d.repository.refs;
    for (const b of refs.nodes) {
      for (const c of b.target?.history?.nodes || []) {
        const cur = byOid.get(c.oid);
        if (cur) cur.branches.add(b.name);
        else byOid.set(c.oid, { sha: c.oid, url: c.url, date: c.committedDate, message: c.message,
          author: c.author?.user?.login || c.author?.name || 'unknown', branches: new Set([b.name]) });
      }
    }
    if (!refs.pageInfo.hasNextPage) break;
    after = refs.pageInfo.endCursor;
  }
  return [...byOid.values()].map(c => ({ ...c, branches: [...c.branches] }));   // dédoublonné par SHA
}

async function fetchActivity(since) {
  const repos = await ghAll(`/orgs/${ORG}/repos`, { type: 'public', sort: 'pushed', direction: 'desc' }, 3);
  const active = repos.filter(r => !r.archived && r.pushed_at && new Date(r.pushed_at) >= since);
  const out = [];
  for (let i = 0; i < active.length; i += 5) {
    const chunk = await Promise.all(active.slice(i, i + 5).map(async r => {
      const [commits, releases] = await Promise.all([
        fetchCommitsAllBranches(r.name, since),
        gh(`/repos/${ORG}/${r.name}/releases`, { per_page: 5 }).catch(() => []),
      ]);
      return {
        name: r.name, url: r.html_url,
        commits,
        releases: releases.filter(x => x.published_at && new Date(x.published_at) >= since && !x.draft)
          .map(x => ({ name: x.name || x.tag_name, tag: x.tag_name, url: x.html_url, date: x.published_at })),
      };
    }));
    out.push(...chunk);
  }
  return out;
}

/* ---------------- Résumé par règles ---------------- */
const RULES = [
  ['tests',      /^(test|tests)\b|\b(tests?|flaky|stabili[sz]e)\b/i],
  ['upgraded',   /^(bump|upgrade)\b|\b(upgrade[sd]?|bump(ed)?|update[sd]? (to|dependenc|version))/i],
  ['fixed',      /^(fix|bugfix|hotfix)\b|\b(fix(es|ed)?|bug|crash|repair|resolve[sd]?)\b/i],
  ['added',      /^(feat|add|implement|introduce|support)\b|\b(add(s|ed)?|implement(s|ed)?|introduc(e|ed)|support)\b/i],
  ['docs',       /^docs?\b|\b(readme|documentation)\b/i],
  ['build',      /^(ci|build|chore|release)\b|\b(workflow|pipeline|cmake|release|version)\b/i],
  ['refactored', /^(refactor|cleanup|clean up|style)\b|\b(refactor|cleanup|rename)\b/i],
];
const VERB = { fixed: 'Fixed', added: 'Added', upgraded: 'Upgraded', tests: 'Test work', docs: 'Docs',
               build: 'Build/release', refactored: 'Refactored', updated: 'Updated' };
const ORDER = ['added', 'fixed', 'upgraded', 'tests', 'build', 'refactored', 'docs', 'updated'];

export function classify(subject) {
  for (const [type, re] of RULES) if (re.test(subject)) return type;
  return 'updated';
}
export function cleanSubject(msg) {
  let s = msg.split('\n')[0].trim();
  s = s.replace(/^(\w+)(\([^)]+\))?!?:\s*/, '');            // préfixe « feat(x): »
  s = s.replace(/\s*\(#\d+\)\s*$/, '').replace(/\s*#\d+\s*$/, ''); // numéros de PR
  if (s.length > 90) s = s.slice(0, 87).trimEnd() + '…';
  if (/^[A-Z][a-z]/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  return s;
}
const isNoise = m => /^(Merge (branch|pull request|remote-tracking)|Revert "Revert)/i.test(m);

const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d)); // YYYY-MM-DD
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function summarizeRepoDay(commits) {
  const groups = {};
  for (const c of commits) {
    const subj = cleanSubject(c.message);
    (groups[classify(c.message.split('\n')[0])] ||= []).push(subj);
  }
  const items = ORDER.filter(t => groups[t]).map(t => {
    const strip = x => ['fixed', 'added', 'upgraded', 'updated'].includes(t)
      ? x.replace(/^(fix(es|ed)?|add(s|ed)?|implement(s|ed)?|upgrade[sd]?|bump(ed)?|update[sd]?)\s+/i, '') : x;
    const uniq = [...new Set(groups[t].map(strip))];
    const shown = uniq.slice(0, 2).join('; ');
    const more = uniq.length > 2 ? ` (+${uniq.length - 2} more)` : '';
    const text = t === 'tests' && uniq.length > 2
      ? `${VERB[t]} (${plural(groups[t].length, 'commit')}), e.g. ${shown}`
      : `${VERB[t]}: ${shown}${more}`;
    return { type: t, label: VERB[t].toLowerCase(), count: groups[t].length, text };
  });
  return items;
}

export function buildDigest(activity, now = new Date(), days = DAYS) {
  // liste des jours (aujourd'hui en premier)
  const keys = [];
  for (let i = 0; i < days; i++) keys.push(dayKey(new Date(now.getTime() - i * 86400000)));

  const perDay = Object.fromEntries(keys.map(k => [k, { date: k, repos: [], releases: [] }]));
  const contributors = new Set();
  const repoTotals = {};
  const typeTotals = {};

  for (const repo of activity) {
    const byDay = {};
    for (const c of repo.commits) {
      const first = c.message.split('\n')[0];
      if (isNoise(first)) continue;
      const k = dayKey(c.date);
      if (!perDay[k]) continue;
      (byDay[k] ||= []).push(c);
      contributors.add(c.author);
    }
    for (const [k, commits] of Object.entries(byDay)) {
      const items = summarizeRepoDay(commits);
      const branches = [...new Set(commits.flatMap(c => c.branches || []))];
      perDay[k].repos.push({ name: repo.name, url: repo.url, commits: commits.length, branches, items });
      repoTotals[repo.name] = (repoTotals[repo.name] || 0) + commits.length;
      for (const it of items) typeTotals[it.type] = (typeTotals[it.type] || 0) + it.count;
    }
    for (const r of repo.releases) {
      const k = dayKey(r.date);
      if (perDay[k]) perDay[k].releases.push({ repo: repo.name, ...r });
    }
  }

  const daysOut = keys.map(k => {
    const d = perDay[k];
    d.repos.sort((a, b) => b.commits - a.commits);
    const total = d.repos.reduce((s, r) => s + r.commits, 0);
    if (!total && !d.releases.length) {
      d.headline = 'A quiet day with no new code activity on GitHub.';
    } else {
      const parts = d.repos.slice(0, 3).map(r => `${r.name} (${r.items.slice(0, 2).map(i => i.label).join(', ')})`);
      d.headline = `${plural(total, 'commit')} across ${plural(d.repos.length, 'repo')}` +
        (parts.length ? `: ${parts.join(', ')}` : '') +
        (d.releases.length ? `. Released ${d.releases.map(r => `${r.repo} ${r.tag}`).join(', ')}` : '') + '.';
    }
    d.commits = total;
    return d;
  });

  const topRepos = Object.entries(repoTotals).sort((a, b) => b[1] - a[1]);
  const totalCommits = topRepos.reduce((s, [, n]) => s + n, 0);
  const allReleases = daysOut.flatMap(d => d.releases);
  const week = {
    from: keys[keys.length - 1], to: keys[0],
    commits: totalCommits, repos: topRepos.length, contributors: contributors.size,
    releases: allReleases.length,
    topRepos: topRepos.slice(0, 5).map(([name, commits]) => ({ name, commits })),
    byType: typeTotals,
    headline: totalCommits
      ? `${plural(totalCommits, 'commit')} by ${plural(contributors.size, 'contributor')} across ${plural(topRepos.length, 'repo')}. ` +
        `Most active: ${topRepos.slice(0, 3).map(([n, c]) => `${n} (${c})`).join(', ')}.` +
        (allReleases.length ? ` ${plural(allReleases.length, 'release')} published.` : '')
      : 'No code activity on GitHub this week.',
  };
  return { generatedAt: now.toISOString(), org: ORG, timezone: TZ, week, days: daysOut };
}

/* ---------------- IA gratuite optionnelle (GitHub Models) ---------------- */
async function polishWithLLM(digest) {
  const res = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'openai/gpt-4.1-mini', temperature: 0.2,
      messages: [
        { role: 'system', content: 'You write a short GitHub digest, always in English, for non-developers. For each day write 1-2 sentences (no jargon, no commit hashes). Also write a 3-sentence weekly summary. Reply ONLY with JSON: {"week":"...","days":{"YYYY-MM-DD":"..."}}.' },
        { role: 'user', content: JSON.stringify({ week: digest.week, days: digest.days.map(d => ({ date: d.date, repos: d.repos.map(r => ({ repo: r.name, items: r.items.map(i => i.text) })), releases: d.releases.map(r => `${r.repo} ${r.tag}`) })) }) },
      ] }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const txt = (await res.json()).choices[0].message.content.replace(/```json|```/g, '').trim();
  const j = JSON.parse(txt);
  digest.week.summary = j.week;
  for (const d of digest.days) if (j.days?.[d.date]) d.summary = j.days[d.date];
  return digest;
}

/* ---------------- main ---------------- */
async function main() {
  const now = new Date();
  const since = new Date(now.getTime() - (DAYS + 1) * 86400000);
  const activity = await fetchActivity(since);
  let digest = buildDigest(activity, now);
  if (process.env.USE_LLM === '1') {
    try { digest = await polishWithLLM(digest); } catch (e) { console.warn('LLM step skipped:', e.message); }
  }
  await mkdir('public', { recursive: true });
  await writeFile('public/digest.json', JSON.stringify(digest, null, 2));
  console.log(`digest.json written: ${digest.week.commits} commits, ${digest.week.repos} repos`);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(e => { console.error(e); process.exit(1); });
