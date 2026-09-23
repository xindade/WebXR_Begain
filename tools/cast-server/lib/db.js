'use strict';
/**
 * 存储层 —— 优先使用 Node 22 内置 node:sqlite（零 npm 依赖），
 * 若运行时没有该模块（Node 18/20）则自动降级为 JSON 文件存储。
 *
 * 为什么要双后端：
 *   node:sqlite 是 Node 22.5 才引入的，而 VPS 上很可能是 Node 18/20 LTS。
 *   授权服务器只有「每天几次请求」的负载，JSON 文件完全够用；
 *   两个后端对外暴露同一套接口，部署时不用纠结 Node 版本。
 *
 * 数据目录：<root>/data/   —— 备份 = 拷这一个目录
 */
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------- SQLite 后端

function openSqlite(dir) {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(dir, 'license.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      lic            TEXT PRIMARY KEY,
      cust           TEXT NOT NULL DEFAULT '',
      dev            TEXT NOT NULL DEFAULT '',
      ke             TEXT NOT NULL DEFAULT '',
      iat            INTEGER NOT NULL DEFAULT 0,
      nbf            INTEGER NOT NULL DEFAULT 0,
      exp            INTEGER NOT NULL DEFAULT 0,
      note           TEXT NOT NULL DEFAULT '',
      revoked        INTEGER NOT NULL DEFAULT 0,
      revoked_reason TEXT NOT NULL DEFAULT '',
      revoked_at     INTEGER NOT NULL DEFAULT 0,
      renew_count    INTEGER NOT NULL DEFAULT 0,
      last_renew_at  INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS activations (
      code       TEXT PRIMARY KEY,
      cust       TEXT NOT NULL DEFAULT '',
      max_uses   INTEGER NOT NULL DEFAULT 1,
      used       INTEGER NOT NULL DEFAULT 0,
      note       TEXT NOT NULL DEFAULT '',
      expires_at INTEGER NOT NULL DEFAULT 0,
      used_by    TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  const norm = (r) => (r ? { ...r, revoked: !!r.revoked } : null);

  return {
    kind: 'sqlite',
    licenses: {
      get: (lic) => norm(db.prepare('SELECT * FROM licenses WHERE lic=?').get(lic)),
      byDev: (dev) => norm(db.prepare('SELECT * FROM licenses WHERE dev=? ORDER BY created_at DESC LIMIT 1').get(dev)),
      list: () => db.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all().map(norm),
      put: (r) =>
        db
          .prepare(
            `INSERT INTO licenses (lic,cust,dev,ke,iat,nbf,exp,note,revoked,revoked_reason,revoked_at,renew_count,last_renew_at,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(lic) DO UPDATE SET
               cust=excluded.cust, dev=excluded.dev, ke=excluded.ke,
               iat=excluded.iat, nbf=excluded.nbf, exp=excluded.exp, note=excluded.note,
               revoked=excluded.revoked, revoked_reason=excluded.revoked_reason, revoked_at=excluded.revoked_at,
               renew_count=excluded.renew_count, last_renew_at=excluded.last_renew_at`
          )
          .run(
            r.lic, r.cust || '', r.dev || '', r.ke || '',
            r.iat || 0, r.nbf || 0, r.exp || 0, r.note || '',
            r.revoked ? 1 : 0, r.revoked_reason || '', r.revoked_at || 0,
            r.renew_count || 0, r.last_renew_at || 0, r.created_at || Date.now()
          ),
      touchRenew: (lic, exp, at) =>
        db.prepare('UPDATE licenses SET exp=?, renew_count=renew_count+1, last_renew_at=? WHERE lic=?').run(exp, at, lic),
      setRevoked: (lic, on, reason, at) =>
        db.prepare('UPDATE licenses SET revoked=?, revoked_reason=?, revoked_at=? WHERE lic=?').run(on ? 1 : 0, reason || '', at, lic),
      revokedList: () =>
        db.prepare('SELECT lic, revoked_reason, revoked_at FROM licenses WHERE revoked=1').all()
          .map((r) => ({ lic: r.lic, reason: r.revoked_reason, at: r.revoked_at })),
    },
    activations: {
      get: (code) => db.prepare('SELECT * FROM activations WHERE code=?').get(code) || null,
      list: () => db.prepare('SELECT * FROM activations ORDER BY created_at DESC').all(),
      put: (r) =>
        db
          .prepare(
            `INSERT INTO activations (code,cust,max_uses,used,note,expires_at,used_by,created_at)
             VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT(code) DO UPDATE SET
               cust=excluded.cust, max_uses=excluded.max_uses, used=excluded.used,
               note=excluded.note, expires_at=excluded.expires_at, used_by=excluded.used_by`
          )
          .run(r.code, r.cust || '', r.max_uses || 1, r.used || 0, r.note || '', r.expires_at || 0, r.used_by || '', r.created_at || Date.now()),
      consume: (code, lic) =>
        db.prepare('UPDATE activations SET used=used+1, used_by=? WHERE code=?').run(lic, code),
    },
    close: () => db.close(),
  };
}

// ---------------------------------------------------------------- JSON 后端

function openJson(dir) {
  const file = path.join(dir, 'license.json');
  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return { licenses: {}, activations: {} };
    }
  };
  let mem = load();
  // 原子写：先写 tmp 再 rename，避免断电写坏主文件
  const flush = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mem, null, 2));
    fs.renameSync(tmp, file);
  };
  const arr = (o) => Object.keys(o).map((k) => o[k]);

  return {
    kind: 'json',
    licenses: {
      get: (lic) => mem.licenses[lic] || null,
      byDev: (dev) => arr(mem.licenses).filter((r) => r.dev === dev).sort((a, b) => b.created_at - a.created_at)[0] || null,
      list: () => arr(mem.licenses).sort((a, b) => b.created_at - a.created_at),
      put: (r) => {
        mem.licenses[r.lic] = { created_at: Date.now(), renew_count: 0, ...(mem.licenses[r.lic] || {}), ...r };
        flush();
      },
      touchRenew: (lic, exp, at) => {
        const r = mem.licenses[lic];
        if (!r) return;
        r.exp = exp;
        r.renew_count = (r.renew_count || 0) + 1;
        r.last_renew_at = at;
        flush();
      },
      setRevoked: (lic, on, reason, at) => {
        const r = mem.licenses[lic];
        if (!r) return;
        r.revoked = !!on;
        r.revoked_reason = reason || '';
        r.revoked_at = at;
        flush();
      },
      revokedList: () =>
        arr(mem.licenses).filter((r) => r.revoked).map((r) => ({ lic: r.lic, reason: r.revoked_reason, at: r.revoked_at })),
    },
    activations: {
      get: (code) => mem.activations[code] || null,
      list: () => arr(mem.activations).sort((a, b) => b.created_at - a.created_at),
      put: (r) => {
        mem.activations[r.code] = { created_at: Date.now(), used: 0, ...(mem.activations[r.code] || {}), ...r };
        flush();
      },
      consume: (code, lic) => {
        const r = mem.activations[code];
        if (!r) return;
        r.used = (r.used || 0) + 1;
        r.used_by = lic;
        flush();
      },
    },
    close: () => flush(),
  };
}

// ---------------------------------------------------------------- 对外

/**
 * 打开存储
 * @param {string} dir 数据目录（会自动创建）
 * @param {boolean} [preferSqlite=true] 测试时可强制走 JSON
 */
function open(dir, preferSqlite = true) {
  fs.mkdirSync(dir, { recursive: true });
  if (preferSqlite) {
    try {
      return openSqlite(dir);
    } catch (e) {
      console.warn('[db] node:sqlite 不可用（' + e.message + '），降级为 JSON 文件存储');
    }
  }
  return openJson(dir);
}

module.exports = { open };
