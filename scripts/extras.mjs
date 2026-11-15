// Fonctions annexes du digest : historique de liquidité, archive des journées, jalons GitHub.
// Chaque fonction « pure » est testable sans réseau.

// Le minuteur est ANNULÉ dès que la tâche se termine : sinon Node reste en attente jusqu'à l'échéance (jusqu'à plusieurs minutes de perdues).
export function withTimeout(promise, ms, label = 'step') {
  let timer;
  const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

const fin = x => (Number.isFinite(x) ? Number(x.toPrecision(6)) : null);   // pas de NaN/Infinity dans le JSON, valeurs arrondies

/* ---------------- liquidité ---------------- */
// core = pool-core.js déjà initialisé avec ethers
export async function fetchLiquiditySnapshot(core, date) {
  const out = {};
  await Promise.all(Object.entries(core.CHAINS).map(async ([k, c]) => {
    try {
      // tickRange : on ne lit que les ticks proches du prix (≈ ±16 %), largement assez pour mesurer ±5 % : bien plus rapide qu'un balayage complet
      const S = await core.loadPool({ chain: k, addr: c.addr, urls: c.rpcs, block: 'latest', status: () => {}, tickRange: 1500 });
      const D = core.derive(S);
      const cost = pct => {
        const up = core.calcRow(S, D, pct), dn = core.calcRow(S, D, -pct);
        return { buy: up.noLiq || D.quoteUsd == null ? null : fin(up.quote * D.quoteUsd),      // dollars à dépenser pour +pct %
                 sell: dn.noLiq || D.baseUsd == null ? null : fin(dn.base * D.baseUsd) };      // valeur (prix courant) des tokens à vendre pour −pct %
      };
      const bBal = (D.baseIsT0 ? S.bal0 : S.bal1) / 10 ** D.dBase, qBal = (D.baseIsT0 ? S.bal1 : S.bal0) / 10 ** D.dQuote;
      out[k] = { pair: `${D.baseSym}/${D.quoteSym}`, v3: !!S.v3, fee: S.fee, priceUsd: fin(D.baseUsd), priceQuote: fin(D.basePrice),
                 tvlUsd: D.quoteUsd != null ? fin((bBal * D.basePrice + qBal) * D.quoteUsd) : null, d2: cost(2), d5: cost(5), block: S.block };
    } catch (e) { out[k] = { error: String(e.message || e).slice(0, 160) }; }
  }));
  return { date, chains: out };
}
export function updateLiquidityHistory(history, snap, max = 400) {
  return history.filter(h => h.date !== snap.date).concat(snap).sort((a, b) => a.date.localeCompare(b.date)).slice(-max);
}

/* ---------------- archive des journées ---------------- */
// Une entrée par journée COMPLÈTE avec activité. La première version enregistrée est conservée (stable),
// sauf si elle n'avait pas de résumé IA et que la nouvelle en a un.
export function updateArchive(archive, digest, max = 800) {
  const byDate = new Map(archive.map(e => [e.date, e]));
  for (const d of digest.days.slice(1)) {
    if (!d.commits && !d.automated && !(d.releases || []).length) continue;
    const entry = {
      date: d.date, commits: d.commits || 0, automated: d.automated || 0, ai: !!d.summary, text: d.summary || d.headline,
      repos: (d.repos || []).map(r => r.name),
      domains: (d.domains || []).map(g => ({ name: g.name, commits: g.commits })),
      releases: (d.releases || []).map(r => ({ repo: r.repo, tag: r.tag, url: r.url })),
    };
    const old = byDate.get(d.date);
    if (!old || (!old.ai && entry.ai)) byDate.set(d.date, entry);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-max);
}

/* ---------------- jalons GitHub (milestones) ---------------- */
export function summarizeMilestones(repoNodes) {
  const out = [];
  for (const r of repoNodes) {
    if (!r || r.isArchived) continue;
    for (const m of r.milestones?.nodes || []) {
      const open = m.open?.totalCount || 0, closed = m.closed?.totalCount || 0;
      if (open + closed === 0) continue;                                   // jalon vide : ignoré
      out.push({ repo: r.name, title: m.title, url: m.url, dueOn: m.dueOn || null, percent: Math.round(m.progressPercentage ?? (100 * closed / (open + closed))), open, closed });
    }
  }
  // échéance proche d'abord, puis sans échéance par avancement décroissant
  return out.sort((a, b) => (a.dueOn && b.dueOn ? a.dueOn.localeCompare(b.dueOn) : a.dueOn ? -1 : b.dueOn ? 1 : b.percent - a.percent)).slice(0, 20);
}
