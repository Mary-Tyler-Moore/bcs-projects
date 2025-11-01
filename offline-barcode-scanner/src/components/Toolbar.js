'use client';

import { useEffect, useRef, useState } from 'react';

export default function Toolbar({ onAddSerial, onBulkAdd }) {
  const [value, setValue] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const inputRef = useRef(null);
  const bulkRef = useRef(null);

  function addAndRefocus() {
    const v = value.trim();
    if (!v) return;
    onAddSerial?.(v);
    setValue('');
    inputRef.current?.focus(); // keep focus for USB scanners
  }

  function onSubmit(e) {
    e.preventDefault();
    addAndRefocus();
  }

  function submitBulk() {
    const lines = bulkText.split(/\r?\n/);
    onBulkAdd?.(lines);
    setBulkText('');
    setShowBulk(false);
    inputRef.current?.focus();
  }

  useEffect(() => {
    if (showBulk) setTimeout(() => bulkRef.current?.focus(), 0);
  }, [showBulk]);

  return (
    <div className="space-y-3">
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          autoFocus
          id="serial-input"
          placeholder="Click here and scan, or type a serial…"
          className="border rounded-md px-3 py-2 grow min-w-[14rem]"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />

        <button
          type="submit"
          className="px-3 py-2 rounded-md bg-gray-900 text-white"
          title="Add serial"
        >
          Add
        </button>

        <button
          type="button"
          className="px-3 py-2 rounded-md border"
          onClick={() => setShowBulk((v) => !v)}
          title="Bulk add (paste multiple lines)"
        >
          {showBulk ? 'Hide bulk' : 'Bulk add'}
        </button>
      </form>

      {showBulk && (
        <div className="rounded-lg border p-3">
          <label htmlFor="bulk-serials" className="block text-sm font-medium mb-2">
            Paste serial numbers (one per line)
          </label>
          <textarea
            id="bulk-serials"
            ref={bulkRef}
            className="w-full border rounded-md p-2 font-mono"
            rows={8}
            placeholder={`PIEMDXCBBJCAG0117`}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-2 rounded-md bg-gray-900 text-white"
              onClick={submitBulk}
              title="Add all lines"
            >
              Add list
            </button>
            <button
              type="button"
              className="px-3 py-2 rounded-md border"
              onClick={() => setShowBulk(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
