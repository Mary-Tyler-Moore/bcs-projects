#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Simple arg helpers
function arg(name, def) {
  const i = process.argv.findIndex(a => a === `--${name}`);
  return i >= 0 ? (process.argv[i + 1] || '') : def;
}
const DRY_RUN = process.argv.includes('--dry-run');
const INCLUDE_LATEST = process.argv.includes('--include-latest');

const REPORTS_DIR = path.resolve(ROOT, arg('reports-dir', 'public/reports'));
const SOURCE_PATH = path.resolve(ROOT, arg('source', 'public/hash-report.json'));

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

function isNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function overlayNumericValues(target, source) {
  // Recursively copy numeric values from source into target at the same paths.
  if (isNumber(source)) {
    return source; // Replace with numeric from source
  }
  if (Array.isArray(source) && Array.isArray(target)) {
    const out = target.slice();
    const len = Math.min(target.length, source.length);
    for (let i = 0; i < len; i++) {
      out[i] = overlayNumericValues(target[i], source[i]);
    }
    return out;
  }
  if (source && typeof source === 'object' && target && typeof target === 'object') {
    const out = { ...target };
    for (const k of Object.keys(source)) {
      if (k in target) {
        out[k] = overlayNumericValues(target[k], source[k]);
      }
    }
    return out;
  }
  // Fallback: if source isn't numeric keep target as-is.
  return target;
}

async function processReportJson(targetPath, sourceJson) {
  const original = await fs.readFile(targetPath, 'utf8');
  let targetJson;
  try {
    targetJson = JSON.parse(original);
  } catch (e) {
    throw new Error(`invalid JSON: ${e.message}`);
  }

  const updated = overlayNumericValues(targetJson, sourceJson);
  const outStr = JSON.stringify(updated, null, 2) + '\n';

  if (DRY_RUN) {
    return { dryRun: true, changed: outStr !== original };
  }

  await fs.writeFile(targetPath, outStr, 'utf8');
  return { updated: true };
}

async function main() {
  if (!(await exists(SOURCE_PATH))) {
    console.error(`Source JSON not found: ${SOURCE_PATH}`);
    process.exit(1);
  }
  if (!(await exists(REPORTS_DIR))) {
    console.error(`Reports dir not found: ${REPORTS_DIR}`);
    process.exit(1);
  }

  // Load source (main) JSON
  let sourceJson;
  try {
    const src = await fs.readFile(SOURCE_PATH, 'utf8');
    sourceJson = JSON.parse(src);
  } catch (e) {
    console.error(`Failed to read/parse source JSON: ${e.message}`);
    process.exit(1);
  }

  // Gather target hash-report.json files
  const targets = [];
  for await (const file of walk(REPORTS_DIR)) {
    if (file.endsWith(`${path.sep}hash-report.json`)) {
      const relParts = path.relative(ROOT, file).split(path.sep).map(s => s.toLowerCase());
      if (!INCLUDE_LATEST && relParts.includes('latest')) continue;
      targets.push(file);
    }
  }

  if (targets.length === 0) {
    console.log('No /reports/**/hash-report.json files found.');
    return;
  }

  let updated = 0, unchanged = 0;
  for (const t of targets) {
    const rel = path.relative(ROOT, t);
    try {
      const res = await processReportJson(t, sourceJson);
      if (res.dryRun) {
        if (res.changed) {
          console.log(`DRY   ${rel}  (would update)`);
        } else {
          unchanged++;
          console.log(`DRY   ${rel}  (no change)`);
        }
      } else {
        updated++;
        console.log(`OK    ${rel}`);
      }
    } catch (e) {
      console.error(`FAIL  ${rel}: ${e.message}`);
    }
  }

  if (DRY_RUN) {
    console.log(`\nDry run complete. Would update: ${targets.length - unchanged}, unchanged: ${unchanged}`);
  } else {
    console.log(`\nDone. Updated: ${updated}`);
    console.log('No backups created.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });

