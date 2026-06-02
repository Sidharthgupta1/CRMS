'use strict';
/**
 * CRMS Module & Approval Flow Patch
 * Run from inside crms-backend folder:  node fix_modules.js
 *
 * Adds:
 *  1. src/controllers/moduleController.js  — module CRUD + approval flow management
 *  2. src/controllers/approvalController.js — RD submission, approve, reject
 *  3. src/routes/modules.js
 *  4. src/routes/approvals.js
 *  5. Patches src/routes/index.js to register new routes
 *  6. Patches src/controllers/releaseController.js — auto-detect module on create
 *                                                  — RD Phase in lifecycle
 */

const fs   = require('fs');
const path = require('path');

// ════════════════════════════════════════════════════════════════════
// 1. moduleController.js
// ════════════════════════════════════════════════════════════════════
const moduleController = `'use strict';

const db     = require('../config/db');
const logger = require('../config/logger');

function safe(s) { return String(s||'').replace(/'/g,"''"); }
function num(n)  { return String(parseInt(n,10)||0); }

// ── GET /modules — all modules with groups, users, flow ──────────────
async function getAll(req, res, next) {
  try {
    const modules = await db.query(
      'SELECT module_id, module_name, description, is_active FROM crms_modules ORDER BY module_name', {}
    );

    const result = [];
    for (const mod of modules) {
      const mid = mod.MODULE_ID;

      // Groups
      const groups = await db.query(
        'SELECT ag.group_id, ag.group_name FROM crms_module_groups mg ' +
        'JOIN crms_assignment_groups ag ON ag.group_id = mg.group_id ' +
        'WHERE mg.module_id = ' + mid + ' ORDER BY ag.group_name', {}
      );

      // Users
      const users = await db.query(
        'SELECT u.user_id, u.full_name, u.initials, mu.is_requester, mu.is_approver ' +
        'FROM crms_module_users mu JOIN crms_users u ON u.user_id = mu.user_id ' +
        'WHERE mu.module_id = ' + mid + ' ORDER BY u.full_name', {}
      );

      // Approval flow
      const flow = await db.query(
        'SELECT af.flow_id, af.level_order, af.auto_approve, u.user_id, u.full_name ' +
        'FROM crms_approval_flows af JOIN crms_users u ON u.user_id = af.approver_user_id ' +
        'WHERE af.module_id = ' + mid + ' ORDER BY af.level_order', {}
      );

      result.push({
        moduleId:    mid,
        moduleName:  mod.MODULE_NAME,
        description: mod.DESCRIPTION,
        isActive:    !!mod.IS_ACTIVE,
        groups:      groups.map(g => ({ groupId: g.GROUP_ID, groupName: g.GROUP_NAME })),
        users:       users.map(u => ({
          userId:      u.USER_ID,
          fullName:    u.FULL_NAME,
          initials:    u.INITIALS,
          isRequester: !!u.IS_REQUESTER,
          isApprover:  !!u.IS_APPROVER,
        })),
        approvalFlow: flow.map(f => ({
          flowId:      f.FLOW_ID,
          levelOrder:  Number(f.LEVEL_ORDER),
          autoApprove: !!f.AUTO_APPROVE,
          userId:      f.USER_ID,
          fullName:    f.FULL_NAME,
        })),
      });
    }
    return res.json(result);
  } catch(err) { next(err); }
}

// ── POST /modules — create module ────────────────────────────────────
async function createModule(req, res, next) {
  try {
    const { moduleName, description } = req.body;
    if (!moduleName || !moduleName.trim())
      return res.status(422).json({ error: 'Module name required' });
    await db.executeWithCommit(
      "INSERT INTO crms_modules (module_name, description) VALUES ('" +
      safe(moduleName.trim()) + "', " +
      (description ? "'" + safe(description) + "'" : 'NULL') + ")", {}
    );
    logger.info('Module created', { moduleName, by: req.user.userId });
    return res.status(201).json({ message: 'Module created' });
  } catch(err) { next(err); }
}

// ── PUT /modules/:moduleId/groups — set groups for module ────────────
async function updateModuleGroups(req, res, next) {
  try {
    const mid       = num(req.params.moduleId);
    const { groupIds = [] } = req.body;
    await db.executeWithCommit('DELETE FROM crms_module_groups WHERE module_id = ' + mid, {});
    for (const gid of groupIds) {
      await db.executeWithCommit(
        'INSERT INTO crms_module_groups (module_id, group_id) VALUES (' + mid + ', ' + num(gid) + ')', {}
      );
    }
    return res.json({ message: 'Module groups updated' });
  } catch(err) { next(err); }
}

// ── PUT /modules/:moduleId/users — set business users for module ──────
async function updateModuleUsers(req, res, next) {
  try {
    const mid       = num(req.params.moduleId);
    const { users = [] } = req.body;
    // users = [{ userId, isRequester, isApprover }]
    await db.executeWithCommit('DELETE FROM crms_module_users WHERE module_id = ' + mid, {});
    for (const u of users) {
      const uid = num(u.userId);
      const req_ = u.isRequester ? 1 : 0;
      const app  = u.isApprover  ? 1 : 0;
      await db.executeWithCommit(
        'INSERT INTO crms_module_users (module_id, user_id, is_requester, is_approver) VALUES (' +
        mid + ', ' + uid + ', ' + req_ + ', ' + app + ')', {}
      );
    }
    return res.json({ message: 'Module users updated' });
  } catch(err) { next(err); }
}

// ── PUT /modules/:moduleId/flow — set approval flow ──────────────────
// flow = [{ levelOrder, approverUserId, autoApprove }]
async function updateApprovalFlow(req, res, next) {
  try {
    const mid         = num(req.params.moduleId);
    const { levels = [] } = req.body;
    await db.executeWithCommit('DELETE FROM crms_approval_flows WHERE module_id = ' + mid, {});
    for (const lvl of levels) {
      const order  = num(lvl.levelOrder);
      const uid    = num(lvl.approverUserId);
      const auto_  = lvl.autoApprove ? 1 : 0;
      await db.executeWithCommit(
        'INSERT INTO crms_approval_flows (module_id, level_order, approver_user_id, auto_approve) VALUES (' +
        mid + ', ' + order + ', ' + uid + ', ' + auto_ + ')', {}
      );
    }
    logger.info('Approval flow updated', { moduleId: mid, levels: levels.length });
    return res.json({ message: 'Approval flow updated' });
  } catch(err) { next(err); }
}

// ── GET /modules/my — get the module the logged-in user belongs to ───
async function myModule(req, res, next) {
  try {
    const uid = num(req.user.userId);
    const mod = await db.queryOne(
      'SELECT m.module_id, m.module_name, mu.is_requester, mu.is_approver ' +
      'FROM crms_module_users mu JOIN crms_modules m ON m.module_id = mu.module_id ' +
      'WHERE mu.user_id = ' + uid + ' AND m.is_active = 1 ' +
      'ORDER BY mu.module_user_id FETCH FIRST 1 ROWS ONLY', {}
    );
    if (!mod) return res.json({ moduleId: null, moduleName: null });

    // Get flow for this module
    const flow = await db.query(
      'SELECT af.level_order, af.auto_approve, af.approver_user_id, u.full_name ' +
      'FROM crms_approval_flows af JOIN crms_users u ON u.user_id = af.approver_user_id ' +
      'WHERE af.module_id = ' + num(mod.MODULE_ID) + ' ORDER BY af.level_order', {}
    );

    return res.json({
      moduleId:     mod.MODULE_ID,
      moduleName:   mod.MODULE_NAME,
      isRequester:  !!mod.IS_REQUESTER,
      isApprover:   !!mod.IS_APPROVER,
      approvalFlow: flow.map(f => ({
        levelOrder:       Number(f.LEVEL_ORDER),
        autoApprove:      !!f.AUTO_APPROVE,
        approverUserId:   f.APPROVER_USER_ID,
        approverFullName: f.FULL_NAME,
      })),
    });
  } catch(err) { next(err); }
}

module.exports = { getAll, createModule, updateModuleGroups, updateModuleUsers, updateApprovalFlow, myModule };
`;

fs.writeFileSync(path.join(__dirname, 'src/controllers/moduleController.js'), moduleController, 'utf8');
console.log('✅  Created moduleController.js');

// ════════════════════════════════════════════════════════════════════
// 2. approvalController.js
// ════════════════════════════════════════════════════════════════════
const approvalController = `'use strict';

const db     = require('../config/db');
const logger = require('../config/logger');

function safe(s) { return String(s||'').replace(/'/g,"''"); }
function num(n)  { return String(parseInt(n,10)||0); }

// ── POST /releases/:releaseId/submit-rd
// Creator submits RD for approval — triggers approval flow
async function submitRD(req, res, next) {
  try {
    const rid    = num(req.params.releaseId);
    const uid    = num(req.user.userId);

    const release = await db.queryOne(
      "SELECT release_id, release_number, state, module_id FROM crms_releases " +
      "WHERE release_id = " + rid + " AND is_deleted = 0", {}
    );
    if (!release) return res.status(404).json({ error: 'Release not found' });
    if (release.STATE !== 'RD Phase')
      return res.status(400).json({ error: 'Release must be in RD Phase to submit for approval' });
    if (!release.MODULE_ID)
      return res.status(400).json({ error: 'Release has no module assigned. Contact admin.' });

    const mid = num(release.MODULE_ID);
    const relNum = release.RELEASE_NUMBER;

    // Get approval flow for this module
    const flow = await db.query(
      'SELECT flow_id, level_order, approver_user_id, auto_approve ' +
      'FROM crms_approval_flows WHERE module_id = ' + mid + ' ORDER BY level_order', {}
    );

    if (flow.length === 0)
      return res.status(400).json({ error: 'No approval flow configured for this module. Contact admin.' });

    // Check if auto-approve (1 level, auto_approve = 1)
    const isAutoApprove = flow.length === 1 && !!flow[0].AUTO_APPROVE;

    if (isAutoApprove) {
      // Skip approval entirely — go straight to FSD Phase
      await db.executeWithCommit(
        "UPDATE crms_releases SET state = 'FSD Phase', updated_at = SYSDATE WHERE release_id = " + rid, {}
      );
      await db.executeWithCommit(
        "INSERT INTO crms_release_history(release_id,action,from_state,to_state,changed_by) " +
        "VALUES(" + rid + ",'State Change','RD Phase','FSD Phase'," + uid + ")", {}
      );
      await db.executeWithCommit(
        "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES(" +
        "'State Change'," + uid + ",'" + relNum + "','RD Phase -> FSD Phase (auto-approved)')", {}
      );
      logger.info('RD auto-approved', { releaseId: rid, relNum });
      return res.json({ message: 'Auto-approved. Release moved to FSD Phase.', newState: 'FSD Phase' });
    }

    // Multi-level: create approval records and move to Awaiting Approval L1
    // Clear any old pending approvals
    await db.executeWithCommit(
      "DELETE FROM crms_release_approvals WHERE release_id = " + rid + " AND status = 'Pending'", {}
    );

    // Insert approval records for all levels
    for (const lvl of flow) {
      const lvlNum = num(lvl.LEVEL_ORDER);
      const aprUid = num(lvl.APPROVER_USER_ID);
      await db.executeWithCommit(
        "INSERT INTO crms_release_approvals(release_id,module_id,level_order,approver_user_id,status) " +
        "VALUES(" + rid + "," + mid + "," + lvlNum + "," + aprUid + ",'Pending')", {}
      );
    }

    const firstLevel = Number(flow[0].LEVEL_ORDER);
    const firstApproverUid = num(flow[0].APPROVER_USER_ID);
    const newState = 'Awaiting Approval L' + firstLevel;

    // Update release state and current_approval_level
    await db.executeWithCommit(
      "UPDATE crms_releases SET state = '" + safe(newState) + "', " +
      "current_approval_level = " + firstLevel + ", updated_at = SYSDATE " +
      "WHERE release_id = " + rid, {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_release_history(release_id,action,from_state,to_state,changed_by) " +
      "VALUES(" + rid + ",'State Change','RD Phase','" + safe(newState) + "'," + uid + ")", {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES(" +
      "'State Change'," + uid + ",'" + relNum + "','RD Phase -> " + safe(newState) + "')", {}
    );

    // Notify L1 approver
    await db.executeWithCommit(
      "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES(" +
      firstApproverUid + ",'Approval Required','" +
      safe(relNum + " requires your approval (Level " + firstLevel + ")") + "'," + rid + ")", {}
    );

    logger.info('RD submitted for approval', { releaseId: rid, firstLevel, firstApproverUid });
    return res.json({ message: 'Submitted for approval.', newState });
  } catch(err) { next(err); }
}

// ── POST /releases/:releaseId/approve — approver approves current level
async function approve(req, res, next) {
  try {
    const rid      = num(req.params.releaseId);
    const uid      = num(req.user.userId);
    const comments = (req.body.comments || '').trim();

    const release = await db.queryOne(
      "SELECT release_id, release_number, state, module_id, current_approval_level " +
      "FROM crms_releases WHERE release_id = " + rid + " AND is_deleted = 0", {}
    );
    if (!release) return res.status(404).json({ error: 'Release not found' });

    const curLevel = Number(release.CURRENT_APPROVAL_LEVEL);
    const mid      = num(release.MODULE_ID);
    const relNum   = release.RELEASE_NUMBER;

    // Verify this user is the approver for the current level
    const myApproval = await db.queryOne(
      "SELECT approval_id FROM crms_release_approvals " +
      "WHERE release_id = " + rid + " AND level_order = " + curLevel +
      " AND approver_user_id = " + uid + " AND status = 'Pending'", {}
    );
    if (!myApproval)
      return res.status(403).json({ error: 'You are not the approver for this level, or it has already been actioned.' });

    // Mark this level as approved
    await db.executeWithCommit(
      "UPDATE crms_release_approvals SET status = 'Approved', " +
      "comments = '" + safe(comments) + "', actioned_at = SYSDATE " +
      "WHERE approval_id = " + num(myApproval.APPROVAL_ID), {}
    );

    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES(" +
      "'Approval'," + uid + ",'" + relNum + "','Level " + curLevel + " approved by " +
      safe(req.user.fullName) + "')", {}
    );

    // Check if there is a next level
    const nextLevelRow = await db.queryOne(
      "SELECT level_order, approver_user_id FROM crms_approval_flows " +
      "WHERE module_id = " + mid + " AND level_order = " + (curLevel + 1), {}
    );

    let newState, message;
    if (nextLevelRow) {
      // Move to next approval level
      const nextLevel    = Number(nextLevelRow.LEVEL_ORDER);
      const nextApprUid  = num(nextLevelRow.APPROVER_USER_ID);
      newState = 'Awaiting Approval L' + nextLevel;

      await db.executeWithCommit(
        "UPDATE crms_releases SET state = '" + safe(newState) + "', " +
        "current_approval_level = " + nextLevel + ", updated_at = SYSDATE " +
        "WHERE release_id = " + rid, {}
      );
      await db.executeWithCommit(
        "INSERT INTO crms_release_history(release_id,action,from_state,to_state,changed_by) " +
        "VALUES(" + rid + ",'State Change','" + safe(release.STATE) + "','" + safe(newState) + "'," + uid + ")", {}
      );

      // Notify next approver
      await db.executeWithCommit(
        "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES(" +
        nextApprUid + ",'Approval Required','" +
        safe(relNum + " requires your approval (Level " + nextLevel + ")") + "'," + rid + ")", {}
      );

      message = 'Approved. Sent to Level ' + nextLevel + ' approver.';
    } else {
      // All levels approved — move to FSD Phase
      newState = 'FSD Phase';
      await db.executeWithCommit(
        "UPDATE crms_releases SET state = 'FSD Phase', current_approval_level = 0, " +
        "updated_at = SYSDATE WHERE release_id = " + rid, {}
      );
      await db.executeWithCommit(
        "INSERT INTO crms_release_history(release_id,action,from_state,to_state,changed_by) " +
        "VALUES(" + rid + ",'State Change','" + safe(release.STATE) + "','FSD Phase'," + uid + ")", {}
      );
      await db.executeWithCommit(
        "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES(" +
        "'State Change'," + uid + ",'" + relNum + "','All approvals complete -> FSD Phase')", {}
      );

      // Notify release requester
      await db.executeWithCommit(
        "INSERT INTO crms_notifications(user_id,title,message,release_id) " +
        "SELECT requested_by,'RD Approved','" +
        safe(relNum + " fully approved and moved to FSD Phase") + "'," + rid + " FROM crms_releases " +
        "WHERE release_id = " + rid, {}
      );

      message = 'All levels approved. Release moved to FSD Phase.';
    }

    logger.info('Approval recorded', { releaseId: rid, level: curLevel, newState });
    return res.json({ message, newState, approvedLevel: curLevel });
  } catch(err) { next(err); }
}

// ── POST /releases/:releaseId/reject — approver rejects
async function reject(req, res, next) {
  try {
    const rid      = num(req.params.releaseId);
    const uid      = num(req.user.userId);
    const comments = (req.body.comments || '').trim();
    if (!comments)
      return res.status(422).json({ error: 'Rejection reason (comments) is required.' });

    const release = await db.queryOne(
      "SELECT release_id, release_number, state, current_approval_level, requested_by " +
      "FROM crms_releases WHERE release_id = " + rid + " AND is_deleted = 0", {}
    );
    if (!release) return res.status(404).json({ error: 'Release not found' });

    const curLevel = Number(release.CURRENT_APPROVAL_LEVEL);
    const relNum   = release.RELEASE_NUMBER;

    // Verify this user is the approver
    const myApproval = await db.queryOne(
      "SELECT approval_id FROM crms_release_approvals " +
      "WHERE release_id = " + rid + " AND level_order = " + curLevel +
      " AND approver_user_id = " + uid + " AND status = 'Pending'", {}
    );
    if (!myApproval)
      return res.status(403).json({ error: 'You are not the approver for this level, or it has already been actioned.' });

    // Mark ALL pending approvals as rejected for this release
    await db.executeWithCommit(
      "UPDATE crms_release_approvals SET status = 'Rejected', " +
      "comments = '" + safe(comments) + "', actioned_at = SYSDATE " +
      "WHERE release_id = " + rid + " AND status = 'Pending'", {}
    );

    // Return to RD Phase
    await db.executeWithCommit(
      "UPDATE crms_releases SET state = 'RD Phase', current_approval_level = 0, " +
      "updated_at = SYSDATE WHERE release_id = " + rid, {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_release_history(release_id,action,from_state,to_state,changed_by) " +
      "VALUES(" + rid + ",'State Change','" + safe(release.STATE) + "','RD Phase'," + uid + ")", {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES(" +
      "'Rejection'," + uid + ",'" + relNum + "','Level " + curLevel + " rejected: " +
      safe(comments.substring(0, 80)) + "')", {}
    );

    // Auto-post rejection comment
    await db.executeWithCommit(
      "INSERT INTO crms_comments(release_id, comment_text, created_by) VALUES(" +
      rid + ", 'REJECTED (Level " + curLevel + "): " + safe(comments) + "', " + uid + ")", {}
    );

    // Notify requester
    const reqUserId = num(release.REQUESTED_BY);
    await db.executeWithCommit(
      "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES(" +
      reqUserId + ",'RD Rejected','" +
      safe(relNum + " was rejected at Level " + curLevel + ": " + comments.substring(0, 100)) +
      "'," + rid + ")", {}
    );

    logger.info('Approval rejected', { releaseId: rid, level: curLevel, by: uid });
    return res.json({ message: 'Rejected. Release returned to RD Phase.', newState: 'RD Phase' });
  } catch(err) { next(err); }
}

// ── GET /approvals/pending — get releases awaiting MY approval ────────
async function myPendingApprovals(req, res, next) {
  try {
    const uid  = num(req.user.userId);
    const rows = await db.query(
      'SELECT ra.approval_id, ra.release_id, ra.level_order, ra.status, ra.created_at, ' +
      'r.release_number, r.title, r.state, r.module_id, m.module_name, ' +
      'u.full_name AS requested_by ' +
      'FROM crms_release_approvals ra ' +
      'JOIN crms_releases r ON r.release_id = ra.release_id ' +
      'JOIN crms_modules m  ON m.module_id  = r.module_id ' +
      'JOIN crms_users u    ON u.user_id    = r.requested_by ' +
      "WHERE ra.approver_user_id = " + uid + " AND ra.status = 'Pending' " +
      'AND r.is_deleted = 0 ORDER BY ra.created_at ASC', {}
    );
    return res.json(rows.map(r => ({
      approvalId:    r.APPROVAL_ID,
      releaseId:     r.RELEASE_ID,
      releaseNumber: r.RELEASE_NUMBER,
      title:         r.TITLE,
      state:         r.STATE,
      levelOrder:    Number(r.LEVEL_ORDER),
      moduleName:    r.MODULE_NAME,
      requestedBy:   r.REQUESTED_BY,
      createdAt:     r.CREATED_AT,
    })));
  } catch(err) { next(err); }
}

module.exports = { submitRD, approve, reject, myPendingApprovals };
`;

fs.writeFileSync(path.join(__dirname, 'src/controllers/approvalController.js'), approvalController, 'utf8');
console.log('✅  Created approvalController.js');

// ════════════════════════════════════════════════════════════════════
// 3. Routes
// ════════════════════════════════════════════════════════════════════
const modulesRoute = `'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/moduleController');
const { requireAdmin } = require('../middleware/auth');

router.get('/',                          ctrl.getAll);
router.get('/my',                        ctrl.myModule);
router.post('/',          requireAdmin,  ctrl.createModule);
router.put('/:moduleId/groups', requireAdmin, ctrl.updateModuleGroups);
router.put('/:moduleId/users',  requireAdmin, ctrl.updateModuleUsers);
router.put('/:moduleId/flow',   requireAdmin, ctrl.updateApprovalFlow);

module.exports = router;
`;
fs.writeFileSync(path.join(__dirname, 'src/routes/modules.js'), modulesRoute, 'utf8');
console.log('✅  Created routes/modules.js');

const approvalsRoute = `'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/approvalController');

router.get('/pending', ctrl.myPendingApprovals);

module.exports = router;
`;
fs.writeFileSync(path.join(__dirname, 'src/routes/approvals.js'), approvalsRoute, 'utf8');
console.log('✅  Created routes/approvals.js');

// ════════════════════════════════════════════════════════════════════
// 4. Patch releases.js to add submit-rd, approve, reject routes
// ════════════════════════════════════════════════════════════════════
const releasesRoutePath = path.join(__dirname, 'src/routes/releases.js');
let releasesRoute = fs.readFileSync(releasesRoutePath, 'utf8');
if (!releasesRoute.includes('submit-rd')) {
  releasesRoute = releasesRoute.replace(
    "const { requireAdmin } = require('../middleware/auth');",
    "const { requireAdmin } = require('../middleware/auth');\nconst apprCtrl = require('../controllers/approvalController');"
  );
  releasesRoute = releasesRoute.replace(
    "module.exports = router;",
    `router.post('/:releaseId/submit-rd', apprCtrl.submitRD);
router.post('/:releaseId/approve',    apprCtrl.approve);
router.post('/:releaseId/reject',     apprCtrl.reject);

module.exports = router;`
  );
  fs.writeFileSync(releasesRoutePath, releasesRoute, 'utf8');
  console.log('✅  Patched routes/releases.js (submit-rd, approve, reject)');
} else {
  console.log('OK    routes/releases.js already has approval routes');
}

// ════════════════════════════════════════════════════════════════════
// 5. Patch routes/index.js to add /modules and /approvals
// ════════════════════════════════════════════════════════════════════
const indexRoutePath = path.join(__dirname, 'src/routes/index.js');
let indexRoute = fs.readFileSync(indexRoutePath, 'utf8');
if (!indexRoute.includes('/modules')) {
  indexRoute = indexRoute.replace(
    "router.use('/admin',",
    "router.use('/modules',   require('./modules'));\nrouter.use('/approvals', require('./approvals'));\n\nrouter.use('/admin',"
  );
  fs.writeFileSync(indexRoutePath, indexRoute, 'utf8');
  console.log('✅  Patched routes/index.js (/modules, /approvals)');
} else {
  console.log('OK    routes/index.js already has module routes');
}

// ════════════════════════════════════════════════════════════════════
// 6. Patch releaseController — add module auto-detect + RD Phase flow
// ════════════════════════════════════════════════════════════════════
const relCtrlPath = path.join(__dirname, 'src/controllers/releaseController.js');
let relCtrl = fs.readFileSync(relCtrlPath, 'utf8');

// Update NEXT_STATE to include RD Phase (BRD Phase removed, RD Phase added)
// The approval levels (L1, L2...) are handled by approvalController
// After all approvals → FSD Phase (handled by approvalController)
// We keep FSD → Dev → Testing → UAT → Deployment → Closed
if (!relCtrl.includes("'Draft':'RD Phase'")) {
  relCtrl = relCtrl.replace(
    "'Draft':'BRD Phase'",
    "'Draft':'RD Phase'"
  );
  // Remove BRD->FSD, FSD Phase now comes after approvals
  // Keep rest of the chain from FSD onwards
  fs.writeFileSync(relCtrlPath, relCtrl, 'utf8');
  console.log('✅  Patched releaseController.js (Draft -> RD Phase)');
} else {
  console.log('OK    releaseController.js already has RD Phase');
}

// Patch create() to auto-detect module_id from user's module membership
let relCtrlUpdated = fs.readFileSync(relCtrlPath, 'utf8');
if (!relCtrlUpdated.includes('crms_module_users')) {
  relCtrlUpdated = relCtrlUpdated.replace(
    `    // Sequence
    const seqRow = await db.queryOne('SELECT crms_release_seq.NEXTVAL AS seq FROM dual', {});`,
    `    // Auto-detect module from user membership
    const modRow = await db.queryOne(
      'SELECT mu.module_id FROM crms_module_users mu ' +
      'JOIN crms_modules m ON m.module_id = mu.module_id ' +
      'WHERE mu.user_id = ' + reqBy + ' AND m.is_active = 1 ' +
      'ORDER BY mu.module_user_id FETCH FIRST 1 ROWS ONLY', {}
    );
    const moduleId = modRow ? num(modRow.MODULE_ID) : null;

    // Sequence
    const seqRow = await db.queryOne('SELECT crms_release_seq.NEXTVAL AS seq FROM dual', {});`
  );

  // Add module_id to INSERT
  relCtrlUpdated = relCtrlUpdated.replace(
    '"INSERT INTO crms_releases " +\n' +
    '      "(release_number,state,requested_by,priority,title,summary,company,service," +\n' +
    '      "planned_start_date,target_end_date,assignment_group_id,assigned_to_user_id) VALUES (" +',
    '"INSERT INTO crms_releases " +\n' +
    '      "(release_number,state,requested_by,priority,title,summary,company,service," +\n' +
    '      "planned_start_date,target_end_date,assignment_group_id,assigned_to_user_id,module_id) VALUES (" +'
  );

  relCtrlUpdated = relCtrlUpdated.replace(
    '"TO_DATE(\'" + plannedStartDate + "\',\'YYYY-MM-DD\')," + endVal + "," + agVal + "," + atVal + ")"',
    '"TO_DATE(\'" + plannedStartDate + "\',\'YYYY-MM-DD\')," + endVal + "," + agVal + "," + atVal + "," + (moduleId || "NULL") + ")"'
  );

  fs.writeFileSync(relCtrlPath, relCtrlUpdated, 'utf8');
  console.log('✅  Patched releaseController.js (auto module_id on create)');
} else {
  console.log('OK    releaseController.js already has module auto-detect');
}

// Patch getAll() to filter by module
let relCtrlFinal = fs.readFileSync(relCtrlPath, 'utf8');
if (!relCtrlFinal.includes('module_id filter') && !relCtrlFinal.includes('req.query.moduleId')) {
  relCtrlFinal = relCtrlFinal.replace(
    "if (req.query.state)           w.push(\"r.state='\" + safe(req.query.state) + \"'\");",
    `if (req.query.moduleId)        w.push('r.module_id=' + num(req.query.moduleId)); // module_id filter
    if (req.query.state)           w.push("r.state='" + safe(req.query.state) + "'");`
  );
  fs.writeFileSync(relCtrlPath, relCtrlFinal, 'utf8');
  console.log('✅  Patched releaseController.js (moduleId filter in getAll)');
}

console.log(`
════════════════════════════════════════════════════
  Backend patch complete!

  STEPS:
  1. Run crms_modules_ddl.sql in SQL Developer
  2. Restart server:  npm run dev
  3. Download updated cr-management-system-v6.html
════════════════════════════════════════════════════
`);
