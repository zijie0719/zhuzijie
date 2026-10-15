/* 商品详情页：展示 + 下单表单 */

(function () {
  'use strict';

  const { api, esc, markdown, money, toast, bootShell, coverHtml } = window.App;

  const productId = Number((location.pathname.match(/\/product\/(\d+)/) || [])[1]);
  const $ = (id) => document.getElementById(id);

  let product = null;

  /* ---------------- 加载 ---------------- */

  async function load() {
    if (!productId) return location.replace('/');

    bootShell('home');

    try {
      const { product: p } = await api.get(`/api/products/${productId}`);
      product = p;
      render(p);
    } catch (err) {
      $('loading').innerHTML = `
        <div class="empty" style="grid-column:1/-1">
          <div class="icon">😕</div>
          <h3>${esc(err.message)}</h3>
          <p><a href="/" style="color:var(--brand)">← 返回首页看看其他商品</a></p>
        </div>`;
    }
  }

  function render(p) {
    document.title = `${p.name} · 自助下单`;
    $('crumbName').textContent = p.name;
    if (p.categoryId) {
      $('crumbCat').innerHTML = `<a href="/?category=${p.categoryId}">${esc(
        p.categoryName || '分类'
      )}</a>`;
    } else {
      $('crumbCat').textContent = '未分类';
    }

    $('gallery').innerHTML = coverHtml(p, 96);

    $('pName').textContent = p.name;
    $('pSubtitle').textContent = p.subtitle || '';
    $('pPrice').textContent = p.priceText;
    $('pOld').innerHTML =
      p.originalPrice && p.originalPrice > p.price
        ? `<span class="price-old">¥${p.originalPriceText}</span>`
        : '';
    $('pDelivery').textContent = p.deliveryText;

    const unlimited = p.unlimited;
    $('pStock').textContent = p.soldOut ? '已售罄' : unlimited ? '现货充足' : `${p.stock} 件`;
    $('pSales').textContent = `${p.sales} 件`;
    $('pCategory').textContent = p.categoryName || '未分类';

    if (p.description && p.description.trim()) {
      $('pDesc').innerHTML = markdown(p.description);
      $('descSection').hidden = false;
    }

    if (p.deliveryType === 'auto') {
      $('contactHint').textContent = '卡密将展示在订单页，请务必填写你能收到的联系方式';
      $('submitHint').textContent = '付款后系统自动发放卡密，无需等待人工';
    } else {
      $('shipFields').hidden = false;
      $('contactHint').textContent = '用于接收发货通知和查询订单';
      $('submitHint').textContent = '付款后由人工审核打包发货，发货后可在订单查询里查看快递单号';
    }

    // 不限库存时只受「每单限购」约束
    const stockCap = p.unlimited ? Infinity : p.stock;
    const maxQty = p.soldOut ? 0 : Math.max(1, Math.min(stockCap, p.maxPerOrder));
    $('qtyHint').textContent = p.soldOut
      ? '暂时缺货'
      : `最多可购买 ${maxQty} 件`;

    const qty = $('qty');
    qty.max = String(Math.max(1, maxQty));
    qty.value = '1';

    if (p.soldOut) {
      $('soldOutNotice').hidden = false;
      $('submitBtn').disabled = true;
      $('submitBtn').textContent = '已售罄';
    } else {
      $('submitBtn').disabled = false;
    }

    $('loading').hidden = true;
    $('content').hidden = false;

    updateTotal();
  }

  /* ---------------- 数量与合计 ---------------- */

  function currentQty() {
    const input = $('qty');
    const max = Number(input.max) || 1;
    let v = Math.trunc(Number(input.value) || 1);
    if (!Number.isFinite(v) || v < 1) v = 1;
    if (v > max) v = max;
    input.value = String(v);
    return v;
  }

  function updateTotal() {
    if (!product) return;
    const q = currentQty();
    $('total').textContent = money(product.price * q);
    $('qtyMinus').disabled = q <= 1;
    $('qtyPlus').disabled = q >= (Number($('qty').max) || 1);
  }

  $('qtyMinus').addEventListener('click', () => {
    $('qty').value = String(currentQty() - 1);
    updateTotal();
  });

  $('qtyPlus').addEventListener('click', () => {
    $('qty').value = String(currentQty() + 1);
    updateTotal();
  });

  $('qty').addEventListener('input', updateTotal);
  $('qty').addEventListener('blur', updateTotal);

  /* ---------------- 提交 ---------------- */

  $('submitBtn').addEventListener('click', async () => {
    if (!product) return;

    const btn = $('submitBtn');
    const contact = $('contact').value.trim();

    if (!contact) {
      toast('请填写联系方式', 'err');
      $('contact').focus();
      return;
    }
    if (/\s/.test(contact) && contact.length < 5) {
      toast('联系方式格式看起来不太对', 'err');
      return;
    }

    if (product.deliveryType === 'manual') {
      const required = [
        ['rName', '请填写收件人姓名'],
        ['rPhone', '请填写收件人手机号'],
        ['rAddr', '请填写收货地址']
      ];
      for (const [id, message] of required) {
        if (!$('' + id).value.trim()) {
          toast(message, 'err');
          $('' + id).focus();
          return;
        }
      }
    }

    const payload = {
      productId: product.id,
      quantity: currentQty(),
      contact,
      remark: $('remark').value.trim(),
      receiverName: $('rName').value.trim(),
      receiverPhone: $('rPhone').value.trim(),
      receiverAddress: $('rAddr').value.trim()
    };

    btn.disabled = true;
    btn.textContent = '正在创建订单…';

    try {
      const { order } = await api.post('/api/orders', payload);
      try {
        sessionStorage.setItem('lastOrderNo', order.orderNo);
        sessionStorage.setItem('lastOrderContact', contact);
      } catch {
        /* ignore */
      }
      location.href = `/pay/${order.orderNo}`;
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
      btn.textContent = '立即下单';
    }
  });

  load();
})();
