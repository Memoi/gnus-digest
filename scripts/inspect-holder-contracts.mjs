import fs from "node:fs";
import path from "node:path";

const DATA_FILE = "public/gnus-top50.json";
const OUTPUT_DIR = "/tmp/gnus-holder-contract-analysis";
const API_KEY = process.env.ROUTESCAN_API_KEY;

if (!API_KEY) {
  throw new Error("ROUTESCAN_API_KEY absent. Lance source ~/.bashrc");
}

const networks = [
  { key: "ethereum", chainId: 1 },
  { key: "polygon", chainId: 137 }
];

const knownPools = new Set([
  "0xf10e8ccdb3f065bf24afa14d08cc6336d4a9a281",
  "0x45126b956401daaec92afba2a9953e14b16fb83f"
]);

const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
const results = [];

async function getSourceCode(chainId, address) {
  const url = new URL(
    `https://api.routescan.io/v2/network/mainnet/evm/${chainId}/etherscan/api`
  );

  url.searchParams.set("module", "contract");
  url.searchParams.set("action", "getsourcecode");
  url.searchParams.set("address", address);

  const response = await fetch(url, {
    headers: { apikey: API_KEY },
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(`Routescan HTTP ${response.status}`);
  }

  const json = await response.json();

  if (json.status !== "1" || !Array.isArray(json.result)) {
    return null;
  }

  return json.result[0] || null;
}

function parseAbi(raw) {
  if (!raw || raw === "Contract source code not verified") return [];

  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function extractSource(raw, directory) {
  if (!raw) return "NO_SOURCE";

  let source = raw;

  // Routescan/Etherscan standard JSON can be wrapped in double braces.
  if (source.startsWith("{{") && source.endsWith("}}")) {
    source = source.slice(1, -1);
  }

  try {
    const parsed = JSON.parse(source);

    if (parsed.sources) {
      const files = [];

      for (const [name, entry] of Object.entries(parsed.sources)) {
        if (!entry.content) continue;

        const safeName = name
          .replace(/^[/\\]+/, "")
          .replace(/\.\./g, "_");

        const destination = path.join(directory, safeName);

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, entry.content);
        files.push(safeName);
      }

      fs.writeFileSync(
        path.join(directory, "standard-input.json"),
        JSON.stringify(parsed, null, 2)
      );

      return files.length ? files : "JSON_WITHOUT_SOURCE_FILES";
    }

    fs.writeFileSync(
      path.join(directory, "source-metadata.json"),
      JSON.stringify(parsed, null, 2)
    );

    return "JSON_METADATA";
  } catch {
    fs.writeFileSync(path.join(directory, "source.sol"), raw);
    return ["source.sol"];
  }
}

function summarizeAbi(abi) {
  return {
    functions: abi
      .filter(item => item.type === "function")
      .map(item => ({
        name: item.name,
        signature: `${item.name}(${(item.inputs || [])
          .map(input => input.type).join(",")})`,
        mutability: item.stateMutability
      })),
    events: abi
      .filter(item => item.type === "event")
      .map(item => item.name)
  };
}

async function inspectContract(network, address, label = "holder") {
  const directory = path.join(
    OUTPUT_DIR,
    network.key,
    address.toLowerCase(),
    label
  );

  fs.mkdirSync(directory, { recursive: true });

  const result = await getSourceCode(network.chainId, address);

  if (!result) {
    return {
      address,
      label,
      status: "SOURCE_NOT_VERIFIED"
    };
  }

  const abi = parseAbi(result.ABI);
  const summary = summarizeAbi(abi);

  fs.writeFileSync(
    path.join(directory, "abi.json"),
    JSON.stringify(abi, null, 2)
  );

  const sourceFiles = extractSource(
    result.SourceCode,
    directory
  );

  return {
    address,
    label,
    status: result.SourceCode
      ? "SOURCE_AVAILABLE"
      : "ABI_ONLY",
    contractName: result.ContractName || null,
    compiler: result.CompilerVersion || null,
    verified: Boolean(result.SourceCode),
    proxy: result.Proxy || "0",
    implementation: result.Implementation || null,
    license: result.LicenseType || null,
    sourceFiles,
    ...summary
  };
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

for (const network of networks) {
  const holders = data.networks[network.key].holders
    .filter(holder => holder.holderType === "Smart Contract");

  console.log(`\n========== ${network.key.toUpperCase()} ==========`);

  for (const holder of holders) {
    const address = holder.address;
    const lower = address.toLowerCase();

    console.log(`\nInspecting ${address}`);

    if (knownPools.has(lower)) {
      results.push({
        network: network.key,
        address,
        status: "KNOWN_POOL",
        contractName: "Uniswap V3 GNUS/WETH Pool",
        purpose: "Provides liquidity for GNUS/WETH trading"
      });
      console.log("KNOWN: Uniswap V3 GNUS/WETH Pool");
      continue;
    }

    try {
      const inspected = await inspectContract(network, address);

      results.push({
        network: network.key,
        gnus: holder.gnus,
        rank: holder.rank,
        ...inspected
      });

      console.log("Status:", inspected.status);
      console.log("Contract:", inspected.contractName || "Unknown");
      console.log("Proxy:", inspected.proxy);
      console.log("Implementation:", inspected.implementation || "None");
      console.log("Functions:", inspected.functions?.length || 0);
      console.log("Events:", inspected.events?.length || 0);

      // Inspect proxy implementation when Routescan identifies one.
      if (
        inspected.implementation &&
        /^0x[a-fA-F0-9]{40}$/.test(inspected.implementation) &&
        inspected.implementation.toLowerCase() !== lower
      ) {
        console.log("Inspecting proxy implementation...");

        const implementation = await inspectContract(
          network,
          inspected.implementation,
          "implementation"
        );

        results.push({
          network: network.key,
          proxyAddress: address,
          ...implementation
        });

        console.log(
          "Implementation contract:",
          implementation.contractName || "Unknown"
        );
      }
    } catch (error) {
      console.log("ERROR:", error.message);

      results.push({
        network: network.key,
        address,
        status: "INSPECTION_ERROR",
        error: error.message
      });
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

fs.writeFileSync(
  path.join(OUTPUT_DIR, "analysis.json"),
  JSON.stringify(results, null, 2)
);

console.log("\n========== ROUTESCAN ANALYSIS COMPLETE ==========");
console.log("Results:", results.length);
console.log(
  "Source available:",
  results.filter(r => r.status === "SOURCE_AVAILABLE").length
);
console.log(
  "ABI only:",
  results.filter(r => r.status === "ABI_ONLY").length
);
console.log(
  "Not verified:",
  results.filter(r => r.status === "SOURCE_NOT_VERIFIED").length
);
console.log("Report:", `${OUTPUT_DIR}/analysis.json`);
console.log("Solidity files:", OUTPUT_DIR);
