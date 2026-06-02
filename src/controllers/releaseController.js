'use strict';
const taskListCtrl = require('./taskListController');
// ServiceNow integration — push state changes to SNow after every transition
const snow = require('../services/servicenowService');

let _appr = null;
function getApprCtrl() {
  if (!_appr) { try { _appr = require('./approvalController'); } catch(e) { _appr = {}; } }
  return _appr;
}

const { body } = require('express-validator');
const db       = require('../config/db');
const logger   = require('../config/logger');
const { validate } = require('../middleware/validate');

function safe(s) { return String(s||'').replace(/'/g,"''"); }
function num(n)  { return String(parseInt(n,10)||0); }
function safeDate(d) {
  if (!d) return 'NULL';
  // Accept YYYY-MM-DD directly
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return "TO_DATE('"+d+"','YYYY-MM-DD')";
  // Accept ISO datetime strings — strip time part to avoid timezone shift
  var m = String(d).match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return "TO_DATE('"+m[1]+"','YYYY-MM-DD')";
  return 'NULL';
}

const TERMINAL_STATES = ['Closed','Cancelled'];

// ── NEW Lifecycle: RD → RD Approval → FSD → FSD Approval → Dev → Testing → UAT → Deployment Approval L1 → Deployment Approval L2 → Deployment → Closed
const AFTER_APPROVAL = {
  RD:         'FSD Phase',
  FSD:        'Development Phase',
  DEPLOYMENT: 'Closed',  // after all Deployment approval levels → CR is Closed
};

// Manual advances (no approval gate, but sub-task required)
const MANUAL_ADVANCE = {
  'Development Phase': 'Testing Phase',
  'Testing Phase':     'UAT Phase',
  'UAT Phase':         'Deployment Phase',
};

// Phase code ↔ state
function stateToPhaseCode(state) {
  const m = {
    'RD Phase':'RD', 'FSD Phase':'FSD',
    'Development Phase':'DEV', 'Testing Phase':'TESTING',
    'UAT Phase':'UAT', 'Deployment Phase':'DEPLOYMENT',
  };
  return m[state] || null;
}
function phaseToState(code) {
  const m = { RD:'RD Phase',FSD:'FSD Phase',DEV:'Development Phase',TESTING:'Testing Phase',UAT:'UAT Phase',DEPLOYMENT:'Deployment Phase' };
  return m[code] || code;
}
function phaseLabel(code) {
  const m = { RD:'RD Task',FSD:'FSD Task',DEV:'Development Task',TESTING:'Testing Task',UAT:'UAT Task',DEPLOYMENT:'Deployment Task' };
  return m[code] || code+' Task';
}

// ── GET /releases/next-number ─────────────────────────────────────────
async function nextNumber(req, res, next) {
  try {
    const row = await db.queryOne('SELECT crms_release_seq.NEXTVAL AS seq FROM dual', {});
    return res.json({ releaseNumber:'RLSE'+String(Number(row.SEQ)).padStart(7,'0') });
  } catch(err) { next(err); }
}

// ── GET /releases ─────────────────────────────────────────────────────

// ── GET /releases/:releaseId/full-history — Complete CR lifecycle export ──
async function fullHistory(req, res, next) {
  try {
    const rid = num(req.params.releaseId);

    // 1. Core release data
    const rel = await db.queryOne(
      'SELECT r.release_id,r.release_number,r.title,r.state,r.priority,r.summary,'+
      'r.company,r.service,r.planned_start_date,r.target_end_date,r.created_at,r.updated_at,'+
      'r.reason_of_change,r.business_benefits_process,r.business_benefits_qualitative,'+
      'r.cost_saving,r.manpower_saving,r.cemli,r.smartsheet_id,r.process_name,'+
      'u_req.full_name AS requested_by,'+
      'u_at.full_name  AS assigned_to,'+
      'ag.group_name   AS assignment_group '+
      'FROM crms_releases r '+
      'LEFT JOIN crms_users u_req ON u_req.user_id=r.requested_by '+
      'LEFT JOIN crms_users u_at  ON u_at.user_id=r.assigned_to_user_id '+
      'LEFT JOIN crms_assignment_groups ag ON ag.group_id=r.assignment_group_id '+
      'WHERE r.release_id='+rid+' AND r.is_deleted=0', {}
    );
    if (!rel) return res.status(404).json({ error:'Release not found' });

    // 2. State change history (chronological)
    const history = await db.query(
      'SELECT h.action,h.from_state,h.to_state,h.changed_at,u.full_name AS changed_by '+
      'FROM crms_release_history h JOIN crms_users u ON u.user_id=h.changed_by '+
      'WHERE h.release_id='+rid+' ORDER BY h.changed_at ASC', {}
    );

    // 3. Approval trail
    const approvals = await db.query(
      'SELECT ra.phase_code,ra.level_order,ra.status,ra.comments,ra.actioned_at,'+
      'u.full_name AS approver_name '+
      'FROM crms_release_approvals ra '+
      'JOIN crms_users u ON u.user_id=ra.approver_user_id '+
      'WHERE ra.release_id='+rid+' ORDER BY ra.phase_code,ra.level_order ASC', {}
    ).catch(function(){ return []; });

    // 4. Sub-tasks with dates
    const tasks = await db.query(
      'SELECT rt.task_number,rt.phase_code,rt.short_description,rt.state,'+
      'rt.planned_start_date,rt.planned_end_date,rt.actual_start_date,rt.actual_end_date,rt.closed_at,'+
      'u_at.full_name AS assigned_to,'+
      'u_cl.full_name AS closed_by,'+
      'ag.group_name '+
      'FROM crms_release_tasks rt '+
      'LEFT JOIN crms_users u_at ON u_at.user_id=rt.assigned_to '+
      'LEFT JOIN crms_users u_cl ON u_cl.user_id=rt.closed_by '+
      'LEFT JOIN crms_assignment_groups ag ON ag.group_id=rt.assignment_group_id '+
      'WHERE rt.release_id='+rid+' ORDER BY rt.created_at ASC', {}
    ).catch(function(){ return []; });

    // 5. Comments
    const comments = await db.query(
      'SELECT c.comment_text,c.created_at,u.full_name AS author '+
      'FROM crms_comments c JOIN crms_users u ON u.user_id=c.created_by '+
      'WHERE c.release_id='+rid+' ORDER BY c.created_at ASC', {}
    ).catch(function(){ return []; });

    return res.json({
      release: {
        releaseNumber:              rel.RELEASE_NUMBER,
        title:                      rel.TITLE,
        state:                      rel.STATE,
        priority:                   rel.PRIORITY,
        summary:                    rel.SUMMARY||'',
        company:                    rel.COMPANY||'',
        service:                    rel.SERVICE||'',
        requestedBy:                rel.REQUESTED_BY,
        assignedTo:                 rel.ASSIGNED_TO||'',
        assignmentGroup:            rel.ASSIGNMENT_GROUP||'',
        plannedStartDate:           rel.PLANNED_START_DATE||null,
        targetEndDate:              rel.TARGET_END_DATE||null,
        createdAt:                  rel.CREATED_AT,
        updatedAt:                  rel.UPDATED_AT,
        reasonOfChange:             rel.REASON_OF_CHANGE||'',
        businessBenefitsProcess:    rel.BUSINESS_BENEFITS_PROCESS||'',
        businessBenefitsQualitative:rel.BUSINESS_BENEFITS_QUALITATIVE||'',
        costSaving:                 rel.COST_SAVING||'',
        manpowerSaving:             rel.MANPOWER_SAVING||'',
      },
      history: history.map(function(h){ return {
        action:    h.ACTION,
        fromState: h.FROM_STATE||'',
        toState:   h.TO_STATE,
        changedBy: h.CHANGED_BY,
        changedAt: h.CHANGED_AT,
      }; }),
      approvals: approvals.map(function(a){ return {
        phaseCode:    a.PHASE_CODE,
        levelOrder:   a.LEVEL_ORDER,
        approverName: a.APPROVER_NAME,
        status:       a.STATUS,
        comments:     a.COMMENTS||'',
        actionedAt:   a.ACTIONED_AT||null,
      }; }),
      tasks: tasks.map(function(t){ return {
        taskNumber:       t.TASK_NUMBER,
        phaseCode:        t.PHASE_CODE,
        shortDescription: t.SHORT_DESCRIPTION||'',
        state:            t.STATE,
        assignedTo:       t.ASSIGNED_TO||'',
        groupName:        t.GROUP_NAME||'',
        plannedStartDate: t.PLANNED_START_DATE ? (t.PLANNED_START_DATE instanceof Date ? t.PLANNED_START_DATE.toISOString().slice(0,10) : String(t.PLANNED_START_DATE).slice(0,10)) : null,
        plannedEndDate:   t.PLANNED_END_DATE   ? (t.PLANNED_END_DATE   instanceof Date ? t.PLANNED_END_DATE.toISOString().slice(0,10)   : String(t.PLANNED_END_DATE).slice(0,10))   : null,
        actualStartDate:  t.ACTUAL_START_DATE  ? (t.ACTUAL_START_DATE  instanceof Date ? t.ACTUAL_START_DATE.toISOString().slice(0,10)  : String(t.ACTUAL_START_DATE).slice(0,10))  : null,
        actualEndDate:    t.ACTUAL_END_DATE    ? (t.ACTUAL_END_DATE    instanceof Date ? t.ACTUAL_END_DATE.toISOString().slice(0,10)    : String(t.ACTUAL_END_DATE).slice(0,10))    : null,
        closedAt:         t.CLOSED_AT||null,
        closedBy:         t.CLOSED_BY||'',
      }; }),
      comments: comments.map(function(c){ return {
        author:    c.AUTHOR,
        text:      c.COMMENT_TEXT,
        createdAt: c.CREATED_AT,
      }; }),
    });
  } catch(err) { next(err); }
}

async function getAll(req, res, next) {
  try {
    const page   = Math.max(1, parseInt(req.query.page,10)||1);
    const limit  = Math.min(200, parseInt(req.query.pageSize,10)||50);
    const offset = (page-1)*limit;
    const isAdmin= req.user.role==='admin';
    const w      = ['r.is_deleted=0'];
    const uid = num(req.user.userId);
    if (!isAdmin || req.query.mine === '1') {
      w.push('(r.requested_by='+uid+' OR r.assigned_to_user_id='+uid+
        ' OR r.assignment_group_id IN (SELECT group_id FROM crms_group_members WHERE user_id='+uid+')'+
        ' OR EXISTS (SELECT 1 FROM crms_release_tasks rt WHERE rt.release_id=r.release_id AND rt.assigned_to='+uid+'))');
    }
    if (req.query.state)           w.push("r.state='"+safe(req.query.state)+"'");
    if (req.query.priority)        w.push("r.priority='"+safe(req.query.priority)+"'");
    if (req.query.assignmentGroup) w.push("ag.group_name='"+safe(req.query.assignmentGroup)+"'");
    if (req.query.requestedBy)     w.push("u.full_name='"+safe(req.query.requestedBy)+"'");
    if (req.query.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(req.query.fromDate))
      w.push("r.planned_start_date>=TO_DATE('"+req.query.fromDate+"','YYYY-MM-DD')");
    if (req.query.toDate && /^\d{4}-\d{2}-\d{2}$/.test(req.query.toDate))
      w.push("r.planned_start_date<=TO_DATE('"+req.query.toDate+"','YYYY-MM-DD')");
    const WHERE = 'WHERE '+w.join(' AND ');
    const cRow  = await db.queryOne(
      'SELECT COUNT(*) AS total FROM crms_releases r '+
      'LEFT JOIN crms_assignment_groups ag ON ag.group_id=r.assignment_group_id '+
      'LEFT JOIN crms_users u ON u.user_id=r.requested_by '+WHERE, {}
    );
    const rows = await db.query(
      'SELECT r.release_id,r.release_number,r.state,r.priority,r.title,'+
      'r.planned_start_date,r.target_end_date,r.company,r.service,r.created_at,'+
      'r.module_id,m.module_name,r.cr_owner_user_id,uco.full_name AS cr_owner_name,'+
      'u.full_name AS requested_by,u2.full_name AS assigned_to,ag.group_name AS assignment_group '+
      'FROM crms_releases r '+
      'LEFT JOIN crms_users u  ON u.user_id=r.requested_by '+
      'LEFT JOIN crms_users u2 ON u2.user_id=r.assigned_to_user_id '+
      'LEFT JOIN crms_assignment_groups ag ON ag.group_id=r.assignment_group_id '+
      'LEFT JOIN crms_modules m   ON m.module_id=r.module_id '+
      'LEFT JOIN crms_users uco   ON uco.user_id=r.cr_owner_user_id '+
      WHERE+' ORDER BY r.created_at DESC OFFSET '+offset+' ROWS FETCH NEXT '+limit+' ROWS ONLY', {}
    );
    return res.json({
      data: rows.map(camelizeRelease),
      pagination:{ page, pageSize:limit, total:Number(cRow.TOTAL), totalPages:Math.ceil(Number(cRow.TOTAL)/limit) },
    });
  } catch(err) { next(err); }
}

// ── GET /releases/:releaseId ──────────────────────────────────────────
async function getOne(req, res, next) {
  try {
    const rid = num(req.params.releaseId);
    const row = await db.queryOne(
      'SELECT r.release_id,r.release_number,r.state,r.priority,r.title,r.summary,'+
      'r.company,r.service,r.planned_start_date,r.target_end_date,r.created_at,r.updated_at,'+
      'r.module_id,r.current_approval_level,r.assignment_group_id,r.cr_owner_user_id,'+
      'r.reason_of_change,r.business_benefits_process,r.business_benefits_qualitative,'+
      'r.cost_saving,r.manpower_saving,r.cemli,r.smartsheet_id,r.process_name,'+
      'u.full_name AS requested_by,u.user_id AS requested_by_user_id,'+
      'u2.full_name AS assigned_to,u2.user_id AS assigned_to_user_id,'+
      'u3.full_name AS cr_owner_name,'+
      'ag.group_name AS assignment_group '+
      'FROM crms_releases r '+
      'LEFT JOIN crms_users u  ON u.user_id=r.requested_by '+
      'LEFT JOIN crms_users u2 ON u2.user_id=r.assigned_to_user_id '+
      'LEFT JOIN crms_users u3 ON u3.user_id=r.cr_owner_user_id '+
      'LEFT JOIN crms_assignment_groups ag ON ag.group_id=r.assignment_group_id '+
      'WHERE r.release_id='+rid+' AND r.is_deleted=0', {}
    );
    if (!row) return res.status(404).json({ error:'Release not found' });

    const hist = await db.query(
      'SELECT h.action,h.from_state,h.to_state,h.changed_at,u.full_name AS changed_by '+
      'FROM crms_release_history h JOIN crms_users u ON u.user_id=h.changed_by '+
      'WHERE h.release_id='+rid+' ORDER BY h.changed_at ASC', {}
    );
    const approvalTrail = await db.query(
      'SELECT ra.phase_code,ra.level_order,ra.status,ra.comments,ra.actioned_at,'+
      'ra.approver_user_id,u.full_name AS approver_name '+
      'FROM crms_release_approvals ra JOIN crms_users u ON u.user_id=ra.approver_user_id '+
      'WHERE ra.release_id='+rid+' ORDER BY ra.phase_code,ra.level_order', {}
    );
    const phaseTasks = await db.query(
      'SELECT rt.task_id,rt.task_number,rt.phase_code,rt.state,rt.short_description,'+
      'rt.priority,rt.description,rt.template_downloaded,rt.upload_attachment_id,'+
      'rt.planned_start_date,rt.planned_end_date,rt.actual_start_date,rt.actual_end_date,'+
      'rt.reason_for_reject,rt.closed_at,rt.created_at,rt.delay_reason,'+
      'rt.cemli,rt.smartsheet_id,rt.process_name,'+
      'u.full_name AS assigned_to,u.user_id AS assigned_to_id,'+
      'ag.group_name AS assignment_group '+
      'FROM crms_release_tasks rt '+
      'LEFT JOIN crms_users u ON u.user_id=rt.assigned_to '+
      'LEFT JOIN crms_assignment_groups ag ON ag.group_id=rt.assignment_group_id '+
      'WHERE rt.release_id='+rid+' ORDER BY rt.phase_code,rt.created_at', {}
    );

    const grpId = row.ASSIGNMENT_GROUP_ID;
    let groupMembers = [];
    if (grpId) {
      groupMembers = await db.query(
        'SELECT u.user_id,u.full_name FROM crms_group_members gm '+
        'JOIN crms_users u ON u.user_id=gm.user_id '+
        'WHERE gm.group_id='+num(String(grpId))+' AND u.is_active=1 ORDER BY u.full_name', {}
      );
    }
    // Per-release phase group overrides
    const releasePhaseGroups = await db.query(
      'SELECT rpg.phase_code,rpg.group_id,ag.group_name '+
      'FROM crms_release_phase_groups rpg '+
      'JOIN crms_assignment_groups ag ON ag.group_id=rpg.group_id '+
      'WHERE rpg.release_id='+rid+' ORDER BY rpg.phase_code', {}
    ).catch(function() { return []; });

    // Get available approvers for current phase (for dynamic approver selection)
    const phaseCode = stateToPhaseCode(row.STATE);
    let phaseApprovers = [];
    if (phaseCode && row.MODULE_ID) {
      phaseApprovers = await db.query(
        'SELECT DISTINCT u.user_id,u.full_name '+
        'FROM crms_approval_flows af '+
        'JOIN crms_users u ON u.user_id=af.approver_user_id '+
        'WHERE af.module_id='+num(String(row.MODULE_ID))+
        " AND af.phase_code='"+phaseCode+"' AND (af.auto_approve IS NULL OR af.auto_approve=0)"+
        ' ORDER BY u.full_name', {}
      );
    }

    // Get ALL reviewers for this module keyed by phase
    // Resolve phaseCode — also handle approval-waiting states
    let resolvedPhase = phaseCode;
    if (!resolvedPhase && row.STATE) {
      const s = row.STATE;
      if      (s.includes('RD'))          resolvedPhase = 'RD';
      else if (s.includes('FSD'))         resolvedPhase = 'FSD';
      else if (s.includes('Development')) resolvedPhase = 'DEV';
      else if (s.includes('Testing'))     resolvedPhase = 'TESTING';
      else if (s.includes('UAT'))         resolvedPhase = 'UAT';
      else if (s.includes('Deployment'))  resolvedPhase = 'DEPLOYMENT';
    }
    let phaseReviewers = [];
    if (row.MODULE_ID) {
      phaseReviewers = await db.query(
        'SELECT pr.user_id,u.full_name,pr.group_id,ag.group_name,pr.phase_code '+
        'FROM crms_phase_reviewers pr '+
        'JOIN crms_users u ON u.user_id=pr.user_id '+
        'JOIN crms_assignment_groups ag ON ag.group_id=pr.group_id '+
        'WHERE pr.module_id='+num(String(row.MODULE_ID))+
        (resolvedPhase ? " AND pr.phase_code='"+resolvedPhase+"'" : '')+
        ' ORDER BY u.full_name', {}
      ).catch(function(){ return []; });
    }

    return res.json({
      ...camelizeRelease(row),
      summary:              row.SUMMARY||'',
      reasonOfChange:       row.REASON_OF_CHANGE||'',
      businessBenefitsProcess: row.BUSINESS_BENEFITS_PROCESS||'',
      businessBenefitsQualitative: row.BUSINESS_BENEFITS_QUALITATIVE||'',
      costSaving:           row.COST_SAVING||'',
      manpowerSaving:       row.MANPOWER_SAVING||'',
      moduleId:             row.MODULE_ID,
      currentApprovalLevel: Number(row.CURRENT_APPROVAL_LEVEL||0),
      requestedByUserId:    row.REQUESTED_BY_USER_ID,
      assignedToUserId:     row.ASSIGNED_TO_USER_ID,
      assignmentGroupId:    row.ASSIGNMENT_GROUP_ID,
      crOwnerUserId:        row.CR_OWNER_USER_ID || null,
      crOwnerName:          row.CR_OWNER_NAME    || '',
      cemli:                row.CEMLI            || '',
      smartsheetId:         row.SMARTSHEET_ID    || '',
      processName:          row.PROCESS_NAME     || '',
      phaseApprovers: phaseApprovers.map(a=>({ userId:a.USER_ID, fullName:a.FULL_NAME })),
      phaseReviewers: phaseReviewers.map(a=>({ userId:a.USER_ID, fullName:a.FULL_NAME, groupId:a.GROUP_ID, groupName:a.GROUP_NAME, phaseCode:a.PHASE_CODE })),
      approvalTrail: approvalTrail.map(a=>({
        phaseCode:a.PHASE_CODE, levelOrder:Number(a.LEVEL_ORDER),
        status:a.STATUS, approverName:a.APPROVER_NAME,
        approverUserId:a.APPROVER_USER_ID,
        comments:a.COMMENTS, actionedAt:a.ACTIONED_AT,
      })),
      phaseTasks: phaseTasks.map(t=>({
        taskId:t.TASK_ID, taskNumber:t.TASK_NUMBER, phaseCode:t.PHASE_CODE,
        taskType:phaseLabel(t.PHASE_CODE), state:t.STATE,
        shortDescription:t.SHORT_DESCRIPTION, priority:t.PRIORITY,
        description:t.DESCRIPTION, templateDownloaded:!!t.TEMPLATE_DOWNLOADED,
        uploadAttachmentId:t.UPLOAD_ATTACHMENT_ID,
        plannedStartDate: t.PLANNED_START_DATE ? (t.PLANNED_START_DATE instanceof Date ? t.PLANNED_START_DATE.toISOString().slice(0,10) : String(t.PLANNED_START_DATE).slice(0,10)) : null,
        plannedEndDate:   t.PLANNED_END_DATE   ? (t.PLANNED_END_DATE   instanceof Date ? t.PLANNED_END_DATE.toISOString().slice(0,10)   : String(t.PLANNED_END_DATE).slice(0,10))   : null,
        actualStartDate:  t.ACTUAL_START_DATE  ? (t.ACTUAL_START_DATE  instanceof Date ? t.ACTUAL_START_DATE.toISOString().slice(0,10)  : String(t.ACTUAL_START_DATE).slice(0,10))  : null,
        actualEndDate:    t.ACTUAL_END_DATE    ? (t.ACTUAL_END_DATE    instanceof Date ? t.ACTUAL_END_DATE.toISOString().slice(0,10)    : String(t.ACTUAL_END_DATE).slice(0,10))    : null,
        reasonForReject:t.REASON_FOR_REJECT, delayReason:t.DELAY_REASON, closedAt:t.CLOSED_AT, createdAt:t.CREATED_AT,
        assignedTo:t.ASSIGNED_TO, assignedToId:t.ASSIGNED_TO_ID,
        assignmentGroup:t.ASSIGNMENT_GROUP,
      })),
      groupMembers: groupMembers.map(m=>({ userId:m.USER_ID, fullName:m.FULL_NAME })),
      releasePhaseGroups: releasePhaseGroups.map(function(r) {
        return { phaseCode: r.PHASE_CODE, groupId: r.GROUP_ID, groupName: r.GROUP_NAME };
      }),
      history: hist.map(h=>({
        action:h.ACTION, fromState:h.FROM_STATE, toState:h.TO_STATE,
        changedBy:h.CHANGED_BY, changedAt:h.CHANGED_AT,
      })),
    });
  } catch(err) { next(err); }
}

// ── POST /releases ────────────────────────────────────────────────────
const createValidation = [
  body('priority').isIn(['1','2','3','4']),
  body('title').trim().notEmpty(),
  body('summary').trim().notEmpty(),
  body('plannedStartDate').optional({nullable:true, checkFalsy:true}).isISO8601(),
  body('targetEndDate').optional({nullable:true}).isISO8601(),
  validate,
];

async function create(req, res, next) {
  try {
    const { priority,title,summary,company,service,plannedStartDate,targetEndDate,
            assignmentGroupId,assignedToUserId,moduleId,
            reasonOfChange,businessBenefitsProcess,businessBenefitsQualitative,
            costSaving,manpowerSaving,
            phaseGroupAssignments } = req.body;  // [{phaseCode, groupId}]
    const reqBy = num(req.user.userId);
    const agVal = assignmentGroupId ? num(assignmentGroupId) : 'NULL';
    const atVal = assignedToUserId  ? num(assignedToUserId)  : 'NULL';
    const midVal = moduleId         ? num(moduleId)           : 'NULL';

    // Get fallback module from user's group
    let resolvedModId = midVal;
    if (resolvedModId === 'NULL') {
      const modRow = await db.queryOne(
        'SELECT pg.module_id FROM crms_phase_groups pg '+
        'JOIN crms_group_members gm ON gm.group_id=pg.group_id '+
        'WHERE gm.user_id='+reqBy+' FETCH FIRST 1 ROWS ONLY', {}
      );
      if (!modRow) {
        const fallback = await db.queryOne(
          "SELECT module_id FROM crms_modules WHERE is_active=1 ORDER BY module_id FETCH FIRST 1 ROWS ONLY", {}
        );
        if (fallback) resolvedModId = num(fallback.MODULE_ID);
      } else {
        resolvedModId = num(modRow.MODULE_ID);
      }
    }

    const seqRow = await db.queryOne('SELECT crms_release_seq.NEXTVAL AS seq FROM dual', {});
    const rlseNum = 'RLSE'+String(Number(seqRow.SEQ)).padStart(7,'0');

    await db.executeWithCommit(
      "INSERT INTO crms_releases(release_number,state,requested_by,priority,title,summary,"+
      "company,service,planned_start_date,target_end_date,assignment_group_id,"+
      "assigned_to_user_id,module_id,"+
      "reason_of_change,business_benefits_process,business_benefits_qualitative,"+
      "cost_saving,manpower_saving) "+
      "VALUES('"+rlseNum+"','RD Phase',"+reqBy+",'"+safe(priority)+"','"+safe(title)+"','"+safe(summary)+"',"+
      "'"+safe(company||'')+"','"+safe(service||'')+"',"+safeDate(plannedStartDate)+","+safeDate(targetEndDate)+","+
      agVal+","+atVal+","+resolvedModId+","+
      "'"+safe(reasonOfChange||'')+"','"+safe(businessBenefitsProcess||'')+"','"+safe(businessBenefitsQualitative||'')+"',"+
      "'"+safe(costSaving||'')+"','"+safe(manpowerSaving||'')+"')", {}
    );
    const relRow = await db.queryOne("SELECT release_id FROM crms_releases WHERE release_number='"+rlseNum+"'", {});
    const releaseId = num(relRow.RELEASE_ID);
    await db.executeWithCommit(
      "INSERT INTO crms_release_history(release_id,action,from_state,to_state,changed_by) VALUES("+
      releaseId+",'Created',NULL,'RD Phase',"+reqBy+")", {}
    );
    // Store per-phase group overrides if provided
    if (Array.isArray(phaseGroupAssignments) && phaseGroupAssignments.length) {
      for (const pg of phaseGroupAssignments) {
        if (!pg.phaseCode || !pg.groupId) continue;
        const existing = await db.queryOne(
          "SELECT rpg_id FROM crms_release_phase_groups WHERE release_id="+releaseId+" AND phase_code='"+safe(pg.phaseCode)+"'", {}
        );
        if (existing) {
          await db.executeWithCommit(
            "UPDATE crms_release_phase_groups SET group_id="+num(pg.groupId)+" WHERE release_id="+releaseId+" AND phase_code='"+safe(pg.phaseCode)+"'", {}
          );
        } else {
          await db.executeWithCommit(
            "INSERT INTO crms_release_phase_groups(release_id,phase_code,group_id) VALUES("+releaseId+",'"+safe(pg.phaseCode)+"',"+num(pg.groupId)+")", {}
          );
        }
      }
    }
    if (reqBy && reqBy !== '0') {
      await db.executeWithCommit(
        "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES("+
        "'Created',"+reqBy+",'"+rlseNum+"','"+safe(rlseNum+' created - RD Phase')+"')", {}
      );
    }
    logger.info('Release created', { releaseId, number:rlseNum });
      // Auto-create Task List row on CR creation
      setImmediate(async function() {
        try {
          const tlRel = await db.queryOne(
            'SELECT r.title,r.company,r.requested_by,m.module_name,u.full_name AS rbn '+
            'FROM crms_releases r LEFT JOIN crms_modules m ON m.module_id=r.module_id '+
            'LEFT JOIN crms_users u ON u.user_id=r.requested_by WHERE r.release_id='+releaseId,{}
          );
          if (tlRel) await taskListCtrl.createOnCRCreate({
            releaseNumber:rlseNum, title:tlRel.TITLE||'', requestedByName:tlRel.RBN||'',
            company:tlRel.COMPANY||'', moduleName:tlRel.MODULE_NAME||'', createdBy:reqBy,
          });
        } catch(e) { logger.warn('[TL] createOnCRCreate failed',{e:e.message}); }
      });
    return res.status(201).json({ releaseId:Number(releaseId), releaseNumber:rlseNum, state:'RD Phase' });
  } catch(err) { next(err); }
}

// ── PATCH /releases/:releaseId/advance ───────────────────────────────
// Body: { selectedApproverId? } — dynamic approver override
async function advanceState(req, res, next) {
  try {
    const rid   = num(req.params.releaseId);
    const force = (req.body||{}).force;
    const uid   = num(req.user.userId);
    const selectedApproverId = (req.body||{}).selectedApproverId;

    const release = await db.queryOne(
      'SELECT release_id,state,release_number,module_id,assigned_to_user_id,requested_by '+
      'FROM crms_releases WHERE release_id='+rid+' AND is_deleted=0', {}
    );
    if (!release) return res.status(404).json({ error:'Release not found' });
    const cur    = release.STATE;
    const relNum = release.RELEASE_NUMBER;
    const modId  = release.MODULE_ID;
    if (TERMINAL_STATES.includes(cur)) return res.status(400).json({ error:'Cannot advance from terminal state: '+cur });

    // Force On Hold / Cancelled
    if (force) {
      if (!['On Hold','Cancelled'].includes(force)) return res.status(400).json({ error:'Only On Hold or Cancelled can be forced' });
      await writeStateChange(rid,relNum,cur,force,uid,release.ASSIGNED_TO_USER_ID);
      return res.json({ releaseId:Number(rid), fromState:cur, toState:force });
    }

    // Phases that trigger approval (with dynamic approver support)
    const approvalPhases = { 'RD Phase':'RD', 'FSD Phase':'FSD', 'Deployment Phase':'DEPLOYMENT' };
    if (approvalPhases[cur]) {
      const phaseCode = approvalPhases[cur];
      // Sub-task gate — NOT required for RD phase, required for FSD and Deployment
      if (phaseCode !== 'RD') {
        const anyTask = await db.queryOne(
          "SELECT task_id FROM crms_release_tasks WHERE release_id="+rid+" AND phase_code='"+phaseCode+"' FETCH FIRST 1 ROWS ONLY", {}
        );
        if (!anyTask) return res.status(400).json({
          error:'At least one sub-task must be created for the '+cur+' before submitting for approval. Click "+ Add Sub-Task" in the Sub-Tasks tab.'
        });
        const openTask = await db.queryOne(
          "SELECT task_id,task_number FROM crms_release_tasks WHERE release_id="+rid+" AND phase_code='"+phaseCode+"' AND state='Open' FETCH FIRST 1 ROWS ONLY", {}
        );
        if (openTask) return res.status(400).json({
          error:'Sub-task '+openTask.TASK_NUMBER+' is still open. Close it before submitting for approval.'
        });
      }
      // Trigger approval — pass selected approver if provided
      const r = await getApprCtrl().triggerApproval(rid,relNum,uid,modId,phaseCode,selectedApproverId);
      if (r.error) return res.status(400).json({ error:r.error });
      // Auto-create Task List row when RD Phase is submitted
      if (phaseCode === 'RD') {
        const relDetails = await db.queryOne(
          'SELECT r.title,r.company,r.module_id,ag.group_name,u.full_name AS rbn,'+
          'uco.full_name AS cr_owner_name,m.module_name '+
          'FROM crms_releases r '+
          'LEFT JOIN crms_assignment_groups ag ON ag.group_id=r.assignment_group_id '+
          'LEFT JOIN crms_users u ON u.user_id=r.requested_by '+
          'LEFT JOIN crms_users uco ON uco.user_id=r.cr_owner_user_id '+
          'LEFT JOIN crms_modules m ON m.module_id=r.module_id '+
          'WHERE r.release_id='+rid, {}
        );
        if (relDetails) {
          const grp = (relDetails.GROUP_NAME||'').split(/[-_]/)[0].toUpperCase();
          setImmediate(function() {
            taskListCtrl.createOnCRCreate({
              releaseNumber:  relNum,
              title:          relDetails.TITLE||'',
              requestedByName:relDetails.RBN||'',
              moduleName:     relDetails.MODULE_NAME||'',
              company:        relDetails.COMPANY||'',
              project:        relDetails.COMPANY||grp,
              createdBy:      uid,
            });
          });
        }
      }
      if (r.autoApproved) {
        if (uid && uid !== '0') await db.executeWithCommit("INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES('State Change',"+uid+",'"+relNum+"','"+safe(cur)+" -> "+safe(r.newState||AFTER_APPROVAL[phaseCode])+" (auto-approved)')", {});
        return res.json({ releaseId:Number(rid), fromState:cur, toState:r.newState||AFTER_APPROVAL[phaseCode], autoApproved:true });
      }
      if (uid && uid !== '0') await db.executeWithCommit("INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES('State Change',"+uid+",'"+relNum+"','"+safe(cur)+" -> "+safe(r.newState)+"')", {});
      return res.json({ releaseId:Number(rid), fromState:cur, toState:r.newState, pendingWith:r.approverName, flowType:phaseCode });
    }

    // Manual advance phases (sub-task required)
    if (MANUAL_ADVANCE[cur]) {
      const phaseMap = { 'Development Phase':'DEV','Testing Phase':'TESTING','UAT Phase':'UAT' };
      const checkPhase = phaseMap[cur];
      if (checkPhase) {
        const anyTask2 = await db.queryOne(
          "SELECT task_id FROM crms_release_tasks WHERE release_id="+rid+" AND phase_code='"+checkPhase+"' FETCH FIRST 1 ROWS ONLY", {}
        );
        if (!anyTask2) {
          // No sub-task created — soft warning, allow advance if user confirms
          if (!(req.body && req.body.confirmed)) {
            return res.json({
              warning: true,
              warningMsg: 'No sub-task has been created for the '+cur+'. Do you want to advance without creating one?',
              releaseId: Number(rid), fromState: cur
            });
          }
          // confirmed=true → fall through and advance
        } else {
          // Sub-task(s) exist — check none are still open
          const openTask2 = await db.queryOne(
            "SELECT task_id,task_number FROM crms_release_tasks WHERE release_id="+rid+" AND phase_code='"+checkPhase+"' AND state='Open' FETCH FIRST 1 ROWS ONLY", {}
          );
          if (openTask2) return res.status(400).json({
            error: 'Sub-task '+openTask2.TASK_NUMBER+' is still open. Please close it before advancing.'
          });
        }
      }
      const next = MANUAL_ADVANCE[cur];
      await writeStateChange(rid,relNum,cur,next,uid,release.ASSIGNED_TO_USER_ID);
      return res.json({ releaseId:Number(rid), fromState:cur, toState:next });
    }

    // Closed Deployment Phase → Closed (final close after deployment)
    if (cur === 'Deployment Phase') {
      await writeStateChange(rid,relNum,cur,'Closed',uid,release.ASSIGNED_TO_USER_ID);
      return res.json({ releaseId:Number(rid), fromState:cur, toState:'Closed' });
    }

    return res.status(400).json({ error:'No transition defined from: '+cur });
  } catch(err) { next(err); }
}

// ── POST /releases/:releaseId/phase-tasks ─────────────────────────────
async function createPhaseTask(req, res, next) {
  try {
    const rid = num(req.params.releaseId);
    const uid = num(req.user.userId);
    const { phaseCode, shortDescription, assignmentGroupId, assignedToUserId,
            priority, description, plannedStartDate, plannedEndDate,
            cemli, smartsheetId, processName } = req.body;
    if (!phaseCode)         return res.status(422).json({ error:'phaseCode required' });
    if (!shortDescription)  return res.status(422).json({ error:'Short description required' });
    if (!assignmentGroupId) return res.status(422).json({ error:'Assignment group required' });
    // plannedStartDate and plannedEndDate are optional — entered later by the assignee
    const release = await db.queryOne('SELECT release_number,state,module_id FROM crms_releases WHERE release_id='+rid, {});
    if (!release) return res.status(404).json({ error:'Release not found' });
    // Multiple sub-tasks per phase are allowed
    const agVal = num(assignmentGroupId);
    const atVal = assignedToUserId ? num(assignedToUserId) : 'NULL';
    const prioVal = priority ? "'"+safe(priority)+"'" : 'NULL';
    const seqRow  = await db.queryOne('SELECT crms_rtask_seq.NEXTVAL AS seq FROM dual', {});
    const taskNum = 'RTSK'+String(Number(seqRow.SEQ)).padStart(7,'0');
    await db.executeWithCommit(
      "INSERT INTO crms_release_tasks(task_number,release_id,phase_code,short_description,"+
      "assignment_group_id,assigned_to,priority,description,"+
      "planned_start_date,planned_end_date,cemli,smartsheet_id,process_name) "+
      "VALUES('"+taskNum+"',"+rid+",'"+safe(phaseCode)+"','"+safe(shortDescription)+"',"+
      agVal+","+atVal+","+prioVal+",'"+safe(description||'')+"',"+
      safeDate(plannedStartDate)+","+safeDate(plannedEndDate)+","+
      (cemli?"'"+safe(cemli)+"'":"NULL")+","+
      (smartsheetId?"'"+safe(smartsheetId)+"'":"NULL")+","+
      (processName?"'"+safe(processName)+"'":"NULL")+")", {}
    );
    if (uid && uid !== '0') await db.executeWithCommit("INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES('Task Created',"+uid+",'"+release.RELEASE_NUMBER+"','"+taskNum+" ("+phaseCode+") created')", {});
    if (assignedToUserId && num(assignedToUserId) !== 0) {
      await db.executeWithCommit("INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+num(assignedToUserId)+",'Sub-Task Assigned: "+taskNum+"','"+safe(taskNum+' — '+phaseCode+' task on '+release.RELEASE_NUMBER)+"',"+rid+")", {});
    }
    logger.info('Phase task created', { taskNum, phaseCode, releaseId:rid });

    // ── Upsert Task List row (fire-and-forget, always) ─────────────
    setImmediate(async function() {
      try {
        const relFull = await db.queryOne(
          'SELECT r.release_number,r.title,r.company,r.module_id,r.requested_by,'+
          'r.cr_owner_user_id,ag.group_name,m.module_name,'+
          'ur.full_name AS rbn,uco.full_name AS cron '+
          'FROM crms_releases r '+
          'LEFT JOIN crms_assignment_groups ag ON ag.group_id=r.assignment_group_id '+
          'LEFT JOIN crms_modules m ON m.module_id=r.module_id '+
          'LEFT JOIN crms_users ur ON ur.user_id=r.requested_by '+
          'LEFT JOIN crms_users uco ON uco.user_id=r.cr_owner_user_id '+
          'WHERE r.release_id='+rid, {}
        );
        const asgRow = assignedToUserId && num(assignedToUserId) !== 0
          ? await db.queryOne('SELECT full_name FROM crms_users WHERE user_id='+num(assignedToUserId), {})
          : null;
        if (relFull) {
          const grp = (relFull.GROUP_NAME||'').split(/[-_]/)[0].toUpperCase();
          await taskListCtrl.upsertFromSubTask({
            releaseNumber:   relFull.RELEASE_NUMBER,
            title:           relFull.TITLE||'',
            requestedByName: relFull.RBN||'',
            moduleName:      relFull.MODULE_NAME||'',
            crOwnerName:     relFull.CRON||'',
            company:         relFull.COMPANY||'',
            project:         relFull.COMPANY||grp,
            phaseCode:       phaseCode,
            assigneeName:    asgRow ? asgRow.FULL_NAME : '',
            createdBy:       uid,
            cemli:           cemli||'',
            smartsheetId:    smartsheetId||'',
            processName:     processName||'',
            plannedStartDate: plannedStartDate||'',
            plannedEndDate:   plannedEndDate||'',
          });
        }
      } catch(e) { logger.warn('[TaskList] upsertFromSubTask failed', {e:e.message}); }
    });

    return res.status(201).json({ taskId:taskNum, taskNumber:taskNum, message:'Task '+taskNum+' created' });
  } catch(err) { next(err); }
}

// ── PATCH /releases/:releaseId/phase-tasks/:taskId ─────────────────
async function updatePhaseTask(req, res, next) {
  try {
    const rid    = num(req.params.releaseId);
    const taskId = num(req.params.taskId);
    const uid    = num(req.user.userId);
    const task   = await db.queryOne(
      "SELECT rt.task_id,rt.state,rt.assigned_to,r.requested_by,r.assigned_to_user_id AS release_assignee "+
      "FROM crms_release_tasks rt JOIN crms_releases r ON r.release_id=rt.release_id "+
      "WHERE rt.task_id="+taskId+" AND rt.release_id="+rid, {}
    );
    if (!task) return res.status(404).json({ error:'Task not found' });
    if (task.STATE === 'Closed') return res.status(400).json({ error:'Cannot edit a closed task' });
    // Permission: admin, task assignee, CR requester, or CR assigned-to user can edit
    const isAdmin2     = req.user.role === 'admin';
    const isTaskAssign = num(task.ASSIGNED_TO) === uid;
    const isCrOwner    = num(task.REQUESTED_BY) === uid;
    const isCrAssignee = num(task.RELEASE_ASSIGNEE) === uid;
    if (!isAdmin2 && !isTaskAssign && !isCrOwner && !isCrAssignee) {
      return res.status(403).json({ error:'Only the task assignee, CR owner, or admin can edit this task.' });
    }
    const { assignmentGroupId, assignedToUserId, plannedStartDate, plannedEndDate,
            actualStartDate, actualCompletionDate, delayReason } = req.body;
    const setParts = [];
    if (assignmentGroupId    !== undefined) setParts.push('assignment_group_id='+num(assignmentGroupId));
    if (assignedToUserId     !== undefined) setParts.push('assigned_to='+num(assignedToUserId));
    if (plannedStartDate     !== undefined) setParts.push('planned_start_date='+safeDate(plannedStartDate));
    if (plannedEndDate       !== undefined) setParts.push('planned_end_date='+safeDate(plannedEndDate));
    if (actualStartDate      !== undefined) setParts.push('actual_start_date='+safeDate(actualStartDate));
    if (actualCompletionDate !== undefined) setParts.push('actual_end_date='+safeDate(actualCompletionDate));
    if (delayReason          !== undefined) setParts.push('delay_reason=\''+safe(delayReason)+'\'');
    if (!setParts.length) return res.status(422).json({ error:'Nothing to update' });
    await db.executeWithCommit('UPDATE crms_release_tasks SET '+setParts.join(',')+' WHERE task_id='+taskId, {});
    if (assignedToUserId && num(assignedToUserId) !== num(task.ASSIGNED_TO)) {
      const rel = await db.queryOne('SELECT release_number FROM crms_releases WHERE release_id='+rid, {});
      await db.executeWithCommit("INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+num(assignedToUserId)+",'Sub-Task Reassigned','"+safe('You have been assigned a sub-task on '+(rel?rel.RELEASE_NUMBER:''))+"',"+rid+")", {});
    }
    return res.json({ message:'Task updated' });
  } catch(err) { logger.error("updatePhaseTask error: "+err.message, { taskId: req.params.taskId }); next(err); }
}

// ── GET /releases/:releaseId/phase-tasks ─────────────────────────────
async function getPhaseTasks(req, res, next) {
  try {
    const rid   = num(req.params.releaseId);
    const phase = req.query.phase;
    let where   = 'WHERE rt.release_id='+rid;
    if (phase) where += " AND rt.phase_code='"+safe(phase.toUpperCase())+"'";
    const rows = await db.query(
      'SELECT rt.task_id,rt.task_number,rt.phase_code,rt.state,rt.short_description,'+
      'rt.priority,rt.description,rt.template_downloaded,rt.upload_attachment_id,'+
      'rt.planned_start_date,rt.planned_end_date,rt.actual_start_date,rt.actual_end_date,'+
      'rt.reason_for_reject,rt.closed_at,rt.created_at,rt.delay_reason,'+
      'rt.cemli,rt.smartsheet_id,rt.process_name,'+
      'u.full_name AS assigned_to,u.user_id AS assigned_to_id,'+
      'ag.group_name AS assignment_group '+
      'FROM crms_release_tasks rt '+
      'LEFT JOIN crms_users u ON u.user_id=rt.assigned_to '+
      'LEFT JOIN crms_assignment_groups ag ON ag.group_id=rt.assignment_group_id '+
      where+' ORDER BY rt.phase_code,rt.created_at', {}
    );
    return res.json(rows.map(r=>({
      taskId:r.TASK_ID, taskNumber:r.TASK_NUMBER, phaseCode:r.PHASE_CODE,
      taskType:phaseLabel(r.PHASE_CODE), state:r.STATE,
      shortDescription:r.SHORT_DESCRIPTION, priority:r.PRIORITY, description:r.DESCRIPTION,
      templateDownloaded:!!r.TEMPLATE_DOWNLOADED, uploadAttachmentId:r.UPLOAD_ATTACHMENT_ID,
      plannedStartDate:r.PLANNED_START_DATE, plannedEndDate:r.PLANNED_END_DATE,
      actualStartDate:r.ACTUAL_START_DATE, actualEndDate:r.ACTUAL_END_DATE,
      reasonForReject:r.REASON_FOR_REJECT, closedAt:r.CLOSED_AT, createdAt:r.CREATED_AT,
      assignedTo:r.ASSIGNED_TO, assignedToId:r.ASSIGNED_TO_ID, assignmentGroup:r.ASSIGNMENT_GROUP,
      cemli:r.CEMLI||'', smartsheetId:r.SMARTSHEET_ID||'', processName:r.PROCESS_NAME||'',
    })));
  } catch(err) { next(err); }
}

// ── PATCH /releases/:releaseId/phase-tasks/:taskId/close ─────────────
async function closePhaseTask(req, res, next) {
  try {
    const rid    = num(req.params.releaseId);
    const taskId = num(req.params.taskId);
    const uid    = num(req.user.userId);
    const task   = await db.queryOne("SELECT task_id,phase_code,assigned_to,state,upload_attachment_id FROM crms_release_tasks WHERE task_id="+taskId+" AND release_id="+rid, {});
    if (!task) return res.status(404).json({ error:'Task not found' });
    if (task.STATE==='Closed') return res.status(400).json({ error:'Task already closed' });
    // Allow: admin, assigned person, or CR owner/assignee
    const assignedTo = task.ASSIGNED_TO ? String(task.ASSIGNED_TO) : null;
    if (req.user.role !== 'admin' && assignedTo && assignedTo !== String(req.user.userId))
      return res.status(403).json({ error:'Only the assigned person or admin can close this task' });
    // Document upload is optional for closing — removed mandatory check
    // Use user-provided actual_end_date if already set, otherwise use SYSDATE
    const existingEnd = await db.queryOne('SELECT actual_end_date FROM crms_release_tasks WHERE task_id='+taskId, {});
    const endDateExpr = (existingEnd && existingEnd.ACTUAL_END_DATE) ? 'actual_end_date' : 'SYSDATE';
    await db.executeWithCommit('UPDATE crms_release_tasks SET state=\'Closed\',closed_by='+uid+',closed_at=SYSDATE,actual_end_date='+endDateExpr+' WHERE task_id='+taskId, {});

    // ── UAT task closed → auto-reassign CR to CR Owner ─────────────
    if (task.PHASE_CODE === 'UAT') {
      try {
        const crOwnerRow = await db.queryOne(
          'SELECT cr_owner_user_id FROM crms_releases WHERE release_id='+rid, {}
        );
        if (crOwnerRow && crOwnerRow.CR_OWNER_USER_ID) {
          await db.executeWithCommit(
            'UPDATE crms_releases SET assigned_to_user_id='+crOwnerRow.CR_OWNER_USER_ID+
            ' WHERE release_id='+rid, {}
          );
          logger.info('CR reassigned to CR Owner after UAT close', { rid, crOwnerUserId: crOwnerRow.CR_OWNER_USER_ID });
        }
      } catch(e) { logger.warn('UAT close reassign failed', {e:e.message}); }
    }

    // ── Update Task List pending_with after task close ───────────────
    try {
      const relRow = await db.queryOne('SELECT release_number FROM crms_releases WHERE release_id='+rid, {});
      if (relRow) {
        setImmediate(function() {
          taskListCtrl.updatePhaseDate(relRow.RELEASE_NUMBER, 'task_closed_'+task.PHASE_CODE, uid.toString()).catch(function(){});
        });
      }
    } catch(e) {}

    return res.json({ message:'Task closed' });
  } catch(err) { next(err); }
}

// ── POST /releases/:releaseId/phase-tasks/:taskId/upload ─────────────
async function uploadTaskDocument(req, res, next) {
  try {
    const rid    = num(req.params.releaseId);
    const taskId = num(req.params.taskId);
    const uid    = num(req.user.userId);
    const { fileName, fileType, fileSize, fileData } = req.body;
    if (!fileName || !fileData) return res.status(422).json({ error:'fileName and fileData required' });
    const task = await db.queryOne("SELECT task_id,phase_code,state FROM crms_release_tasks WHERE task_id="+taskId+" AND release_id="+rid, {});
    if (!task) return res.status(404).json({ error:'Task not found' });
    if (task.STATE==='Closed') return res.status(400).json({ error:'Cannot upload to a closed task' });
    const rel = await db.queryOne("SELECT release_number FROM crms_releases WHERE release_id="+rid, {});
    const fsVal = fileSize ? num(String(Math.floor(fileSize))) : 'NULL';
    await db.executeWithCommit("INSERT INTO crms_attachments(release_id,file_name,file_type,file_size,file_data,uploaded_by,phase_code,task_id) VALUES("+rid+",'"+safe(fileName)+"','"+safe(fileType||'')+"',"+fsVal+",TO_CLOB('"+safe(fileData.substring(0,4000))+"'),"+uid+",'"+task.PHASE_CODE+"',"+taskId+")", {});
    const attRow = await db.queryOne("SELECT attachment_id FROM crms_attachments WHERE release_id="+rid+" AND task_id="+taskId+" ORDER BY created_at DESC FETCH FIRST 1 ROWS ONLY", {});
    if (attRow && fileData.length > 4000) {
      let offset = 4000;
      while (offset < fileData.length) {
        await db.executeWithCommit("UPDATE crms_attachments SET file_data=file_data||TO_CLOB('"+safe(fileData.substring(offset,offset+4000))+"') WHERE attachment_id="+num(attRow.ATTACHMENT_ID), {});
        offset += 4000;
      }
    }
    if (attRow) await db.executeWithCommit("UPDATE crms_release_tasks SET upload_attachment_id="+num(attRow.ATTACHMENT_ID)+",actual_start_date=DECODE(actual_start_date,NULL,SYSDATE,actual_start_date) WHERE task_id="+taskId, {});
    if (uid && uid !== '0') await db.executeWithCommit("INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES('Attachment',"+uid+",'"+rel.RELEASE_NUMBER+"','"+task.PHASE_CODE+" task doc: "+safe(fileName)+"')", {});
    return res.status(201).json({ message:'Document uploaded.' });
  } catch(err) { next(err); }
}

// ── PATCH /releases/:releaseId/phase-tasks/:taskId/download ──────────
async function markTemplateDownloaded(req, res, next) {
  try {
    await db.executeWithCommit("UPDATE crms_release_tasks SET template_downloaded=1 WHERE task_id="+num(req.params.taskId), {});
    return res.json({ message:'Template download recorded' });
  } catch(err) { next(err); }
}

// ── GET /releases/my-phase-tasks ─────────────────────────────────────
async function myPhaseTasks(req, res, next) {
  try {
    const uid = num(req.user.userId);
    const rows = await db.query(
      'SELECT rt.task_id,rt.task_number,rt.phase_code,rt.state,rt.short_description,'+
      'rt.priority,rt.upload_attachment_id,rt.planned_start_date,rt.planned_end_date,'+
      'rt.closed_at,rt.assignment_group_id,rt.assigned_to,'+
      'u.full_name AS assigned_to_name,'+
      'r.release_id,r.release_number,r.state AS release_state,r.title AS release_title,'+
      'ag.group_name AS assignment_group,'+
      'ur.full_name AS requested_by_name,'+
      'm.module_name,'+
      'uo.full_name AS cr_owner_name '+
      'FROM crms_release_tasks rt '+
      'JOIN crms_releases r ON r.release_id=rt.release_id AND r.is_deleted=0 '+
      'LEFT JOIN crms_assignment_groups ag ON ag.group_id=rt.assignment_group_id '+
      'LEFT JOIN crms_users u  ON u.user_id=rt.assigned_to '+
      'LEFT JOIN crms_users ur ON ur.user_id=r.requested_by '+
      'LEFT JOIN crms_modules m  ON m.module_id=r.module_id '+
      'LEFT JOIN crms_users uo   ON uo.user_id=r.cr_owner_user_id '+
      'WHERE rt.assigned_to='+uid+' AND rt.state IN (\'Open\',\'Closed\') ORDER BY rt.created_at DESC', {}
    );
    return res.json(rows.map(t=>({
      taskId:t.TASK_ID, taskNumber:t.TASK_NUMBER, phaseCode:t.PHASE_CODE,
      state:t.STATE, shortDescription:t.SHORT_DESCRIPTION, priority:t.PRIORITY,
      uploadAttachmentId:t.UPLOAD_ATTACHMENT_ID,
      plannedStartDate:t.PLANNED_START_DATE, plannedEndDate:t.PLANNED_END_DATE,
      closedAt:t.CLOSED_AT, assignmentGroup:t.ASSIGNMENT_GROUP,
      assignedTo:t.ASSIGNED_TO_NAME,
      requestedBy:t.REQUESTED_BY_NAME||'',
      moduleName:t.MODULE_NAME||'',
      crOwnerName:t.CR_OWNER_NAME||'',
      releaseId:t.RELEASE_ID, releaseNumber:t.RELEASE_NUMBER,
      releaseState:t.RELEASE_STATE, releaseTitle:t.RELEASE_TITLE,
    })));
  } catch(err) { next(err); }
}

// ── PATCH /releases/:releaseId/reassign ──────────────────────────────
async function reassign(req, res, next) {
  try {
    const rid = num(req.params.releaseId);
    const uid = num(req.user.userId);
    const { assignedToUserId } = req.body;
    if (!assignedToUserId) return res.status(422).json({ error:'assignedToUserId required' });
    const release = await db.queryOne('SELECT release_id,release_number FROM crms_releases WHERE release_id='+rid, {});
    if (!release) return res.status(404).json({ error:'Release not found' });
    const newU = await db.queryOne('SELECT full_name FROM crms_users WHERE user_id='+num(assignedToUserId), {});
    const newName = newU ? newU.FULL_NAME : 'User';
    await db.executeWithCommit('UPDATE crms_releases SET assigned_to_user_id='+num(assignedToUserId)+',updated_at=SYSDATE WHERE release_id='+rid, {});
    if (uid && uid !== '0') await db.executeWithCommit("INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES('Reassign',"+uid+",'"+release.RELEASE_NUMBER+"','Assigned to "+safe(newName)+"')", {});
    await db.executeWithCommit("INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+num(assignedToUserId)+",'Release Assigned to You','"+safe(release.RELEASE_NUMBER+' assigned to you')+"',"+rid+")", {});
    return res.json({ message:'Reassigned to '+newName });
  } catch(err) { next(err); }
}

// ── DELETE ────────────────────────────────────────────────────────────
async function remove(req, res, next) {
  try {
    const rid = num(req.params.releaseId);
    const result = await db.executeWithCommit('UPDATE crms_releases SET is_deleted=1,updated_at=SYSDATE WHERE release_id='+rid, {});
    if (result.rowsAffected===0) return res.status(404).json({ error:'Release not found' });
    return res.json({ message:'Release deleted' });
  } catch(err) { next(err); }
}

// ── GET /releases/:releaseId/rd-export ───────────────────────────────
async function rdExport(req, res, next) {
  try {
    const rid = num(req.params.releaseId);
    const row = await db.queryOne(
      'SELECT r.release_number,r.title,r.priority,r.planned_start_date,r.target_end_date,'+
      'r.reason_of_change,r.business_benefits_process,r.business_benefits_qualitative,'+
      'r.cost_saving,r.manpower_saving,u.full_name AS requested_by,r.created_at '+
      'FROM crms_releases r LEFT JOIN crms_users u ON u.user_id=r.requested_by '+
      'WHERE r.release_id='+rid, {}
    );
    if (!row) return res.status(404).json({ error:'Release not found' });
    return res.json({
      releaseNumber: row.RELEASE_NUMBER,
      title:         row.TITLE,
      requestedBy:   row.REQUESTED_BY,
      priority:      row.PRIORITY,
      plannedStartDate: row.PLANNED_START_DATE,
      targetEndDate:    row.TARGET_END_DATE,
      createdAt:        row.CREATED_AT,
      reasonOfChange:             row.REASON_OF_CHANGE||'',
      businessBenefitsProcess:    row.BUSINESS_BENEFITS_PROCESS||'',
      businessBenefitsQualitative:row.BUSINESS_BENEFITS_QUALITATIVE||'',
      costSaving:                 row.COST_SAVING||'',
      manpowerSaving:             row.MANPOWER_SAVING||'',
    });
  } catch(err) { next(err); }
}

// ── Helpers ───────────────────────────────────────────────────────────
async function writeStateChange(rid,relNum,fromState,toState,uid,assignedUserId) {
  // ── Update assigned_to based on the sub-task assignee for the new phase ────
  // Map state → phase code so we can find the right sub-task assignee
  const stateToPhase = {
    'RD Phase':'RD','RD Awaiting Approval L1':'RD','RD Awaiting Approval L2':'RD',
    'FSD Phase':'FSD','FSD Awaiting Approval L1':'FSD','FSD Awaiting Approval L2':'FSD',
    'Development Phase':'DEV',
    'Testing Phase':'TESTING',
    'UAT Phase':'UAT',
    'Deployment Phase':'DEPLOYMENT','Deployment Approval L1':'DEPLOYMENT',
    'Deployment Approval L2':'DEPLOYMENT','Deployment Approval L3':'DEPLOYMENT',
  };
  const newPhaseCode = stateToPhase[toState];
  if (newPhaseCode) {
    try {
      // Find the first sub-task assignee for the new phase
      const phaseTask = await db.queryOne(
        "SELECT assigned_to FROM crms_release_tasks "+
        "WHERE release_id="+rid+" AND phase_code='"+newPhaseCode+"' "+
        "AND assigned_to IS NOT NULL ORDER BY task_id FETCH FIRST 1 ROWS ONLY", {}
      );
      if (phaseTask && phaseTask.ASSIGNED_TO) {
        assignedUserId = num(phaseTask.ASSIGNED_TO);
      }
    } catch(e) { /* table may not exist */ }
  }

  // If no sub-task assignee found, fall back to L1 approver from crms_approval_flows
  if (!assignedUserId && newPhaseCode) {
    try {
      const relMod = await db.queryOne('SELECT module_id FROM crms_releases WHERE release_id='+rid, {});
      if (relMod && relMod.MODULE_ID) {
        const flowL1 = await db.queryOne(
          "SELECT approver_user_id FROM crms_approval_flows "+
          "WHERE module_id="+num(String(relMod.MODULE_ID))+" AND phase_code='"+newPhaseCode+"' AND level_order=1 "+
          "ORDER BY approver_user_id FETCH FIRST 1 ROWS ONLY", {}
        );
        if (flowL1 && flowL1.APPROVER_USER_ID) assignedUserId = num(flowL1.APPROVER_USER_ID);
      }
    } catch(e2) { /* no flow configured */ }
  }

  // Update CR with new state AND new assignee
  const setAssigned = assignedUserId ? ',assigned_to_user_id='+assignedUserId : '';
  await db.executeWithCommit("UPDATE crms_releases SET state='"+safe(toState)+"',updated_at=SYSDATE"+setAssigned+" WHERE release_id="+rid, {});
  await db.executeWithCommit("INSERT INTO crms_release_history(release_id,action,from_state,to_state,changed_by) VALUES("+rid+",'State Change','"+safe(fromState)+"','"+safe(toState)+"',"+uid+")", {});
  if (uid && uid !== '0') await db.executeWithCommit("INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES('State Change',"+uid+",'"+relNum+"','"+safe(fromState)+" -> "+safe(toState)+"')", {});

  // Collect all users who need notification: release assignee + all sub-task assignees
  const notifySet = new Set();
  if (assignedUserId && num(assignedUserId) !== '0') notifySet.add(num(assignedUserId));

  // Get all distinct sub-task assignees for this release
  try {
    const taskAssignees = await db.query(
      'SELECT DISTINCT assigned_to FROM crms_release_tasks '+
      'WHERE release_id='+rid+' AND assigned_to IS NOT NULL AND assigned_to != '+uid, {}
    );
    taskAssignees.forEach(function(row) {
      var aid = num(row.ASSIGNED_TO);
      if (aid !== '0') notifySet.add(aid);
    });
  } catch(e) { /* table may not exist yet */ }

  // Send notification to each unique user (exclude the person making the change)
  for (const notifyUid of notifySet) {
    if (notifyUid === uid) continue;
    await db.executeWithCommit(
      "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+
      notifyUid+",'CR State Updated','"+safe(relNum+' → '+toState)+"',"+rid+")", {}
    );
  }

  // ── Update Task List phase dates (fire-and-forget) ──────────────────
  setImmediate(function() {
    taskListCtrl.updatePhaseDate(relNum, toState, null).catch(function(){});
  });

  // ── Push to ServiceNow (fire-and-forget, never blocks CRMS) ─────────
  setImmediate(function() {
    db.queryOne(
      "SELECT r.title,r.summary,r.priority,r.company,r.service," +
      "r.planned_start_date,r.target_end_date,r.snow_sys_id," +
      "u1.full_name AS rby,u2.full_name AS ato," +
      "ag.group_name AS grp,uc.full_name AS cby " +
      "FROM crms_releases r " +
      "LEFT JOIN crms_users u1 ON u1.user_id=r.requested_by " +
      "LEFT JOIN crms_users u2 ON u2.user_id=r.assigned_to_user_id " +
      "LEFT JOIN crms_assignment_groups ag ON ag.group_id=r.assignment_group_id " +
      "LEFT JOIN crms_users uc ON uc.user_id="+uid+" " +
      "WHERE r.release_id="+rid, {}
    ).then(function(rel) {
      if (!rel) return;
      return snow.pushStateChange({
        releaseId:rid, releaseNumber:relNum, fromState:fromState, toState:toState,
        title:rel.TITLE, summary:rel.SUMMARY||'', priority:rel.PRIORITY,
        requestedBy:rel.RBY, assignedTo:rel.ATO, assignmentGroup:rel.GRP,
        company:rel.COMPANY, service:rel.SERVICE,
        startDate:rel.PLANNED_START_DATE, endDate:rel.TARGET_END_DATE,
        changedBy:rel.CBY, snowSysId:rel.SNOW_SYS_ID||null,
      });
    }).then(function(result) {
      if (!result||result.skipped) return;
      const detail = result.success
        ? 'Pushed to SNow '+result.action+' sysId:'+result.sysId
        : 'SNow push failed: '+(result.error||'unknown');
      const action = result.success ? 'ServiceNow Push' : 'ServiceNow Error';
      db.executeWithCommit(
        "INSERT INTO crms_audit(action,performed_by,cr_number,details) "+
        "VALUES('"+action+"',"+uid+",'"+relNum+"','"+detail.replace(/'/g,"''")+"')", {}
      ).catch(function(){});
      if (result.success && result.sysId) {
        db.executeWithCommit(
          "UPDATE crms_releases SET snow_sys_id='"+result.sysId+"' "+
          "WHERE release_id="+rid+" AND (snow_sys_id IS NULL OR snow_sys_id='')", {}
        ).catch(function(){});
      }
    }).catch(function(err){
      require('../config/logger').warn('[SNow] async push error',{err:err.message});
    });
  });
}

async function assignPhaseTasks() { logger.info('assignPhaseTasks skipped — tasks created manually'); }

function camelizeRelease(r) {
  return {
    releaseId:r.RELEASE_ID, releaseNumber:r.RELEASE_NUMBER,
    state:r.STATE, priority:r.PRIORITY, title:r.TITLE,
    summary:r.SUMMARY||'', company:r.COMPANY||'', service:r.SERVICE||'',
    requestedBy:r.REQUESTED_BY||'', assignedTo:r.ASSIGNED_TO||'',
    assignmentGroup:r.ASSIGNMENT_GROUP||'',
    plannedStartDate:r.PLANNED_START_DATE||null,
    targetEndDate:r.TARGET_END_DATE||null,
    moduleId:r.MODULE_ID||null,
    moduleName:r.MODULE_NAME||'',
    crOwnerUserId: r.CR_OWNER_USER_ID || null,
    crOwnerName:   r.CR_OWNER_NAME    || '',
    cemli:         r.CEMLI            || '',
    smartsheetId:  r.SMARTSHEET_ID    || '',
    processName:   r.PROCESS_NAME     || '',
    createdAt:r.CREATED_AT, updatedAt:r.UPDATED_AT,
  };
}

// ── POST /releases/:releaseId/notify-reviewer ─────────────────────────
async function notifyReviewer(req, res, next) {
  try {
    const rid = num(req.params.releaseId);
    const { reviewerUserId, phaseCode, reviewerName, notes } = req.body;
    if (!reviewerUserId) return res.status(422).json({ error: 'reviewerUserId is required' });
    if (!phaseCode)      return res.status(422).json({ error: 'phaseCode is required' });

    const release = await db.queryOne(
      'SELECT release_number FROM crms_releases WHERE release_id='+rid+' AND is_deleted=0', {}
    );
    if (!release) return res.status(404).json({ error: 'Release not found' });

    const sentBy = num(req.user.userId);

    // 1. Check for duplicate — same CR, same phase, same reviewer, already Pending
    let existing;
    try {
      existing = await db.queryOne(
        "SELECT review_id FROM crms_review_requests "+
        "WHERE release_id="+rid+" AND phase_code='"+safe(phaseCode)+"' "+
        "AND reviewer_id="+num(reviewerUserId)+" AND status='Pending'", {}
      );
    } catch(tableErr) {
      const msg = tableErr.message || '';
      if (msg.includes('ORA-00942') || msg.includes('table or view does not exist')) {
        return res.status(500).json({
          error: 'Review requests table is missing. Please run crms_review_requests.sql in SQL Developer and restart the backend.',
        });
      }
      throw tableErr;
    }
    if (existing) {
      return res.status(409).json({
        error: 'This CR is already pending review by '+safe(reviewerName||'that reviewer')+' for the '+safe(phaseCode)+' phase. Cannot send again until the current review is completed or passed.',
      });
    }

    // 2. Insert review request
    await db.executeWithCommit(
      "INSERT INTO crms_review_requests"+
      "(release_id,phase_code,sent_by,reviewer_id,status,notes) VALUES("+
      rid+",'"+safe(phaseCode)+"',"+sentBy+","+num(reviewerUserId)+",'Pending','"+safe(notes||'')+"')", {}
    );

    // 2. Send in-app notification to the reviewer
    await db.executeWithCommit(
      "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+
      num(reviewerUserId)+",'Review Requested — "+safe(phaseCode)+" Phase','"+
      safe(release.RELEASE_NUMBER+' has been sent to you for review ('+phaseCode+' phase). Please check My Reviews.')+
      "',"+rid+")", {}
    );

    logger.info('Review request created', { releaseId:rid, phaseCode, reviewerUserId, sentBy });
    return res.json({ message: 'Sent for review to '+safe(reviewerName||'reviewer'), reviewRequestCreated: true });

  } catch(err) { next(err); }
}

// ── GET /reviews/my — CRs sent to me for review ──────────────────────
async function myReviews(req, res, next) {
  try {
    const uid = num(req.user.userId);
    const rows = await db.query(
      'SELECT rr.review_id,rr.release_id,rr.phase_code,rr.status,rr.notes,rr.created_at,'+
      'rr.sent_by,rr.passed_to,'+
      'r.release_number,r.title,r.state,r.priority,r.summary,'+
      'r.reason_of_change,r.business_benefits_process,r.business_benefits_qualitative,'+
      'r.cost_saving,r.manpower_saving,r.cemli,r.smartsheet_id,r.process_name,'+
      'r.planned_start_date,r.target_end_date,'+
      'r.company,r.service,r.module_id,'+
      'u_sent.full_name AS sent_by_name,'+
      'u_pass.full_name AS passed_to_name,'+
      'ag.group_name AS assignment_group,'+
      'u_at.full_name AS assigned_to,'+
      'u_req.full_name AS requested_by '+
      'FROM crms_review_requests rr '+
      'JOIN crms_releases r ON r.release_id=rr.release_id AND r.is_deleted=0 '+
      'JOIN crms_users u_sent ON u_sent.user_id=rr.sent_by '+
      'JOIN crms_users u_req  ON u_req.user_id=r.requested_by '+
      'LEFT JOIN crms_users u_pass  ON u_pass.user_id=rr.passed_to '+
      'LEFT JOIN crms_users u_at    ON u_at.user_id=r.assigned_to_user_id '+
      'LEFT JOIN crms_assignment_groups ag ON ag.group_id=r.assignment_group_id '+
      'WHERE (rr.reviewer_id='+uid+' OR rr.passed_to='+uid+') '+
      "AND rr.status='Pending' ORDER BY rr.created_at DESC", {}
    );

    // For each review, fetch phase-specific sub-tasks and recent comments
    const result = [];
    for (const r of rows) {
      const rid = num(r.RELEASE_ID);
      const phaseCode = r.PHASE_CODE;

      // Phase sub-tasks for this specific phase
      const tasks = await db.query(
        'SELECT rt.task_number,rt.phase_code,rt.short_description,rt.state,'+
        'rt.planned_start_date,rt.planned_end_date,rt.actual_start_date,rt.actual_end_date,'+
        'u.full_name AS assigned_to_name,ag.group_name '+
        'FROM crms_release_tasks rt '+
        'LEFT JOIN crms_users u ON u.user_id=rt.assigned_to '+
        'LEFT JOIN crms_assignment_groups ag ON ag.group_id=rt.assignment_group_id '+
        "WHERE rt.release_id="+rid+" AND rt.phase_code='"+safe(phaseCode)+"' ORDER BY rt.created_at", {}
      ).catch(function(){ return []; });

      // Recent comments (last 5)
      const comments = await db.query(
        'SELECT c.comment_text,c.created_at,u.full_name AS author '+
        'FROM crms_comments c JOIN crms_users u ON u.user_id=c.created_by '+
        'WHERE c.release_id='+rid+' ORDER BY c.created_at DESC FETCH FIRST 5 ROWS ONLY', {}
      ).catch(function(){ return []; });

      result.push({
        reviewId:       r.REVIEW_ID,
        releaseId:      r.RELEASE_ID,
        releaseNumber:  r.RELEASE_NUMBER,
        title:          r.TITLE,
        state:          r.STATE,
        priority:       r.PRIORITY,
        summary:        r.SUMMARY||'',
        company:        r.COMPANY||'',
        service:        r.SERVICE||'',
        phaseCode:      phaseCode,
        status:         r.STATUS,
        notes:          r.NOTES||'',
        sentByName:     r.SENT_BY_NAME,
        passedToName:   r.PASSED_TO_NAME||'',
        requestedBy:    r.REQUESTED_BY,
        assignedTo:     r.ASSIGNED_TO||'',
        assignmentGroup:r.ASSIGNMENT_GROUP||'',
        plannedStartDate:   r.PLANNED_START_DATE||null,
        targetEndDate:      r.TARGET_END_DATE||null,
        reasonOfChange:             r.REASON_OF_CHANGE||'',
        businessBenefitsProcess:    r.BUSINESS_BENEFITS_PROCESS||'',
        businessBenefitsQualitative:r.BUSINESS_BENEFITS_QUALITATIVE||'',
        costSaving:                 r.COST_SAVING||'',
        manpowerSaving:             r.MANPOWER_SAVING||'',
        createdAt:      r.CREATED_AT,
        // Phase-specific data
        phaseTasks: tasks.map(function(t){ return {
          taskNumber:      t.TASK_NUMBER,
          phaseCode:       t.PHASE_CODE,
          shortDescription:t.SHORT_DESCRIPTION||'',
          state:           t.STATE,
          plannedStartDate:t.PLANNED_START_DATE||null,
          plannedEndDate:  t.PLANNED_END_DATE||null,
          actualStartDate: t.ACTUAL_START_DATE||null,
          actualEndDate:   t.ACTUAL_END_DATE||null,
          assignedTo:      t.ASSIGNED_TO_NAME||'',
          groupName:       t.GROUP_NAME||'',
        }; }),
        recentComments: comments.map(function(c){ return {
          text:      c.COMMENT_TEXT,
          author:    c.AUTHOR,
          createdAt: c.CREATED_AT,
        }; }),
      });
    }
    return res.json(result);
  } catch(err) { next(err); }
}

// ── GET /reviews/is-reviewer — check if current user is a mapped reviewer ──
async function isReviewer(req, res, next) {
  try {
    const uid = num(req.user.userId);
    const row = await db.queryOne(
      'SELECT COUNT(*) AS cnt FROM crms_phase_reviewers WHERE user_id='+uid, {}
    ).catch(function(){ return { CNT:0 }; });
    const pending = await db.queryOne(
      "SELECT COUNT(*) AS cnt FROM crms_review_requests WHERE (reviewer_id="+uid+" OR passed_to="+uid+") AND status='Pending'", {}
    ).catch(function(){ return { CNT:0 }; });
    return res.json({
      isReviewer:   Number(row.CNT) > 0,
      pendingCount: Number(pending.CNT),
    });
  } catch(err) { next(err); }
}

// ── POST /reviews/:reviewId/pass — pass review to another reviewer ───
async function passReview(req, res, next) {
  try {
    const rvid  = num(req.params.reviewId);
    const uid   = num(req.user.userId);
    const { passToUserId, notes } = req.body;
    if (!passToUserId) return res.status(422).json({ error:'passToUserId required' });
    const rr = await db.queryOne(
      'SELECT rr.review_id,rr.release_id,rr.phase_code,rr.reviewer_id,rr.passed_to,'+
      'r.release_number FROM crms_review_requests rr '+
      'JOIN crms_releases r ON r.release_id=rr.release_id WHERE rr.review_id='+rvid, {}
    );
    if (!rr) return res.status(404).json({ error:'Review request not found' });
    // Update: set passed_to, keep original reviewer
    await db.executeWithCommit(
      "UPDATE crms_review_requests SET passed_to="+num(passToUserId)+
      ",notes='"+safe(notes||'')+"',updated_at=SYSDATE WHERE review_id="+rvid, {}
    );
    // Notify the new reviewer
    const newReviewer = await db.queryOne('SELECT full_name FROM crms_users WHERE user_id='+num(passToUserId), {});
    const fromUser    = await db.queryOne('SELECT full_name FROM crms_users WHERE user_id='+uid, {});
    await db.executeWithCommit(
      "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+
      num(passToUserId)+",'Review Passed to You','"+
      safe(rr.RELEASE_NUMBER+' review ('+rr.PHASE_CODE+' phase) has been passed to you by '+(fromUser?fromUser.FULL_NAME:'someone'))+
      "',"+num(rr.RELEASE_ID)+")", {}
    );
    return res.json({ message:'Review passed to '+(newReviewer?newReviewer.FULL_NAME:'user') });
  } catch(err) { next(err); }
}

// ── POST /reviews/:reviewId/complete — mark review done ─────────────
async function completeReview(req, res, next) {
  try {
    const rvid = num(req.params.reviewId);
    const uid  = num(req.user.userId);
    const { notes } = req.body;
    await db.executeWithCommit(
      "UPDATE crms_review_requests SET status='Completed',notes='"+safe(notes||'')+"',updated_at=SYSDATE WHERE review_id="+rvid, {}
    );
    return res.json({ message:'Review marked complete' });
  } catch(err) { next(err); }
}


// ── PATCH /releases/:releaseId/cr-owner  — set CR Owner (once, locked) ──
async function setCrOwner(req, res, next) {
  try {
    const rid  = num(req.params.releaseId);
    const uid  = num(req.user.userId);
    const ownerUserId = num(req.body.crOwnerUserId);
    if (!ownerUserId) return res.status(422).json({ error: 'crOwnerUserId required' });

    const release = await db.queryOne(
      'SELECT state, cr_owner_user_id, release_number FROM crms_releases WHERE release_id='+rid+' AND is_deleted=0', {}
    );
    if (!release) return res.status(404).json({ error: 'Release not found' });
    // Only set if not already set (locked once saved)
    if (release.CR_OWNER_USER_ID) {
      return res.status(400).json({ error: 'CR Owner is already set and cannot be changed' });
    }
    // Only settable from FSD Phase onwards
    const allowedStates = ['FSD Phase','FSD Awaiting Approval L1','FSD Awaiting Approval L2',
      'FSD Awaiting Approval L3','Development Phase','Testing Phase','UAT Phase',
      'Deployment Phase','Closed'];
    if (!allowedStates.includes(release.STATE)) {
      return res.status(400).json({ error: 'CR Owner can only be set from FSD Phase onwards' });
    }
    await db.executeWithCommit(
      'UPDATE crms_releases SET cr_owner_user_id='+ownerUserId+' WHERE release_id='+rid, {}
    );
    const ownerRow = await db.queryOne('SELECT full_name FROM crms_users WHERE user_id='+ownerUserId, {});
    const ownerName = ownerRow ? ownerRow.FULL_NAME : '';
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES('CR Owner Set',"+uid+
      ",'"+safe(release.RELEASE_NUMBER)+"','CR Owner set to "+safe(ownerName)+"')", {}
    );
    logger.info('CR Owner set', { releaseId:rid, ownerUserId, ownerName });
    setImmediate(function() { taskListCtrl.updateOwner(release.RELEASE_NUMBER, ownerName).catch(function(){}); });
    return res.json({ message: 'CR Owner set', crOwnerUserId: ownerUserId, crOwnerName: ownerName });
  } catch(err) { next(err); }
}

// ── GET /releases/:releaseId/rd-approval-groups ──────────────────────
// Returns assignment groups mapped for RD approval for this CR's
// Company + Service + Module combination
async function getRdApprovalGroups(req, res, next) {
  try {
    const rid = num(req.params.releaseId);
    const rel = await db.queryOne(
      'SELECT company,service,module_id FROM crms_releases WHERE release_id='+rid+' AND is_deleted=0', {}
    );
    if (!rel) return res.status(404).json({ error:'Release not found' });

    // Find groups mapped for this CR's company/service/module
    // Correct logic:
    //   agm.company_name IS NULL  → matches any company
    //   agm.company_name = 'X'    → only matches CRs where company='X'
    //   same for service_name and module_id
    const crCompany   = safe(rel.COMPANY  ||'');
    const crService   = safe(rel.SERVICE  ||'');
    const crModuleId  = rel.MODULE_ID ? num(String(rel.MODULE_ID)) : null;

    const qPhase = (req.query && req.query.phase) ? req.query.phase : 'RD';
    let groups = await db.query(
      "SELECT ag.group_id,ag.group_name,agm.level_order "+
      "FROM crms_approval_groups agm "+
      "JOIN crms_assignment_groups ag ON ag.group_id=agm.group_id "+
      "WHERE agm.phase_code='"+safe(qPhase)+"' "+
      "AND (agm.company_name IS NULL OR agm.company_name='"+crCompany+"') "+
      "AND (agm.service_name IS NULL OR agm.service_name='"+crService+"') "+
      (crModuleId ? "AND (agm.module_id IS NULL OR agm.module_id="+crModuleId+") " : "AND agm.module_id IS NULL ") +
      "ORDER BY agm.level_order,ag.group_name", {}
    ).catch(function(){ return []; });

    // Check if ANY mapping exists in the table at all (to decide fallback)
    const anyMappingExists = groups.length > 0;
    if (!anyMappingExists) {
      // No mapping configured at all — check total rows in approval_groups
      const totalMappings = await db.queryOne(
        "SELECT COUNT(*) AS cnt FROM crms_approval_groups WHERE phase_code='"+safe(qPhase)+"'", {}
      ).catch(function(){ return { CNT: 0 }; });
      if (!totalMappings || Number(totalMappings.CNT) === 0) {
        // No RD mappings configured at all — fall back to all groups
        groups = await db.query(
          "SELECT group_id,group_name FROM crms_assignment_groups ORDER BY group_name", {}
        ).catch(function(){ return []; });
      }
      // else: mappings exist but none match this CR's company/service/module
      // → show empty groups (user needs to add the right mapping)
    }

    // For each group, get its active members
    const result = [];
    for (const g of groups) {
      const members = await db.query(
        "SELECT u.user_id,u.full_name "+
        "FROM crms_group_members gm "+
        "JOIN crms_users u ON u.user_id=gm.user_id AND u.is_active=1 "+
        "WHERE gm.group_id="+num(g.GROUP_ID)+" ORDER BY u.full_name", {}
      ).catch(function(){ return []; });
      result.push({
        groupId:    Number(g.GROUP_ID),
        groupName:  g.GROUP_NAME,
        levelOrder: Number(g.LEVEL_ORDER)||1,
        members:    members.map(function(m){ return { userId:Number(m.USER_ID), fullName:m.FULL_NAME }; }),
      });
    }
    return res.json({
      company: rel.COMPANY||'', service: rel.SERVICE||'',
      groups: result,
    });
  } catch(err) { next(err); }
}

// ── PATCH /releases/:releaseId/send-back ─────────────────────────────
// Sends CR back to the previous phase with a mandatory reason
// Only allowed when CR is in a non-terminal, non-RD state
const SEND_BACK_MAP = {
  'FSD Phase':               'RD Phase',
  'FSD Awaiting Approval L1':'FSD Phase',
  'FSD Awaiting Approval L2':'FSD Phase',
  'FSD Awaiting Approval L3':'FSD Phase',
  'Development Phase':        'FSD Phase',
  'Testing Phase':            'Development Phase',
  'UAT Phase':                'Testing Phase',
  'Deployment Phase':         'UAT Phase',
  'Deployment Approval L1':   'Deployment Phase',
  'Deployment Approval L2':   'Deployment Phase',
  'Deployment Approval L3':   'Deployment Phase',
  'On Hold':                  null,  // special — unhold
};
async function sendBack(req, res, next) {
  try {
    const rid    = num(req.params.releaseId);
    const uid    = num(req.user.userId);
    const reason = (req.body.reason||'').trim();
    if (!reason) return res.status(422).json({ error:'Reason for sending back is mandatory' });

    const release = await db.queryOne(
      'SELECT release_id,state,release_number FROM crms_releases WHERE release_id='+rid+' AND is_deleted=0', {}
    );
    if (!release) return res.status(404).json({ error:'Release not found' });
    const cur    = release.STATE;
    const relNum = release.RELEASE_NUMBER;

    const backState = SEND_BACK_MAP[cur];
    if (backState === undefined) return res.status(400).json({ error:'Cannot send back from state: '+cur });
    if (backState === null) return res.status(400).json({ error:'Use unhold to move from On Hold' });

    // Write state change
    await writeStateChange(rid, relNum, cur, backState, uid, null);

    // Add reason as comment
    await db.executeWithCommit(
      "INSERT INTO crms_comments(release_id,comment_text,created_by) VALUES("+rid+
      ",'[SENT BACK] Reason: "+safe(reason)+"',"+uid+")", {}
    );
    // Notify requester
    await db.executeWithCommit(
      "INSERT INTO crms_notifications(user_id,title,message,release_id) "+
      "VALUES((SELECT requested_by FROM crms_releases WHERE release_id="+rid+"),"+
      "'CR Sent Back','"+safe(relNum+' sent back to '+backState+'. Reason: '+reason)+"',"+rid+")", {}
    ).catch(function(){});

    logger.info('CR sent back', { rid, from: cur, to: backState, reason });
    return res.json({ message:'Sent back', fromState: cur, toState: backState });
  } catch(err) { next(err); }
}

// ── PATCH /releases/:releaseId/unhold ────────────────────────────────
// Releases a CR from On Hold — moves to Development Phase (the phase
// that typically follows On Hold)
async function unhold(req, res, next) {
  try {
    const rid = num(req.params.releaseId);
    const uid = num(req.user.userId);
    const release = await db.queryOne(
      'SELECT release_id,state,release_number FROM crms_releases WHERE release_id='+rid+' AND is_deleted=0', {}
    );
    if (!release) return res.status(404).json({ error:'Release not found' });
    if (release.STATE !== 'On Hold') return res.status(400).json({ error:'CR is not On Hold' });
    const relNum = release.RELEASE_NUMBER;
    // Find the state BEFORE 'On Hold' from history — restore to it
    const lastHistory = await db.queryOne(
      'SELECT from_state FROM crms_release_history '+
      'WHERE release_id='+rid+" AND to_state='On Hold' "+
      'ORDER BY changed_at DESC FETCH FIRST 1 ROWS ONLY', {}
    );
    const resumeState = (lastHistory && lastHistory.FROM_STATE) || 'Development Phase';
    await writeStateChange(rid, relNum, 'On Hold', resumeState, uid, null);
    return res.json({ message:'CR resumed', toState:resumeState });
  } catch(err) { next(err); }
}

// ── PATCH /releases/:releaseId/rd-fields ─────────────────────────────
// Save CEMLI No, Smartsheet ID, Process Name to the release
async function updateRdFields(req, res, next) {
  try {
    const rid = num(req.params.releaseId);
    const { cemli, smartsheetId, processName } = req.body;
    const sets = [];
    if (cemli        !== undefined) sets.push("cemli='"         + safe(cemli||'')        + "'");
    if (smartsheetId !== undefined) sets.push("smartsheet_id='" + safe(smartsheetId||'') + "'");
    if (processName  !== undefined) sets.push("process_name='"  + safe(processName||'')  + "'");
    if (!sets.length) return res.status(422).json({ error:'No fields provided' });
    await db.executeWithCommit(
      'UPDATE crms_releases SET '+sets.join(',')+' WHERE release_id='+rid+' AND is_deleted=0', {}
    );
    // Push CEMLI/Smartsheet/Process to Task List
    const relRow2 = await db.queryOne('SELECT release_number FROM crms_releases WHERE release_id='+rid, {});
    if (relRow2) {
      const upd = {};
      if (cemli        !== undefined) upd.cemli      = cemli||'';
      if (smartsheetId !== undefined) upd.smartSheet = smartsheetId||'';
      if (processName  !== undefined) upd.process    = processName||'';
      setImmediate(async function() {
        // Use updateCemliFields which handles missing columns gracefully
        await taskListCtrl.updateCemliFields(
          relRow2.RELEASE_NUMBER,
          upd.cemli, upd.smartSheet, upd.process
        ).catch(function(){});
      });
    }
    return res.json({ message:'Saved', cemli:cemli||'', smartsheetId:smartsheetId||'', processName:processName||'' });
  } catch(err) { next(err); }
}

// ── GET /releases/:releaseId/approval-flow-options ────────────────────
// Returns users from crms_approval_flows for this CR's module, for RD phase
// Used by the "Submit for Approval" modal to show level-by-level approvers
async function getApprovalFlowOptions(req, res, next) {
  try {
    const rid = num(req.params.releaseId);
    const rel = await db.queryOne(
      'SELECT module_id,company,service FROM crms_releases WHERE release_id='+rid+' AND is_deleted=0', {}
    );
    if (!rel) return res.status(404).json({ error:'Release not found' });

    const mid = rel.MODULE_ID ? num(String(rel.MODULE_ID)) : null;
    if (!mid) {
      return res.json({ levels: [], moduleName: '', message: 'No module assigned to this CR' });
    }

    // Get all approval flow entries for this module + requested phase, ordered by level
    const qPhase2 = (req.query && req.query.phase) ? String(req.query.phase) : 'RD';
    const rows = await db.query(
      "SELECT af.level_order,af.approver_user_id,af.auto_approve,u.full_name "+
      "FROM crms_approval_flows af "+
      "JOIN crms_users u ON u.user_id=af.approver_user_id AND u.is_active=1 "+
      "WHERE af.module_id="+mid+" AND af.phase_code='"+safe(qPhase2)+"' "+
      "ORDER BY af.level_order,u.full_name", {}
    ).catch(function(){ return []; });

    // Get module name
    const modRow = await db.queryOne('SELECT module_name FROM crms_modules WHERE module_id='+mid, {}).catch(function(){ return null; });

    const relInfo2 = await db.queryOne('SELECT company,service FROM crms_releases WHERE release_id='+rid, {}).catch(function(){ return null; });
    return res.json({
      moduleName: modRow ? modRow.MODULE_NAME : '',
      company: relInfo2 ? relInfo2.COMPANY || '' : '',
      service: relInfo2 ? relInfo2.SERVICE || '' : '',
      levels: rows.map(function(r){
        return {
          levelOrder:  Number(r.LEVEL_ORDER),
          userId:      Number(r.APPROVER_USER_ID),
          fullName:    r.FULL_NAME,
          autoApprove: !!Number(r.AUTO_APPROVE),
        };
      }),
    });
  } catch(err) { next(err); }
}

// ── GET /releases/:releaseId/approval-status ──────────────────────────
// Returns current pending approver for a CR — works for old and new CRs
async function getApprovalStatus(req, res, next) {
  try {
    const rid = num(req.params.releaseId);
    // Check crms_release_approvals for a pending record
    const pending = await db.queryOne(
      "SELECT ra.level_order,ra.approver_user_id,u.full_name "+
      "FROM crms_release_approvals ra "+
      "JOIN crms_users u ON u.user_id=ra.approver_user_id "+
      "WHERE ra.release_id="+rid+" AND ra.status='Pending' "+
      "ORDER BY ra.level_order FETCH FIRST 1 ROWS ONLY", {}
    ).catch(function(){ return null; });

    if (pending) {
      return res.json({
        pendingWith:  pending.FULL_NAME,
        levelOrder:   Number(pending.LEVEL_ORDER),
        approverId:   Number(pending.APPROVER_USER_ID),
      });
    }
    return res.json({ pendingWith: null });
  } catch(err) { next(err); }
}

module.exports = {
  nextNumber, getAll, getOne,
  create, createValidation,
  advanceState, setCrOwner, getRdApprovalGroups, sendBack, unhold, updateRdFields, getApprovalFlowOptions, getApprovalStatus,
  createPhaseTask, updatePhaseTask,
  myPhaseTasks,
  getPhaseTasks, closePhaseTask, uploadTaskDocument, markTemplateDownloaded,
  rdExport,
  reassign, remove, notifyReviewer,
  myReviews, isReviewer, passReview, completeReview,
  assignPhaseTasks, writeStateChange, stateToPhaseCode, phaseToState, AFTER_APPROVAL,
  fullHistory,
};
