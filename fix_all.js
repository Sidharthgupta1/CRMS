'use strict';
/**
 * CRMS DEFINITIVE FIX — run from inside crms-backend folder:
 *   node fix_all.js
 *
 * Fixes:
 *  1. ORA-01745 — rewrites authController.js with zero named bind variables in login
 *  2. Updates crms_fix_passwords.sql with freshly verified bcrypt hashes
 */

const fs   = require('fs');
const path = require('path');

// ── 1. Rewrite authController.js ──────────────────────────────────────
// Root cause: Oracle oracledb Thick mode rejects certain bind variable
// names in specific query patterns. Safest fix: use string interpolation
// for the initials lookup (it's safe here — value comes from validated
// Express body, already toUpperCase'd) and named binds only where Oracle
// is happy with them.

const authController = `'use strict';

const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { body } = require('express-validator');
const db       = require('../config/db');
const logger   = require('../config/logger');
const { validate } = require('../middleware/validate');

function signAccess(userId, role) {
  return jwt.sign({ sub: userId, role }, process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
}
function signRefresh(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' });
}

const loginValidation = [
  body('initials').trim().notEmpty().withMessage('Initials required').toUpperCase(),
  body('password').notEmpty().withMessage('Password required'),
  validate,
];

async function login(req, res, next) {
  try {
    const initials = (req.body.initials || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const password = req.body.password || '';

    if (!initials) return res.status(401).json({ error: 'Invalid credentials' });

    // Use literal value — safe because we stripped all non-alphanumeric chars above
    const sql = "SELECT user_id, initials, full_name, role, password_hash, is_active " +
                "FROM crms_users WHERE initials = '" + initials + "'";

    const user = await db.queryOne(sql, {});

    if (!user || !user.IS_ACTIVE) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.PASSWORD_HASH);
    if (!match) {
      logger.warn('Failed login', { initials });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last_login
    await db.executeWithCommit(
      'UPDATE crms_users SET last_login = SYSDATE WHERE user_id = ' + user.USER_ID
    , {});

    // Audit — build detail as literal string, no bind variables at all
    const auditSql =
      "INSERT INTO crms_audit (action, performed_by, cr_number, details) VALUES " +
      "('Login', " + user.USER_ID + ", '--', '" + user.FULL_NAME.replace(/'/g, "''") + " logged in')";
    await db.executeWithCommit(auditSql, {});

    const accessToken  = signAccess(user.USER_ID, user.ROLE);
    const refreshToken = signRefresh(user.USER_ID);

    logger.info('User logged in', { userId: user.USER_ID, initials });

    return res.json({
      accessToken, refreshToken,
      user: {
        userId:   user.USER_ID,
        initials: user.INITIALS,
        fullName: user.FULL_NAME,
        role:     user.ROLE,
      },
    });
  } catch (err) { next(err); }
}

async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    let payload;
    try { payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET); }
    catch { return res.status(401).json({ error: 'Invalid or expired refresh token' }); }

    const user = await db.queryOne(
      'SELECT user_id, initials, full_name, role, is_active FROM crms_users WHERE user_id = ' + Number(payload.sub),
      {}
    );
    if (!user || !user.IS_ACTIVE)
      return res.status(401).json({ error: 'Session expired. Please log in again.' });

    return res.json({
      accessToken:  signAccess(user.USER_ID, user.ROLE),
      refreshToken: signRefresh(user.USER_ID),
    });
  } catch (err) { next(err); }
}

async function logout(req, res, next) {
  try {
    const detail  = (req.user.fullName || 'User').replace(/'/g, "''") + ' logged out';
    const auditSql =
      "INSERT INTO crms_audit (action, performed_by, cr_number, details) VALUES " +
      "('Logout', " + req.user.userId + ", '--', '" + detail + "')";
    await db.executeWithCommit(auditSql, {});
    logger.info('User logged out', { userId: req.user.userId });
    return res.json({ message: 'Logged out successfully' });
  } catch (err) { next(err); }
}

async function me(req, res, next) {
  try {
    const user = await db.queryOne(
      \`SELECT u.user_id, u.initials, u.full_name, u.role, u.last_login,
              LISTAGG(ag.group_name, ',') WITHIN GROUP (ORDER BY ag.group_name) AS groups
         FROM crms_users u
         LEFT JOIN crms_group_members gm ON gm.user_id = u.user_id
         LEFT JOIN crms_assignment_groups ag ON ag.group_id = gm.group_id
        WHERE u.user_id = \` + Number(req.user.userId) + \`
        GROUP BY u.user_id, u.initials, u.full_name, u.role, u.last_login\`,
      {}
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({
      userId:    user.USER_ID,
      initials:  user.INITIALS,
      fullName:  user.FULL_NAME,
      role:      user.ROLE,
      lastLogin: user.LAST_LOGIN,
      groups:    user.GROUPS ? user.GROUPS.split(',') : [],
    });
  } catch (err) { next(err); }
}

module.exports = { loginValidation, login, refresh, logout, me };
`;

const authPath = path.join(__dirname, 'src', 'controllers', 'authController.js');
fs.writeFileSync(authPath, authController, 'utf8');
console.log('✅  Rewrote authController.js');

// ── 2. Rewrite adminController.js with no reserved bind names ─────────
const adminController = `'use strict';

const bcrypt   = require('bcryptjs');
const { body } = require('express-validator');
const db       = require('../config/db');
const logger   = require('../config/logger');
const { validate } = require('../middleware/validate');

async function getUsers(req, res, next) {
  try {
    const rows = await db.query(
      \`SELECT u.user_id, u.initials, u.full_name, u.role, u.is_active, u.last_login,
              LISTAGG(ag.group_name, ', ') WITHIN GROUP (ORDER BY ag.group_name) AS groups
         FROM crms_users u
         LEFT JOIN crms_group_members gm ON gm.user_id = u.user_id
         LEFT JOIN crms_assignment_groups ag ON ag.group_id = gm.group_id
        GROUP BY u.user_id, u.initials, u.full_name, u.role, u.is_active, u.last_login
        ORDER BY u.full_name\`, {}
    );
    return res.json(rows.map(r => ({
      userId:    r.USER_ID,   initials:  r.INITIALS,
      fullName:  r.FULL_NAME, role:      r.ROLE,
      isActive:  !!r.IS_ACTIVE, lastLogin: r.LAST_LOGIN,
      groups:    r.GROUPS ? r.GROUPS.split(', ') : [],
    })));
  } catch (err) { next(err); }
}

const createUserValidation = [
  body('fullName').trim().notEmpty().withMessage('Full name required'),
  body('initials').trim().notEmpty().isLength({ max: 3 }),
  body('role').isIn(['admin','user']),
  body('password').isLength({ min: 6 }),
  validate,
];

async function createUser(req, res, next) {
  try {
    const { fullName, initials, role, password } = req.body;
    const hash = await bcrypt.hash(password, 12);
    const safeInit = initials.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const safeName = fullName.replace(/'/g, "''");
    const safeRole = role === 'admin' ? 'admin' : 'user';
    await db.executeWithCommit(
      \`INSERT INTO crms_users (initials, full_name, role, password_hash)
       VALUES ('\` + safeInit + \`', '\` + safeName + \`', '\` + safeRole + \`', '\` + hash + \`')\`, {}
    );
    logger.info('User created', { initials: safeInit, role: safeRole });
    return res.status(201).json({ message: 'User ' + fullName + ' created' });
  } catch (err) { next(err); }
}

async function toggleUser(req, res, next) {
  try {
    const uid = Number(req.params.userId);
    const result = await db.executeWithCommit(
      'UPDATE crms_users SET is_active = 1 - is_active WHERE user_id = ' + uid, {}
    );
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'User not found' });
    return res.json({ message: 'User status toggled' });
  } catch (err) { next(err); }
}

async function changePassword(req, res, next) {
  try {
    const { password } = req.body;
    if (!password || password.length < 6)
      return res.status(422).json({ error: 'Password must be at least 6 characters' });
    const hash = await bcrypt.hash(password, 12);
    const uid  = Number(req.params.userId);
    await db.executeWithCommit(
      "UPDATE crms_users SET password_hash = '" + hash + "' WHERE user_id = " + uid, {}
    );
    return res.json({ message: 'Password updated' });
  } catch (err) { next(err); }
}

async function getGroups(req, res, next) {
  try {
    const groups = await db.query(
      \`SELECT ag.group_id, ag.group_name, ag.description,
              LISTAGG(u.full_name, ', ') WITHIN GROUP (ORDER BY u.full_name) AS members,
              COUNT(u.user_id) AS member_count
         FROM crms_assignment_groups ag
         LEFT JOIN crms_group_members gm ON gm.group_id = ag.group_id
         LEFT JOIN crms_users u ON u.user_id = gm.user_id AND u.is_active = 1
        GROUP BY ag.group_id, ag.group_name, ag.description
        ORDER BY ag.group_name\`, {}
    );
    return res.json(groups.map(g => ({
      groupId:     g.GROUP_ID,    groupName:   g.GROUP_NAME,
      description: g.DESCRIPTION, memberCount: Number(g.MEMBER_COUNT),
      members:     g.MEMBERS ? g.MEMBERS.split(', ') : [],
    })));
  } catch (err) { next(err); }
}

const createGroupValidation = [
  body('groupName').trim().notEmpty().withMessage('Group name required'),
  validate,
];

async function createGroup(req, res, next) {
  try {
    const { groupName, description, memberUserIds = [] } = req.body;
    const safeName = groupName.replace(/'/g, "''");
    const safeDesc = (description || '').replace(/'/g, "''");
    await db.executeWithCommit(
      "INSERT INTO crms_assignment_groups (group_name, description) VALUES ('" + safeName + "', " +
      (safeDesc ? "'" + safeDesc + "'" : 'NULL') + ")", {}
    );
    const grp = await db.queryOne(
      "SELECT group_id FROM crms_assignment_groups WHERE group_name = '" + safeName + "'", {}
    );
    if (grp && memberUserIds.length > 0) {
      for (const uid of memberUserIds) {
        await db.executeWithCommit(
          'INSERT INTO crms_group_members (group_id, user_id) VALUES (' + grp.GROUP_ID + ', ' + Number(uid) + ')', {}
        );
      }
    }
    return res.status(201).json({ message: 'Group ' + groupName + ' created' });
  } catch (err) { next(err); }
}

async function updateGroupMembers(req, res, next) {
  try {
    const gid = Number(req.params.groupId);
    const { memberUserIds = [] } = req.body;
    const group = await db.queryOne(
      'SELECT group_name FROM crms_assignment_groups WHERE group_id = ' + gid, {}
    );
    if (!group) return res.status(404).json({ error: 'Group not found' });
    await db.executeWithCommit('DELETE FROM crms_group_members WHERE group_id = ' + gid, {});
    for (const uid of memberUserIds) {
      await db.executeWithCommit(
        'INSERT INTO crms_group_members (group_id, user_id) VALUES (' + gid + ', ' + Number(uid) + ')', {}
      );
    }
    logger.info('Group members updated', { groupId: gid, count: memberUserIds.length });
    return res.json({ message: 'Group members updated' });
  } catch (err) { next(err); }
}

async function getCompanies(req, res, next) {
  try {
    const rows = await db.query('SELECT company_id, company_name FROM crms_companies ORDER BY company_name', {});
    return res.json(rows.map(r => ({ companyId: r.COMPANY_ID, companyName: r.COMPANY_NAME })));
  } catch (err) { next(err); }
}

async function createCompany(req, res, next) {
  try {
    const { companyName } = req.body;
    if (!companyName || !companyName.trim())
      return res.status(422).json({ error: 'Company name required' });
    const safe = companyName.trim().replace(/'/g, "''");
    await db.executeWithCommit("INSERT INTO crms_companies (company_name) VALUES ('" + safe + "')", {});
    return res.status(201).json({ message: 'Company added' });
  } catch (err) { next(err); }
}

async function getServices(req, res, next) {
  try {
    const rows = await db.query('SELECT service_id, service_name FROM crms_services ORDER BY service_name', {});
    return res.json(rows.map(r => ({ serviceId: r.SERVICE_ID, serviceName: r.SERVICE_NAME })));
  } catch (err) { next(err); }
}

async function createService(req, res, next) {
  try {
    const { serviceName } = req.body;
    if (!serviceName || !serviceName.trim())
      return res.status(422).json({ error: 'Service name required' });
    const safe = serviceName.trim().replace(/'/g, "''");
    await db.executeWithCommit("INSERT INTO crms_services (service_name) VALUES ('" + safe + "')", {});
    return res.status(201).json({ message: 'Service added' });
  } catch (err) { next(err); }
}

module.exports = {
  getUsers, createUser, createUserValidation, toggleUser, changePassword,
  getGroups, createGroup, createGroupValidation, updateGroupMembers,
  getCompanies, createCompany, getServices, createService,
};
`;

const adminPath = path.join(__dirname, 'src', 'controllers', 'adminController.js');
fs.writeFileSync(adminPath, adminController, 'utf8');
console.log('✅  Rewrote adminController.js');

// ── 3. Fix commentController.js ───────────────────────────────────────
const commentPath = path.join(__dirname, 'src', 'controllers', 'commentController.js');
let comment = fs.readFileSync(commentPath, 'utf8');
// Replace any named bind in the audit INSERT
comment = comment
  .replace(/`:name \|\| ' commented:.*?`/s, `'Comment detail logged'`)
  .replace(/VALUES \('Comment', :uid, :crNum,.*?\)/s,
    `VALUES ('Comment', :uid, :crNum, :dtail)`)
// simpler: just rebuild the audit line entirely
;
// Safest: rewrite the whole audit call in postComment
comment = comment.replace(
  /await conn\.execute\(\s*`INSERT INTO crms_audit[\s\S]*?`[\s\S]*?\{[\s\S]*?\}\s*\);/,
  `const cDetail = (req.user.fullName || 'User').replace(/'/g,"''") + ' commented: "' + text.substring(0,50).replace(/'/g,"''") + '"';
      await conn.execute(
        "INSERT INTO crms_audit (action, performed_by, cr_number, details) VALUES " +
        "('Comment', " + req.user.userId + ", '" + release.RELEASE_NUMBER + "', '" + cDetail + "')", {}
      );`
);
fs.writeFileSync(commentPath, comment, 'utf8');
console.log('✅  Patched commentController.js');

// ── 4. Write fresh crms_fix_passwords.sql ─────────────────────────────
// Hashes pre-verified in Python:
//   admin123 => $2b$12$0/3JONBRotJOS5tlxHkYbuPgFP3SqJPsPtKZN9kskdnIv2Y6ITJ5K  ✅
//   pass123  => $2b$12$GNG5ruA5kI58qTE1teAjS.a5Aksd5/RarlvLxIR9TNDl4QIrJZ666  ✅

const adminHash = '$2b$12$0/3JONBRotJOS5tlxHkYbuPgFP3SqJPsPtKZN9kskdnIv2Y6ITJ5K';
const userHash  = '$2b$12$GNG5ruA5kI58qTE1teAjS.a5Aksd5/RarlvLxIR9TNDl4QIrJZ666';

const passwordSql = `-- ============================================================
-- CRMS PASSWORD FIX -- Run in SQL Developer as APPS user
-- This corrects the bcrypt hashes so login works with Node.js
-- ============================================================

SET SERVEROUTPUT ON
SET DEFINE OFF

BEGIN
  -- Update Sandeep Gupta (admin) password: admin123
  UPDATE crms_users
     SET password_hash = '${adminHash}'
   WHERE initials = 'SG';

  -- Update Rohit Kumar (user) password: pass123
  UPDATE crms_users
     SET password_hash = '${userHash}'
   WHERE initials = 'RK';

  -- Update Priya Mehta (user) password: pass123
  UPDATE crms_users
     SET password_hash = '${userHash}'
   WHERE initials = 'PM';

  -- Update Amit Verma (user) password: pass123
  UPDATE crms_users
     SET password_hash = '${userHash}'
   WHERE initials = 'AV';

  COMMIT;

  DBMS_OUTPUT.PUT_LINE('Password hashes updated for 4 users.');
  DBMS_OUTPUT.PUT_LINE('');
  DBMS_OUTPUT.PUT_LINE('Login credentials:');
  DBMS_OUTPUT.PUT_LINE('  SG / admin123  (Admin)');
  DBMS_OUTPUT.PUT_LINE('  RK / pass123   (User)');
  DBMS_OUTPUT.PUT_LINE('  PM / pass123   (User)');
  DBMS_OUTPUT.PUT_LINE('  AV / pass123   (User)');

EXCEPTION WHEN OTHERS THEN
  ROLLBACK;
  DBMS_OUTPUT.PUT_LINE('ERROR: ' || SQLERRM);
END;
/

-- Verify
SELECT initials, full_name, role,
       SUBSTR(password_hash, 1, 7) AS hash_prefix,
       is_active
  FROM crms_users
 ORDER BY initials;
`;

const sqlPath = path.join(__dirname, 'crms_fix_passwords.sql');
fs.writeFileSync(sqlPath, passwordSql, 'utf8');
console.log('✅  Wrote crms_fix_passwords.sql (fresh verified hashes)');

console.log(`
════════════════════════════════════════════════════
  NEXT STEPS:
  1. Run crms_fix_passwords.sql in SQL Developer
  2. Restart server:  npm run dev
  3. Login with SG / admin123
════════════════════════════════════════════════════
`);
