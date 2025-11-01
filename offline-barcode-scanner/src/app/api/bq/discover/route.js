export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { BigQuery } from '@google-cloud/bigquery';

const DATASET_PREFIX = 'foreman-production.foreman_customer_access';
const EXCLUDE_TABLES = new Set(['customer_btc_info', 'customer_lmp_prices']);

// Looser detectors so we don't miss odd schemas
const SERIAL_RE = /(serial|miner[_]?id|device[_]?serial|unit[_]?serial|sn)\b/i;
const MAC_RE    = /(mac(_address)?|miner[_]?mac|network[_]?mac)/i;
const IP_RE     = /(^|_)(ip|ip_address|miner[_]?ip|network[_]?ip)($|_)/i;

function getBQ() {
  const raw = process.env.FOREMAN_SA_JSON;
  if (!raw) throw new Error('FOREMAN_SA_JSON not set');
  const creds = JSON.parse(raw);
  return new BigQuery({ credentials: creds, projectId: creds.project_id });
}

async function listTables(bq) {
  const q = `
    SELECT table_name
    FROM \`${DATASET_PREFIX}\`.INFORMATION_SCHEMA.TABLES
    WHERE table_type = 'BASE TABLE'
  `;
  const [rows] = await bq.query({ query: q });
  return rows
    .map(r => String(r.table_name))
    .filter(n => n && !EXCLUDE_TABLES.has(n));
}

async function listColumns(bq, tableName) {
  const q = `
    SELECT column_name
    FROM \`${DATASET_PREFIX}\`.INFORMATION_SCHEMA.COLUMNS
    WHERE table_name = @t
  `;
  const [rows] = await bq.query({ query: q, params: { t: tableName } });
  return rows.map(r => String(r.column_name));
}

function pickCols(cols) {
  // Pick best-guess serial/mac/ip columns from a set of names
  const serials = cols.filter(c => SERIAL_RE.test(c));
  const macs    = cols.filter(c => MAC_RE.test(c));
  const ips     = cols.filter(c => IP_RE.test(c));
  if (!serials.length) return null;
  return {
    serialCol: serials[0],
    macCol: macs[0] || null,
    ipCol:  ips[0]  || null,
  };
}

async function tryTable(bq, tableName, serial, cols) {
  const fq = `\`${DATASET_PREFIX}.${tableName}\``;

  const selectPieces = [
    `CAST(${cols.serialCol} AS STRING) AS serial`,
    cols.macCol ? `LOWER(REPLACE(CAST(${cols.macCol} AS STRING), '-', ':')) AS mac` : `'null' AS mac`,
    cols.ipCol  ? `CAST(${cols.ipCol} AS STRING) AS ip` : `'null' AS ip`,
  ];

  // Try with ORDER BY timestamp if present
  const q1 = `
    SELECT ${selectPieces.join(', ')}
    FROM ${fq}
    WHERE UPPER(CAST(${cols.serialCol} AS STRING)) = @serial
    ORDER BY timestamp DESC
    LIMIT 1
  `;
  try {
    const [rows1] = await bq.query({ query: q1, params: { serial } });
    if (rows1?.length) return { row: rows1[0], table: `${DATASET_PREFIX}.${tableName}`, cols };
  } catch { /* maybe no timestamp column */ }

  // Try without ORDER BY
  const q2 = `
    SELECT ${selectPieces.join(', ')}
    FROM ${fq}
    WHERE UPPER(CAST(${cols.serialCol} AS STRING)) = @serial
    LIMIT 1
  `;
  try {
    const [rows2] = await bq.query({ query: q2, params: { serial } });
    if (rows2?.length) return { row: rows2[0], table: `${DATASET_PREFIX}.${tableName}`, cols };
  } catch { /* ignore */ }

  return null;
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const serialRaw = String(searchParams.get('serial') || '').trim();
    if (!serialRaw) return NextResponse.json({ error: 'serial required' }, { status: 400 });
    const serial = serialRaw.toUpperCase();

    const bq = getBQ();

    // Prefer CUSTOMER_NAME if set, but scan all tables too
    const preferred = (process.env.CUSTOMER_NAME || '').trim();
    const allTables = await listTables(bq);

    const ordered = preferred
      ? [preferred, ...allTables.filter(t => t !== preferred)]
      : allTables;

    const tried = [];
    for (const t of ordered) {
      const cols = await listColumns(bq, t);
      const picked = pickCols(cols);
      tried.push({ table: t, cols, picked });
      if (!picked) continue;

      const hit = await tryTable(bq, t, serial, picked);
      if (hit) {
        const { row, table, cols: used } = hit;
        return NextResponse.json(
          {
            serial: row.serial || serial,
            mac: row.mac || null,
            ip: row.ip || null,
            viaTable: table,
            viaColumns: used,
          },
          { headers: { 'Cache-Control': 'no-store' } }
        );
      }
    }

    return NextResponse.json(
      { error: 'not found', scannedTables: ordered, tried },
      { status: 404 }
    );
  } catch (e) {
    return NextResponse.json({ error: e?.message || 'discover failed' }, { status: 500 });
  }
}
