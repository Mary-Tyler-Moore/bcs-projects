// toolbar.js

export function mountToolbar({ container, initial, onChange, issues = [] }) {
  if (!container) return () => {};

  // Helper for PDF generation: force text black regardless of theme
  window.__issuesForceLightText = function (on = true) {
    const id = '__issues_force_light_text';
    let tag = document.getElementById(id);
    if (on) {
      if (!tag) {
        tag = document.createElement('style');
        tag.id = id;
        tag.textContent = `
          /* Force foreground text to black when exporting PDF */
          .issues-force-light, .issues-force-light * {
            color: #000 !important;
            -webkit-text-fill-color: #000 !important;
          }
        `;
        document.head.appendChild(tag);
      }
      document.documentElement.classList.add('issues-force-light');
    } else {
      document.documentElement.classList.remove('issues-force-light');
    }
  };

  const allIssues = Array.from(issues);
  const initialSet = new Set(
    Array.isArray(initial?.activeFilters) && initial.activeFilters.length
      ? initial.activeFilters
      : allIssues
  );

  const state = {
    positionBase: initial?.positionBase === 0 ? 0 : 1,
    activeFilters: new Set(initialSet),
  };

  container.innerHTML = `
    <div class="flex flex-col gap-3">
      <!-- Row 1: Position toggle -->
      <div class="inline-flex items-center gap-2">
        <span class="text-sm text-slate-600 dark:text-slate-400">Positions:</span>
        <button id="pos-1"
          class="px-3 py-1 rounded-lg border text-sm
                 border-slate-300/70 dark:border-slate-600/70
                 bg-white dark:bg-slate-800
                 text-slate-800 dark:text-slate-200
                 hover:shadow">
          Physical Location
        </button>
        <button id="pos-0"
          class="px-3 py-1 rounded-lg border text-sm
                 border-slate-300/70 dark:border-slate-600/70
                 bg-white dark:bg-slate-800
                 text-slate-800 dark:text-slate-200
                 hover:shadow">
          Foreman Index
        </button>
      </div>

      <!-- Row 2: Filters -->
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <span class="text-sm text-slate-600 dark:text-slate-400">Filter issues shown below:</span>
          <div class="flex items-center gap-2">
            <button id="filters-all"
              class="px-2 py-1 rounded-md border text-xs
                     border-slate-300/70 dark:border-slate-600/70
                     bg-white dark:bg-slate-800
                     text-slate-800 dark:text-slate-200
                     hover:shadow">
              All
            </button>
            <button id="filters-none"
              class="px-2 py-1 rounded-md border text-xs
                     border-slate-300/70 dark:border-slate-600/70
                     bg-white dark:bg-slate-800
                     text-slate-800 dark:text-slate-200
                     hover:shadow">
              None
            </button>
          </div>
        </div>
        <div id="filters-wrap" class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1"></div>
      </div>
    </div>
  `;

  const elPos1 = container.querySelector('#pos-1');
  const elPos0 = container.querySelector('#pos-0');
  const elFiltersWrap = container.querySelector('#filters-wrap');
  const elAll = container.querySelector('#filters-all');
  const elNone = container.querySelector('#filters-none');

  function buildFilters() {
    elFiltersWrap.innerHTML = '';
    for (const label of allIssues) {
      const id = `filter-${btoa(label).replace(/=/g,'')}`;
      const wrapper = document.createElement('label');
      wrapper.className = `
        inline-flex items-center gap-2 text-sm
        text-slate-800 dark:text-slate-200
      `;
      wrapper.innerHTML = `
        <input id="${id}" type="checkbox"
               class="rounded border-slate-300 dark:border-slate-600
                      text-slate-900 dark:text-slate-100
                      bg-white dark:bg-slate-800"
               ${state.activeFilters.has(label) ? 'checked' : ''}>
        <span>${label}</span>
      `;
      elFiltersWrap.appendChild(wrapper);

      const cb = wrapper.querySelector('input');
      cb.addEventListener('change', () => {
        if (cb.checked) state.activeFilters.add(label);
        else state.activeFilters.delete(label);
        emitChange();
      });
    }
  }

  function render() {
    const activeClass =
      'bg-blue-600 text-white border-blue-600 dark:bg-blue-500 dark:text-white dark:border-blue-500';
    const inactiveClass =
      'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 border-slate-300/70 dark:border-slate-600/70';

    function setActive(btn, on) {
      btn.className = `px-3 py-1 rounded-lg border text-sm hover:shadow ${on ? activeClass : inactiveClass}`;
    }

    setActive(elPos1, state.positionBase === 1);
    setActive(elPos0, state.positionBase === 0);
    buildFilters();
  }

  function emitChange() {
    const lowHashSelected = state.activeFilters.has('Hash rate too low');
    window.__LOW_HASH_SHOW_WARN__ = !!lowHashSelected;

    onChange?.({
      positionBase: state.positionBase,
      activeFilters: Array.from(state.activeFilters),
    });
  }

  // Handlers
  elPos1.addEventListener('click', () => {
    if (state.positionBase !== 1) {
      state.positionBase = 1;
      render();
      emitChange();
    }
  });

  elPos0.addEventListener('click', () => {
    if (state.positionBase !== 0) {
      state.positionBase = 0;
      render();
      emitChange();
    }
  });

  elAll.addEventListener('click', () => {
    state.activeFilters = new Set(allIssues);
    render();
    emitChange();
  });

  elNone.addEventListener('click', () => {
    state.activeFilters.clear();
    render();
    emitChange();
  });

  // Initial paint + notify
  render();
  emitChange();

  return () => { container.innerHTML = ''; };
}
