'use client';

import { useCallback, useMemo, useEffect } from 'react';
import ItemsTable from '@/components/ItemsTable';
import Toolbar from '@/components/Toolbar';
import { useItemsStore } from '@/lib/store';
import {
  initForemanAutoSync,
  queueAdd as queueForemanLookup,
  cacheGet,
  processQueue,
} from '@/lib/foreman-sync';

function normalizeSerial(s) {
  return String(s || '').trim().replace(/\s+/g, '').toUpperCase();
}

// Build tab text
function buildTabText(items) {
  return items
    .map((it) => [it.serial, it.mac || '', it.ip || '', it.location || ''].join('\t'))
    .join('\n');
}

export default function Page() {
  const { items, loading, addItem, updateItem, removeItem, clearAll } = useItemsStore();

  const addSerial = useCallback(
    async (raw) => {
      const serial = normalizeSerial(raw);
      if (!serial) return;

      const exists = items.some((it) => normalizeSerial(it.serial) === serial);
      if (exists) {
        alert(`Duplicate serial:\n\n${serial}`);
        return;
      }

      // 1) Add immediately (offline-friendly)
      addItem(serial);

      // 2) Enrich from cache if present; otherwise enqueue and (if online) process now
      const cached = cacheGet(serial);
      if (cached) {
        updateItem(serial, cached);
      } else {
        queueForemanLookup(serial);
        processQueue({ onUpdate: (s, patch) => updateItem(s, patch) });
      }
    },
    [items, addItem, updateItem]
  );

  const bulkAdd = useCallback(
    async (lines) => {
      const dups = [];
      for (const line of lines) {
        const s = normalizeSerial(line);
        if (!s) continue;
        const exists = items.some((it) => normalizeSerial(it.serial) === s);
        if (exists) dups.push(s);
        else await addSerial(s);
      }
      if (dups.length) {
        alert(`Duplicate serial(s) skipped:\n\n${Array.from(new Set(dups)).join('\n')}`);
      }
    },
    [items, addSerial]
  );

  const downloadTxt = useCallback(() => {
    if (!items.length) return;
    const payload = buildTabText(items);
    const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scanned-items.txt';
    a.click();
    URL.revokeObjectURL(url);
  }, [items]);

  const copyTxt = useCallback(async () => {
    if (!items.length) return;
    const payload = buildTabText(items);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        const ta = document.createElement('textarea');
        ta.value = payload;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      alert(`Copied ${items.length} row(s) to clipboard.`);
    } catch {
      alert('Copy failed. You can still use download.');
    }
  }, [items]);

  // Auto-sync Foreman when online or when tab becomes visible
  useEffect(() => {
    const stop = initForemanAutoSync({
      onUpdate: (serial, patch) => updateItem(serial, patch),
      getItems: () => items,
    });
    return () => stop && stop();
  }, [items, updateItem]);

  const count = useMemo(() => items.length, [items]);

  return (
    <main className="max-w-7xl mx-auto p-4 md:p-8 space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">Offline Barcode Scanner</h1>
        <div className="text-sm text-gray-600">
          Items: <span className="font-semibold">{count}</span>
        </div>
      </header>

      <section className="space-y-4">
        <Toolbar onAddSerial={addSerial} onBulkAdd={bulkAdd} />

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Queue</h2>
            <button className="text-sm text-red-600 hover:underline" onClick={clearAll}>
              Clear all
            </button>
          </div>

          {loading ? (
            <div className="p-6 text-gray-500">Loading…</div>
          ) : (
            <>
              <div className="rounded-xl border">
                <ItemsTable items={items} onUpdate={updateItem} onRemove={removeItem} />
              </div>

              {items.length > 0 && (
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className="px-3 py-2 rounded-md border"
                    onClick={copyTxt}
                    title="Copy tab-delimited text"
                  >
                    copy
                  </button>
                  <button
                    type="button"
                    className="px-3 py-2 rounded-md border"
                    onClick={downloadTxt}
                    title="Download tab-delimited text"
                  >
                    download
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <footer className="pt-2 text-xs text-gray-500">
        Optimized for USB wedge scanners. Works offline and enriches when back online.
      </footer>
    </main>
  );
}
