import fs from "node:fs";

const JSON_FILE = "public/gnus-top50.json";
const CSV_FILE = "public/gnus-top50-classified.csv";
const MAIN_CSV_FILE = "public/gnus-top50.csv";

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

function readCsv(file) {
  const lines = fs.readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/);

  if (!lines.length || !lines[0]) throw new Error(`Empty CSV: ${file}`);

  return {
    headers: parseCsvLine(lines[0]),
    rows: lines.slice(1).map(parseCsvLine)
  };
}

function serializeCsv(headers, rows) {
  const escape = value =>
    `"${String(value ?? "").replace(/"/g, '""')}"`;

  return [
    headers.map(escape).join(","),
    ...rows.map(row => headers.map((_, i) => escape(row[i])).join(","))
  ].join("\n") + "\n";
}

const classified = readCsv(CSV_FILE);
const ci = Object.fromEntries(classified.headers.map((h, i) => [h, i]));

const required = [
  "network", "rank", "address", "gnus", "referenceBlock",
  "classification", "identification", "codePresent", "codeBytes",
  "codePrefix", "eip7702Verified", "delegatedImplementation"
];

for (const field of required) {
  if (ci[field] === undefined) {
    throw new Error(`Missing classified CSV column: ${field}`);
  }
}

const labels = new Map();

for (const row of classified.rows) {
  const networkKey =
    row[ci.network] === "Ethereum" ? "ethereum" :
    row[ci.network] === "Polygon" ? "polygon" : null;

  const address = row[ci.address]?.toLowerCase();
  const classification = row[ci.classification];
  const identification = row[ci.identification] || "";
  const codePresent = row[ci.codePresent] === "true";
  const eip7702Verified = row[ci.eip7702Verified] === "true";
  const delegatedImplementation = row[ci.delegatedImplementation] || "";
  const codeBytes = Number(row[ci.codeBytes]);

  if (!networkKey || !/^0x[a-f0-9]{40}$/.test(address || "")) {
    throw new Error("Invalid network or address in classified CSV");
  }

  if (!Number.isInteger(codeBytes) || codeBytes < 0) {
    throw new Error(`Invalid codeBytes for ${address}`);
  }

  if (eip7702Verified) {
    if (
      classification !== "EOA" ||
      !codePresent ||
      codeBytes !== 23 ||
      !/^0x[a-fA-F0-9]{40}$/.test(delegatedImplementation)
    ) {
      throw new Error(`Invalid EIP-7702 evidence for ${address}`);
    }
  } else if (delegatedImplementation) {
    throw new Error(`Unexpected delegated implementation for ${address}`);
  }

  const holderType = {
    TEAM_MULTISIG: "GNUS Multisig",
    GNOSIS_SAFE: "GNUS Multisig",
    SMART_CONTRACT: "Smart Contract",
    POOL: "Smart Contract",
    VESTING: "Smart Contract",
    EOA: "Wallet"
  }[classification];

  if (!holderType) throw new Error(`Unknown classification: ${classification}`);

  const key = `${networkKey}:${address}`;

  if (labels.has(key)) throw new Error(`Duplicate classification: ${key}`);

  labels.set(key, {
    holderType,
    holderDescription: identification,
    classification,
    codeAudit: {
      checked: true,
      codePresent,
      codeBytes,
      codePrefix: row[ci.codePrefix] || "",
      eip7702Verified,
      delegatedImplementation: delegatedImplementation || null
    },
    inventory: {
      network: networkKey,
      rank: Number(row[ci.rank]),
      address: row[ci.address],
      gnus: row[ci.gnus],
      referenceBlock: row[ci.referenceBlock],
      role: identification,
      delegatedImplementation: delegatedImplementation || null
    }
  });
}

if (labels.size !== 100 || classified.rows.length !== 100) {
  throw new Error(`Expected 100 classifications, received ${labels.size}`);
}

// Load and validate the source JSON.
const data = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
data.description =
  "Top 50 holders per network, balances individually verified on-chain";

const inventory = {
  eip7702Wallets: [],
  verifiedContracts: [],
  multisigs: []
};

let updated = 0;
let codeChecked = 0;

for (const networkKey of ["ethereum", "polygon"]) {
  const holders = data.networks?.[networkKey]?.holders;

  if (!Array.isArray(holders) || holders.length !== 50) {
    throw new Error(`Invalid ${networkKey} holder dataset`);
  }

  for (const holder of holders) {
    const address = holder.address?.toLowerCase();
    const key = `${networkKey}:${address}`;
    const label = labels.get(key);

    if (!label) throw new Error(`Missing classification: ${key}`);

    holder.holderType = label.holderType;
    holder.holderDescription = label.holderDescription;
    holder.codeAudit = label.codeAudit;

    const item = {
      ...label.inventory,
      rank: Number(holder.rank),
      gnus: String(holder.gnus),
      referenceBlock: String(holder.referenceBlock)
    };

    if (label.codeAudit.checked) codeChecked++;

    if (label.codeAudit.eip7702Verified) {
      inventory.eip7702Wallets.push(item);
    } else if (
      ["TEAM_MULTISIG", "GNOSIS_SAFE"].includes(label.classification) &&
      label.codeAudit.codePresent
    ) {
      inventory.multisigs.push(item);
    } else if (
      ["POOL", "VESTING", "SMART_CONTRACT"].includes(label.classification) &&
      label.codeAudit.codePresent
    ) {
      inventory.verifiedContracts.push(item);
    }

    updated++;
  }
}

if (updated !== 100 || codeChecked !== 100) {
  throw new Error(`Expected 100 updated/code-checked holders; got ${updated}/${codeChecked}`);
}

for (const key of Object.keys(inventory)) {
  inventory[key].sort((a, b) =>
    a.network.localeCompare(b.network) || a.rank - b.rank
  );
}

data.codeAudit = {
  generatedAt: new Date().toISOString(),
  method: "eth_getCode at each holder referenceBlock",
  networks: {
    ethereum: {
      chainId: 1,
      referenceBlock: data.networks.ethereum.referenceBlock
    },
    polygon: {
      chainId: 137,
      referenceBlock: data.networks.polygon.referenceBlock
    }
  },
  checkedAddresses: codeChecked,
  eip7702Wallets: inventory.eip7702Wallets.length,
  verifiedContracts: inventory.verifiedContracts.length,
  multisigs: inventory.multisigs.length
};

data.eip7702Wallets = inventory.eip7702Wallets;
data.verifiedContracts = inventory.verifiedContracts;
data.multisigs = inventory.multisigs;

// Update downloadable main CSV.
const mainCsv = readCsv(MAIN_CSV_FILE);
const mi = Object.fromEntries(mainCsv.headers.map((h, i) => [h, i]));

for (const field of ["network", "address"]) {
  if (mi[field] === undefined) throw new Error(`Missing main CSV column: ${field}`);
}

for (const field of ["holder_type", "holder_description"]) {
  if (mi[field] === undefined) {
    mainCsv.headers.push(field);
    mi[field] = mainCsv.headers.length - 1;
    for (const row of mainCsv.rows) row.push("");
  }
}

let csvUpdated = 0;

for (const row of mainCsv.rows) {
  const networkKey =
    row[mi.network] === "Ethereum" ? "ethereum" :
    row[mi.network] === "Polygon" ? "polygon" : null;

  const address = row[mi.address]?.toLowerCase();
  const label = labels.get(`${networkKey}:${address}`);

  if (!networkKey || !label) {
    throw new Error(`Missing CSV classification: ${networkKey}:${address}`);
  }

  row[mi.holder_type] = label.holderType;
  row[mi.holder_description] = label.holderDescription;
  csvUpdated++;
}

if (csvUpdated !== 100 || mainCsv.rows.length !== 100) {
  throw new Error(`Expected 100 CSV rows, got ${csvUpdated}`);
}

// Prepare both files before replacing either one.
const jsonTemporary = `${JSON_FILE}.tmp`;
const csvTemporary = `${MAIN_CSV_FILE}.tmp`;

fs.writeFileSync(jsonTemporary, JSON.stringify(data, null, 2) + "\n");
fs.writeFileSync(csvTemporary, serializeCsv(mainCsv.headers, mainCsv.rows));

fs.renameSync(jsonTemporary, JSON_FILE);
fs.renameSync(csvTemporary, MAIN_CSV_FILE);

console.log("Holder categories applied:", updated);
console.log("Main CSV categories applied:", csvUpdated);
console.log("On-chain code checks:", data.codeAudit.checkedAddresses);
console.log("EIP-7702 wallets:", data.codeAudit.eip7702Wallets);
console.log("Identified contracts:", data.codeAudit.verifiedContracts);
console.log("Multisigs:", data.codeAudit.multisigs);
console.log("Ethereum:", data.networks.ethereum.holders.length);
console.log("Polygon:", data.networks.polygon.holders.length);
