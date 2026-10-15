'use strict';

/** 前台接口：浏览商品、下单、查询订单 */

const express = require('express');
const { db, getSettings, availableStock } = require('../db');
const { fmtCents } = require('../util');
const svc = require('../service');
const { rateLimit } = require('../ratelimit');

const router = express.Router();

/* ------------------------------------------------------------------ *
 * 序列化
 * ------------------------------------------------------------------ */

function publicProduct(p, { withDescription = false } = {}) {
  const stock = availableStock(p);
  // stock = -1 表示人工发货商品不限库存
  const unlimited = p.delivery_type === 'manual' && Number(p.stock) < 0;

  const category = p.category_id
    ? db.prepare('SELECT name FROM categories WHERE id = ?').get(p.category_id)
    : null;

  const out = {
    id: p.id,
    name: p.name,
    subtitle: p.subtitle,
    cover: p.cover,
    price: p.price,
    priceText: fmtCents(p.price),
    originalPrice: p.original_price || null,
    originalPriceText: p.original_price ? fmtCents(p.original_price) : null,
    categoryId: p.category_id,
    categoryName: category ? category.name : '',
    deliveryType: p.delivery_type,
    deliveryText: p.delivery_type === 'auto' ? '自动发货' : '人工发货',
    stock,
    unlimited,
    soldOut: !unlimited && stock <= 0,
    sales: p.sales,
    // 每单限购：自动发货商品按后台设置，人工发货统一放宽到 999，实际还受库存上限约束
    maxPerOrder: p.delivery_type === 'auto' ? Math.max(1, p.max_per_order) : 999
  };
  if (withDescription) out.description = p.description;
  return out;
}

/** 对外暴露的订单视图：不含内部备注，待付款订单不返回卡密 */
function publicOrder(order) {
  const delivered = order.status === 'delivered';
  return {
    orderNo: order.order_no,
    productName: order.product_name,
    productId: order.product_id,
    quantity: order.quantity,
    unitPriceText: fmtCents(order.unit_price),
    totalAmount: order.total_amount,
    totalText: fmtCents(order.total_amount),
    deliveryType: order.delivery_type,
    status: order.status,
    statusText: STATUS_TEXT[order.status] || order.status,
    contact: order.contact,
    remark: order.remark,
    receiver:
      order.delivery_type === 'manual'
        ? {
            name: order.receiver_name,
            phone: order.receiver_phone,
            address: order.receiver_address
          }
        : null,
    trackingCompany: delivered ? order.tracking_company : '',
    trackingNo: delivered ? order.tracking_no : '',
    content: delivered ? order.delivered_content : '',
    buyerReportedPaid: !!order.buyer_reported_paid,
    payMethod: order.pay_method,
    paidAt: order.paid_at,
    deliveredAt: order.delivered_at,
    createdAt: order.created_at
  };
}

const STATUS_TEXT = {
  pending: '待付款',
  paid: '已付款 · 待发货',
  delivered: '已完成',
  cancelled: '已取消'
};

/* ------------------------------------------------------------------ *
 * 站点信息
 * ------------------------------------------------------------------ */

router.get('/site', (req, res) => {
  const s = getSettings();
  res.json({
    ok: true,
    site: {
      name: s.site_name,
      subtitle: s.site_subtitle,
      notice: s.site_notice,
      logo: s.site_logo,
      footer: s.footer_text,
      queryRequireContact: s.query_require_contact === '1',
      contact: {
        qq: s.contact_qq,
        wechat: s.contact_wechat,
        email: s.contact_email,
        hours: s.contact_hours
      },
      pay: {
        note: s.pay_note,
        expireMinutes: Number(s.order_expire_minutes) || 30,
        methods: buildPayMethods(s)
      }
    }
  });
});

/** 只把「已启用且填了收款码」的方式返回给前台 */
function buildPayMethods(s) {
  const methods = [];
  if (s.pay_wechat_enabled === '1') {
    methods.push({
      key: 'wechat',
      name: '微信支付',
      qr: s.pay_wechat_qr,
      account: s.pay_wechat_name
    });
  }
  if (s.pay_alipay_enabled === '1') {
    methods.push({
      key: 'alipay',
      name: '支付宝',
      qr: s.pay_alipay_qr,
      account: s.pay_alipay_name
    });
  }
  return methods;
}

/* ------------------------------------------------------------------ *
 * 商品
 * ------------------------------------------------------------------ */

router.get('/categories', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.sort,
              (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status = 1) AS count
         FROM categories c ORDER BY c.sort ASC, c.id ASC`
    )
    .all();
  res.json({ ok: true, categories: rows });
});

router.get('/products', (req, res) => {
  const { category, q, sort } = req.query;
  const where = ['status = 1'];
  const params = [];

  if (category && category !== 'all') {
    where.push('category_id = ?');
    params.push(Number(category));
  }
  if (q && String(q).trim()) {
    where.push('(name LIKE ? OR subtitle LIKE ?)');
    const like = `%${String(q).trim()}%`;
    params.push(like, like);
  }

  const orderBy =
    sort === 'price_asc'
      ? 'price ASC'
      : sort === 'price_desc'
        ? 'price DESC'
        : sort === 'sales'
          ? 'sales DESC'
          : 'sort DESC, id DESC';

  const rows = db
    .prepare(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`)
    .all(...params);

  res.json({ ok: true, products: rows.map((p) => publicProduct(p)) });
});

router.get('/products/:id', (req, res) => {
  const p = svc.getProduct(Number(req.params.id));
  if (!p || p.status !== 1) {
    return res.status(404).json({ ok: false, error: '商品不存在或已下架' });
  }
  res.json({ ok: true, product: publicProduct(p, { withDescription: true }) });
});

/* ------------------------------------------------------------------ *
 * 下单
 * ------------------------------------------------------------------ */

router.post('/orders', rateLimit({ windowMs: 60_000, max: 20 }), (req, res, next) => {
  try {
    const order = svc.createOrder({
      productId: Number(req.body.productId),
      quantity: req.body.quantity,
      contact: req.body.contact,
      remark: req.body.remark,
      receiverName: req.body.receiverName,
      receiverPhone: req.body.receiverPhone,
      receiverAddress: req.body.receiverAddress
    });

    const s = getSettings();
    res.json({
      ok: true,
      order: publicOrder(order),
      pay: {
        note: s.pay_note,
        expireMinutes: Number(s.order_expire_minutes) || 30,
        methods: buildPayMethods(s)
      }
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * 订单查询
 * ------------------------------------------------------------------ */

router.get('/orders/:orderNo', rateLimit({ windowMs: 60_000, max: 40 }), (req, res) => {
  const order = svc.getOrderByNo(String(req.params.orderNo || '').trim().toUpperCase());
  if (!order) {
    return res.status(404).json({ ok: false, error: '订单不存在，请核对订单号' });
  }

  const s = getSettings();
  if (s.query_require_contact === '1') {
    const contact = String(req.query.contact || '').trim();
    if (!contact) {
      return res.status(401).json({ ok: false, error: '请输入下单时填写的联系方式', needContact: true });
    }
    if (contact.toLowerCase() !== String(order.contact).trim().toLowerCase()) {
      return res.status(403).json({ ok: false, error: '联系方式与订单不匹配', needContact: true });
    }
  }

  res.json({ ok: true, order: publicOrder(order) });
});

/* ------------------------------------------------------------------ *
 * 买家点「我已完成付款」
 * ------------------------------------------------------------------ */

router.post('/orders/:orderNo/report-paid', rateLimit({ windowMs: 60_000, max: 15 }), (req, res) => {
  const order = svc.getOrderByNo(String(req.params.orderNo || '').trim().toUpperCase());
  if (!order) return res.status(404).json({ ok: false, error: '订单不存在' });
  if (order.status === 'cancelled') {
    return res.status(409).json({ ok: false, error: '订单已关闭，无法提交' });
  }
  if (order.status !== 'pending') {
    return res.json({ ok: true, order: publicOrder(order), note: '订单已处理，无需重复提交' });
  }

  const contact = String(req.body?.contact || '').trim();
  const s = getSettings();
  if (s.query_require_contact === '1' && contact &&
      contact.toLowerCase() !== String(order.contact).trim().toLowerCase()) {
    return res.status(403).json({ ok: false, error: '联系方式与订单不匹配' });
  }

  const ts = new Date().toISOString();
  const payMethod = String(req.body?.payMethod || '').trim().slice(0, 20);

  db.prepare(
    `UPDATE orders SET buyer_reported_paid = 1, buyer_reported_at = ?,
       pay_method = CASE WHEN ? <> '' THEN ? ELSE pay_method END, updated_at = ?
     WHERE id = ?`
  ).run(ts, payMethod, payMethod, ts, order.id);

  // 店铺开启「自动确认」时，省掉人工核对这一步，直接发货
  if (s.auto_confirm === '1') {
    try {
      const { order: updated } = svc.confirmPayment(order.id, payMethod);
      return res.json({ ok: true, order: publicOrder(updated), autoConfirmed: true });
    } catch {
      /* 自动确认失败就退回人工流程 */
    }
  }

  res.json({
    ok: true,
    order: publicOrder(svc.getOrderById(order.id)),
    note: '已收到你的付款通知，客服核对到账后会尽快发货'
  });
});

module.exports = router;
