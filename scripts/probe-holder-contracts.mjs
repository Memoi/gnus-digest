import fs from "node:fs";

const KEY = process.env.ROUTESCAN_API_KEY;
if (!KEY) throw new Error("ROUTESCAN_API_KEY absente");

function parseCsvLine(line) {
  const out = [];
  let value = "", quoted = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"'; i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      out.push(value); value = "";
    } else value += c;
  }
  out.push(value);
  return out;
}

const lines = fs.readFileSync("public/gnus-top50-classified.csv", "utf8")
  .replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);

const headers = parseCsvLine(lines[0]);
const rows = lines.slice(1).map(line =>
  Object.fromEntries(headers.map((h, i) => [h, parseCsvLine(line)[i]]))
).filter(r => r.classification === "SMART_CONTRACT");

const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

async function rpc(network, method, params) {
  const chain = network === "Ethereum" ? 1 : 137;
  const url = `https://rpc.routescan.io/evm/${chain}/${KEY}`;

  for (let attempt = 1; attempt <= 7; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20000)
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(JSON.stringify(data.error || data));
      return data.result;
    } catch (e) {
      if (attempt === 7) throw e;
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 20000)));
    }
  }
}

function addressFromWord(value) {
  if (!value || value === "0x" || /^0x0+$/.test(value)) return null;
  return "0x" + value.slice(-40);
}

function decodeOwners(data) {
  if (!data || data.length < 130) return [];
  try {
    const offset = Number(BigInt("0x" + data.slice(2, 66)));
    const start = 2 + offset * 2;
    const count = Number(BigInt("0x" + data.slice(start, start + 64)));
    if (!Number.isSafeInteger(count) || count > 100) return [];
    const owners = [];
    for (let i = 0; i < count; i++) {
      const pos = start + 64 + i * 64;
      owners.push(addressFromWord("0x" + data.slice(pos, pos + 64)));
    }
    return owners.filter(Boolean);
  } catch {
    return [];
  }
}

async function call(row, selector) {
  return rpc(row.network, "eth_call", [
    { to: row.address, data: selector },
    "0x" + BigInt(row.referenceBlock).toString(16)
  ]).catch(() => null);
}

let cursor = 0;
const results = [];

async function worker() {
  while (cursor < rows.length) {
    const row = rows[cursor++];
    const block = "0x" + BigInt(row.referenceBlock).toString(16);
    const addr = row.address;

    const [code, implementation, beacon, ownersRaw, thresholdRaw,
      versionRaw, token0Raw, token1Raw, feeRaw, factoryRaw, reservesRaw] =
      await Promise.all([
        rpc(row.network, "eth_getCode", [addr, block]),
        rpc(row.network, "eth_getStorageAt", [addr, SLOT, block]),
        rpc(row.network, "eth_getStorageAt", [addr, BEACON_SLOT, block]),
        call(row, "0xa0e67b2d"),
        call(row, "0xe75235b8"),
        call(row, "0xffa1ad74"),
        call(row, "0x0dfe1681"),
        call(row, "0xd21220a7"),
        call(row, "0xddca3f43"),
        call(row, "0xc45a0155"),
        call(row, "0x0902f1ac")
      ]);

    const owners = decodeOwners(ownersRaw);
    const threshold = thresholdRaw && thresholdRaw !== "0x"
      ? Number(BigInt(thresholdRaw)) : null;

    const token0 = addressFromWord(token0Raw);
    const token1 = addressFromWord(token1Raw);
    const factory = addressFromWord(factoryRaw);
    const fee = feeRaw && feeRaw !== "0x"
      ? Number(BigInt(feeRaw)) : null;

    const impl = addressFromWord(implementation);
    const beaconAddress = addressFromWord(beacon);

    const minimalProxy = /363d3d373d3d3d363d73([a-f0-9]{40})5af43d82803e903d91602b57fd5bf3/i.exec(code);
    const cloneImplementation = minimalProxy ? "0x" + minimalProxy[1] : null;

    const isSafe = owners.length > 0 && threshold !== null;
    const isV3Pool = !!(token0 && token1 && factory && fee !== null);
    const isV2Pair = !!(token0 && token1 && reservesRaw && reservesRaw !== "0x");

    let detected = [];
    if (isSafe) detected.push("SAFE_MULTISIG");
    if (isV3Pool) detected.push("UNISWAP_V3_POOL");
    if (isV2Pair) detected.push("V2_LIQUIDITY_PAIR");
    if (impl) detected.push("EIP1967_PROXY");
    if (beaconAddress) detected.push("EIP1967_BEACON_PROXY");
    if (cloneImplementation) detected.push("MINIMAL_PROXY");
    if (!detected.length) detected.push("UNKNOWN_CONTRACT");

    const result = {
      network: row.network,
      rank: row.rank,
      address: addr,
      gnus: row.gnus,
      detected,
      owners,
      threshold,
      versionRaw,
      token0,
      token1,
      fee,
      factory,
      implementation: impl,
      beacon: beaconAddress,
      cloneImplementation
    };

    results.push(result);
    console.log(
      `${row.network} #${row.rank} | ${detected.join(", ")} | ` +
      `${addr} | ${row.gnus} GNUS`
    );
    if (owners.length) {
      console.log(`  Safe owners (${threshold}/${owners.length}): ${owners.join(", ")}`);
    }
    if (token0 && token1) {
      console.log(`  Tokens: ${token0} / ${token1} | fee: ${fee}`);
    }
    if (impl || cloneImplementation) {
      console.log(`  Implementation: ${impl || cloneImplementation}`);
    }
  }
}

await Promise.all(Array.from({ length: 3 }, () => worker()));

results.sort((a, b) =>
  a.network.localeCompare(b.network) || Number(a.rank) - Number(b.rank)
);

fs.writeFileSync(
  "gnus-contract-probes.json",
  JSON.stringify(results, null, 2) + "\n"
);

console.log("\n========== PROBES TERMINÉS ==========");
console.log("Contrats examinés :", results.length);
console.log("Rapport : gnus-contract-probes.json");
