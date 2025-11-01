# BCS Projects

A small collection of focused tools that streamline day-to-day operations for BCS. Each folder is a self-contained project with its own README, build/run instructions, and clear scope. Collectively they demonstrate production-minded scheduling, client-only workflows, offline-first UX, and integrations with Foreman/BigQuery.

---

## Repository Structure

### `/automated-hash-reports`

A Node.js app that generates time-stamped hash rate reports and publishes them as versioned static pages. Runs on Vercel, enriches with optional weather and power-cost data, and persists generated assets back to GitHub to avoid runtime filesystem constraints. Cron is scheduled in UTC with a local (America/New_York) DST-safe guard; each run writes `public/hash-report.json` and a snapshot under `public/reports/<timestamp>/` with an HTML viewer and manifest/redirect updates.

**See:** `automated-hash-reports/README.md` for scheduling, EDT/EST handling, page generation, and backfill utilities.

---

### `/issues-report-viewer`

A lightweight, browser-only tool to triage Foreman CSV exports. Open `index.html`, upload a CSV, filter/group issues, and produce a clean to-do list you can copy, download as `.txt`, or export as a paginated `.pdf`. Includes grid-based mini rack maps for spatial context. Built with vanilla JS, Tailwind (CDN), PapaParse, and html2pdf.js — no backend or build step.

**See:** `issues-report-viewer/README.md` for CSV expectations, dark-mode behavior, export details, and file layout.

---

### `/offline-barcode-scanner`

A Windows desktop app (Next.js + Electron) for scanning miner barcodes offline and enriching each row with MAC/IP from a Foreman BigQuery dataset. Scans persist locally (IndexedDB); lookups are queued, cached with TTL, and processed automatically on reconnect or tab focus. Ships a Next UI wrapped by Electron with safe defaults and a simple API route for BigQuery access.

**See:** `offline-barcode-scanner/README.md` for environment setup, queue/cache flow, and build/packaging notes.

---

## How to Review

- Each project is **standalone**. Start by reading the README in that folder, then follow its quick-start.  
- Production considerations are called out inline (e.g., Vercel’s ephemeral FS, DST boundaries, client-side privacy).  
- Code paths are documented with “Key entry points”/“Architecture” sections to speed navigation.

---
