/* 后台主程序：路由、弹窗、数据概览、订单管理、账号安全 */

(function () {
  'use strict';

  const { api, esc, money, toast, dateTime, relTime, toggleTheme, loadSite } = window.App;

  const $ = (sel) => document.querySelector(sel);

  const STATUS = {
    pending: { text: '待付款', cls: 'pending' },
    paid: { text: '已付款', cls: 'paid' },
    delivered: { text: '已完成', cls: 'delivered' },
    cancelled: { text: '已取消', cls: 'cancelled' }
  };

  /* ================================================================ *
   * 弹窗
   * ================================================================ */

  function modal({ title, body, footer, size = '' }) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal ${size}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="modal-close" type="button" aria-label="关闭">✕</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>`;

    document.body.appendChild(backdrop);
    document.body.style.overflow = 'hidden';

    const close = () => {
      backdrop.remove();
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
    };

    function onKey(e) {
      if (e.key === 'Escape') close();
    }

    backdrop.querySelector('.modal-close').addEventListener('click', close);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener('keydown', onKey);

    return { el: backdrop.querySelector('.modal'), close };
  }

  function confirmDialog(message, { okText = '确定', danger = false, title = '请确认' } = {}) {
    return new Promise((resolve) => {
      const m = modal({
        title,
        size: 'narrow',
        body: `<div style="font-size:14.5px;line-height:1.75">${message}</div>`,
        footer: `
          <button class="btn" data-act="no" type="button">取消</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="yes" type="button">${esc(
            okText
          )}</button>`
      });

      m.el.querySelector('[data-act="no"]').addEventListener('click', () => {
        m.close();
        resolve(false);
      });
      m.el.querySelector('[data-act="yes"]').addEventListener('click', () => {
        m.close();
        resolve(true);
      });
    });
  }

  /** 简单的输入弹窗，返回输入值或 null */
  function promptDialog({ title, label, value = '', placeholder = '', textarea = false, hint = '' }) {
    return new Promise((resolve) => {
      const field = textarea
        ? `<textarea class="textarea" id="pdInput" rows="4" placeholder="${esc(placeholder)}">${esc(
            value
          )}</textarea>`
        : `<input class="input" id="pdInput" type="text" value="${esc(
            value
          )}" placeholder="${esc(placeholder)}">`;

      const m = modal({
        title,
        size: 'narrow',
        body: `<div class="field">
            <label>${esc(label)}</label>
            ${field}
            ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
          </div>`,
        footer: `
          <button class="btn" data-act="no" type="button">取消</button>
          <button class="btn btn-primary" data-act="yes" type="button">确定</button>`
      });

      const input = m.el.querySelector('#pdInput');
      input.focus();
      if (input.select && !textarea) input.select();

      m.el.querySelector('[data-act="no"]').addEventListener('click', () => {
        m.close();
        resolve(null);
      });
      m.el.querySelector('[data-act="yes"]').addEventListener('click', () => {
        const v = input.value.trim();
        m.close();
        resolve(v);
      });
    });
  }

  function emptyRow(colspan, text, icon = '📭') {
    return `<tr><td colspan="${colspan}"><div class="empty-cell">
        <div class="icon">${icon}</div><div>${esc(text)}</div>
      </div></td></tr>`;
  }

  /* ================================================================ *
   * 路由
   * ================================================================ */

  const routes = {};
  const register = (name, config) => {
    routes[name] = config;
  };

  let currentRoute = null;

  async function go(name) {
    if (!routes[name]) name = 'dashboard';
    if (location.hash !== `#/${name}`) {
      history.replaceState(null, '', `#/${name}`);
    }

    currentRoute = name;
    document.querySelectorAll('.side-nav a').forEach((a) => {
      a.classList.toggle('active', a.dataset.route === name);
    });
    document.querySelectorAll('.section').forEach((s) => {
      s.classList.toggle('active', s.dataset.view === name);
    });

    $('#pageTitle').textContent = routes[name].title;
    document.title = `${routes[name].title} · 商家后台`;
    closeSidebar();

    try {
      await routes[name].render();
    } catch (err) {
      if (err.status === 401) return location.replace('/admin/login');
      toast(err.message, 'err');
    }
  }

  /* ================================================================ *
   * 侧栏
   * ================================================================ */

  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    document.querySelector('.scrim')?.remove();
  }

  $('#menuBtn').addEventListener('click', () => {
    const sb = $('#sidebar');
    sb.classList.add('open');
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.addEventListener('click', closeSidebar);
    document.body.appendChild(scrim);
  });

  $('#sideNav').addEventListener('click', (e) => {
    const link = e.target.closest('a[data-route]');
    if (link) go(link.dataset.route);
  });

  document.addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) go(goto.dataset.goto);
  });

  $('[data-theme-toggle]').addEventListener('click', toggleTheme);

  $('#logoutBtn').addEventListener('click', async () => {
    const yes = await confirmDialog('确定要退出登录吗？', { okText: '退出' });
    if (!yes) return;
    try {
      await api.post('/api/admin/logout');
    } finally {
      location.replace('/admin/login');
    }
  });

  /* ================================================================ *
   * 数据概览
   * ================================================================ */

  function stockBar(stock) {
    const max = 50;
    const pct = Math.min(100, (stock / max) * 100);
    const cls = stock === 0 ? 'empty' : stock < 5 ? 'low' : '';
    return `<span class="stock-bar">
        <span class="track"><span class="fill ${cls}" style="width:${pct}%"></span></span>
        <b>${stock}</b>
      </span>`;
  }

  register('dashboard', {
    title: '数据概览',
    async render() {
      const { stats } = await api.get('/api/admin/stats');

      const cards = [
        { k: '总营业额', v: `¥${stats.revenueText}`, cls: 'accent', sub: `今日 ¥${stats.todayRevenueText}` },
        { k: '待处理订单', v: stats.orderToShip, sub: stats.orderToShip ? '已付款，等待发货' : '暂无待发货' },
        { k: '待付款订单', v: stats.orderPending, sub: `今日新增 ${stats.orderToday} 单` },
        { k: '已完成订单', v: stats.orderDelivered, sub: `累计 ${stats.orderTotal} 单` },
        { k: '在售商品', v: stats.productOnline, sub: `共 ${stats.productTotal} 个商品` },
        { k: '可用卡密', v: stats.cardsAvailable, sub: `已售出 ${stats.cardsSold} 条` }
      ];

      $('#statGrid').innerHTML = cards
        .map(
          (c) => `<div class="stat ${c.cls || ''}">
            <div class="k">${esc(c.k)}</div>
            <div class="v">${esc(String(c.v))}</div>
            <div class="sub">${esc(c.sub)}</div>
          </div>`
        )
        .join('');

      // 库存预警
      const alerts = [];
      if (stats.lowStock.length) {
        alerts.push(`<div class="alert alert-warn" style="margin-bottom:16px">
            <span>⚠️</span>
            <div><b>${stats.lowStock.length} 个自动发货商品卡密不足</b>：
              ${stats.lowStock
                .map((p) => `${esc(p.name)}（剩 ${p.stock}）`)
                .join('、')}
              <br><a data-goto="cards" style="color:inherit;text-decoration:underline;cursor:pointer">去补充卡密 →</a>
            </div>
          </div>`);
      }
      if (stats.orderToShip > 0) {
        alerts.push(`<div class="alert alert-info" style="margin-bottom:16px">
            <span>📦</span>
            <div>有 <b>${stats.orderToShip}</b> 笔订单已确认收款但还没发货。
              <a data-goto="orders" style="color:inherit;text-decoration:underline;cursor:pointer">去处理 →</a>
            </div>
          </div>`);
      }
      $('#dashAlert').innerHTML = alerts.join('');

      const { orders } = await api.get('/api/admin/orders?page=1');
      const recent = orders.slice(0, 8);

      $('#recentTable').innerHTML = `
        <thead><tr>
          <th>订单号</th><th>商品</th><th>金额</th><th>联系方式</th><th>状态</th><th>下单时间</th>
        </tr></thead>
        <tbody>${
          recent.length
            ? recent
                .map(
                  (o) => `<tr>
                    <td class="mono">${esc(o.order_no)}</td>
                    <td>${esc(o.product_name)} <span class="muted">×${o.quantity}</span></td>
                    <td style="color:var(--price);font-weight:650">¥${esc(o.totalText)}</td>
                    <td>${esc(o.contact)}</td>
                    <td><span class="pill ${STATUS[o.status].cls}">${STATUS[o.status].text}</span></td>
                    <td class="muted nowrap">${relTime(o.created_at)}</td>
                  </tr>`
                )
                .join('')
            : emptyRow(6, '还没有订单，把商品分享出去试试吧')
        }</tbody>`;
    }
  });

  /* ================================================================ *
   * 订单管理
   * ================================================================ */

  const orderState = { status: 'all', q: '', page: 1 };

  register('orders', {
    title: '订单管理',
    async render() {
      await loadOrders();
    }
  });

  async function loadOrders() {
    const params = new URLSearchParams();
    if (orderState.status !== 'all') params.set('status', orderState.status);
    if (orderState.q) params.set('q', orderState.q);
    params.set('page', String(orderState.page));

    const data = await api.get('/api/admin/orders?' + params.toString());
    const counts = data.counts || {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    $('#orderTabs').innerHTML = [
      ['all', '全部', total],
      ['pending', '待付款', counts.pending || 0],
      ['paid', '待发货', counts.paid || 0],
      ['delivered', '已完成', counts.delivered || 0],
      ['cancelled', '已取消', counts.cancelled || 0]
    ]
      .map(
        ([key, label, n]) =>
          `<button class="chip${orderState.status === key ? ' active' : ''}" data-status="${key}">
             ${label}<span class="n">${n}</span>
           </button>`
      )
      .join('');

    $('#orderTabs')
      .querySelectorAll('.chip')
      .forEach((chip) => {
        chip.addEventListener('click', () => {
          orderState.status = chip.dataset.status;
          orderState.page = 1;
          loadOrders();
        });
      });

    $('#ordersTable').innerHTML = `
      <thead><tr>
        <th>订单号</th><th>商品信息</th><th>买家</th><th>金额</th>
        <th>状态</th><th>下单时间</th><th style="width:1%">操作</th>
      </tr></thead>
      <tbody>${
        data.orders.length
          ? data.orders.map(orderRow).join('')
          : emptyRow(7, '没有符合条件的订单', '🧾')
      }</tbody>`;

    // 分页
    const pages = Math.max(1, Math.ceil(data.total / data.perPage));
    $('#orderPager').innerHTML =
      pages > 1
        ? `<button class="btn btn-sm" data-page="${data.page - 1}" ${
            data.page <= 1 ? 'disabled' : ''
          }>上一页</button>
           <span>第 ${data.page} / ${pages} 页 · 共 ${data.total} 单</span>
           <button class="btn btn-sm" data-page="${data.page + 1}" ${
             data.page >= pages ? 'disabled' : ''
           }>下一页</button>`
        : `<span>共 ${data.total} 单</span>`;

    $('#orderPager')
      .querySelectorAll('[data-page]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          orderState.page = Number(btn.dataset.page);
          loadOrders();
        });
      });

    $('#ordersTable')
      .querySelectorAll('[data-order-act]')
      .forEach((btn) => {
        btn.addEventListener('click', () => handleOrderAction(btn.dataset.orderAct, Number(btn.dataset.id)));
      });

    updateBadge(counts.pending || 0);
  }

  function orderRow(o) {
    const st = STATUS[o.status] || { text: o.status, cls: 'pending' };

    const payTag =
      o.status === 'pending' && o.buyer_reported_paid
        ? '<span class="pill paid" style="margin-left:6px">买家称已付款</span>'
        : '';

    const actions = [];

    if (o.status === 'pending') {
      actions.push(`<button class="btn btn-sm btn-success" data-order-act="confirm" data-id="${o.id}">确认收款</button>`);
      actions.push(`<button class="btn btn-sm" data-order-act="cancel" data-id="${o.id}">取消</button>`);
    }
    if (o.status === 'paid') {
      actions.push(`<button class="btn btn-sm btn-primary" data-order-act="deliver" data-id="${o.id}">发货</button>`);
      actions.push(`<button class="btn btn-sm" data-order-act="cancel" data-id="${o.id}">取消</button>`);
    }
    actions.push(`<button class="btn btn-sm" data-order-act="detail" data-id="${o.id}">详情</button>`);
    if (o.status === 'cancelled') {
      actions.push(`<button class="btn btn-sm btn-danger" data-order-act="delete" data-id="${o.id}">删除</button>`);
    }

    const buyer = o.delivery_type === 'manual' && o.receiver_name
      ? `${esc(o.contact)}<div class="muted">${esc(o.receiver_name)} ${esc(o.receiver_phone)}</div>`
      : esc(o.contact);

    return `<tr>
      <td class="mono">${esc(o.order_no)}</td>
      <td>
        <div style="font-weight:600">${esc(o.product_name)}</div>
        <div class="muted">${
          o.delivery_type === 'auto' ? '自动发货' : '人工发货'
        } · ¥${esc(o.unitPriceText)} × ${o.quantity}${
          o.tracking_no ? ` · 单号 ${esc(o.tracking_no)}` : ''
        }</div>
      </td>
      <td>${buyer}</td>
      <td style="color:var(--price);font-weight:650;white-space:nowrap">¥${esc(o.totalText)}</td>
      <td class="nowrap"><span class="pill ${st.cls}">${st.text}</span>${payTag}</td>
      <td class="muted nowrap">${dateTime(o.created_at)}</td>
      <td><div class="actions">${actions.join('')}</div></td>
    </tr>`;
  }

  async function handleOrderAction(action, id) {
    if (action === 'detail') return showOrderDetail(id);
    if (action === 'confirm') return confirmOrder(id);
    if (action === 'deliver') return deliverOrder(id);
    if (action === 'cancel') return cancelOrder(id);

    if (action === 'delete') {
      const yes = await confirmDialog('删除后无法恢复，确定要删除这笔订单吗？', {
        okText: '删除',
        danger: true
      });
      if (!yes) return;
      await api.del(`/api/admin/orders/${id}`);
      toast('订单已删除', 'ok');
      loadOrders();
      refreshBadge();
    }
  }

  async function confirmOrder(id) {
    const order = await findOrder(id);
    if (!order) return;

    const isAuto = order.delivery_type === 'auto';
    const yes = await confirmDialog(
      `确认已收到 <b>¥${esc(order.totalText)}</b> 款项吗？<br><br>` +
        (isAuto
          ? '确认后系统会立即自动分配卡密并发货，操作不可撤销。'
          : '确认后订单进入「待发货」，你再填写快递单号完成发货。'),
      { okText: '确认收款' }
    );
    if (!yes) return;

    const res = await api.post(`/api/admin/orders/${id}/confirm`, { payMethod: order.pay_method || '' });
    toast(res.message, 'ok');

    if (res.autoDelivered && res.order.status !== 'delivered') {
      toast('库存不足，未能自动发卡，请到「卡密库存」补充', 'err', 5000);
    }
    loadOrders();
    refreshBadge();
  }

  async function deliverOrder(id) {
    const order = await findOrder(id);
    if (!order) return;

    const isManual = order.delivery_type === 'manual';

    const m = modal({
      title: '订单发货',
      body: `
        <div class="stack">
          <div class="alert alert-info">
            <span>📦</span>
            <div>${esc(order.product_name)} × ${order.quantity}
              · 买家 ${esc(order.contact)}</div>
          </div>
          ${
            isManual
              ? `<div class="form-grid">
                   <div class="field">
                     <label for="dvCompany">快递公司</label>
                     <input class="input" id="dvCompany" type="text" maxlength="40"
                            value="${esc(order.tracking_company || '')}" placeholder="顺丰 / 中通 / 圆通…">
                   </div>
                   <div class="field">
                     <label for="dvNo">快递单号</label>
                     <input class="input" id="dvNo" type="text" maxlength="60"
                            value="${esc(order.tracking_no || '')}" placeholder="填写快递单号">
                   </div>
                 </div>`
              : ''
          }
          <div class="field">
            <label>发给买家的内容${isManual ? '（选填）' : ''}</label>
            <textarea class="textarea" id="dvContent" rows="5"
              placeholder="${
                isManual
                  ? '可以写补充说明，比如发货清单、使用提示'
                  : '留空则自动从卡密库分配；如果库存不足，也可以在这里手动粘贴卡密（一行一个）'
              }">${esc(order.delivered_content || '')}</textarea>
            <span class="hint">内容会原样展示在买家的订单页，支持多行</span>
          </div>
          <div class="field">
            <label for="dvRemark">内部备注（买家看不到）</label>
            <input class="input" id="dvRemark" type="text" maxlength="200"
                   value="${esc(order.admin_remark || '')}" placeholder="选填">
          </div>
        </div>`,
      footer: `<button class="btn" data-act="cancel" type="button">取消</button>
               <button class="btn btn-primary" data-act="ok" type="button">确认发货</button>`
    });

    m.el.querySelector('[data-act="cancel"]').addEventListener('click', m.close);
    m.el.querySelector('[data-act="ok"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '提交中…';

      try {
        await api.post(`/api/admin/orders/${id}/deliver`, {
          trackingCompany: m.el.querySelector('#dvCompany')?.value.trim() || '',
          trackingNo: m.el.querySelector('#dvNo')?.value.trim() || '',
          content: m.el.querySelector('#dvContent').value,
          remark: m.el.querySelector('#dvRemark').value.trim()
        });
        m.close();
        toast('发货成功', 'ok');
        loadOrders();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
        btn.textContent = '确认发货';
      }
    });
  }

  async function cancelOrder(id) {
    const reason = await promptDialog({
      title: '取消订单',
      label: '取消原因（买家可见）',
      value: '买家申请取消',
      placeholder: '例如：超时未付款 / 缺货'
    });
    if (reason === null) return;

    await api.post(`/api/admin/orders/${id}/cancel`, { reason });
    toast('订单已取消', 'ok');
    loadOrders();
    refreshBadge();
  }

  /** 统一从接口取完整订单，避免列表分页导致找不到 */
  async function findOrder(id) {
    const { order } = await api.get(`/api/admin/orders/${id}`);
    return order;
  }

  async function showOrderDetail(id) {
    const m = modal({
      title: '订单详情',
      size: 'wide',
      body: '<div class="skeleton" style="height:200px"></div>',
      footer: `<button class="btn" data-act="close" type="button">关闭</button>`
    });

    m.el.querySelector('[data-act="close"]').addEventListener('click', m.close);

    let full;
    try {
      full = await findOrder(id);
    } catch (err) {
      m.el.querySelector('.modal-body').innerHTML = `<div class="empty-cell">${esc(
        err.message
      )}</div>`;
      return;
    }

    m.el.querySelector('.modal-head h3').textContent = `订单详情 · ${full.order_no}`;

    const st = STATUS[full.status] || { text: full.status, cls: 'pending' };

    const line = (k, v) =>
      `<div class="line"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;

    m.el.querySelector('.modal-body').innerHTML = `
      <div class="stack">
        <div class="row-between">
          <span class="pill ${st.cls}">${st.text}</span>
          <span class="muted" style="color:var(--text-faint);font-size:12.5px">
            下单于 ${dateTime(full.created_at)}
          </span>
        </div>

        <div class="order-meta">
          ${line('订单号', `<span class="mono">${esc(full.order_no)}</span>`)}
          ${line('商品', `${esc(full.product_name)} × ${full.quantity}`)}
          ${line('单价', `¥${esc(full.unitPriceText)}`)}
          ${line('订单金额', `<b style="color:var(--price)">¥${esc(full.totalText)}</b>`)}
          ${line('发货方式', full.delivery_type === 'auto' ? '自动发货' : '人工发货')}
          ${line('联系方式', esc(full.contact))}
          ${line('付款方式', esc(full.pay_method || '—'))}
          ${
            full.receiver_name
              ? line(
                  '收货信息',
                  `${esc(full.receiver_name)} ${esc(full.receiver_phone)}<br>${esc(
                    full.receiver_address
                  )}`
                )
              : ''
          }
          ${full.remark ? line('买家备注', esc(full.remark)) : ''}
          ${full.paid_at ? line('付款时间', dateTime(full.paid_at)) : ''}
          ${full.delivered_at ? line('发货时间', dateTime(full.delivered_at)) : ''}
          ${
            full.tracking_no
              ? line(
                  '物流',
                  `${esc(full.tracking_company || '—')} <span class="mono">${esc(
                    full.tracking_no
                  )}</span>`
                )
              : ''
          }
          ${full.admin_remark ? line('内部备注', esc(full.admin_remark)) : ''}
        </div>

        ${
          full.delivered_content
            ? `<div>
                 <div class="section-title" style="margin:0 0 8px">已发放内容</div>
                 <div class="secret-box">${esc(full.delivered_content)}</div>
               </div>`
            : ''
        }
      </div>`;
  }

  function updateBadge(n) {
    document.querySelectorAll('[data-badge="pending"]').forEach((el) => {
      el.textContent = String(n);
      el.classList.toggle('zero', !n);
    });
  }

  async function refreshBadge() {
    try {
      const { stats } = await api.get('/api/admin/stats');
      updateBadge(stats.orderPending + stats.orderToShip);
    } catch {
      /* ignore */
    }
  }

  // 订单搜索防抖
  let searchTimer = null;
  $('#orderSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      orderState.q = e.target.value.trim();
      orderState.page = 1;
      if (currentRoute === 'orders') loadOrders();
    }, 350);
  });

  $('#orderRefresh').addEventListener('click', () => {
    loadOrders();
    refreshBadge();
  });

  /* ================================================================ *
   * 账号安全
   * ================================================================ */

  register('account', {
    title: '账号安全',
    async render() {
      $('#oldPw').value = '';
      $('#newPw').value = '';
      $('#newPw2').value = '';
    }
  });

  $('#changePwBtn').addEventListener('click', async () => {
    const oldPassword = $('#oldPw').value;
    const newPassword = $('#newPw').value;
    const confirmPw = $('#newPw2').value;

    if (!oldPassword) return toast('请输入当前密码', 'err');
    if (newPassword.length < 6) return toast('新密码至少 6 位', 'err');
    if (newPassword !== confirmPw) return toast('两次输入的新密码不一致', 'err');

    const btn = $('#changePwBtn');
    btn.disabled = true;
    btn.textContent = '提交中…';

    try {
      await api.post('/api/admin/password', { oldPassword, newPassword });
      toast('密码已修改，请用新密码重新登录', 'ok', 3500);
      setTimeout(() => location.replace('/admin/login'), 1200);
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
      btn.textContent = '修改密码';
    }
  });

  $('#exportBtn').addEventListener('click', () => {
    location.href = '/api/admin/orders/export.csv';
  });

  /* ================================================================ *
   * 启动
   * ================================================================ */

  // 供 admin-catalog.js 使用
  window.Admin = {
    api, esc, money, toast, dateTime, relTime,
    STATUS, modal, confirmDialog, promptDialog, emptyRow, register, go,
    stockBar, refreshBadge, findOrder,
    get currentRoute() {
      return currentRoute;
    }
  };

  let booted = false;

  async function boot() {
    if (booted) return;
    booted = true;

    let me;
    try {
      me = await api.get('/api/admin/me');
    } catch {
      return location.replace('/admin/login');
    }

    $('#adminName').textContent = me.admin.username;
    $('#adminAvatar').textContent = me.admin.username.charAt(0).toUpperCase();

    try {
      const site = await loadSite();
      if (site) {
        $('#brandName').textContent = site.name;
        const mark = $('#brandMark');
        if (site.logo) {
          mark.innerHTML = `<img src="${site.logo}" alt="">`;
        } else {
          mark.textContent = (site.name || '店').charAt(0);
        }
      }
    } catch {
      /* 站点信息拿不到不影响后台使用 */
    }

    const initial = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'dashboard';
    await go(initial);
    refreshBadge();

    window.addEventListener('hashchange', () => {
      const name = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'dashboard';
      if (name !== currentRoute) go(name);
    });
  }

  // 等 admin-catalog.js 注册完路由再启动
  window.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
