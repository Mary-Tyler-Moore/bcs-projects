'use client';

import { useEffect, useMemo, useState } from 'react';

// Parse "R## S## P##" → preserves leading zeros
function parseLocation(str) {
  const m = String(str || '').match(/R(\d{1,2})\s*S(\d{1,2})\s*P(\d{1,2})/i);
  return {
    r: m?.[1] ?? '',
    s: m?.[2] ?? '',
    p: m?.[3] ?? '',
  };
}

// Build "R{r} S{s} P{p}"
function formatLocation(r, s, p) {
  return `R${String(r ?? '')} S${String(s ?? '')} P${String(p ?? '')}`.trim();
}

// Keep only digits (max 2)
function digits(x, max = 2) {
  return String(x || '').replace(/\D/g, '').slice(0, max);
}

export default function ItemsTable({ items, onUpdate, onRemove }) {
  // local map: serial -> { r, s, p }
  const [locMap, setLocMap] = useState({});

  // Initialize/merge local map whenever items change.
  useEffect(() => {
    setLocMap((prev) => {
      const next = {};
      for (const it of items) {
        next[it.serial] = prev[it.serial] ?? parseLocation(it.location);
      }
      return next;
    });
  }, [items]);

  const sorted = useMemo(() => items, [items]);

  // Update a single field for a row (R/S/P)
  function updateLoc(serial, field, rawValue) {
    const curr =
      locMap[serial] ?? parseLocation(items.find((x) => x.serial === serial)?.location);
    const next = { ...curr, [field]: digits(rawValue, 2) };

    // 1) update local UI state
    setLocMap((prev) => ({ ...prev, [serial]: next }));

    // 2) push combined string up to parent/store
    onUpdate(serial, { location: formatLocation(next.r, next.s, next.p) });
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed text-sm">
        <thead className="bg-gray-100 text-gray-700">
          <tr>
            <th className="text-left pr-2 pl-2 py-2 w-[24%]">Serial</th>
            <th className="text-left pl-1 pr-8 py-2 w-[24%]">Location</th>
            <th className="text-left pl-4 pr-2 py-2 w-[30%]">MAC</th>
            <th className="text-left px-2 py-2 w-[22%]">IP</th>
            <th className="px-2 py-2 w-[10%]">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((it) => {
            const loc = locMap[it.serial] ?? parseLocation(it.location);

            return (
              <tr key={it.serial} className="border-t">
                <td className="pl-2 py-2 font-mono whitespace-nowrap truncate" title={it.serial}>
                  {it.serial}
                </td>

                <td className="pr-10 py-2">
                  <div className="flex items-center gap-1">
                    <div className="flex items-center gap-1">
                      <span className="text-gray-600">R</span>
                      <input
                        type="text"
                        className="border rounded-md px-2 py-1 w-10 text-center font-mono"
                        value={loc.r}
                        onChange={(e) => updateLoc(it.serial, 'r', e.target.value)}
                        inputMode="numeric"
                        pattern="\d{0,2}"
                        maxLength={2}
                        placeholder="0"
                        aria-label="Row"
                        title="Row (00–99)"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-gray-600">S</span>
                      <input
                        type="text"
                        className="border rounded-md px-2 py-1 w-10 text-center font-mono"
                        value={loc.s}
                        onChange={(e) => updateLoc(it.serial, 's', e.target.value)}
                        inputMode="numeric"
                        pattern="\d{0,2}"
                        maxLength={2}
                        placeholder="0"
                        aria-label="Shelf"
                        title="Shelf (00–99)"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-gray-600">P</span>
                      <input
                        type="text"
                        className="border rounded-md px-2 py-1 w-12 text-center font-mono"
                        value={loc.p}
                        onChange={(e) => updateLoc(it.serial, 'p', e.target.value)}
                        inputMode="numeric"
                        pattern="\d{0,2}"
                        maxLength={2}
                        placeholder="0"
                        aria-label="Position"
                        title="Position (00–99)"
                      />
                    </div>
                  </div>
                </td>

                <td className="pl-4 pr-2 py-2">
                  <input
                    type="text"
                    className="border rounded-md px-2 py-1 font-mono w-[11rem] max-w-full"
                    value={it.mac || ''}
                    onChange={(e) => onUpdate(it.serial, { mac: e.target.value })}
                    placeholder="MAC"
                  />
                </td>

                <td className="px-2 py-2">
                  <input
                    type="text"
                    className="border rounded-md px-2 py-1 font-mono w-[10rem] max-w-full"
                    value={it.ip || ''}
                    onChange={(e) => onUpdate(it.serial, { ip: e.target.value })}
                    placeholder="IP"
                  />
                </td>

                <td className="px-2 py-2 text-right">
                  <button
                    className="text-red-600 hover:underline"
                    onClick={() => onRemove(it.serial)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}

          {sorted.length === 0 && (
            <tr>
              <td className="px-3 py-6 text-center text-gray-500" colSpan={5}>
                No items yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
