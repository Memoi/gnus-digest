import fs from "node:fs";

const JSON_FILE = "public/gnus-top50.json";
const CSV_FILE = "public/gnus-top50-classified.csv";

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

const csv = fs.readFileSync(CSV_FILE, "utf8")
  .replace(/^\uFEFF/, "")
  .trim()
  .split(/\r?\n/);

const headers = parseCsvLine(csv[0]);
const index = Object.fromEntries(headers.map((h, i) => [h, i]));

for (const field of ["network", "address", "classification"]) {
  if (index[field] === undefined) {
    throw new Error(`Missing CSV column: ${field}`);
  }
}

const labels = new Map();

for (const line of csv.slice(1)) {
  const row = parseCsvLine(line);
  const network = row[index.network];
  const address = row[index.address]?.toLowerCase();
  const classification = row[index.classification];

  const networkKey =
    network === "Ethereum" ? "ethereum" :
    network === "Polygon" ? "polygon" : null;

  if (!networkKey || !address) {
    throw new Error(`Invalid classified row: ${line}`);
  }

  const holderType = {
    TEAM_MULTISIG: "GNUS Multisig",
    SMART_CONTRACT: "Smart Contract",
    POOL: "Smart Contract",
    EOA: "Wallet"
  }[classification];

  if (!holderType) {
    throw new Error(`Unknown classification: ${classification}`);
  }

  labels.set(`${networkKey}:${address}`, holderType);
}

if (labels.size !== 100) {
  throw new Error(`Expected 100 classifications, received ${labels.size}`);
}

const data = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
data.description = "Top 50 holders per network, balances individually verified on-chain";
let updated = 0;

for (const networkKey of ["ethereum", "polygon"]) {
  const holders = data.networks?.[networkKey]?.holders;

  if (!Array.isArray(holders) || holders.length !== 50) {
    throw new Error(`Invalid ${networkKey} holder dataset`);
  }

  for (const holder of holders) {
    const key = `${networkKey}:${holder.address.toLowerCase()}`;
    const holderType = labels.get(key);

    if (!holderType) {
      throw new Error(`Missing classification: ${key}`);
    }

    holder.holderType = holderType;
    updated++;
  }
}

if (updated !== 100) {
  throw new Error(`Expected 100 updated holders, got ${updated}`);
}

const temporary = `${JSON_FILE}.tmp`;
fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n");
fs.renameSync(temporary, JSON_FILE);

console.log("Holder categories applied:", updated);
console.log("Ethereum:", data.networks.ethereum.holders.length);
console.log("Polygon:", data.networks.polygon.holders.length);
