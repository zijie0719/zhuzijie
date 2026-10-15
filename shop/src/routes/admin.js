'use strict';

/** 后台接口：全部挂在 /api/admin 下，除登录外都需要会话 */

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { db, getSettings, setSetting, availableStock, DEFAULT_SETTINGS, UPLOAD_DIR, nowISO } =
  require('../db');
const auth = require('../auth');
const svc = require('../service');
const { fmtCents, toCents, clampInt, str } = require('../util');
const { rateLimit } = require('../ratelimit');

const router = express.Router();

const asyncH = (fn) => (req, res, next) => {
  try {
    fn(req, res, next);
  } catch (err) {
    next(err);
  }
};

/* ================================================================== *
 * 登录 / 登出
 * ================================================================== */

router.post(
  '/login',
  rateLimit({ windowMs: 10 * 60_000, max: 20, message: '尝试次数过多，请稍后再试' }),
  asyncH((req, res) => {
    const ip = req.ip || 'unknown';
    if (auth.isLockedOut(ip)) {
      return res.status(429).json({ ok: false, error: '失败次数过多，请 10 分钟后再试' });
    }

    const username = str(req.body?.username, 64);
    const password = String(req.body?.password || '');

    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    if (!admin || !auth.verifyPassword(password, admin.salt, admin.password_hash)) {
      auth.recordFailure(ip);
      return res.status(401).json({ ok: false, error: '用户名或密码错误' });
    }

    auth.clearFailures(ip);
    auth.clearExpiredSessions();

    const { token, expires } = auth.createSession(admin.id);
    auth.setSessionCookie(res, token, expires);
    db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(nowISO(), admin.id);

    res.json({ ok: true, admin: { id: admin.id, username: admin.username } });
  })
);

router.post('/logout', (req, res) => {
  auth.destroySession(req.adminToken);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.admin) return res.status(401).json({ ok: false, error: '未登录' });
  res.json({ ok: true, admin: req.admin });
});

router.post('/password', auth.requireAdmin, asyncH((req, res) => {
  const oldPw = String(req.body?.oldPassword || '');
  const newPw = String(req.body?.newPassword || '');

  if (newPw.length < 6) {
    return res.status(400).json({ ok: false, error: '新密码至少 6 位' });
  }

  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
  if (!auth.verifyPassword(oldPw, admin.salt, admin.password_hash)) {
    return res.status(401).json({ ok: false, error: '当前密码不正确' });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE admins SET password_hash = ?, salt = ? WHERE id = ?').run(
    auth.hashPassword(newPw, salt),
    salt,
    admin.id
  );
  // 改密后踢掉其他会话
  db.prepare('DELETE FROM sessions WHERE admin_id = ? AND token <> ?').run(admin.id, req.adminToken);

  res.json({ ok: true });
}));

// 以下所有路由都要求登录
router.use(auth.requireAdmin);

/* ================================================================== *
 * 仪表盘
 * ================================================================== */

router.get('/stats', (req, res) => {
  const q = (sql, ...p) => db.prepare(sql).get(...p);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const revenue = q(
    "SELECT COALESCE(SUM(total_amount), 0) AS v FROM orders WHERE status = 'delivered'"
  ).v;
  const todayRevenue = q(
    "SELECT COALESCE(SUM(total_amount), 0) AS v FROM orders WHERE status = 'delivered' AND delivered_at >= ?",
    todayStart.toISOString()
  ).v;

  res.json({
    ok: true,
    stats: {
      revenue,
      revenueText: fmtCents(revenue),
      todayRevenue,
      todayRevenueText: fmtCents(todayRevenue),
      orderTotal: q('SELECT COUNT(*) AS v FROM orders').v,
      orderPending: q("SELECT COUNT(*) AS v FROM orders WHERE status = 'pending'").v,
      orderToShip: q("SELECT COUNT(*) AS v FROM orders WHERE status = 'paid'").v,
      orderDelivered: q("SELECT COUNT(*) AS v FROM orders WHERE status = 'delivered'").v,
      orderToday: q('SELECT COUNT(*) AS v FROM orders WHERE created_at >= ?', todayStart.toISOString()).v,
      productTotal: q('SELECT COUNT(*) AS v FROM products').v,
      productOnline: q('SELECT COUNT(*) AS v FROM products WHERE status = 1').v,
      cardsAvailable: q('SELECT COUNT(*) AS v FROM cards WHERE status = 0').v,
      cardsSold: q('SELECT COUNT(*) AS v FROM cards WHERE status = 1').v,
      lowStock: db
        .prepare(
          `SELECT * FROM (
             SELECT p.id AS id, p.name AS name,
                    (SELECT COUNT(*) FROM cards c
                      WHERE c.product_id = p.id AND c.status = 0) AS stock
               FROM products p
              WHERE p.delivery_type = 'auto' AND p.status = 1
           )
           WHERE stock < 5
           ORDER BY stock ASC LIMIT 10`
        )
        .all()
    }
  });
});

/* ================================================================== *
 * 分类
 * ================================================================== */

router.get('/categories', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS count
         FROM categories c ORDER BY c.sort ASC, c.id ASC`
    )
    .all();
  res.json({ ok: true, categories: rows });
});

router.post('/categories', asyncH((req, res) => {
  const name = str(req.body?.name, 40);
  if (!name) return res.status(400).json({ ok: false, error: '分类名称不能为空' });
  const info = db
    .prepare('INSERT INTO categories (name, sort) VALUES (?, ?)')
    .run(name, clampInt(req.body?.sort, -9999, 9999, 0));
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
}));

router.put('/categories/:id', asyncH((req, res) => {
  const id = Number(req.params.id);
  const name = str(req.body?.name, 40);
  if (!name) return res.status(400).json({ ok: false, error: '分类名称不能为空' });
  db.prepare('UPDATE categories SET name = ?, sort = ? WHERE id = ?').run(
    name,
    clampInt(req.body?.sort, -9999, 9999, 0),
    id
  );
  res.json({ ok: true });
}));

router.delete('/categories/:id', asyncH((req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

/* ================================================================== *
 * 商品
 * ================================================================== */

function adminProduct(p) {
  return {
    ...p,
    priceText: fmtCents(p.price),
    originalPriceText: p.original_price ? fmtCents(p.original_price) : '',
    stockActual: availableStock(p),
    cardStock: Number(
      db.prepare('SELECT COUNT(*) AS n FROM cards WHERE product_id = ? AND status = 0').get(p.id).n
    ),
    cardTotal: Number(
      db.prepare('SELECT COUNT(*) AS n FROM cards WHERE product_id = ?').get(p.id).n
    ),
    categoryName: p.category_id
      ? (db.prepare('SELECT name FROM categories WHERE id = ?').get(p.category_id)?.name ?? '')
      : ''
  };
}

router.get('/products', (req, res) => {
  const rows = db.prepare('SELECT * FROM products ORDER BY sort DESC, id DESC').all();
  res.json({ ok: true, products: rows.map(adminProduct) });
});

router.get('/products/:id', (req, res) => {
  const p = svc.getProduct(Number(req.params.id));
  if (!p) return res.status(404).json({ ok: false, error: '商品不存在' });
  res.json({ ok: true, product: adminProduct(p) });
});

function readProductBody(body) {
  const name = str(body?.name, 120);
  if (!name) throw Object.assign(new Error('商品名称不能为空'), { status: 400 });

  const price = toCents(body?.price);
  if (price === null || price <= 0) {
    throw Object.assign(new Error('请填写有效的商品价格'), { status: 400 });
  }

  const originalPriceRaw = body?.originalPrice;
  const originalPrice =
    originalPriceRaw === '' || originalPriceRaw === null || originalPriceRaw === undefined
      ? null
      : toCents(originalPriceRaw);

  const deliveryType = body?.deliveryType === 'manual' ? 'manual' : 'auto';

  return {
    name,
    subtitle: str(body?.subtitle, 160),
    description: String(body?.description ?? '').slice(0, 20000),
    cover: str(body?.cover, 500),
    price,
    original_price: originalPrice,
    category_id: body?.categoryId ? Number(body.categoryId) || null : null,
    delivery_type: deliveryType,
    stock: deliveryType === 'manual' ? clampInt(body?.stock, -1, 999999, 0) : 0,
    sort: clampInt(body?.sort, -9999, 9999, 0),
    status: body?.status === 0 || body?.status === '0' || body?.status === false ? 0 : 1,
    max_per_order: clampInt(body?.maxPerOrder, 1, 999, 10)
  };
}

router.post('/products', asyncH((req, res) => {
  const d = readProductBody(req.body);
  const ts = nowISO();
  const info = db
    .prepare(
      `INSERT INTO products
         (name, subtitle, description, cover, price, original_price, category_id,
          delivery_type, stock, sort, status, max_per_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      d.name, d.subtitle, d.description, d.cover, d.price, d.original_price, d.category_id,
      d.delivery_type, d.stock, d.sort, d.status, d.max_per_order, ts, ts
    );
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
}));

router.put('/products/:id', asyncH((req, res) => {
  const id = Number(req.params.id);
  if (!svc.getProduct(id)) return res.status(404).json({ ok: false, error: '商品不存在' });

  const d = readProductBody(req.body);
  db.prepare(
    `UPDATE products SET name = ?, subtitle = ?, description = ?, cover = ?, price = ?,
       original_price = ?, category_id = ?, delivery_type = ?, stock = ?, sort = ?, status = ?,
       max_per_order = ?, updated_at = ? WHERE id = ?`
  ).run(
    d.name, d.subtitle, d.description, d.cover, d.price, d.original_price, d.category_id,
    d.delivery_type, d.stock, d.sort, d.status, d.max_per_order, nowISO(), id
  );
  res.json({ ok: true });
}));

router.delete('/products/:id', asyncH((req, res) => {
  const id = Number(req.params.id);
  const sold = db.prepare('SELECT COUNT(*) AS n FROM cards WHERE product_id = ? AND status = 1').get(id).n;
  if (sold > 0) {
    // 已经卖出去的卡密有订单关联，直接删会破坏历史记录，改为下架
    db.prepare('UPDATE products SET status = 0, updated_at = ? WHERE id = ?').run(nowISO(), id);
    return res.json({ ok: true, softDeleted: true, message: '该商品已有售出记录，已改为下架处理' });
  }
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  res.json({ ok: true });
}));

/* ================================================================== *
 * 卡密
 * ================================================================== */

router.get('/products/:id/cards', (req, res) => {
  const id = Number(req.params.id);
  const status = req.query.status;
  let sql = 'SELECT * FROM cards WHERE product_id = ?';
  const params = [id];
  if (status === '0' || status === '1') {
    sql += ' AND status = ?';
    params.push(Number(status));
  }
  sql += ' ORDER BY id DESC LIMIT 500';
  res.json({ ok: true, cards: db.prepare(sql).all(...params) });
});

/** 批量导入卡密：一行一个，自动去重、跳过已存在的 */
router.post('/products/:id/cards', asyncH((req, res) => {
  const id = Number(req.params.id);
  if (!svc.getProduct(id)) return res.status(404).json({ ok: false, error: '商品不存在' });

  const raw = String(req.body?.content ?? '');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5000);

  if (!lines.length) return res.status(400).json({ ok: false, error: '没有解析到任何卡密' });

  const existing = new Set(
    db.prepare('SELECT content FROM cards WHERE product_id = ?').all(id).map((r) => r.content)
  );

  const insert = db.prepare(
    'INSERT INTO cards (product_id, content, status, created_at) VALUES (?, ?, 0, ?)'
  );
  const ts = nowISO();

  let added = 0;
  let skipped = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const line of lines) {
      if (existing.has(line)) {
        skipped += 1;
        continue;
      }
      existing.add(line);
      insert.run(id, line.slice(0, 500), ts);
      added += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({ ok: true, added, skipped, total: lines.length });
}));

router.delete('/cards/:cardId', asyncH((req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(req.params.cardId));
  if (!card) return res.status(404).json({ ok: false, error: '卡密不存在' });
  if (card.status === 1) {
    return res.status(409).json({ ok: false, error: '该卡密已售出，不能删除' });
  }
  db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
  res.json({ ok: true });
}));

router.delete('/products/:id/cards', asyncH((req, res) => {
  const info = db
    .prepare('DELETE FROM cards WHERE product_id = ? AND status = 0')
    .run(Number(req.params.id));
  res.json({ ok: true, removed: Number(info.changes) });
}));

/* ================================================================== *
 * 订单
 * ================================================================== */

router.get('/orders', (req, res) => {
  const { status, q: keyword, page = 1 } = req.query;
  const where = [];
  const params = [];

  if (status && status !== 'all') {
    where.push('status = ?');
    params.push(String(status));
  }
  if (keyword && String(keyword).trim()) {
    where.push('(order_no LIKE ? OR contact LIKE ? OR product_name LIKE ? OR receiver_phone LIKE ?)');
    const like = `%${String(keyword).trim()}%`;
    params.push(like, like, like, like);
  }

  const perPage = 30;
  const current = Math.max(1, Number(page) || 1);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM orders ${whereSql}`).get(...params).n;
  const rows = db
    .prepare(`SELECT * FROM orders ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, perPage, (current - 1) * perPage);

  // 统计各状态数量，用于后台标签上的角标
  const counts = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all()) {
    counts[r.status] = Number(r.n);
  }

  res.json({
    ok: true,
    orders: rows.map((o) => ({ ...o, totalText: fmtCents(o.total_amount), unitPriceText: fmtCents(o.unit_price) })),
    total: Number(total),
    page: current,
    perPage,
    counts
  });
});

/** 导出订单 CSV（用 Excel 打开时中文不会乱码：加 UTF-8 BOM） */
router.get('/orders/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();

  const header = [
    '订单号', '状态', '商品', '数量', '单价', '金额', '发货方式', '联系方式',
    '收货人', '收货电话', '收货地址', '付款方式', '下单时间', '付款时间', '发货时间',
    '快递公司', '快递单号', '发货内容', '备注'
  ];

  const STATUS_CN = { pending: '待付款', paid: '已付款', delivered: '已完成', cancelled: '已取消' };
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const lines = [header.join(',')];
  for (const o of rows) {
    lines.push(
      [
        o.order_no,
        STATUS_CN[o.status] || o.status,
        o.product_name,
        o.quantity,
        fmtCents(o.unit_price),
        fmtCents(o.total_amount),
        o.delivery_type === 'auto' ? '自动发货' : '人工发货',
        o.contact,
        o.receiver_name,
        o.receiver_phone,
        o.receiver_address,
        o.pay_method,
        o.created_at,
        o.paid_at,
        o.delivered_at,
        o.tracking_company,
        o.tracking_no,
        o.delivered_content,
        o.remark
      ]
        .map(esc)
        .join(',')
    );
  }

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

// 注意：必须放在 /orders/export.csv 之后，否则 export.csv 会被当成 :id 吃掉
router.get('/orders/:id', asyncH((req, res) => {
  const order = svc.getOrderById(Number(req.params.id));
  if (!order) return res.status(404).json({ ok: false, error: '订单不存在' });
  res.json({
    ok: true,
    order: {
      ...order,
      totalText: fmtCents(order.total_amount),
      unitPriceText: fmtCents(order.unit_price)
    }
  });
}));

router.post('/orders/:id/confirm', asyncH((req, res) => {
  const { order, autoDelivered } = svc.confirmPayment(
    Number(req.params.id),
    str(req.body?.payMethod, 20),
    { adminRemark: req.body?.remark === undefined ? undefined : str(req.body.remark, 200) }
  );
  res.json({
    ok: true,
    order,
    autoDelivered,
    message: autoDelivered ? '已确认收款并自动发货' : '已确认收款，等待发货'
  });
}));

router.post('/orders/:id/deliver', asyncH((req, res) => {
  const order = svc.deliverManually(Number(req.params.id), {
    trackingCompany: str(req.body?.trackingCompany, 40),
    trackingNo: str(req.body?.trackingNo, 60),
    content: String(req.body?.content ?? '').slice(0, 20000),
    remark: str(req.body?.remark, 200)
  });
  res.json({ ok: true, order, message: '发货成功' });
}));

router.post('/orders/:id/cancel', asyncH((req, res) => {
  const order = svc.cancelOrder(Number(req.params.id), str(req.body?.reason, 200));
  res.json({ ok: true, order, message: '订单已取消' });
}));

router.delete('/orders/:id', asyncH((req, res) => {
  const id = Number(req.params.id);
  const order = svc.getOrderById(id);
  if (!order) return res.status(404).json({ ok: false, error: '订单不存在' });
  if (order.status !== 'cancelled') {
    return res.status(409).json({ ok: false, error: '只能删除已取消的订单' });
  }
  db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  res.json({ ok: true });
}));

/* ================================================================== *
 * 系统设置
 * ================================================================== */

router.get('/settings', (req, res) => {
  res.json({ ok: true, settings: getSettings() });
});

router.put('/settings', asyncH((req, res) => {
  const body = req.body || {};
  const allowed = Object.keys(DEFAULT_SETTINGS);

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      setSetting(key, String(body[key] ?? '').slice(0, 5000));
    }
  }
  res.json({ ok: true, settings: getSettings() });
}));

/* ================================================================== *
 * 图片上传（收款码 / 商品封面）
 * 直接收原始字节，省掉 multipart 解析依赖
 * ================================================================== */

const IMAGE_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
};

/** 用文件头判断真实类型，不信任 Content-Type */
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

router.post(
  '/upload',
  express.raw({ type: () => true, limit: '5mb' }),
  asyncH((req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ ok: false, error: '没有收到图片数据' });
    }

    const type = sniffImage(buf);
    if (!type || !IMAGE_TYPES[type]) {
      return res.status(400).json({ ok: false, error: '只支持 PNG / JPG / GIF / WEBP 图片' });
    }

    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${IMAGE_TYPES[type]}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);

    res.json({ ok: true, url: `/uploads/${filename}` });
  })
);

module.exports = router;
