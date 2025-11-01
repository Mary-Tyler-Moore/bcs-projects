// src/app/api/bq/lookup/route.js
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { createSign } from 'node:crypto';

/** Find a service-account JSON for packaged app */
function findServiceAccountJson() {
  // 1) Explicit env file path (absolute or relative)
  let file = process.env.FOREMAN_SA_JSON_FILE;
  if (file) {
    if (!path.isAbsolute(file)) {
      const appRoot = path.join(process.resourcesPath || path.dirname(process.execPath), 'app');
      file = path.join(appRoot, file);
    }
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }

  // 2) Env var contents (raw JSON or base64)
  let raw = process.env.FOREMAN_SA_JSON;
  if (raw) {
    raw = raw.trim();
    if (!raw.startsWith('{')) {
      try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch {}
    }
    return raw;
  }

  // 3) Conventional bundled location for installed app
  const bundled = path.join((process.resourcesPath || path.dirname(process.execPath)), 'app', 'config', 'service-account.json');
  if (fs.existsSync(bundled)) return fs.readFileSync(bundled, 'utf8');

  // 4) Dev-time fallbacks
  const devCands = [
    path.resolve(process.cwd(), 'config', 'service-account.json'),
    path.resolve(process.cwd(), '..', 'config', 'service-account.json'),
  ];
  for (const p of devCands) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }

  return null;
}

function readServiceAccount() {
  const rawIn = findServiceAccountJson();
  if (!rawIn) throw new Error('Missing FOREMAN_SA_JSON or FOREMAN_SA_JSON_FILE (and no config/service-account.json found)');
  let raw = rawIn.trim();
  if (!raw.startsWith('{')) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch {}
  }
  const sa = JSON.parse(raw);
  if (sa.private_key && sa.private_key.includes('\\n')) {
    sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  }
  return sa;
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    sub: sa.client_email,
    scope: 'https://www.googleapis.com/auth/bigquery',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  const sig = signer.sign(sa.private_key);
  const assertion = `${input}.${b64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`token ${res.status} ${t}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function bqQuery(projectId, sql, params = {}) {
  const sa = readServiceAccount();
  const token = await getAccessToken(sa);

  const queryParameters = Object.entries(params).map(([name, { type, value }]) => ({
    name,
    parameterType: { type },
    parameterValue: { value: String(value) }
  }));

  const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/queries`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      useLegacySql: false,
      parameterMode: 'NAMED',
      query: sql,
      queryParameters
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`BQ ${res.status} ${t}`);
  }

  const data = await res.json();

  const fields = (data.schema?.fields || []).map(f => f.name);
  const rows = (data.rows || []).map(r => {
    const o = {};
    r.f.forEach((cell, idx) => { o[fields[idx]] = cell?.v ?? null; });
    return o;
  });

  return rows;
}

function tablePath() {
  const explicit = (process.env.FOREMAN_BQ_TABLE || '').trim();
  if (explicit) return explicit;
  const name = (process.env.CUSTOMER_NAME || '').trim();
  if (!name) throw new Error('CUSTOMER_NAME or FOREMAN_BQ_TABLE not set');
  return `foreman-production.foreman_customer_access.${name}`;
}

// default: 30 days
function tsStartMicros() {
  const hours = Number(process.env.FOREMAN_LOOKUP_HOURS || '720');
  const ms = Math.max(1, hours) * 60 * 60 * 1000;
  return (Date.now() - ms) * 1000; // microseconds
}

const COLSETS = [
  { s: 'miner_serial',  m: 'miner_mac',   i: 'miner_ip' },
  { s: 'serial',        m: 'mac',         i: 'ip' },
  { s: 'serial_number', m: 'mac_address', i: 'ip_address' },
  { s: 'device_serial', m: 'mac_addr',    i: 'ip_addr' },
  { s: 'asset_serial',  m: 'macaddr',     i: 'ipaddr' },
  { s: 'miner_sno',     m: 'miner_mac',   i: 'miner_ip' },
];

function normalizeMac(mac) {
  if (!mac) return null;
  if (/^[0-9a-f]{12}$/i.test(mac)) return mac.match(/.{1,2}/g).join(':').toLowerCase();
  return mac.replace(/-/g, ':').toLowerCase();
}

async function tryColumnSets(projectId, table, serialUpper, startMicros) {
  for (const c of COLSETS) {
    const q1 = `
      SELECT
        CAST(${c.s} AS STRING) AS serial,
        LOWER(REPLACE(CAST(${c.m} AS STRING), '-', ':')) AS mac,
        CAST(${c.i} AS STRING) AS ip
      FROM \`${table}\`
      WHERE UPPER(CAST(${c.s} AS STRING)) = @serial
        AND timestamp >= TIMESTAMP_MICROS(@tsStart)
      ORDER BY timestamp DESC
      LIMIT 1
    `;
    try {
      const rows1 = await bqQuery(projectId, q1, {
        serial:  { type: 'STRING', value: serialUpper },
        tsStart: { type: 'INT64',  value: startMicros }
      });
      if (rows1.length) return { row: rows1[0], via: { table, columns: c, mode: 'columns+ts+order' } };
    } catch {}

    const q2 = `
      SELECT
        CAST(${c.s} AS STRING) AS serial,
        LOWER(REPLACE(CAST(${c.m} AS STRING), '-', ':')) AS mac,
        CAST(${c.i} AS STRING) AS ip
      FROM \`${table}\`
      WHERE UPPER(CAST(${c.s} AS STRING)) = @serial
      LIMIT 1
    `;
    try {
      const rows2 = await bqQuery(projectId, q2, {
        serial: { type: 'STRING', value: serialUpper }
      });
      if (rows2.length) return { row: rows2[0], via: { table, columns: c, mode: 'columns' } };
    } catch {}
  }
  return null;
}

async function tryJsonScan(projectId, table, serialUpper, startMicros) {
  const q1 = `
    WITH src AS (
      SELECT TO_JSON_STRING(t) AS js
      FROM \`${table}\` t
      WHERE t.timestamp >= TIMESTAMP_MICROS(@tsStart)
        AND REGEXP_CONTAINS(UPPER(TO_JSON_STRING(t)), @serial)
      LIMIT 10
    )
    SELECT
      COALESCE(
        REGEXP_EXTRACT(js, r'(?i)"miner_serial"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)"serial_number"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)"device_serial"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)"asset_serial"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)"serial"\\s*:\\s*"([^"]+)"')
      ) AS serial,
      LOWER(COALESCE(
        REGEXP_EXTRACT(js, r'(?i)"miner_mac"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)"mac_address"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)"network_mac"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)"mac"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)([0-9A-F]{2}(?:[:-][0-9A-F]{2}){5})')
      )) AS mac,
      COALESCE(
        REGEXP_EXTRACT(js, r'(?i)"miner_ip"\\s*:\\s*"(\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b)"'),
        REGEXP_EXTRACT(js, r'(?i)"ip_address"\\s*:\\s*"(\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b)"'),
        REGEXP_EXTRACT(js, r'(?i)"network_ip"\\s*:\\s*"(\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b)"'),
        REGEXP_EXTRACT(js, r'(?i)"ip"\\s*:\\s*"(\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b)"'),
        REGEXP_EXTRACT(js, r'(?i)\\b((?:\\d{1,3}\\.){3}\\d{1,3})\\b')
      ) AS ip
    FROM src
    LIMIT 1
  `;
  try {
    const r1 = await bqQuery(projectId, q1, {
      serial:  { type: 'STRING', value: serialUpper },
      tsStart: { type: 'INT64',  value: startMicros }
    });
    if (r1.length) return normalizeJsonHit(r1[0], table, 'json+ts');
  } catch {}

  const q2 = `
    WITH src AS (
      SELECT TO_JSON_STRING(t) AS js
      FROM \`${table}\` t
      WHERE REGEXP_CONTAINS(UPPER(TO_JSON_STRING(t)), @serial)
      LIMIT 10
    )
    SELECT
      COALESCE(
        REGEXP_EXTRACT(js, r'(?i)"miner_serial"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)"serial_number"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)"device_serial"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)"asset_serial"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)"serial"\\s*:\\s*"([^"]+)"')
      ) AS serial,
      LOWER(COALESCE(
        REGEXP_EXTRACT(js, r'(?i)"miner_mac"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)"mac_address"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)"network_mac"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)"mac"\\s*:\\s*"([^"]+)"'),
        REGEXP_EXTRACT(js, r'(?i)([0-9A-F]{2}(?:[:-][0-9A-F]{2}){5})')
      )) AS mac,
      COALESCE(
        REGEXP_EXTRACT(js, r'(?i)"miner_ip"\\s*:\\s*"(\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b)"'),
        REGEXP_EXTRACT(js, r'(?i)"ip_address"\\s*:\\s*"(\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b)"'),
        REGEXP_EXTRACT(js, r'(?i)"network_ip"\\s*:\\s*"(\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b)"'),
        REGEXP_EXTRACT(js, r'(?i)"ip"\\s*:\\s*"(\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b)"'),
        REGEXP_EXTRACT(js, r'(?i)\\b((?:\\d{1,3}\\.){3}\\d{1,3})\\b')
      ) AS ip
    FROM src
    LIMIT 1
  `;
  try {
    const r2 = await bqQuery(projectId, q2, {
      serial: { type: 'STRING', value: serialUpper }
    });
    if (r2.length) return normalizeJsonHit(r2[0], table, 'json');
  } catch {}

  return null;
}

function normalizeJsonHit(r, table, mode) {
  return {
    row: {
      serial: r.serial || null,
      mac: normalizeMac(r.mac || null),
      ip: r.ip || null
    },
    via: { table, mode }
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const serialRaw = String(searchParams.get('serial') || '').trim();
    if (!serialRaw) return NextResponse.json({ error: 'serial required' }, { status: 400 });

    const serialUpper = serialRaw.toUpperCase();
    const sa = readServiceAccount();
    const projectId = sa.project_id;
    const table = tablePath();
    const startMicros = tsStartMicros();

    const direct = await tryColumnSets(projectId, table, serialUpper, startMicros);
    if (direct?.row) {
      const { row, via } = direct;
      return NextResponse.json(
        { serial: row.serial || serialUpper, mac: normalizeMac(row.mac), ip: row.ip || null, via },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const scanned = await tryJsonScan(projectId, table, serialUpper, startMicros);
    if (scanned?.row) {
      const { row, via } = scanned;
      return NextResponse.json(
        { serial: row.serial || serialUpper, mac: row.mac, ip: row.ip, via },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(
      { error: 'not found', table, note: 'no match via column sets or json scan' },
      { status: 404 }
    );
  } catch (e) {
    return NextResponse.json({ error: e?.message || 'lookup failed' }, { status: 500 });
  }
}
