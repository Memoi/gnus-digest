'use strict';

import fs from 'node:fs';

const ETH = {
  network: 'Ethereum',
  key: process.env.ROUTESCAN_API_KEY,
  contract: '0x614577036f0a024dbc1c88ba616b394dd65d105a',
  api: 'https://api.routescan.io/v2/network/mainnet/evm/1/erc20/0x614577036f0a024dbc1c88ba616b394dd65d105a/holders',
  rpc: `https://rpc.routescan.io/evm/1/${process.env.ROUTESCAN_API_KEY}`,
  type: 'erc20'
};

const POLY = {
  network: 'Polygon',
  key: process.env.ALCHEMY_API_KEY,
  contract: '0x127E47abA094a9a87D084a3a93732909Ff031419',
  api: `https://polygon-mainnet.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getOwnersForContract`,
  rpc: `https://rpc.routescan.io/evm/137/${process.env.ROUTESCAN_API_KEY}`,
  type: 'erc1155'
};

const DECIMALS = 18;
const TOP = 50;
const OUTPUT_JSON = 'public/gnus-top50.json';
const OUTPUT_CSV = 'public/gnus-top50.csv';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function format(raw) {
  const n = BigInt(raw);
  const base = 10n ** 18n;
  return `${n / base}.${(n % base).toString().padStart(18, '0')}`;
}

async function fetchJson(url, options = {}, label = 'API') {
  let lastError;

  for (let attempt = 1; attempt <= 8; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      const body = await response.text();

      if (!response.ok) {
        throw new Error(`${label} HTTP ${response.status}: ${body.slice(0, 300)}`);
      }

      return JSON.parse(body);
    } catch (error) {
      lastError = error;
      if (attempt === 8) break;

      const delay = Math.min(1000 * (2 ** (attempt - 1)), 20000);
      console.log(`${label}: tentative ${attempt} échouée, attente ${delay} ms`);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

async function rpc(config, method, params) {
  const result = await fetchJson(config.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params
    })
  }, `${config.network} RPC`);

  if (result.error) {
    throw new Error(`${config.network} RPC: ${JSON.stringify(result.error)}`);
  }

  return result.result;
}

async function getBlock(config) {
  const hex = await rpc(config, 'eth_blockNumber', []);
  return { number: Number(BigInt(hex)), tag: hex };
}

async function getEthereumCandidates() {
  console.log('\n========== COLLECTE ETHEREUM ==========');

  const all = [];
  const cursors = new Set();
  let cursor = null;
  let pages = 0;
  let expectedCount = null;

  do {
    const url = new URL(ETH.api);
    url.searchParams.set('limit', '100');
    url.searchParams.set('count', 'true');
    if (cursor) url.searchParams.set('next', cursor);

    const data = await fetchJson(url, {
      headers: { apikey: ETH.key }
    }, 'Routescan holders');

    if (!Array.isArray(data.items)) {
      throw new Error('Ethereum : champ items absent.');
    }

    all.push(...data.items);
    pages++;

    if (data.count !== undefined) expectedCount = Number(data.count);

    console.log(`Ethereum : page ${pages}, ${data.items.length} entrées`);

    cursor = data.link?.nextToken || null;
    if (cursor && cursors.has(cursor)) {
      throw new Error('Ethereum : curseur de pagination répété.');
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);

  const unique = new Map();

  for (const item of all) {
    if (!item.address || item.balance === undefined) {
      throw new Error('Ethereum : entrée holder incomplète.');
    }

    const key = item.address.toLowerCase();
    const raw = BigInt(item.balance);

    if (unique.has(key) && unique.get(key).raw !== raw) {
      throw new Error(`Ethereum : soldes contradictoires pour ${item.address}`);
    }

    unique.set(key, { address: item.address, raw });
  }

  if (expectedCount !== null && unique.size !== expectedCount) {
    throw new Error(`Ethereum : pagination incomplète (${unique.size}/${expectedCount}).`);
  }

  const holders = [...unique.values()]
    .filter(x => x.raw > 0n)
    .sort((a, b) => a.raw > b.raw ? -1 : a.raw < b.raw ? 1 : 0);

  console.log(`Ethereum : ${unique.size} adresses uniques, ${holders.length} positives`);

  if (holders.length < TOP) {
    throw new Error('Ethereum : moins de 50 holders.');
  }

  return { holders, pages, entries: all.length, unique: unique.size };
}

async function getPolygonCandidates() {
  console.log('\n========== COLLECTE POLYGON ==========');

  const owners = [];
  const cursors = new Set();
  let pageKey = null;
  let pages = 0;

  do {
    const params = new URLSearchParams({
      contractAddress: POLY.contract,
      withTokenBalances: 'true'
    });

    if (pageKey) params.set('pageKey', pageKey);

    const data = await fetchJson(`${POLY.api}?${params}`, {}, 'Alchemy owners');

    if (!Array.isArray(data.owners)) {
      throw new Error('Polygon : tableau owners absent.');
    }

    owners.push(...data.owners);
    pages++;

    console.log(`Polygon : page ${pages}, ${data.owners.length} propriétaires`);

    pageKey = data.pageKey || null;
    if (pageKey && cursors.has(pageKey)) {
      throw new Error('Polygon : curseur Alchemy répété.');
    }
    if (pageKey) cursors.add(pageKey);
  } while (pageKey);

  const unique = new Map();

  for (const owner of owners) {
    const address = owner.ownerAddress || owner.address;
    if (!address) throw new Error('Polygon : adresse propriétaire absente.');

    const token = (owner.tokenBalances || []).find(
      x => String(x.tokenId) === '0'
    );

    if (!token) continue;

    const key = address.toLowerCase();
    const raw = BigInt(token.balance || '0');

    if (unique.has(key) && unique.get(key).raw !== raw) {
      throw new Error(`Polygon : soldes contradictoires pour ${address}`);
    }

    unique.set(key, { address, raw });
  }

  const holders = [...unique.values()]
    .filter(x => x.raw > 0n)
    .sort((a, b) => a.raw > b.raw ? -1 : a.raw < b.raw ? 1 : 0);

  console.log(`Polygon : ${unique.size} adresses, ${holders.length} positives`);

  if (holders.length < TOP) {
    throw new Error('Polygon : moins de 50 holders.');
  }

  return { holders, pages, entries: owners.length, unique: unique.size };
}

function encodeBalance(config, address) {
  const clean = address.toLowerCase().replace(/^0x/, '');

  if (config.type === 'erc20') {
    return '0x70a08231' + clean.padStart(64, '0');
  }

  // ERC-1155 balanceOf(address,uint256), token ID 0
  return '0x00fdd58e' + clean.padStart(64, '0') + '0'.repeat(64);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );

  return results;
}

async function verifyTop50(config, candidates, block) {
  console.log(`\n${config.network} : vérification on-chain des 50 candidats au bloc ${block.number}`);

  const selected = candidates.slice(0, TOP);

  const verified = await mapLimit(selected, 4, async (holder, index) => {
    const result = await rpc(config, 'eth_call', [
      {
        to: config.contract,
        data: encodeBalance(config, holder.address)
      },
      block.tag
    ]);

    const chainRaw = BigInt(result);

    if (chainRaw <= 0n) {
      throw new Error(`${config.network} : solde nul au rang ${index + 1}.`);
    }

    if (chainRaw !== holder.raw) {
      throw new Error(
        `${config.network} : différence au rang ${index + 1} (${holder.address}) : API=${holder.raw}, chaîne=${chainRaw}`
      );
    }

    console.log(`${config.network} ${String(index + 1).padStart(2, '0')}/50 MATCH`);

    return {
      address: holder.address,
      raw: chainRaw.toString(),
      gnus: format(chainRaw)
    };
  });

  verified.sort((a, b) => {
    const x = BigInt(a.raw);
    const y = BigInt(b.raw);
    return x > y ? -1 : x < y ? 1 : 0;
  });

  return verified.map((h, i) => ({
    network: config.network,
    rank: i + 1,
    address: h.address,
    raw: h.raw,
    gnus: h.gnus,
    contract: config.contract,
    referenceBlock: block.number
  }));
}

function csvEscape(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function main() {
  const started = Date.now();

  if (!ETH.key || !POLY.key) {
    throw new Error('Secrets manquants : ROUTESCAN_API_KEY et/ou ALCHEMY_API_KEY.');
  }

  fs.mkdirSync('public', { recursive: true });

  // Collecte complète des deux réseaux.
  const [ethData, polyData] = await Promise.all([
    getEthereumCandidates(),
    getPolygonCandidates()
  ]);

  // Chaque réseau a son propre bloc de référence.
  const [ethBlock, polyBlock] = await Promise.all([
    getBlock(ETH),
    getBlock(POLY)
  ]);

  // Aucune donnée n'est publiée avant les 100 vérifications.
  const [ethTop, polyTop] = await Promise.all([
    verifyTop50(ETH, ethData.holders, ethBlock),
    verifyTop50(POLY, polyData.holders, polyBlock)
  ]);

  if (ethTop.length !== TOP || polyTop.length !== TOP) {
    throw new Error('Le classement final ne contient pas exactement 50 adresses par réseau.');
  }

  const result = {
    token: 'GNUS',
    generatedAt: new Date().toISOString(),
    description: 'Top 50 holders per network, balances individually verified on-chain',
    decimals: DECIMALS,
    validation: {
      ethereum: { verified: 50, total: 50, status: 'MATCH' },
      polygon: { verified: 50, total: 50, status: 'MATCH' }
    },
    networks: {
      ethereum: {
        contract: ETH.contract,
        referenceBlock: ethBlock.number,
        source: 'Routescan Holders API + Routescan RPC',
        pages: ethData.pages,
        entriesReceived: ethData.entries,
        uniqueAddresses: ethData.unique,
        holdersCount: ethTop.length,
        holders: ethTop
      },
      polygon: {
        contract: POLY.contract,
        tokenId: '0',
        referenceBlock: polyBlock.number,
        source: 'Alchemy NFT API + Routescan RPC',
        pages: polyData.pages,
        entriesReceived: polyData.entries,
        uniqueAddresses: polyData.unique,
        holdersCount: polyTop.length,
        holders: polyTop
      }
    },
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(2))
  };

  const rows = [
    ['network', 'rank', 'address', 'gnus', 'raw', 'referenceBlock', 'contract'],
    ...ethTop.map(h => [
      h.network, h.rank, h.address, h.gnus, h.raw, h.referenceBlock, h.contract
    ]),
    ...polyTop.map(h => [
      h.network, h.rank, h.address, h.gnus, h.raw, h.referenceBlock, h.contract
    ])
  ];

  const csv = '\uFEFF' + rows.map(row =>
    row.map(csvEscape).join(',')
  ).join('\n') + '\n';

  // Écriture atomique : les anciens fichiers restent intacts si une écriture échoue.
  const jsonTmp = `${OUTPUT_JSON}.tmp`;
  const csvTmp = `${OUTPUT_CSV}.tmp`;

  fs.writeFileSync(jsonTmp, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(csvTmp, csv);

  fs.renameSync(jsonTmp, OUTPUT_JSON);
  fs.renameSync(csvTmp, OUTPUT_CSV);

  console.log('\n========== GNUS TOP 50 PUBLIÉ ==========');
  console.log(`Ethereum : ${ethTop.length}/50 | bloc ${ethBlock.number}`);
  console.log(`Polygon  : ${polyTop.length}/50 | bloc ${polyBlock.number}`);
  console.log(`Durée    : ${result.elapsedSeconds}s`);
  console.log(`JSON     : ${OUTPUT_JSON}`);
  console.log(`CSV      : ${OUTPUT_CSV}`);
}

main().catch(error => {
  console.error('\nÉCHEC — aucune nouvelle publication :', error.message);
  process.exit(1);
});
