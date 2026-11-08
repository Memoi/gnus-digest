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
        gh(`/repos/${ORG}/${r.name}/releases`, { per_page: 50 }).catch(() => []),
      ]);
      return {
        name: r.name, url: r.html_url,
        commits,
        releases: releases.filter(x => x.published_at && new Date(x.published_at) >= since && !x.draft)
          .map(x => ({ name: x.name || x.tag_name, tag: x.tag_name, url: x.html_url, date: x.published_at, prerelease: !!x.prerelease })),
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

const normSubject = m => cleanSubject(m).toLowerCase().replace(/\d+/g, '#');
const isBuildRelease = r => r.prerelease || /-(Release|Debug)$/i.test(r.tag || '') || /-(Release|Debug)$/i.test(r.name || '');

export function buildDigest(activity, now = new Date(), days = DAYS) {
  const keys = [];                                   // jours, aujourd'hui en premier
  for (let i = 0; i < days; i++) keys.push(dayKey(new Date(now.getTime() - i * 86400000)));

  const perDay = Object.fromEntries(keys.map(k => [k, { date: k, repos: [], releases: [], ciBuilds: {} }]));
  const contributors = new Set();
  const repoHuman = {};
  let autoTotal = 0, ciTotal = 0, namedTotal = 0;
  const typeTotals = {};

  for (const repo of activity) {
    // un commit est « automatique » s'il vient d'un bot, contient [skip ci], ou si son message se répète ≥ 5 fois
    const freq = new Map();
    for (const c of repo.commits) {
      if (isNoise(c.message.split('\n')[0])) continue;
      const n = normSubject(c.message); freq.set(n, (freq.get(n) || 0) + 1);
    }
    const isAuto = c => /\[bot\]$/i.test(c.author) || /\[(skip ci|ci skip)\]/i.test(c.message) || freq.get(normSubject(c.message)) >= 5;

    const byDay = {};
    for (const c of repo.commits) {
      if (isNoise(c.message.split('\n')[0])) continue;
      const k = dayKey(c.date);
      if (!perDay[k]) continue;
      const slot = (byDay[k] ||= { human: [], auto: [] });
      if (isAuto(c)) slot.auto.push(c); else { slot.human.push(c); contributors.add(c.author); }
    }
    for (const [k, { human, auto }] of Object.entries(byDay)) {
      const items = summarizeRepoDay(human);
      if (auto.length) items.push({ type: 'automated', label: 'automated updates', count: auto.length,
        text: `Automated updates (${plural(auto.length, 'commit')}), e.g. ${cleanSubject(auto[0].message)}` });
      const branches = [...new Set([...human, ...auto].flatMap(c => c.branches || []))];
      perDay[k].repos.push({ name: repo.name, url: repo.url, commits: human.length + auto.length,
        human: human.length, automated: auto.length, branches, items });
      repoHuman[repo.name] = (repoHuman[repo.name] || 0) + human.length;
      autoTotal += auto.length;
      for (const it of items) if (it.type !== 'automated') typeTotals[it.type] = (typeTotals[it.type] || 0) + it.count;
    }
    for (const r of repo.releases) {
      const k = dayKey(r.date);
      if (!perDay[k]) continue;
      if (isBuildRelease(r)) { perDay[k].ciBuilds[repo.name] = (perDay[k].ciBuilds[repo.name] || 0) + 1; ciTotal++; }
      else { perDay[k].releases.push({ repo: repo.name, ...r }); namedTotal++; }
    }
  }

  const daysOut = keys.map(k => {
    const d = perDay[k];
    d.repos.sort((a, b) => b.human - a.human || b.automated - a.automated);
    const human = d.repos.reduce((s, r) => s + r.human, 0);
    const auto = d.repos.reduce((s, r) => s + r.automated, 0);
    const humanRepos = d.repos.filter(r => r.human > 0);
    const autoRepos = d.repos.filter(r => r.automated > 0);
    const builds = Object.entries(d.ciBuilds);
    const buildCount = builds.reduce((s, [, n]) => s + n, 0);
    const bits = [];
    if (human) bits.push(`${plural(human, 'commit')} across ${plural(humanRepos.length, 'repo')}: ` +
      humanRepos.slice(0, 3).map(r => `${r.name} (${r.items.filter(i => i.type !== 'automated').slice(0, 2).map(i => i.label).join(', ')})`).join(', ') +
      (humanRepos.length > 3 ? ` +${humanRepos.length - 3} more` : '') + '.');
    if (auto) bits.push(`${plural(auto, 'automated commit')} (${autoRepos.map(r => r.name).join(', ')}).`);
    if (d.releases.length) bits.push(`Released ${d.releases.slice(0, 4).map(r => `${r.repo} ${r.tag}`).join(', ')}` +
      `${d.releases.length > 4 ? ` +${d.releases.length - 4} more` : ''}.`);
    if (buildCount) bits.push(`${plural(buildCount, 'CI build')} published (${builds.map(([r, n]) => `${r} ×${n}`).join(', ')}).`);
    d.headline = bits.length ? bits.join(' ') : 'A quiet day with no new code activity on GitHub.';
    d.commits = human; d.automated = auto;
    return d;
  });

  const topRepos = Object.entries(repoHuman).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const humanTotal = topRepos.reduce((s, [, n]) => s + n, 0);
  const week = {
    from: keys[keys.length - 1], to: keys[0],
    commits: humanTotal, automated: autoTotal, repos: topRepos.length, contributors: contributors.size,
    releases: namedTotal, ciBuilds: ciTotal,
    topRepos: topRepos.slice(0, 5).map(([name, commits]) => ({ name, commits })),
    byType: typeTotals,
    headline: (humanTotal
      ? `${plural(humanTotal, 'commit')} by ${plural(contributors.size, 'contributor')} across ${plural(topRepos.length, 'repo')}. ` +
        `Most active: ${topRepos.slice(0, 3).map(([n, c]) => `${n} (${c})`).join(', ')}.`
      : 'No manual commits this week.') +
      (autoTotal ? ` Plus ${plural(autoTotal, 'automated commit')}.` : '') +
      (namedTotal ? ` ${plural(namedTotal, 'release')} published.` : '') +
      (ciTotal ? ` ${plural(ciTotal, 'CI build')} published.` : ''),
  };
  return { generatedAt: now.toISOString(), org: ORG, timezone: TZ, week, days: daysOut };
}

/* ---------------- IA gratuite optionnelle (GitHub Models) ---------------- */
async function polishWithLLM(digest) {
  // charge utile compacte (le niveau gratuit limite la taille d'entrée)
  const payload = {
    week: { ...digest.week, byType: undefined },
    days: digest.days.filter(d => d.repos.length || d.releases.length || Object.keys(d.ciBuilds).length).map(d => ({
      date: d.date,
      repos: d.repos.slice(0, 4).map(r => ({ repo: r.name, manual: r.human, automated: r.automated,
        changes: r.items.filter(i => i.type !== 'automated').slice(0, 4).map(i => i.text.slice(0, 110)) })),
      releases: d.releases.slice(0, 5).map(r => `${r.repo} ${r.tag}`),
      ciBuilds: Object.values(d.ciBuilds).reduce((a, b) => a + b, 0) })) };
  const res = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'openai/gpt-4.1-mini', temperature: 0.2,
      messages: [
        { role: 'system', content: 'You write a short GitHub digest, always in English, for non-developers. ' +
          'For each day write 1-2 plain sentences describing what the team did (no jargon, no commit hashes, no run IDs). ' +
          'Ignore automated commits and CI builds unless nothing else happened (then mention them in a few words). ' +
          'Also write a 3-sentence summary of the week. Never invent facts that are not in the data. ' +
          'Answer in plain text only, no markdown, no JSON, exactly one line per item: first a line "WEEK: <summary>", ' +
          'then one line "YYYY-MM-DD: <summary>" for each day present in the data.' },
        { role: 'user', content: JSON.stringify(payload) },
      ] }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const raw = await res.text();
  let body;
  try { body = JSON.parse(raw); }
  catch { throw new Error(`LLM HTTP ${res.status}, reply is not JSON: ${JSON.stringify(raw.slice(0, 160))}`); }
  const txt = body.choices?.[0]?.message?.content || '';
  let gotWeek = false, gotDays = 0;
  for (const raw of txt.split('\n')) {
    const m = raw.replace(/^[\s\-*•]+/, '').replace(/\*\*/g, '').match(/^(WEEK|\d{4}-\d{2}-\d{2})\s*:\s*(.+)$/i);
    if (!m) continue;
    if (m[1].toUpperCase() === 'WEEK') { digest.week.summary = m[2].trim(); gotWeek = true; }
    else { const d = digest.days.find(x => x.date === m[1]); if (d) { d.summary = m[2].trim(); gotDays++; } }
  }
  if (!gotWeek && !gotDays) throw new Error('unexpected model reply: ' + JSON.stringify(txt.slice(0, 120)));
  return digest;
}

/* ---------------- main ---------------- */
async function main() {
  const now = new Date();
  const since = new Date(now.getTime() - (DAYS + 1) * 86400000);
  const activity = await fetchActivity(since);
  let digest = buildDigest(activity, now);
  digest.builder = 'v3';
  if (process.env.USE_LLM === '1') {
    try { digest = await polishWithLLM(digest); digest.ai = process.env.LLM_MODEL || 'openai/gpt-4.1-mini'; console.log('AI summaries added'); }
    catch (e) { digest.aiError = String(e.message).slice(0, 200); console.warn('LLM step skipped:', e.message); }
  }
  await mkdir('public', { recursive: true });
  await writeFile('public/digest.json', JSON.stringify(digest, null, 2));
  console.log(`digest.json written: ${digest.week.commits} commits, ${digest.week.repos} repos`);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(e => { console.error(e); process.exit(1); });
