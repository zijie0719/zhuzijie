/* 订单查询页 */

(function () {
  'use strict';

  const { api, esc, toast, bootShell, copy, dateTime, relTime } = window.App;

  const $ = (id) => document.getElementById(id);
  let site = null;

  const STATUS_CLASS = {
    pending: 'pending',
    paid: 'paid',
    delivered: 'delivered',
    cancelled: 'cancelled'
  };

  /* ---------------- 本地历史订单 ---------------- */

  function readHistory() {
    try {
      return JSON.parse(localStorage.getItem('myOrders') || '[]');
    } catch {
      return [];
    }
  }

  function rememberOrder(orderNo, contact) {
    const list = readHistory().filter((o) => o.orderNo !== orderNo);
    list.unshift({ orderNo, contact, at: Date.now() });
    try {
      localStorage.setItem('myOrders', JSON.stringify(list.slice(0, 15)));
    } catch {
      /* ignore */
    }
  }

  function renderHistory() {
    const list = readHistory();
    if (!list.length) return;

    const host = document.createElement('div');
    host.className = 'panel';
    host.style.marginTop = '18px';
    host.innerHTML = `
      <div class="panel-head">
        <h3>本机最近订单</h3>
        <button class="btn btn-sm" type="button" id="clearHistory">清空</button>
      </div>
      <div class="panel-body stack">
        ${list
          .map(
            (o) => `<div class="row-between" style="font-size:13.5px">
              <span class="mono" style="font-family:ui-monospace,Consolas,monospace">${esc(
                o.orderNo
              )}</span>
              <span style="display:flex;gap:10px;align-items:center">
                <span style="color:var(--text-faint)">${relTime(new Date(o.at).toISOString())}</span>
                <button class="btn btn-sm" type="button" data-fill="${esc(o.orderNo)}">查看</button>
              </span>
            </div>`
          )
          .join('')}
      </div>`;

    $('result').appendChild(host);

    host.querySelectorAll('[data-fill]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = readHistory().find((o) => o.orderNo === btn.dataset.fill);
        if (!item) return;
        $('orderNo').value = item.orderNo;
        $('contact').value = item.contact || '';
        runQuery();
      });
    });

    host.querySelector('#clearHistory').addEventListener('click', () => {
      try {
        localStorage.removeItem('myOrders');
      } catch {
        /* ignore */
      }
      host.remove();
    });
  }

  /* ---------------- 渲染结果 ---------------- */

  function renderOrder(order) {
    const host = $('result');
    host.innerHTML = '';

    const pillClass = STATUS_CLASS[order.status] || 'pending';

    let body = '';

    if (order.status === 'delivered') {
      if (order.deliveryType === 'manual') {
        body = `
          <div class="section-title" style="margin-top:0">物流信息</div>
          ${
            order.trackingNo
              ? `<div class="order-meta">
                   <div class="line"><span class="k">快递公司</span><span class="v">${esc(
                     order.trackingCompany || '—'
                   )}</span></div>
                   <div class="line"><span class="k">快递单号</span>
                     <span class="v mono">${esc(order.trackingNo)}</span></div>
                   <div class="line"><span class="k">发货时间</span><span class="v">${dateTime(
                     order.deliveredAt
                   )}</span></div>
                 </div>
                 <button class="btn btn-block" type="button" data-copy="${esc(
                   order.trackingNo
                 )}">复制快递单号</button>`
              : '<div class="hint">商家尚未填写快递单号，请联系客服。</div>'
          }
          ${
            order.content
              ? `<div class="section-title">发货说明</div>
                 <div class="secret-box">${esc(order.content)}</div>`
              : ''
          }`;
      } else {
        body = `
          <div class="section-title" style="margin-top:0">卡密 / 兑换码</div>
          <div class="secret-box">${esc(order.content || '（无内容）')}</div>
          <button class="btn btn-primary btn-block" style="margin-top:12px" type="button"
                  data-copy="${esc(order.content || '')}">一键复制全部</button>
          <div class="hint" style="text-align:center;margin-top:8px">建议截图保存，避免丢失</div>`;
      }
    } else if (order.status === 'paid') {
      body = `<div class="alert alert-info">
          <span>⏳</span>
          <div>${
            order.buyerReportedPaid
              ? '已收到你的付款通知，客服正在核对到账，核实后立即发货。'
              : '商家已确认收款，正在安排发货。'
          }</div>
        </div>
        <a class="btn btn-block" href="/pay/${esc(order.orderNo)}">查看订单详情</a>`;
    } else if (order.status === 'pending') {
      body = `<div class="alert alert-warn">
          <span>💳</span><div>该订单还没有完成付款。</div>
        </div>
        <a class="btn btn-primary btn-block" href="/pay/${esc(order.orderNo)}">去付款</a>`;
    } else {
      body = `<div class="alert alert-danger">
          <span>✕</span><div>订单已取消。如已付款，请联系客服处理退款。</div>
        </div>`;
    }

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.marginTop = '18px';
    panel.innerHTML = `
      <div class="panel-head">
        <h3>订单详情</h3>
        <span class="pill ${pillClass}">${esc(order.statusText)}</span>
      </div>
      <div class="panel-body stack">
        <div class="order-meta">
          <div class="line"><span class="k">订单号</span>
            <span class="v mono">${esc(order.orderNo)}</span></div>
          <div class="line"><span class="k">商品</span><span class="v">${esc(
            order.productName
          )}</span></div>
          <div class="line"><span class="k">金额</span>
            <span class="v" style="color:var(--price)">¥${esc(order.totalText)}</span></div>
          <div class="line"><span class="k">数量</span><span class="v">${order.quantity}</span></div>
          <div class="line"><span class="k">发货方式</span>
            <span class="v">${order.deliveryType === 'auto' ? '自动发货' : '人工发货'}</span></div>
          <div class="line"><span class="k">下单时间</span>
            <span class="v">${dateTime(order.createdAt)}</span></div>
          ${
            order.receiver
              ? `<div class="line"><span class="k">收货信息</span>
                   <span class="v">${esc(order.receiver.name)} ${esc(order.receiver.phone)}<br>${esc(
                     order.receiver.address
                   )}</span></div>`
              : ''
          }
        </div>
        ${body}
      </div>`;

    host.appendChild(panel);

    panel.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => copy(btn.dataset.copy));
    });
  }

  /* ---------------- 查询 ---------------- */

  async function runQuery() {
    const orderNo = $('orderNo').value.trim().toUpperCase();
    const contact = $('contact').value.trim();

    if (!orderNo) {
      toast('请输入订单号', 'err');
      $('orderNo').focus();
      return;
    }

    const btn = $('queryBtn');
    btn.disabled = true;
    btn.textContent = '查询中…';
    $('result').innerHTML = '<div class="skeleton" style="height:260px;margin-top:18px"></div>';

    try {
      const query = contact ? `?contact=${encodeURIComponent(contact)}` : '';
      const { order } = await api.get(`/api/orders/${encodeURIComponent(orderNo)}${query}`);
      rememberOrder(order.orderNo, contact);
      $('result').innerHTML = '';
      renderOrder(order);
    } catch (err) {
      $('result').innerHTML = '';
      if (err.data && err.data.needContact) {
        $('contactField').style.display = '';
        $('contact').focus();
      }
      $('result').innerHTML = `<div class="alert alert-danger" style="margin-top:18px">
          <span>😕</span><div>${esc(err.message)}</div>
        </div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '立即查询';
    }
  }

  $('queryBtn').addEventListener('click', runQuery);
  ['orderNo', 'contact'].forEach((id) => {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runQuery();
    });
  });

  /* ---------------- 初始化 ---------------- */

  async function init() {
    site = await bootShell('query');

    if (site && site.queryRequireContact === false) {
      $('contactField').style.display = 'none';
    }

    // 从支付页跳过来时自动带上参数
    const params = new URLSearchParams(location.search);
    if (params.get('no')) $('orderNo').value = params.get('no').toUpperCase();

    try {
      const saved = sessionStorage.getItem('lastOrderContact');
      if (saved) $('contact').value = saved;
      const lastNo = sessionStorage.getItem('lastOrderNo');
      if (lastNo && !$('orderNo').value) $('orderNo').value = lastNo;
    } catch {
      /* ignore */
    }

    renderHistory();

    if ($('orderNo').value && $('contact').value) runQuery();
  }

  init();
})();
