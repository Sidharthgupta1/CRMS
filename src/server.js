'use strict';

try { require('dotenv').config(); } catch(e) {}

const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
const db       = require('./config/db');
const logger   = require('./config/logger');
const routes   = require('./routes');
const { errorHandler } = require('./middleware/errorHandler');
const cookieParser = require('cookie-parser');
const app        = express();
const PORT       = parseInt(process.env.PORT, 10) || 3000;
const API_PREFIX = process.env.API_PREFIX || '/api/v1';

// ── CORS ──────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

  app.use(cors({
    origin: (origin, callback) => {
      console.log("Incoming Origin:", origin);
      // Allow requests with no origin (Postman, server calls)
      if (!origin) return callback(null, true);
      // Allow localhost
      if (origin.includes("localhost"))
        return callback(null, true);
      // Allow your office network IP
      if (origin.includes("10.240.182.45"))
        return callback(null, true);
      return callback(null, true); // allow all (internal tool)
    },
    credentials: true
  }));

// ── Security & parsing ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(express.json({ limit: '20mb' }));   // 20MB for base64 attachments
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: msg => logger.info(msg.trim()) },
    skip:   (req) => req.path === '/health',
  }));
}

const path = require('path');

// Serve static files from root folder
app.use(express.static(path.join(__dirname, '..')));

// Root route
app.get('/', (req, res) => {
  res.sendFile(
    path.join(__dirname, '..', 'cr-management-system.html')//'cr-management-system-v6 (36).html')
  );
});
// ── Health check — always responds, even before DB connects ──────────
app.get('/health', async (req, res) => {
  const status = { status: 'ok', db: dbReady ? 'connected' : 'connecting', time: new Date().toISOString() };
  if (!dbReady) {
    status.status  = 'degraded';
    status.message = 'Database connecting — retry in a moment';
    return res.status(503).json(status);
  }
  try {
    await db.queryOne('SELECT 1 AS n FROM dual', {});
    return res.json(status);
  } catch(e) {
    return res.status(503).json({ ...status, db: 'error', message: e.message });
  }
});

// ── Debug endpoint ────────────────────────────────────────────────────
app.get('/debug-db', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Database not connected yet', dbReady });
  try {
    const row = await db.queryOne("SELECT SYS_CONTEXT('USERENV','DB_NAME') AS db_name FROM dual", {});
    const cnt = await db.queryOne('SELECT COUNT(*) AS cnt FROM crms_users', {});
    return res.json({ connected: true, db: row.DB_NAME, userCount: Number(cnt.CNT) });
  } catch(e) {
    return res.status(500).json({ connected: false, error: e.message });
  }
});

// ── DB-not-ready middleware ───────────────────────────────────────────
// /auth/users is served from in-memory cache — never blocked by DB status
// All other API calls return 503 until Oracle pool is ready
app.use(API_PREFIX, (req, res, next) => {
  if (req.path === '/auth/users') return next();   // always serve from cache
  if (!dbReady) {
    return res.status(503).json({
      error: 'Database connecting — please wait a moment and retry',
      dbReady: false,
    });
  }
  next();
});

// ── One Oracle connection per request (performance) ───────────────────
// requestConnection skips /auth/users and /auth/login automatically
app.use(API_PREFIX, db.requestConnection);

// ── API routes ────────────────────────────────────────────────────────
app.use(API_PREFIX, routes);

// ── Error handler ─────────────────────────────────────────────────────
app.use(errorHandler);

// ═══════════════════════════════════════════════════════════════════════
// DB CONNECTION — non-blocking with auto-retry
// Server starts immediately; Oracle connects in the background.
// ═══════════════════════════════════════════════════════════════════════
let dbReady        = false;
let retryCount     = 0;
const MAX_RETRIES  = 20;          // give up after 20 attempts (~10 minutes)
const RETRY_DELAY  = [5, 5, 10, 10, 15, 15, 30]; // seconds between retries

function getRetryDelay(attempt) {
  return (RETRY_DELAY[attempt] || 30) * 1000;
}

async function connectWithRetry() {
  try {
    await db.connect();
    dbReady = true;
    retryCount = 0;
    logger.info('✅ Oracle DB connected — API fully operational');

    // Pre-warm users list cache so first login dropdown is instant
    try {
      const auth    = require('./controllers/authController');
      const mockReq = {};
      const mockRes = { json: (d) => logger.info(`User cache primed (${d ? d.length : 0} users)`), set: ()=>{} };
      await auth.listUsers(mockReq, mockRes, (e) => { if(e) logger.warn('Cache warm-up:', e.message); });
    } catch(e) {
      logger.warn('Cache warm-up skipped:', e.message);
    }
  } catch(err) {
    dbReady = false;

    // Extract clean error reason
    const msg = err.message || '';
    let reason = 'Unknown error';
    if (msg.includes('ORA-12170') || msg.includes('TCP connect timeout'))
      reason = 'TCP timeout — Oracle host unreachable on network';
    else if (msg.includes('ORA-12541'))
      reason = 'No listener — Oracle not running on that port';
    else if (msg.includes('ORA-01017'))
      reason = 'Wrong username/password in .env';
    else if (msg.includes('ORA-12514'))
      reason = 'Wrong service name in DB_CONNECTION_STRING';
    else if (msg.includes('ORA-12660') || msg.includes('NNE'))
      reason = 'NNE encryption — need Oracle Thick mode (check ORACLE_CLIENT_LIB)';
    else
      reason = msg.split('\n')[0];

    retryCount++;
    if (retryCount > MAX_RETRIES) {
      logger.error(`❌ DB connection failed after ${MAX_RETRIES} attempts. Fix .env and restart.`);
      return; // stop retrying, but keep server running
    }

    const delay = getRetryDelay(retryCount - 1);
    logger.warn(`⚠ DB connection attempt ${retryCount}/${MAX_RETRIES} failed: ${reason}`);
    logger.warn(`  Retrying in ${delay/1000}s... (server is running, API returns 503 until connected)`);

    setTimeout(connectWithRetry, delay);
  }
}

// ── Start HTTP server immediately, then connect DB ────────────────────
async function start() {
  app.listen(PORT, () => {
    logger.info(`🚀 CRMS server started → http://localhost:${PORT}${API_PREFIX}`);
    logger.info(`   Connecting to Oracle DB in background...`);
  });

  // Connect to Oracle — non-blocking, with retry
  connectWithRetry();
}

// ── Graceful shutdown ─────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`${signal} received — shutting down`);
  dbReady = false;
  await db.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (err) => { logger.error('Uncaught exception',  { err: err.message }); process.exit(1); });
process.on('unhandledRejection', (err) => { logger.error('Unhandled rejection', { err: String(err)  }); });

start();
