'use strict';

/**
 * CRMS SSO Controller — Oracle EBS R12 FND_USER Integration
 *
 * Since CRMS backend connects to the SAME Oracle DB as EBS (as APPS user),
 * we can query FND_USER directly — no HMAC signatures needed.
 *
 * FLOW:
 *   1. EBS PL/SQL generates a one-time token:
 *        INSERT INTO crms_sso_tokens(token, fnd_user_id, expires_at)
 *        VALUES(SYS_GUID(), :fnd_user_id, SYSDATE + 1/144)  -- 10-min expiry
 *
 *   2. EBS opens browser URL:
 *        http://YOUR-CRMS-SERVER:3000/api/v1/auth/fnd-sso?token=<guid>
 *
 *   3. CRMS backend:
 *        a. Reads token from crms_sso_tokens
 *        b. Gets fnd_user_id → looks up FND_USER.USER_NAME
 *        c. Matches FND_USER.USER_NAME to crms_users.fnd_user_name
 *        d. Issues CRMS JWT → auto-login, no password needed
 *
 * SECURITY:
 *   - Token is a UUID (SYS_GUID) — unguessable
 *   - Token expires in 10 minutes
 *   - Token is deleted after first use (one-time use)
 *   - No password or credential is ever transmitted
 */

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const db     = require('../config/db');
const logger = require('../config/logger');

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

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/fnd-token
// Called by Oracle EBS PL/SQL (server-side) to create a one-time SSO token.
// The PL/SQL package calls this before redirecting the user's browser.
//
// Body: { fndUserId: 12345 }   OR   { fndUserName: 'JOHN.SMITH' }
// Returns: { token: 'ABC...', expiresAt: '...' }
// ─────────────────────────────────────────────────────────────────────────────
async function createFndToken(req, res, next) {
  try {
    const { fndUserId, fndUserName } = req.body;

    if (!fndUserId && !fndUserName) {
      return res.status(400).json({ error: 'fndUserId or fndUserName required' });
    }

    // Look up the FND user to confirm they exist
    let fndUser;
    if (fndUserId) {
      fndUser = await db.queryOne(
        "SELECT user_id, user_name, employee_id FROM fnd_user " +
        "WHERE user_id=" + num(fndUserId) + " AND NVL(end_date, SYSDATE+1) > SYSDATE", {}
      );
    } else {
      fndUser = await db.queryOne(
        "SELECT user_id, user_name, employee_id FROM fnd_user " +
        "WHERE UPPER(user_name)='" + safe(fndUserName.toUpperCase()) + "' AND NVL(end_date, SYSDATE+1) > SYSDATE", {}
      );
    }

    if (!fndUser) {
      return res.status(404).json({ error: 'Oracle EBS user not found or inactive' });
    }

    // Now confirm this Oracle user is mapped to a CRMS user
    const crmsUser = await db.queryOne(
      "SELECT user_id, full_name, role FROM crms_users " +
      "WHERE UPPER(fnd_user_name)='" + safe((fndUser.USER_NAME||'').toUpperCase()) + "' " +
      "AND is_active=1", {}
    );

    if (!crmsUser) {
      return res.status(404).json({
        error: 'Oracle user "' + fndUser.USER_NAME + '" is not mapped to any CRMS user. ' +
               'Ask your CRMS administrator to link your Oracle account.',
        fndUserName: fndUser.USER_NAME,
      });
    }

    // Generate a secure one-time token (UUID via SYS_GUID equivalent)
    const token = crypto.randomBytes(32).toString('hex');

    // Store in crms_sso_tokens with 10-minute expiry
    await db.executeWithCommit(
      "INSERT INTO crms_sso_tokens(token, fnd_user_id, crms_user_id, created_at, expires_at) " +
      "VALUES('" + token + "'," + num(fndUser.USER_ID) + "," + num(crmsUser.USER_ID) + "," +
      "SYSDATE, SYSDATE + 10/1440)", {}   // 10 minutes
    );

    logger.info('SSO token created', { fndUserName: fndUser.USER_NAME, crmsUserId: crmsUser.USER_ID });

    return res.json({
      token,
      expiresInSeconds: 600,
      fndUserName: fndUser.USER_NAME,
      crmsUserName: crmsUser.FULL_NAME,
    });

  } catch(err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/fnd-sso?token=<hex>
// Browser lands here after EBS redirects.
// Validates the token, issues CRMS JWT, redirects to app.
// ─────────────────────────────────────────────────────────────────────────────
async function fndSso(req, res, next) {
  try {
    const { token } = req.query;

    if (!token || !/^[0-9a-f]{64}$/.test(token)) {
      return res.status(400).send(errorPage('Invalid SSO token format.'));
    }

    // Look up and validate token
    const tokenRow = await db.queryOne(
      "SELECT t.token, t.crms_user_id, t.expires_at, t.used, " +
      "u.initials, u.full_name, u.role, u.is_active " +
      "FROM crms_sso_tokens t " +
      "JOIN crms_users u ON u.user_id = t.crms_user_id " +
      "WHERE t.token='" + safe(token) + "'", {}
    );

    if (!tokenRow) {
      return res.status(401).send(errorPage(
        'SSO token not found. It may have already been used or never existed.'
      ));
    }

    if (tokenRow.USED === 1 || tokenRow.USED === '1') {
      return res.status(401).send(errorPage(
        'This SSO link has already been used. Please click the menu item again in Oracle EBS.'
      ));
    }

    // Check expiry
    const now     = new Date();
    const expires = new Date(tokenRow.EXPIRES_AT);
    if (now > expires) {
      return res.status(401).send(errorPage(
        'SSO link has expired (valid for 10 minutes). Please click the menu item again in Oracle EBS.'
      ));
    }

    if (!tokenRow.IS_ACTIVE) {
      return res.status(403).send(errorPage(
        'Your CRMS account is inactive. Contact your CRMS administrator.'
      ));
    }

    // ── Mark token as used (one-time use) ──────────────────────────
    await db.executeWithCommit(
      "UPDATE crms_sso_tokens SET used=1, used_at=SYSDATE WHERE token='" + safe(token) + "'", {}
    );

    // ── Log the login ───────────────────────────────────────────────
    const uid = num(tokenRow.CRMS_USER_ID);
    await db.executeWithCommit(
      "UPDATE crms_users SET last_login=SYSDATE WHERE user_id=" + uid, {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES(" +
      "'Login'," + uid + ",'--','Oracle EBS SSO login: " + safe(tokenRow.FULL_NAME) + "')", {}
    );

    // ── Issue CRMS JWT tokens ───────────────────────────────────────
    const accessToken  = signAccess(tokenRow.CRMS_USER_ID, tokenRow.ROLE);
    const refreshToken = signRefresh(tokenRow.CRMS_USER_ID);

    logger.info('EBS FND SSO login success', {
      crmsUserId: tokenRow.CRMS_USER_ID,
      fullName:   tokenRow.FULL_NAME,
    });

    // ── Return HTML that stores tokens and redirects to CRMS ────────
    return res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Logging in to CRMS...</title>
  <style>
    body { font-family: Arial, sans-serif; background: #C8102E; display: flex;
           align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: white; border-radius: 12px; padding: 40px; text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 400px; }
    .logo { color: #C8102E; font-size: 24px; font-weight: 700; margin-bottom: 16px; }
    .msg  { color: #555; font-size: 14px; margin-bottom: 20px; }
    .spinner { width: 36px; height: 36px; border: 4px solid #f3f3f3;
               border-top: 4px solid #C8102E; border-radius: 50%;
               animation: spin 0.8s linear infinite; margin: 0 auto; }
    @keyframes spin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Motherson CRMS</div>
    <div class="msg">Welcome, <strong>${tokenRow.FULL_NAME}</strong><br>Logging you in via Oracle EBS...</div>
    <div class="spinner"></div>
  </div>
  <script>
    (function() {
      try {
        sessionStorage.setItem('crms_access',  ${JSON.stringify(accessToken)});
        sessionStorage.setItem('crms_refresh', ${JSON.stringify(refreshToken)});
        // Redirect to CRMS main page after a brief moment
        setTimeout(function() { window.location.replace('/'); }, 800);
      } catch(e) {
        document.querySelector('.msg').innerHTML =
          'Login error: ' + e.message + '<br><a href="/">Click here to login manually</a>';
      }
    })();
  </script>
</body>
</html>`);

  } catch(err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/fnd-users
// Returns all FND_USER records that are NOT yet mapped to CRMS users.
// Used by CRMS Admin to see who needs to be linked.
// ─────────────────────────────────────────────────────────────────────────────
async function listFndUsers(req, res, next) {
  try {
    // All active FND users
    const fndUsers = await db.query(
      "SELECT u.user_id, u.user_name, u.description, u.email_address, " +
      "NVL(u.end_date, TO_DATE('9999-12-31','YYYY-MM-DD')) AS end_date, " +
      "c.user_id AS crms_user_id, c.full_name AS crms_full_name, " +
      "c.initials AS crms_initials " +
      "FROM fnd_user u " +
      "LEFT JOIN crms_users c ON UPPER(c.fnd_user_name) = UPPER(u.user_name) " +
      "WHERE NVL(u.end_date, SYSDATE+1) > SYSDATE " +
      "AND u.user_name NOT IN ('GUEST','INITIAL SETUP','SYSADMIN') " +
      "ORDER BY u.user_name " +
      "FETCH FIRST 200 ROWS ONLY", {}
    );

    return res.json(fndUsers.map(u => ({
      fndUserId:      u.USER_ID,
      fndUserName:    u.USER_NAME,
      description:    u.DESCRIPTION || '',
      email:          u.EMAIL_ADDRESS || '',
      crmsUserId:     u.CRMS_USER_ID || null,
      crmsFullName:   u.CRMS_FULL_NAME || null,
      crmsInitials:   u.CRMS_INITIALS || null,
      isMapped:       !!u.CRMS_USER_ID,
    })));
  } catch(err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/link-fnd-user
// Admin links an FND_USER to a CRMS user.
// Body: { crmsUserId: 5, fndUserName: 'JOHN.SMITH' }
// ─────────────────────────────────────────────────────────────────────────────
async function linkFndUser(req, res, next) {
  try {
    const { crmsUserId, fndUserName } = req.body;
    if (!crmsUserId || !fndUserName) {
      return res.status(400).json({ error: 'crmsUserId and fndUserName required' });
    }

    // Verify FND user exists
    const fndUser = await db.queryOne(
      "SELECT user_id, user_name FROM fnd_user " +
      "WHERE UPPER(user_name)='" + safe(fndUserName.toUpperCase()) + "' " +
      "AND NVL(end_date, SYSDATE+1) > SYSDATE", {}
    );
    if (!fndUser) {
      return res.status(404).json({ error: 'Oracle EBS user "' + fndUserName + '" not found or inactive' });
    }

    // Check not already mapped to another CRMS user
    const existing = await db.queryOne(
      "SELECT user_id, full_name FROM crms_users " +
      "WHERE UPPER(fnd_user_name)='" + safe(fndUserName.toUpperCase()) + "' " +
      "AND user_id <> " + num(crmsUserId), {}
    );
    if (existing) {
      return res.status(409).json({
        error: '"' + fndUserName + '" is already linked to CRMS user "' + existing.FULL_NAME + '"',
      });
    }

    // Update the mapping
    await db.executeWithCommit(
      "UPDATE crms_users SET fnd_user_name='" + safe(fndUserName.toUpperCase()) + "' " +
      "WHERE user_id=" + num(crmsUserId), {}
    );

    logger.info('FND user linked', { crmsUserId, fndUserName });
    return res.json({ message: 'Linked "' + fndUserName + '" to CRMS user successfully' });

  } catch(err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: styled error page
// ─────────────────────────────────────────────────────────────────────────────
function errorPage(message) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>CRMS Login Error</title>
<style>
  body { font-family: Arial, sans-serif; background: #C8102E; display: flex;
         align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { background: white; border-radius: 12px; padding: 40px; text-align: center;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 420px; }
  .logo { color: #C8102E; font-size: 22px; font-weight: 700; margin-bottom: 16px; }
  .err  { color: #555; font-size: 13px; line-height: 1.6; margin-bottom: 20px; }
  a { color: #C8102E; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">Motherson CRMS</div>
    <div class="err">${message}</div>
    <a href="/">Go to CRMS Login</a>
  </div>
</body>
</html>`;
}


// ─────────────────────────────────────────────────────────────────────────────
// GET /ebs-launch
// This is the URL registered in Oracle EBS Function HTML Call field.
// EBS opens this in a new browser window when user clicks the menu item.
//
// HOW IT WORKS:
//   Browser arrives here from EBS with the Oracle ICX session cookie.
//   We query FND_USER using the ICX session to identify the user,
//   create a one-time token, and redirect to CRMS with auto-login.
//
//   If we cannot identify the user from cookies (direct access),
//   we show a loading page that calls the fnd-token API.
// ─────────────────────────────────────────────────────────────────────────────
async function ebsLaunch(req, res, next) {
  try {
    // Method 1: Try to identify user from ICX_SESSION cookie
    // Oracle EBS sets this cookie when user logs in
    const icxSession = req.cookies && (
      req.cookies['ICX_SESSION'] ||
      req.cookies['ICX_HR_SESSION'] ||
      req.cookies['EBS_SESSION']
    );

    // Method 2: Check for Oracle username in request header
    // (Set by Apache mod_proxy: RequestHeader set X-Oracle-Username "%{REMOTE_USER}s")
    const headerUser = req.headers['x-oracle-username'] ||
                       req.headers['x-remote-user'] ||
                       req.headers['x-forwarded-user'];

    let fndUserName = null;

    // Try header first (most reliable when Apache proxied)
    if (headerUser && headerUser !== '%{REMOTE_USER}s' && headerUser.trim()) {
      fndUserName = headerUser.trim().toUpperCase();
      logger.info('EBS launch via header', { fndUserName });
    }

    // Try ICX session cookie
    if (!fndUserName && icxSession) {
      try {
        const sessionRow = await db.queryOne(
          "SELECT u.user_name FROM icx_sessions s " +
          "JOIN fnd_user u ON u.user_id = s.user_id " +
          "WHERE s.session_id='" + safe(icxSession) + "' " +
          "AND s.disabled_flag='N' AND ROWNUM=1", {}
        );
        if (sessionRow) {
          fndUserName = sessionRow.USER_NAME;
          logger.info('EBS launch via ICX session', { fndUserName });
        }
      } catch(e) {
        logger.debug('ICX session lookup failed: ' + e.message);
      }
    }

    // If we identified the user server-side — create token and redirect
    if (fndUserName) {
      const crmsUser = await db.queryOne(
        "SELECT user_id, initials, full_name, role, is_active " +
        "FROM crms_users " +
        "WHERE UPPER(fnd_user_name)='" + safe(fndUserName.toUpperCase()) + "'", {}
      );

      if (crmsUser && crmsUser.IS_ACTIVE) {
        // Create one-time token
        const token = require('crypto').randomBytes(32).toString('hex');
        const fndUser = await db.queryOne(
          "SELECT user_id FROM fnd_user WHERE UPPER(user_name)='" +
          safe(fndUserName.toUpperCase()) + "' AND ROWNUM=1", {}
        );

        await db.executeWithCommit(
          "INSERT INTO crms_sso_tokens(token,fnd_user_id,crms_user_id,created_at,expires_at) VALUES('" +
          token + "'," + num(fndUser ? fndUser.USER_ID : 0) + "," +
          num(crmsUser.USER_ID) + ",SYSDATE,SYSDATE+10/1440)", {}
        );

        // Redirect to fnd-sso with token
        return res.redirect(302, '/api/v1/auth/fnd-sso?token=' + token);
      }
    }

    // Fallback: serve a smart launch page that identifies the user client-side
    // This works when cookies are accessible from the same domain
    return res.send(launchPage());

  } catch(err) {
    logger.error('EBS launch error: ' + err.message);
    return res.send(launchPage());
  }
}

function launchPage() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Opening CR Management System...</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #C8102E;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; }
    .card { background: white; border-radius: 14px; padding: 48px 40px;
            text-align: center; max-width: 420px; width: 90%;
            box-shadow: 0 24px 64px rgba(0,0,0,0.35); }
    .logo { color: #C8102E; font-size: 26px; font-weight: 700;
            letter-spacing: -0.5px; margin-bottom: 8px; }
    .sub  { color: #999; font-size: 13px; margin-bottom: 28px; }
    .msg  { color: #555; font-size: 14px; margin-bottom: 24px; line-height: 1.6; }
    .spinner { width: 40px; height: 40px; border: 4px solid #f0f0f0;
               border-top: 4px solid #C8102E; border-radius: 50%;
               animation: spin 0.9s linear infinite; margin: 0 auto 20px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .err  { color: #dc2626; font-size: 13px; display: none; margin-top: 16px; }
    .btn  { display: inline-block; margin-top: 16px; padding: 10px 24px;
            background: #C8102E; color: white; text-decoration: none;
            border-radius: 6px; font-size: 14px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Motherson CRMS</div>
    <div class="sub">CR Management System</div>
    <div class="spinner" id="spin"></div>
    <div class="msg" id="msg">Connecting to Oracle EBS session...<br>Please wait.</div>
    <div class="err" id="err">
      Could not detect your Oracle session.<br>
      <a class="btn" href="/">Login Manually</a>
    </div>
  </div>
  <script>
  (function() {
    // Check if we already have a valid CRMS session
    var stored = null;
    try { stored = sessionStorage.getItem('crms_access'); } catch(e) {}

    if (stored) {
      // Already logged in — go straight to CRMS
      document.getElementById('msg').textContent = 'Already logged in. Redirecting...';
      setTimeout(function() { window.location.replace('/'); }, 500);
      return;
    }

    // Ask the backend to check Oracle cookies and identify the user
    // The backend reads ICX_SESSION cookie (same domain) and looks up FND_USER
    fetch('/api/v1/auth/ebs-session-check', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.redirectTo) {
          document.getElementById('msg').textContent = 'Oracle user found. Logging in...';
          window.location.replace(data.redirectTo);
        } else {
          showError();
        }
      })
      .catch(function() { showError(); });

    function showError() {
      document.getElementById('spin').style.display = 'none';
      document.getElementById('msg').style.display  = 'none';
      document.getElementById('err').style.display  = 'block';
    }

    // Timeout after 8 seconds
    setTimeout(showError, 8000);
  })();
  </script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/ebs-session-check
// Called by the launch page JavaScript — checks ICX cookies server-side
// and returns a redirect URL if user is identified
// ─────────────────────────────────────────────────────────────────────────────
async function ebsSessionCheck(req, res, next) {
  try {
    const icxSession = req.cookies && (
      req.cookies['ICX_SESSION'] ||
      req.cookies['ICX_HR_SESSION'] ||
      req.cookies['EBS_SESSION'] ||
      req.cookies['JSESSIONID']
    );

    if (!icxSession) {
      return res.json({ found: false, reason: 'No Oracle session cookie' });
    }

    // Try to resolve session to FND_USER
    let fndUserName = null;
    try {
      const row = await db.queryOne(
        "SELECT u.user_name FROM icx_sessions s " +
        "JOIN fnd_user u ON u.user_id=s.user_id " +
        "WHERE s.session_id='" + safe(icxSession) + "' " +
        "AND NVL(s.disabled_flag,'N')='N' AND ROWNUM=1", {}
      );
      if (row) fndUserName = row.USER_NAME;
    } catch(e) {
      logger.debug('Session check ICX lookup: ' + e.message);
    }

    if (!fndUserName) {
      return res.json({ found: false, reason: 'Session not found in ICX_SESSIONS' });
    }

    // Find CRMS user
    const crmsUser = await db.queryOne(
      "SELECT user_id, full_name, role, is_active FROM crms_users " +
      "WHERE UPPER(fnd_user_name)='" + safe(fndUserName.toUpperCase()) + "'", {}
    );

    if (!crmsUser || !crmsUser.IS_ACTIVE) {
      return res.json({ found: false, reason: 'Oracle user not mapped in CRMS', fndUserName });
    }

    // Create token and return redirect
    const token = require('crypto').randomBytes(32).toString('hex');
    const fndU  = await db.queryOne(
      "SELECT user_id FROM fnd_user WHERE UPPER(user_name)='" +
      safe(fndUserName.toUpperCase()) + "' AND ROWNUM=1", {}
    );

    await db.executeWithCommit(
      "INSERT INTO crms_sso_tokens(token,fnd_user_id,crms_user_id,created_at,expires_at) VALUES('" +
      token + "'," + num(fndU ? fndU.USER_ID : 0) + "," +
      num(crmsUser.USER_ID) + ",SYSDATE,SYSDATE+10/1440)", {}
    );

    return res.json({
      found: true,
      fndUserName,
      crmsFullName: crmsUser.FULL_NAME,
      redirectTo: '/api/v1/auth/fnd-sso?token=' + token,
    });

  } catch(err) {
    logger.error('ebs-session-check error: ' + err.message);
    return res.json({ found: false, reason: 'Internal error: ' + err.message });
  }
}

module.exports = { createFndToken, fndSso, listFndUsers, linkFndUser, ebsLaunch, ebsSessionCheck };
