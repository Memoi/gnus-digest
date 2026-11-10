// Génère public/digest.json : résumé quotidien + hebdomadaire de l'activité GitHub d'une organisation.
// Node 20+, aucune dépendance. Résumé 100 % règles (gratuit) ; IA gratuite optionnelle (USE_LLM=1).
import { writeFile, readFile, mkdir } from 'node:fs/promises';
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

/* ---------------- Domaines (regroupement des repos) ---------------- */
// Première règle qui correspond gagne ; « * » = joker. Modifiable sans toucher au code : config/domains.json
export const DEFAULT_DOMAINS = [
  { name: 'Cognitive system (AI)',  repos: ['GeniusCognitiveSystem', '*Cognitive*', '*swarm*'] },
  { name: 'Wallet & apps',          repos: ['GeniusWallet', '*Wallet*'] },
  { name: 'SDK & developer tools',  repos: ['GeniusSDK', '*SDK*', 'openapi-cpp-scaffolding', 'AsyncIOManager', 'thirdparty'] },
  { name: 'Docs & website',         repos: ['gitbook', 'documentation', '*docs*', '*website*'] },
  { name: 'Blockchain & network',   repos: ['SuperGenius', 'GeniusNetwork', 'rlp_enodes', 'zkLLVM', '*contracts*'] },
];
const globToRe = pat => new RegExp('^' + pat.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
export function domainOf(repoName, cfg = DEFAULT_DOMAINS) {
  for (const d of cfg) for (const pat of d.repos) if (globToRe(pat).test(repoName)) return d.name;
  return 'Other';
}
async function loadDomains() {
  try {
    const j = JSON.parse(await readFile('config/domains.json', 'utf8'));
    const arr = Array.isArray(j) ? j : j.domains;
    if (Array.isArray(arr) && arr.every(d => d && d.name && Array.isArray(d.repos))) return arr;
  } catch {}
  return DEFAULT_DOMAINS;
}

export function buildDigest(activity, now = new Date(), days = DAYS, domains = DEFAULT_DOMAINS) {
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
      perDay[k].repos.push({ name: repo.name, domain: domainOf(repo.name, domains), url: repo.url, commits: human.length + auto.length,
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
    // regroupement par domaine
    const byDom = new Map();
    for (const r of d.repos) {
      const g = byDom.get(r.domain) || { name: r.domain, commits: 0, automated: 0, repos: [], labels: [] };
      g.commits += r.human; g.automated += r.automated;
      g.repos.push({ name: r.name, commits: r.human, automated: r.automated });
      for (const it of r.items) if (it.type !== 'automated' && !g.labels.includes(it.label)) g.labels.push(it.label);
      byDom.set(r.domain, g);
    }
    d.domains = [...byDom.values()].sort((a, b) => b.commits - a.commits || b.automated - a.automated);
    const humanDoms = d.domains.filter(g => g.commits > 0);
    if (human) bits.push(`${plural(human, 'commit')} across ${plural(humanRepos.length, 'repo')} in ${plural(humanDoms.length, 'domain')}: ` +
      humanDoms.slice(0, 3).map(g => `${g.name} (${g.labels.slice(0, 2).join(', ')})`).join(', ') +
      (humanDoms.length > 3 ? ` +${humanDoms.length - 3} more` : '') + '.');
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
    domains: (() => {
      const wk = new Map();
      for (const d of daysOut) for (const r of d.repos) {                  // jours du plus récent au plus ancien
        const g = wk.get(r.domain) || { name: r.domain, commits: 0, automated: 0, repos: new Map(), highlights: [] };
        g.commits += r.human; g.automated += r.automated;
        const rr = g.repos.get(r.name) || { name: r.name, commits: 0 }; rr.commits += r.human; g.repos.set(r.name, rr);
        for (const it of r.items) if (it.type !== 'automated' && g.highlights.length < 4) {
          const t = `${r.name}: ${it.text}`.slice(0, 170); if (!g.highlights.includes(t)) g.highlights.push(t);
        }
        wk.set(r.domain, g);
      }
      return [...wk.values()].map(g => ({ ...g, repos: [...g.repos.values()].sort((a, b) => b.commits - a.commits) }))
        .sort((a, b) => b.commits - a.commits || b.automated - a.automated);
    })(),
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
const LLM_BAD = /whisper|tts|guard|embed|moderation|orpheus|playai|compound|safeguard|vision|ocr/i;
const LLM_PREFS = [/gpt-oss-120b/, /llama-3\.3-70b/, /70b/, /gpt-oss-20b/, /llama.*(instant|8b)/, /qwen/, /./];
function pickModel(ids) {
  const ok = ids.filter(i => !LLM_BAD.test(i));
  for (const re of LLM_PREFS) { const f = ok.find(i => re.test(i)); if (f) return f; }
  return null;
}

async function polishWithLLM(digest) {
  // charge utile compacte (les niveaux gratuits limitent la taille d'entrée)
  const payload = {
    week: { ...digest.week, byType: undefined },
    days: digest.days.filter(d => d.repos.length || d.releases.length || Object.keys(d.ciBuilds).length).map(d => ({
      date: d.date,
      repos: d.repos.slice(0, 4).map(r => ({ repo: r.name, domain: r.domain, manual: r.human, automated: r.automated,
        changes: r.items.filter(i => i.type !== 'automated').slice(0, 4).map(i => i.text.slice(0, 110)) })),
      releases: d.releases.slice(0, 5).map(r => `${r.repo} ${r.tag}`),
      ciBuilds: Object.values(d.ciBuilds).reduce((a, b) => a + b, 0) })) };

  // Fournisseur configurable : GitHub Models par défaut, ou toute API compatible OpenAI (LLM_URL + LLM_KEY + LLM_MODEL)
  const url = process.env.LLM_URL || 'https://models.github.ai/inference/chat/completions';
  const key = process.env.LLM_KEY || TOKEN;
  const isGitHub = url.includes('models.github.ai');
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'gnus-digest', Authorization: `Bearer ${key}`,
    ...(isGitHub ? { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } : {}) };
  const messages = [
    { role: 'system', content: 'You write a short GitHub digest, always in English, for non-developers. ' +
      'For each day write 1-2 plain sentences describing what the team did (no jargon, no commit hashes, no run IDs). ' +
      'Ignore automated commits and CI builds unless nothing else happened (then mention them in a few words). ' +
      'Also write a 3-sentence summary of the week. Never invent facts that are not in the data. ' +
      'Answer in plain text only, no markdown, no JSON, exactly one line per item: first a line "WEEK: <summary>", ' +
      'then one line "YYYY-MM-DD: <summary>" for each day present in the data.' },
    { role: 'user', content: JSON.stringify(payload) }];
  const call = model => fetch(url, { method: 'POST', headers, body: JSON.stringify({ model, temperature: 0.2, messages }) });

  let model = process.env.LLM_MODEL || 'openai/gpt-4.1-mini';
  let res = await call(model);
  let raw = await res.text();

  // modèle inconnu ou inaccessible : on interroge la liste des modèles du fournisseur et on en choisit un
  if (res.status === 404 || (res.status === 400 && /model/i.test(raw))) {
    const mr = await fetch(url.replace(/\/chat\/completions.*$/, '') + '/models', { headers });
    const ids = ((await mr.json().catch(() => ({}))).data || []).map(m => m.id);
    const alt = pickModel(ids.filter(i => i !== model));
    if (!alt) throw new Error(`model "${model}" unavailable; models seen: ${ids.slice(0, 15).join(', ') || 'none'}`);
    console.log(`Model "${model}" unavailable, trying "${alt}"`);
    model = alt;
    res = await call(model);
    raw = await res.text();
  }
  digest.aiModel = model;
  if (!res.ok) throw new Error(`LLM ${res.status} (model ${model}): ${raw.slice(0, 200)}`);
  let body;
  try { body = JSON.parse(raw); }
  catch { throw new Error(`LLM HTTP ${res.status} from ${res.url} (type=${res.headers.get('content-type')}), not JSON: ${JSON.stringify(raw.slice(0, 120))}`); }
  const txt = body.choices?.[0]?.message?.content || '';
  let gotWeek = false, gotDays = 0;
  for (const line of txt.split('\n')) {
    const m = line.replace(/^[\s\-*•]+/, '').replace(/\*\*/g, '').match(/^(WEEK|\d{4}-\d{2}-\d{2})\s*:\s*(.+)$/i);
    if (!m) continue;
    if (m[1].toUpperCase() === 'WEEK') { digest.week.summary = m[2].trim(); gotWeek = true; }
    else { const d = digest.days.find(x => x.date === m[1]); if (d) { d.summary = m[2].trim(); gotDays++; } }
  }
  if (!gotWeek && !gotDays) throw new Error('unexpected model reply: ' + JSON.stringify(txt.slice(0, 120)));
  return digest;
}

/* ---------------- Issues & Pull Requests ---------------- */
const IP_QUERY = `query($q:String!,$after:String){ search(query:$q,type:ISSUE,first:100,after:$after){ pageInfo{hasNextPage endCursor} nodes{ __typename
  ... on Issue{ title url number createdAt closedAt repository{name} author{login} }
  ... on PullRequest{ title url number isDraft createdAt closedAt mergedAt repository{name} author{login} } } } }`;
const COUNT_QUERY = `query($a:String!,$b:String!,$c:String!,$d:String!){ prs:search(query:$a,type:ISSUE,first:1){issueCount} issues:search(query:$b,type:ISSUE,first:1){issueCount} closed:search(query:$c,type:ISSUE,first:1){issueCount} merged:search(query:$d,type:ISSUE,first:1){issueCount} }`;

export function summarizeIssuesPrs(nodes, since) {
  const items = [];
  const c = { prsOpened: 0, prsMerged: 0, prsClosed: 0, issuesOpened: 0, issuesClosed: 0 };
  for (const n of nodes) {
    if (!n || !n.title) continue;
    const pr = n.__typename === 'PullRequest';
    const created = new Date(n.createdAt) >= since;
    const merged = pr && n.mergedAt && new Date(n.mergedAt) >= since;
    const closed = !merged && n.closedAt && new Date(n.closedAt) >= since;
    // compteurs indépendants : une PR ouverte ET fusionnée dans la semaine compte dans « opened » et dans « merged »
    if (created) c[pr ? 'prsOpened' : 'issuesOpened']++;
    if (merged) c.prsMerged++;
    if (closed) c[pr ? 'prsClosed' : 'issuesClosed']++;
    // liste : un seul événement par élément, le plus récent
    const event = merged ? 'merged' : closed ? 'closed' : created ? 'opened' : null;
    if (!event) continue;                                   // simple mise à jour : ignorée
    const date = merged ? n.mergedAt : closed ? n.closedAt : n.createdAt;
    items.push({ type: pr ? 'pr' : 'issue', event, repo: n.repository.name, number: n.number, title: n.title.slice(0, 140),
      url: n.url, author: n.author?.login || 'ghost', draft: !!n.isDraft, date });
  }
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { ...c, items: items.slice(0, 40) };
}

async function fetchIssuesPrs(since) {
  const day = since.toISOString().slice(0, 10);
  const q = `org:${ORG} is:public updated:>=${day} sort:updated-desc`;
  let nodes = [], after = null;
  for (let page = 0; page < 3; page++) {                       // jusqu'à 300 éléments modifiés dans la fenêtre
    const d = await ghql(IP_QUERY, { q, after });
    nodes = nodes.concat(d.search.nodes);
    if (!d.search.pageInfo.hasNextPage) break;
    after = d.search.pageInfo.endCursor;
  }
  const out = summarizeIssuesPrs(nodes, since);
  const base = `org:${ORG} is:public`;
  const c = await ghql(COUNT_QUERY, { a: `${base} is:pr is:open`, b: `${base} is:issue is:open`, c: `${base} is:issue is:closed`, d: `${base} is:pr is:merged` });
  out.openPrs = c.prs.issueCount; out.openIssues = c.issues.issueCount;
  out.closedIssuesTotal = c.closed.issueCount; out.mergedPrsTotal = c.merged.issueCount;
  return out;
}

/* ---------------- Docs : mainnet readiness (release-status, public-roadmap) ---------------- */
// Les pages de docs.gnus.ai sont générées depuis le repo GeniusVentures/gitbook (about-gnus.ai/release-status.md, public-roadmap.md) :
// on lit le Markdown source (les icônes ✅ 🔄 ⬜ y sont intactes) plutôt que le HTML rendu.
const DOCS_REPO  = process.env.DOCS_REPO || 'GeniusVentures/gitbook';
const DOC_PAGES  = (process.env.DOC_PAGES || 'release-status,public-roadmap').split(',').map(x => x.trim()).filter(Boolean);
const DOCS_BASE  = process.env.DOCS_BASE || 'https://docs.gnus.ai/about-gnus.ai/';
const STALE_DAYS = Number(process.env.STALE_DAYS || 30);   // au-delà, la page signale une information possiblement périmée

// Objectifs trimestriels cités dans la doc (« Q2 2026 »), analysés LIGNE PAR LIGNE.
// - une étape déjà terminée ([x], ✅) est de l'historique : ignorée ;
// - une étape non terminée ([ ], ⬜, 🔄) dont le trimestre est passé est signalée ;
// - une phrase libre n'est retenue que si elle parle d'objectif / lancement / date.
const quarterEnd = l => { const m = l.match(/Q([1-4]) (\d{4})/); return new Date(Date.UTC(+m[2], +m[1] * 3, 0)); };
export function findTargets(md, now = new Date()) {
  const out = new Map();
  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || /^[-|: ]+$/.test(line)) continue;
    const body = line.replace(/^([-*+]|\d+[.)])\s+/, '');
    const st = detectStatus(body) || detectStatus(body.replace(/^\*\*/, ''));
    if (st && st.status === 'done') continue;
    const text = mdClean(st ? st.rest : body);
    const labels = [...new Set([...text.matchAll(/\bQ([1-4])\s*(20\d{2})\b/g)].map(m => `Q${m[1]} ${m[2]}`))];
    if (!labels.length) continue;
    if (!st && !/target|deadline|planned|expected|original|launch|date|announced/i.test(text)) continue;
    const key = text.toLowerCase();
    if (out.has(key)) continue;                                  // même phrase déjà vue
    out.set(key, { label: labels[0], labels, passed: labels.some(l => quarterEnd(l) < now), line: cut(text, 900) });
  }
  return [...out.values()];
}

const STATUS_RULES = [
  ['done',     /^(✅|☑️?|✔️?|\[x\]|:white_check_mark:|:heavy_check_mark:)\s*/i],
  ['progress', /^(🔄|🚧|⏳|🟡|:construction:|:arrows_counterclockwise:|:hourglass(_flowing_sand)?:)\s*/i],
  ['todo',     /^(⬜|☐|🔲|\[ \]|:white_large_square:|:black_square_button:)\s*/i],
];
const mdClean = t => t.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/[*_`]+/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// coupe proprement (fin de phrase ou de mot) et n'ajoute « … » que si le texte est réellement raccourci
export function cut(t, n) {
  if (t.length <= n) return t;
  const head = t.slice(0, n);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (end > n * 0.6) return head.slice(0, end + 1);
  return head.slice(0, head.lastIndexOf(' ')).trimEnd() + '…';
}

export function detectStatus(text) {
  const t = text.trim();
  for (const [status, re] of STATUS_RULES) { const m = t.match(re); if (m) return { status, rest: t.slice(m[0].length) }; }
  return null;
}
function splitLabel(rest) {
  const clean = mdClean(rest).replace(/^\d+[.)]\s*/, '');
  const [label, target] = clean.split(/\s+(?:→|->|=>)\s+/);
  return { label: label.trim().slice(0, 140), target: target ? target.trim().slice(0, 80) : '' };
}

// « Complete », « Not launched », « Launch preparation in progress »… -> done / progress / todo / other
export function classifyStatusText(t) {
  if (/not (yet )?(launched|started|available|public|live)|planned|pending|tbd|upcoming|to do|\bearly\b/i.test(t)) return 'todo';
  if (/in progress|preparation|underway|working|partial|ongoing|in development|\bwip\b/i.test(t)) return 'progress';
  if (/complete|done|launched|\blive\b|deployed|available|ready|finished|shipped/i.test(t)) return 'done';
  return 'other';
}
const isSeparatorRow = l => /^\|?[\s:|-]+\|?$/.test(l) && l.includes('-');
const splitRow = l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());

export function parseReadiness(md) {
  const sections = [];
  let cur = { heading: '', level: 0, text: [], items: [], tableItems: [] };
  let tbl = null;
  const closeTable = () => {
    if (!tbl) return;
    const statusCol = tbl.header.findIndex(h => /status|state|phase status/i.test(h));
    const iconRows = [];
    for (const cells of tbl.rows) {
      const idx = cells.findIndex(c => detectStatus(c));
      if (idx >= 0) {                                                      // tableau à icônes ✅ 🔄 ⬜
        const st = detectStatus(cells[idx]);
        const others = [st.rest, ...cells.filter((_, i) => i !== idx)].filter(Boolean).join(' — ');
        iconRows.push({ status: st.status, ...splitLabel(others) });
      }
    }
    if (iconRows.length) cur.items.push(...iconRows);
    else if (statusCol >= 0) {                                             // tableau « Area | Status | Meaning »
      for (const cells of tbl.rows) {
        const statusText = mdClean(cells[statusCol] || '');
        const label = mdClean(cells[statusCol === 0 ? 1 : 0] || '');
        const detail = cut(mdClean(cells.filter((_, i) => i !== statusCol && i !== (statusCol === 0 ? 1 : 0)).join(' ')), 900);
        if (label && statusText) cur.tableItems.push({ label: label.slice(0, 140), statusText: statusText.slice(0, 100), status: classifyStatusText(statusText), detail });
      }
    }
    tbl = null;
  };
  const push = () => { closeTable(); if (cur.heading || cur.text.length || cur.items.length || cur.tableItems.length) sections.push(cur); };

  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) { push(); cur = { heading: mdClean(h[2]), level: h[1].length, text: [], items: [], tableItems: [] }; continue; }
    const line = raw.trim();
    if (!line) { closeTable(); continue; }
    if (line.startsWith('|')) {
      const cells = splitRow(line);
      if (!tbl) tbl = { header: cells.map(mdClean), rows: [], sep: false };
      else if (!tbl.sep && isSeparatorRow(line)) tbl.sep = true;
      else if (tbl.sep) tbl.rows.push(cells);
      continue;
    }
    closeTable();
    if (/^(---|```)/.test(line)) continue;
    const body = line.replace(/^([-*+]|\d+[.)])\s+/, '');
    const st = detectStatus(body) || detectStatus(body.replace(/^\*\*/, ''));
    if (st) cur.items.push({ status: st.status, ...splitLabel(st.rest) });
    else { const t = mdClean(body); if (t) cur.text.push(cut(t, 700)); }
  }
  push();

  const all = sections.flatMap(x => x.text).join(' ');
  const statusDate = (all.match(/Status date:?\s*([A-Za-z]+ \d{1,2}, \d{4})/i) || [])[1] || '';

  const tracks = [];
  for (const x of sections) {
    if (x.items.length) {
      const n = st => x.items.filter(i => i.status === st).length;
      const done = n('done'), progress = n('progress'), todo = n('todo'), total = x.items.length;
      tracks.push({ kind: 'track', name: x.heading || 'Status', summary: x.text[0] || '', done, progress, todo, total,
        percent: Math.round(100 * (done + 0.1 * progress) / total), items: x.items, note: x.text.slice(1, 3).join(' ') });
    }
    if (x.tableItems.length) tracks.push({ kind: 'table', name: x.heading || 'Status', summary: x.text[0] || '', items: x.tableItems });
  }
  const notes = sections.filter(x => !x.items.length && !x.tableItems.length && x.text.length).slice(0, 8)
    .map(x => ({ heading: x.heading, lines: x.text.slice(0, 6) }));
  return { statusDate, tracks, notes };
}

export const calendarDaysAgo = (d, now = new Date()) => Math.round((Date.parse(dayKey(now)) - Date.parse(dayKey(d))) / 86400000);

async function fetchDocs() {
  const repo = await gh(`/repos/${DOCS_REPO}`);
  const tree = await gh(`/repos/${DOCS_REPO}/git/trees/${repo.default_branch}`, { recursive: '1' });
  const pages = [];
  for (const key of DOC_PAGES) {
    const blobs = (tree.tree || []).filter(t => t.type === 'blob' && /\.md$/i.test(t.path));
    const f = blobs.find(t => t.path.toLowerCase() === `about-gnus.ai/${key}.md`)
           || blobs.find(t => t.path.toLowerCase().includes(key));
    if (!f) {
      const hint = blobs.filter(t => /status|roadmap/i.test(t.path)).slice(0, 6).map(t => t.path).join(', ');
      pages.push({ key, error: `source file not found in ${DOCS_REPO}` + (hint ? ` (similar: ${hint})` : '')}); continue;
    }
    const r = await fetch(`https://raw.githubusercontent.com/${DOCS_REPO}/${repo.default_branch}/${f.path.split('/').map(encodeURIComponent).join('/')}`);
    if (!r.ok) { pages.push({ key, error: `raw fetch ${r.status}` }); continue; }
    const text = await r.text();
    const parsed = parseReadiness(text);
    let lastEdited = null;
    try { const cm = await gh(`/repos/${DOCS_REPO}/commits`, { path: f.path, per_page: 1 }); lastEdited = cm[0]?.commit?.committer?.date || null; } catch {}
    // écart en JOURS CALENDAIRES (date contre date), pas en heures écoulées : deux mentions du même jour donnent le même nombre
    const sd = parsed.statusDate ? new Date(parsed.statusDate + ' 12:00 UTC') : null;
    const statusAgeDays = sd && !isNaN(sd) ? calendarDaysAgo(sd) : null;
    const editedAgeDays = lastEdited ? calendarDaysAgo(new Date(lastEdited)) : null;
    pages.push({ key, url: `${DOCS_BASE}${key}/`, source: f.path, ...parsed, lastEdited, statusAgeDays, editedAgeDays,
      stale: (statusAgeDays ?? editedAgeDays ?? 0) > STALE_DAYS, targets: findTargets(text) });
  }
  return { fetchedAt: new Date().toISOString(), pages };
}

/* ---------------- Historique et changements ---------------- */
const HISTORY_FILE = 'public/history.json';
const HISTORY_MAX  = 180;                       // jours conservés

async function loadHistory() {
  try { const j = JSON.parse(await readFile(HISTORY_FILE, 'utf8')); return Array.isArray(j) ? j : []; }
  catch { return []; }
}

export function makeSnapshot(digest, date) {
  const w = digest.week, P = digest.prs || {};
  return {
    date, commits: w.commits, automated: w.automated, contributors: w.contributors, repos: w.repos,
    openPrs: P.openPrs ?? null, openIssues: P.openIssues ?? null, closedIssues: P.closedIssuesTotal ?? null, mergedPrs: P.mergedPrsTotal ?? null,
    readiness: digest.readiness ? digest.readiness.pages.filter(p => !p.error).map(p => ({ key: p.key,
      tracks: p.tracks.map(t => ({ name: t.name, kind: t.kind, percent: t.percent ?? null,
        items: t.items.map(i => ({ label: i.label.slice(0, 100), status: i.status, statusText: i.statusText || '' })) })) })) : null,
  };
}

// Référence de comparaison : l'instantané le plus proche d'il y a 7 jours (ou le plus ancien disponible)
export function pickBaseline(history, today, daysBack = 7) {
  const older = history.filter(h => h.date < today).sort((a, b) => a.date.localeCompare(b.date));
  if (!older.length) return null;
  const target = new Date(Date.parse(today) - daysBack * 86400000).toISOString().slice(0, 10);
  const ok = older.filter(h => h.date <= target);
  return ok.length ? ok[ok.length - 1] : older[0];
}

export function compareSnapshots(prev, cur) {
  const out = { readiness: null, metrics: [] };
  if (prev.readiness && cur.readiness) {
    const idx = snap => { const m = new Map();
      for (const p of snap.readiness) for (const t of p.tracks) for (const i of t.items) m.set(`${p.key}|${t.name}|${i.label}`, { page: p.key, section: t.name, ...i }); return m; };
    const a = idx(prev), b = idx(cur), items = [];
    const txt = i => i.statusText || i.status;
    for (const [k, v] of b) {
      const o = a.get(k);
      if (!o) items.push({ type: 'added', page: v.page, section: v.section, label: v.label, to: txt(v), toStatus: v.status });
      else if (o.status !== v.status || o.statusText !== v.statusText)
        items.push({ type: 'status', page: v.page, section: v.section, label: v.label, from: txt(o), fromStatus: o.status, to: txt(v), toStatus: v.status });
    }
    for (const [k, v] of a) if (!b.has(k)) items.push({ type: 'removed', page: v.page, section: v.section, label: v.label, from: txt(v), fromStatus: v.status });
    const pc = snap => { const m = new Map(); for (const p of snap.readiness) for (const t of p.tracks) if (t.percent != null) m.set(`${p.key}|${t.name}`, { name: t.name, percent: t.percent }); return m; };
    const pa = pc(prev), pb = pc(cur), trackDeltas = [];
    for (const [k, v] of pb) { const o = pa.get(k); if (o && o.percent !== v.percent) trackDeltas.push({ name: v.name, from: o.percent, to: v.percent }); }
    out.readiness = { items, trackDeltas };
  }
  for (const [key, label] of [['openIssues', 'Open issues'], ['openPrs', 'Open PRs'], ['closedIssues', 'Closed issues (total)'], ['mergedPrs', 'Merged PRs (total)']])
    if (prev[key] != null && cur[key] != null && prev[key] !== cur[key]) out.metrics.push({ key, label, from: prev[key], to: cur[key], delta: cur[key] - prev[key] });
  return out;
}

/* ---------------- main ---------------- */
async function main() {
  const now = new Date();
  const since = new Date(now.getTime() - (DAYS + 1) * 86400000);
  const activity = await fetchActivity(since);
  const domains = await loadDomains();
  let digest = buildDigest(activity, now, DAYS, domains);
  digest.builder = 'v16';
  try { digest.prs = await fetchIssuesPrs(new Date(now.getTime() - DAYS * 86400000)); }
  catch (e) { digest.prsError = String(e.message).slice(0, 200); console.warn('Issues/PR step skipped:', e.message); }
  try { digest.readiness = await fetchDocs(); }
  catch (e) { digest.readinessError = String(e.message).slice(0, 200); console.warn('Docs step skipped:', e.message); }

  // historique : comparaison avec il y a ~7 jours + tendances
  const history = await loadHistory();
  const today = makeSnapshot(digest, dayKey(now));
  const base = pickBaseline(history, today.date);
  digest.changes = base ? { since: base.date, ...compareSnapshots(base, today) } : { since: null };
  const kept = history.filter(h => h.date !== today.date).concat(today).slice(-HISTORY_MAX);
  digest.trend = kept.map(h => ({ date: h.date, commits: h.commits, openIssues: h.openIssues, openPrs: h.openPrs, closedIssues: h.closedIssues, mergedPrs: h.mergedPrs }));
  await mkdir('public', { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(kept));
  if (process.env.USE_LLM === '1') {
    try { digest = await polishWithLLM(digest); digest.ai = digest.aiModel; console.log('AI summaries added'); }
    catch (e) { digest.aiError = String(e.message).slice(0, 400); console.warn('LLM step skipped:', e.message); }
  }
  await mkdir('public', { recursive: true });
  await writeFile('public/digest.json', JSON.stringify(digest, null, 2));
  console.log(`digest.json written: ${digest.week.commits} commits, ${digest.week.repos} repos`);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(e => { console.error(e); process.exit(1); });
