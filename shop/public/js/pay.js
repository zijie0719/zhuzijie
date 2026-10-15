/* 支付页：展示收款码、倒计时、提交付款通知、展示发货内容 */

(function () {
  'use strict';

  const { api, esc, toast, bootShell, copy, dateTime } = window.App;

  const $ = (id) => document.getElementById(id);
  const orderNo = ((location.pathname.match(/\/pay\/([A-Za-z0-9]+)/) || [])[1] || '').toUpperCase();

  let site = null;
  let order = null;
  let activeMethod = null;
  let countdownTimer = null;
  let pollTimer = null;
  let contact = '';

  try {
    contact = sessionStorage.getItem('lastOrderContact') || '';
  } catch {
    /* ignore */
  }

  /* ---------------- 加载订单 ---------------- */

  async function loadOrder(withContact) {
    const query = withContact ? `?contact=${encodeURIComponent(withContact)}` : '';
    const { order: o } = await api.get(`/api/orders/${encodeURIComponent(orderNo)}${query}`);
    order = o;
    contact = withContact || contact;
    return o;
  }

  async function init() {
    if (!orderNo) return location.replace('/');

    site = await bootShell('query');
    if (!site) site = { pay: { methods: [], note: '', expireMinutes: 30 } };

    $('skeleton').hidden = true;

    // 手上没有联系方式时先探一下：后台关掉了校验就直接展示，否则弹出验证框
    if (!contact) {
      const needGate = await probeGate();
      if (needGate) return;
    }

    try {
      await loadOrder(contact);
      $('gate').hidden = true;
      render();
    } catch (err) {
      if (err.data && err.data.needContact) {
        showGate();
      } else {
        showError(err.message);
      }
    }
  }

  /** 探测一下不带联系方式能不能查（后台可能关掉了校验） */
  async function probeGate() {
    try {
      await loadOrder('');
      return false;
    } catch (err) {
      if (err.data && err.data.needContact) {
        showGate();
        return true;
      }
      showError(err.message);
      return true;
    }
  }

  function showGate() {
    $('gate').hidden = false;
    $('content').hidden = true;
    $('skeleton').hidden = true;
    $('gateContact').focus();

    $('gateBtn').addEventListener('click', submitGate);
    $('gateContact').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitGate();
    });
  }

  async function submitGate() {
    const value = $('gateContact').value.trim();
    if (!value) return toast('请输入联系方式', 'err');

    const btn = $('gateBtn');
    btn.disabled = true;
    btn.textContent = '查询中…';

    try {
      await loadOrder(value);
      try {
        sessionStorage.setItem('lastOrderContact', value);
      } catch {
        /* ignore */
      }
      $('gate').hidden = true;
      render();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
      btn.textContent = '查看订单';
    }
  }

  function showError(message) {
    $('skeleton').hidden = true;
    $('content').hidden = true;
    $('gate').hidden = true;

    const box = document.createElement('div');
    box.className = 'empty';
    box.innerHTML = `
      <div class="icon">😕</div>
      <h3>${esc(message)}</h3>
      <p style="margin-top:12px">
        <a class="btn btn-primary" href="/query">去订单查询</a>
        <a class="btn" href="/" style="margin-left:8px">返回首页</a>
      </p>`;
    document.querySelector('.wrap').appendChild(box);
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    $('content').hidden = false;
    renderStatus();
    renderMeta();
    renderPayPanel();
    renderDonePanel();
    renderCountdown();
    startPolling();
  }

  const STATUS_CLASS = {
    pending: 'pending',
    paid: 'paid',
    delivered: 'delivered',
    cancelled: 'cancelled'
  };

  function renderStatus() {
    const pill = $('statusPill');
    pill.className = 'pill ' + (STATUS_CLASS[order.status] || 'pending');
    pill.textContent = order.statusText;
  }

  function renderMeta() {
    const rows = [
      ['订单号', `<span class="mono">${esc(order.orderNo)}</span>`],
      ['商品', esc(order.productName)],
      ['单价 × 数量', `¥${order.unitPriceText} × ${order.quantity}`],
      ['订单金额', `<span style="color:var(--price);font-size:16px">¥${order.totalText}</span>`],
      ['联系方式', esc(order.contact)],
      ['下单时间', dateTime(order.createdAt)]
    ];

    if (order.deliveryType === 'manual' && order.receiver) {
      rows.push([
        '收货信息',
        `${esc(order.receiver.name)} ${esc(order.receiver.phone)}<br>${esc(
          order.receiver.address
        )}`
      ]);
    }
    if (order.remark) rows.push(['备注', esc(order.remark)]);
    if (order.paidAt) rows.push(['付款时间', dateTime(order.paidAt)]);

    $('orderMeta').innerHTML = rows
      .map(
        ([k, v]) =>
          `<div class="line"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`
      )
      .join('');
  }

  function renderPayPanel() {
    const methods = (site.pay && site.pay.methods) || [];

    // 已完成 / 已取消的订单不再展示收款码
    if (order.status !== 'pending') {
      $('payPanel').hidden = true;
      $('countdown').hidden = true;
      return;
    }

    $('payPanel').hidden = false;

    if (!methods.length) {
      $('payBody').innerHTML = `
        <div class="alert alert-warn">
          <span>⚠️</span>
          <div>商家还没有配置收款方式，请先联系客服完成付款。</div>
        </div>
        <div class="amount-highlight">¥${order.totalText}</div>`;
      return;
    }

    if (!activeMethod || !methods.some((m) => m.key === activeMethod)) {
      activeMethod = methods[0].key;
    }
    const current = methods.find((m) => m.key === activeMethod);

    $('payBody').innerHTML = `
      ${
        methods.length > 1
          ? `<div class="pay-tabs">${methods
              .map(
                (m) =>
                  `<button type="button" class="pay-tab${
                    m.key === activeMethod ? ' active' : ''
                  }" data-method="${esc(m.key)}">${esc(m.name)}</button>`
              )
              .join('')}</div>`
          : `<div class="row" style="justify-content:center;font-weight:650;color:var(--text-muted)">
               ${esc(current.name)}
             </div>`
      }

      <div class="amount-highlight">¥${order.totalText}</div>

      <div class="qr-frame" id="qrFrame"></div>

      ${
        current.account
          ? `<div class="copy-row">
               <span style="color:var(--text-faint);flex:none">收款账号</span>
               <span class="val">${esc(current.account)}</span>
               <button class="btn btn-sm" type="button" data-copy="${esc(current.account)}">复制</button>
             </div>`
          : ''
      }

      <div class="copy-row">
        <span style="color:var(--text-faint);flex:none">付款备注</span>
        <span class="val">${esc(order.orderNo)}</span>
        <button class="btn btn-sm" type="button" data-copy="${esc(order.orderNo)}">复制</button>
      </div>

      ${
        site.pay.note
          ? `<div class="alert alert-info"><span>💡</span><div>${esc(site.pay.note)}</div></div>`
          : ''
      }

      <button class="btn btn-success btn-lg btn-block" id="paidBtn" type="button">
        我已完成付款
      </button>
      <div class="hint" style="text-align:center">
        点击后客服会收到通知并核对到账，请勿重复提交
      </div>`;

    // 收款码
    const frame = $('qrFrame');
    if (current.qr) {
      frame.innerHTML = `<img src="${esc(current.qr)}" alt="${esc(current.name)}收款码">`;
    } else {
      frame.innerHTML = `<div class="qr-placeholder">
          商家尚未上传${esc(current.name)}收款码<br>
          请通过页面底部的客服方式联系商家付款
        </div>`;
    }

    $('payBody').querySelectorAll('.pay-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        activeMethod = tab.dataset.method;
        renderPayPanel();
      });
    });

    $('payBody').querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => copy(btn.dataset.copy));
    });

    $('paidBtn').addEventListener('click', reportPaid);
  }

  async function reportPaid() {
    const btn = $('paidBtn');
    if (!btn) return;

    btn.disabled = true;
    btn.textContent = '提交中…';

    try {
      const res = await api.post(`/api/orders/${encodeURIComponent(orderNo)}/report-paid`, {
        contact,
        payMethod: activeMethod || ''
      });
      order = res.order;
      toast(res.note || '已提交，客服会尽快核对', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
      btn.textContent = '我已完成付款';
    }
  }

  function renderDonePanel() {
    const panel = $('donePanel');

    if (order.status === 'pending') {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;

    if (order.status === 'cancelled') {
      $('doneAlert').innerHTML = `<div class="alert alert-danger">
          <span>✕</span><div>该订单已关闭。如果已经付款，请联系客服处理。</div>
        </div>`;
      $('doneContent').innerHTML = '';
      return;
    }

    if (order.status === 'delivered') {
      if (order.deliveryType === 'manual') {
        $('doneAlert').innerHTML = `<div class="alert alert-ok">
            <span>✓</span><div>订单已完成发货，感谢你的购买！</div>
          </div>`;
        $('doneContent').innerHTML = `
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
                 )}">复制单号</button>`
              : '<div class="hint">商家未填写快递单号，请联系客服获取物流信息。</div>'
          }
          ${
            order.content
              ? `<div class="section-title" style="margin:0">发货说明</div>
                 <div class="secret-box">${esc(order.content)}</div>`
              : ''
          }`;
      } else {
        $('doneAlert').innerHTML = `<div class="alert alert-ok">
            <span>✓</span><div>付款已确认，卡密已自动发放，请妥善保存。</div>
          </div>`;
        $('doneContent').innerHTML = `
          <div class="secret-box" id="secretBox">${esc(order.content || '（无内容）')}</div>
          <button class="btn btn-primary btn-block" type="button" data-copy="${esc(
            order.content || ''
          )}">一键复制全部</button>
          <div class="hint">建议截图保存，或记住订单号随时回到本页查看。</div>`;
      }
    } else {
      // paid
      $('doneAlert').innerHTML = `<div class="alert alert-info">
          <span>${
            order.buyerReportedPaid ? '⏳' : '💳'
          }</span><div>${
            order.buyerReportedPaid
              ? '已收到你的付款通知，客服正在核对到账，请耐心等待。'
              : '订单等待付款确认。'
          }</div>
        </div>`;
      $('doneContent').innerHTML = `<div class="hint">
          发货后本页会自动刷新并显示${
            order.deliveryType === 'auto' ? '卡密' : '快递单号'
          }，也可以稍后到「订单查询」查看。
        </div>`;
    }

    panel.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => copy(btn.dataset.copy));
    });
  }

  /* ---------------- 倒计时 ---------------- */

  function renderCountdown() {
    clearInterval(countdownTimer);
    if (order.status !== 'pending') return;

    const minutes = Number(site.pay?.expireMinutes) || 0;
    if (minutes <= 0) return; // 0 表示不自动关单

    const deadline = new Date(order.createdAt).getTime() + minutes * 60000;

    const tick = () => {
      const left = deadline - Date.now();
      if (left <= 0) {
        clearInterval(countdownTimer);
        $('countdownText').textContent = '00:00';
        setTimeout(() => location.reload(), 4000);
        return;
      }
      const total = Math.floor(left / 1000);
      const m = String(Math.floor(total / 60)).padStart(2, '0');
      const s = String(total % 60).padStart(2, '0');
      $('countdownText').textContent = `${m}:${s}`;
    };

    $('countdown').hidden = false;
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  /* ---------------- 轮询：付款确认后自动展示结果 ---------------- */

  function startPolling() {
    clearInterval(pollTimer);
    if (order.status === 'delivered' || order.status === 'cancelled') return;

    pollTimer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const prev = order.status;
        await loadOrder(contact);
        if (order.status !== prev) {
          if (order.status === 'delivered') {
            toast('商家已确认收款，发货完成！', 'ok', 4000);
            clearInterval(pollTimer);
          }
          render();
        }
      } catch {
        /* 网络抖动就跳过这一轮 */
      }
    }, 10000);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && order) {
      loadOrder(contact)
        .then(() => render())
        .catch(() => {});
    }
  });

  init();
})();
