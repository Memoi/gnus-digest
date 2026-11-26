import fs from "node:fs/promises";

const INPUT = "public/gnus-top50-classified.csv";
const OUTPUT = "public/gnus-top50-enriched.csv";
const CACHE = ".gnus-explorer-label-cache-v2.json";

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter(r => r.some(v => v.trim() !== ""));
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function decodeHTML(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#10;|&#xA;/gi, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    )
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n))
    )
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function extractNameTag(html) {
  const match = html.match(
    /title=['"]Public Name Tag[^'"]*?<br\s*\/?>\s*([^'"]+)/i
  );

  if (!match?.[1]) return "";

  return decodeHTML(match[1])
    .replace(/\s*\(0x[0-9a-f]{40}\)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLabels(html) {
  const knownLabels = [
    "Liquidity Pool",
    "Centralized Exchange",
    "Decentralized Exchange",
    "Exchange",
    "Bridge",
    "Bridge Contract",
    "Staking Contract",
    "Lending Pool",
    "Vault",
    "Multisig",
    "Safe",
    "Proxy",
    "Router",
    "Treasury",
    "Governance",
    "DAO",
    "Distributor",
    "Vesting",
    "Smart Account",
    "Token",
    "NFT"
  ];

  const labels = [];

  for (const label of knownLabels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `>\\s*${escaped}\\s*<`,
      "i"
    );

    if (pattern.test(html)) labels.push(label);
  }

  return labels;
}

function findColumn(headers, candidates) {
  return headers.findIndex(h =>
    candidates.includes(h.trim().toLowerCase())
  );
}

function identifyChain(value) {
  const v = String(value ?? "").toLowerCase();

  if (/\b(ethereum|eth|mainnet|1)\b/.test(v)) return "ethereum";
  if (/\b(polygon|matic|137)\b/.test(v)) return "polygon";

  return "";
}

async function loadCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE, "utf8"));
  } catch {
    return {};
  }
}

async function fetchExplorer(chain, address) {
  const host = chain === "ethereum"
    ? "https://etherscan.io"
    : "https://polygonscan.com";

  const url = `${host}/address/${address}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 GNUS-Digest/1.0",
          "Accept": "text/html"
        },
        signal: AbortSignal.timeout(20000)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();

      if (/cloudflare|just a moment/i.test(html.slice(0, 30000))) {
        throw new Error("Protection anti-bot");
      }

      return {
        nameTag: extractNameTag(html),
        labels: extractLabels(html),
        url,
        status: "OK",
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      if (attempt === 3) {
        return {
          nameTag: "",
          labels: [],
          url,
          status: `ERROR: ${error.message}`,
          checkedAt: new Date().toISOString()
        };
      }

      await new Promise(resolve =>
        setTimeout(resolve, attempt * 2000)
      );
    }
  }
}

async function main() {
  const source = await fs.readFile(INPUT, "utf8");
  const rows = parseCSV(source);

  if (rows.length < 2) {
    throw new Error("CSV vide ou sans données.");
  }

  const headers = rows[0];

  const addressCol = findColumn(headers, [
    "address", "holder", "wallet", "account"
  ]);

  const chainCol = findColumn(headers, [
    "chain", "network", "blockchain"
  ]);

  if (addressCol < 0 || chainCol < 0) {
    throw new Error(
      `Colonnes introuvables. En-têtes détectés : ${headers.join(" | ")}`
    );
  }

  const nameCol = findColumn(headers, ["explorer name tag"]);
  const labelCol = findColumn(headers, ["explorer label"]);
  const statusCol = findColumn(headers, ["explorer status"]);
  const urlCol = findColumn(headers, ["explorer url"]);

  const outputHeaders = [...headers];

  function addColumn(name, existingIndex) {
    if (existingIndex >= 0) return existingIndex;
    outputHeaders.push(name);
    return outputHeaders.length - 1;
  }

  const nameIndex = addColumn("Explorer Name Tag", nameCol);
  const labelIndex = addColumn("Explorer Label", labelCol);
  const statusIndex = addColumn("Explorer Status", statusCol);
  const urlIndex = addColumn("Explorer URL", urlCol);

  const cache = await loadCache();
  const tasks = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    while (row.length < outputHeaders.length) row.push("");

    const address = row[addressCol].trim();
    const chain = identifyChain(row[chainCol]);

    if (!/^0x[0-9a-f]{40}$/i.test(address)) {
      console.log(`Ligne ${i}: adresse invalide, ignorée.`);
      continue;
    }

    if (!chain) {
      console.log(`Ligne ${i}: réseau non reconnu (${row[chainCol]}).`);
      continue;
    }

    tasks.push({ i, address, chain, row });
  }

  let completed = 0;
  let fetched = 0;

  async function worker(items) {
    for (const item of items) {
      const key = `${item.chain}:${item.address.toLowerCase()}`;
      let result = cache[key];

      if (!result) {
        result = await fetchExplorer(item.chain, item.address);
        cache[key] = result;
        fetched++;

        await fs.writeFile(CACHE, JSON.stringify(cache, null, 2));
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      item.row[nameIndex] = result.nameTag || "";
      item.row[labelIndex] = (result.labels || []).join(" | ");
      item.row[statusIndex] = result.status || "";
      item.row[urlIndex] = result.url || "";

      completed++;

      console.log(
        `[${completed}/${tasks.length}] ${item.chain} ${item.address} | ` +
        `${result.nameTag || "No Name Tag"} | ` +
        `${(result.labels || []).join(", ") || "Sans label"}`
      );
    }
  }

  const workers = [];
  const concurrency = 3;

  for (let i = 0; i < concurrency; i++) {
    workers.push(worker(tasks.filter((_, index) =>
      index % concurrency === i
    )));
  }

  await Promise.all(workers);

  const output = [
    outputHeaders.map(csvEscape).join(","),
    ...rows.slice(1).map(row =>
      outputHeaders.map((_, index) =>
        csvEscape(row[index] ?? "")
      ).join(",")
    )
  ].join("\n") + "\n";

  await fs.writeFile(OUTPUT, output);

  console.log("\n========== ENRICHMENT COMPLETE ==========");
  console.log("Addresses processed :", completed);
  console.log("New pages downloaded :", fetched);
  console.log("Cached entries :", Object.keys(cache).length);
  console.log("File:", OUTPUT);
}

main().catch(error => {
  console.error("ERREUR :", error.message);
  process.exitCode = 1;
});
