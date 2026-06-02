'use strict';

try { require('dotenv').config(); } catch(e) {}

const oracledb = require('oracledb');
const fs       = require('fs');
const logger   = require('./logger');

// ── Thick mode ────────────────────────────────────────────────────────
(function initThickMode() {
  let libDir = process.env.ORACLE_CLIENT_LIB;
  if (!libDir && process.platform === 'win32') {
    const cands = ['C:\\Oracle\\instantclient_23_8','C:\\Oracle\\instantclient_23_7',
      'C:\\Oracle\\instantclient_21_13','C:\\Oracle\\instantclient_21_3',
      'C:\\oracle\\instantclient_21_3','C:\\instantclient_21_3'];
    libDir = cands.find(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  }
  if (!libDir && process.platform === 'linux') {
    const cands = ['/opt/oracle/instantclient_21_15','/opt/oracle/instantclient_21_3',
      '/opt/oracle/instantclient_19_24','/usr/lib/oracle/21/client64/lib'];
    libDir = cands.find(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  }
  if (libDir) {
    try { oracledb.initOracleClient({ libDir }); console.log('[db] Thick mode: ' + libDir); }
    catch(err) { if (!err.message.includes('already been called')) console.warn('[db] Thick mode failed: ' + err.message.split('\n')[0]); }
  } else { console.warn('[db] Instant Client not found — thin mode'); }
})();

oracledb.outFormat     = oracledb.OUT_FORMAT_OBJECT;
oracledb.autoCommit    = false;
oracledb.fetchAsString = [oracledb.CLOB];
oracledb.fetchAsBuffer = [oracledb.BLOB];

let pool;

// Dead connection detection
function isDeadConn(err) {
  const m = (err && err.message) ? err.message : String(err);
  return ['NJS-003','NJS-500','ORA-03113','ORA-03114','ORA-03135',
          'ORA-01012','ORA-12571','ORA-12537','ORA-12547','ORA-12170'].some(c => m.includes(c));
}

async function getFreshConn() {
  return oracledb.getConnection('crmsPool');
}

// ── connect ───────────────────────────────────────────────────────────
async function connect() {
  if (pool) return pool;
  const dbUser = process.env.DB_USER;
  const dbPass = process.env.DB_PASSWORD;
  const dbConn = process.env.DB_CONNECTION_STRING;
  if (!dbUser || !dbPass || !dbConn)
    throw new Error('Missing DB_USER / DB_PASSWORD / DB_CONNECTION_STRING in .env');

  pool = await oracledb.createPool({
    user: dbUser, password: dbPass, connectionString: dbConn,
    poolMin:          parseInt(process.env.DB_POOL_MIN,  10) || 2,
    poolMax:          parseInt(process.env.DB_POOL_MAX,  10) || 15,
    poolIncrement:    parseInt(process.env.DB_POOL_INCREMENT, 10) || 1,
    poolTimeout:      parseInt(process.env.DB_POOL_TIMEOUT,   10) || 60,
    poolPingInterval: 10,   // ping every 10s — kills stale connections fast
    poolAlias:        'crmsPool',
    stmtCacheSize:    100,
    connectTimeout:   15,
  });

  logger.info('Oracle pool ready → ' + dbConn);
  return pool;
}

async function disconnect() {
  if (!pool) return;
  await pool.close(10);
  pool = null;
}

// ── Request-scoped connection ─────────────────────────────────────────
const asyncLocalStorage = (() => {
  try { return new (require('node:async_hooks').AsyncLocalStorage)(); } catch(e) { return null; }
})();

async function requestConnection(req, res, next) {
  const skip = ['/auth/users','/auth/login','/auth/refresh'];
  if (skip.some(p => (req.path||'').endsWith(p))) return next();
  if (!pool || !asyncLocalStorage) return next();

  let conn, released = false;
  const release = async () => {
    if (released) return; released = true;
    if (conn) { try { await conn.close(); } catch(e) {} }
  };
  try {
    conn = await getFreshConn();
    res.on('finish', release);
    res.on('close',  release);
    asyncLocalStorage.run(conn, next);
  } catch(err) {
    logger.warn('[db] requestConnection failed — per-query mode: ' + err.message);
    next();
  }
}

// ── executeOne: run sql on conn, retry with fresh conn if dead ────────
async function executeOne(conn, sql, binds, opts) {
  try {
    return await conn.execute(sql, binds, opts);
  } catch(err) {
    if (!isDeadConn(err)) throw err;
    logger.warn('[db] Dead conn, retrying: ' + err.message.split('\n')[0]);
    const fresh = await getFreshConn();
    try    { return await fresh.execute(sql, binds, opts); }
    finally { try { await fresh.close(); } catch(e) {} }
  }
}

// ── execute ───────────────────────────────────────────────────────────
async function execute(sql, binds = {}, opts = {}) {
  const o = { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false, ...opts };
  const stored = asyncLocalStorage ? asyncLocalStorage.getStore() : null;
  if (stored) return executeOne(stored, sql, binds, o);
  const conn = await getFreshConn();
  try    { return await executeOne(conn, sql, binds, o); }
  finally { try { await conn.close(); } catch(e) {} }
}

async function executeWithCommit(sql, binds = {}, opts = {}) {
  const o = { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: false, ...opts };
  const stored = asyncLocalStorage ? asyncLocalStorage.getStore() : null;
  if (stored) {
    const r = await executeOne(stored, sql, binds, o);
    await stored.commit();
    return r;
  }
  const conn = await getFreshConn();
  try    { return await executeOne(conn, sql, binds, { ...o, autoCommit: true }); }
  finally { try { await conn.close(); } catch(e) {} }
}

async function transaction(fn) {
  const stored = asyncLocalStorage ? asyncLocalStorage.getStore() : null;
  const conn   = stored || await getFreshConn();
  try {
    const result = await fn(conn);
    if (!stored) await conn.commit();
    return result;
  } catch(err) {
    if (!stored) { try { await conn.rollback(); } catch(e) {} }
    throw err;
  } finally {
    if (!stored) { try { await conn.close(); } catch(e) {} }
  }
}

async function query(sql, binds = {}) {
  return (await execute(sql, binds)).rows || [];
}

async function queryOne(sql, binds = {}) {
  return (await query(sql, binds))[0] || null;
}


/**
 * callFunction(sql, binds)
 * ──────────────────────────────────────────────────────────────────
 * Executes a PL/SQL anonymous block that calls a stored function/procedure.
 * Used specifically for FND_WEB_SEC.VALIDATE_LOGIN which requires
 * OUT parameters — something plain query() cannot handle.
 *
 * Example usage in authController.js:
 *   const result = await db.callFunction(
 *     'BEGIN :ret := FND_WEB_SEC.VALIDATE_LOGIN(:user, :pass); END;',
 *     {
 *       ret:  { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 100 },
 *       user: { dir: oracledb.BIND_IN,  val: 'JOHN.SMITH' },
 *       pass: { dir: oracledb.BIND_IN,  val: 'mypassword' },
 *     }
 *   );
 *   // result.outBinds.ret === 'Y' means valid credentials
 */
async function callFunction(sql, binds = {}) {
  const stored = asyncLocalStorage ? asyncLocalStorage.getStore() : null;
  const conn   = stored || await getFreshConn();
  try {
    const result = await conn.execute(sql, binds, { autoCommit: false });
    return result;
  } catch(err) {
    if (!isDeadConn(err)) throw err;
    logger.warn('[db] Dead conn in callFunction, retrying: ' + err.message.split('\n')[0]);
    const fresh = await getFreshConn();
    try    { return await fresh.execute(sql, binds, { autoCommit: false }); }
    finally { try { await fresh.close(); } catch(e) {} }
  } finally {
    if (!stored) { try { await conn.close(); } catch(e) {} }
  }
}

module.exports = {
  connect, disconnect, requestConnection,
  execute, executeWithCommit, transaction, query, queryOne,
  callFunction,
  // Expose oracledb constants so callers can use BIND_IN/BIND_OUT/STRING etc.
  oracledb,
};
