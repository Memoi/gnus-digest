import fs from "node:fs";

const input = "public/gnus-top50.csv";
const output = "public/gnus-top50-classified.csv";
const key = process.env.ROUTESCAN_API_KEY;

if (!key) throw new Error("ROUTESCAN_API_KEY missing. Run source ~/.bashrc");

const known = {
  "0xf10e8ccdb3f065bf24afa14d08cc6336d4a9a281": {
    type: "POOL", label: "Uniswap V3 GNUS/WETH"
  },
  "0x45126b956401daaec92afba2a9953e14b16fb83f": {
    type: "POOL", label: "Uniswap V3 GNUS/WETH"
  },

  "0x45a920727578222b6afa5ce4044dd35a2218c900": {
    type: "TEAM_MULTISIG", label: "GNUS Main Treasury"
  },
  "0xa390c06d129a0b0288fe4e33b2540bd9f99dc333": {
    type: "TEAM_MULTISIG", label: "GNUS Secondary Treasury"
  },
  "0xc365bac723295e0d56db30219d249fdbc19b63cf": {
    type: "TEAM_MULTISIG", label: "GNUS Deployment Ethereum"
  },
  "0x3ab2620db18db01f064613f13665297c87e95ee9": {
    type: "TEAM_MULTISIG", label: "GNUS Deployment Polygon"
  },

  "0xc86e1a194aa2c15a07e259a3bb1c7d05a8505153": {
    type: "GNOSIS_SAFE", label: "Gnosis Safe multisig"
  },
  "0x665b8e9e6f133eb5690f8a7df6a484a9a09a1d92": {
    type: "GNOSIS_SAFE", label: "Gnosis Safe multisig"
  },
  "0x90c1818a86d55c2872ba56dc05408dd0606f409f": {
    type: "GNOSIS_SAFE", label: "Gnosis Safe multisig"
  },
  "0x4ca714a91f39245b59ef712553491196b177dbb2": {
    type: "GNOSIS_SAFE", label: "Gnosis Safe multisig"
  },
  "0xd5fb61cd1bc0d0acc74bc5bdeed04bd403335985": {
    type: "GNOSIS_SAFE", label: "Gnosis Safe multisig"
  },

  "0x9679519e246cfdc8d6681bd7abf0d6467375f5ce": {
    type: "VESTING", label: "GNUS Vesting Contract"
  },
  "0x912accc3534a03197015f446334e3cfa7783ecf0": {
    type: "VESTING", label: "GNUS Vesting Beacon Proxy"
  },
  "0xbd1f3b857d95f8134d4419215a1622ecd82b9687": {
    type: "VESTING", label: "GNUS Vesting Beacon Proxy"
  },
  "0xfe69f9e7beeff51c0c8e5511688eb31023fe8e20": {
    type: "VESTING", label: "GNUS Vesting Beacon Proxy"
  }
};

function parseCsvLine(line) {
  const fields = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];

    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (c === "," && !quoted) {
      fields.push(value);
      value = "";
    } else {
      value += c;
    }
  }

  fields.push(value);
  return fields;
}

const lines = fs.readFileSync(input, "utf8")
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)
  .filter(line => line.trim() !== "");

const header = parseCsvLine(lines[0]).map(h =>
  h.trim().replace(/^"|"$/g, "").replace(/^\uFEFF/, "")
);

const rows = lines.slice(1).map((line, index) => {
  const values = parseCsvLine(line);

  if (values.length !== header.length) {
    throw new Error(
      `CSV row ${index + 2}: ${values.length} columns instead of ${header.length}`
    );
  }

  return Object.fromEntries(header.map((h, i) => [h, values[i]]));
});

for (const field of ["network", "rank", "address", "gnus", "referenceBlock"]) {
  if (!header.includes(field)) {
    throw new Error(`Missing required CSV column: ${field}`);
  }
}

if (rows.length !== 100) {
  throw new Error(`Expected 100 rows, found ${rows.length}`);
}

if (rows.some(row => !/^0x[a-fA-F0-9]{40}$/.test(row.address || ""))) {
  throw new Error("Invalid or missing address in CSV");
}

console.log(`CSV loaded: ${rows.length} holders`);

async function getCode(row) {
  const chainId = row.network === "Ethereum" ? 1 :
    row.network === "Polygon" ? 137 : null;

  if (!chainId) throw new Error(`Unsupported network: ${row.network}`);

  const rpc = `https://rpc.routescan.io/evm/${chainId}/${key}`;
  const block = "0x" + BigInt(row.referenceBlock).toString(16);

  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getCode",
          params: [row.address, block]
        }),
        signal: AbortSignal.timeout(20000)
      });

      const data = await response.json();

      if (!response.ok || data.error || typeof data.result !== "string") {
        throw new Error(JSON.stringify(data.error || data));
      }

      return data.result.toLowerCase();
    } catch (error) {
      if (attempt === 8) {
        throw new Error(`${row.network} ${row.address}: ${error.message}`);
      }

      await new Promise(resolve =>
        setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 20000))
      );
    }
  }
}

const results = [];
let cursor = 0;

async function worker() {
  while (cursor < rows.length) {
    const row = rows[cursor++];
    const address = row.address.toLowerCase();
    const code = await getCode(row);

    const hasCode = code !== "0x" && code !== "0x0";
    const is7702 = /^0xef0100[0-9a-f]{40}$/.test(code);
    const knownEntry = known[address];

    let type;
    let label;

    if (is7702) {
      type = "EOA";
      label = "EIP-7702 delegated wallet";
    } else if (knownEntry && hasCode) {
      type = knownEntry.type;
      label = knownEntry.label;
    } else if (hasCode) {
      type = "SMART_CONTRACT";
      label = "Unidentified smart contract";
    } else {
      type = "EOA";
      label = knownEntry
        ? "Known address without bytecode at reference block"
        : "Wallet";
    }

    const codeBytes = hasCode ? (code.length - 2) / 2 : 0;
    const delegatedImplementation = is7702
      ? "0x" + code.slice(8)
      : "";

    results.push({
      ...row,
      classification: type,
      identification: label,
      codePresent: hasCode ? "true" : "false",
      codeBytes: String(codeBytes),
      codePrefix: hasCode ? code.slice(0, 10) : "",
      eip7702Verified: is7702 ? "true" : "false",
      delegatedImplementation
    });

    console.log(
      `${row.network.padEnd(8)} #${String(row.rank).padStart(2)} ` +
      `${type.padEnd(16)} ${row.address} | ${label}` +
      (is7702 ? ` -> ${delegatedImplementation}` : "")
    );
  }
}

await Promise.all(Array.from({ length: 4 }, () => worker()));

results.sort((a, b) =>
  a.network.localeCompare(b.network) || Number(a.rank) - Number(b.rank)
);

const extraColumns = [
  "classification",
  "identification",
  "codePresent",
  "codeBytes",
  "codePrefix",
  "eip7702Verified",
  "delegatedImplementation"
];

const columns = [...header, ...extraColumns];
const escapeCsv = value =>
  `"${String(value ?? "").replaceAll('"', '""')}"`;

const csv = [
  columns.join(","),
  ...results.map(row => columns.map(c => escapeCsv(row[c])).join(","))
].join("\n") + "\n";

const temporary = `${output}.tmp`;
fs.writeFileSync(temporary, csv);
fs.renameSync(temporary, output);

console.log("\n========== CLASSIFICATION COMPLETE ==========");

for (const type of [
  "EOA", "SMART_CONTRACT", "POOL",
  "TEAM_MULTISIG", "GNOSIS_SAFE", "VESTING"
]) {
  console.log(`${type}: ${results.filter(r => r.classification === type).length}`);
}

console.log(
  "EIP-7702 verified:",
  results.filter(r => r.eip7702Verified === "true").length
);
console.log(
  "Code-bearing addresses:",
  results.filter(r => r.codePresent === "true").length
);
console.log(`File: ${output}`);
