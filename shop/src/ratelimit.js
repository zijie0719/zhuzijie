'use strict';

/**
 * 极简内存限流，用于挡住刷单、撞订单号之类的行为。
 * 单机部署够用；上多实例时换成 Redis 即可。
 */

function rateLimit({ windowMs = 60_000, max = 30, message = '操作过于频繁，请稍后再试' } = {}) {
  const hits = new Map();

  // 定期清理，避免内存无限增长
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of hits) {
      if (now - rec.start > windowMs) hits.delete(key);
    }
  }, Math.max(windowMs, 30_000));
  timer.unref();

  return function limiter(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let rec = hits.get(key);

    if (!rec || now - rec.start > windowMs) {
      rec = { count: 0, start: now };
      hits.set(key, rec);
    }
    rec.count += 1;

    if (rec.count > max) {
      const retryAfter = Math.ceil((rec.start + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ ok: false, error: message });
    }
    next();
  };
}

module.exports = { rateLimit };
