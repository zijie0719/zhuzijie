'use strict';

/**
 * 端到端自测：把「下单 → 支付 → 确认收款 → 自动发货 → 买家取货」
 * 以及「人工发货商品」的完整链路跑一遍。
 *
 *   node scripts/smoke.js            （需要服务已在 localhost:3000 运行）
 *   BASE=http://localhost:3000 node scripts/smoke.js
 */

const BASE = process.env.BASE || 'http://localhost:3000';

let cookie = '';
let pass = 0;
let fail = 0;

function ok(name, extra = '') {
  pass++;
  console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
}

function bad(name, detail) {
  fail++;
  console.log(`  ✗ ${name}\n      ${detail}`);
}

function check(name, cond, detail = '') {
  cond ? ok(name, detail) : bad(name, detail || '断言失败');
}

async function req(method, path, body) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（例如 CSV） */
  }
  return { status: res.status, json, text, res };
}

async function main() {
  console.log(`\n对 ${BASE} 做端到端自测\n`);

  /* ---------- 1. 前台浏览 ---------- */
  console.log('[1] 前台浏览');
  const site = await req('GET', '/api/site');
  check('站点信息可读取', site.json?.ok === true, site.json?.site?.name);

  const list = await req('GET', '/api/products');
  check('商品列表可读取', Array.isArray(list.json?.products) && list.json.products.length > 0,
    `${list.json?.products?.length} 个商品`);

  const autoProduct = list.json.products.find((p) => p.deliveryType === 'auto');
  const manualProduct = list.json.products.find((p) => p.deliveryType === 'manual');
  check('存在自动发货商品', !!autoProduct, autoProduct?.name);
  check('存在人工发货商品', !!manualProduct, manualProduct?.name);

  const detail = await req('GET', `/api/products/${autoProduct.id}`);
  check('商品详情带描述', typeof detail.json?.product?.description === 'string');

  /* ---------- 2. 自动发货：下单 → 确认收款 → 拿卡密 ---------- */
  console.log('\n[2] 自动发货链路');
  const stockBefore = autoProduct.stock;

  const created = await req('POST', '/api/orders', {
    productId: autoProduct.id,
    quantity: 2,
    contact: '买家小张 <zhang@example.com>',
    remark: '中文备注测试 · emoji 🎉'
  });
  check('下单成功', created.json?.ok === true, created.json?.error);
  const order = created.json.order;
  check('订单状态为待付款', order.status === 'pending');
  check('金额计算正确', order.totalAmount === autoProduct.price * 2,
    `${order.totalText} = ${autoProduct.priceText} × 2`);
  check('中文备注无乱码', order.remark.includes('中文备注测试'), order.remark);

  const wrong = await req('GET', `/api/orders/${order.orderNo}?contact=someone-else`);
  check('错误联系方式被拒绝', wrong.status === 403, wrong.json?.error);

  const right = await req('GET', `/api/orders/${encodeURIComponent(order.orderNo)}?contact=${encodeURIComponent('买家小张 <zhang@example.com>')}`);
  check('正确联系方式可查询', right.json?.ok === true);
  check('待付款订单不泄露卡密', right.json.order.content === '', 'content 为空');

  const reported = await req('POST', `/api/orders/${order.orderNo}/report-paid`, {
    contact: '买家小张 <zhang@example.com>',
    payMethod: 'wechat'
  });
  check('买家可提交付款通知', reported.json?.ok === true);
  check('提交后仍是待确认状态', reported.json.order.status === 'pending',
    '不会因为买家点一下就发货');

  await req('POST', '/api/admin/login', { username: 'admin', password: 'admin123' });
  const found = await req('GET', `/api/admin/orders?q=${encodeURIComponent(order.orderNo)}`);
  const dbOrder = found.json.orders.find((o) => o.order_no === order.orderNo);
  check('后台能看到订单', !!dbOrder);
  check('后台标记了「买家称已付款」', dbOrder?.buyer_reported_paid === 1);

  const confirmed = await req('POST', `/api/admin/orders/${dbOrder.id}/confirm`, { payMethod: 'wechat' });
  check('管理员确认收款', confirmed.json?.ok === true, confirmed.json?.message);
  check('自动发货完成', confirmed.json.order.status === 'delivered');
  check('订单已写入卡密', (confirmed.json.order.delivered_content || '').split('\n').length >= 2);

  const after = await req('GET', `/api/orders/${order.orderNo}?contact=${encodeURIComponent('买家小张 <zhang@example.com>')}`);
  check('买家能查到卡密', after.json.order.content.length > 0, after.json.order.content.slice(0, 24) + '…');
  check('已完成订单状态正确', after.json.order.status === 'delivered');

  const listAfter = await req('GET', '/api/products');
  const autoAfter = listAfter.json.products.find((p) => p.id === autoProduct.id);
  check('库存已扣减', autoAfter.stock === stockBefore - 2, `${stockBefore} → ${autoAfter.stock}`);

  /* ---------- 3. 人工发货链路 ---------- */
  console.log('\n[3] 人工发货链路');
  const m = await req('POST', '/api/orders', {
    productId: manualProduct.id,
    quantity: 1,
    contact: '13900001111',
    receiverName: '李四',
    receiverPhone: '13900001111',
    receiverAddress: '广东省深圳市南山区科技园 1 号'
  });
  check('人工发货商品下单成功', m.json?.ok === true, m.json?.error);
  const mOrder = m.json.order;
  check('收货信息已保存', mOrder.receiver?.name === '李四');

  const missing = await req('POST', '/api/orders', {
    productId: manualProduct.id,
    quantity: 1,
    contact: '13900002222'
  });
  check('缺少收货信息被拒绝', missing.status === 400, missing.json?.error);

  await req('POST', `/api/admin/orders/${mOrder.orderNo ? '' : ''}`);
  const mList = await req('GET', `/api/admin/orders?q=${encodeURIComponent(mOrder.orderNo)}`);
  const mDb = mList.json.orders.find((o) => o.order_no === mOrder.orderNo);

  const mConfirm = await req('POST', `/api/admin/orders/${mDb.id}/confirm`, {});
  check('人工订单确认收款后进入待发货', mConfirm.json.order.status === 'paid');

  const shipped = await req('POST', `/api/admin/orders/${mDb.id}/deliver`, {
    trackingCompany: '顺丰速运',
    trackingNo: 'SF1234567890'
  });
  check('填写快递单号完成发货', shipped.json?.ok === true, shipped.json?.error);
  check('订单状态变为已完成', shipped.json.order.status === 'delivered');

  const mAfter = await req('GET', `/api/orders/${mOrder.orderNo}?contact=13900001111`);
  check('买家能看到快递单号', mAfter.json.order.trackingNo === 'SF1234567890',
    `${mAfter.json.order.trackingCompany} ${mAfter.json.order.trackingNo}`);

  /* ---------- 4. 权限与边界 ---------- */
  console.log('\n[4] 权限与边界');
  const saved = cookie;
  cookie = '';
  const noAuth = await req('GET', '/api/admin/products');
  check('未登录无法访问后台接口', noAuth.status === 401);
  const badLogin = await req('POST', '/api/admin/login', { username: 'admin', password: 'wrong' });
  check('错误密码被拒绝', badLogin.status === 401);
  cookie = saved;

  await req('POST', '/api/admin/login', { username: 'admin', password: 'admin123' });

  const overBuy = await req('POST', '/api/orders', {
    productId: autoProduct.id,
    quantity: 9999,
    contact: 'greedy@example.com'
  });
  check('超量购买被明确拒绝', overBuy.status === 400, overBuy.json?.error);

  const noContact = await req('POST', '/api/orders', {
    productId: autoProduct.id,
    quantity: 1,
    contact: ''
  });
  check('未填联系方式被拒绝', noContact.status === 400, noContact.json?.error);

  // 不限库存（stock = -1）的人工发货商品
  const unlim = await req('POST', '/api/admin/products', {
    name: '不限库存的人工商品',
    price: '1.00',
    deliveryType: 'manual',
    stock: -1,
    status: 1
  });
  const unlimId = unlim.json.id;
  const unlimList = await req('GET', '/api/products');
  const unlimPub = unlimList.json.products.find((p) => p.id === unlimId);
  check('不限库存商品不算售罄', unlimPub && unlimPub.soldOut === false,
    `stock=${unlimPub?.stock} unlimited=${unlimPub?.unlimited}`);
  const unlimOrder = await req('POST', '/api/orders', {
    productId: unlimId,
    quantity: 5,
    contact: 'unlimited@example.com',
    receiverName: '王五',
    receiverPhone: '13700000000',
    receiverAddress: '北京市朝阳区某路 1 号'
  });
  check('不限库存商品可以下单', unlimOrder.json?.ok === true, unlimOrder.json?.error);
  await req('DELETE', `/api/admin/products/${unlimId}`);

  /* ---------- 5. 后台管理能力 ---------- */
  console.log('\n[5] 后台管理能力');
  const newProduct = await req('POST', '/api/admin/products', {
    name: '自测商品 · 中文名 🎯',
    subtitle: '冒烟测试用',
    price: '12.34',
    deliveryType: 'auto',
    maxPerOrder: 5,
    description: '**加粗**\n\n- 列表项',
    status: 1
  });
  check('新建商品成功', newProduct.json?.ok === true, newProduct.json?.error);
  const pid = newProduct.json.id;

  const importRes = await req('POST', `/api/admin/products/${pid}/cards`, {
    content: 'CARD-0001\nCARD-0002\nCARD-0003\nCARD-0001'
  });
  check('批量导入去重生效', importRes.json?.added === 3 && importRes.json?.skipped === 1,
    `导入 ${importRes.json?.added} 条，跳过重复 ${importRes.json?.skipped} 条`);

  const cards = await req('GET', `/api/admin/products/${pid}/cards?status=0`);
  check('卡密列表可读取', cards.json?.cards?.length === 3);

  const delCard = await req('DELETE', `/api/admin/cards/${cards.json.cards[0].id}`);
  check('未售卡密可删除', delCard.json?.ok === true);

  const upd = await req('PUT', `/api/admin/products/${pid}`, {
    name: '自测商品（已改名）',
    price: '99.00',
    deliveryType: 'auto',
    maxPerOrder: 5,
    status: 0
  });
  check('编辑商品成功', upd.json?.ok === true, upd.json?.error);

  const cat = await req('POST', '/api/admin/categories', { name: '自测分类', sort: 5 });
  check('新增分类成功', cat.json?.ok === true);
  check('分类改名成功', (await req('PUT', `/api/admin/categories/${cat.json.id}`, { name: '自测分类2', sort: 6 })).json?.ok === true);
  check('分类删除成功', (await req('DELETE', `/api/admin/categories/${cat.json.id}`)).json?.ok === true);

  const settings = await req('PUT', '/api/admin/settings', { site_name: '自测小店 ⚡' });
  check('保存设置成功', settings.json?.ok === true);
  const reread = await req('GET', '/api/site');
  check('设置已生效', reread.json.site.name === '自测小店 ⚡', reread.json.site.name);
  await req('PUT', '/api/admin/settings', { site_name: '云上小铺' });

  const csv = await req('GET', '/api/admin/orders/export.csv');
  check('CSV 导出可用', csv.res.headers.get('content-type')?.includes('text/csv'),
    `${csv.text.split('\r\n').length - 1} 行数据`);
  check('CSV 含中文表头', csv.text.includes('订单号'));

  const exported = await req('POST', `/api/admin/products/${pid}/cards`, { content: 'X-1\nX-2' });
  check('重复导入仍然可用', exported.json?.added === 2);

  check('删除商品成功', (await req('DELETE', `/api/admin/products/${pid}`)).json?.ok === true);

  const p404 = await req('GET', '/api/products/999999');
  check('不存在的商品返回 404', p404.status === 404);

  const badOrder = await req('GET', '/api/orders/NOTAREALORDER?contact=x');
  check('不存在的订单返回 404', badOrder.status === 404);

  /* ---------- 6. 页面路由 ---------- */
  console.log('\n[6] 页面路由');
  for (const path of ['/', '/query', '/admin', '/admin/login', '/product/' + autoProduct.id, '/pay/' + order.orderNo]) {
    const page = await req('GET', path);
    check(`GET ${path} 返回 HTML`, page.status === 200 && page.text.includes('<!DOCTYPE html>'));
  }
  const nf = await req('GET', '/this-does-not-exist');
  check('未知路径返回 404 页面', nf.status === 404 && nf.text.includes('<!DOCTYPE html>'));

  /* ---------- 汇总 ---------- */
  console.log('\n' + '─'.repeat(52));
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('─'.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\n自测脚本异常终止：', err);
  process.exit(1);
});
