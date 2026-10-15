/* 首页：分类筛选 + 搜索 + 排序 + 商品网格 */

(function () {
  'use strict';

  const { api, esc, productCard, renderSkeletons, bootShell, toast } = window.App;

  const grid = document.getElementById('grid');
  const chips = document.getElementById('chips');
  const sortSel = document.getElementById('sort');
  const emptyState = document.getElementById('emptyState');

  const params = new URLSearchParams(location.search);
  const state = {
    category: params.get('category') || 'all',
    q: params.get('q') || '',
    sort: params.get('sort') || 'default'
  };

  sortSel.value = state.sort;

  function syncUrl() {
    const url = new URL(location.href);
    const setOr = (k, v, def) => {
      if (v && v !== def) url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    };
    setOr('category', state.category, 'all');
    setOr('q', state.q, '');
    setOr('sort', state.sort, 'default');
    history.replaceState(null, '', url.pathname + (url.search || ''));
  }

  async function loadCategories() {
    try {
      const { categories } = await api.get('/api/categories');
      const total = categories.reduce((sum, c) => sum + c.count, 0);

      chips.innerHTML =
        `<button class="chip${
          state.category === 'all' ? ' active' : ''
        }" data-cat="all">全部<span class="n">${total}</span></button>` +
        categories
          .map(
            (c) =>
              `<button class="chip${
                String(state.category) === String(c.id) ? ' active' : ''
              }" data-cat="${c.id}">${esc(c.name)}<span class="n">${c.count}</span></button>`
          )
          .join('');
    } catch (err) {
      console.error(err);
    }
  }

  async function loadProducts() {
    renderSkeletons(grid, 8);
    emptyState.hidden = true;
    grid.hidden = false;

    const query = new URLSearchParams();
    if (state.category !== 'all') query.set('category', state.category);
    if (state.q) query.set('q', state.q);
    if (state.sort !== 'default') query.set('sort', state.sort);

    try {
      const { products } = await api.get('/api/products?' + query.toString());

      if (!products.length) {
        grid.hidden = true;
        emptyState.hidden = false;
        return;
      }

      grid.innerHTML = products.map(productCard).join('');
    } catch (err) {
      grid.hidden = true;
      emptyState.hidden = false;
      toast(err.message, 'err');
    }
  }

  chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.category = chip.dataset.cat;
    chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    syncUrl();
    loadProducts();
  });

  sortSel.addEventListener('change', () => {
    state.sort = sortSel.value;
    syncUrl();
    loadProducts();
  });

  async function init() {
    const site = await bootShell('home');

    if (site) {
      const hero = document.getElementById('hero');
      document.getElementById('heroTitle').textContent = site.name;
      document.getElementById('heroSubtitle').textContent = site.subtitle || '';
      hero.hidden = false;

      if (state.q) {
        document.title = `搜索「${state.q}」 · ${site.name}`;
      }
    }

    loadCategories();
    loadProducts();
  }

  init();
})();
