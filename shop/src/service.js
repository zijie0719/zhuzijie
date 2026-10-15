'use strict';

/**
 * 业务逻辑：下单、确认收款、发货、取消、超时关单。
 * 路由层只负责收参数和返回 JSON。
 */

const { db, getSettings, availableStock, nowISO } = require('./db');
const { randomOrderNo, clampInt } = require('./util');

class BizError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 已经回滚过了 */
    }
    throw err;
  }
}

function getProduct(id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

function getOrderByNo(orderNo) {
  return db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
}

function getOrderById(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

/**
 * 取出并锁定 N 张未售卡密。调用方必须已经开启事务。
 */
function allocateCards(productId, quantity, orderId) {
  const cards = db
    .prepare(
      'SELECT id, content FROM cards WHERE product_id = ? AND status = 0 ORDER BY id LIMIT ?'
    )
    .all(productId, quantity);

  if (cards.length < quantity) return null;

  const ts = nowISO();
  const upd = db.prepare(
    'UPDATE cards SET status = 1, order_id = ?, sold_at = ? WHERE id = ? AND status = 0'
  );
  for (const c of cards) upd.run(orderId, ts, c.id);

  return cards.map((c) => c.content);
}

/* ------------------------------------------------------------------ *
 * 下单
 * ------------------------------------------------------------------ */

function createOrder(input) {
  const product = getProduct(input.productId);
  if (!product || product.status !== 1) throw new BizError('商品不存在或已下架', 404);

  const isManual = product.delivery_type === 'manual';
  // stock = -1 表示人工发货商品不限库存
  const unlimited = isManual && Number(product.stock) < 0;

  const requested = clampInt(input.quantity, 1, 999, 1);
  const quantity = requested;

  const maxPer = isManual ? 999 : Math.max(1, Number(product.max_per_order) || 10);
  if (quantity > maxPer) {
    throw new BizError(`该商品每单最多购买 ${maxPer} 件`, 400);
  }

  const stock = availableStock(product);
  if (!unlimited) {
    if (stock <= 0) throw new BizError('商品暂时缺货，请稍后再试', 409);
    if (quantity > stock) throw new BizError(`库存不足，当前仅剩 ${stock} 件`, 409);
  }

  const contact = String(input.contact || '').trim();
  if (!contact) throw new BizError('请填写联系方式，用于接收卡密和查询订单');

  const receiver = {
    name: String(input.receiverName || '').trim(),
    phone: String(input.receiverPhone || '').trim(),
    address: String(input.receiverAddress || '').trim()
  };
  if (isManual) {
    if (!receiver.name) throw new BizError('请填写收件人姓名');
    if (!receiver.phone) throw new BizError('请填写收件人手机号');
    if (!receiver.address) throw new BizError('请填写收货地址');
  }

  const total = product.price * quantity;
  const ts = nowISO();

  const orderId = tx(() => {
    // 自动发货商品在下单瞬间再校验一次库存，防止并发超卖
    if (!isManual) {
      const fresh = availableStock(getProduct(product.id));
      if (fresh < quantity) throw new BizError(`库存不足，当前仅剩 ${fresh} 件`, 409);
    }


    let orderNo = randomOrderNo();
    while (getOrderByNo(orderNo)) orderNo = randomOrderNo();

    const info = db
      .prepare(
        `INSERT INTO orders
           (order_no, product_id, product_name, quantity, unit_price, total_amount,
            delivery_type, contact, remark, receiver_name, receiver_phone, receiver_address,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        orderNo,
        product.id,
        product.name,
        quantity,
        product.price,
        total,
        product.delivery_type,
        contact,
        String(input.remark || '').trim().slice(0, 300),
        receiver.name,
        receiver.phone,
        receiver.address,
        ts,
        ts
      );
    return Number(info.lastInsertRowid);
  });

  return getOrderById(orderId);
}

/* ------------------------------------------------------------------ *
 * 确认收款
 * ------------------------------------------------------------------ */

/**
 * 管理员（或开启了「自动确认」时的用户点按）确认到账。
 * - 自动发货商品：立刻分配卡密，订单直接进入 delivered
 * - 人工发货商品：进入 paid（待发货），等管理员填单号
 */
function confirmPayment(orderId, payMethod = '', opts = {}) {
  return tx(() => {
    const order = getOrderById(orderId);
    if (!order) throw new BizError('订单不存在', 404);
    if (order.status === 'cancelled') throw new BizError('订单已取消，无法确认收款');
    if (order.status === 'delivered') throw new BizError('订单已完成，无需重复确认');

    const ts = nowISO();
    // 先标记已付款，保证即便发货失败，钱的状态也是对的
    db.prepare(
      `UPDATE orders SET status = 'paid', pay_method = ?, paid_at = COALESCE(paid_at, ?),
         admin_remark = ?, updated_at = ? WHERE id = ?`
    ).run(payMethod || order.pay_method, ts, opts.adminRemark ?? order.admin_remark, ts, orderId);

    if (order.delivery_type === 'auto') {
      return { order: deliverAuto(orderId), autoDelivered: true };
    }
    return { order: getOrderById(orderId), autoDelivered: false };
  });
}

/** 必须在事务内调用 */
function deliverAuto(orderId) {
  const order = getOrderById(orderId);
  if (!order || order.status === 'delivered') return order;

  const now = nowISO();

  if (!order.delivered_content) {
    const allocated = allocateCards(order.product_id, order.quantity, order.id);
    if (!allocated) {
      // 停在 paid，等管理员补卡密或手动发货
      db.prepare('UPDATE orders SET admin_remark = ?, updated_at = ? WHERE id = ?').run(
        '⚠ 库存不足，未能自动发卡，请补充卡密后重试',
        now,
        orderId
      );
      return getOrderById(orderId);
    }
    db.prepare('UPDATE orders SET delivered_content = ?, updated_at = ? WHERE id = ?').run(
      allocated.join('\n'),
      now,
      orderId
    );
    db.prepare('UPDATE products SET sales = sales + ? WHERE id = ?').run(
      order.quantity,
      order.product_id
    );
  }

  db.prepare(
    "UPDATE orders SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ?"
  ).run(now, now, orderId);
  return getOrderById(orderId);
}

/* ------------------------------------------------------------------ *
 * 人工发货
 * ------------------------------------------------------------------ */

function deliverManually(orderId, { trackingCompany = '', trackingNo = '', content = '', remark = '' } = {}) {
  return tx(() => {
    const order = getOrderById(orderId);
    if (!order) throw new BizError('订单不存在', 404);
    if (order.status === 'cancelled') throw new BizError('订单已取消，无法发货');
    if (order.status === 'pending') throw new BizError('订单还未确认收款，请先确认到账');

    const ts = nowISO();
    const delivered = String(content || order.delivered_content || '').trim();
    const company = String(trackingCompany || order.tracking_company || '').trim();
    const no = String(trackingNo || order.tracking_no || '').trim();

    if (order.delivery_type === 'manual' && !no && !delivered) {
      throw new BizError('请填写快递单号，或填写要发给买家的内容');
    }

    if (order.delivery_type === 'manual' && order.status !== 'delivered') {
      db.prepare('UPDATE products SET sales = sales + ? WHERE id = ?').run(
        order.quantity,
        order.product_id
      );
    }

    db.prepare(
      `UPDATE orders SET status = 'delivered', delivered_content = ?, tracking_company = ?,
         tracking_no = ?, admin_remark = ?, delivered_at = COALESCE(delivered_at, ?), updated_at = ?
       WHERE id = ?`
    ).run(delivered, company, no, remark || order.admin_remark, ts, ts, orderId);

    return getOrderById(orderId);
  });
}

/* ------------------------------------------------------------------ *
 * 取消
 * ------------------------------------------------------------------ */

function cancelOrder(orderId, reason = '') {
  return tx(() => {
    const order = getOrderById(orderId);
    if (!order) throw new BizError('订单不存在', 404);
    if (order.status === 'delivered') throw new BizError('订单已完成，如需退款请手动处理');

    const ts = nowISO();
    // 归还已经预占的卡密（正常情况下自动发货订单不会走到这里）
    db.prepare('UPDATE cards SET status = 0, order_id = NULL, sold_at = NULL WHERE order_id = ?').run(
      orderId
    );

    db.prepare(
      `UPDATE orders SET status = 'cancelled', admin_remark = ?, updated_at = ? WHERE id = ?`
    ).run(reason || order.admin_remark, ts, orderId);

    return getOrderById(orderId);
  });
}

/* ------------------------------------------------------------------ *
 * 超时关单：待付款超过 N 分钟自动取消
 * ------------------------------------------------------------------ */

function expireStaleOrders() {
  const { order_expire_minutes } = getSettings();
  const minutes = Number(order_expire_minutes) || 30;
  if (minutes <= 0) return 0;

  const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
  const stale = db
    .prepare("SELECT id FROM orders WHERE status = 'pending' AND created_at < ?")
    .all(cutoff);

  for (const row of stale) {
    try {
      cancelOrder(row.id, '超时未付款，系统自动关闭');
    } catch {
      /* 单条失败不影响其他 */
    }
  }
  return stale.length;
}

module.exports = {
  BizError,
  tx,
  createOrder,
  confirmPayment,
  deliverManually,
  deliverAuto,
  cancelOrder,
  expireStaleOrders,
  getOrderByNo,
  getOrderById,
  getProduct
};
