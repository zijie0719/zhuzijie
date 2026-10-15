'use strict';

/**
 * 前台/后台页面的渲染自测。
 *
 * 用 jsdom 真实加载每个页面、执行页面脚本，把 window.fetch 指向本地服务，
 * 然后检查：有没有 JS 报错、关键内容有没有渲染出来。
 *
 *   node scripts/ui-test.js          （需要服务已在 localhost:3000 运行）
 *   BASE=http://localhost:3000 node scripts/ui-test.js
 */

const path = require('node:path');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.env.BASE || 'http://localhost:3000';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`);
  }
}

/** 路由 → 磁盘上的 HTML 文件，跟 server.js 里的页面路由保持一致 */
function resolveHtml(routePath) {
  if (routePath === '/') return 'index.html';
  if (routePath === '/query') return 'query.html';
  if (routePath === '/admin') return 'admin/index.html';
  if (routePath === '/admin/login') return 'admin/login.html';
  if (routePath.startsWith('/product/')) return 'product.html';
  if (routePath.startsWith('/pay/')) return 'pay.html';
  throw new Error('测试脚本里没有配置这个路由的页面文件: ' + routePath);
}

/**
 * 加载一个页面并等它「安静下来」（脚本跑完、异步请求完成）
 */
async function render(routePath, { waitMs = 900, cookie = '' } = {}) {
  const htmlPath = path.join(PUBLIC_DIR, resolveHtml(routePath));
  const html = fs.readFileSync(htmlPath, 'utf8');

  const errors = [];

  // jsdom 没有实现页面跳转，页面里 location.href = '...' 会抛出这个提示。
  // 那是测试环境的限制，不是代码问题，过滤掉。
  const IGNORED = [/Not implemented: navigation/i];

  const push = (msg) => {
    if (IGNORED.some((re) => re.test(msg))) return;
    errors.push(msg);
  };

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => push('jsdomError: ' + err.message));
  virtualConsole.on('error', (...args) => push('console.error: ' + args.join(' ')));
  // 页面里的 console.log 不当作错误，忽略

  const dom = new JSDOM(html, {
    url: BASE + routePath,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole
  });

  const { window } = dom;

  // 让页面里的 fetch 打到真实服务上
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const absolute = url.startsWith('http') ? url : BASE + url;
    const opts = { ...init };
    if (cookie) opts.headers = { ...(opts.headers || {}), Cookie: cookie };
    return fetch(absolute, opts);
  };

  // jsdom 没有实现 matchMedia 之外的几个 API，补上避免页面脚本报错
  window.matchMedia =
    window.matchMedia ||
    (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  window.scrollTo = () => {};

  const cookieJar = {};
  Object.defineProperty(window.document, 'cookie', {
    get: () => Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; '),
    set: (v) => {
      const [pair] = v.split(';');
      const i = pair.indexOf('=');
      cookieJar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    },
    configurable: true
  });

  await new Promise((r) => setTimeout(r, waitMs));

  return { dom, window, doc: window.document, errors, close: () => dom.window.close() };
}

async function main() {
  console.log(`\n对 ${BASE} 做页面渲染自测\n`);

  /* ---------------- 首页 ---------------- */
  console.log('[1] 首页');
  {
    const p = await render('/', { waitMs: 1200 });

    check('无 JS 报错', p.errors.length === 0, p.errors.join('\n      '));
    check('页头已渲染', !!p.doc.querySelector('.site-header .logo'));
    check('显示店铺名', (p.doc.querySelector('.site-header .logo span:last-child')?.textContent || '').length > 0,
      p.doc.querySelector('.site-header .logo span:last-child')?.textContent);
    check('Hero 已显示', p.doc.getElementById('hero')?.hidden === false);
    check('分类筛选已渲染', p.doc.querySelectorAll('#chips .chip').length > 1,
      `${p.doc.querySelectorAll('#chips .chip').length} 个分类`);
    check('商品卡片已渲染', p.doc.querySelectorAll('#grid .card').length > 0,
      `${p.doc.querySelectorAll('#grid .card').length} 个商品`);
    check('商品卡片有价格', !!p.doc.querySelector('#grid .card .price'));
    check('商品卡片有下单按钮', !!p.doc.querySelector('#grid .card .btn-buy'));
    check('页脚已渲染', !!p.doc.querySelector('.site-footer .inner'));

    p.close();
  }

  /* ---------------- 商品详情 ---------------- */
  console.log('\n[2] 商品详情页');
  {
    const list = await (await fetch(BASE + '/api/products')).json();
    const auto = list.products.find((x) => x.deliveryType === 'auto');
    const manual = list.products.find((x) => x.deliveryType === 'manual' && !x.unlimited);

    const p = await render(`/product/${auto.id}`, { waitMs: 1100 });
    check('无 JS 报错', p.errors.length === 0, p.errors.join('\n      '));
    check('商品名已渲染', p.doc.getElementById('pName')?.textContent === auto.name,
      p.doc.getElementById('pName')?.textContent);
    check('价格已渲染', p.doc.getElementById('pPrice')?.textContent === auto.priceText,
      '¥' + p.doc.getElementById('pPrice')?.textContent);
    check('发货方式已渲染', p.doc.getElementById('pDelivery')?.textContent === '自动发货');
    check('数量上限已设置', Number(p.doc.getElementById('qty')?.max) ===
      Math.min(auto.stock, auto.maxPerOrder),
      `max=${p.doc.getElementById('qty')?.max}`);
    check('自动发货不显示收货信息', p.doc.getElementById('shipFields')?.hidden !== false);
    check('详情内容已渲染', p.doc.getElementById('descSection')?.hidden === false);
    check('详情里的 Markdown 列表已转成 ul', !!p.doc.querySelector('#pDesc ul'));
    check('详情里的粗体已转成 strong', !!p.doc.querySelector('#pDesc strong'));
    check('下单按钮可用', p.doc.getElementById('submitBtn')?.disabled === false);
    p.close();

    // 人工发货商品应显示收货信息
    const p2 = await render(`/product/${manual.id}`, { waitMs: 1100 });
    check('人工发货显示收货信息', p2.doc.getElementById('shipFields')?.hidden === false);
    check('人工发货按钮可用', p2.doc.getElementById('submitBtn')?.disabled === false);
    check('人工发货提示正确', (p2.doc.getElementById('submitHint')?.textContent || '').includes('人工'));
    p2.close();
  }

  /* ---------------- 下单 → 支付页 ---------------- */
  console.log('\n[3] 下单并跳转支付页');
  let createdOrderNo = '';
  {
    const list = await (await fetch(BASE + '/api/products')).json();
    const auto = list.products.find((x) => x.deliveryType === 'auto');

    const p = await render(`/product/${auto.id}`, { waitMs: 1100 });

    // 模拟买家填写表单并点击下单
    p.doc.getElementById('contact').value = 'ui-test@example.com';
    p.doc.getElementById('qty').value = '2';
    p.doc.getElementById('qty').dispatchEvent(new p.window.Event('input', { bubbles: true }));

    check('合计金额随数量更新',
      p.doc.getElementById('total')?.textContent === ((auto.price * 2) / 100).toFixed(2),
      '¥' + p.doc.getElementById('total')?.textContent);

    p.doc.getElementById('submitBtn').dispatchEvent(new p.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1000));

    // 页面脚本用 location.href 跳转，jsdom 下拿不到，改为直接读 sessionStorage
    const orderNo = p.window.sessionStorage.getItem('lastOrderNo');
    check('下单成功并记录了订单号', !!orderNo, orderNo);
    check('下单后无 JS 报错', p.errors.length === 0, p.errors.join('\n      '));
    createdOrderNo = orderNo || '';
    p.close();
  }

  /* ---------------- 支付页 ---------------- */
  console.log('\n[4] 支付页');
  if (createdOrderNo) {
    const p = await render(`/pay/${createdOrderNo}`, { waitMs: 1300 });
    check('无 JS 报错', p.errors.length === 0, p.errors.join('\n      '));

    // 直接访问支付页时没有 sessionStorage，应出现验证框
    const gateShown = p.doc.getElementById('gate')?.hidden === false;
    check('无凭证时要求验证联系方式', gateShown);

    if (gateShown) {
      p.doc.getElementById('gateContact').value = 'ui-test@example.com';
      p.doc.getElementById('gateBtn').dispatchEvent(new p.window.Event('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1100));
    }

    check('订单信息已渲染', !!(p.doc.getElementById('orderMeta')?.textContent || '').includes('订单号'));
    check('显示订单号', (p.doc.getElementById('orderMeta')?.textContent || '').includes(createdOrderNo));
    check('显示应付金额', (p.doc.getElementById('payBody')?.textContent || '').includes('¥'));
    check('显示收款方式切换或单一方式',
      p.doc.querySelectorAll('#payBody .pay-tab').length > 0 ||
        (p.doc.getElementById('payBody')?.textContent || '').includes('微信'));
    check('有「我已完成付款」按钮', !!p.doc.getElementById('paidBtn'));
    check('倒计时已启动', p.doc.getElementById('countdown')?.hidden === false);
    check('无 JS 报错（交互后）', p.errors.length === 0, p.errors.join('\n      '));
    p.close();
  } else {
    check('支付页测试被跳过（没有订单号）', false);
  }

  /* ---------------- 订单查询页 ---------------- */
  console.log('\n[5] 订单查询页');
  {
    const p = await render('/query', { waitMs: 900 });
    check('无 JS 报错', p.errors.length === 0, p.errors.join('\n      '));
    check('查询表单已渲染', !!p.doc.getElementById('queryBtn'));
    check('页头正常', !!p.doc.querySelector('.site-header .logo'));
    p.close();
  }

  /* ---------------- 后台登录 ---------------- */
  console.log('\n[6] 后台页面');
  {
    const p = await render('/admin/login', { waitMs: 900 });
    check('登录页无 JS 报错', p.errors.length === 0, p.errors.join('\n      '));
    check('登录表单已渲染', !!p.doc.getElementById('loginForm'));
    p.close();

    // 用真实登录拿 Cookie，再进后台
    const res = await fetch(BASE + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    check('后台登录拿到会话', !!cookie);

    const admin = await render('/admin', { waitMs: 1400, cookie });
    check('后台无 JS 报错', admin.errors.length === 0, admin.errors.join('\n      '));
    check('侧栏已渲染', !!admin.doc.querySelector('.side-nav a[data-route="dashboard"]'));
    check('显示当前管理员', admin.doc.getElementById('adminName')?.textContent === 'admin');
    check('概览默认激活', admin.doc.querySelector('[data-view="dashboard"]')?.classList.contains('active'));
    check('统计卡片已渲染', admin.doc.querySelectorAll('#statGrid .stat').length >= 6,
      `${admin.doc.querySelectorAll('#statGrid .stat').length} 张卡片`);
    check('最近订单表格已渲染', !!admin.doc.querySelector('#recentTable thead'));

    // 切到商品管理
    admin.doc.querySelector('.side-nav a[data-route="products"]')
      .dispatchEvent(new admin.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    check('商品管理可切换', admin.doc.querySelector('[data-view="products"]')?.classList.contains('active'));
    check('商品表格已渲染', admin.doc.querySelectorAll('#productsTable tbody tr').length > 0,
      `${admin.doc.querySelectorAll('#productsTable tbody tr').length} 行`);
    check('商品行有编辑按钮', !!admin.doc.querySelector('#productsTable [data-pact="edit"]'));

    // 切到订单管理
    admin.doc.querySelector('.side-nav a[data-route="orders"]')
      .dispatchEvent(new admin.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    check('订单管理可切换', admin.doc.querySelector('[data-view="orders"]')?.classList.contains('active'));
    check('订单状态标签已渲染', admin.doc.querySelectorAll('#orderTabs .chip').length === 5,
      `${admin.doc.querySelectorAll('#orderTabs .chip').length} 个标签`);
    check('订单表格已渲染', !!admin.doc.querySelector('#ordersTable thead'));

    // 切到卡密库存
    admin.doc.querySelector('.side-nav a[data-route="cards"]')
      .dispatchEvent(new admin.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    check('卡密页可切换', admin.doc.querySelector('[data-view="cards"]')?.classList.contains('active'));
    check('卡密商品下拉已填充', (admin.doc.getElementById('cardProduct')?.options.length || 0) > 0,
      `${admin.doc.getElementById('cardProduct')?.options.length} 个选项`);

    // 切到收款设置
    admin.doc.querySelector('.side-nav a[data-route="payment"]')
      .dispatchEvent(new admin.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    check('收款设置可切换', admin.doc.querySelector('[data-view="payment"]')?.classList.contains('active'));
    check('微信/支付宝收款块都已渲染',
      !!admin.doc.querySelector('[data-picker="wechat_qr"]') &&
        !!admin.doc.querySelector('[data-picker="alipay_qr"]'));
    check('收款设置页无 JS 报错', admin.errors.length === 0, admin.errors.join('\n      '));

    // 切到系统设置
    admin.doc.querySelector('.side-nav a[data-route="settings"]')
      .dispatchEvent(new admin.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    check('系统设置可切换', admin.doc.querySelector('[data-view="settings"]')?.classList.contains('active'));
    check('设置表单已渲染', !!admin.doc.getElementById('sSiteName'));
    check('Logo 上传控件已渲染', !!admin.doc.querySelector('[data-picker="logo"]'));

    // 打开「发布新商品」弹窗
    admin.doc.getElementById('addProductBtn')
      .dispatchEvent(new admin.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    check('商品编辑弹窗可打开', !!admin.doc.querySelector('.modal-backdrop .modal'));
    check('弹窗含封面图上传控件', !!admin.doc.querySelector('.modal [data-picker="cover"]'));
    check('弹窗含发货方式选择', !!admin.doc.querySelector('.modal #fDelivery'));
    check('弹窗无 JS 报错', admin.errors.length === 0, admin.errors.join('\n      '));

    admin.close();
  }

  console.log('\n' + '─'.repeat(52));
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('─'.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\n页面自测异常终止：', err);
  process.exit(1);
});
