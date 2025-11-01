#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');

// Simple arg helpers
function arg(name, def) {
  const i = process.argv.findIndex(a => a === `--${name}`);
  return i >= 0 ? (process.argv[i + 1] || '') : def;
}
const DRY_RUN = process.argv.includes('--dry-run');
const INCLUDE_LATEST = process.argv.includes('--include-latest');

const REPORTS_DIR   = path.resolve(ROOT, arg('reports-dir', 'public/reports'));
const TEMPLATE_PATH = path.resolve(ROOT, arg('template',    'public/index.html'));

const FETCH_BASE_SNIPPET = `
<script>
  // Ensure report pages fetch their own hash-report.json from this folder
  window.__REPORT_FETCH_BASE__ = location.pathname.replace(/[^/]+$/, '');
  window.REPORT_TZ = 'America/New_York';
</script>`.trim();

// Helpers
async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

function extractTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1] : null;
}

function setTitle(html, titleText) {
  if (!titleText) return html;
  if (/<title>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${titleText}</title>`);
  }
  // If template lacks a <title>, inject in <head>
  return html.replace(/<head([^>]*)>/i, `<head$1>\n    <title>${titleText}</title>`);
}

function ensureFetchBaseSnippet(html) {
  if (html.includes('__REPORT_FETCH_BASE__')) return html; // already present
  // insert just before </body>
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${FETCH_BASE_SNIPPET}\n</body>`);
  }
  // Fallback: append
  return html + '\n' + FETCH_BASE_SNIPPET + '\n';
}

function normalizeWhitespace(html) {
  // Optional, keep diffs smaller by trimming trailing spaces
  return html.replace(/[ \t]+(\r?\n)/g, '$1');
}

async function processReportIndex(indexPath, templateHtml) {
  // Skip any ".../latest/index.html" unless explicitly requested
  const rel = path.relative(ROOT, indexPath);
  const segments = rel.split(path.sep).map(s => s.toLowerCase());
  if (!INCLUDE_LATEST && segments.includes('latest')) {
    return { skipped: true, reason: 'latest' };
  }

  const original = await fs.readFile(indexPath, 'utf8');
  const originalTitle = extractTitle(original);

  let out = templateHtml;
  out = setTitle(out, originalTitle);          // keep each report's title
  out = ensureFetchBaseSnippet(out);
  out = normalizeWhitespace(out);

  if (DRY_RUN) {
    return { dryRun: true, changed: out !== original };
  }

  // Backup
  const bakPath = indexPath + '.bak';
  await fs.writeFile(bakPath, original, 'utf8');

  // Write new
  await fs.writeFile(indexPath, out, 'utf8');

  return { updated: true, backup: bakPath };
}

async function main() {
  if (!(await exists(TEMPLATE_PATH))) {
    console.error(`Template not found: ${TEMPLATE_PATH}`);
    process.exit(1);
  }
  if (!(await exists(REPORTS_DIR))) {
    console.error(`Reports dir not found: ${REPORTS_DIR}`);
    process.exit(1);
  }

  const templateHtml = await fs.readFile(TEMPLATE_PATH, 'utf8');

  const targets = [];
  for await (const file of walk(REPORTS_DIR)) {
    if (file.endsWith(`${path.sep}index.html`)) targets.push(file);
  }

  if (targets.length === 0) {
    console.log('No /reports/**/index.html files found.');
    return;
  }

  let updated = 0, skipped = 0, unchanged = 0;
  for (const idx of targets) {
    const rel = path.relative(ROOT, idx);
    try {
      const res = await processReportIndex(idx, templateHtml);
      if (res.skipped) {
        skipped++;
        console.log(`SKIP  ${rel}  (${res.reason})`);
      } else if (res.dryRun) {
        if (res.changed) {
          console.log(`DRY   ${rel}  (would update)`);
        } else {
          unchanged++;
          console.log(`DRY   ${rel}  (no change)`);
        }
      } else {
        updated++;
        console.log(`OK    ${rel}  (backup: ${path.basename(res.backup)})`);
      }
    } catch (e) {
      console.error(`FAIL  ${rel}: ${e.message}`);
    }
  }

  if (DRY_RUN) {
    console.log(`\nDry run complete. Would update: ${targets.length - skipped - unchanged}, unchanged: ${unchanged}, skipped: ${skipped}`);
  } else {
    console.log(`\nDone. Updated: ${updated}, skipped: ${skipped}`);
    console.log('Backups saved next to each file as index.html.bak');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
