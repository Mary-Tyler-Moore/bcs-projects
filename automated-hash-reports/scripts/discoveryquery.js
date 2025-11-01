#!/usr/bin/env node
import 'dotenv/config';
import { BigQuery } from '@google-cloud/bigquery';
import { promises as fs } from 'fs';
import path from 'path';

// CLI args & options
const args = process.argv.slice(2);
const wantAll = args.includes('--all');
const wantA = args.includes('--a') || wantAll; // Clients
const wantB = args.includes('--b') || wantAll; // Pool domains
const wantC = args.includes('--c') || wantAll; // Manufacturers
const wantD = args.includes('--d') || wantAll; // Needle search
const wantE = args.includes('--e') || wantAll; // Groups
const wantF = args.includes('--f') || wantAll; // Sylvania split (current + 24h)
const wantG = args.includes('--g') || wantAll; // Sylvania-Bitmain split (current + 24h)

const needlesArg = (args.find(a => a.startsWith('--needles=')) || '').split('=')[1];
const needles = (needlesArg ? needlesArg.split(',') : ['antpool','blockware','bitmain','kjdga'])
  .map(s => s.trim()).filter(Boolean);

const formatArg = (args.find(a => a.startsWith('--format=')) || '').split('=')[1]; // csv|json
const format = formatArg && ['csv','json'].includes(formatArg.toLowerCase())
  ? formatArg.toLowerCase() : null;

const outDirArg = (args.find(a => a.startsWith('--out-dir=')) || '').split('=')[1];
const outDir = outDirArg || 'out';

function getIntFlag(name, def) {
  const raw = (args.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1];
  const num = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(num) ? num : def;
}
const hoursFlag = getIntFlag('hours', NaN);
const daysFlag = getIntFlag('days', NaN);

// Priority: --hours, then --days, else default 7 days
const timeWindow = Number.isFinite(hoursFlag)
  ? { unit: 'HOUR', value: hoursFlag }
  : Number.isFinite(daysFlag)
    ? { unit: 'DAY', value: daysFlag }
    : { unit: 'DAY', value: 7 };

function timeFilter(alias = '') {
  const a = alias ? alias.trim() + '.' : '';
  return `${a}timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${timeWindow.value} ${timeWindow.unit})`;
}

// Setup helpers
function getClient() {
  const raw = process.env.FOREMAN_SA_JSON;
  if (!raw) throw new Error('FOREMAN_SA_JSON env var not set');
  const credentials = JSON.parse(raw);
  return new BigQuery({ credentials, projectId: credentials.project_id });
}

async function resolveCustomerName(bq) {
  const envName = process.env.CUSTOMER_NAME;
  if (envName) return envName;
  const [rows] = await bq.query(`
    SELECT table_name
    FROM \`foreman-production.foreman_customer_access.INFORMATION_SCHEMA.TABLES\`
    WHERE table_type = 'BASE TABLE'
  `);
  const names = rows.map(r => r.table_name);
  const candidates = names.filter(n => !['customer_btc_info','customer_lmp_prices'].includes(n));
  if (candidates.length === 1) return candidates[0];
  throw new Error(
    `Could not resolve CUSTOMER_NAME automatically. Found: ${names.join(', ')}. Set CUSTOMER_NAME.`
  );
}

async function runQuery(bq, sql) {
  const [rows] = await bq.query({ query: sql });
  return rows;
}

function print(title, rows, limit = 100) {
  console.log(`\n=== ${title} (window: last ${timeWindow.value} ${timeWindow.unit}${timeWindow.value !== 1 ? 's' : ''}) ===`);
  if (!rows || rows.length === 0) { console.log('(no rows)'); return; }
  const out = rows.slice(0, limit);
  try { console.table(out); } catch { for (const r of out) console.log(r); }
  if (rows.length > limit) console.log(`... (${rows.length - limit} more)`);
}

function toCSV(rows) {
  if (!rows || rows.length === 0) return '';
  const cols = Array.from(rows.reduce((set, r) => { Object.keys(r).forEach(k => set.add(k)); return set; }, new Set())).sort();
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    const needsWrap = /[",\n]/.test(s);
    const body = s.replace(/"/g, '""');
    return needsWrap ? `"${body}"` : body;
  };
  const header = cols.join(',');
  const lines = rows.map(r => cols.map(c => esc(r[c])).join(','));
  return [header, ...lines].join('\n');
}

async function saveRows(rows, dir, baseName, fmt) {
  if (!fmt) return;
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${baseName}.${fmt}`);
  const body = fmt === 'csv' ? toCSV(rows) : JSON.stringify(rows, null, 2);
  await fs.writeFile(file, body, 'utf8');
  console.log(`(saved ${rows.length} rows to ${file})`);
}

// Queries with partition filter

// Clients present
async function q2A_clients(bq, dataset) {
  const sql = `
    SELECT client_name, COUNT(DISTINCT miner_id) AS miners
    FROM \`${dataset}\`
    WHERE ${timeFilter()}
    GROUP BY client_name
    ORDER BY miners DESC
  `;
  return runQuery(bq, sql);
}

// Pool domains
async function q2B_pools(bq, dataset) {
  const sql = `
    WITH url_rows AS (
      SELECT miner_id, pool_1_url AS url FROM \`${dataset}\`
      WHERE ${timeFilter()} AND pool_1_url IS NOT NULL
      UNION ALL
      SELECT miner_id, pool_2_url FROM \`${dataset}\`
      WHERE ${timeFilter()} AND pool_2_url IS NOT NULL
      UNION ALL
      SELECT miner_id, pool_3_url FROM \`${dataset}\`
      WHERE ${timeFilter()} AND pool_3_url IS NOT NULL
    ),
    domains AS (
      SELECT
        miner_id,
        LOWER(REGEXP_EXTRACT(url, r'(?i)(?:^|//)([^/:]+)')) AS domain
      FROM url_rows
    )
    SELECT domain, COUNT(DISTINCT miner_id) AS miners
    FROM domains
    WHERE domain IS NOT NULL
    GROUP BY domain
    ORDER BY miners DESC
  `;
  return runQuery(bq, sql);
}

// Manufacturers inferred from miner_type
async function q2C_manufacturers(bq, dataset) {
  const sql = `
    SELECT
      CASE
        WHEN LOWER(miner_type) LIKE 'antminer%' THEN 'Bitmain'
        WHEN LOWER(miner_type) LIKE 'whatsminer%' THEN 'MicroBT'
        WHEN LOWER(miner_type) LIKE 'avalon%' THEN 'Canaan'
        ELSE 'Other/Unknown'
      END AS manufacturer,
      COUNT(DISTINCT miner_id) AS miners
    FROM \`${dataset}\`
    WHERE ${timeFilter()}
    GROUP BY manufacturer
    ORDER BY miners DESC
  `;
  return runQuery(bq, sql);
}

//Needle search across many fields
async function q2D_needles(bq, dataset, needlesList = ['antpool','blockware','bitmain','kjdga']) {
  const like = needlesList.map(n => `LOWER(x) LIKE '%${n.toLowerCase()}%'`).join(' OR ');
  const sql = `
    WITH base AS (
      SELECT
        miner_id,
        client_name,
        sitemap_group_name,
        pickaxe_name,
        miner_tags,
        active_worker,
        pool_1_worker, pool_2_worker, pool_3_worker,
        pool_1_url,    pool_2_url,    pool_3_url
      FROM \`${dataset}\`
      WHERE ${timeFilter()}
    ),
    exploded AS (
      SELECT miner_id, 'client_name' AS field, client_name AS x FROM base
      UNION ALL SELECT miner_id, 'sitemap_group_name', sitemap_group_name FROM base
      UNION ALL SELECT miner_id, 'pickaxe_name',       pickaxe_name       FROM base
      UNION ALL SELECT miner_id, 'miner_tags',         miner_tags         FROM base
      UNION ALL SELECT miner_id, 'active_worker',      active_worker      FROM base
      UNION ALL SELECT miner_id, 'pool_1_worker',      pool_1_worker      FROM base
      UNION ALL SELECT miner_id, 'pool_2_worker',      pool_2_worker      FROM base
      UNION ALL SELECT miner_id, 'pool_3_worker',      pool_3_worker      FROM base
      UNION ALL SELECT miner_id, 'pool_1_url',         pool_1_url         FROM base
      UNION ALL SELECT miner_id, 'pool_2_url',         pool_2_url         FROM base
      UNION ALL SELECT miner_id, 'pool_3_url',         pool_3_url         FROM base
    )
    SELECT field, x AS value, COUNT(DISTINCT miner_id) AS miners
    FROM exploded
    WHERE x IS NOT NULL AND (${like})
    GROUP BY field, value
    ORDER BY miners DESC
  `;
  return runQuery(bq, sql);
}

// Groups (MBxx)
async function q2E_groups(bq, dataset) {
  const sql = `
    SELECT sitemap_group_name, COUNT(DISTINCT miner_id) AS miners
    FROM \`${dataset}\`
    WHERE ${timeFilter()}
    GROUP BY sitemap_group_name
    ORDER BY sitemap_group_name
  `;
  return runQuery(bq, sql);
}

// Helper snippets for category conditions
const ANTPOOL = `
  LOWER(COALESCE(pool_1_url,'')) LIKE '%antpool.%'
  OR LOWER(COALESCE(pool_2_url,'')) LIKE '%antpool.%'
  OR LOWER(COALESCE(pool_3_url,'')) LIKE '%antpool.%'
`;
const BLOCKWARE = `
  LOWER(COALESCE(pool_1_url,'')) LIKE '%blockwarepool.%'
  OR LOWER(COALESCE(pool_2_url,'')) LIKE '%blockwarepool.%'
  OR LOWER(COALESCE(pool_3_url,'')) LIKE '%blockwarepool.%'
`;
const KJDGA = `
  REGEXP_CONTAINS(LOWER(COALESCE(active_worker,'')), r'(?:^|\\.)kjdga')
  OR REGEXP_CONTAINS(LOWER(COALESCE(pool_1_worker,'')), r'(?:^|\\.)kjdga')
  OR REGEXP_CONTAINS(LOWER(COALESCE(pool_2_worker,'')), r'(?:^|\\.)kjdga')
  OR REGEXP_CONTAINS(LOWER(COALESCE(pool_3_worker,'')), r'(?:^|\\.)kjdga')
`;
const F2POOL = `
  LOWER(COALESCE(pool_1_url,'')) LIKE '%f2pool.%'
  OR LOWER(COALESCE(pool_2_url,'')) LIKE '%f2pool.%'
  OR LOWER(COALESCE(pool_3_url,'')) LIKE '%f2pool.%'
`;

// Sylvania — Antpool vs Blockware vs Other (CURRENT snapshot + 24h AVG)
async function q2F_sylvania_current_and_24h(bq, dataset) {
  const sql = `
    -- Latest 5m snapshot for Sylvania (within the selected window)
    WITH latest_ts AS (
      SELECT MAX(timestamp) AS ts
      FROM \`${dataset}\`
      WHERE ${timeFilter()} AND client_name = 'Sylvania'
    ),
    current_rows AS (
      SELECT t.*
      FROM \`${dataset}\` t
      JOIN latest_ts s ON t.timestamp = s.ts
      WHERE t.client_name = 'Sylvania'
        AND ${timeFilter('t')} -- explicit partition filter for current_rows
    ),
    current_split AS (
      SELECT
        SUM(CAST(avg_hash_rate AS FLOAT64))/1e15 AS current_total_phs,
        SUM(CAST(CASE WHEN (
          LOWER(COALESCE(pool_1_url,'')) LIKE '%antpool.%' OR
          LOWER(COALESCE(pool_2_url,'')) LIKE '%antpool.%' OR
          LOWER(COALESCE(pool_3_url,'')) LIKE '%antpool.%'
        ) THEN avg_hash_rate ELSE 0 END AS FLOAT64))/1e15 AS current_antpool_phs,
        SUM(CAST(CASE WHEN (
          NOT (LOWER(COALESCE(pool_1_url,'')) LIKE '%antpool.%' OR
               LOWER(COALESCE(pool_2_url,'')) LIKE '%antpool.%' OR
               LOWER(COALESCE(pool_3_url,'')) LIKE '%antpool.%')
          AND
          (LOWER(COALESCE(pool_1_url,'')) LIKE '%blockwarepool.%' OR
           LOWER(COALESCE(pool_2_url,'')) LIKE '%blockwarepool.%' OR
           LOWER(COALESCE(pool_3_url,'')) LIKE '%blockwarepool.%')
        ) THEN avg_hash_rate ELSE 0 END AS FLOAT64))/1e15 AS current_blockware_phs,
        SUM(CAST(CASE WHEN (
          NOT (LOWER(COALESCE(pool_1_url,'')) LIKE '%antpool.%' OR
               LOWER(COALESCE(pool_2_url,'')) LIKE '%antpool.%' OR
               LOWER(COALESCE(pool_3_url,'')) LIKE '%antpool.%')
          AND
          NOT (LOWER(COALESCE(pool_1_url,'')) LIKE '%blockwarepool.%' OR
               LOWER(COALESCE(pool_2_url,'')) LIKE '%blockwarepool.%' OR
               LOWER(COALESCE(pool_3_url,'')) LIKE '%blockwarepool.%')
        ) THEN avg_hash_rate ELSE 0 END AS FLOAT64))/1e15 AS current_other_phs
      FROM current_rows
    ),

    -- 24h exclusive categorization, per-miner average per category, then sum
    rows_24h AS (
      SELECT *
      FROM \`${dataset}\`
      WHERE client_name = 'Sylvania'
        AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
    ),
    rows_24h_cat AS (
      SELECT
        miner_id,
        CAST(avg_hash_rate AS FLOAT64) AS hps,
        CASE
          WHEN (LOWER(COALESCE(pool_1_url,'')) LIKE '%antpool.%'
                OR LOWER(COALESCE(pool_2_url,'')) LIKE '%antpool.%'
                OR LOWER(COALESCE(pool_3_url,'')) LIKE '%antpool.%') THEN 'antpool'
          WHEN (LOWER(COALESCE(pool_1_url,'')) LIKE '%blockwarepool.%'
                OR LOWER(COALESCE(pool_2_url,'')) LIKE '%blockwarepool.%'
                OR LOWER(COALESCE(pool_3_url,'')) LIKE '%blockwarepool.%') THEN 'blockware'
          ELSE 'other'
        END AS cat
      FROM rows_24h
    ),
    per_miner_cat_avg AS (
      SELECT miner_id, cat, AVG(hps) AS miner_avg_hps
      FROM rows_24h_cat
      GROUP BY miner_id, cat
    ),
    sum_cat AS (
      SELECT
        SUM(CASE WHEN cat = 'antpool'   THEN miner_avg_hps ELSE 0 END)/1e15 AS avg24_antpool_phs,
        SUM(CASE WHEN cat = 'blockware' THEN miner_avg_hps ELSE 0 END)/1e15 AS avg24_blockware_phs,
        SUM(CASE WHEN cat = 'other'     THEN miner_avg_hps ELSE 0 END)/1e15 AS avg24_other_phs
      FROM per_miner_cat_avg
    ),
    total_avg24 AS (
      SELECT SUM(miner_avg_hps)/1e15 AS avg24_total_phs
      FROM (
        SELECT miner_id, AVG(CAST(avg_hash_rate AS FLOAT64)) AS miner_avg_hps
        FROM rows_24h
        GROUP BY miner_id
      )
    )
    SELECT
      current_total_phs, current_antpool_phs, current_blockware_phs, current_other_phs,
      avg24_total_phs,   avg24_antpool_phs,  avg24_blockware_phs,  avg24_other_phs
    FROM current_split, sum_cat, total_avg24
  `;
  return runQuery(bq, sql);
}

// Sylvania - Bitmain — KJDGA vs F2Pool vs Other (CURRENT + 24h AVG)
async function q2G_bitmain_current_and_24h(bq, dataset) {
  const sql = `
    -- Latest 5m snapshot for Sylvania - Bitmain (within the selected window)
    WITH latest_ts AS (
      SELECT MAX(timestamp) AS ts
      FROM \`${dataset}\`
      WHERE ${timeFilter()} AND client_name = 'Sylvania - Bitmain'
    ),
    current_rows AS (
      SELECT t.*
      FROM \`${dataset}\` t
      JOIN latest_ts s ON t.timestamp = s.ts
      WHERE t.client_name = 'Sylvania - Bitmain'
        AND ${timeFilter('t')} -- explicit partition filter for current_rows
    ),
    current_split AS (
      SELECT
        SUM(CAST(avg_hash_rate AS FLOAT64))/1e15 AS current_total_phs,
        SUM(CAST(CASE WHEN (
          REGEXP_CONTAINS(LOWER(COALESCE(active_worker,'')), r'(?:^|\\.)kjdga') OR
          REGEXP_CONTAINS(LOWER(COALESCE(pool_1_worker,'')), r'(?:^|\\.)kjdga') OR
          REGEXP_CONTAINS(LOWER(COALESCE(pool_2_worker,'')), r'(?:^|\\.)kjdga') OR
          REGEXP_CONTAINS(LOWER(COALESCE(pool_3_worker,'')), r'(?:^|\\.)kjdga')
        ) THEN avg_hash_rate ELSE 0 END AS FLOAT64))/1e15 AS current_kjdga_phs,
        SUM(CAST(CASE WHEN (
          NOT (
            REGEXP_CONTAINS(LOWER(COALESCE(active_worker,'')), r'(?:^|\\.)kjdga') OR
            REGEXP_CONTAINS(LOWER(COALESCE(pool_1_worker,'')), r'(?:^|\\.)kjdga') OR
            REGEXP_CONTAINS(LOWER(COALESCE(pool_2_worker,'')), r'(?:^|\\.)kjdga') OR
            REGEXP_CONTAINS(LOWER(COALESCE(pool_3_worker,'')), r'(?:^|\\.)kjdga')
          )
          AND (
            LOWER(COALESCE(pool_1_url,'')) LIKE '%f2pool.%' OR
            LOWER(COALESCE(pool_2_url,'')) LIKE '%f2pool.%' OR
            LOWER(COALESCE(pool_3_url,'')) LIKE '%f2pool.%'
          )
        ) THEN avg_hash_rate ELSE 0 END AS FLOAT64))/1e15 AS current_f2pool_phs,
        SUM(CAST(CASE WHEN (
          NOT (
            REGEXP_CONTAINS(LOWER(COALESCE(active_worker,'')), r'(?:^|\\.)kjdga') OR
            REGEXP_CONTAINS(LOWER(COALESCE(pool_1_worker,'')), r'(?:^|\\.)kjdga') OR
            REGEXP_CONTAINS(LOWER(COALESCE(pool_2_worker,'')), r'(?:^|\\.)kjdga') OR
            REGEXP_CONTAINS(LOWER(COALESCE(pool_3_worker,'')), r'(?:^|\\.)kjdga')
          )
          AND NOT (
            LOWER(COALESCE(pool_1_url,'')) LIKE '%f2pool.%' OR
            LOWER(COALESCE(pool_2_url,'')) LIKE '%f2pool.%' OR
            LOWER(COALESCE(pool_3_url,'')) LIKE '%f2pool.%'
          )
        ) THEN avg_hash_rate ELSE 0 END AS FLOAT64))/1e15 AS current_other_phs
      FROM current_rows
    ),

    -- 24h exclusive categorization (KJDGA has precedence), per-miner average per category, then sum
    rows_24h AS (
      SELECT *
      FROM \`${dataset}\`
      WHERE client_name = 'Sylvania - Bitmain'
        AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
    ),
    rows_24h_cat AS (
      SELECT
        miner_id,
        CAST(avg_hash_rate AS FLOAT64) AS hps,
        CASE
          WHEN (
            REGEXP_CONTAINS(LOWER(COALESCE(active_worker,'')), r'(?:^|\\.)kjdga') OR
            REGEXP_CONTAINS(LOWER(COALESCE(pool_1_worker,'')), r'(?:^|\\.)kjdga') OR
            REGEXP_CONTAINS(LOWER(COALESCE(pool_2_worker,'')), r'(?:^|\\.)kjdga') OR
            REGEXP_CONTAINS(LOWER(COALESCE(pool_3_worker,'')), r'(?:^|\\.)kjdga')
          ) THEN 'kjdga'
          WHEN (
            LOWER(COALESCE(pool_1_url,'')) LIKE '%f2pool.%' OR
            LOWER(COALESCE(pool_2_url,'')) LIKE '%f2pool.%' OR
            LOWER(COALESCE(pool_3_url,'')) LIKE '%f2pool.%'
          ) THEN 'f2pool'
          ELSE 'other'
        END AS cat
      FROM rows_24h
    ),
    per_miner_cat_avg AS (
      SELECT miner_id, cat, AVG(hps) AS miner_avg_hps
      FROM rows_24h_cat
      GROUP BY miner_id, cat
    ),
    sum_cat AS (
      SELECT
        SUM(CASE WHEN cat = 'kjdga'  THEN miner_avg_hps ELSE 0 END)/1e15 AS avg24_kjdga_phs,
        SUM(CASE WHEN cat = 'f2pool' THEN miner_avg_hps ELSE 0 END)/1e15 AS avg24_f2pool_phs,
        SUM(CASE WHEN cat = 'other'  THEN miner_avg_hps ELSE 0 END)/1e15 AS avg24_other_phs
      FROM per_miner_cat_avg
    ),
    total_avg24 AS (
      SELECT SUM(miner_avg_hps)/1e15 AS avg24_total_phs
      FROM (
        SELECT miner_id, AVG(CAST(avg_hash_rate AS FLOAT64)) AS miner_avg_hps
        FROM rows_24h
        GROUP BY miner_id
      )
    )
    SELECT
      current_total_phs, current_kjdga_phs, current_f2pool_phs, current_other_phs,
      avg24_total_phs,   avg24_kjdga_phs,  avg24_f2pool_phs,  avg24_other_phs
    FROM current_split, sum_cat, total_avg24
  `;
  return runQuery(bq, sql);
}

// Main
(async () => {
  try {
    const bq = getClient();
    const customer = await resolveCustomerName(bq);
    const dataset = `foreman-production.foreman_customer_access.${customer}`;
    console.log(`Using dataset: ${dataset}`);

    if (!(wantA || wantB || wantC || wantD || wantE || wantF || wantG)) {
      console.log(`\nUsage:
  node scripts/discoveryquery.js --all [--format=csv|json] [--out-dir=out] [--hours=24|--days=7]
  node scripts/discoveryquery.js --a    [--format=csv|json] [--out-dir=out] [--hours=24|--days=7]
  node scripts/discoveryquery.js --b    [--format=csv|json] [--out-dir=out] [--hours=24|--days=7]
  node scripts/discoveryquery.js --c    [--format=csv|json] [--out-dir=out] [--hours=24|--days=7]
  node scripts/discoveryquery.js --d [--needles=antpool,blockware,bitmain,kjdga] [--format=csv|json] [--out-dir=out] [--hours=24|--days=7]
  node scripts/discoveryquery.js --e    [--format=csv|json] [--out-dir=out] [--hours=24|--days=7]
  node scripts/discoveryquery.js --f    [--format=csv|json] [--out-dir=out] [--hours=24|--days=7]
  node scripts/discoveryquery.js --g    [--format=csv|json] [--out-dir=out] [--hours=24|--days=7]
`);
      process.exit(0);
    }

    if (wantA) { const rows = await q2A_clients(bq, dataset); print('2A) Clients present (distinct miners)', rows); await saveRows(rows, outDir, '2A_clients', format); }
    if (wantB) { const rows = await q2B_pools(bq, dataset);   print('2B) Pool domains (distinct miners per domain)', rows); await saveRows(rows, outDir, '2B_pool_domains', format); }
    if (wantC) { const rows = await q2C_manufacturers(bq, dataset); print('2C) Manufacturers (inferred; distinct miners)', rows); await saveRows(rows, outDir, '2C_manufacturers', format); }
    if (wantD) { const rows = await q2D_needles(bq, dataset, needles); print(`2D) Needle matches (distinct miners): ${needles.join(', ')}`, rows); await saveRows(rows, outDir, '2D_needle_matches', format); }
    if (wantE) { const rows = await q2E_groups(bq, dataset); print('2E) Groups (MBxx) — distinct miners per group', rows); await saveRows(rows, outDir, '2E_groups', format); }
    if (wantF) { const rows = await q2F_sylvania_current_and_24h(bq, dataset); print('2F) Sylvania — current & 24h (PH/s): Antpool vs Blockware vs Other', rows); await saveRows(rows, outDir, '2F_sylvania_current_avg24', format); }
    if (wantG) { const rows = await q2G_bitmain_current_and_24h(bq, dataset); print('2G) Sylvania - Bitmain — current & 24h (PH/s): KJDGA vs F2Pool vs Other', rows); await saveRows(rows, outDir, '2G_bitmain_current_avg24', format); }

  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
