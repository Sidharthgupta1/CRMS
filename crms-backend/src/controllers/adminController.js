'use strict';

const bcrypt = require('bcryptjs');
const db     = require('../config/db');
const logger = require('../config/logger');
const { bustUsersCache } = require('./authController');

function safe(s) { return String(s||'').replace(/'/g,"''"); }
function num(n)  { return String(parseInt(n,10)||0); }

// ── GET /admin/users ──────────────────────────────────────────────────
async function getUsers(req, res, next) {
  try {
    const rows = await db.query(
      "SELECT u.user_id,u.initials,u.full_name,u.role,u.is_active,u.last_login,"+
      "LISTAGG(ag.group_name,',') WITHIN GROUP (ORDER BY ag.group_name) AS groups "+
      "FROM crms_users u "+
      "LEFT JOIN crms_group_members gm ON gm.user_id=u.user_id "+
      "LEFT JOIN crms_assignment_groups ag ON ag.group_id=gm.group_id "+
      "GROUP BY u.user_id,u.initials,u.full_name,u.role,u.is_active,u.last_login "+
      "ORDER BY u.full_name", {}
    );
    return res.json(rows.map(r => ({
      userId:   r.USER_ID,
      initials: r.INITIALS,
      fullName: r.FULL_NAME,
      role:     r.ROLE,
      isActive: r.IS_ACTIVE,
      lastLogin:r.LAST_LOGIN,
      groups:   r.GROUPS ? r.GROUPS.split(',') : [],
    })));
  } catch(err) { next(err); }
}

// ── POST /admin/users ─────────────────────────────────────────────────
const createUserValidation = [
  require('express-validator').body('fullName').trim().notEmpty().withMessage('Full name required'),
  require('express-validator').body('initials').trim().notEmpty().withMessage('Initials required'),
  require('express-validator').body('role').isIn(['admin','user']).withMessage('Role must be admin or user'),
  require('express-validator').body('password').notEmpty().withMessage('Password required'),
  require('../middleware/validate').validate,
];

async function createUser(req, res, next) {
  try {
    const { fullName, initials, role, password } = req.body;
    const hash       = await bcrypt.hash(password, 12);
    const upperInit  = safe(initials.toUpperCase());
    const safeName   = safe(fullName);
    const safeRole   = safe(role||'user');

    // Check duplicate
    const existing = await db.queryOne(
      "SELECT user_id FROM crms_users WHERE initials='"+upperInit+"'", {}
    );
    if (existing) return res.status(409).json({ error:"User with initials '"+upperInit+"' already exists" });

    await db.executeWithCommit(
      "INSERT INTO crms_users(initials,full_name,role,password_hash) VALUES("+
      "'"+upperInit+"','"+safeName+"','"+safeRole+"','"+safe(hash)+"')", {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES("+
      "'User Added',"+num(req.user.userId)+",'--','"+safe(req.user.fullName)+" added user "+safeName+"')", {}
    );

    bustUsersCache();
    logger.info('User created', { initials:upperInit, role, by:req.user.userId });
    return res.status(201).json({ message:'User '+fullName+' created' });
  } catch(err) { next(err); }
}

// ── PATCH /admin/users/:userId/toggle ────────────────────────────────
async function toggleUser(req, res, next) {
  try {
    const uid = num(req.params.userId);
    const result = await db.executeWithCommit(
      "UPDATE crms_users SET is_active=1-is_active WHERE user_id="+uid, {}
    );
    if (result.rowsAffected===0) return res.status(404).json({ error:'User not found' });
    bustUsersCache();
    return res.json({ message:'User status updated' });
  } catch(err) { next(err); }
}

// ── PATCH /admin/users/:userId/password ──────────────────────────────
async function changePassword(req, res, next) {
  try {
    const uid  = num(req.params.userId);
    const { password } = req.body;
    if (!password) return res.status(422).json({ error:'Password required' });
    const hash = await bcrypt.hash(password, 12);
    await db.executeWithCommit(
      "UPDATE crms_users SET password_hash='"+safe(hash)+"' WHERE user_id="+uid, {}
    );
    return res.json({ message:'Password updated' });
  } catch(err) { next(err); }
}

// ── GET /admin/groups ─────────────────────────────────────────────────
async function getGroups(req, res, next) {
  try {
    const groups = await db.query(
      "SELECT g.group_id,g.group_name,g.description,"+
      "LISTAGG(u.user_id||':'||u.full_name,',') WITHIN GROUP (ORDER BY u.full_name) AS members "+
      "FROM crms_assignment_groups g "+
      "LEFT JOIN crms_group_members gm ON gm.group_id=g.group_id "+
      "LEFT JOIN crms_users u ON u.user_id=gm.user_id AND u.is_active=1 "+
      "GROUP BY g.group_id,g.group_name,g.description ORDER BY g.group_name", {}
    );
    return res.json(groups.map(g => ({
      groupId:     g.GROUP_ID,
      groupName:   g.GROUP_NAME,
      description: g.DESCRIPTION,
      members: g.MEMBERS ? g.MEMBERS.split(',').filter(Boolean).map(m => {
        const [id,name] = m.split(':');
        return { userId:Number(id), fullName:name };
      }) : [],
    })));
  } catch(err) { next(err); }
}

const createGroupValidation = [
  require('express-validator').body('groupName').trim().notEmpty().withMessage('Group name required'),
  require('../middleware/validate').validate,
];

// ── POST /admin/groups ────────────────────────────────────────────────
async function createGroup(req, res, next) {
  try {
    const { groupName, description } = req.body;
    if (!groupName) return res.status(422).json({ error:'Group name required' });
    await db.executeWithCommit(
      "INSERT INTO crms_assignment_groups(group_name,description) VALUES("+
      "'"+safe(groupName)+"','"+safe(description||'')+"')", {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES("+
      "'Group Added',"+num(req.user.userId)+",'--','Group \""+safe(groupName)+"\" added')", {}
    );
    logger.info('Group created', { groupName });
    return res.status(201).json({ message:'Group created' });
  } catch(err) { next(err); }
}

// ── PUT /admin/groups/:groupId/members ────────────────────────────────
async function updateGroupMembers(req, res, next) {
  try {
    const gid = num(req.params.groupId);
    const { userIds } = req.body;
    if (!Array.isArray(userIds)) return res.status(422).json({ error:'userIds array required' });

    const grp = await db.queryOne(
      "SELECT group_name FROM crms_assignment_groups WHERE group_id="+gid, {}
    );
    if (!grp) return res.status(404).json({ error:'Group not found' });

    await db.executeWithCommit("DELETE FROM crms_group_members WHERE group_id="+gid, {});
    for (const uid of userIds) {
      await db.executeWithCommit(
        "INSERT INTO crms_group_members(group_id,user_id) VALUES("+gid+","+num(uid)+")", {}
      );
    }
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES("+
      "'Group Updated',"+num(req.user.userId)+",'--','Members of \""+safe(grp.GROUP_NAME)+"\" updated')", {}
    );
    return res.json({ message:'Group members updated' });
  } catch(err) { next(err); }
}

// ── GET /admin/companies ──────────────────────────────────────────────
async function getCompanies(req, res, next) {
  try {
    const rows = await db.query(
      "SELECT company_id,company_name FROM crms_companies ORDER BY company_name", {}
    );
    return res.json(rows.map(r => ({ companyId:r.COMPANY_ID, companyName:r.COMPANY_NAME })));
  } catch(err) { next(err); }
}

// ── POST /admin/companies ─────────────────────────────────────────────
async function createCompany(req, res, next) {
  try {
    const { companyName } = req.body;
    if (!companyName) return res.status(422).json({ error:'Company name required' });
    await db.executeWithCommit(
      "INSERT INTO crms_companies(company_name) VALUES('"+safe(companyName)+"')", {}
    );
    return res.status(201).json({ message:'Company created' });
  } catch(err) { next(err); }
}

// ── GET /admin/services ───────────────────────────────────────────────
async function getServices(req, res, next) {
  try {
    const rows = await db.query(
      "SELECT service_id,service_name FROM crms_services ORDER BY service_name", {}
    );
    return res.json(rows.map(r => ({ serviceId:r.SERVICE_ID, serviceName:r.SERVICE_NAME })));
  } catch(err) { next(err); }
}

// ── POST /admin/services ──────────────────────────────────────────────
async function createService(req, res, next) {
  try {
    const { serviceName } = req.body;
    if (!serviceName) return res.status(422).json({ error:'Service name required' });
    await db.executeWithCommit(
      "INSERT INTO crms_services(service_name) VALUES('"+safe(serviceName)+"')", {}
    );
    return res.status(201).json({ message:'Service created' });
  } catch(err) { next(err); }
}

// ── GET /ref/* — public reference data ───────────────────────────────
async function getRefUsers(req, res, next) {
  try {
    const rows = await db.query(
      "SELECT user_id,full_name,initials FROM crms_users WHERE is_active=1 ORDER BY full_name", {}
    );
    return res.json(rows.map(r => ({ userId:r.USER_ID, fullName:r.FULL_NAME, initials:r.INITIALS })));
  } catch(err) { next(err); }
}

module.exports = {
  createGroupValidation,
  getUsers, createUser, createUserValidation, toggleUser, changePassword,
  getGroups, createGroup, updateGroupMembers,
  getCompanies, createCompany,
  getServices, createService,
  getRefUsers,
};
