// api/cron/refresh.js
export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Octokit } from '@octokit/rest';

import { fetchHashReport } from '../../lib/bigquery.js';
import { fetchSylvaniaWeather } from '../../lib/weather.js';
import { fetchPowerCostMinMaxOrNull } from '../../lib/powercost.js';
import { createGithubWriter } from '../../lib/github-writer.js';

// Small utils
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

// Timezone aware helpers
const REPORT_TZ = process.env.REPORT_TZ || 'America/New_York';
function pad2(n){ return String(n).padStart(2,'0'); }
function partsInTz(dt, tz = REPORT_TZ) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const obj = Object.fromEntries(fmt.formatToParts(dt).map(({ type, value }) => [type, value]));
  return {
    year: obj.year, month: obj.month, day: obj.day,
    hour: pad2(obj.hour), minute: obj.minute,
    dayPeriod: (obj.dayPeriod || '').toUpperCase() || (parseInt(obj.hour,10) < 12 ? 'AM' : 'PM'),
    weekdayShort: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(dt), // Sun..Sat
  };
}
function formatDirName(dt) { const p = partsInTz(dt); return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.dayPeriod}`; }
function humanLabel(dt) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TZ, weekday:'long', month:'long', day:'numeric',
    year:'numeric', hour:'numeric', minute:'2-digit',
  }).format(dt);
}
function clean(p) { return p.replace(/^\/+/, '').replace(/\/+/g, '/'); }

// ---- Local schedule gate (DST-safe via Intl + America/New_York) ----
// Mon–Thu: 06:00, 16:00, 23:59   |   Fri–Sun: 06:00, 18:00
function shouldRunNowNY(now = new Date()) {
  const p = partsInTz(now);
  const minute = parseInt(p.minute, 10);   // 00..59
  const h12 = parseInt(p.hour, 10);        // 01..12
  const isPM = p.dayPeriod === 'PM';
  const hour24 = (h12 === 12 ? 0 : h12) + (isPM ? 12 : 0); // 0..23
  const dow = p.weekdayShort;              // Sun..Sat

  const isMonThu = dow === 'Mon' || dow === 'Tue' || dow === 'Wed' || dow === 'Thu';
  const isFriSun = dow === 'Fri' || dow === 'Sat' || dow === 'Sun';

  // Mon–Thu end-of-day run (11:59 PM local)
  if (isMonThu && hour24 === 23 && minute === 59) return true;

  // Top-of-hour runs
  if (minute === 0) {
    if (isMonThu && (hour24 === 6 || hour24 === 16)) return true; // 6 AM, 4 PM
    if (isFriSun && (hour24 === 6 || hour24 === 18)) return true; // 6 AM, 6 PM
  }

  return false;
}

// GitHub helpers (read + write via API)
const gh = createGithubWriter();
const owner   = process.env.GITHUB_OWNER;
const repo    = process.env.GITHUB_REPO;
const branch  = process.env.GITHUB_BRANCH || 'main';
const basedir = (process.env.CMS_GITHUB_BASEDIR || 'public/').replace(/^\//, '');
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

async function ghReadJson(publicPath, fallback) {
  const repoPath = clean(basedir + publicPath.replace(/^public\//, ''));
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: repoPath, ref: branch });
    if (Array.isArray(data)) return fallback;
    const buff = Buffer.from(data.content || '', data.encoding || 'base64');
    return JSON.parse(buff.toString('utf8'));
  } catch (e) {
    if (e?.status === 404) return fallback; // expected for first write
    throw e;
  }
}

// Write to GitHub repo 
async function writeLatestRedirect() {
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
  await gh.writeText('public/reports/latest/index.html', html, 'Update latest redirect');
}

async function writeReportPage({ dirName, report }) {
  await gh.writeJson(`public/reports/${dirName}/hash-report.json`, report, `Add reports/${dirName}/hash-report.json`);

  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  let html = await fs.readFile(indexPath, 'utf8');

  html = html.replace(
    /<script\s+type="module"\s+src="\.?\/app\.js"><\/script>/i,
    '<script type="module" src="/app.js"></script>'
  );
  const inject = `
  <script>
    window.__REPORT_FETCH_BASE__ = location.pathname.replace(/[^/]+$/, '');
    window.REPORT_TZ = '${REPORT_TZ}';
  </script>`;
  html = html.replace(/<\/body>\s*<\/html>\s*$/i, `${inject}\n</body></html>`);

  const title = `Hash Report — ${humanLabel(new Date(report.generatedAt || Date.now()))}`;
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);

  await gh.writeText(`public/reports/${dirName}/index.html`, html, `Add reports/${dirName}/index.html`);
}

async function writeManifest({ entry }) {
  const manifestPath = 'public/reports/index.json';
  const existing = await ghReadJson(manifestPath, { reports: [] });
  const filtered = (existing.reports || []).filter(r => r.path !== entry.path);
  const next = { reports: [entry, ...filtered].slice(0, 500) };
  await gh.writeJson(manifestPath, next, 'Update reports index');
  return next;
}

// Handler
export default async function handler(req, res) {
  try {
    // Allow manual override: /api/cron/refresh?force=1
    const url = new URL(req.url, `https://${req.headers.host || 'example.org'}`);
    const force = url.searchParams.has('force');

    if (!force && !shouldRunNowNY()) {
      res.status(204).send('Skipped (outside local schedule)');
      return;
    }

    const [report, weather, power] = await Promise.all([
      fetchHashReport({ hours: 24 }),
      (async () => { try { return await fetchSylvaniaWeather(); } catch { return null; } })(),
      fetchPowerCostMinMaxOrNull().catch(() => null),
    ]);

    if (weather?.sylvania) report.weather = { sylvania: weather.sylvania };

    if (power) {
      report.powerCost = {
        min_cents_kwh: power.min_cents_kwh,
        max_cents_kwh: power.max_cents_kwh,
        fetchedAt: power.fetchedAt,
        source: power.source,
      };
    }

    // Latest single-file
    await gh.writeJson('public/hash-report.json', report, 'Update public/hash-report.json');

    // Versioned snapshot (Time Zone aware)
    const gen = new Date(report.generatedAt || Date.now());
    const dirName = formatDirName(gen);
    await writeReportPage({ dirName, report });

    const entry = {
      path: `/reports/${dirName}/`,
      label: humanLabel(gen),
      generatedAt: gen.toISOString(),
      snapshotTs: report.currentSnapshotTs ?? null,
    };
    const manifest = await writeManifest({ entry });
    await writeLatestRedirect();

    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.status(200).json({ ok: true, snapshotPath: entry.path, manifestCount: manifest.reports.length, forced: !!force });
  } catch (e) {
    console.error('[refresh] fatal:', e);
    res.status(500).json({ ok: false, error: e?.message || 'Unknown error' });
  }
}
