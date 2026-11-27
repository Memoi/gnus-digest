import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/gnus-agent/playwright/node_modules/playwright');

const ROOT = path.resolve('public');
const OUTPUT = path.join('/tmp', `gnus-digest-playwright-${process.env.USER || 'user'}`);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const REPORT = path.join(OUTPUT, `report-${timestamp}.json`);

const MODE = process.env.GNUS_TEST_MODE === 'live'
  ? 'live'
  : 'isolated';

const results = {
  startedAt: new Date().toISOString(),
  mode: MODE,
  tests: [],
  errors: [],
  warnings: [],
  externalRequests: [],
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function addTest(name, status, details = {}) {
  results.tests.push({ name, status, ...details });
  console.log(`[${status}] ${name}`);
}

function fail(name, error) {
  results.errors.push({ name, error: String(error) });
  addTest(name, 'FAIL', { error: String(error) });
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(ROOT, relative);

    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const data = await fs.readFile(file);
    const type = mimeTypes[path.extname(file)] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

await fs.mkdir(OUTPUT, { recursive: true });

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(18765, '127.0.0.1', resolve);
});

const BASE = 'http://127.0.0.1:18765';

let browser;

try {
  const launchOptions = { headless: true };

  if (MODE === 'live') {
    launchOptions.proxy = {
      server: 'http://127.0.0.1:3128',
      bypass: '127.0.0.1,localhost',
    };
  }

  browser = await chromium.launch(launchOptions);

  async function inspectPage(page, name, url, mobile = false) {
    const pageErrors = [];
    const localErrors = [];
    const httpErrors = [];
    const consoleErrors = [];

    page.on('pageerror', error => pageErrors.push(error.message));

    page.on('console', message => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    page.on('response', response => {
      if (response.status() >= 400) {
        const request = response.request();
        const entry = {
          url: response.url(),
          status: response.status(),
          method: request.method(),
          resourceType: request.resourceType(),
        };

        if (response.url().startsWith(BASE)) {
          localErrors.push(entry);
        } else {
          httpErrors.push(entry);
        }
      }
    });

    // Ethers est simulé pour tester l'interface sans dépendance CDN.
    // Les autres requêtes externes sont volontairement neutralisées.
    if (name === 'liquidity' && MODE === 'isolated') {
      await page.route('**/*', async route => {
        const requestUrl = route.request().url();

        if (requestUrl.startsWith(BASE)) {
          return route.continue();
        }

        if (requestUrl.includes('ethers.umd.min.js')) {
          return route.fulfill({
            status: 200,
            contentType: 'application/javascript',
            body: `
              window.ethers = {
                utils: {
                  Interface: class {
                    constructor() {}
                    encodeFunctionData() { return '0x'; }
                    decodeFunctionResult() { return []; }
                  },
                  getAddress(value) { return value; }
                }
              };
            `,
          });
        }

        results.externalRequests.push({
          page: name,
          url: requestUrl,
          action: 'blocked',
        });

        return route.abort();
      });
    }

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    if (!response || !response.ok()) {
      throw new Error(`Navigation HTTP incorrecte : ${response?.status()}`);
    }

    if (name === 'index' || name === 'archive') {
      await page.waitForFunction(() => {
        const meta = document.querySelector('#meta');
        return meta && !meta.textContent.includes('Loading');
      }, { timeout: 15000 });
    } else if (name === 'liquidity') {
      await page.waitForSelector('#histBody', { timeout: 10000 });
      await page.waitForTimeout(1500);
    } else if (name === 'holders') {
      await page.waitForFunction(() => {
        const status = document.querySelector('#updated')?.textContent || '';
        return status.startsWith('Last update:') ||
          status.includes('Unable to load holders data:');
      }, { timeout: 15000 });
    }

    const title = await page.title();
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));

    if (dimensions.scrollWidth > dimensions.width + 3) {
      results.warnings.push({
        page: name,
        viewport: mobile ? 'mobile' : 'desktop',
        issue: 'Débordement horizontal',
        dimensions,
      });
    }

    if (pageErrors.length) {
      throw new Error(`Erreurs JavaScript : ${pageErrors.join(' | ')}`);
    }

    if (localErrors.length) {
      throw new Error(`Ressources locales en erreur : ${JSON.stringify(localErrors)}`);
    }

    if (name === 'index') {
      const meta = await page.locator('#meta').innerText();

      if (meta.includes('Could not load digest.json')) {
        throw new Error(meta);
      }

      if (!(await page.locator('nav a').count())) {
        throw new Error('Navigation absente');
      }
    }

    if (name === 'archive') {
      const search = page.locator('#q');
      await search.fill('terme-de-test-qui-ne-devrait-rien-correspondre-987654321');

      await page.getByText('Nothing matches this filter.').waitFor({
        timeout: 5000,
      });

      await search.fill('');
    }

    let functionalChecks = null;

    if (name === 'holders') {
      const status = (await page.locator('#updated').innerText()).trim();

      if (!status.startsWith('Last update:')) {
        throw new Error('Chargement du dataset Holders échoué : ' + status);
      }

      const initialRows = await page.locator('#holders tr').count();

      if (initialRows !== 50) {
        throw new Error(`Ethereum : 50 détenteurs attendus, ${initialRows} trouvés`);
      }

      const ethereumContract = (await page.locator('#contract').innerText()).trim();

      if (!ethereumContract.includes('Contract:')) {
        throw new Error('Adresse du contrat Ethereum absente');
      }

      const firstAddress = (
        await page.locator('#holders tr td:nth-child(2) a').first().innerText()
      ).trim();

      if (!firstAddress) {
        throw new Error('Adresse du premier détenteur Ethereum absente');
      }

      // Vérification de la recherche par adresse exacte.
      await page.locator('#search').fill(firstAddress);

      const filteredRows = await page.locator('#holders tr').count();
      const filteredCount = (await page.locator('#count').innerText()).trim();

      if (filteredRows !== 1 || !filteredCount.startsWith('1 of 50')) {
        throw new Error(
          `Recherche Holders incorrecte : ${filteredRows} ligne(s), ${filteredCount}`
        );
      }

      // Vérification du résultat vide.
      await page.locator('#search').fill('address-that-does-not-exist-987654321');

      const emptyResult = await page.locator('#holders').innerText();

      if (!emptyResult.includes('No matching address.')) {
        throw new Error('Le résultat vide de la recherche est incorrect');
      }

      // Restauration de la liste Ethereum.
      await page.locator('#search').fill('');

      // Bascule vers Polygon.
      await page.locator('#polyButton').click();

      const polygonRows = await page.locator('#holders tr').count();
      const polygonContract = (await page.locator('#contract').innerText()).trim();

      if (polygonRows !== 50) {
        throw new Error(`Polygon : 50 détenteurs attendus, ${polygonRows} trouvés`);
      }

      if (!polygonContract.includes('Contract:') ||
          polygonContract === ethereumContract) {
        throw new Error('Le contrat Polygon est absent ou identique à Ethereum');
      }

      const polygonActive = await page.locator('#polyButton').evaluate(
        element => element.classList.contains('active')
      );

      if (!polygonActive) {
        throw new Error('Le bouton Polygon ne devient pas actif');
      }

      // Retour à Ethereum.
      await page.locator('#ethButton').click();

      const ethereumActive = await page.locator('#ethButton').evaluate(
        element => element.classList.contains('active')
      );

      if (!ethereumActive) {
        throw new Error('Le bouton Ethereum ne devient pas actif');
      }

      // Vérification des trois inventaires sans supposer qu'ils sont tous remplis.
      const inventories = {};

      for (const [key, selector, metaSelector] of [
        ['eip7702', '#eip7702Table', '#eip7702Meta'],
        ['contracts', '#contractsTable', '#contractsMeta'],
        ['multisigs', '#multisigsTable', '#multisigsMeta'],
      ]) {
        const container = page.locator(selector);
        const meta = (await page.locator(metaSelector).innerText()).trim();
        const rows = await container.locator('table tbody tr').count();
        const empty = await container.locator('.inventory-empty').count();

        if (!meta) {
          throw new Error(`Métadonnées absentes pour l'inventaire ${key}`);
        }

        if (rows === 0 && empty === 0) {
          throw new Error(`Inventaire ${key} vide sans message explicatif`);
        }

        inventories[key] = {
          rows,
          empty,
          metadata: meta,
        };
      }

      functionalChecks = {
        dataset: {
          status,
          ethereumHolders: initialRows,
          polygonHolders: polygonRows,
          ethereumContract,
          polygonContract,
        },
        search: {
          addressTested: firstAddress,
          matchingRows: filteredRows,
          emptyResultVerified: true,
        },
        networkSwitch: {
          ethereum: ethereumActive,
          polygon: polygonActive,
        },
        inventories,
      };
    }

    if (name === 'liquidity') {
      if (!(await page.locator('#histBody').count())) {
        throw new Error('Zone historique absente');
      }

      if (MODE === 'live') {
        // 1. Attendre le résultat réel du chargement du pool principal.
        await page.waitForFunction(() => {
          const status = document.querySelector('#status')?.textContent || '';
          return status.startsWith('Up to date') || status.startsWith('Error:');
        }, null, { timeout: 120000 });

        const status = (await page.locator('#status').innerText()).trim();

        if (!status.startsWith('Up to date')) {
          throw new Error('Chargement du pool principal échoué : ' + status);
        }

        const info = (await page.locator('#info').innerText()).trim();
        const outputRows = await page.locator('#out table tbody tr').count();

        if (!info || !(await page.locator('#info > div').count())) {
          throw new Error('Informations du pool principal absentes');
        }

        if (outputRows === 0) {
          throw new Error('Aucun résultat de calcul de liquidité');
        }

        // 2. Attendre le chargement asynchrone de l'historique réel.
        await page.waitForFunction(() => {
          const note = document.querySelector('#histNote')?.textContent || '';
          const rows = document.querySelectorAll('#histBody tr').length;
          return note.includes('daily snapshot') && rows === 4;
        }, null, { timeout: 30000 });

        const historyNote = (await page.locator('#histNote').innerText()).trim();
        const historyRows = await page.locator('#histBody tr').count();

        // 3. Attendre la fin des quatre comparaisons blockchain.
        await page.waitForFunction(() => {
          const rows = [...document.querySelectorAll('#cmpBody tr')];
          return rows.length === 4 &&
            rows.every(row => !row.innerText.includes('Loading…'));
        }, null, { timeout: 120000 });

        const comparison = await page.locator('#cmpBody tr').evaluateAll(rows =>
          rows.map(row => ({
            network: row.cells[0]?.innerText.trim() || '',
            result: row.innerText.trim(),
            failed: row.innerText.includes('Error:')
          }))
        );

        const comparisonSuccesses = comparison.filter(row => !row.failed).length;
        const comparisonFailures = comparison.filter(row => row.failed);

        if (comparisonSuccesses === 0) {
          throw new Error('Aucun réseau ne fournit de résultat dans la comparaison');
        }

        // 4. Les API de trading sont tierces : on observe leur état sans
        // transformer une indisponibilité externe en échec du moteur blockchain.
        await page.waitForFunction(() => {
          const rows = [...document.querySelectorAll('#tradeBody tr')];
          return rows.length === 4 &&
            rows.every(row => !row.innerText.includes('Loading…'));
        }, null, { timeout: 20000 }).catch(() => {});

        const trading = await page.locator('#tradeBody tr').evaluateAll(rows =>
          rows.map(row => ({
            network: row.cells[0]?.innerText.trim() || '',
            result: row.innerText.trim(),
            unavailable: row.innerText.includes('Unavailable (')
          }))
        );

        functionalChecks = {
          mainPool: {
            status,
            informationFields: await page.locator('#info > div').count(),
            calculationRows: outputRows
          },
          history: {
            rows: historyRows,
            note: historyNote
          },
          comparison: {
            totalNetworks: comparison.length,
            successes: comparisonSuccesses,
            failures: comparisonFailures
          },
          trading: {
            totalNetworks: trading.length,
            unavailable: trading.filter(row => row.unavailable),
            pending: trading.filter(row => row.result.includes('Loading…'))
          }
        };
      }
    }

    // Diagnostic RPC : ne classer comme récupérée qu'une erreur HTTP
    // explicitement suivie d'un fallback réussi sur un autre endpoint.
    const rpcDiagnostics = name === 'liquidity'
      ? await page.evaluate(() => window.GNUS_RPC_EVENTS || [])
      : [];

    const normalizeRpcUrl = value => {
      try {
        const url = new URL(value);
        if (url.pathname === '/') url.pathname = '';
        return url.href;
      } catch {
        return value;
      }
    };

    const recoveredCounts = new Map();

    for (const event of rpcDiagnostics) {
      if (event.event !== 'rpcFallback') continue;

      for (const failure of event.failedAttempts || []) {
        if (failure.status == null) continue;
        const key = JSON.stringify([normalizeRpcUrl(failure.url), failure.status]);
        recoveredCounts.set(key, (recoveredCounts.get(key) || 0) + 1);
      }
    }

    const recoveredRpcErrors = [];
    const unresolvedHttpErrors = [];

    for (const error of httpErrors) {
      const key = JSON.stringify([normalizeRpcUrl(error.url), error.status]);
      const remaining = recoveredCounts.get(key) || 0;

      if (remaining > 0) {
        recoveredRpcErrors.push({
          ...error,
          recoveredByFallback: true,
        });
        recoveredCounts.set(key, remaining - 1);
      } else {
        unresolvedHttpErrors.push(error);
      }
    }

    const screenshot = path.join(
      OUTPUT,
      `${name}-${mobile ? 'mobile' : 'desktop'}-${timestamp}.png`,
    );

    await page.screenshot({
      path: screenshot,
      fullPage: true,
    });

    addTest(`${name} / ${mobile ? 'mobile' : 'desktop'}`, 'PASS', {
      title,
      dimensions,
      screenshot,
      consoleErrors,
      pageErrors,
      localErrors,
      httpErrors: unresolvedHttpErrors,
      recoveredRpcErrors,
      rpcDiagnostics,
      ...(functionalChecks ? { functionalChecks } : {}),
    });
  }

  const pages = [
    ['index', `${BASE}/index.html`],
    ['archive', `${BASE}/archive.html`],
    ['liquidity', `${BASE}/liquidity.html`],
    ['holders', `${BASE}/holders.html`],
  ];

  for (const [name, url] of pages) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });

    try {
      await inspectPage(page, name, url, false);
    } catch (error) {
      fail(`${name} / desktop`, error);
    } finally {
      await page.close();
    }
  }

  for (const [name, url] of pages) {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      deviceScaleFactor: 1,
    });

    try {
      await inspectPage(page, name, url, true);
    } catch (error) {
      fail(`${name} / mobile`, error);
    } finally {
      await page.close();
    }
  }
} catch (error) {
  results.errors.push({
    name: 'Démarrage Playwright',
    error: String(error),
  });
} finally {
  if (browser) await browser.close();

  await new Promise(resolve => server.close(resolve));

  results.finishedAt = new Date().toISOString();
  results.summary = {
    passed: results.tests.filter(t => t.status === 'PASS').length,
    failed: results.tests.filter(t => t.status === 'FAIL').length,
    warnings: results.warnings.length,
    externalRequestsBlocked: results.externalRequests.length,
  };

  await fs.writeFile(REPORT, JSON.stringify(results, null, 2));

  console.log('\n======================================');
  console.log('GNUS DIGEST — RAPPORT PLAYWRIGHT');
  console.log('======================================');
  console.log(JSON.stringify(results.summary, null, 2));
  console.log(`Rapport : ${REPORT}`);
  console.log(`Captures : ${OUTPUT}`);

  if (results.errors.length) process.exitCode = 1;
}
