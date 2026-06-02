'use strict';

const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { body } = require('express-validator');
const db       = require('../config/db');
const logger   = require('../config/logger');
const { validate } = require('../middleware/validate');

function safe(s) { return String(s||'').replace(/'/g,"''"); }
function num(n)  { return String(parseInt(n,10)||0); }

function signAccess(userId, role) {
  return jwt.sign({ sub: userId, role },
    process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
}
function signRefresh(userId) {
  return jwt.sign({ sub: userId },
    process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' });
}

// DEFAULT password for all auto-provisioned users: pass123
const DEFAULT_PASSWORD      = 'pass123';
const DEFAULT_PASSWORD_HASH = '$2b$12$LO5bMX/h05wgtgsaOEOTWOEBYVoR6gONZTGjZm/.En4OdseFlok3u';

// ── Build initials from Oracle username ───────────────────────────────
function makeInitials(username) {
  // JOHN.SMITH → JS,  PRIYA_MEHTA → PM,  SYSADMIN → SY
  const words = username.replace(/[._]/g, ' ').trim().split(/\s+/);
  let init = words.map(w => w.charAt(0)).join('').toUpperCase().slice(0, 3);
  if (!init) init = username.slice(0, 2).toUpperCase();
  return init;
}

// ── Build display name from FND_USER fields ───────────────────────────
function makeDisplayName(fndRow) {
  const desc = (fndRow.DESCRIPTION || '').trim();
  if (desc && desc.toUpperCase() !== (fndRow.USER_NAME || '').toUpperCase()) {
    return desc;
  }
  // Format JOHN.SMITH → John Smith
  return fndRow.USER_NAME
    .replace(/[._]/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// ── Find or auto-provision a CRMS user from FND_USER ─────────────────
// Returns crms_users row (existing or newly created)
async function findOrProvisionUser(username, fndRow) {
  // Try to find existing CRMS user
  let crmsUser = await db.queryOne(
    "SELECT user_id,initials,full_name,role,password_hash,is_active " +
    "FROM crms_users " +
    "WHERE UPPER(fnd_user_name)='" + username + "' AND ROWNUM=1", {}
  );

  if (crmsUser) return { crmsUser, isNew: false };

  // ── Auto-provision: new Oracle user → create CRMS account ────────
  const fullName = makeDisplayName(fndRow);
  let   initials = makeInitials(username);

  // Make initials unique (append digit if clash)
  let suffix = 0;
  while (true) {
    const clash = await db.queryOne(
      "SELECT user_id FROM crms_users WHERE UPPER(initials)='" + initials + "'", {}
    );
    if (!clash) break;
    suffix++;
    initials = makeInitials(username).slice(0, 2) + suffix;
  }

  await db.executeWithCommit(
    "INSERT INTO crms_users(initials,full_name,role,password_hash,fnd_user_name,is_active,created_at) " +
    "VALUES('" + safe(initials) + "','" + safe(fullName) + "','user','" +
    safe(DEFAULT_PASSWORD_HASH) + "','" + safe(username) + "',1,SYSDATE)", {}
  );

  crmsUser = await db.queryOne(
    "SELECT user_id,initials,full_name,role,password_hash,is_active " +
    "FROM crms_users WHERE UPPER(fnd_user_name)='" + username + "' AND ROWNUM=1", {}
  );

  // Audit the auto-provision event
  if (crmsUser) {
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES(" +
      "'User Auto-Provisioned'," + num(crmsUser.USER_ID) + ",'--'," +
      "'New Oracle user " + safe(username) + " auto-provisioned as " + safe(fullName) + "')", {}
    );
    logger.info('Auto-provisioned new user', { username, fullName, initials });
  }

  return { crmsUser, isNew: true };
}

// ── POST /auth/login ───────────────────────────────────────────────────
const loginValidation = [
  body('username').trim().notEmpty().withMessage('Username required'),
  body('password').notEmpty().withMessage('Password required'),
  validate,
];

async function login(req, res, next) {
  try {
    const username = safe((req.body.username || req.body.initials || '').toUpperCase());
    const password = req.body.password || '';

    // ── Step 1: Validate against FND_USER ─────────────────────────
    let fndRow = null;
    try {
      fndRow = await db.queryOne(
        "SELECT user_id, user_name, description, email_address " +
        "FROM fnd_user " +
        "WHERE UPPER(user_name)='" + username + "' " +
        "AND NVL(end_date, SYSDATE+1) > SYSDATE AND ROWNUM=1", {}
      );
    } catch(e) {
      // FND_USER not accessible in dev/standalone mode — skip
      logger.warn('FND_USER check skipped (standalone mode): ' + e.message);
      fndRow = { USER_NAME: username, USER_ID: null, DESCRIPTION: username, EMAIL_ADDRESS: null };
    }

    if (!fndRow) {
      return res.status(401).json({
        error: '"' + username + '" is not a valid Oracle EBS username. ' +
               'Please enter the same username you use to login to Oracle EBS.',
      });
    }

    // ── Step 2: Find in CRMS — or auto-create on first login ──────
    const { crmsUser, isNew } = await findOrProvisionUser(username, fndRow);

    if (!crmsUser) {
      return res.status(500).json({ error: 'Failed to provision user account. Contact administrator.' });
    }

    if (!crmsUser.IS_ACTIVE) {
      return res.status(403).json({
        error: 'Your CRMS account has been deactivated. Please contact your CRMS administrator.',
      });
    }

    // ── Step 3: Verify password ────────────────────────────────────
    const match = await bcrypt.compare(password, crmsUser.PASSWORD_HASH);
    if (!match) {
      // If new user, tell them the default password
      if (isNew) {
        return res.status(401).json({
          error: 'Your account has been created. Please login with the default password: pass123',
          isNewUser: true,
        });
      }
      return res.status(401).json({ error: 'Invalid password. Please try again.' });
    }

    // ── Step 4: Issue tokens ───────────────────────────────────────
    const userId = num(crmsUser.USER_ID);
    await db.executeWithCommit(
      "UPDATE crms_users SET last_login=SYSDATE WHERE user_id=" + userId, {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES(" +
      "'Login'," + userId + ",'--','" + safe(crmsUser.FULL_NAME) + " logged in')", {}
    );

    const accessToken  = signAccess(crmsUser.USER_ID, crmsUser.ROLE);
    const refreshToken = signRefresh(crmsUser.USER_ID);

    logger.info('Login success', { userId, username, isNew });
    return res.json({
      accessToken,
      refreshToken,
      isNewUser: isNew,
      user: {
        userId:   crmsUser.USER_ID,
        initials: crmsUser.INITIALS,
        fullName: crmsUser.FULL_NAME,
        role:     crmsUser.ROLE,
      },
    });
  } catch(err) { next(err); }
}

// ── POST /auth/refresh ─────────────────────────────────────────────────
async function refresh(req, res, next) {
  try {
    const token = req.body.refreshToken;
    if (!token) return res.status(401).json({ error: 'No refresh token' });
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET); }
    catch(e) { return res.status(401).json({ error: 'Invalid or expired refresh token' }); }
    const user = await db.queryOne(
      "SELECT user_id,role,is_active FROM crms_users WHERE user_id=" + num(payload.sub), {}
    );
    if (!user || !user.IS_ACTIVE)
      return res.status(401).json({ error: 'User not found or inactive' });
    return res.json({
      accessToken:  signAccess(user.USER_ID, user.ROLE),
      refreshToken: signRefresh(user.USER_ID),
    });
  } catch(err) { next(err); }
}

// ── POST /auth/logout ──────────────────────────────────────────────────
async function logout(req, res, next) {
  try {
    const uid = num(req.user.userId);
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES(" +
      "'Logout'," + uid + ",'--','" + safe(req.user.fullName) + " logged out')", {}
    );
    return res.json({ message: 'Logged out' });
  } catch(err) { next(err); }
}

// ── GET /auth/me ───────────────────────────────────────────────────────
async function me(req, res, next) {
  try {
    const uid  = num(req.user.userId);
    const user = await db.queryOne(
      "SELECT u.user_id,u.initials,u.full_name,u.role,u.last_login,u.fnd_user_name," +
      "LISTAGG(ag.group_name,',') WITHIN GROUP (ORDER BY ag.group_name) AS groups " +
      "FROM crms_users u " +
      "LEFT JOIN crms_group_members gm ON gm.user_id=u.user_id " +
      "LEFT JOIN crms_assignment_groups ag ON ag.group_id=gm.group_id " +
      "WHERE u.user_id=" + uid + " GROUP BY u.user_id,u.initials,u.full_name,u.role,u.last_login,u.fnd_user_name", {}
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({
      userId:       user.USER_ID,
      initials:     user.INITIALS,
      fullName:     user.FULL_NAME,
      role:         user.ROLE,
      fndUserName:  user.FND_USER_NAME,
      groups:       user.GROUPS ? user.GROUPS.split(',') : [],
      lastLogin:    user.LAST_LOGIN,
    });
  } catch(err) { next(err); }
}

// ── GET /auth/users ────────────────────────────────────────────────────
let _usersCache = null, _usersCacheTs = 0;
const USERS_CACHE_TTL = 60000;

async function listUsers(req, res, next) {
  if (_usersCache && (Date.now() - _usersCacheTs) < USERS_CACHE_TTL) {
    res.set('Cache-Control','public,max-age=60');
    return res.json(_usersCache);
  }
  try {
    const rows = await db.query(
      "SELECT initials,full_name FROM crms_users WHERE is_active=1 ORDER BY full_name", {}
    );
    _usersCache   = rows.map(r => ({ initials: r.INITIALS, fullName: r.FULL_NAME }));
    _usersCacheTs = Date.now();
    res.set('Cache-Control','public,max-age=60');
    return res.json(_usersCache);
  } catch(err) {
    logger.warn('listUsers error: ' + err.message);
    return res.json(_usersCache || []);
  }
}

// ── GET /auth/fnd-sync-status (Admin) ─────────────────────────────────
// Shows all FND_USER accounts and their CRMS sync status
async function fndSyncStatus(req, res, next) {
  try {
    const rows = await db.query(
      "SELECT " +
      "  f.user_name          AS fnd_user_name, " +
      "  f.description        AS fnd_description, " +
      "  f.email_address      AS email, " +
      "  NVL(f.end_date, TO_DATE('9999-12-31','YYYY-MM-DD')) AS end_date, " +
      "  c.user_id            AS crms_user_id, " +
      "  c.full_name          AS crms_full_name, " +
      "  c.initials           AS crms_initials, " +
      "  c.role               AS crms_role, " +
      "  c.is_active          AS crms_is_active, " +
      "  c.last_login         AS last_login " +
      "FROM fnd_user f " +
      "LEFT JOIN crms_users c ON UPPER(c.fnd_user_name)=UPPER(f.user_name) " +
      "WHERE NVL(f.end_date, SYSDATE+1) > SYSDATE " +
      "AND f.user_name NOT IN ('GUEST','INITIAL SETUP','SYSADMIN','ANONYMOUS') " +
      "ORDER BY CASE WHEN c.user_id IS NULL THEN 0 ELSE 1 END, f.user_name " +
      "FETCH FIRST 300 ROWS ONLY", {}
    );

    return res.json(rows.map(r => ({
      fndUserName:    r.FND_USER_NAME,
      description:    r.FND_DESCRIPTION || '',
      email:          r.EMAIL || '',
      crmsUserId:     r.CRMS_USER_ID    || null,
      crmsFullName:   r.CRMS_FULL_NAME  || null,
      crmsInitials:   r.CRMS_INITIALS   || null,
      crmsRole:       r.CRMS_ROLE       || null,
      crmsIsActive:   r.CRMS_IS_ACTIVE  != null ? (r.CRMS_IS_ACTIVE == 1) : null,
      lastLogin:      r.LAST_LOGIN       || null,
      isSynced:       !!r.CRMS_USER_ID,
    })));
  } catch(err) { next(err); }
}

// ── POST /auth/fnd-sync-all (Admin) ───────────────────────────────────
// Immediately provisions ALL active FND users not yet in CRMS
async function fndSyncAll(req, res, next) {
  try {
    const fndUsers = await db.query(
      "SELECT user_name, description FROM fnd_user " +
      "WHERE NVL(end_date, SYSDATE+1) > SYSDATE " +
      "AND user_name NOT IN ('GUEST','INITIAL SETUP','SYSADMIN','ANONYMOUS') " +
      "AND NOT EXISTS (SELECT 1 FROM crms_users c WHERE UPPER(c.fnd_user_name)=UPPER(user_name)) " +
      "ORDER BY user_name FETCH FIRST 200 ROWS ONLY", {}
    );

    let created = 0, skipped = 0;
    for (const fnd of fndUsers) {
      try {
        await findOrProvisionUser(fnd.USER_NAME.toUpperCase(), {
          USER_NAME:   fnd.USER_NAME,
          DESCRIPTION: fnd.DESCRIPTION,
        });
        created++;
      } catch(e) {
        skipped++;
        logger.warn('Sync skip ' + fnd.USER_NAME + ': ' + e.message);
      }
    }

    bustUsersCache();
    return res.json({
      message: 'Sync complete',
      created,
      skipped,
      total: fndUsers.length,
    });
  } catch(err) { next(err); }
}

// ── PATCH /auth/crms-user/:userId (Admin) ─────────────────────────────
// Deactivate / reactivate / change role / reset password
async function updateCrmsUser(req, res, next) {
  try {
    const targetId = num(req.params.userId);
    const { isActive, role, resetPassword } = req.body;
    const parts = [];

    if (isActive !== undefined) {
      parts.push('is_active=' + (isActive ? 1 : 0));
    }
    if (role && ['admin','user'].includes(role)) {
      parts.push("role='" + role + "'");
    }
    if (resetPassword === true) {
      parts.push("password_hash='" + safe(DEFAULT_PASSWORD_HASH) + "'");
    }

    if (!parts.length) return res.status(422).json({ error: 'Nothing to update' });

    await db.executeWithCommit(
      "UPDATE crms_users SET " + parts.join(',') + " WHERE user_id=" + targetId, {}
    );

    const adminId = num(req.user.userId);
    const action  = resetPassword ? 'Password Reset by Admin' :
                    isActive === false ? 'User Deactivated' :
                    isActive === true  ? 'User Activated' : 'User Updated';

    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES('" +
      action + "'," + adminId + ",'--','Admin updated user_id=" + targetId + "')", {}
    );

    bustUsersCache();
    return res.json({ message: 'User updated successfully' });
  } catch(err) { next(err); }
}

function bustUsersCache() { _usersCache = null; _usersCacheTs = 0; }

module.exports = {
  loginValidation, login, refresh, logout, me, listUsers, bustUsersCache,
  fndSyncStatus, fndSyncAll, updateCrmsUser,
};
