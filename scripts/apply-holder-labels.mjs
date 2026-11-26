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
    ...rows.map(row => row.map(escape).join(","))
  ].join("\n") + "\n";
}

const classified = readCsv(CSV_FILE);
const classifiedIndex = Object.fromEntries(
  classified.headers.map((h, i) => [h, i])
);

for (const field of ["network", "address", "classification", "identification"]) {
  if (classifiedIndex[field] === undefined) {
    throw new Error(`Missing classified CSV column: ${field}`);
  }
}

const labels = new Map();

for (const row of classified.rows) {
  const networkKey =
    row[classifiedIndex.network] === "Ethereum" ? "ethereum" :
    row[classifiedIndex.network] === "Polygon" ? "polygon" : null;

  const address = row[classifiedIndex.address]?.toLowerCase();
  const classification = row[classifiedIndex.classification];
  const identification = row[classifiedIndex.identification] || "";

  if (!networkKey || !address) {
    throw new Error("Invalid row in classified CSV");
  }

  const holderType = {
    TEAM_MULTISIG: "GNUS Multisig",
    GNOSIS_SAFE: "GNUS Multisig",
    SMART_CONTRACT: "Smart Contract",
    POOL: "Smart Contract",
    VESTING: "Smart Contract",
    EOA: "Wallet"
  }[classification];

  if (!holderType) {
    throw new Error(`Unknown classification: ${classification}`);
  }

  const key = `${networkKey}:${address}`;

  if (labels.has(key)) {
    throw new Error(`Duplicate classification: ${key}`);
  }

  labels.set(key, { holderType, holderDescription: identification });
}

if (labels.size !== 100) {
  throw new Error(`Expected 100 classifications, received ${labels.size}`);
}

// Update JSON
const data = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
data.description =
  "Top 50 holders per network, balances individually verified on-chain";

let updated = 0;

for (const networkKey of ["ethereum", "polygon"]) {
  const holders = data.networks?.[networkKey]?.holders;

  if (!Array.isArray(holders) || holders.length !== 50) {
    throw new Error(`Invalid ${networkKey} holder dataset`);
  }

  for (const holder of holders) {
    const key = `${networkKey}:${holder.address.toLowerCase()}`;
    const label = labels.get(key);

    if (!label) {
      throw new Error(`Missing classification: ${key}`);
    }

    holder.holderType = label.holderType;
    holder.holderDescription = label.holderDescription;
    updated++;
  }
}

if (updated !== 100) {
  throw new Error(`Expected 100 updated holders, got ${updated}`);
}

// Update the main downloadable CSV
const mainCsv = readCsv(MAIN_CSV_FILE);
const mainIndex = Object.fromEntries(
  mainCsv.headers.map((h, i) => [h, i])
);

for (const field of ["network", "address"]) {
  if (mainIndex[field] === undefined) {
    throw new Error(`Missing main CSV column: ${field}`);
  }
}

if (mainIndex.holder_type === undefined) {
  mainCsv.headers.push("holder_type");
  mainIndex.holder_type = mainCsv.headers.length - 1;
}

if (mainIndex.holder_description === undefined) {
  mainCsv.headers.push("holder_description");
  mainIndex.holder_description = mainCsv.headers.length - 1;
}

let csvUpdated = 0;

for (const row of mainCsv.rows) {
  const networkKey =
    row[mainIndex.network] === "Ethereum" ? "ethereum" :
    row[mainIndex.network] === "Polygon" ? "polygon" : null;

  const address = row[mainIndex.address]?.toLowerCase();
  const key = `${networkKey}:${address}`;
  const label = labels.get(key);

  if (!networkKey || !label) {
    throw new Error(`Missing CSV classification: ${key}`);
  }

  row[mainIndex.holder_type] = label.holderType;
  row[mainIndex.holder_description] = label.holderDescription;
  csvUpdated++;
}

if (csvUpdated !== 100 || mainCsv.rows.length !== 100) {
  throw new Error(`Expected 100 CSV rows, got ${csvUpdated}`);
}

// Write only after all validations have passed
const jsonTemporary = `${JSON_FILE}.tmp`;
const csvTemporary = `${MAIN_CSV_FILE}.tmp`;

fs.writeFileSync(jsonTemporary, JSON.stringify(data, null, 2) + "\n");
fs.writeFileSync(
  csvTemporary,
  serializeCsv(mainCsv.headers, mainCsv.rows)
);

fs.renameSync(jsonTemporary, JSON_FILE);
fs.renameSync(csvTemporary, MAIN_CSV_FILE);

console.log("Holder categories applied:", updated);
console.log("Main CSV categories applied:", csvUpdated);
console.log("CSV columns: holder_type, holder_description");
console.log("Holder descriptions applied:", updated);
console.log("Ethereum:", data.networks.ethereum.holders.length);
console.log("Polygon:", data.networks.polygon.holders.length);
