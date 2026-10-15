'use strict';

/**
 * 自助下单网站 —— 服务入口
 *
 *   npm install && npm start
 *   前台 http://localhost:3000
 *   后台 http://localhost:3000/admin
 */

/* ------------------------------------------------------------------ *
 * 运行环境检查
 *
 * 本项目用 Node 内置的 node:sqlite 存数据，它要求 Node >= 24：
 *   · 22.5 以下根本没有这个模块
 *   · 22.5 ~ 22.12 需要 --experimental-sqlite 参数才能用
 *   · 22.13 起免参数但仍是不稳定 API，启动会打实验性警告
 *   · 24 才是稳定版，所以这里直接卡 24
 * 版本不够时给出人话提示，而不是让 require 抛一句看不懂的报错。
 * ------------------------------------------------------------------ */

const MIN_NODE_MAJOR = 24;
const currentMajor = Number(process.versions.node.split('.')[0]);

if (currentMajor < MIN_NODE_MAJOR) {
  console.error(`
────────────────────────────────────────────────────
  启动失败：Node.js 版本太低

  当前版本： v${process.versions.node}
  需要版本： v${MIN_NODE_MAJOR}.0.0 或更高

  本项目用 Node 内置的 SQLite 存数据，低版本没有这个模块。

  升级方式（任选一种）：

  1) 官方安装脚本（推荐，会自动装最新 LTS）
     curl -fsSL https://rpm.nodesource.com/setup_24.x | bash -
     dnf install -y nodejs

  2) 用 nvm 管理多版本
     curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
     nvm install 24 && nvm use 24

  装完执行 node -v 确认，再重新启动。
────────────────────────────────────────────────────
`);
  process.exit(1);
}

const express = require('express');
const path = require('node:path');

const { createdAdmin } = require('./src/db');
const auth = require('./src/auth');
const svc = require('./src/service');
const apiRoutes = require('./src/routes/api');
const adminRoutes = require('./src/routes/admin');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();

app.disable('x-powered-by');
// 部署在 Nginx / 宝塔等反向代理后面时，把 TRUST_PROXY=1 打开，限流才能拿到真实 IP
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

/* ------------------------------------------------------------------ *
 * 安全响应头
 * ------------------------------------------------------------------ */

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob: https: http:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "font-src 'self' data:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'"
    ].join('; ')
  );
  next();
});

/* ------------------------------------------------------------------ *
 * 解析请求体
 * ------------------------------------------------------------------ */

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(auth.attachAdmin);

/* ------------------------------------------------------------------ *
 * 静态资源
 * ------------------------------------------------------------------ */

app.use(
  '/uploads',
  express.static(path.join(PUBLIC_DIR, 'uploads'), { maxAge: '30d', index: false })
);
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.set('Cache-Control', 'no-cache');
      } else {
        res.set('Cache-Control', 'public, max-age=3600');
      }
    }
  })
);

/* ------------------------------------------------------------------ *
 * 接口
 * ------------------------------------------------------------------ */

app.use('/api/admin', adminRoutes);
app.use('/api', apiRoutes);

/* ------------------------------------------------------------------ *
 * 页面路由（干净的 URL）
 * ------------------------------------------------------------------ */

const page = (file) => (req, res, next) => {
  res.sendFile(path.join(PUBLIC_DIR, file), (err) => (err ? next(err) : undefined));
};

app.get('/', page('index.html'));
app.get('/product/:id', page('product.html'));
app.get('/pay/:orderNo', page('pay.html'));
app.get('/query', page('query.html'));
app.get('/admin', page(path.join('admin', 'index.html')));
app.get('/admin/login', page(path.join('admin', 'login.html')));

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

/* ------------------------------------------------------------------ *
 * 404 & 错误处理
 * ------------------------------------------------------------------ */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: '接口不存在' });
  }
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'), (err) => {
    if (err) res.type('text/plain').send('404 Not Found');
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', err);

  const message =
    status >= 500 && !err.expose ? '服务器开小差了，请稍后重试' : err.message || '请求失败';

  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ ok: false, error: message });
  }
  res.status(status).type('text/plain').send(message);
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

// 定期关闭超时未付款的订单
const sweep = setInterval(
  () => {
    try {
      const n = svc.expireStaleOrders();
      if (n) console.log(`[sweep] 自动关闭 ${n} 笔超时未付款订单`);
    } catch (err) {
      console.error('[sweep] 失败', err);
    }
  },
  5 * 60 * 1000
);
sweep.unref();

const server = app.listen(PORT, HOST, () => {
  const line = '─'.repeat(52);
  console.log(`\n${line}`);
  console.log('  自助下单网站已启动');
  console.log(line);
  console.log(`  前台首页   http://localhost:${PORT}/`);
  console.log(`  订单查询   http://localhost:${PORT}/query`);
  console.log(`  管理后台   http://localhost:${PORT}/admin`);
  if (createdAdmin) {
    console.log(line);
    console.log('  首次启动已创建管理员，请立即登录并修改密码：');
    console.log(`     用户名  ${createdAdmin.username}`);
    console.log(`     密码    ${createdAdmin.password}`);
  } else {
    console.log(line);
    console.log('  管理员账号沿用数据库中的配置');
  }
  console.log(`${line}\n`);
});

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
