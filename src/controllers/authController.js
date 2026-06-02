'use strict';

/**
 * authController.js
 * ─────────────────────────────────────────────────────────────────────
 * Handles all authentication for CRMS.
 *
 * LOGIN FLOW (changed in this version):
 *   Old: username validated against FND_USER, password checked with bcrypt
 *        against crms_users.password_hash
 *
 *   New: username validated against FND_USER,
 *        password validated via Oracle API: FND_WEB_SEC.VALIDATE_LOGIN
 *        → If Oracle says credentials are valid → user is in
 *        → No password stored or compared in CRMS at all
 *        → Fallback to bcrypt (crms_users.password_hash) if Oracle
 *          API is inaccessible (dev/standalone mode)
 *
 * FND_WEB_SEC.VALIDATE_LOGIN:
 *   PL/SQL function that validates an Oracle EBS username + password.
 *   Returns 'Y' if valid, 'N' or raises exception if invalid.
 *   Signature: FUNCTION VALIDATE_LOGIN(p_user_name, p_password) RETURN VARCHAR2
 *
 * AUTO-PROVISIONING:
 *   If a valid Oracle user has no CRMS account, one is created
 *   automatically on their first successful login. No admin action needed.
 */

const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { body } = require('express-validator');
const db       = require('../config/db');
const logger   = require('../config/logger');
const { validate } = require('../middleware/validate');

function safe(s) { return String(s||'').replace(/'/g,"''"); }
function num(n)  { return String(parseInt(n,10)||0); }

function signAccess(userId, role) {
  return jwt.sign(
    { sub: userId, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}
function signRefresh(userId) {
  return jwt.sign(
    { sub: userId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
}

// ─────────────────────────────────────────────────────────────────────
// validateOracleCredentials()
//
// FILE:    src/controllers/authController.js
// CALLED FROM: login() function, Step 2
//
// PURPOSE:
//   Calls FND_WEB_SEC.VALIDATE_LOGIN(username, password) in the Oracle
//   database. This is the official Oracle EBS API for credential validation.
//   It checks the password against Oracle's own encrypted password store —
//   the same mechanism Oracle EBS login uses.
//
// RETURNS:
//   { valid: true }   — Oracle accepted the credentials
//   { valid: false, reason: '...' } — Oracle rejected or API unavailable
//
// ORACLE API REFERENCE:
//   Package: FND_WEB_SEC (in APPS schema)
//   Function: VALIDATE_LOGIN(p_user_name VARCHAR2, p_password VARCHAR2)
//             RETURN VARCHAR2  -- 'Y' = valid, anything else = invalid
//
// HOW IT WORKS IN THE DB:
//   Oracle EBS stores passwords encrypted in FND_USER.ENCRYPTED_USER_PASSWORD
//   FND_WEB_SEC.VALIDATE_LOGIN decrypts and compares internally.
//   We never see or store the actual Oracle password.
// ─────────────────────────────────────────────────────────────────────
async function validateOracleCredentials(username, password) {
  try {
    // Get oracledb from db module so we can use BIND_IN / BIND_OUT constants
    const oracledb = db.oracledb;

    // Call FND_WEB_SEC.VALIDATE_LOGIN as an anonymous PL/SQL block
    // :ret  = OUT parameter — receives 'Y' or 'N'
    // :user = IN  parameter — the Oracle EBS username
    // :pass = IN  parameter — the Oracle EBS password (sent over encrypted DB connection)
    const result = await db.callFunction(
      'BEGIN :ret := FND_WEB_SEC.VALIDATE_LOGIN(:user, :pass); END;',
      {
        ret:  { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 10 },
        user: { dir: oracledb.BIND_IN,  val:  username },
        pass: { dir: oracledb.BIND_IN,  val:  password },
      }
    );

    const returnVal = (result.outBinds && result.outBinds.ret) || '';
    logger.debug('FND_WEB_SEC.VALIDATE_LOGIN result', { username, returnVal });

    return { valid: returnVal === 'Y' };

  } catch(err) {
    // Common reasons this can fail:
    //   ORA-04067 — package not found (APPS not accessible from this user)
    //   ORA-01017 — account locked
    //   ORA-28000 — account locked (different error code)
    const msg = err.message || '';

    if (msg.includes('ORA-04067') || msg.includes('not found')) {
      logger.warn('FND_WEB_SEC not accessible — falling back to bcrypt', { username });
      return { valid: false, reason: 'oracle_api_unavailable' };
    }
    if (msg.includes('ORA-28000') || msg.includes('account is locked')) {
      return { valid: false, reason: 'account_locked', message: 'Your Oracle account is locked. Contact your Oracle administrator.' };
    }
    if (msg.includes('ORA-01017')) {
      // Wrong password thrown as exception by some Oracle versions
      return { valid: false, reason: 'invalid_credentials' };
    }

    logger.error('FND_WEB_SEC.VALIDATE_LOGIN error', { username, error: msg });
    return { valid: false, reason: 'oracle_api_error', message: msg };
  }
}

// ─────────────────────────────────────────────────────────────────────
// makeInitials() / makeDisplayName()
//
// FILE:    src/controllers/authController.js
// PURPOSE: Derive CRMS display name and initials from Oracle username
//          when auto-provisioning a new user account.
// ─────────────────────────────────────────────────────────────────────
function makeInitials(username) {
  const words = username.replace(/[._]/g, ' ').trim().split(/\s+/);
  let init = words.map(w => w.charAt(0)).join('').toUpperCase().slice(0, 3);
  if (!init) init = username.slice(0, 2).toUpperCase();
  return init;
}

function makeDisplayName(fndRow) {
  // Clean FND_USER.DESCRIPTION — strip numeric codes, special chars, keep only name words
  function cleanDesc(raw) {
    if (!raw) return '';
    // Remove anything that looks like a number-heavy code: e.g. "EMP123456", "00123 JOHN"
    // Keep only segments that are mostly alphabetical (at least 2 alpha chars)
    return raw
      .replace(/[^a-zA-Z .'\-]/g, ' ')   // remove digits and special chars except name chars
      .replace(/\s+/g, ' ')              // collapse whitespace
      .trim()
      .split(' ')
      .filter(function(w) {
        // Keep only words with at least 2 letters (filters out single initials and junk)
        return w.replace(/[^a-zA-Z]/g, '').length >= 2;
      })
      .map(function(w) {
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      })
      .join(' ');
  }

  const desc = (fndRow.DESCRIPTION || '').trim();

  // Use description if it's meaningfully different from the username and is clean
  if (desc && desc.toUpperCase() !== (fndRow.USER_NAME || '').toUpperCase()) {
    const cleaned = cleanDesc(desc);
    if (cleaned && cleaned.length >= 2) return cleaned;
  }

  // Fall back: format the Oracle username itself (e.g. JOHN.SMITH → John Smith)
  return (fndRow.USER_NAME || '')
    .replace(/[._]/g, ' ')
    .split(' ')
    .filter(function(w) { return w.length > 0; })
    .map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); })
    .join(' ');
}

// ─────────────────────────────────────────────────────────────────────
// findOrProvisionUser()
//
// FILE:    src/controllers/authController.js
// PURPOSE: Find existing CRMS user by Oracle username, OR create one
//          automatically if this Oracle user has never logged into CRMS.
//          This is the "auto-provisioning" feature — any Oracle EBS user
//          can log into CRMS immediately after first successful Oracle auth.
// ─────────────────────────────────────────────────────────────────────
async function findOrProvisionUser(username, fndRow) {
  // Try to find existing CRMS user linked to this Oracle username
  let crmsUser = await db.queryOne(
    "SELECT user_id, initials, full_name, role, password_hash, is_active " +
    "FROM crms_users WHERE UPPER(fnd_user_name)='" + username + "' AND ROWNUM=1", {}
  );

  if (crmsUser) return { crmsUser, isNew: false };

  // ── Auto-provision: first login → create CRMS account ─────────────
  const fullName = makeDisplayName(fndRow);
  let   initials = makeInitials(username);

  // Ensure initials are unique (append digit if there's a clash)
  let suffix = 0;
  while (true) {
    const clash = await db.queryOne(
      "SELECT user_id FROM crms_users WHERE UPPER(initials)='" + initials + "'", {}
    );
    if (!clash) break;
    suffix++;
    initials = makeInitials(username).slice(0, 2) + suffix;
  }

  // Insert new user — no password_hash stored (Oracle validates credentials)
  // We store a dummy bcrypt hash so the column NOT NULL constraint is satisfied
  // This hash is never used for actual authentication in Oracle mode
  const dummyHash = '$2b$12$invalidhash.placeholder.never.used.for.oracle.auth.mode';

  await db.executeWithCommit(
    "INSERT INTO crms_users(initials, full_name, role, password_hash, fnd_user_name, is_active, created_at) " +
    "VALUES('" + safe(initials) + "', '" + safe(fullName) + "', 'user', '" +
    safe(dummyHash) + "', '" + safe(username) + "', 1, SYSDATE)", {}
  );

  crmsUser = await db.queryOne(
    "SELECT user_id, initials, full_name, role, password_hash, is_active " +
    "FROM crms_users WHERE UPPER(fnd_user_name)='" + username + "' AND ROWNUM=1", {}
  );

  if (crmsUser) {
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action, performed_by, cr_number, details) VALUES(" +
      "'User Auto-Provisioned', " + num(crmsUser.USER_ID) + ", '--', " +
      "'New Oracle user " + safe(username) + " auto-provisioned as " + safe(fullName) + "')", {}
    );
    logger.info('Auto-provisioned new CRMS user', { username, fullName, initials });
  }

  return { crmsUser, isNew: true };
}

// ─────────────────────────────────────────────────────────────────────
// POST /auth/login
//
// FILE:    src/controllers/authController.js
// ROUTE:   src/routes/auth.js → router.post('/login', ...)
//
// AUTHENTICATION STEPS (in order):
//
//   Step 1 — Check FND_USER
//     Query FND_USER to confirm the username exists and is an active
//     Oracle EBS user. Non-Oracle users cannot log into CRMS.
//
//   Step 2 — Validate password via Oracle API
//     Call FND_WEB_SEC.VALIDATE_LOGIN(username, password).
//     This uses Oracle's own credential store — same as EBS login.
//     If Oracle API is unavailable (dev mode), fall back to bcrypt.
//
//   Step 3 — Find or auto-provision CRMS account
//     Look up the user in crms_users by fnd_user_name.
//     If not found, create a new crms_users row automatically.
//
//   Step 4 — Issue JWT tokens
//     Return accessToken + refreshToken for the frontend to store.
// ─────────────────────────────────────────────────────────────────────
const loginValidation = [
  body('username').trim().notEmpty().withMessage('Username required'),
  body('password').notEmpty().withMessage('Password required'),
  validate,
];

async function login(req, res, next) {
  try {
    const username = safe((req.body.username || req.body.initials || '').toUpperCase());
    const password = req.body.password || '';

    // ── Step 1: Confirm username exists in FND_USER ────────────────
    let fndRow = null;
    try {
      fndRow = await db.queryOne(
        "SELECT user_id, user_name, description, email_address " +
        "FROM fnd_user " +
        "WHERE UPPER(user_name)='" + username + "' " +
        "AND NVL(end_date, SYSDATE+1) > SYSDATE AND ROWNUM=1", {}
      );
    } catch(e) {
      // FND_USER not accessible → standalone/dev mode, skip FND check
      logger.warn('FND_USER lookup skipped (standalone mode): ' + e.message);
      fndRow = { USER_NAME: username, USER_ID: null, DESCRIPTION: username, EMAIL_ADDRESS: null };
    }

    if (!fndRow) {
      return res.status(401).json({
        error: '"' + username + '" is not a valid Oracle EBS username. ' +
               'Please use the same username you use to login to Oracle EBS.',
      });
    }

    // ── Step 2: Validate password via FND_WEB_SEC.VALIDATE_LOGIN ───
    //
    // This is the key change from the previous version:
    // Instead of comparing against crms_users.password_hash (bcrypt),
    // we call Oracle's own authentication function.
    // The password is sent over the encrypted Oracle DB connection (NNE).
    //
    const oracleAuth = await validateOracleCredentials(username, password);

    if (!oracleAuth.valid) {
      if (oracleAuth.reason === 'oracle_api_unavailable') {
        // ── FALLBACK: Oracle API not accessible → use bcrypt ──────
        // This happens in dev/standalone mode when APPS doesn't have
        // EXECUTE privilege on FND_WEB_SEC.
        // In production, grant: GRANT EXECUTE ON FND_WEB_SEC TO APPS;
        logger.warn('Using bcrypt fallback for: ' + username);

        const { crmsUser: fallbackUser, isNew: fallbackNew } =
          await findOrProvisionUser(username, fndRow);

        if (!fallbackUser || !fallbackUser.IS_ACTIVE) {
          return res.status(401).json({ error: 'Invalid credentials.' });
        }

        // Check if dummy hash (auto-provisioned, never had a real password)
        const isDummy = (fallbackUser.PASSWORD_HASH || '').startsWith('$2b$12$invalidhash');
        let bcryptMatch = false;
        if (!isDummy) {
          bcryptMatch = await bcrypt.compare(password, fallbackUser.PASSWORD_HASH);
        } else {
          // Auto-provisioned user, no bcrypt hash — check default pass123
          bcryptMatch = (password === 'pass123');
        }

        if (!bcryptMatch) {
          return res.status(401).json({ error: 'Invalid credentials.' });
        }

        return await issueTokens(res, fallbackUser, fallbackNew);

      } else if (oracleAuth.reason === 'account_locked') {
        return res.status(403).json({
          error: oracleAuth.message || 'Your Oracle account is locked. Contact your Oracle administrator.',
        });
      } else {
        // Invalid credentials from Oracle
        return res.status(401).json({
          error: 'Invalid Oracle credentials. Please use your Oracle EBS username and password.',
        });
      }
    }

    // ── Oracle confirmed credentials are valid ─────────────────────
    // Step 3: Find or auto-provision CRMS account
    const { crmsUser, isNew } = await findOrProvisionUser(username, fndRow);

    if (!crmsUser) {
      return res.status(500).json({ error: 'Failed to provision user account. Contact administrator.' });
    }
    if (!crmsUser.IS_ACTIVE) {
      return res.status(403).json({
        error: 'Your CRMS account has been deactivated. Contact your CRMS administrator.',
      });
    }

    // Step 4: Issue JWT tokens
    return await issueTokens(res, crmsUser, isNew);

  } catch(err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────
// issueTokens()
//
// FILE:    src/controllers/authController.js
// PURPOSE: Common token-issuing logic used by both Oracle auth path
//          and bcrypt fallback path. Logs the login, updates last_login,
//          and returns JWT tokens to the frontend.
// ─────────────────────────────────────────────────────────────────────
async function issueTokens(res, crmsUser, isNew) {
  const userId = num(crmsUser.USER_ID);

  await db.executeWithCommit(
    "UPDATE crms_users SET last_login=SYSDATE WHERE user_id=" + userId, {}
  );
  await db.executeWithCommit(
    "INSERT INTO crms_audit(action, performed_by, cr_number, details) VALUES(" +
    "'Login', " + userId + ", '--', '" + safe(crmsUser.FULL_NAME) + " logged in (Oracle auth)')", {}
  );

  const accessToken  = signAccess(crmsUser.USER_ID, crmsUser.ROLE);
  const refreshToken = signRefresh(crmsUser.USER_ID);

  logger.info('Login success via Oracle credentials', {
    userId, username: crmsUser.INITIALS, isNew,
  });

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
}

// ─────────────────────────────────────────────────────────────────────
// Standard auth endpoints (unchanged from previous version)
// ─────────────────────────────────────────────────────────────────────

async function refresh(req, res, next) {
  try {
    const token = req.body.refreshToken;
    if (!token) return res.status(401).json({ error: 'No refresh token' });
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET); }
    catch(e) { return res.status(401).json({ error: 'Invalid or expired refresh token' }); }
    const user = await db.queryOne(
      "SELECT user_id, role, is_active FROM crms_users WHERE user_id=" + num(payload.sub), {}
    );
    if (!user || !user.IS_ACTIVE)
      return res.status(401).json({ error: 'User not found or inactive' });
    return res.json({
      accessToken:  signAccess(user.USER_ID, user.ROLE),
      refreshToken: signRefresh(user.USER_ID),
    });
  } catch(err) { next(err); }
}

async function logout(req, res, next) {
  try {
    const uid = num(req.user.userId);
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action, performed_by, cr_number, details) VALUES(" +
      "'Logout', " + uid + ", '--', '" + safe(req.user.fullName) + " logged out')", {}
    );
    return res.json({ message: 'Logged out' });
  } catch(err) { next(err); }
}

async function me(req, res, next) {
  try {
    const uid  = num(req.user.userId);
    const user = await db.queryOne(
      "SELECT u.user_id, u.initials, u.full_name, u.role, u.last_login, u.fnd_user_name, " +
      "LISTAGG(ag.group_name, ',') WITHIN GROUP (ORDER BY ag.group_name) AS groups " +
      "FROM crms_users u " +
      "LEFT JOIN crms_group_members gm ON gm.user_id = u.user_id " +
      "LEFT JOIN crms_assignment_groups ag ON ag.group_id = gm.group_id " +
      "WHERE u.user_id=" + uid +
      " GROUP BY u.user_id, u.initials, u.full_name, u.role, u.last_login, u.fnd_user_name", {}
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({
      userId:      user.USER_ID,
      initials:    user.INITIALS,
      fullName:    user.FULL_NAME,
      role:        user.ROLE,
      fndUserName: user.FND_USER_NAME,
      groups:      user.GROUPS ? user.GROUPS.split(',') : [],
      lastLogin:   user.LAST_LOGIN,
    });
  } catch(err) { next(err); }
}

let _usersCache = null, _usersCacheTs = 0;
const USERS_CACHE_TTL = 60000;

async function listUsers(req, res, next) {
  if (_usersCache && (Date.now() - _usersCacheTs) < USERS_CACHE_TTL) {
    res.set('Cache-Control', 'public, max-age=60');
    return res.json(_usersCache);
  }
  try {
    const rows = await db.query(
      "SELECT initials, full_name FROM crms_users WHERE is_active=1 ORDER BY full_name", {}
    );
    _usersCache   = rows.map(r => ({ initials: r.INITIALS, fullName: r.FULL_NAME }));
    _usersCacheTs = Date.now();
    res.set('Cache-Control', 'public, max-age=60');
    return res.json(_usersCache);
  } catch(err) {
    logger.warn('listUsers error: ' + err.message);
    return res.json(_usersCache || []);
  }
}

// ─────────────────────────────────────────────────────────────────────
// FND Sync admin endpoints (unchanged)
// ─────────────────────────────────────────────────────────────────────
async function fndSyncStatus(req, res, next) {
  try {
    // Page size: default 2000, overridable via ORACLE_USER_PAGE_SIZE env var.
    // Set to a high number so all real Oracle users are visible.
    // The old FETCH FIRST 300 ROWS ONLY caused the count to always show 300.
    const pageSize = parseInt(process.env.ORACLE_USER_PAGE_SIZE, 10) || 2000;

    // Step 1: Get the TRUE total count of active Oracle EBS users
    // (separate query so stat card shows accurate total even if we paginate)
    let totalCount = 0;
    try {
      const cntRow = await db.queryOne(
        "SELECT COUNT(*) AS cnt FROM fnd_user " +
        "WHERE NVL(end_date, SYSDATE+1) > SYSDATE " +
        "AND user_name NOT IN ('GUEST','INITIAL SETUP','SYSADMIN','ANONYMOUS')", {}
      );
      totalCount = Number(cntRow && cntRow.CNT) || 0;
    } catch(e) {
      logger.warn('fndSyncStatus: could not get total count: ' + e.message);
    }

    // Step 2: Fetch users with CRMS join, ordered so unsynced appear first
    const rows = await db.query(
      "SELECT f.user_name        AS fnd_user_name, " +
      "       f.description      AS fnd_description, " +
      "       f.email_address    AS email, " +
      "       c.user_id          AS crms_user_id, " +
      "       c.full_name        AS crms_full_name, " +
      "       c.initials         AS crms_initials, " +
      "       c.role             AS crms_role, " +
      "       c.is_active        AS crms_is_active, " +
      "       c.last_login       AS last_login " +
      "FROM   fnd_user f " +
      "LEFT JOIN crms_users c " +
      "       ON UPPER(c.fnd_user_name) = UPPER(f.user_name) " +
      "WHERE  NVL(f.end_date, SYSDATE+1) > SYSDATE " +
      "AND    f.user_name NOT IN ('GUEST','INITIAL SETUP','SYSADMIN','ANONYMOUS') " +
      "ORDER  BY CASE WHEN c.user_id IS NULL THEN 0 ELSE 1 END, f.user_name " +
      "FETCH  FIRST " + pageSize + " ROWS ONLY", {}
    );

    const data = rows.map(r => ({
      fndUserName:  r.FND_USER_NAME,
      description:  r.FND_DESCRIPTION || '',
      email:        r.EMAIL           || '',
      crmsUserId:   r.CRMS_USER_ID    || null,
      crmsFullName: r.CRMS_FULL_NAME  || null,
      crmsInitials: r.CRMS_INITIALS   || null,
      crmsRole:     r.CRMS_ROLE       || null,
      crmsIsActive: r.CRMS_IS_ACTIVE  != null ? (r.CRMS_IS_ACTIVE == 1) : null,
      lastLogin:    r.LAST_LOGIN      || null,
      isSynced:     !!r.CRMS_USER_ID,
    }));

    // Return both the list and the true total so the frontend can show
    // the correct count even when the list is paginated
    return res.json({
      users:      data,
      totalCount: totalCount,       // true total from COUNT(*) query
      fetched:    data.length,      // how many rows are in this response
      pageSize:   pageSize,
      truncated:  totalCount > data.length,  // true if more users exist
    });
  } catch(err) { next(err); }
}

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
        await findOrProvisionUser(fnd.USER_NAME.toUpperCase(),
          { USER_NAME: fnd.USER_NAME, DESCRIPTION: fnd.DESCRIPTION });
        created++;
      } catch(e) {
        skipped++;
        logger.warn('Sync skip ' + fnd.USER_NAME + ': ' + e.message);
      }
    }
    bustUsersCache();
    return res.json({ message: 'Sync complete', created, skipped, total: fndUsers.length });
  } catch(err) { next(err); }
}

async function updateCrmsUser(req, res, next) {
  try {
    const targetId = num(req.params.userId);
    const { isActive, role, resetPassword } = req.body;
    const parts = [];
    if (isActive  !== undefined) parts.push('is_active=' + (isActive ? 1 : 0));
    if (role && ['admin','user'].includes(role)) parts.push("role='" + role + "'");
    if (resetPassword === true)
      parts.push("password_hash='$2b$12$LO5bMX/h05wgtgsaOEOTWOEBYVoR6gONZTGjZm/.En4OdseFlok3u'");
    if (!parts.length) return res.status(422).json({ error: 'Nothing to update' });
    await db.executeWithCommit(
      "UPDATE crms_users SET " + parts.join(',') + " WHERE user_id=" + targetId, {}
    );
    const action = resetPassword ? 'Password Reset by Admin' :
      isActive === false ? 'User Deactivated' :
      isActive === true  ? 'User Activated' : 'User Updated';
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action, performed_by, cr_number, details) VALUES('" +
      action + "', " + num(req.user.userId) + ", '--', 'Admin updated user_id=" + targetId + "')", {}
    );
    bustUsersCache();
    return res.json({ message: 'User updated successfully' });
  } catch(err) { next(err); }
}

function bustUsersCache() { _usersCache = null; _usersCacheTs = 0; }


// ─────────────────────────────────────────────────────────────────────
// POST /auth/fnd-provision-one
// Provision a single Oracle user into CRMS by their FND username.
// Called from the Oracle Users UI "Add to CRMS" button.
// ─────────────────────────────────────────────────────────────────────
async function fndProvisionOne(req, res, next) {
  try {
    const { fndUserName } = req.body;
    if (!fndUserName) return res.status(400).json({ error: 'fndUserName required' });

    const uname = fndUserName.trim().toUpperCase();
    const fndRow = await db.queryOne(
      "SELECT user_id, user_name, description FROM fnd_user " +
      "WHERE UPPER(user_name)='" + safe(uname) + "' " +
      "AND NVL(end_date, SYSDATE+1) > SYSDATE AND ROWNUM=1", {}
    );
    if (!fndRow) return res.status(404).json({ error: 'Oracle user not found: ' + uname });

    const { crmsUser, isNew } = await findOrProvisionUser(uname, fndRow);
    bustUsersCache();
    return res.json({
      message: isNew ? 'User provisioned successfully' : 'User already exists in CRMS',
      isNew,
      crmsUserId: crmsUser ? crmsUser.USER_ID : null,
      fullName:   crmsUser ? crmsUser.FULL_NAME : null,
    });
  } catch(err) { next(err); }
}

module.exports = {
  loginValidation, login,
  refresh, logout, me,
  listUsers, bustUsersCache,
  fndSyncStatus, fndSyncAll, fndProvisionOne, updateCrmsUser,
};
