'use strict';
/**
 * CRMS Release Fix — run from inside crms-backend folder:
 *   node fix_release.js
 *
 * Fixes:
 *  1. Internal server error on Create Release (sequence + bind issues)
 *  2. Data not showing in tables (column name mapping)
 *  3. Adds /releases/next-number endpoint so frontend shows RLSE number
 */

const fs   = require('fs');
const path = require('path');

// ════════════════════════════════════════════════════════════════════
// 1. REWRITE releaseController.js — complete clean version
// ════════════════════════════════════════════════════════════════════
const releaseController = `'use strict';

const { body }  = require('express-validator');
const db        = require('../config/db');
const logger    = require('../config/logger');
const { validate }                           = require('../middleware/validate');
const { parsePagination, paginatedResponse } = require('../utils/pagination');

const TERMINAL_STATES = ['Closed','Cancelled'];
const NEXT_STATE = {
  'Draft':'BRD Phase','BRD Phase':'FSD Phase','FSD Phase':'Awaiting approval',
  'Awaiting approval':'Development Phase','On Hold':'Development Phase',
  'Development Phase':'Testing/QA','Testing/QA':'UAT','UAT':'Deployment','Deployment':'Closed',
};

// ── GET /releases/next-number ─────────────────────────────────────────
// Returns the next RLSE number WITHOUT consuming the sequence
async function nextNumber(req, res, next) {
  try {
    const row = await db.queryOne(
      'SELECT crms_release_seq.CURRVAL AS seq FROM dual', {}
    ).catch(() => null);
    // CURRVAL only works after NEXTVAL in same session; use a peek approach
    const peekRow = await db.queryOne(
      \`SELECT last_number AS seq
         FROM user_sequences
        WHERE sequence_name = 'CRMS_RELEASE_SEQ'\`, {}
    );
    const nextSeq = Number(peekRow.SEQ);
    const num = 'RLSE' + String(nextSeq).padStart(7, '0');
    return res.json({ releaseNumber: num, sequence: nextSeq });
  } catch (err) { next(err); }
}

// ── GET /releases ─────────────────────────────────────────────────────
async function getAll(req, res, next) {
  try {
    const { page, limit } = parsePagination(req.query);
    const offset    = (page - 1) * limit;
    const isAdmin   = req.user.role === 'admin';

    // Build WHERE conditions using string literals for safety
    const conditions = ['r.is_deleted = 0'];

    if (!isAdmin) {
      conditions.push(
        '(r.requested_by = ' + Number(req.user.userId) +
        ' OR r.assignment_group_id IN (' +
        '  SELECT gm2.group_id FROM crms_group_members gm2' +
        '  WHERE gm2.user_id = ' + Number(req.user.userId) + '))'
      );
    }
    if (req.query.state) {
      conditions.push("r.state = '" + req.query.state.replace(/'/g,"''") + "'");
    }
    if (req.query.priority) {
      const p = req.query.priority.replace(/[^1-4]/g,'');
      if (p) conditions.push("r.priority = '" + p + "'");
    }
    if (req.query.assignmentGroup) {
      conditions.push("ag.group_name = '" + req.query.assignmentGroup.replace(/'/g,"''") + "'");
    }
    if (req.query.requestedBy) {
      conditions.push("u.full_name = '" + req.query.requestedBy.replace(/'/g,"''") + "'");
    }
    if (req.query.fromDate && /^\\d{4}-\\d{2}-\\d{2}$/.test(req.query.fromDate)) {
      conditions.push("r.planned_start_date >= TO_DATE('" + req.query.fromDate + "','YYYY-MM-DD')");
    }
    if (req.query.toDate && /^\\d{4}-\\d{2}-\\d{2}$/.test(req.query.toDate)) {
      conditions.push("r.planned_start_date <= TO_DATE('" + req.query.toDate + "','YYYY-MM-DD')");
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    const countRow = await db.queryOne(
      \`SELECT COUNT(*) AS total
         FROM crms_releases r
         LEFT JOIN crms_assignment_groups ag ON ag.group_id = r.assignment_group_id
         LEFT JOIN crms_users u ON u.user_id = r.requested_by
        \` + whereClause, {}
    );
    const total = Number(countRow.TOTAL);

    const rows = await db.query(
      \`SELECT r.release_id, r.release_number, r.state, r.priority, r.title,
              r.planned_start_date, r.target_end_date, r.company, r.service, r.created_at,
              u.full_name  AS requested_by,
              u2.full_name AS assigned_to,
              ag.group_name AS assignment_group
         FROM crms_releases r
         LEFT JOIN crms_users u  ON u.user_id  = r.requested_by
         LEFT JOIN crms_users u2 ON u2.user_id = r.assigned_to_user_id
         LEFT JOIN crms_assignment_groups ag ON ag.group_id = r.assignment_group_id
        \` + whereClause + \`
        ORDER BY r.created_at DESC
        OFFSET \` + offset + \` ROWS FETCH NEXT \` + limit + \` ROWS ONLY\`, {}
    );

    return res.json({
      data: rows.map(camelizeRelease),
      pagination: { page, pageSize: limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
}

// ── GET /releases/:releaseId ──────────────────────────────────────────
async function getOne(req, res, next) {
  try {
    const rid = Number(req.params.releaseId);
    const row = await db.queryOne(
      \`SELECT r.release_id, r.release_number, r.state, r.priority, r.title,
              r.summary, r.company, r.service,
              r.planned_start_date, r.target_end_date, r.created_at, r.updated_at,
              u.full_name  AS requested_by,
              u2.full_name AS assigned_to,
              ag.group_name AS assignment_group
         FROM crms_releases r
         LEFT JOIN crms_users u  ON u.user_id  = r.requested_by
         LEFT JOIN crms_users u2 ON u2.user_id = r.assigned_to_user_id
         LEFT JOIN crms_assignment_groups ag ON ag.group_id = r.assignment_group_id
        WHERE r.release_id = \` + rid + \` AND r.is_deleted = 0\`, {}
    );
    if (!row) return res.status(404).json({ error: 'Release not found' });

    const history = await db.query(
      \`SELECT h.action, h.from_state, h.to_state, h.changed_at, u.full_name AS changed_by
         FROM crms_release_history h
         JOIN crms_users u ON u.user_id = h.changed_by
        WHERE h.release_id = \` + rid + \`
        ORDER BY h.changed_at ASC\`, {}
    );

    return res.json({
      ...camelizeRelease(row),
      summary:  row.SUMMARY || '',
      history:  history.map(h => ({
        action:    h.ACTION,
        fromState: h.FROM_STATE,
        toState:   h.TO_STATE,
        changedBy: h.CHANGED_BY,
        changedAt: h.CHANGED_AT,
      })),
    });
  } catch (err) { next(err); }
}

// ── POST /releases ────────────────────────────────────────────────────
const createValidation = [
  body('priority').isIn(['1','2','3','4']).withMessage('Priority must be 1-4'),
  body('title').trim().notEmpty().withMessage('Title required').isLength({ max: 200 }),
  body('summary').trim().notEmpty().withMessage('Summary required'),
  body('company').trim().notEmpty().withMessage('Company required'),
  body('service').trim().notEmpty().withMessage('Service required'),
  body('plannedStartDate').isISO8601().withMessage('Invalid planned start date'),
  body('targetEndDate').optional({ nullable: true }).isISO8601()
    .custom((val, { req }) => {
      if (val && req.body.plannedStartDate && val < req.body.plannedStartDate)
        throw new Error('Target end date must be on or after planned start date');
      return true;
    }),
  validate,
];

async function create(req, res, next) {
  try {
    const {
      priority, title, summary, company, service,
      plannedStartDate, targetEndDate, assignmentGroupId, assignedToUserId,
    } = req.body;

    // Get next sequence value
    const seqRow = await db.queryOne('SELECT crms_release_seq.NEXTVAL AS seq FROM dual', {});
    const seq    = Number(seqRow.SEQ);
    const number = 'RLSE' + String(seq).padStart(7, '0');

    const safeTitle   = (title   || '').replace(/'/g, "''");
    const safeSummary = (summary || '').replace(/'/g, "''");
    const safeCompany = (company || '').replace(/'/g, "''");
    const safeService = (service || '').replace(/'/g, "''");
    const safeStart   = (plannedStartDate || '').replace(/[^0-9-]/g,'');
    const safeEnd     = (targetEndDate    || '').replace(/[^0-9-]/g,'');
    const safePrio    = String(priority).replace(/[^1-4]/g,'');
    const agId        = assignmentGroupId ? Number(assignmentGroupId) : null;
    const atId        = assignedToUserId  ? Number(assignedToUserId)  : null;
    const reqBy       = Number(req.user.userId);

    const endDateSQL  = safeEnd
      ? "TO_DATE('" + safeEnd + "','YYYY-MM-DD')"
      : 'NULL';
    const agSQL       = agId ? String(agId) : 'NULL';
    const atSQL       = atId ? String(atId) : 'NULL';

    await db.executeWithCommit(
      \`INSERT INTO crms_releases
         (release_number, state, requested_by, priority, title, summary,
          company, service, planned_start_date, target_end_date,
          assignment_group_id, assigned_to_user_id)
       VALUES (
         '\` + number + \`', 'Draft', \` + reqBy + \`, '\` + safePrio + \`',
         '\` + safeTitle + \`', '\` + safeSummary + \`',
         '\` + safeCompany + \`', '\` + safeService + \`',
         TO_DATE('\` + safeStart + \`','YYYY-MM-DD'),
         \` + endDateSQL + \`,
         \` + agSQL + \`, \` + atSQL + \`)\`, {}
    );

    const relRow = await db.queryOne(
      "SELECT release_id FROM crms_releases WHERE release_number = '" + number + "'", {}
    );
    const releaseId = Number(relRow.RELEASE_ID);

    await db.executeWithCommit(
      \`INSERT INTO crms_release_history (release_id, action, from_state, to_state, changed_by)
       VALUES (\` + releaseId + \`, 'Created', NULL, 'Draft', \` + reqBy + \`)\`, {}
    );

    const auditDetail = number + ' created by ' + (req.user.fullName || 'User').replace(/'/g,"''");
    await db.executeWithCommit(
      "INSERT INTO crms_audit (action, performed_by, cr_number, details) VALUES " +
      "('Created', " + reqBy + ", '" + number + "', '" + auditDetail + "')", {}
    );

    await db.executeWithCommit(
      "INSERT INTO crms_notifications (user_id, title, message, release_id) VALUES (" +
      reqBy + ", 'New Release Created', '" + number + " has been created and is in Draft state.', " +
      releaseId + ")", {}
    );

    logger.info('Release created', { releaseId, number, userId: req.user.userId });
    return res.status(201).json({ releaseId, releaseNumber: number, state: 'Draft', message: 'Release created' });
  } catch (err) { next(err); }
}

// ── PATCH /releases/:releaseId/advance ───────────────────────────────
async function advanceState(req, res, next) {
  try {
    const rid     = Number(req.params.releaseId);
    const { force } = req.body || {};

    const release = await db.queryOne(
      'SELECT release_id, state, release_number FROM crms_releases WHERE release_id = ' + rid, {}
    );
    if (!release) return res.status(404).json({ error: 'Release not found' });

    const currentState = release.STATE;
    if (TERMINAL_STATES.includes(currentState))
      return res.status(400).json({ error: 'Cannot advance from terminal state: ' + currentState });

    let newState;
    if (force) {
      if (!['On Hold','Cancelled'].includes(force))
        return res.status(400).json({ error: 'Only "On Hold" or "Cancelled" can be forced' });
      newState = force;
    } else {
      newState = NEXT_STATE[currentState];
      if (!newState) return res.status(400).json({ error: 'No next state defined' });
    }

    const reqBy = Number(req.user.userId);
    const safeNew = newState.replace(/'/g,"''");
    const safeCur = currentState.replace(/'/g,"''");
    const relNum  = release.RELEASE_NUMBER;

    await db.executeWithCommit(
      "UPDATE crms_releases SET state = '" + safeNew + "', updated_at = SYSDATE WHERE release_id = " + rid, {}
    );
    await db.executeWithCommit(
      \`INSERT INTO crms_release_history (release_id, action, from_state, to_state, changed_by)
       VALUES (\` + rid + \`, 'State Change', '\` + safeCur + \`', '\` + safeNew + \`', \` + reqBy + \`)\`, {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_audit (action, performed_by, cr_number, details) VALUES " +
      "('State Change', " + reqBy + ", '" + relNum + "', '" + safeCur + " -> " + safeNew + "')", {}
    );
    // Notification to assigned user
    const assigned = await db.queryOne(
      'SELECT assigned_to_user_id FROM crms_releases WHERE release_id = ' + rid, {}
    );
    if (assigned && assigned.ASSIGNED_TO_USER_ID) {
      await db.executeWithCommit(
        "INSERT INTO crms_notifications (user_id, title, message, release_id) VALUES (" +
        Number(assigned.ASSIGNED_TO_USER_ID) + ", 'State Updated', '" +
        relNum + " moved from " + safeCur + " to " + safeNew + "', " + rid + ")", {}
      );
    }

    logger.info('State advanced', { releaseId: rid, from: currentState, to: newState });
    return res.json({ releaseId: rid, fromState: currentState, toState: newState });
  } catch (err) { next(err); }
}

// ── DELETE /releases/:releaseId ───────────────────────────────────────
async function remove(req, res, next) {
  try {
    const rid    = Number(req.params.releaseId);
    const result = await db.executeWithCommit(
      'UPDATE crms_releases SET is_deleted = 1, updated_at = SYSDATE WHERE release_id = ' + rid, {}
    );
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Release not found' });
    return res.json({ message: 'Release deleted' });
  } catch (err) { next(err); }
}

// ── helper ────────────────────────────────────────────────────────────
function camelizeRelease(r) {
  return {
    releaseId:       r.RELEASE_ID,
    releaseNumber:   r.RELEASE_NUMBER,
    state:           r.STATE,
    priority:        r.PRIORITY,
    title:           r.TITLE,
    summary:         r.SUMMARY || '',
    company:         r.COMPANY,
    service:         r.SERVICE,
    requestedBy:     r.REQUESTED_BY,
    assignedTo:      r.ASSIGNED_TO,
    assignmentGroup: r.ASSIGNMENT_GROUP,
    plannedStartDate:r.PLANNED_START_DATE,
    targetEndDate:   r.TARGET_END_DATE,
    createdAt:       r.CREATED_AT,
    updatedAt:       r.UPDATED_AT,
  };
}

module.exports = { nextNumber, getAll, getOne, create, createValidation, advanceState, remove };
`;

const relPath = path.join(__dirname, 'src', 'controllers', 'releaseController.js');
fs.writeFileSync(relPath, releaseController, 'utf8');
console.log('✅  Rewrote releaseController.js');

// ════════════════════════════════════════════════════════════════════
// 2. Add /next-number route to releases.js
// ════════════════════════════════════════════════════════════════════
const routesPath = path.join(__dirname, 'src', 'routes', 'releases.js');
let routes = fs.readFileSync(routesPath, 'utf8');
if (!routes.includes('next-number')) {
  routes = routes.replace(
    "router.get  ('/',",
    "router.get  ('/next-number',   ctrl.nextNumber);\nrouter.get  ('/',"
  );
  fs.writeFileSync(routesPath, routes, 'utf8');
  console.log('✅  Added /releases/next-number route');
} else {
  console.log('OK    routes/releases.js already has next-number');
}

// ════════════════════════════════════════════════════════════════════
// 3. Rewrite taskController.js — clean version no bind issues
// ════════════════════════════════════════════════════════════════════
const taskController = `'use strict';

const { body } = require('express-validator');
const db       = require('../config/db');
const logger   = require('../config/logger');
const { validate } = require('../middleware/validate');

const VALID_PHASES = ['BRD','FSD','Dev','Testing','UAT'];
const PHASE_TYPE   = {
  BRD:'BRD Task', FSD:'FSD Task', Dev:'Development Task',
  Testing:'Testing Task', UAT:'UAT Task',
};

async function getByRelease(req, res, next) {
  try {
    const rid   = Number(req.params.releaseId);
    const phase = req.query.phase;
    let   sql   = \`SELECT t.task_id, t.task_number, t.phase, t.task_type, t.state,
              t.short_description, t.created_at,
              ag.group_name AS assignment_group,
              u.full_name   AS assigned_to
         FROM crms_tasks t
         LEFT JOIN crms_assignment_groups ag ON ag.group_id = t.assignment_group_id
         LEFT JOIN crms_users             u  ON u.user_id   = t.assigned_to_user_id
        WHERE t.release_id = \` + rid;
    if (phase && VALID_PHASES.includes(phase)) sql += " AND t.phase = '" + phase + "'";
    sql += ' ORDER BY t.created_at ASC';
    const rows = await db.query(sql, {});
    return res.json(rows.map(camelizeTask));
  } catch (err) { next(err); }
}

const createValidation = [
  body('phase').isIn(VALID_PHASES).withMessage('Invalid phase'),
  body('shortDescription').trim().notEmpty().withMessage('Short description required'),
  body('assignmentGroupId').notEmpty().withMessage('Assignment group required'),
  validate,
];

async function create(req, res, next) {
  try {
    const { phase, shortDescription, assignmentGroupId, assignedToUserId } = req.body;
    const rid    = Number(req.params.releaseId);
    const reqBy  = Number(req.user.userId);

    const release = await db.queryOne(
      'SELECT release_id, release_number FROM crms_releases WHERE release_id = ' + rid + ' AND is_deleted = 0', {}
    );
    if (!release) return res.status(404).json({ error: 'Release not found' });

    const seqRow = await db.queryOne('SELECT crms_task_seq.NEXTVAL AS seq FROM dual', {});
    const seq    = Number(seqRow.SEQ);
    const taskNumber = 'RTSK' + String(seq).padStart(7, '0');
    const taskType   = PHASE_TYPE[phase];
    const safeDesc   = (shortDescription || '').replace(/'/g,"''");
    const agId       = Number(assignmentGroupId);
    const atId       = assignedToUserId ? Number(assignedToUserId) : null;
    const atSQL      = atId ? String(atId) : 'NULL';

    await db.executeWithCommit(
      \`INSERT INTO crms_tasks
         (task_number, release_id, phase, task_type, state,
          short_description, assignment_group_id, assigned_to_user_id, created_by)
       VALUES ('\` + taskNumber + \`', \` + rid + \`, '\` + phase + \`', '\` + taskType + \`', 'Open',
         '\` + safeDesc + \`', \` + agId + \`, \` + atSQL + \`, \` + reqBy + \`)\`, {}
    );

    const taskRow = await db.queryOne(
      "SELECT task_id FROM crms_tasks WHERE task_number = '" + taskNumber + "'", {}
    );
    const taskId = Number(taskRow.TASK_ID);

    // Notification to assigned user
    if (atId) {
      const relNum = release.RELEASE_NUMBER;
      await db.executeWithCommit(
        "INSERT INTO crms_notifications (user_id, title, message, release_id) VALUES (" +
        atId + ", 'New Task Assigned', '" + taskNumber + " assigned to you on " + relNum + "', " + rid + ")", {}
      );
    }

    const auditDetail = taskNumber + ' (' + taskType + ') added';
    await db.executeWithCommit(
      "INSERT INTO crms_audit (action, performed_by, cr_number, details) VALUES " +
      "('Task Created', " + reqBy + ", '" + release.RELEASE_NUMBER + "', '" + auditDetail + "')", {}
    );

    logger.info('Task created', { taskId, taskNumber, releaseId: rid });
    return res.status(201).json({
      taskId, taskNumber, phase, taskType, state: 'Open',
      shortDescription, message: 'Task created',
    });
  } catch (err) { next(err); }
}

async function closeTask(req, res, next) {
  try {
    const tid = Number(req.params.taskId);
    const result = await db.executeWithCommit(
      "UPDATE crms_tasks SET state = 'Closed', updated_at = SYSDATE WHERE task_id = " + tid + " AND state = 'Open'", {}
    );
    if (result.rowsAffected === 0)
      return res.status(400).json({ error: 'Task not found or already closed' });
    return res.json({ message: 'Task closed' });
  } catch (err) { next(err); }
}

async function myTasks(req, res, next) {
  try {
    const uid  = Number(req.user.userId);
    const rows = await db.query(
      \`SELECT t.task_id, t.task_number, t.phase, t.task_type, t.state,
              t.short_description, r.release_number, r.release_id
         FROM crms_tasks t
         JOIN crms_releases r ON r.release_id = t.release_id
        WHERE t.assigned_to_user_id = \` + uid + \` AND t.state = 'Open'
        ORDER BY t.created_at DESC\`, {}
    );
    return res.json(rows.map(camelizeTask));
  } catch (err) { next(err); }
}

function camelizeTask(t) {
  return {
    taskId:          t.TASK_ID,
    taskNumber:      t.TASK_NUMBER,
    phase:           t.PHASE,
    taskType:        t.TASK_TYPE,
    state:           t.STATE,
    shortDescription:t.SHORT_DESCRIPTION,
    assignmentGroup: t.ASSIGNMENT_GROUP,
    assignedTo:      t.ASSIGNED_TO,
    releaseNumber:   t.RELEASE_NUMBER,
    releaseId:       t.RELEASE_ID,
    createdAt:       t.CREATED_AT,
  };
}

module.exports = { getByRelease, create, createValidation, closeTask, myTasks };
`;

const taskPath = path.join(__dirname, 'src', 'controllers', 'taskController.js');
fs.writeFileSync(taskPath, taskController, 'utf8');
console.log('✅  Rewrote taskController.js');

// ════════════════════════════════════════════════════════════════════
// 4. Rewrite analyticsController.js — no bind variables
// ════════════════════════════════════════════════════════════════════
const analyticsController = `'use strict';

const db = require('../config/db');

async function getSummary(req, res, next) {
  try {
    const conditions = ['r.is_deleted = 0'];

    if (req.query.assignmentGroupId) {
      conditions.push('r.assignment_group_id = ' + Number(req.query.assignmentGroupId));
    }
    if (req.query.userId) {
      conditions.push('r.requested_by = ' + Number(req.query.userId));
    }
    if (req.query.priority) {
      const p = req.query.priority.replace(/[^1-4]/g,'');
      if (p) conditions.push("r.priority = '" + p + "'");
    }

    const where = 'WHERE ' + conditions.join(' AND ');

    const summary = await db.queryOne(
      \`SELECT
         COUNT(*)                                                          AS total,
         COUNT(CASE WHEN r.state NOT IN ('Closed','Cancelled') THEN 1 END) AS open_count,
         COUNT(CASE WHEN r.state = 'Closed'    THEN 1 END)                AS closed_count,
         COUNT(CASE WHEN r.state = 'Cancelled' THEN 1 END)                AS cancelled_count,
         COUNT(CASE WHEN r.priority = '1'      THEN 1 END)                AS critical_count
         FROM crms_releases r \` + where, {}
    );

    const byState = await db.query(
      \`SELECT r.state, COUNT(*) AS cnt
         FROM crms_releases r \` + where + \`
        GROUP BY r.state
        ORDER BY MIN(CASE r.state
          WHEN 'Draft' THEN 1 WHEN 'BRD Phase' THEN 2 WHEN 'FSD Phase' THEN 3
          WHEN 'Awaiting approval' THEN 4 WHEN 'On Hold' THEN 5
          WHEN 'Development Phase' THEN 6 WHEN 'Testing/QA' THEN 7
          WHEN 'UAT' THEN 8 WHEN 'Deployment' THEN 9 WHEN 'Closed' THEN 10
          ELSE 11 END)\`, {}
    );

    const byPriority = await db.query(
      \`SELECT r.priority,
              CASE r.priority WHEN '1' THEN '1 - Critical' WHEN '2' THEN '2 - High'
                WHEN '3' THEN '3 - Moderate' WHEN '4' THEN '4 - Low' ELSE r.priority END AS lbl,
              COUNT(*) AS cnt
         FROM crms_releases r \` + where + \`
        GROUP BY r.priority ORDER BY r.priority\`, {}
    );

    const byGroup = await db.query(
      \`SELECT NVL(ag.group_name,'(Unassigned)') AS grp, COUNT(*) AS cnt
         FROM crms_releases r
         LEFT JOIN crms_assignment_groups ag ON ag.group_id = r.assignment_group_id
        \` + where + \`
        GROUP BY ag.group_name ORDER BY cnt DESC\`, {}
    );

    const byUser = await db.query(
      \`SELECT u.full_name AS uname, COUNT(*) AS cnt
         FROM crms_releases r
         JOIN crms_users u ON u.user_id = r.requested_by
        \` + where + \`
        GROUP BY u.full_name ORDER BY cnt DESC\`, {}
    );

    const taskCount = await db.queryOne(
      \`SELECT COUNT(*) AS total
         FROM crms_tasks t
         JOIN crms_releases r ON r.release_id = t.release_id \` + where, {}
    );

    return res.json({
      summary: {
        total:     Number(summary.TOTAL),
        open:      Number(summary.OPEN_COUNT),
        closed:    Number(summary.CLOSED_COUNT),
        cancelled: Number(summary.CANCELLED_COUNT),
        critical:  Number(summary.CRITICAL_COUNT),
        tasks:     Number(taskCount.TOTAL),
      },
      byState:    byState.map(r    => ({ state:    r.STATE,  count: Number(r.CNT) })),
      byPriority: byPriority.map(r => ({ priority: r.PRIORITY, label: r.LBL, count: Number(r.CNT) })),
      byGroup:    byGroup.map(r    => ({ group:    r.GRP,    count: Number(r.CNT) })),
      byUser:     byUser.map(r     => ({ user:     r.UNAME,  count: Number(r.CNT) })),
    });
  } catch (err) { next(err); }
}

module.exports = { getSummary };
`;

const analyticsPath = path.join(__dirname, 'src', 'controllers', 'analyticsController.js');
fs.writeFileSync(analyticsPath, analyticsController, 'utf8');
console.log('✅  Rewrote analyticsController.js');

// ════════════════════════════════════════════════════════════════════
// 5. Rewrite auditController.js — no bind variables
// ════════════════════════════════════════════════════════════════════
const auditController = `'use strict';

const db = require('../config/db');
const { parsePagination } = require('../utils/pagination');

async function getAll(req, res, next) {
  try {
    const isAdmin = req.user.role === 'admin';
    const { page, limit } = parsePagination(req.query);
    const offset = (page - 1) * limit;

    const conditions = [];

    if (!isAdmin) {
      conditions.push('a.performed_by = ' + Number(req.user.userId));
    } else if (req.query.userId) {
      conditions.push('a.performed_by = ' + Number(req.query.userId));
    }
    if (req.query.action) {
      conditions.push("a.action = '" + req.query.action.replace(/'/g,"''") + "'");
    }
    if (req.query.crNumber) {
      conditions.push("a.cr_number = '" + req.query.crNumber.replace(/'/g,"''") + "'");
    }
    if (req.query.fromDate && /^\\d{4}-\\d{2}-\\d{2}$/.test(req.query.fromDate)) {
      conditions.push("a.created_at >= TO_DATE('" + req.query.fromDate + "','YYYY-MM-DD')");
    }
    if (req.query.toDate && /^\\d{4}-\\d{2}-\\d{2}$/.test(req.query.toDate)) {
      conditions.push("a.created_at < TO_DATE('" + req.query.toDate + "','YYYY-MM-DD') + 1");
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const countRow = await db.queryOne('SELECT COUNT(*) AS total FROM crms_audit a ' + where, {});
    const total    = Number(countRow.TOTAL);

    const rows = await db.query(
      \`SELECT a.audit_id, a.action, a.cr_number, a.details, a.created_at,
              u.full_name AS performed_by
         FROM crms_audit a
         JOIN crms_users u ON u.user_id = a.performed_by
        \` + where + \`
        ORDER BY a.created_at DESC
        OFFSET \` + offset + \` ROWS FETCH NEXT \` + limit + \` ROWS ONLY\`, {}
    );

    return res.json({
      data: rows.map(r => ({
        auditId:     r.AUDIT_ID,
        action:      r.ACTION,
        performedBy: r.PERFORMED_BY,
        crNumber:    r.CR_NUMBER,
        details:     r.DETAILS,
        createdAt:   r.CREATED_AT,
      })),
      pagination: { page, pageSize: limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
}

module.exports = { getAll };
`;

const auditPath = path.join(__dirname, 'src', 'controllers', 'auditController.js');
fs.writeFileSync(auditPath, auditController, 'utf8');
console.log('✅  Rewrote auditController.js');

// ════════════════════════════════════════════════════════════════════
// 6. Rewrite notificationController.js — no bind variables
// ════════════════════════════════════════════════════════════════════
const notifController = `'use strict';

const db = require('../config/db');

async function getAll(req, res, next) {
  try {
    const uid  = Number(req.user.userId);
    const rows = await db.query(
      \`SELECT n.notification_id, n.title, n.message, n.is_read, n.created_at,
              n.release_id, r.release_number
         FROM crms_notifications n
         LEFT JOIN crms_releases r ON r.release_id = n.release_id
        WHERE n.user_id = \` + uid + \`
        ORDER BY n.created_at DESC
        FETCH FIRST 50 ROWS ONLY\`, {}
    );
    const unreadCount = rows.filter(r => !r.IS_READ).length;
    return res.json({
      notifications: rows.map(r => ({
        id:            r.NOTIFICATION_ID,
        title:         r.TITLE,
        message:       r.MESSAGE,
        isRead:        !!r.IS_READ,
        releaseId:     r.RELEASE_ID,
        releaseNumber: r.RELEASE_NUMBER,
        createdAt:     r.CREATED_AT,
      })),
      unreadCount,
    });
  } catch (err) { next(err); }
}

async function markRead(req, res, next) {
  try {
    const nid = Number(req.params.id);
    const uid = Number(req.user.userId);
    await db.executeWithCommit(
      'UPDATE crms_notifications SET is_read = 1 WHERE notification_id = ' + nid + ' AND user_id = ' + uid, {}
    );
    return res.json({ message: 'Marked as read' });
  } catch (err) { next(err); }
}

async function markAllRead(req, res, next) {
  try {
    const uid    = Number(req.user.userId);
    const result = await db.executeWithCommit(
      'UPDATE crms_notifications SET is_read = 1 WHERE user_id = ' + uid + ' AND is_read = 0', {}
    );
    return res.json({ message: result.rowsAffected + ' notifications marked as read' });
  } catch (err) { next(err); }
}

module.exports = { getAll, markRead, markAllRead };
`;

const notifPath = path.join(__dirname, 'src', 'controllers', 'notificationController.js');
fs.writeFileSync(notifPath, notifController, 'utf8');
console.log('✅  Rewrote notificationController.js');

console.log(`
════════════════════════════════════════════════════
  All controllers rewritten.

  NEXT STEPS:
  1. Restart server:   npm run dev
  2. Open frontend:    cr-management-system-v6.html
  3. Login with:       SG / admin123
════════════════════════════════════════════════════
`);
