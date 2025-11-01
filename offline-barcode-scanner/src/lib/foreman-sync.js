'use client';

// Offline-first Foreman enrichment (via BigQuery API)

const QKEY = 'foremanQueueV1';
const CKEY = 'foremanCacheV1';
const TTL_MS = 1000 * 60 * 60 * 24 * 7;

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function normSerial(s) {
  return String(s || '').trim().toUpperCase();
}

export function cacheGet(serial) {
  const s = normSerial(serial);
  const cache = readJSON(CKEY, {});
  const hit = cache[s];
  if (!hit) return null;
  if (Date.now() - (hit.ts || 0) > TTL_MS) return null;
  return { mac: hit.mac || null, ip: hit.ip || null };
}

export function cachePut(serial, mac, ip) {
  const s = normSerial(serial);
  const cache = readJSON(CKEY, {});
  cache[s] = { mac: mac || null, ip: ip || null, ts: Date.now() };
  writeJSON(CKEY, cache);
}

export function queueAdd(serial) {
  const s = normSerial(serial);
  if (!s) return;
  if (cacheGet(s)) return;
  const q = new Set(readJSON(QKEY, []));
  q.add(s);
  writeJSON(QKEY, Array.from(q));
}

export function queueAddMissingFrom(items) {
  for (const it of items || []) {
    const s = normSerial(it?.serial);
    if (!s) continue;
    const needs = !it.mac || !it.ip;
    if (needs && !cacheGet(s)) queueAdd(s);
  }
}

export function queueClear(serial) {
  const s = normSerial(serial);
  const q = new Set(readJSON(QKEY, []));
  q.delete(s);
  writeJSON(QKEY, Array.from(q));
}

// BigQuery-backed lookup route
async function fetchFromBQ(serial) {
  const res = await fetch(`/api/bq/lookup?serial=${encodeURIComponent(serial)}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`bq lookup ${serial} -> ${res.status}`);
  return res.json();
}

export async function processQueue({ onUpdate } = {}) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;

  const q = readJSON(QKEY, []);
  if (!q?.length) return;

  const serials = Array.from(new Set(q));
  for (const s of serials) {
    try {
      const cached = cacheGet(s);
      if (cached) {
        onUpdate?.(s, cached);
        queueClear(s);
        continue;
      }

      const { mac, ip } = await fetchFromBQ(s);
      cachePut(s, mac, ip);
      onUpdate?.(s, { mac, ip });
      queueClear(s);

      await new Promise((r) => setTimeout(r, 200));
    } catch {
      // keep it in queue
    }
  }
}

export function initForemanAutoSync({ onUpdate, getItems } = {}) {
  // seed queue with rows missing data
  try { queueAddMissingFrom(getItems?.() || []); } catch {}

  // try once now
  processQueue({ onUpdate });

  const onOnline = () => processQueue({ onUpdate });
  const onVisible = () => {
    if (document.visibilityState === 'visible') processQueue({ onUpdate });
  };

  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
