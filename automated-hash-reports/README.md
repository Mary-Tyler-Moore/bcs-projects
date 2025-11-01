# Automated Hash Reports 

A Node.js app that generates time-stamped hash rate reports and publishes them as versioned static pages. It runs on Vercel and persists generated assets to GitHub (so they are durable across deployments). This README explains the scheduling, Daylight Savings Time handling, programmatic page creation, Vercel filesystem constraints, and the backfill utilities I used to prepare this repo for public review.

## Overview
- Fetches data from Foreman BigQuery and enriches with optional weather and power-cost data.
- Writes the latest JSON to `public/hash-report.json` and also snapshots each run into a unique folder under `public/reports/<timestamp>/` with an HTML page and JSON.
- Maintains a manifest at `public/reports/index.json` and a redirect page at `public/reports/latest/` that always points to the newest snapshot.
- On Vercel, uses the GitHub API to write files back into the repo because the runtime filesystem is ephemeral.

**Key entry points**
- API cron handler: `api/cron/refresh.js`
- GitHub writer: `lib/github-writer.js`
- Data sources: `lib/bigquery.js`, `lib/weather.js`, `lib/powercost.js`
- Local script version of the refresh flow: `scripts/refresh.js`
- Backfill utilities: `scripts/backfill-reports-index.js`, `scripts/backfill-reports-json.js`

## Cron Scheduling on Vercel (with EDT/EST handling)
Vercel cron schedules are configured in `vercel.json` and run in UTC. To guarantee the job runs at the intended local Eastern Time (America/New_York) across Daylight Saving Time changes, the app uses two techniques:

1) Duplicate UTC schedules around the DST boundary hours so at least one invocation aligns with the desired local time.
2) A local, timezone-aware gate in `api/cron/refresh.js` that checks whether “now” in New York matches an allowed run window (so extra cron invocations simply no-op).

Example from `vercel.json`:

```
{
  "crons": [
    { "path": "/api/cron/refresh", "schedule": "0 10 * * 1-4" },
    { "path": "/api/cron/refresh", "schedule": "0 11 * * 1-4" },

    { "path": "/api/cron/refresh", "schedule": "0 20 * * 1-4" },
    { "path": "/api/cron/refresh", "schedule": "0 21 * * 1-4" },

    { "path": "/api/cron/refresh", "schedule": "59 3 * * 2-5" },
    { "path": "/api/cron/refresh", "schedule": "59 4 * * 2-5" },

    { "path": "/api/cron/refresh", "schedule": "0 10 * * 5,6,0" },
    { "path": "/api/cron/refresh", "schedule": "0 11 * * 5,6,0" },

    { "path": "/api/cron/refresh", "schedule": "0 22 * * 5,6,0" },
    { "path": "/api/cron/refresh", "schedule": "0 23 * * 5,6,0" }
  ],
  "routes": [
    { "src": "^/$", "dest": "/index.html" }
  ]
}
```

How this maps to local time:
- Multiple adjacent UTC hours are scheduled (e.g., 10 and 11) to cover both EDT and EST offsets.
- The handler’s local-time guard runs only at allowed local times and returns `204 Skipped` otherwise.

In `api/cron/refresh.js`, the EDT/EST detection uses `Intl.DateTimeFormat` with `America/New_York` to compute local hour/minute reliably across DST without manually dealing with offsets:

```js
// Convert Date -> local NY parts using Intl
const REPORT_TZ = process.env.REPORT_TZ || 'America/New_York';
function partsInTz(dt, tz = REPORT_TZ) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const obj = Object.fromEntries(fmt.formatToParts(dt).map(({ type, value }) => [type, value]));
  return {
    hour: String(obj.hour).padStart(2, '0'),
    minute: obj.minute,
    dayPeriod: (obj.dayPeriod || '').toUpperCase() || (parseInt(obj.hour,10) < 12 ? 'AM' : 'PM'),
    weekdayShort: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(dt),
  };
}

// DST-safe local schedule gate (America/New_York)
function shouldRunNowNY(now = new Date()) {
  const p = partsInTz(now);
  const minute = parseInt(p.minute, 10);
  const h12 = parseInt(p.hour, 10);
  const isPM = p.dayPeriod === 'PM';
  const hour24 = (h12 === 12 ? 0 : h12) + (isPM ? 12 : 0);
  const dow = p.weekdayShort; // Sun..Sat

  const isMonThu = ['Mon','Tue','Wed','Thu'].includes(dow);
  const isFriSun = ['Fri','Sat','Sun'].includes(dow);

  if (isMonThu && hour24 === 23 && minute === 59) return true; // 11:59 PM
  if (minute === 0) {
    if (isMonThu && (hour24 === 6 || hour24 === 16)) return true; // 6 AM, 4 PM
    if (isFriSun && (hour24 === 6 || hour24 === 18)) return true; // 6 AM, 6 PM
  }
  return false;
}
```

You can force a run regardless of the gate via `GET /api/cron/refresh?force=1`.

## Programmatic Page Generation and Folder Naming
Each run creates a time-stamped folder under `public/reports/` and writes both the JSON payload and a self-contained HTML page that references it. The folder name embeds the local time (America/New_York) so the snapshots are human-readable:

```
YYYY-MM-DD_HH-mm-AM|PM
// e.g. 2025-10-31_06-00-AM
```

From `api/cron/refresh.js` and `scripts/refresh.js`:

```js
function formatDirName(dt) {
  const p = partsInTz(dt); // uses America/New_York by default
  return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.dayPeriod}`;
}

// Writes JSON and an index.html cloned from public/index.html
// and injects a small snippet so the page fetches ./hash-report.json
async function writeReportPage({ dirName, report }) {
  // JSON
  await gh.writeJson(`public/reports/${dirName}/hash-report.json`, report, `Add reports/${dirName}/hash-report.json`);

  // HTML (clone + inject fetch base + set title)
  let html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  html = html.replace(/<script\s+type="module"\s+src="\.?\/app\.js"><\/script>/i,
                      '<script type="module" src="/app.js"></script>');
  const inject = `\n  <script>\n    window.__REPORT_FETCH_BASE__ = location.pathname.replace(/[^/]+$/, '');\n    window.REPORT_TZ = '${REPORT_TZ}';\n  </script>`;
  html = html.replace(/<\/body>\s*<\/html>\s*$/i, `${inject}\n</body></html>`);
  const title = `Hash Report — ${humanLabel(new Date(report.generatedAt || Date.now()))}`;
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);
  await gh.writeText(`public/reports/${dirName}/index.html`, html, `Add reports/${dirName}/index.html`);
}
```

A manifest is maintained at `public/reports/index.json`, with newest first, and a redirect page `public/reports/latest/` points browsers to the most recent snapshot.

## Why `github-writer.js` on Vercel
On Vercel, the runtime filesystem is read-only and ephemeral. Writing files to `public/` at runtime does not persist across requests or deployments. To persist generated assets, this project writes directly to the GitHub repository using the GitHub API.

`lib/github-writer.js` provides a minimal helper built on Octokit that creates or updates files in the repo. It accepts repo info from environment variables and transparently handles “create vs update” by checking for an existing blob `sha`.

```js
// lib/github-writer.js
export function createGithubWriter() {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  async function put(path, content, message) {
    // normalize to repo path (mirrors public/*)
    const repoPath = clean((process.env.CMS_GITHUB_BASEDIR || 'public/') + path.replace(/^public\//, ''));
    let sha;
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path: repoPath, ref: branch });
      if (!Array.isArray(data) && data?.sha) sha = data.sha;
    } catch (e) {
      if (e?.status !== 404) throw e;
    }
    await octokit.repos.createOrUpdateFileContents({ owner, repo, branch, path: repoPath, message, content: base64(content), sha });
  }
  return { writeJson: (p, o, m) => put(p, JSON.stringify(o, null, 2), m), writeText: (p, s, m) => put(p, s, m) };
}
```

This approach lets the cron handler “publish” static pages and JSON to the repo, which then serve as durable assets from the deployed site.

## How `refresh.js` Works (API and Script)

- API version: `api/cron/refresh.js`
  - Optional `?force=1` query param to bypass the local-time guard.
  - Fetches report data: `fetchHashReport`, plus best-effort `weather` and `power cost`.
  - Writes latest JSON to `public/hash-report.json` via GitHub.
  - Creates a versioned snapshot directory (TZ-aware), writes `hash-report.json` and a cloned `index.html` with the base-fetch hint.
  - Updates `public/reports/index.json` and `public/reports/latest/index.html`.
  - Responds with JSON including the snapshot path.

- Local script version: `scripts/refresh.js`
  - Same flow as the API, but supports dual-write: writes to the local filesystem and, if env vars are present, also commits the same files to GitHub.
  - Useful for local testing and manual runs outside of Vercel.

## Backfill Scripts (and preparing public data)
To prepare this repository for public sharing, I ran two backfill utilities to normalize existing snapshot content and remove private details by copying safe public values over sensitive fields.

- `scripts/backfill-reports-index.js`
  - Iterates all `public/reports/**/index.html` pages (skips `latest/` by default).
  - Rebuilds each page from the current `public/index.html` template, preserving the snapshot’s original `<title>` and injecting the `__REPORT_FETCH_BASE__` hint so the page fetches its sibling `hash-report.json`.
  - Flags: `--dry-run` to preview changes, `--include-latest` to include the `latest/` folder.

- `scripts/backfill-reports-json.js`
  - Iterates all `public/reports/**/hash-report.json` files (skips `latest/` by default).
  - Loads a designated source JSON (default `public/hash-report.json`) that contains the “public-safe” values.
  - Recursively overlays numeric values from the source into each snapshot at matching paths. By preparing the source file with zeros or non-sensitive numbers for private fields, this effectively scrubs previously published snapshots by replacing their numeric values with the public-safe numbers.
  - Flags: `--dry-run`, `--include-latest`, `--source <path>`, `--reports-dir <dir>`.

Example usage:
```
node scripts/backfill-reports-index.js --dry-run
node scripts/backfill-reports-index.js

node scripts/backfill-reports-json.js --source public/hash-report.json --dry-run
node scripts/backfill-reports-json.js --source public/hash-report.json
```

## Environment
Set the following in your `.env` or Vercel project settings:
- Reporting TZ: `REPORT_TZ=America/New_York`
- BigQuery service account JSON: `FOREMAN_SA_JSON=<json>`
- Optional customer hint: `CUSTOMER_NAME=<name>`
- GitHub publish (required on Vercel): `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, [`GITHUB_BRANCH`], [`CMS_GITHUB_BASEDIR`]
- Optional power cost scrape: `MEAGPOWER_USER`, `MEAGPOWER_PASS`

## Local Development
- Run a local refresh: `node scripts/refresh.js`
- Inspect generated pages under `public/reports/` and confirm `public/reports/latest/` redirects appropriately.
- Use backfill scripts to keep historical pages consistent with the latest template and to scrub sensitive numbers.

## Notes
- Time calculations are DST-safe by relying on `Intl.DateTimeFormat` with `America/New_York`; no manual offset math.
- Vercel cron entries intentionally “over-schedule” around DST and rely on a local-time guard in the handler to avoid double processing.
- Publishing via GitHub API ensures generated artifacts persist despite Vercel’s ephemeral filesystem.
