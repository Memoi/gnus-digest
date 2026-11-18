// Alertes rapides (workflow toutes les 3 h) : changement de statut de la mainnet, nouvelle vraie release, jalon terminé.
// Premier passage : on mémorise l'état sans rien envoyer. Les passages suivants n'envoient que ce qui a CHANGÉ.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ORG, gh, ghAll, fetchDocs, fetchMilestones, postTelegram, isBuildRelease } from './build-digest.mjs';

const STATE_FILE = 'public/alerts-state.json';
const SITE_URL = (process.env.SITE_URL || 'https://gnus-digest.vercel.app').replace(/\/$/, '');

async function loadJson(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } }

// { "SuperGenius public mainnet": { statusText: "Not launched", url } } à partir des pages de docs
export function mainnetStatuses(docs) {
  const out = {};
  for (const pg of docs?.pages || []) for (const t of pg.tracks || []) if (t.kind === 'table')
    for (const it of t.items) if (/mainnet/i.test(it.label)) out[it.label] = { statusText: it.statusText, url: pg.url };
  return out;
}

export async function recentReleases(now, days = 4) {
  const since = new Date(now.getTime() - days * 86400000);
  const repos = await ghAll(`/orgs/${ORG}/repos`, { type: 'public', sort: 'pushed', direction: 'desc' }, 2);
  const active = repos.filter(r => !r.archived && r.pushed_at && new Date(r.pushed_at) >= since);
  const releasesOf = async r => {
    const list = await gh(`/repos/${ORG}/${r.name}/releases`, { per_page: 15 }).catch(() => []);
    return list
      .filter(x => x.published_at && new Date(x.published_at) >= since && !x.draft)
      .map(x => ({
        repo: r.name, tag: x.tag_name, name: x.name || x.tag_name, url: x.html_url, date: x.published_at,
        build: !!isBuildRelease({ tag: x.tag_name, name: x.name, prerelease: x.prerelease }),
      }));
  };
  const out = [];
  for (let i = 0; i < active.length; i += 5) {
    const chunk = await Promise.all(active.slice(i, i + 5).map(releasesOf));
    out.push(...chunk.flat());
  }
  return out;
}

// snap = { ok: { docs, releases, milestones }, mainnet, releases, milestones } ; prev = état précédent (null au premier passage)
export function computeAlerts(prev, snap, nowIso = new Date().toISOString()) {
  const keepIf = (ok, fresh, old) => (ok || !prev ? fresh : old);          // si une source a échoué, on garde la mémoire d'avant : pas de fausse alerte
  const state = {
    initialized: prev?.initialized || nowIso,
    mainnet: keepIf(snap.ok.docs, Object.fromEntries(Object.entries(snap.mainnet).map(([k, v]) => [k, v.statusText])), prev?.mainnet || {}),
    releasesSeen: keepIf(snap.ok.releases, [...new Set([...(prev?.releasesSeen || []), ...snap.releases.filter(r => !r.build).map(r => `${r.repo}@${r.tag}`)])].slice(-400), prev?.releasesSeen || []),
    milestones: keepIf(snap.ok.milestones, Object.fromEntries(snap.milestones.map(m => [`${m.repo}|${m.title}`, { percent: m.percent, open: m.open, closed: m.closed }])), prev?.milestones || {}),
  };
  if (!prev) return { alerts: [], state };
  const alerts = [];
  if (snap.ok.docs) for (const [label, cur] of Object.entries(snap.mainnet)) {
    const before = prev.mainnet?.[label];
    if (before != null && before !== cur.statusText) alerts.push({ type: 'mainnet', label, from: before, to: cur.statusText, url: cur.url });
  }
  if (snap.ok.releases) {
    const seen = new Set(prev.releasesSeen || []);
    for (const r of snap.releases) if (!r.build && !seen.has(`${r.repo}@${r.tag}`)) alerts.push({ type: 'release', repo: r.repo, tag: r.tag, name: r.name, url: r.url });
  }
  if (snap.ok.milestones) {
    const cur = new Map(snap.milestones.map(m => [`${m.repo}|${m.title}`, m]));
    for (const [key, before] of Object.entries(prev.milestones || {})) {
      const [repo, ...rest] = key.split('|'), title = rest.join('|'), now = cur.get(key);
      if (now && before.percent < 100 && now.percent >= 100) alerts.push({ type: 'milestone', repo, title, state: 'complete', url: now.url });
      else if (!now) alerts.push({ type: 'milestone', repo, title, state: 'closed', percent: before.percent });
    }
  }
  return { alerts, state };
}

export function formatAlert(a, site = SITE_URL) {
  if (a.type === 'mainnet') return `🚨 Mainnet status changed\n${a.label}: ${a.from} → ${a.to}\n${a.url || site + '/'}`;
  if (a.type === 'release') return `🚀 New release: ${a.repo} ${a.tag}${a.name && a.name !== a.tag ? ` — ${a.name}` : ''}\n${a.url}`;
  if (a.state === 'complete') return `🏁 Milestone completed: ${a.title} (${a.repo})\n${a.url}`;
  return `📌 Milestone closed: ${a.title} (${a.repo}), it was at ${a.percent}%\n${site}/`;
}

async function main() {
  const now = new Date();
  const prev = await loadJson(STATE_FILE, null);
  const snap = { ok: {}, mainnet: {}, releases: [], milestones: [] };
  try { snap.mainnet = mainnetStatuses(await fetchDocs()); snap.ok.docs = true; } catch (e) { console.warn('docs:', e.message); }
  try { snap.releases = await recentReleases(now); snap.ok.releases = true; } catch (e) { console.warn('releases:', e.message); }
  try { snap.milestones = await fetchMilestones(); snap.ok.milestones = true; } catch (e) { console.warn('milestones:', e.message); }

  const { alerts, state } = computeAlerts(prev, snap, now.toISOString());
  console.log(prev ? `${alerts.length} alert(s)` : 'First run: state recorded, nothing sent');
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  let failed = 0;
  for (const a of alerts) {
    const text = formatAlert(a);
    if (!token || !chat) { console.log('[Telegram not configured]\n' + text); continue; }
    try { await postTelegram(token, chat, text); console.log('Sent:', a.type); } catch (e) { failed++; console.warn('Telegram failed:', e.message); }
  }
  if (failed) { console.error(`${failed} alert(s) not delivered: state kept as is, they will be retried`); process.exit(1); }
  await mkdir('public', { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(e => { console.error(e); process.exit(1); });
