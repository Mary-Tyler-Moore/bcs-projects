// src/app/api/bq/lookup/route.js
import { NextResponse } from 'next/server';
import { BigQuery } from '@google-cloud/bigquery';

function getBQ() {
  const raw = process.env.FOREMAN_SA_JSON;
  if (!raw) throw new Error('FOREMAN_SA_JSON not set');
  const creds = JSON.parse(raw);
  return new BigQuery({ credentials: creds, projectId: creds.project_id });
}

// Prefer CUSTOMER_NAME from .env; fall back to error if missing
function tablePath() {
  const name = process.env.CUSTOMER_NAME;
  if (!name) throw new Error('CUSTOMER_NAME not set');
  return `foreman-production.foreman_customer_access.${name}`;
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const serial = String(searchParams.get('serial') || '').trim();
    if (!serial) return NextResponse.json({ error: 'serial required' }, { status: 400 });

    const bq = getBQ();
    const table = tablePath();

    // Query latest row for this serial
    const query = `
      SELECT
        CAST(miner_serial AS STRING) AS serial,
        LOWER(REPLACE(CAST(miner_mac AS STRING), '-', ':')) AS mac,
        CAST(miner_ip AS STRING) AS ip
      FROM \`${table}\`
      WHERE miner_serial = @serial
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    const [rows] = await bq.query({
      query,
      params: { serial },
    });

    const row = rows?.[0];
    if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

    return NextResponse.json(
      { serial: row.serial || serial, mac: row.mac || null, ip: row.ip || null },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    return NextResponse.json({ error: e?.message || 'lookup failed' }, { status: 500 });
  }
}
