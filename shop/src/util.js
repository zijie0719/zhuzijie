'use strict';

const crypto = require('node:crypto');

/** 生成订单号：日期 + 随机串，可读且不可猜 */
function randomOrderNo() {
  const d = new Date();
  const ymd =
    String(d.getFullYear()) +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${ymd}${rand}`;
}

/** "29.90" / "29.9" / 29.9 → 2990（分）。非法输入返回 null */
function toCents(input) {
  if (input === null || input === undefined || input === '') return null;
  const n = Number(String(input).trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** 2990 → "29.90" */
function fmtCents(cents) {
  const n = Number(cents) || 0;
  return (n / 100).toFixed(2);
}

/** 取整并夹在 [min, max] 之间 */
function clampInt(value, min, max, fallback = min) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(value, maxLen = 500) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, maxLen);
}

/** 联系方式校验：邮箱 / 手机号 / QQ / 微信号 都放行，但必须像个联系方式 */
function isPlausibleContact(contact) {
  const c = String(contact || '').trim();
  if (c.length < 5 || c.length > 80) return false;
  if (/[\s<>]/.test(c)) return false;
  return true;
}

/** 给 SQLite 绑定用的安全值：undefined → null */
function nz(v) {
  return v === undefined ? null : v;
}

module.exports = { randomOrderNo, toCents, fmtCents, clampInt, str, isPlausibleContact, nz };
