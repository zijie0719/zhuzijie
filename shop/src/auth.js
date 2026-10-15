'use strict';

/**
 * 后台登录鉴权：scrypt 口令散列 + 数据库会话表 + HttpOnly Cookie。
 * 会话写库，所以服务重启后不会掉登录。
 */

const crypto = require('node:crypto');
const { db, nowISO } = require('./db');

const COOKIE_NAME = 'shop_admin';
const SESSION_DAYS = 7;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, expectedHash) {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function createSession(adminId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare(
    'INSERT INTO sessions (token, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, adminId, nowISO(), expires);
  return { token, expires };
}

function getSession(token) {
  if (!token) return null;
  const row = db
    .prepare('SELECT * FROM sessions WHERE token = ?')
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function clearExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowISO());
}

/* ------------------------------------------------------------------ *
 * 登录失败限流（内存计数，重启即清空，够用）
 * ------------------------------------------------------------------ */

const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function isLockedOut(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

function clearFailures(ip) {
  attempts.delete(ip);
}

/* ------------------------------------------------------------------ *
 * Express 中间件
 * ------------------------------------------------------------------ */

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function setSessionCookie(res, token, expires) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: new Date(expires)
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** 把当前管理员挂到 req.admin（未登录为 null） */
function attachAdmin(req, _res, next) {
  const token = readCookie(req, COOKIE_NAME);
  const session = getSession(token);
  if (session) {
    req.admin = db
      .prepare('SELECT id, username, created_at, last_login_at FROM admins WHERE id = ?')
      .get(session.admin_id);
    req.adminToken = token;
  } else {
    req.admin = null;
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.admin) return res.status(401).json({ ok: false, error: '请先登录后台' });
  next();
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  clearExpiredSessions,
  isLockedOut,
  recordFailure,
  clearFailures,
  attachAdmin,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie
};
