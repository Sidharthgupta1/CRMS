'use strict';
const db     = require('../config/db');
const logger = require('../config/logger');

// Safe string escape
function s(v) { return v ? String(v).replace(/'/g,"''") : ''; }
function n(v) { return parseInt(v, 10) || 0; }

// ── GET /task-list  — all rows for current user ───────────────────────
async function getTaskList(req, res, next) {
  try {
    const rows = await db.query(
      "SELECT task_list_id, reported_on, requester, cemli, service_now_id, " +
      "ticket_no, smart_sheet, project, module, process, task_title, owner, " +
      "status, stage, pending_with, cr_task_id, cr_number, auto_populated, " +
      "created_at, updated_at " +
      "FROM crms_task_list " +
      "WHERE created_by = " + n(req.user.userId) + " AND is_deleted = 0 " +
      "ORDER BY task_list_id ASC", {}
    );
    return res.json(rows.map(camel));
  } catch(err) { next(err); }
}

// ── POST /task-list  — create one row ────────────────────────────────
async function createTask(req, res, next) {
  try {
    const b = req.body;
    const result = await db.executeWithCommit(
      "INSERT INTO crms_task_list (" +
      "  reported_on, requester, cemli, service_now_id, ticket_no, smart_sheet, " +
      "  project, module, process, task_title, owner, status, stage, pending_with, " +
      "  cr_task_id, cr_number, auto_populated, created_by " +
      ") VALUES (" +
      "  '" + s(b.reportedOn)   + "','" + s(b.requester)    + "','" + s(b.cemli)        + "'," +
      "  '" + s(b.serviceNowId) + "','" + s(b.ticketNo)     + "','" + s(b.smartSheet)   + "'," +
      "  '" + s(b.project)      + "','" + s(b.module)       + "','" + s(b.process)      + "'," +
      "  '" + s(b.taskTitle)    + "','" + s(b.owner)        + "'," +
      "  '" + s(b.status||'NOT STARTED') + "','" + s(b.stage||'NOT STARTED') + "'," +
      "  '" + s(b.pendingWith)  + "','" + s(b.crTaskId)     + "','" + s(b.crNumber)     + "'," +
      "  " + (b.autoPopulated ? 1 : 0) + "," +
      "  " + n(req.user.userId) +
      ")", {}
    );
    // Get the auto-generated ID
    const newRow = await db.queryOne(
      'SELECT MAX(task_list_id) AS new_id FROM crms_task_list WHERE created_by=' + n(req.user.userId), {}
    );
    const newId = newRow && newRow.NEW_ID;
    logger.info('[TaskList] Created', { id: newId, by: req.user.userId });
    return res.status(201).json({ taskListId: newId, message: 'Created' });
  } catch(err) { next(err); }
}

// ── POST /task-list/bulk  — upsert many rows at once ─────────────────
// Used by "Save All" — inserts new rows, updates existing ones
async function bulkUpsert(req, res, next) {
  try {
    const rows   = req.body.rows;
    if (!Array.isArray(rows) || !rows.length)
      return res.status(422).json({ error: 'rows array required' });

    const uid    = n(req.user.userId);
    let created  = 0, updated = 0;

    for (const b of rows) {
      if (b.taskListId) {
        // UPDATE existing
        await db.executeWithCommit(
          "UPDATE crms_task_list SET " +
          "  reported_on='" + s(b.reportedOn)   + "', requester='"    + s(b.requester)    + "'," +
          "  cemli='"       + s(b.cemli)         + "', service_now_id='"+ s(b.serviceNowId)+ "'," +
          "  ticket_no='"   + s(b.ticketNo)      + "', smart_sheet='"  + s(b.smartSheet)   + "'," +
          "  project='"     + s(b.project)       + "', module='"       + s(b.module)       + "'," +
          "  process='"     + s(b.process)       + "', task_title='"   + s(b.taskTitle)    + "'," +
          "  owner='"       + s(b.owner)         + "', status='"       + s(b.status||'NOT STARTED') + "'," +
          "  stage='"       + s(b.stage||'NOT STARTED') + "', pending_with='" + s(b.pendingWith) + "'" +
          " WHERE task_list_id=" + n(b.taskListId) + " AND created_by=" + uid, {}
        );
        updated++;
      } else {
        // INSERT new
        await db.executeWithCommit(
          "INSERT INTO crms_task_list (" +
          "  reported_on, requester, cemli, service_now_id, ticket_no, smart_sheet, " +
          "  project, module, process, task_title, owner, status, stage, pending_with, " +
          "  cr_task_id, cr_number, auto_populated, created_by " +
          ") VALUES (" +
          "  '" + s(b.reportedOn)   + "','" + s(b.requester)    + "','" + s(b.cemli)        + "'," +
          "  '" + s(b.serviceNowId) + "','" + s(b.ticketNo)     + "','" + s(b.smartSheet)   + "'," +
          "  '" + s(b.project)      + "','" + s(b.module)       + "','" + s(b.process)      + "'," +
          "  '" + s(b.taskTitle)    + "','" + s(b.owner)        + "'," +
          "  '" + s(b.status||'NOT STARTED') + "','" + s(b.stage||'NOT STARTED') + "'," +
          "  '" + s(b.pendingWith)  + "','" + s(b.crTaskId||'') + "','" + s(b.crNumber||'') + "'," +
          "  " + (b.autoPopulated ? 1 : 0) + ", " + uid +
          ")", {}
        );
        created++;
      }
    }
    logger.info('[TaskList] BulkUpsert', { created, updated, by: uid });
    return res.json({ message: 'Saved', created, updated });
  } catch(err) { next(err); }
}

// ── PATCH /task-list/:id  — update one row ────────────────────────────
async function updateTask(req, res, next) {
  try {
    const id  = n(req.params.id);
    const uid = n(req.user.userId);
    const b   = req.body;
    await db.executeWithCommit(
      "UPDATE crms_task_list SET " +
      "  reported_on='"   + s(b.reportedOn)   + "', requester='"     + s(b.requester)    + "'," +
      "  cemli='"         + s(b.cemli)         + "', service_now_id='"+ s(b.serviceNowId) + "'," +
      "  ticket_no='"     + s(b.ticketNo)      + "', smart_sheet='"   + s(b.smartSheet)   + "'," +
      "  project='"       + s(b.project)       + "', module='"        + s(b.module)       + "'," +
      "  process='"       + s(b.process)       + "', task_title='"    + s(b.taskTitle)    + "'," +
      "  owner='"         + s(b.owner)         + "', status='"        + s(b.status)       + "'," +
      "  stage='"         + s(b.stage)         + "', pending_with='"  + s(b.pendingWith)  + "'" +
      " WHERE task_list_id=" + id + " AND created_by=" + uid + " AND is_deleted=0", {}
    );
    return res.json({ message: 'Updated' });
  } catch(err) { next(err); }
}

// ── DELETE /task-list/:id  — soft delete one row ──────────────────────
async function deleteTask(req, res, next) {
  try {
    const id  = n(req.params.id);
    const uid = n(req.user.userId);
    await db.executeWithCommit(
      "UPDATE crms_task_list SET is_deleted=1 " +
      "WHERE task_list_id=" + id + " AND created_by=" + uid, {}
    );
    return res.json({ message: 'Deleted' });
  } catch(err) { next(err); }
}

// ── DELETE /task-list/bulk  — soft delete many rows ───────────────────
async function bulkDelete(req, res, next) {
  try {
    const ids = (req.body.ids || []).map(n).filter(Boolean);
    if (!ids.length) return res.status(422).json({ error: 'ids array required' });
    const uid = n(req.user.userId);
    await db.executeWithCommit(
      "UPDATE crms_task_list SET is_deleted=1 " +
      "WHERE task_list_id IN (" + ids.join(',') + ") AND created_by=" + uid, {}
    );
    return res.json({ message: 'Deleted', count: ids.length });
  } catch(err) { next(err); }
}

// ── camelCase mapper ──────────────────────────────────────────────────
function camel(r) {
  return {
    taskListId:   r.TASK_LIST_ID,
    reportedOn:   r.REPORTED_ON   || '',
    requester:    r.REQUESTER     || '',
    cemli:        r.CEMLI         || '',
    serviceNowId: r.SERVICE_NOW_ID|| '',
    ticketNo:     r.TICKET_NO     || '',
    smartSheet:   r.SMART_SHEET   || '',
    project:      r.PROJECT       || '',
    module:       r.MODULE        || '',
    process:      r.PROCESS       || '',
    taskTitle:    r.TASK_TITLE    || '',
    owner:        r.OWNER         || '',
    status:       r.STATUS        || 'NOT STARTED',
    stage:        r.STAGE         || 'NOT STARTED',
    pendingWith:  r.PENDING_WITH  || '',
    crTaskId:     r.CR_TASK_ID    || '',
    crNumber:     r.CR_NUMBER     || '',
    autoPopulated:r.AUTO_POPULATED === 1,
    createdAt:    r.CREATED_AT,
    updatedAt:    r.UPDATED_AT,
  };
}

module.exports = {
  getTaskList, createTask, bulkUpsert, updateTask, deleteTask, bulkDelete,
};
