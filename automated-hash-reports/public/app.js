// public/app.js

// Formatters
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const el = (id) => document.getElementById(id);
const setText = (id, v) => { const n = el(id); if (n) n.textContent = v; };
const setIf = (node, fn) => { if (node) fn(node); };

const fmtPH = (x) => (x == null ? '—' : nf2.format(Number(x)));
const fmtInt = (x) => (x == null ? '—' : nf0.format(Number(x)));
const fmtPct = (x) => (x == null ? '—' : nf2.format(Number(x)) + '%');
const fmt3  = (x) => (x == null ? '—' : Number(x).toFixed(3));

function ts(x) {
  if (!x) return '(data pending)';
  const v = typeof x === 'string' ? x : (x && x.value !== undefined ? x.value : x);
  const d = new Date(v);
  return isNaN(d) ? '(data pending)' : d.toLocaleString();
}

const keepBox = (g) => /^[AM]B\d+/i.test(String(g || ''));

// Bitmain fixed capacities (Space Available)
const BM_SPACE_CAP = Object.freeze({
  MB06: 686,
  MB07: 336,
  MB08: 686,
  MB09: 350,
  MB10: 672,
  MB11: 700,
  MB12: 686,
  MB13: 336,
  MB17: 700,
  MB18: 700,
  MB19: 626,
  MB20: 672,
  MB21: 672,
  MB22: 672,
  MB23: 336,
});

// Manifest + base path
async function fetchManifest() {
  try {
    const r = await fetch('/reports/index.json', { cache: 'no-cache' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
function currentReportBaseFromPath() {
  const m = location.pathname.match(/^\/reports\/[^/]+\/$/);
  return m ? m[0] : null;
}
function reportJsonUrl(base) {
  if (window.__REPORT_FETCH_BASE__) {
    const b = window.__REPORT_FETCH_BASE__;
    return b.endsWith('/') ? (b + 'hash-report.json') : (b + '/hash-report.json');
  }
  if (base) return base + 'hash-report.json';
  return './hash-report.json';
}
function setActiveReportLabel(label) {
  const n = el('active-report-label');
  setIf(n, (node) => { node.textContent = `· ${label}`; });
}
function wireReportPicker(manifest) {
  const sel = el('report-picker');
  if (!sel) return;
  if (!manifest?.reports?.length) {
    sel.innerHTML = '<option value="">No reports found</option>';
    return;
  }
  sel.innerHTML = '';
  manifest.reports.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = r.path;
    opt.textContent = r.label || r.path;
    if (currentReportBaseFromPath() === r.path) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => { if (sel.value) location.href = sel.value; });
}

// Renderers
function renderHeader(d) {
  const safeNum = (v) => (v === null || v === undefined ? null : Number(v));
  const pick = (...vals) => vals.find(v => v !== undefined && v !== null);

  setText('last-updated', `Last updated: ${ts(d.generatedAt)}`);

  setText('total-current', fmtPH(safeNum(d?.overall?.current_phs)));
  setText('total-avg24',   fmtPH(safeNum(d?.overall?.avg24_phs)));

  const bmCurTotal = safeNum(d?.bitmain?.current?.total);
  const bmAvgTotal = safeNum(d?.bitmain?.avg24?.total);
  setText('bitmain-current', fmtPH(bmCurTotal));
  setText('bitmain-avg24',   fmtPH(bmAvgTotal));
  setText('bitmain-current-dup', fmtPH(bmCurTotal));
  setText('bitmain-avg24-dup',   fmtPH(bmAvgTotal));

  const kjCur = safeNum(pick(d?.bitmain?.current?.kjdga, d?.bitmain?.current?.kjdga_phs, d?.bitmain?.current?.KJDGA));
  const kjAvg = safeNum(pick(d?.bitmain?.avg24?.kjdga,   d?.bitmain?.avg24?.kjdga_phs,   d?.bitmain?.avg24?.KJDGA));
  setText('bm-kjdga-current', fmtPH(kjCur));
  setText('bm-kjdga-avg24',   fmtPH(kjAvg));

  // KJDGA efficiency:
  let kjEff = safeNum(d?.bitmain?.kjdga_efficiency_pct);
  if (kjEff == null || !isFinite(kjEff) || kjEff > 200) {
    let kjThs = kjCur;
    if (kjThs != null && isFinite(kjThs)) {
      if (kjThs > 10) kjThs = kjThs / 1000;
      kjEff = (kjThs / 1.24) * 100;
    } else {
      kjEff = null;
    }
  }
  setText('bm-kjdga-efficiency', fmtPct(kjEff));

  setText('syl-antpool-current',   fmtPH(safeNum(d?.sylvania?.current?.antpool)));
  setText('syl-antpool-avg24',     fmtPH(safeNum(d?.sylvania?.avg24?.antpool)));
  setText('syl-blockware-current', fmtPH(safeNum(d?.sylvania?.current?.blockware)));
  setText('syl-blockware-avg24',   fmtPH(safeNum(d?.sylvania?.avg24?.blockware)));
}

function renderTable(tbodyId, totalsPrefix, src) {
  const tbody = el(tbodyId);
  if (!tbody) return null;
  tbody.innerHTML = '';

  const rows = (src?.rows || [])
    .filter(r => keepBox(r.group || r.sitemap_group_name))
    .sort((a, b) => {
      const ax = String(a.group || a.sitemap_group_name || '');
      const bx = String(b.group || b.sitemap_group_name || '');
      const na = parseInt((ax.match(/^[A-Z]{2}(\d+)/i) || [])[1] || '0', 10);
      const nb = parseInt((bx.match(/^[A-Z]{2}(\d+)/i) || [])[1] || '0', 10);
      if (na !== nb) return na - nb;
      return ax.localeCompare(bx);
    });

  const isBM = String(totalsPrefix || '').toLowerCase().startsWith('bm-');

  rows.forEach((r) => {
    const group      = r.group || r.sitemap_group_name || '—';
    const deployed   = r.deployed ?? null;
    const reachable  = r.reachable ?? null;
    const hashing    = r.hashing ?? null;
    const notHashing = r.not_hashing ?? ((reachable != null && hashing != null) ? (reachable - hashing) : null);

    let effPct = r.efficiency_pct;
    if (effPct == null) {
      effPct = isBM
        ? (reachable ? (hashing / reachable * 100) : null)     // Bitmain uptime
        : (deployed  ? (hashing / deployed  * 100) : null);     // BCS efficiency
    }

    // Build row cells; insert Space Available ONLY for Bitmain
    let cells = '';
    cells += '<td class="px-4 py-3">' + group + '</td>';

    if (isBM) {
      const cap = BM_SPACE_CAP[String(group).toUpperCase()];
      cells += '<td class="px-4 py-3 text-right">' + fmtInt(cap ?? null) + '</td>';
    }

    cells += '<td class="px-4 py-3 text-right">' + fmtInt(deployed)   + '</td>';
    cells += '<td class="px-4 py-3 text-right">' + fmtInt(reachable)  + '</td>';
    cells += '<td class="px-4 py-3 text-right">' + fmtInt(notHashing) + '</td>';
    cells += '<td class="px-4 py-3 text-right">' + fmtInt(hashing)    + '</td>';
    cells += '<td class="px-4 py-3 text-right">' + fmtPct(effPct)     + '</td>';

    const tr = document.createElement('tr');
    tr.innerHTML = cells;
    tbody.appendChild(tr);
  });

  const t = src?.totals;
  if (t) {
    const eff = isBM
      ? (t.reachable ? (t.hashing / t.reachable * 100) : null) // uptime
      : (t.deployed  ? (t.hashing / t.deployed  * 100) : null);

    // Standard totals
    setText(`${totalsPrefix}-deployed`,  fmtInt(t.deployed));
    setText(`${totalsPrefix}-reachable`, fmtInt(t.reachable));
    setText(`${totalsPrefix}-nh`,        fmtInt(t.not_hashing ?? ((t.reachable != null && t.hashing != null) ? (t.reachable - t.hashing) : null)));
    setText(`${totalsPrefix}-h`,         fmtInt(t.hashing));
    setText(`${totalsPrefix}-eff`,       fmtPct(eff));

    // Bitmain footer placeholder for Space Available
    if (isBM) {
      const n = el(`${totalsPrefix}-space`);
      if (n) n.textContent = '—';
    }
    return eff;
  }
  return null;
}

function renderPowerCost(d) {
  const pc = d?.powerCost;
  if (!pc) {
    setText('power-min','—'); setText('power-max','—'); setText('power-stamp','');
    return;
  }
  setText('power-min', fmt3(pc.min_cents_kwh));
  setText('power-max', fmt3(pc.max_cents_kwh));

  const dt = pc.fetchedAt ? new Date(pc.fetchedAt) : null;
  const stamp = (dt && !isNaN(dt)) ? ('As of ' + dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) : '';
  setText('power-stamp', stamp);
}

function renderWeatherFromJSON(d) {
  const wx = d?.weather?.sylvania?.sylvania || d?.weather?.sylvania;

  if (!wx || wx.error) {
    setText('weather-current-temp', '—');
    setText('weather-humidity', '—');
    setText('weather-high-temp', '—');
    setText('weather-high-window', '—');
    setText('weather-conditions-line', '—');
    setText('weather-stamp', '');
    return { points: [] };
  }

  const curF = wx.current?.temperature_f;
  const hum  = wx.current?.humidity_pct;
  const hiF  = wx.today?.high_f;
  const win  = wx.today?.high_time_window_local || '—';
  const label = wx.today?.label || wx.current?.label || '—';

  setText('weather-current-temp', (curF == null ? '—' : String(Math.round(curF))));
  setText('weather-humidity',     (hum  == null ? '—' : String(Math.round(hum))));
  setText('weather-high-temp',    (hiF  == null ? '—' : String(Math.round(hiF))));
  setText('weather-high-window',  win);
  setText('weather-conditions-line', `${label} | High of ${hiF == null ? '—' : Math.round(hiF)}°F`);

  const gen = wx.generatedAt ? new Date(wx.generatedAt) : null;
  const stamp = (gen && !isNaN(gen)) ? ('As of ' + gen.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) : '';
  setText('weather-stamp', stamp);

  return { points: wx.hourly?.points || [] };
}

let weatherChart;
function buildWeatherChart(points) {
  const canvas = document.getElementById('weatherChart');
  if (!canvas || !Array.isArray(points) || points.length < 2) return;

  if (weatherChart) { weatherChart.destroy(); weatherChart = null; }

  const labels = points.map(p => p.label_local);
  const temps  = points.map(p => p.temp_f);

  weatherChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Temp °F',
        data: temps,
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2,
        segment: {
          borderDash: (ctx) => {
            const i1 = ctx.p1DataIndex;
            return points[i1] && points[i1].forecast ? [6, 6] : undefined;
          }
        }
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 150,
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } }, y: { beginAtZero: false } }
    }
  });
}

function formatDowDateTime(isoish) {
  const v = typeof isoish === 'string' ? isoish : (isoish && isoish.value !== undefined ? isoish.value : isoish);
  const d = new Date(v);
  if (isNaN(d)) return '';
  const dow  = d.toLocaleDateString('en-US', { weekday: 'long' });
  const date = d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${dow}, ${date}, ${time}`;
}

function renderHeaderStamp(d) {
  const stamp = formatDowDateTime(d?.generatedAt || d?.currentSnapshotTs) || '';
  setText('now-stamp', stamp);
}

function filenameFromReport(d) {
  const raw = d?.generatedAt;
  const dt = raw ? new Date(raw) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const y = dt.getFullYear();
  const m = pad(dt.getMonth() + 1);
  const day = pad(dt.getDate());
  return `hash-report-${y}-${m}-${day}.pdf`;
}

async function exportPDF(d) {
  const root = document.getElementById('page-root');
  if (!root || typeof html2pdf === 'undefined') return;
  const filename = filenameFromReport(d);
  const opt = {
    margin: [0.3, 0.4, 0.3, 0.4],
    filename,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, logging: false, windowWidth: document.documentElement.scrollWidth },
    jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
    pagebreak: { mode: ['css', 'legacy'], avoid: 'tr, .no-break' }
  };
  await html2pdf().from(root).set(opt).save();
}

function fileDateFromGeneratedAt(d) {
  const iso = d?.generatedAt ? new Date(d.generatedAt) : null;
  if (!iso || isNaN(iso)) return 'unknown-date';
  const y = iso.getFullYear();
  const m = String(iso.getMonth() + 1).padStart(2, '0');
  const dd = String(iso.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function naturalSortGroups(a, b) {
  const na = parseInt(String(a).match(/^[A-Z]{2}(\d+)/i)?.[1] ?? '0', 10);
  const nb = parseInt(String(b).match(/^[A-Z]{2}(\d+)/i)?.[1] ?? '0', 10);
  if (na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

function buildIssuesText(silo, groupsMap) {
  const isBCS = silo === 'bcs';
  const title = isBCS ? 'BCS Issues (Foreman Positions)' : 'BM Issues (Foreman Positions)';
  const site  = isBCS ? 'BCS' : 'BM';

  const lines = [title, '', site, ''];
  const groupNames = Object.keys(groupsMap || {}).sort(naturalSortGroups);

  if (groupNames.length === 0) { lines.push('(no groups found)'); return lines.join('\n'); }

  for (const grp of groupNames) {
    lines.push(grp);
    const arr = groupsMap[grp] || [];
    if (arr.length === 0) { lines.push(''); continue; }
    for (const item of arr) {
      const pos = item.position || 'R?.S?.P?';
      const ip  = item.ip || 'unknown-ip';
      const mac = item.mac || 'unknown-mac';
      lines.push(`\t${pos} / ${ip} / ${mac}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function wireIssuesButtons(reportJson) {
  const by = reportJson?.foreman?.issuesByGroup || {};
  const bcsBtn = document.getElementById('btn-bcs-issues');
  const bmBtn  = document.getElementById('btn-bm-issues');
  const dateTag = fileDateFromGeneratedAt(reportJson);

  const bcsFilename = `bcs-issues-${dateTag}.txt`;
  const bmFilename  = `bm-issues-${dateTag}.txt`;

  if (bcsBtn) bcsBtn.addEventListener('click', () => {
    const text = buildIssuesText('bcs', by.bcs || {});
    downloadText(bcsFilename, text);
  });
  if (bmBtn) bmBtn.addEventListener('click', () => {
    const text = buildIssuesText('bm', by.bm || {});
    downloadText(bmFilename, text);
  });
}

// Bootstrap
async function bootstrap() {
  const manifest = await fetchManifest();
  if (manifest?.reports?.length) {
    wireReportPicker(manifest);
  } else {
    const sel = el('report-picker');
    if (sel) sel.innerHTML = '<option value="">No reports found</option>';
  }

  let base = currentReportBaseFromPath();
  let activeLabel = null;

  if (!base) {
    if (manifest?.reports?.length) {
      base = manifest.reports[0].path;
      activeLabel = manifest.reports[0].label || null;
      try { history.replaceState(null, '', base); } catch {}
    } else {
      base = null;
    }
  } else if (manifest?.reports) {
    const match = manifest.reports.find(r => r.path === base);
    activeLabel = match?.label || null;
  }
  if (activeLabel) setActiveReportLabel(activeLabel);

  const url = reportJsonUrl(base);
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const d = await res.json();
  window.__hashReport = d;

  renderHeaderStamp(d);
  renderHeader(d);
  renderPowerCost(d);
  wireIssuesButtons(d);

  const sylEff = renderTable('tbl-syl', 'syl-t', d.tables?.sylvania);
  const bmEff  = renderTable('tbl-bm',  'bm-t',  d.tables?.bitmain);

  if (sylEff != null) setText('syl-total-eff', fmtPct(sylEff));
  const blk = d.tables?.sylvania?.blockware_efficiency_pct;
  setText('syl-blockware-eff', (blk == null ? '—' : fmtPct(blk)));

  if (bmEff != null) {
    setText('bm-eff', fmtPct(bmEff));
    setText('bm-total-eff', fmtPct(bmEff));
  }

  const { points } = renderWeatherFromJSON(d);
  buildWeatherChart(points);

  const btn = document.getElementById('btn-export-pdf');
  if (btn) btn.addEventListener('click', () => exportPDF(window.__hashReport));
}

bootstrap().catch(e => {
  console.error(e);
  setText('last-updated', 'Last updated: (error loading data)');
});
