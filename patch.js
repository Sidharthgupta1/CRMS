'use strict';
/**
 * CRMS Patch Script — fixes ORA-01745 (invalid bind variable names)
 * 
 * Run from inside the crms-backend folder:
 *   node patch.js
 */

const fs   = require('fs');
const path = require('path');

function patch(filePath, description, replacements) {
  const full = path.join(__dirname, filePath);
  if (!fs.existsSync(full)) {
    console.log(`SKIP  ${filePath} (not found)`);
    return;
  }
  let content = fs.readFileSync(full, 'utf8');
  const orig  = content;
  let count   = 0;
  for (const [from, to] of replacements) {
    if (content.includes(from)) {
      content = content.split(from).join(to);
      count++;
    }
  }
  if (content !== orig) {
    fs.writeFileSync(full, content, 'utf8');
    console.log(`FIXED ${filePath} (${count} replacements) — ${description}`);
  } else {
    console.log(`OK    ${filePath} — ${description}`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 1. REWRITE authController.js completely — positional binds only
// ══════════════════════════════════════════════════════════════════════
const newAuthController = `'use strict';

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
    const { initials, password } = req.body;

    const user = await db.queryOne(
      \`SELECT user_id, initials, full_name, role, password_hash, is_active
         FROM crms_users
        WHERE UPPER(initials) = UPPER(:init)\`,
      { init: initials }
    );

    if (!user || !user.IS_ACTIVE) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.PASSWORD_HASH);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await db.executeWithCommit(
      'UPDATE crms_users SET last_login = SYSDATE WHERE user_id = :uid',
      { uid: user.USER_ID }
    );

    const detail = user.FULL_NAME + ' logged in';
    await db.executeWithCommit(
      \`INSERT INTO crms_audit (action, performed_by, cr_number, details)
       VALUES ('Login', :uid, '--', :detail)\`,
      { uid: user.USER_ID, detail }
    );

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
      'SELECT user_id, initials, full_name, role, is_active FROM crms_users WHERE user_id = :uid',
      { uid: payload.sub }
    );

    if (!user || !user.IS_ACTIVE) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    return res.json({
      accessToken:  signAccess(user.USER_ID, user.ROLE),
      refreshToken: signRefresh(user.USER_ID),
    });
  } catch (err) { next(err); }
}

async function logout(req, res, next) {
  try {
    const detail = req.user.fullName + ' logged out';
    await db.executeWithCommit(
      \`INSERT INTO crms_audit (action, performed_by, cr_number, details)
       VALUES ('Logout', :uid, '--', :detail)\`,
      { uid: req.user.userId, detail }
    );
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
        WHERE u.user_id = :uid
        GROUP BY u.user_id, u.initials, u.full_name, u.role, u.last_login\`,
      { uid: req.user.userId }
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

// ══════════════════════════════════════════════════════════════════════
// 2. REWRITE adminController.js — safe bind variable names throughout
// ══════════════════════════════════════════════════════════════════════
const newAdminController = `'use strict';

const bcrypt   = require('bcryptjs');
const { body } = require('express-validator');
const db       = require('../config/db');
const logger   = require('../config/logger');
const { validate } = require('../middleware/validate');

// ── USERS ─────────────────────────────────────────────────────────────
async function getUsers(req, res, next) {
  try {
    const rows = await db.query(
      \`SELECT u.user_id, u.initials, u.full_name, u.role, u.is_active, u.last_login,
              LISTAGG(ag.group_name, ', ') WITHIN GROUP (ORDER BY ag.group_name) AS groups
         FROM crms_users u
         LEFT JOIN crms_group_members gm ON gm.user_id = u.user_id
         LEFT JOIN crms_assignment_groups ag ON ag.group_id = gm.group_id
        GROUP BY u.user_id, u.initials, u.full_name, u.role, u.is_active, u.last_login
        ORDER BY u.full_name\`
    );
    return res.json(rows.map(r => ({
      userId:    r.USER_ID,
      initials:  r.INITIALS,
      fullName:  r.FULL_NAME,
      role:      r.ROLE,
      isActive:  !!r.IS_ACTIVE,
      lastLogin: r.LAST_LOGIN,
      groups:    r.GROUPS ? r.GROUPS.split(', ') : [],
    })));
  } catch (err) { next(err); }
}

const createUserValidation = [
  body('fullName').trim().notEmpty().withMessage('Full name required'),
  body('initials').trim().notEmpty().isLength({ max: 3 }).withMessage('Initials required (max 3 chars)'),
  body('role').isIn(['admin','user']).withMessage('Role must be admin or user'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  validate,
];

async function createUser(req, res, next) {
  try {
    const { fullName, initials, role, password } = req.body;
    const hash = await bcrypt.hash(password, 12);
    await db.transaction(async (conn) => {
      await conn.execute(
        \`INSERT INTO crms_users (initials, full_name, role, password_hash)
         VALUES (UPPER(:init), :fname, :urole, :phash)\`,
        { init: initials, fname: fullName, urole: role, phash: hash }
      );
      const adminName = req.user.fullName;
      await conn.execute(
        \`INSERT INTO crms_audit (action, performed_by, cr_number, details)
         VALUES ('User Added', :uid, '--', :detail)\`,
        { uid: req.user.userId, detail: adminName + ' added user ' + fullName }
      );
      await conn.commit();
    });
    logger.info('User created', { initials, role, by: req.user.userId });
    return res.status(201).json({ message: 'User ' + fullName + ' created' });
  } catch (err) { next(err); }
}

async function toggleUser(req, res, next) {
  try {
    const result = await db.executeWithCommit(
      'UPDATE crms_users SET is_active = 1 - is_active WHERE user_id = :uid',
      { uid: req.params.userId }
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
    await db.executeWithCommit(
      'UPDATE crms_users SET password_hash = :phash WHERE user_id = :uid',
      { phash: hash, uid: req.params.userId }
    );
    return res.json({ message: 'Password updated' });
  } catch (err) { next(err); }
}

// ── ASSIGNMENT GROUPS ─────────────────────────────────────────────────
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
        ORDER BY ag.group_name\`
    );
    return res.json(groups.map(g => ({
      groupId:     g.GROUP_ID,
      groupName:   g.GROUP_NAME,
      description: g.DESCRIPTION,
      members:     g.MEMBERS ? g.MEMBERS.split(', ') : [],
      memberCount: Number(g.MEMBER_COUNT),
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
    await db.transaction(async (conn) => {
      await conn.execute(
        'INSERT INTO crms_assignment_groups (group_name, description) VALUES (:gname, :gdesc)',
        { gname: groupName, gdesc: description || null }
      );
      for (const userId of memberUserIds) {
        await conn.execute(
          \`INSERT INTO crms_group_members (group_id, user_id)
           SELECT group_id, :uid FROM crms_assignment_groups WHERE group_name = :gname\`,
          { uid: userId, gname: groupName }
        );
      }
      await conn.execute(
        \`INSERT INTO crms_audit (action, performed_by, cr_number, details)
         VALUES ('Group Added', :uid, '--', :detail)\`,
        { uid: req.user.userId, detail: 'Group "' + groupName + '" added' }
      );
      await conn.commit();
    });
    return res.status(201).json({ message: 'Group ' + groupName + ' created' });
  } catch (err) { next(err); }
}

async function updateGroupMembers(req, res, next) {
  try {
    const { groupId }            = req.params;
    const { memberUserIds = [] } = req.body;
    const group = await db.queryOne(
      'SELECT group_name FROM crms_assignment_groups WHERE group_id = :gid',
      { gid: groupId }
    );
    if (!group) return res.status(404).json({ error: 'Group not found' });
    await db.transaction(async (conn) => {
      await conn.execute('DELETE FROM crms_group_members WHERE group_id = :gid', { gid: groupId });
      for (const userId of memberUserIds) {
        await conn.execute(
          'INSERT INTO crms_group_members (group_id, user_id) VALUES (:gid, :uid)',
          { gid: groupId, uid: userId }
        );
      }
      await conn.execute(
        \`INSERT INTO crms_audit (action, performed_by, cr_number, details)
         VALUES ('Group Updated', :uid, '--', :detail)\`,
        { uid: req.user.userId, detail: 'Members of "' + group.GROUP_NAME + '" updated' }
      );
      await conn.commit();
    });
    logger.info('Group members updated', { groupId, count: memberUserIds.length });
    return res.json({ message: 'Group members updated' });
  } catch (err) { next(err); }
}

// ── COMPANIES ─────────────────────────────────────────────────────────
async function getCompanies(req, res, next) {
  try {
    const rows = await db.query('SELECT company_id, company_name FROM crms_companies ORDER BY company_name');
    return res.json(rows.map(r => ({ companyId: r.COMPANY_ID, companyName: r.COMPANY_NAME })));
  } catch (err) { next(err); }
}

async function createCompany(req, res, next) {
  try {
    const { companyName } = req.body;
    if (!companyName || !companyName.trim())
      return res.status(422).json({ error: 'Company name required' });
    await db.executeWithCommit(
      'INSERT INTO crms_companies (company_name) VALUES (:cname)',
      { cname: companyName.trim() }
    );
    return res.status(201).json({ message: 'Company added' });
  } catch (err) { next(err); }
}

// ── SERVICES ──────────────────────────────────────────────────────────
async function getServices(req, res, next) {
  try {
    const rows = await db.query('SELECT service_id, service_name FROM crms_services ORDER BY service_name');
    return res.json(rows.map(r => ({ serviceId: r.SERVICE_ID, serviceName: r.SERVICE_NAME })));
  } catch (err) { next(err); }
}

async function createService(req, res, next) {
  try {
    const { serviceName } = req.body;
    if (!serviceName || !serviceName.trim())
      return res.status(422).json({ error: 'Service name required' });
    await db.executeWithCommit(
      'INSERT INTO crms_services (service_name) VALUES (:sname)',
      { sname: serviceName.trim() }
    );
    return res.status(201).json({ message: 'Service added' });
  } catch (err) { next(err); }
}

module.exports = {
  getUsers, createUser, createUserValidation, toggleUser, changePassword,
  getGroups, createGroup, createGroupValidation, updateGroupMembers,
  getCompanies, createCompany,
  getServices, createService,
};
`;

// ── Apply rewrites ────────────────────────────────────────────────────
const authPath  = path.join(__dirname, 'src/controllers/authController.js');
const adminPath = path.join(__dirname, 'src/controllers/adminController.js');

fs.writeFileSync(authPath,  newAuthController,  'utf8');
console.log('REWRITTEN src/controllers/authController.js');

fs.writeFileSync(adminPath, newAdminController, 'utf8');
console.log('REWRITTEN src/controllers/adminController.js');

// ── Fix commentController.js ──────────────────────────────────────────
patch('src/controllers/commentController.js', 'fix :name bind', [
  [
    `:name || ' commented: "' || SUBSTR(:text,1,50) || '"')`,
    `:detail)`,
  ],
  [
    `name:  req.user.fullName,\n        text,`,
    `detail: req.user.fullName + ' commented: "' + text.substring(0,50) + '"',`,
  ],
  [
    `name: req.user.fullName,\n        text,`,
    `detail: req.user.fullName + ' commented: "' + text.substring(0,50) + '"',`,
  ],
]);

console.log('\n✅  Patch complete! Restart the server:  npm run dev');
console.log('   Then test login at:  http://localhost:3000/debug-db');
