'use strict';

const { body } = require('express-validator');
const db       = require('../config/db');
const logger   = require('../config/logger');
const { validate } = require('../middleware/validate');

const VALID_PHASES = ['BRD','FSD','Dev','Testing','UAT'];
const PHASE_TYPE   = { BRD:'BRD Task',FSD:'FSD Task',Dev:'Development Task',Testing:'Testing Task',UAT:'UAT Task' };

function safe(s) { return String(s||'').replace(/'/g,"''"); }
function num(n)  { return String(parseInt(n,10)||0); }

async function getByRelease(req, res, next) {
  try {
    const rid = num(req.params.releaseId);
    const ph  = req.query.phase;
    let sql = 'SELECT t.task_id,t.task_number,t.phase,t.task_type,t.state,t.short_description,t.created_at,'+
              'ag.group_name AS assignment_group,u.full_name AS assigned_to '+
              'FROM crms_tasks t '+
              'LEFT JOIN crms_assignment_groups ag ON ag.group_id=t.assignment_group_id '+
              'LEFT JOIN crms_users u ON u.user_id=t.assigned_to_user_id '+
              'WHERE t.release_id='+rid;
    if (ph && VALID_PHASES.includes(ph)) sql += " AND t.phase='"+ph+"'";
    sql += ' ORDER BY t.created_at ASC';
    const rows = await db.query(sql, {});
    return res.json(rows.map(t=>({
      taskId:t.TASK_ID, taskNumber:t.TASK_NUMBER, phase:t.PHASE, taskType:t.TASK_TYPE,
      state:t.STATE, shortDescription:t.SHORT_DESCRIPTION,
      assignmentGroup:t.ASSIGNMENT_GROUP||'', assignedTo:t.ASSIGNED_TO||'',
      createdAt:t.CREATED_AT,
    })));
  } catch(err) { next(err); }
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
    const rid   = num(req.params.releaseId);
    const reqBy = num(req.user.userId);

    const rel = await db.queryOne(
      'SELECT release_id,release_number FROM crms_releases WHERE release_id='+rid+' AND is_deleted=0', {}
    );
    if (!rel) return res.status(404).json({ error:'Release not found' });

    const seqRow = await db.queryOne('SELECT crms_task_seq.NEXTVAL AS seq FROM dual', {});
    const taskNum  = 'RTSK'+String(Number(seqRow.SEQ)).padStart(7,'0');
    const taskType = PHASE_TYPE[phase];
    const agId     = num(assignmentGroupId);
    const atVal    = assignedToUserId ? num(assignedToUserId) : 'NULL';

    await db.executeWithCommit(
      "INSERT INTO crms_tasks(task_number,release_id,phase,task_type,state,short_description,"+
      "assignment_group_id,assigned_to_user_id,created_by) VALUES("+
      "'"+taskNum+"',"+rid+",'"+phase+"','"+taskType+"','Open','"+safe(shortDescription)+"',"+
      agId+","+atVal+","+reqBy+")", {}
    );

    const taskRow = await db.queryOne("SELECT task_id FROM crms_tasks WHERE task_number='"+taskNum+"'", {});
    const taskId  = Number(taskRow.TASK_ID);

    if (assignedToUserId) {
      await db.executeWithCommit(
        "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+
        num(assignedToUserId)+",'New Task Assigned','"+safe(taskNum+" assigned to you on "+rel.RELEASE_NUMBER)+"',"+rid+")", {}
      );
    }
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES("+
      "'Task Created',"+reqBy+",'"+rel.RELEASE_NUMBER+"','"+safe(taskNum+" ("+taskType+") added")+"')", {}
    );

    logger.info('Task created',{taskId,taskNum,releaseId:rid});
    return res.status(201).json({ taskId, taskNumber:taskNum, phase, taskType, state:'Open', shortDescription, message:'Task created' });
  } catch(err) { next(err); }
}

async function closeTask(req, res, next) {
  try {
    const tid    = num(req.params.taskId);
    const result = await db.executeWithCommit(
      "UPDATE crms_tasks SET state='Closed',updated_at=SYSDATE WHERE task_id="+tid+" AND state='Open'", {}
    );
    if (result.rowsAffected===0) return res.status(400).json({ error:'Task not found or already closed' });
    return res.json({ message:'Task closed' });
  } catch(err) { next(err); }
}

async function myTasks(req, res, next) {
  try {
    const uid  = num(req.user.userId);
    const rows = await db.query(
      'SELECT t.task_id,t.task_number,t.phase,t.task_type,t.state,t.short_description,'+
      'r.release_number,r.release_id FROM crms_tasks t '+
      'JOIN crms_releases r ON r.release_id=t.release_id '+
      'WHERE t.assigned_to_user_id='+uid+" AND t.state='Open' ORDER BY t.created_at DESC", {}
    );
    return res.json(rows.map(t=>({
      taskId:t.TASK_ID, taskNumber:t.TASK_NUMBER, phase:t.PHASE, taskType:t.TASK_TYPE,
      state:t.STATE, shortDescription:t.SHORT_DESCRIPTION,
      releaseNumber:t.RELEASE_NUMBER, releaseId:t.RELEASE_ID,
    })));
  } catch(err) { next(err); }
}

module.exports = { getByRelease, create, createValidation, closeTask, myTasks };
