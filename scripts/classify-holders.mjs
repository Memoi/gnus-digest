import fs from "node:fs";

const input = "public/gnus-top50.csv";
const output = "public/gnus-top50-classified.csv";
const key = process.env.ROUTESCAN_API_KEY;

if (!key) throw new Error("ROUTESCAN_API_KEY absente. Lance source ~/.bashrc");

const known = {
  "0xf10e8ccdb3f065bf24afa14d08cc6336d4a9a281": {
    type: "POOL",
    label: "Uniswap V3 GNUS/WETH"
  },
  "0x45126b956401daaec92afba2a9953e14b16fb83f": {
    type: "POOL",
    label: "Uniswap V3 GNUS/WETH"
  },
  "0x45a920727578222b6afa5ce4044dd35a2218c900": {
    type: "TEAM_MULTISIG",
    label: "GNUS Main Treasury"
  },
  "0xa390c06d129a0b0288fe4e33b2540bd9f99dc333": {
    type: "TEAM_MULTISIG",
    label: "GNUS Secondary Treasury"
  },
  "0xc365bac723295e0d56db30219d249fdbc19b63cf": {
    type: "TEAM_MULTISIG",
    label: "GNUS Deployment Ethereum"
  },
  "0x3ab2620db18db01f064613f13665297c87e95ee9": {
    type: "TEAM_MULTISIG",
    label: "GNUS Deployment Polygon"
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
      `CSV row ${index + 2}: ${values.length} colonnes au lieu de ${header.length}`
    );
  }

  return Object.fromEntries(
    header.map((h, i) => [h, values[i]])
  );
});

for (const field of ["network", "rank", "address", "gnus", "referenceBlock"]) {
  if (!header.includes(field)) {
    throw new Error(`Colonne CSV obligatoire absente : ${field}`);
  }
}

if (rows.length !== 100) {
  throw new Error(`Expected 100 rows, found ${rows.length} trouvées`);
}

if (rows.some(row => !/^0x[a-fA-F0-9]{40}$/.test(row.address || ""))) {
  throw new Error("Invalid or missing Ethereum/Polygon address in CSV");
}

console.log(`CSV loaded: ${rows.length} lignes, ${header.length} colonnes`);

const results = [];
let cursor = 0;

async function getCode(row) {
  const chainId = row.network === "Ethereum" ? 1 : 137;
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
      if (!response.ok || data.error || !data.result) {
        throw new Error(JSON.stringify(data.error || data));
      }
      return data.result;
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

async function worker() {
  while (cursor < rows.length) {
    const row = rows[cursor++];
    const address = row.address.toLowerCase();
    const code = await getCode(row);
    const hasCode = code !== "0x" && code !== "0x0";
    const knownEntry = known[address];

    let type;
    let label;

    if (knownEntry && hasCode) {
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

    results.push({ ...row, classification: type, identification: label });

    console.log(
      `${row.network.padEnd(8)} #${String(row.rank).padStart(2)} ` +
      `${type.padEnd(16)} ${row.address} | ${row.gnus} GNUS`
    );
  }
}

await Promise.all(Array.from({ length: 4 }, () => worker()));

results.sort((a, b) =>
  a.network.localeCompare(b.network) || Number(a.rank) - Number(b.rank)
);

const columns = [...header, "classification", "identification"];
const escapeCsv = value => `"${String(value ?? "").replaceAll('"', '""')}"`;

const csv = [
  columns.join(","),
  ...results.map(row => columns.map(c => escapeCsv(row[c])).join(","))
].join("\n") + "\n";

fs.writeFileSync(output, csv);

console.log("\n========== CLASSIFICATION COMPLETE ==========");
for (const type of ["EOA", "SMART_CONTRACT", "POOL", "TEAM_MULTISIG"]) {
  console.log(`${type}: ${results.filter(r => r.classification === type).length}`);
}
console.log(`File: ${output}`);
