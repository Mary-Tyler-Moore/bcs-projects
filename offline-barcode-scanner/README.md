# Offline Barcode Scanner (Next.js + Electron)

Windows desktop app for scanning miner barcodes offline and enriching each row with MAC and IP from a Foreman BigQuery dataset. Users may also record location as Rack, Shelf, and Position (R/S/P). Works fully offline; when connectivity returns, lookups are queued, fetched, cached, and the UI updates in place.

## Highlights

- Offline‑first UX: scans persist locally (IndexedDB via `idb-keyval`).
- Foreman enrichment: background queue + cache with TTL; automatic sync on reconnect or tab focus.
- Desktop shell: Electron app wrapping a built Next.js UI.
- USB‑scanner friendly: input remains focused to streamline repeated scans; bulk paste supported.

## Quick Start

1) Install dependencies
```bash
npm install
```

2) Configure environment (see `config/.env.example`)
```ini
# .env.local (root)
CUSTOMER_NAME=your_customer_slug
FOREMAN_LOOKUP_HOURS=720
# Either JSON contents or path to a JSON file (supports base64 as well)
FOREMAN_SA_JSON=
```

3) Run in development (Next + Electron)
```bash
npm run dev
```

4) Build Windows installer
```bash
npm run build
```

## Code Snippets

Add a serial (offline‑first), enrich from cache or queue a lookup:

```js
// src/app/page.js
const addSerial = useCallback(async (raw) => {
  const serial = normalizeSerial(raw);
  if (!serial) return;

  const exists = items.some((it) => normalizeSerial(it.serial) === serial);
  if (exists) { alert(`Duplicate serial:\n\n${serial}`); return; }

  // 1) Add immediately (offline-friendly)
  addItem(serial);

  // 2) Enrich now if cached, else enqueue + process
  const cached = cacheGet(serial);
  if (cached) {
    updateItem(serial, cached);
  } else {
    queueForemanLookup(serial);
    processQueue({ onUpdate: (s, patch) => updateItem(s, patch) });
  }
}, [items, addItem, updateItem]);
```

Queue + cache with TTL, and background processing on reconnect/visibility:

```js
// src/lib/foreman-sync.js
const QKEY = 'foremanQueueV1';
const CKEY = 'foremanCacheV1';
const TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export function cacheGet(serial) { /* read cache; respect TTL */ }
export function queueAdd(serial)  { /* add serial if missing */ }

export async function processQueue({ onUpdate } = {}) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  const q = /* unique serials from localStorage */;
  for (const s of q) {
    try {
      const { mac, ip } = await fetch(`/api/bq/lookup?serial=${encodeURIComponent(s)}`).then(r => r.json());
      /* cachePut and onUpdate(s, { mac, ip }) */
    } catch {
      /* keep item in queue */
    }
  }
}
```

USB‑scanner‑friendly input keeps focus after submission; bulk paste supported:

```js
// src/components/Toolbar.js
const inputRef = useRef(null);
function addAndRefocus() {
  const v = value.trim();
  if (!v) return;
  onAddSerial?.(v);
  setValue('');
  inputRef.current?.focus(); // keep focus for USB scanners
}
```

BigQuery lookup reads service account from env or bundled file; normalizes keys:

```js
// src/app/api/bq/lookup/route.js
function readServiceAccount() {
  let raw = process.env.FOREMAN_SA_JSON || findServiceAccountJson();
  if (!raw) throw new Error('Missing credentials');
  if (!String(raw).trim().startsWith('{')) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch {}
  }
  const sa = JSON.parse(String(raw));
  if (sa.private_key?.includes('\\n')) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}
```

Electron window with safe defaults; static asset shim for packaged Next app:

```js
// electron/main.js
function createWindow(urlToLoad) {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    }
  });
  win.loadURL(urlToLoad);
}
```

## Config Notes

- `CUSTOMER_NAME` (or `FOREMAN_BQ_TABLE`) selects the BigQuery table; recent window controlled by `FOREMAN_LOOKUP_HOURS`.
- Credentials can be provided as raw JSON, base64, or a file path (`FOREMAN_SA_JSON_FILE`). See `config/.env.example`.
- Data is persisted locally (IndexedDB). Cache TTL is 7 days.

## Build & Packaging

- `npm run build` builds Next and packages a Windows installer via `electron-builder`.
- Packager bundles `.next`, `public`, and `config` into the app and serves static assets via a lightweight HTTP shim in the main process.

---