# Issues Report Viewer 

A lightweight, browser‑only tool for operations teams to quickly triage Foreman issue exports. Upload a CSV from Foreman, filter and group issues, and generate a clean to‑do list you can copy, download as `.txt`, or export as a paginated `.pdf`. For spatial context, the report includes a grid‑based mini‑map of each miner’s position within its rack.

Built with vanilla JavaScript, Tailwind (CDN), PapaParse, and html2pdf.js — no backend or build step required. Open `index.html` in a modern browser and work entirely client‑side.

---

## Quick Start

- Open `index.html` in any modern browser.
- Drag and drop a `.csv` file from Foreman, or click “Upload .csv”.
- Use the toolbar to choose position indexing (physical location or Foreman index) and filter which issues to show.
- Copy or download the generated to‑do list as `.txt`, or export a `.pdf` with mini rack maps.

---

## Core Features

- Client‑side CSV parse with PapaParse; no data leaves your browser.
- Filter issues by type and see live counts.
- Generate a clean, printable to‑do list for affected miners.
- Grid‑based mini rack maps to quickly locate each miner physically.
- One‑click copy or download as `.txt` and `.pdf`.

---

## CSV Expectations

The app is tolerant to header naming differences. It looks for:

- Issue: a column that describes the issue type (e.g., “Zero hash rate”, “Missing fan”).
- Group/rack: either a combined `miner_rack` like `MB08 R5`, or a `rack_group`/`group_name` plus a `rack_name` with `R<digits>`.
- Coordinates: headers ending with `row` (shelf) and `index`/`idx` (position), using 0‑ or 1‑based integers.

Headers are normalized before matching:

```js
// index.html (header normalization)
function normalizeRowKeys(row) {
  const out = {};
  for (const [k,v] of Object.entries(row)) {
    const nk = String(k)
      .replace(/^\uFEFF/,'')
      .trim()
      .toLowerCase()
      .replace(/\s+/g,'_');
    out[nk] = v;
  }
  return out;
}
```

---

## How It Works

1) Parse CSV and build in‑memory state

```js
// index.html: parse -> recompute -> render
async function parseCSVText(csvText) {
  const raw = csvText.replace(/^\uFEFF/, '');
  const result = Papa.parse(raw, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false
  });

  state.csvRows = (result.data || []).map(normalizeRowKeys);
  recomputeOpenMap();          // prepares rack occupancy/coordinates
  renderSummaryTable();        // summary UI
  renderPreview();             // printable preview + mini maps
}
```

2) Filter issues via a small toolbar API

```js
// toolbar.js: track active issue filters
const state = {
  positionBase: initial?.positionBase === 0 ? 0 : 1,
  activeFilters: new Set(initialSet),
};

function emitChange() {
  const lowHashSelected = state.activeFilters.has('Hash rate too low');
  window.__LOW_HASH_SHOW_WARN__ = !!lowHashSelected;
  onChange?.({
    positionBase: state.positionBase,
    activeFilters: Array.from(state.activeFilters),
  });
}
```

You can pass the set of issue labels you care about and react to `onChange` to filter what renders in the preview or the to‑do list.

3) Show rack context with a mini grid

```js
// site-map.js: mini rack box with selected cell highlighted
export function createRackBox({ group, rackNumber, row, idx, style = {} }) {
  const key = `${group}.R${rackNumber}`;
  const layout = LAYOUTS[key];
  const cols = layout ? layout.cols : 7;
  const rows = layout ? layout.rows : 12;
  // …construct a grid and mark r===row && c===idx
}
```

4) Export to TXT and PDF

```js
// index.html: download plain text
function doDownloadTXT() {
  const text = buildPlainText();
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, 'issues_todo_list.txt');
}

// index.html: export a paginated PDF with forced light colors
function doDownloadPDF() {
  const element = document.getElementById('preview-plain');
  const opt = { /* margins, html2canvas, jsPDF, pagebreak */ };
  html2pdf().set(opt).from(element).toContainer()
    .get('container', (c) => {
      c.setAttribute('data-force-light','1');
      const style = document.createElement('style');
      style.textContent = '[data-force-light], [data-force-light] * { color:#000 !important; -webkit-text-fill-color:#000 !important; }';
      c.ownerDocument.head.appendChild(style);
      repaintRackBoxes(c, { forceLight: true });
    })
    .toCanvas().toPdf().get('pdf')
    .then((pdf) => { /* add page numbers */ })
    .save();
}
```

---

## Dark Mode

The UI supports a dark theme via Tailwind’s `class` strategy. A small toggle stores preference in `localStorage`, applies the `dark` class on `<html>`, and repaints the rack mini‑maps as needed. PDF export forces light text/colors for print clarity.

Tailwind config loaded before the CDN script:

```js
// tailwind-config.js
window.tailwind = window.tailwind || {};
window.tailwind.config = {
  darkMode: 'class',
  theme: { extend: { colors: { ink: '#0b0d12', panel: '#0f172a', edge: '#1e293b' } } }
};
```

Theme toggle and application:

```js
// index.html (theme toggle)
const root = document.documentElement;
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');

function applyTheme(mode) {
  if (mode === 'dark') {
    root.classList.add('dark');
    themeIcon.textContent = '🌙';
  } else {
    root.classList.remove('dark');
    themeIcon.textContent = '☀️';
  }
  try { localStorage.setItem('theme', mode); } catch {}
  repaintRackBoxes(document, { forceLight: false });
}

applyTheme(
  localStorage.getItem('theme')
  || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark':'light')
);

themeToggle.addEventListener('click', () => {
  applyTheme(root.classList.contains('dark') ? 'light' : 'dark');
});
```

When exporting PDF, a cloned container gets an explicit light stylesheet so printed output is always legible regardless of the on‑screen theme.

---

## Architecture

- `index.html`: UI markup, theme toggle, CSV parsing, state, rendering, and export handlers.
- `site-map.js`: registry of known rack dimensions and utilities to render mini rack maps.
- `toolbar.js`: toolbar with position base and issue filter state; emits `onChange` to the host.
- `issues-time.js`: timestamp helpers for report headers and optional live clock.
- `tailwind-config.js`: Tailwind config injected before the CDN script.

---
