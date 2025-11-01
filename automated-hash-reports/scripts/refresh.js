// scripts/refresh.js
import 'dotenv/config';
import * as dotenv from 'dotenv';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { fetchHashReport } from '../lib/bigquery.js';
import { fetchSylvaniaWeather } from '../lib/weather.js';
import { fetchPowerCostMinMaxOrNull } from '../lib/powercost.js';
import { createGithubWriter } from '../lib/github-writer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load envs from repo root
try {
  const rootEnv      = path.join(__dirname, '..', '.env');
  const rootEnvLocal = path.join(__dirname, '..', '.env.local');
  await dotenv.config({ path: rootEnv });
  await dotenv.config({ path: rootEnvLocal, override: true });
} catch (e) {
  console.warn('[dotenv] manual load failed:', e?.message || e);
}

// Probe
(function probeEnv() {
  const names = ['MEAGPOWER_USER', 'MEAGPOWER_PASS'];
  const seen = Object.fromEntries(
    names.filter(n => Object.prototype.hasOwnProperty.call(process.env, n))
         .map(n => [n, process.env[n] ? '(set)' : '(empty string)'])
  );
  console.log('[powercost env probe]', seen);
})();

// Helpers
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Optional GitHub writer (enabled if envs are present)
let gh = null;
(function initGithubWriter() {
  const hasGH =
    !!process.env.GITHUB_TOKEN &&
    !!process.env.GITHUB_OWNER &&
    !!process.env.GITHUB_REPO;
  if (!hasGH) {
    console.log('[github-writer] disabled (missing envs)');
    return;
  }
  try {
    gh = createGithubWriter();
    console.log(
      `[github-writer] enabled → ${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}` +
      (process.env.GITHUB_BRANCH ? `#${process.env.GITHUB_BRANCH}` : '#main')
    );
  } catch (e) {
    console.warn('[github-writer] failed to init:', e?.message || e);
    gh = null;
  }
})();

// Timezone aware helpers
const REPORT_TZ = process.env.REPORT_TZ || 'America/New_York';

function pad2(n){ return String(n).padStart(2,'0'); }

function partsInTz(dt, tz = REPORT_TZ) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const obj = Object.fromEntries(fmt.formatToParts(dt).map(({ type, value }) => [type, value]));
  return {
    year: obj.year,
    month: obj.month,
    day: obj.day,
    hour: pad2(obj.hour),
    minute: obj.minute,
    dayPeriod: (obj.dayPeriod || '').toUpperCase() || (parseInt(obj.hour,10) < 12 ? 'AM' : 'PM'),
  };
}

function formatDirName(dt) {
  const p = partsInTz(dt);
  return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.dayPeriod}`;
}

function humanLabel(dt) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TZ,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(dt);
}

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }

function toPublicRel(localPath) {
  // Convert an absolute local path to a forward-slash relative path
  const rel = path.relative(process.cwd(), localPath).replace(/\\/g, '/');
  return rel.startsWith('/') ? rel.slice(1) : rel;
}

// Dual-write helpers: local + GitHub
async function writeJsonBoth(localPath, obj, message) {
  await ensureDir(path.dirname(localPath));
  const str = JSON.stringify(obj, null, 2);
  await fs.writeFile(localPath, str, 'utf8');

  if (gh) {
    const publicRel = toPublicRel(localPath);
    await gh.writeJson(publicRel, obj, message);
  }
}

async function writeTextBoth(localPath, text, message) {
  await ensureDir(path.dirname(localPath));
  await fs.writeFile(localPath, text, 'utf8');

  if (gh) {
    const publicRel = toPublicRel(localPath);
    await gh.writeText(publicRel, text, message);
  }
}

async function readManifest(manifestPath) {
  try {
    const txt = await fs.readFile(manifestPath, 'utf8');
    return JSON.parse(txt);
  } catch {
    return { reports: [] };
  }
}

async function writeManifest({ entry }) {
  const manifestPath = path.join(PUBLIC_DIR, 'reports', 'index.json');
  await ensureDir(path.dirname(manifestPath));
  const existing = await readManifest(manifestPath);

  const filtered = (existing.reports || []).filter(r => r.path !== entry.path);
  const next = { reports: [entry, ...filtered].slice(0, 500) };

  await writeJsonBoth(manifestPath, next, 'Update reports index');
  return next;
}

async function writeLatestRedirect() {
  const folder = path.join(PUBLIC_DIR, 'reports', 'latest');
  await ensureDir(folder);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Latest Hash Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<script>
(async function(){
  try{
    const r = await fetch('/reports/index.json', {cache:'no-cache'});
    const m = await r.json();
    const first = m?.reports?.[0]?.path;
    if(first){ location.replace(first); }
    else { document.body.innerHTML = '<p>No reports yet.</p>'; }
  }catch(e){
    document.body.innerHTML = '<p>Unable to load latest report.</p>';
  }
})();
</script>
</head><body></body></html>`;
  await writeTextBoth(path.join(folder, 'index.html'), html, 'Update latest redirect');
}

/**
 * Clone existing public/index.html into the snapshot folder and
 * inject a small script that sets __REPORT_FETCH_BASE__ so app.js loads
 * ./hash-report.json from the snapshot folder.
 */
async function writeReportPage({ dirName, report }) {
  const folder = path.join(PUBLIC_DIR, 'reports', dirName);
  await ensureDir(folder);

  // 1) write the snapshot data
  await writeJsonBoth(
    path.join(folder, 'hash-report.json'),
    report,
    `Add ${dirName}/hash-report.json`
  );

  // 2) clone index.html and inject base hint
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  let html = await fs.readFile(indexPath, 'utf8');

  // Ensure app.js loads from root
  html = html.replace(
    /<script\s+type="module"\s+src="\.?\/app\.js"><\/script>/i,
    '<script type="module" src="/app.js"></script>'
  );

  // Inject base before </body>
  const inject = `
  <script>
    // Tell app.js to fetch the report JSON from this folder
    window.__REPORT_FETCH_BASE__ = location.pathname.replace(/[^/]+$/, '');
    // Optional: fix header time zone in the browser too
    window.REPORT_TZ = '${REPORT_TZ}';
  </script>
  `;
  html = html.replace(/<\/body>\s*<\/html>\s*$/i, `${inject}\n</body></html>`);

  // Set a specific title with the TZ-aware label
  const title = `Hash Report — ${humanLabel(new Date(report.generatedAt || Date.now()))}`;
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);

  await writeTextBoth(
    path.join(folder, 'index.html'),
    html,
    `Add ${dirName}/index.html`
  );
}

// Main
async function main() {
  const [report, weather, power] = await Promise.all([
    fetchHashReport({ hours: 24 }),
    (async () => { try { return await fetchSylvaniaWeather(); } catch { return null; } })(),
    fetchPowerCostMinMaxOrNull()
  ]);

  if (weather?.sylvania) report.weather = { sylvania: weather.sylvania };

  if (power) {
    report.powerCost = {
      min_cents_kwh: power.min_cents_kwh,
      max_cents_kwh: power.max_cents_kwh,
      fetchedAt: power.fetchedAt,
      source: power.source
    };
  }

  // Keep single-file latest for backward-compat
  await writeJsonBoth(
    path.join(PUBLIC_DIR, 'hash-report.json'),
    report,
    'Update public/hash-report.json'
  );

  // Versioned snapshot (Time Zone aware)
  const gen = new Date(report.generatedAt || Date.now());
  const dirName = formatDirName(gen);
  await writeReportPage({ dirName, report });

  const entry = {
    path: `/reports/${dirName}/`,
    label: humanLabel(gen),
    generatedAt: gen.toISOString(),
    snapshotTs: report.currentSnapshotTs ?? null
  };
  const manifest = await writeManifest({ entry });

  await writeLatestRedirect();

  console.log(`Wrote public/hash-report.json`);
  console.log(`Snapshot: ${report.currentSnapshotTs} | Generated: ${report.generatedAt}`);
  console.log(`Overall (PH/s) current=${report.overall?.current_phs?.toFixed(2)} avg24=${report.overall?.avg24_phs?.toFixed(2)}`);
  if (power) {
    console.log(`Power (¢/kWh) min=${power.min_cents_kwh.toFixed(3)} max=${power.max_cents_kwh.toFixed(3)}`);
  } else {
    console.log('Power cost: (unavailable — check env and login)');
  }
  console.log(`New report page: ${entry.path}`);
  console.log(`Manifest contains ${manifest.reports.length} entries`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
