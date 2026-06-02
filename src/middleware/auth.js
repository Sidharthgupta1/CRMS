'use strict';

const jwt    = require('jsonwebtoken');
const db     = require('../config/db');
const logger = require('../config/logger');

// ── verifyToken ───────────────────────────────────────────────────────
/**
 * Middleware: validates Bearer JWT, attaches req.user.
 */
async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token   = authHeader.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Verify user still exists and is active in DB
    const user = await db.queryOne(
      `SELECT u.user_id, u.initials, u.full_name, u.role, u.is_active
         FROM crms_users u
        WHERE u.user_id = :userId AND u.is_active = 1`,
      { userId: payload.sub }
    );

    if (!user) {
      return res.status(401).json({ error: 'User not found or deactivated' });
    }

    req.user = {
      userId:   user.USER_ID,
      initials: user.INITIALS,
      fullName: user.FULL_NAME,
      role:     user.ROLE,          // 'admin' | 'user'
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    logger.error('verifyToken error', { err: err.message });
    return res.status(500).json({ error: 'Authentication error' });
  }
}

// ── requireAdmin ──────────────────────────────────────────────────────
/**
 * Middleware: must be used AFTER verifyToken.
 * Rejects non-admin users with 403.
 */
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required' });
}

// ── requireOwnerOrAdmin ───────────────────────────────────────────────
/**
 * Factory: checks that req.user.userId === paramId or user is admin.
 * Usage: router.get('/:userId/...', requireOwnerOrAdmin('userId'), handler)
 */
function requireOwnerOrAdmin(paramName = 'userId') {
  return (req, res, next) => {
    const targetId = req.params[paramName];
    if (req.user.role === 'admin' || String(req.user.userId) === String(targetId)) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden' });
  };
}

module.exports = { verifyToken, requireAdmin, requireOwnerOrAdmin };
