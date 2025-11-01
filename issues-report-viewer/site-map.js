// site-map.js

const LAYOUTS = {};

function registerRack(group, rackNum, maxX, maxY) {
  const cols = maxX + 1;
  const rows = maxY + 1;
  LAYOUTS[`${group}.R${rackNum}`] = { cols, rows };
}

function setRange(group, startR, endR, maxX, maxY) {
  for (let r = startR; r <= endR; r++) {
    registerRack(group, r, maxX, maxY);
  }
}

function set(group, rackNums, maxX, maxY) {
  for (const r of rackNums) {
    registerRack(group, r, maxX, maxY);
  }
}

// AB01.R01-03: (0,0)-(8,7)
setRange('AB01', 1, 3, 8, 7);

// MB01.R01-06: (0,0)-(8,5)
setRange('MB01', 1, 6, 8, 5);

// MB02.R01-06: (0,0)-(8,5)
setRange('MB02', 1, 6, 8, 5);

// MB03.R01-12: (0,0)-(2,4)
setRange('MB03', 1, 12, 2, 4);

// MB05.R01-06: (0,0)-(8,6)
setRange('MB05', 1, 6, 8, 6);

// MB04.R01-12: (0,0)-(6,8)
setRange('MB04', 1, 12, 6, 8);

// MB14 mixed rack sizes
set('MB14', [1, 5, 6, 10], 6, 11);
set('MB14', [2, 4, 7, 9],  6, 8);
set('MB14', [3, 8],        6, 7);

// MB15 mixed rack sizes
set('MB15', [1, 5, 6, 10], 6, 11);
set('MB15', [2, 4, 7, 9],  6, 8);
set('MB15', [3, 8],        6, 7); 

// MB16 mixed
set('MB16', [1, 5, 6, 10], 6, 11);
set('MB16', [2, 4, 7, 9],  6, 8);
set('MB16', [3, 8],        6, 7);

// MB06 mixed rack sizes
set('MB06', [1, 2, 6, 7], 6, 5);
set('MB06', [3, 4, 10],  6, 7);
set('MB06', [5],        6, 6);
set('MB06', [8, 12],    6, 11);
set('MB06', [9, 11],    6, 8);

// MB07 mixed rack sizes
set('MB07', [1, 2, 6, 7], 6, 5);
set('MB07', [3, 4, 5],   6, 7);

// MB08 mixed rack sizes
set('MB08', [1, 2, 6, 7],       6, 5);
set('MB08', [3, 4, 5, 10],     6, 7);
set('MB08', [8],              6, 11);
set('MB08', [9],              6, 8);
set('MB08', [11],             6, 11);

// MB09 mixed rack sizes
set('MB09', [1, 5], 6, 11);
set('MB09', [2, 4], 6, 8);
set('MB09', [3],    6, 7);

// MB10 mixed rack sizes
set('MB10', [1, 2, 6, 7, 8, 9, 13, 14], 6, 5);
set('MB10', [3, 4, 5, 10, 11, 12],      6, 7);

// MB11 mixed rack sizes
set('MB11', [1, 5, 6, 10], 6, 11);
set('MB11', [2, 4, 7, 9],  6, 8);
set('MB11', [3, 8],       6, 7);

// MB12 mixed rack sizes
set('MB12', [1, 5],           6, 11);
set('MB12', [2, 4],           6, 8);
set('MB12', [3, 8, 9, 10],    6, 7);
set('MB12', [6, 7, 11, 12],   6, 5);

// MB13 mixed rack dimensions
set('MB13', [1, 2, 6, 7], 6, 5);
// [3,4,5]   "7 x 8" => (6,7)
set('MB13', [3, 4, 5],    6, 7);

// MB17 mixed rack dimensions
set('MB17', [1, 5, 6, 10], 6, 11);
set('MB17', [2, 4, 7, 9],  6, 8);
set('MB17', [3, 8],       6, 7);

// MB18 mixed rack dimensions
set('MB18', [1, 5, 6, 10], 6, 11);
set('MB18', [2, 4, 7, 9],  6, 8);
set('MB18', [3, 8],       6, 7);

// MB19 mixed rack dimensions
set('MB19', [1, 2, 6, 7, 8, 9, 13, 14], 6, 5);
set('MB19', [3, 4, 5, 10, 11, 12],      6, 7);

// MB20 mixed rack dimensions
set('MB20', [1, 2, 6, 7, 8, 9, 13, 14], 6, 5);
set('MB20', [3, 4, 5, 10, 11, 12],      6, 7);

// MB21 mixed rack dimensions
set('MB21', [1, 2, 6, 7, 8, 9, 13, 14], 6, 5);
set('MB21', [3, 4, 5, 10, 11, 12],      6, 7);

// MB22 mixed rack dimensions
set('MB22', [1, 2, 6, 7, 8, 9, 13, 14], 6, 5);
set('MB22', [3, 4, 5, 10, 11, 12],      6, 7);

// MB23 mixed rack dimensions
set('MB23', [1, 2, 6, 7], 6, 5);
set('MB23', [3, 4, 5],   6, 7);

// Rendering rack grids

export function createRackBox({ group, rackNumber, row, idx, style = {} }) {
  const key = `${group}.R${rackNumber}`;
  const layout = LAYOUTS[key];

  // Fallback rack dimensions (useful for miners without a known location)
  const cols = layout ? layout.cols : 7;
  const rows = layout ? layout.rows : 12;

  const cellSize = style.cell ?? 10; // px

  // Outer wrapper
  const box = document.createElement('div');
  box.setAttribute('data-rack-box', '1');
  box.setAttribute('data-rack-group', group);
  box.setAttribute('data-rack-num', rackNumber);
  box.style.display = 'inline-block';
  box.style.fontSize = '10px';
  box.style.lineHeight = '10px';
  box.style.userSelect = 'none';

  // Grid wrapper
  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = `repeat(${cols}, ${cellSize}px)`;
  grid.style.gridAutoRows = `${cellSize}px`;
  grid.style.gap = '2px';
  grid.style.padding = '4px';
  grid.style.borderRadius = '6px';
  grid.style.border = '1px solid rgb(71 85 105 / 0.6)';
  grid.style.boxShadow = '0 8px 30px rgba(0,0,0,.35)';
  grid.style.backgroundColor = 'rgb(15 23 42)'; // dark slate by default; repaintRackBoxes() will flip for PDF

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement('div');
      cell.style.width = `${cellSize}px`;
      cell.style.height = `${cellSize}px`;
      cell.style.borderRadius = '3px';
      cell.style.boxShadow = '0 1px 2px rgba(0,0,0,.4)';
      // default fill
      cell.style.backgroundColor = 'rgb(71 85 105)'; // slate-600

      // highlight target open slot
      if (r === row && c === idx) {
        cell.setAttribute('data-selected', '1');
        cell.style.backgroundColor = 'rgb(52 211 153)'; // green
      }

      grid.appendChild(cell);
    }
  }

  // Label
  const label = document.createElement('div');
  label.style.marginTop = '4px';
  label.style.textAlign = 'center';
  label.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
  label.style.fontSize = '10px';
  label.style.color = 'rgb(148 163 184)'; // slate-400
  label.textContent = `${group} R${rackNumber}`;

  box.appendChild(grid);
  box.appendChild(label);

  return box;
}

// Repaint rack boxes to light mode (useful for generating a PDF when UI is set to dark mode) 

export function repaintRackBoxes(scopeEl, { forceLight = false } = {}) {
  const darkModeOn = document.documentElement.classList.contains('dark');
  const rackBoxes = scopeEl.querySelectorAll('[data-rack-box]');

  rackBoxes.forEach(box => {
    const grid = box.querySelector('div');
    if (!grid) return;

    const wantsLight = forceLight || !darkModeOn;

    // Grid background + border
    grid.style.backgroundColor = wantsLight ? 'rgb(255 255 255)' : 'rgb(15 23 42)';
    grid.style.border = wantsLight
      ? '1px solid rgb(148 163 184 / 0.6)'   // slate-400-ish
      : '1px solid rgb(71 85 105 / 0.6)';    // slate-600-ish

    // Update each cell color
    const cells = grid.querySelectorAll('div');
    cells.forEach(cell => {
      const selected = cell.getAttribute('data-selected') === '1';
      if (selected) {
        cell.style.backgroundColor = wantsLight
          ? 'rgb(16 185 129)'  // green-500 in light
          : 'rgb(52 211 153)'; // green-400 in dark
      } else {
        cell.style.backgroundColor = wantsLight
          ? 'rgb(226 232 240)' // slate-200 in light
          : 'rgb(71 85 105)';  // slate-600 in dark
      }
      cell.style.boxShadow = '0 1px 2px rgba(0,0,0,.4)';
    });

    // label
    const label = box.lastChild;
    if (label) {
      label.style.color = wantsLight
        ? 'rgb(71 85 105)'   // slate-600
        : 'rgb(148 163 184)';// slate-400
    }
  });
}
