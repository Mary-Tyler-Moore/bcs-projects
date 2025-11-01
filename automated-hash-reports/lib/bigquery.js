// lib/bigquery.js
import 'dotenv/config';
import { BigQuery } from '@google-cloud/bigquery';

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
  throw new Error(`Set CUSTOMER_NAME. Found: ${names.join(', ')}`);
}

function timeFilter(alias, hours) {
  const a = alias ? `${alias}.` : '';
  return `${a}timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${hours} HOUR)`;
}

async function runQuery(bq, sql) {
  const [rows] = await bq.query({ query: sql });
  return rows;
}

// Pool + worker matching
const ANTPOOL = `
  REGEXP_CONTAINS(LOWER(COALESCE(pool_1_url,'')), r'antpool')
  OR REGEXP_CONTAINS(LOWER(COALESCE(pool_2_url,'')), r'antpool')
  OR REGEXP_CONTAINS(LOWER(COALESCE(pool_3_url,'')), r'antpool')
`;
const BLOCKWARE = `
  REGEXP_CONTAINS(LOWER(COALESCE(pool_1_url,'')), r'blockware')
  OR REGEXP_CONTAINS(LOWER(COALESCE(pool_2_url,'')), r'blockware')
  OR REGEXP_CONTAINS(LOWER(COALESCE(pool_3_url,'')), r'blockware')
`;
const KJDGA = `
  REGEXP_CONTAINS(LOWER(COALESCE(active_worker,'')), r'(?:^|\\.)kjdga')
  OR REGEXP_CONTAINS(LOWER(COALESCE(pool_1_worker,'')), r'(?:^|\\.)kjdga')
  OR REGEXP_CONTAINS(LOWER(COALESCE(pool_2_worker,'')), r'(?:^|\\.)kjdga')
  OR REGEXP_CONTAINS(LOWER(COALESCE(pool_3_worker,'')), r'(?:^|\\.)kjdga')
`;
const F2POOL = `
  REGEXP_CONTAINS(LOWER(COALESCE(pool_1_url,'')), r'f2pool')
  OR REGEXP_CONTAINS(LOWER(COALESCE(pool_2_url,'')), r'f2pool')
  OR REGEXP_CONTAINS(LOWER(COALESCE(pool_3_url,'')), r'f2pool')
`;

// Helpers: sorting / totals
function sortByBox(a, b) {
  const ax = String(a.group ?? a.sitemap_group_name ?? '');
  const bx = String(b.group ?? b.sitemap_group_name ?? '');
  const na = parseInt(ax.match(/^[A-Z]{2}(\d+)/i)?.[1] ?? '0', 10);
  const nb = parseInt(bx.match(/^[A-Z]{2}(\d+)/i)?.[1] ?? '0', 10);
  if (na !== nb) return na - nb;
  return ax.localeCompare(bx);
}

// Build tables per-group: 'bcs' | 'bm' 
function buildTable(
  rowsRaw,
  {
    mode = 'bcs',               
    includePrefixes = ['MB','AB']
  } = {}
) {
  const ALLOW_BCS = new Set(['MB01','MB02','MB03','MB04','MB05','MB14','MB15','MB16','AB01']);
  const ALLOW_BM = new Set([
    'MB06','MB07','MB08','MB09','MB10','MB11','MB12','MB13',
    'MB17','MB18','MB19','MB20','MB21','MB22','MB23'
  ]);
  const re = new RegExp(`^(${includePrefixes.join('|')})`, 'i');

  const filtered = rowsRaw
    .map(r => ({
      group: r.grp ?? null,
      deployed: r.deployed ?? 0,
      reachable: r.reachable ?? 0,
      hashing: r.hashing ?? 0
    }))
    .filter(r => r.group && re.test(r.group))
    .filter(r => {
      const g = (r.group || '').toUpperCase();
      return mode === 'bm' ? ALLOW_BM.has(g) : ALLOW_BCS.has(g);
    });

  const rows = filtered
    .map(r => {
      const not_hashing = Math.max(0, (r.reachable ?? 0) - (r.hashing ?? 0));
      const efficiency_pct =
        mode === 'bm'
          ? (r.reachable ? (r.hashing / r.reachable * 100) : null)   // uptime
          : (r.deployed  ? (r.hashing / r.deployed  * 100) : null);
      const not_hashing_rate_pct =
        r.reachable ? (not_hashing / r.reachable * 100) : null;
      return { ...r, not_hashing, efficiency_pct, not_hashing_rate_pct };
    })
    .sort(sortByBox);

  const totals = rows.reduce((acc, r) => {
    acc.deployed += r.deployed ?? 0;
    acc.reachable += r.reachable ?? 0;
    acc.hashing += r.hashing ?? 0;
    acc.not_hashing += r.not_hashing ?? 0;
    return acc;
  }, { deployed: 0, reachable: 0, hashing: 0, not_hashing: 0 });

  totals.efficiency_pct =
    (mode === 'bm')
      ? (totals.reachable ? (totals.hashing / totals.reachable * 100) : null)
      : (totals.deployed  ? (totals.hashing / totals.deployed  * 100) : null);

  totals.not_hashing_rate_pct =
    totals.reachable ? (totals.not_hashing / totals.reachable * 100) : null;

  return { rows, totals };
}

function toIso(x) {
  if (!x) return null;
  const v = typeof x === 'string' ? x : (x.value ?? x);
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}

// Top splits
function sqlSylvania(dataset, hours) {
  return `
    WITH latest_ts AS (
      SELECT MAX(timestamp) AS ts
      FROM \`${dataset}\`
      WHERE ${timeFilter('', hours)} AND client_name = 'Sylvania'
    ),
    current_rows AS (
      SELECT t.*
      FROM \`${dataset}\` t
      JOIN latest_ts s ON t.timestamp = s.ts
      WHERE t.client_name = 'Sylvania'
        AND ${timeFilter('t', hours)}
    ),
    current_split AS (
      SELECT
        SUM(SAFE_CAST(avg_hash_rate AS FLOAT64))/1e15 AS current_total_phs,
        SUM(SAFE_CAST(CASE WHEN (${ANTPOOL})   THEN avg_hash_rate ELSE 0 END AS FLOAT64))/1e15 AS current_antpool_phs,
        SUM(SAFE_CAST(CASE WHEN (NOT (${ANTPOOL}) AND (${BLOCKWARE})) THEN avg_hash_rate ELSE 0 END AS FLOAT64))/1e15 AS current_blockware_phs,
        SUM(SAFE_CAST(CASE WHEN (NOT (${ANTPOOL}) AND NOT (${BLOCKWARE})) THEN avg_hash_rate ELSE 0 END AS FLOAT64))/1e15 AS current_other_phs
      FROM current_rows
    ),
    rows_24h AS (
      SELECT *
      FROM \`${dataset}\`
      WHERE client_name = 'Sylvania'
        AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
    ),
    rows_24h_cat AS (
      SELECT
        miner_id,
        SAFE_CAST(avg_hash_rate AS FLOAT64) AS hps,
        CASE
          WHEN (${ANTPOOL})   THEN 'antpool'
          WHEN (${BLOCKWARE}) THEN 'blockware'
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
        SELECT miner_id, AVG(SAFE_CAST(avg_hash_rate AS FLOAT64)) AS miner_avg_hps
        FROM rows_24h
        GROUP BY miner_id
      )
    )
    SELECT
      (SELECT ts FROM latest_ts) AS current_snapshot_ts,
      (SELECT current_total_phs     FROM current_split) AS current_total_phs,
      (SELECT current_antpool_phs   FROM current_split) AS current_antpool_phs,
      (SELECT current_blockware_phs FROM current_split) AS current_blockware_phs,
      (SELECT current_other_phs     FROM current_split) AS current_other_phs,
      (SELECT avg24_total_phs       FROM total_avg24)   AS avg24_total_phs,
      (SELECT avg24_antpool_phs     FROM sum_cat)       AS avg24_antpool_phs,
      (SELECT avg24_blockware_phs   FROM sum_cat)       AS avg24_blockware_phs,
      (SELECT avg24_other_phs       FROM sum_cat)       AS avg24_other_phs
  `;
}

function sqlBitmain(dataset, hours) {
  return `
    WITH latest_ts AS (
      SELECT MAX(timestamp) AS ts
      FROM \`${dataset}\`
      WHERE ${timeFilter('', hours)} AND client_name = 'Sylvania - Bitmain'
    ),
    current_rows AS (
      SELECT t.*
      FROM \`${dataset}\` t
      JOIN latest_ts s ON t.timestamp = s.ts
      WHERE t.client_name = 'Sylvania - Bitmain'
        AND ${timeFilter('t', hours)}
    ),
    current_split AS (
      SELECT
        SUM(SAFE_CAST(avg_hash_rate AS FLOAT64))/1e15 AS current_total_phs,
        SUM(SAFE_CAST(CASE WHEN (${KJDGA}) THEN avg_hash_rate ELSE 0 END AS FLOAT64))/1e15 AS current_kjdga_phs,
        SUM(SAFE_CAST(CASE WHEN (NOT (${KJDGA}) AND (${F2POOL})) THEN avg_hash_rate ELSE 0 END AS FLOAT64))/1e15 AS current_f2pool_phs,
        SUM(SAFE_CAST(CASE WHEN (NOT (${KJDGA}) AND NOT (${F2POOL})) THEN avg_hash_rate ELSE 0 END AS FLOAT64))/1e15 AS current_other_phs
      FROM current_rows
    ),
    rows_24h AS (
      SELECT *
      FROM \`${dataset}\`
      WHERE client_name = 'Sylvania - Bitmain'
        AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
    ),
    rows_24h_cat AS (
      SELECT
        miner_id,
        SAFE_CAST(avg_hash_rate AS FLOAT64) AS hps,
        CASE
          WHEN (${KJDGA}) THEN 'kjdga'
          WHEN (${F2POOL}) THEN 'f2pool'
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
        SELECT miner_id, AVG(SAFE_CAST(avg_hash_rate AS FLOAT64)) AS miner_avg_hps
        FROM rows_24h
        GROUP BY miner_id
      )
    )
    SELECT
      (SELECT ts FROM latest_ts) AS current_snapshot_ts,
      (SELECT current_total_phs  FROM current_split) AS current_total_phs,
      (SELECT current_kjdga_phs  FROM current_split) AS current_kjdga_phs,
      (SELECT current_f2pool_phs FROM current_split) AS current_f2pool_phs,
      (SELECT current_other_phs  FROM current_split) AS current_other_phs,
      (SELECT avg24_total_phs    FROM total_avg24)   AS avg24_total_phs,
      (SELECT avg24_kjdga_phs    FROM sum_cat)       AS avg24_kjdga_phs,
      (SELECT avg24_f2pool_phs   FROM sum_cat)       AS avg24_f2pool_phs,
      (SELECT avg24_other_phs    FROM sum_cat)       AS avg24_other_phs
  `;
}

// MB tables
function sqlMBTable(dataset, hours, clientName) {
  return `
    WITH window_rows AS (
      SELECT *
      FROM \`${dataset}\`
      WHERE client_name = '${clientName}'
        AND ${timeFilter('', hours)}
    ),
    latest_ts AS (
      SELECT MAX(timestamp) AS ts FROM window_rows
    ),
    current_rows AS (
      SELECT w.*
      FROM window_rows w
      JOIN latest_ts s ON w.timestamp = s.ts
    ),
    all_groups AS (
      SELECT DISTINCT sitemap_group_name AS grp
      FROM window_rows
      WHERE sitemap_group_name IS NOT NULL
    ),
    d AS (
      SELECT sitemap_group_name AS grp, COUNT(DISTINCT miner_id) AS deployed
      FROM window_rows
      GROUP BY sitemap_group_name
    ),
    r AS (
      SELECT sitemap_group_name AS grp, COUNT(DISTINCT miner_id) AS reachable
      FROM current_rows
      GROUP BY sitemap_group_name
    ),
    h AS (
      SELECT sitemap_group_name AS grp, COUNT(DISTINCT miner_id) AS hashing
      FROM current_rows
      WHERE SAFE_CAST(avg_hash_rate AS FLOAT64) > 0
      GROUP BY sitemap_group_name
    )
    SELECT
      g.grp,
      d.deployed,
      r.reachable,
      h.hashing
    FROM all_groups g
    LEFT JOIN d USING (grp)
    LEFT JOIN r USING (grp)
    LEFT JOIN h USING (grp)
  `;
}

function sqlBlockwareEfficiency(dataset, hours) {
  return `
    WITH window_rows AS (
      SELECT *
      FROM \`${dataset}\`
      WHERE client_name = 'Sylvania'
        AND ${timeFilter('', hours)}
    ),
    latest_ts AS (
      SELECT MAX(timestamp) AS ts FROM window_rows
    ),
    current_rows AS (
      SELECT w.*
      FROM window_rows w
      JOIN latest_ts s ON w.timestamp = s.ts
    ),
    deployed_blockware AS (
      SELECT COUNT(DISTINCT miner_id) AS deployed
      FROM window_rows
      WHERE (${BLOCKWARE})
    ),
    hashing_blockware AS (
      SELECT COUNT(DISTINCT miner_id) AS hashing
      FROM current_rows
      WHERE (${BLOCKWARE}) AND SAFE_CAST(avg_hash_rate AS FLOAT64) > 0
    )
    SELECT
      d.deployed,
      h.hashing,
      SAFE_DIVIDE(h.hashing, d.deployed) * 100.0 AS efficiency_pct
    FROM deployed_blockware d CROSS JOIN hashing_blockware h
  `;
}

// Issues
function sqlIssuesForClient(dataset, hours, clientName) {
  return `
    WITH window_rows AS (
      SELECT *
      FROM \`${dataset}\`
      WHERE client_name = '${clientName}'
        AND ${timeFilter('', hours)}
    ),
    latest_ts AS (
      SELECT MAX(timestamp) AS ts FROM window_rows
    ),
    current_rows AS (
      SELECT w.*
      FROM window_rows w
      JOIN latest_ts s ON w.timestamp = s.ts
      WHERE w.sitemap_group_name IS NOT NULL
    ),
    issues AS (
      SELECT
        sitemap_group_name AS grp,
        CONCAT(
          'R', COALESCE(NULLIF(REGEXP_EXTRACT(CAST(miner_rack  AS STRING), r'(\\d+)'), ''), '?'),
          '.S', COALESCE(NULLIF(REGEXP_EXTRACT(CAST(miner_row   AS STRING), r'(\\d+)'), ''), '?'),
          '.P', COALESCE(NULLIF(REGEXP_EXTRACT(CAST(miner_index AS STRING), r'(\\d+)'), ''), '?')
        ) AS position,
        miner_ip  AS ip,
        LOWER(REPLACE(CAST(miner_mac AS STRING), '-', ':')) AS mac,
        SAFE_CAST(avg_hash_rate AS FLOAT64) AS hps
      FROM current_rows
    )
    SELECT
      grp,
      position,
      ip,
      mac
    FROM issues
    WHERE grp IS NOT NULL
      AND REGEXP_CONTAINS(UPPER(grp), r'^(MB|AB)\\d+')
      AND COALESCE(hps, 0) <= 0
    ORDER BY grp, position
  `;
}

function rowsToIssueMap(rows) {
  const m = {};
  for (const r of rows || []) {
    const g = r.grp || 'Unknown';
    if (!m[g]) m[g] = [];
    m[g].push({
      position: r.position || 'R?.S?.P?',
      ip: r.ip || null,
      mac: r.mac || null
    });
  }
  return m;
}

async function fetchIssuesBothClients(bq, dataset, hours) {
  try {
    const [bcsRows, bmRows] = await Promise.all([
      runQuery(bq, sqlIssuesForClient(dataset, hours, 'Sylvania')),
      runQuery(bq, sqlIssuesForClient(dataset, hours, 'Sylvania - Bitmain')),
    ]);
    return {
      bcs: rowsToIssueMap(bcsRows),
      bm:  rowsToIssueMap(bmRows),
    };
  } catch (e) {
    console.warn('[bigquery issues] skipped:', e?.message || e);
    return { bcs: {}, bm: {} };
  }
}

// Export: main report
export async function fetchHashReport({ hours = 24 } = {}) {
  const bq = getClient();
  const customer = await resolveCustomerName(bq);
  const dataset = `foreman-production.foreman_customer_access.${customer}`;

  // Splits
  const sylRows = await runQuery(bq, sqlSylvania(dataset, hours));
  const bitRows = await runQuery(bq, sqlBitmain(dataset, hours));
  const syl = sylRows?.[0] ?? null;
  const bit = bitRows?.[0] ?? null;

  // Tables (site-specific efficiency + allowlists)
  const sylMB = await runQuery(bq, sqlMBTable(dataset, hours, 'Sylvania'));
  const bitMB = await runQuery(bq, sqlMBTable(dataset, hours, 'Sylvania - Bitmain'));
  const sylTable = buildTable(sylMB, { mode: 'bcs', includePrefixes: ['MB','AB'] });
  const bitTable = buildTable(bitMB, { mode: 'bm',  includePrefixes: ['MB'] });

  // Blockware efficiency (global)
  const blk = await runQuery(bq, sqlBlockwareEfficiency(dataset, hours));
  const blkEff = blk?.[0]?.efficiency_pct ?? null;

  // Snapshot normalize
  const snapSyl = toIso(syl?.current_snapshot_ts);
  const snapBit = toIso(bit?.current_snapshot_ts);
  const snap = snapSyl && snapBit ? (new Date(snapSyl) > new Date(snapBit) ? snapSyl : snapBit) : (snapSyl || snapBit || null);

  // Overall totals are the sum of both clients
  const overall = {
    current_phs: (syl?.current_total_phs || 0) + (bit?.current_total_phs || 0),
    avg24_phs:   (syl?.avg24_total_phs   || 0) + (bit?.avg24_total_phs   || 0)
  };

  const issuesByGroup = await fetchIssuesBothClients(bq, dataset, hours);

  return {
    generatedAt: new Date().toISOString(),
    windowHours: hours,
    currentSnapshotTs: snap,
    overall,
    sylvania: {
      current: {
        total: syl?.current_total_phs ?? null,
        antpool: syl?.current_antpool_phs ?? null,
        blockware: syl?.current_blockware_phs ?? null,
        other: syl?.current_other_phs ?? null
      },
      avg24: {
        total: syl?.avg24_total_phs ?? null,
        antpool: syl?.avg24_antpool_phs ?? null,
        blockware: syl?.avg24_blockware_phs ?? null,
        other: syl?.avg24_other_phs ?? null
      }
    },
    bitmain: {
      current: {
        total: bit?.current_total_phs ?? null,
        kjdga: bit?.current_kjdga_phs ?? null,
        f2pool: bit?.current_f2pool_phs ?? null,
        other: bit?.current_other_phs ?? null
      },
      avg24: {
        total: bit?.avg24_total_phs ?? null,
        kjdga: bit?.avg24_kjdga_phs ?? null,
        f2pool: bit?.avg24_f2pool_phs ?? null,
        other: bit?.avg24_other_phs ?? null
      }
    },
    tables: {
      sylvania: {
        rows: sylTable.rows,
        totals: sylTable.totals,
        blockware_efficiency_pct: blkEff
      },
      bitmain: {
        rows: bitTable.rows,
        totals: bitTable.totals
      }
    },
    foreman: { issuesByGroup }
  };
}
