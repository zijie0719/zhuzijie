'use strict';

/**
 * 数据层：使用 Node 24 内置的 node:sqlite，无需安装数据库、无需编译原生模块。
 * 所有金额一律以「分」为单位存整数，避免浮点误差。
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'public', 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'shop.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/* ------------------------------------------------------------------ *
 * 建表
 * ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  subtitle       TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',
  cover          TEXT NOT NULL DEFAULT '',
  price          INTEGER NOT NULL,
  original_price INTEGER,
  category_id    INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  delivery_type  TEXT NOT NULL DEFAULT 'auto',
  stock          INTEGER NOT NULL DEFAULT 0,
  sales          INTEGER NOT NULL DEFAULT 0,
  sort           INTEGER NOT NULL DEFAULT 0,
  status         INTEGER NOT NULL DEFAULT 1,
  max_per_order  INTEGER NOT NULL DEFAULT 10,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  status     INTEGER NOT NULL DEFAULT 0,
  order_id   INTEGER,
  created_at TEXT NOT NULL,
  sold_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_cards_pick ON cards(product_id, status);

CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no          TEXT NOT NULL UNIQUE,
  product_id        INTEGER,
  product_name      TEXT NOT NULL,
  quantity          INTEGER NOT NULL DEFAULT 1,
  unit_price        INTEGER NOT NULL,
  total_amount      INTEGER NOT NULL,
  delivery_type     TEXT NOT NULL,
  contact           TEXT NOT NULL,
  remark            TEXT NOT NULL DEFAULT '',
  receiver_name     TEXT NOT NULL DEFAULT '',
  receiver_phone    TEXT NOT NULL DEFAULT '',
  receiver_address  TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'pending',
  pay_method        TEXT NOT NULL DEFAULT '',
  paid_at           TEXT,
  delivered_at      TEXT,
  delivered_content TEXT NOT NULL DEFAULT '',
  tracking_company  TEXT NOT NULL DEFAULT '',
  tracking_no       TEXT NOT NULL DEFAULT '',
  admin_remark      TEXT NOT NULL DEFAULT '',
  buyer_reported_paid INTEGER NOT NULL DEFAULT 0,
  buyer_reported_at   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`);

/* ------------------------------------------------------------------ *
 * 轻量迁移：给早先建好的库补上后加的列
 * ------------------------------------------------------------------ */

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

ensureColumn('orders', 'buyer_reported_paid', 'buyer_reported_paid INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'buyer_reported_at', 'buyer_reported_at TEXT');

/* ------------------------------------------------------------------ *
 * 默认配置（可在后台「系统设置」里全部改掉）
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  site_name: '云上小铺',
  site_subtitle: '自助下单 · 自动发货 · 7×24 小时不打烊',
  site_notice:
    '下单后请按页面提示扫码付款，并备注订单号。付款完成后点击「我已完成付款」，客服核对到账后立即发货。',
  site_logo: '',
  contact_qq: '',
  contact_wechat: '',
  contact_email: '',
  contact_hours: '每天 09:00 - 23:00',
  footer_text: '本站商品均为虚拟/实物自营，如有疑问请通过页面客服方式联系。',

  pay_wechat_enabled: '1',
  pay_wechat_qr: '',
  pay_wechat_name: '',
  pay_alipay_enabled: '1',
  pay_alipay_qr: '',
  pay_alipay_name: '',
  pay_note: '付款时请在备注中填写订单号，未备注将影响发货速度。',
  order_expire_minutes: '30',

  query_require_contact: '1',
  auto_confirm: '0'
};

function seedSettings() {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
}

/* ------------------------------------------------------------------ *
 * 首次运行：创建默认管理员 + 少量演示数据
 * ------------------------------------------------------------------ */

function seedAdmin() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM admins').get();
  if (row.n > 0) return null;

  const username = 'admin';
  const password = 'admin123';
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');

  db.prepare(
    'INSERT INTO admins (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)'
  ).run(username, hash, salt, new Date().toISOString());

  return { username, password };
}

function seedDemoData() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM products').get();
  if (row.n > 0) return;

  const now = new Date().toISOString();
  const cat = db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)');
  const c1 = Number(cat.run('软件激活码', 10).lastInsertRowid);
  const c2 = Number(cat.run('会员充值', 20).lastInsertRowid);
  const c3 = Number(cat.run('实体周边', 30).lastInsertRowid);

  const insertProduct = db.prepare(`
    INSERT INTO products
      (name, subtitle, description, price, original_price, category_id,
       delivery_type, stock, sales, sort, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);

  const p1 = Number(
    insertProduct.run(
      '设计软件 专业版 激活码（1年）',
      '官方授权 · 拍下秒发码 · 支持重装',
      '**商品说明**\n\n- 官方渠道授权，支持在线激活\n- 有效期 1 年，可绑定 1 台设备\n- 付款后系统**自动发放激活码**，无需等待\n\n**使用方法**\n\n1. 打开软件 →「帮助」→「激活」\n2. 粘贴订单里的激活码\n3. 完成激活，重启软件生效\n\n> 本商品为虚拟商品，一经发出不支持退款，请确认无误后下单。',
      2990,
      5990,
      c1,
      'auto',
      0,
      128,
      100,
      now,
      now
    ).lastInsertRowid
  );

  const p2 = Number(
    insertProduct.run(
      '视频平台 年度会员（12个月）',
      '直充到账 · 支持手机号/账号',
      '**商品说明**\n\n- 12 个月会员，直充到你的账号\n- 下单后请务必填写正确的账号/手机号\n- 付款后 **5-30 分钟内** 到账\n\n**下单必读**\n\n- 充值期间请勿登录，以免充值失败\n- 若 30 分钟未到账，请联系客服处理',
      10800,
      19800,
      c2,
      'auto',
      0,
      64,
      90,
      now,
      now
    ).lastInsertRowid
  );

  const p3 = Number(
    insertProduct.run(
      '定制周边礼盒（含手写贺卡）',
      '实体发货 · 48 小时内出库',
      '**商品说明**\n\n- 礼盒装，含主体商品 + 定制贺卡\n- 下单后请填写**完整的收货信息**\n- 每天 16:00 前付款当天出库，之后顺延至次日\n\n**发货说明**\n\n下单后由人工审核并打包发货，发货后可在「订单查询」里查看快递单号。',
      8800,
      null,
      c3,
      'manual',
      50,
      12,
      80,
      now,
      now
    ).lastInsertRowid
  );

  // 给自动发货商品塞一点卡密
  const insertCard = db.prepare(
    'INSERT INTO cards (product_id, content, status, created_at) VALUES (?, ?, 0, ?)'
  );
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 20; i++) {
    let code = '';
    for (let j = 0; j < 16; j++) {
      if (j > 0 && j % 4 === 0) code += '-';
      code += alphabet[crypto.randomInt(alphabet.length)];
    }
    insertCard.run(p1, code, now);
  }
  for (let i = 0; i < 10; i++) {
    insertCard.run(p2, 'DEMO-' + crypto.randomBytes(6).toString('hex').toUpperCase(), now);
  }
}

seedSettings();
const createdAdmin = seedAdmin();
seedDemoData();

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));
}

/** 自动发货商品的可售库存 = 未售卡密数量 */
function availableStock(product) {
  if (!product) return 0;
  if (product.delivery_type === 'auto') {
    return Number(
      db.prepare('SELECT COUNT(*) AS n FROM cards WHERE product_id = ? AND status = 0').get(
        product.id
      ).n
    );
  }
  return Number(product.stock);
}

function nowISO() {
  return new Date().toISOString();
}

module.exports = {
  db,
  ROOT,
  DATA_DIR,
  UPLOAD_DIR,
  DEFAULT_SETTINGS,
  getSettings,
  setSetting,
  availableStock,
  nowISO,
  createdAdmin
};
