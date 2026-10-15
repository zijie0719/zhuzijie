/* 公共工具：接口调用、转义、渲染、提示、主题切换 */
/* 无构建步骤，直接以普通脚本加载；挂到 window.App 上供各页面使用 */

(function () {
  'use strict';

  /* ---------------- 接口 ---------------- */

  async function request(url, options = {}) {
    const opts = { credentials: 'same-origin', ...options };
    if (opts.body !== undefined && !(opts.body instanceof Blob)) {
      opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      opts.body = JSON.stringify(opts.body);
    }

    let res;
    try {
      res = await fetch(url, opts);
    } catch {
      throw new Error('网络连接失败，请检查网络后重试');
    }

    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    }

    if (!res.ok || (data && data.ok === false)) {
      const err = new Error((data && data.error) || `请求失败（${res.status}）`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const api = {
    get: (url) => request(url),
    post: (url, body) => request(url, { method: 'POST', body: body ?? {} }),
    put: (url, body) => request(url, { method: 'PUT', body: body ?? {} }),
    del: (url) => request(url, { method: 'DELETE' })
  };

  /* ---------------- 转义与格式化 ---------------- */

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(cents) {
    const n = Number(cents) || 0;
    return (n / 100).toFixed(2);
  }

  function dateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
      d.getMinutes()
    )}`;
  }

  function relTime(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} 天前`;
    return dateTime(iso).slice(0, 10);
  }

  /**
   * 极简 Markdown 渲染（先转义再替换，所以不存在 XSS）。
   * 支持：# 标题、**粗体**、`代码`、> 引用、- 列表、![图](url)、[链接](url)
   */
  function markdown(src) {
    let text = esc(src || '');

    // 图片与链接放在最前面处理，避免内部内容被后续规则破坏
    text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, (_m, alt, url) => {
      return `\n<img src="${url}" alt="${alt}" loading="lazy">\n`;
    });
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, (_m, label, url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/^###\s+(.+)$/gm, '<h4>$1</h4>');
    text = text.replace(/^##\s+(.+)$/gm, '<h3>$1</h3>');

    // 引用块
    text = text.replace(/(?:^&gt;\s?.*(?:\n|$))+/gm, (block) => {
      const inner = block
        .replace(/&gt;\s?/g, '')
        .trim()
        .replace(/\n/g, '<br>');
      return `<blockquote>${inner}</blockquote>`;
    });

    // 列表
    text = text.replace(/(?:^[-*]\s+.+(?:\n|$))+/gm, (block) => {
      const items = block
        .trim()
        .split('\n')
        .map((l) => `<li>${l.replace(/^[-*]\s+/, '')}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    });

    // 段落
    text = text
      .split(/\n{2,}/)
      .map((chunk) => {
        const t = chunk.trim();
        if (!t) return '';
        if (/^<(h[34]|ul|blockquote|img|p|div)/.test(t)) return t;
        return `<p>${t.replace(/\n/g, '<br>')}</p>`;
      })
      .join('');

    return text;
  }

  /* ---------------- 提示 ---------------- */

  let toastHost = null;

  function toast(message, kind = '', duration = 2600) {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.className = 'toast-host';
      document.body.appendChild(toastHost);
    }
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = message;
    toastHost.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .2s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 220);
    }, duration);
  }

  async function copy(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast('已复制到剪贴板', 'ok');
      return true;
    } catch {
      toast('复制失败，请手动选择复制', 'err');
      return false;
    }
  }

  /* ---------------- 主题 ---------------- */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* 隐私模式下写不了，忽略 */
    }
    document.querySelectorAll('[data-theme-icon]').forEach((el) => {
      el.textContent = theme === 'dark' ? '☀' : '☾';
    });
  }

  function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem('theme');
    } catch {
      /* ignore */
    }
    if (!saved) {
      saved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    applyTheme(saved);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  /* ---------------- 页面外壳 ---------------- */

  function coverHtml(product, size) {
    if (product.cover) {
      return `<img src="${esc(product.cover)}" alt="${esc(product.name)}" loading="lazy">`;
    }
    const letter = (product.name || '?').trim().charAt(0);
    return `<div class="cover-fallback"${size ? ` style="font-size:${size}px"` : ''}>${esc(
      letter
    )}</div>`;
  }

  function productCard(p) {
    const badges = [];
    if (p.soldOut) {
      badges.push('<span class="badge danger">已售罄</span>');
    } else if (p.deliveryType === 'auto') {
      badges.push('<span class="badge brand">自动发货</span>');
    } else {
      badges.push('<span class="badge warn">人工发货</span>');
    }
    if (p.stock > 0 && p.stock <= 5 && p.deliveryType === 'auto') {
      badges.push(`<span class="badge">仅剩 ${p.stock}</span>`);
    }

    const old =
      p.originalPrice && p.originalPrice > p.price
        ? `<span class="price-old">¥${p.originalPriceText}</span>`
        : '';

    const stockText = p.soldOut ? '缺货' : p.unlimited ? '现货充足' : `库存 ${p.stock}`;

    return `
      <article class="card">
        <a class="cover" href="/product/${p.id}">
          ${coverHtml(p)}
          <div class="badges">${badges.join('')}</div>
        </a>
        <div class="body">
          <a class="name" href="/product/${p.id}">${esc(p.name)}</a>
          <div class="sub">${esc(p.subtitle || p.categoryName || '')}</div>
          <div class="foot">
            <div>
              <div class="price"><span class="cur">¥</span>${p.priceText}${old}</div>
            </div>
            <div class="meta">已售 ${p.sales} · ${stockText}</div>
          </div>
          <a class="btn-buy" href="/product/${p.id}" style="margin-top:4px;width:100%">
            ${p.soldOut ? '已售罄' : '立即下单'}
          </a>
        </div>
      </article>`;
  }

  function renderSkeletons(host, count = 8) {
    host.innerHTML = Array.from({ length: count })
      .map(() => '<div class="skeleton skeleton-card"></div>')
      .join('');
  }

  /* ---------------- 站点外壳渲染 ---------------- */

  let siteCache = null;

  async function loadSite(force = false) {
    if (siteCache && !force) return siteCache;
    const { site } = await api.get('/api/site');
    siteCache = site;
    return site;
  }

  function renderHeader(site, activeKey) {
    const host = document.querySelector('[data-site-header]');
    if (!host) return;

    const nav = [
      { key: 'home', label: '全部商品', href: '/' },
      { key: 'query', label: '订单查询', href: '/query' }
    ];

    host.innerHTML = `
      <div class="wrap inner">
        <a class="logo" href="/">
          <span class="mark">${
            site.logo ? `<img src="${esc(site.logo)}" alt="">` : esc((site.name || '店').charAt(0))
          }</span>
          <span>${esc(site.name)}</span>
        </a>
        <nav class="main-nav" data-nav>
          ${nav
            .map(
              (n) =>
                `<a href="${n.href}" class="${activeKey === n.key ? 'active' : ''}">${n.label}</a>`
            )
            .join('')}
        </nav>
        <div class="header-actions">
          <form class="search-box" data-search>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/>
              <path d="M20 20l-3.5-3.5"/></svg>
            <input type="search" placeholder="搜索商品…" aria-label="搜索商品" maxlength="60">
          </form>
          <button class="icon-btn" data-theme-toggle title="切换深色 / 浅色" type="button">
            <span data-theme-icon>☾</span>
          </button>
          <button class="icon-btn nav-toggle" data-nav-toggle title="菜单" type="button">☰</button>
        </div>
      </div>`;

    host.querySelector('[data-theme-toggle]').addEventListener('click', toggleTheme);

    const navEl = host.querySelector('[data-nav]');
    host.querySelector('[data-nav-toggle]')?.addEventListener('click', () => {
      navEl.classList.toggle('open');
    });

    const searchForm = host.querySelector('[data-search]');
    const input = searchForm.querySelector('input');
    const params = new URLSearchParams(location.search);
    if (params.get('q')) input.value = params.get('q');

    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (location.pathname !== '/') {
        location.href = q ? `/?q=${encodeURIComponent(q)}` : '/';
      } else {
        const url = new URL(location.href);
        if (q) url.searchParams.set('q', q);
        else url.searchParams.delete('q');
        location.href = url.toString();
      }
    });

    document.title = `${site.name}${activeKey === 'query' ? ' · 订单查询' : ''}`;
  }

  function renderNotice(site) {
    const host = document.querySelector('[data-site-notice]');
    if (!host) return;
    if (!site.notice) {
      host.remove();
      return;
    }
    host.hidden = false;
    host.innerHTML = `<div class="wrap inner">
        <span class="tag">公告</span>
        <span class="text">${esc(site.notice)}</span>
      </div>`;
  }

  function renderFooter(site) {
    const host = document.querySelector('[data-site-footer]');
    if (!host) return;

    const contacts = [];
    if (site.contact.qq) contacts.push(`<span>QQ：${esc(site.contact.qq)}</span>`);
    if (site.contact.wechat) contacts.push(`<span>微信：${esc(site.contact.wechat)}</span>`);
    if (site.contact.email) contacts.push(`<span>邮箱：${esc(site.contact.email)}</span>`);
    if (site.contact.hours) contacts.push(`<span>客服时间：${esc(site.contact.hours)}</span>`);

    host.innerHTML = `
      <div class="wrap inner">
        <div>
          <div style="font-weight:600;color:var(--text-muted);margin-bottom:6px">
            ${esc(site.name)}
          </div>
          <div style="max-width:520px">${esc(site.footer)}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">
          <div class="contacts">${contacts.join('')}</div>
          <div style="display:flex;gap:16px">
            <a href="/">首页</a>
            <a href="/query">订单查询</a>
            <a href="/admin">商家后台</a>
          </div>
        </div>
      </div>`;
  }

  /** 一次性把页头页脚公告都渲染好 */
  async function bootShell(activeKey) {
    try {
      const site = await loadSite();
      renderHeader(site, activeKey);
      renderNotice(site);
      renderFooter(site);
      return site;
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  function applyQueryFilterToLinks(filter) {
    if (!filter) return;
    document.querySelectorAll('[data-keep-query]').forEach((a) => {
      const url = new URL(a.getAttribute('href'), location.origin);
      filter.forEach(([k, v]) => v && url.searchParams.set(k, v));
      a.setAttribute('href', url.pathname + url.search);
    });
  }

  /* ---------------- 导出 ---------------- */

  window.App = {
    api,
    esc,
    money,
    dateTime,
    relTime,
    markdown,
    toast,
    copy,
    initTheme,
    toggleTheme,
    applyTheme,
    coverHtml,
    productCard,
    renderSkeletons,
    loadSite,
    bootShell,
    applyQueryFilterToLinks
  };

  initTheme();
})();
