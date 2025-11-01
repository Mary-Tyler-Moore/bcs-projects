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

function stripBom(s) {
  if (!s) return s;
  // Strip leading UTF-8 BOM if present
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

async function formatJsonFile(p) {
  const originalRaw = await fs.readFile(p, 'utf8');
  const original = stripBom(originalRaw);
  let obj;
  try {
    obj = JSON.parse(original);
  } catch (e) {
    throw new Error(`invalid JSON: ${e.message}`);
  }
  const out = JSON.stringify(obj, null, 2) + '\n';
  if (DRY_RUN) {
    return { changed: out !== originalRaw };
  }
  await fs.writeFile(p, out, 'utf8');
  return { updated: true };
}

async function main() {
  if (!(await exists(REPORTS_DIR))) {
    console.error(`Reports dir not found: ${REPORTS_DIR}`);
    process.exit(1);
  }

  const targets = [];
  for await (const f of walk(REPORTS_DIR)) {
    if (f.endsWith(`${path.sep}hash-report.json`)) {
      const relParts = path.relative(ROOT, f).split(path.sep).map(s => s.toLowerCase());
      if (!INCLUDE_LATEST && relParts.includes('latest')) continue;
      targets.push(f);
    }
  }

  if (targets.length === 0) {
    console.log('No /reports/**/hash-report.json files found.');
    return;
  }

  let updated = 0, unchanged = 0, failed = 0;
  for (const t of targets) {
    const rel = path.relative(ROOT, t);
    try {
      const res = await formatJsonFile(t);
      if (DRY_RUN) {
        if (res.changed) {
          console.log(`DRY   ${rel}  (would reformat)`);
        } else {
          unchanged++;
          console.log(`DRY   ${rel}  (already formatted)`);
        }
      } else {
        updated++;
        console.log(`OK    ${rel}`);
      }
    } catch (e) {
      failed++;
      console.error(`FAIL  ${rel}: ${e.message}`);
    }
  }

  if (DRY_RUN) {
    console.log(`\nDry run complete. Would update: ${targets.length - unchanged}, unchanged: ${unchanged}`);
  } else {
    console.log(`\nDone. Updated: ${updated}, failed: ${failed}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

