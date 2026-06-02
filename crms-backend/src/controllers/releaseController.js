'use strict';

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
  DEPLOYMENT: 'Deployment Phase',  // after all approval levels → Deployment Phase (pre-go-live)
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
      'r.cost_saving,r.manpower_saving,'+
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
      'u.full_name AS requested_by,u2.full_name AS assigned_to,ag.group_name AS assignment_group '+
      'FROM crms_releases r '+
      'LEFT JOIN crms_users u  ON u.user_id=r.requested_by '+
      'LEFT JOIN crms_users u2 ON u2.user_id=r.assigned_to_user_id '+
      'LEFT JOIN crms_assignment_groups ag ON ag.group_id=r.assignment_group_id '+
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
      'r.module_id,r.current_approval_level,r.assignment_group_id,'+
      'r.reason_of_change,r.business_benefits_process,r.business_benefits_qualitative,'+
      'r.cost_saving,r.manpower_saving,'+
      'u.full_name AS requested_by,u.user_id AS requested_by_user_id,'+
      'u2.full_name AS assigned_to,u2.user_id AS assigned_to_user_id,'+
      'ag.group_name AS assignment_group '+
      'FROM crms_releases r '+
      'LEFT JOIN crms_users u  ON u.user_id=r.requested_by '+
      'LEFT JOIN crms_users u2 ON u2.user_id=r.assigned_to_user_id '+
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
      'u.full_name AS assigned_to,u.user_id AS assigned_to_id,'+
      'ag.group_name AS assignment_group '+
      'FROM crms_release_tasks rt '+
      'JOIN crms_users u ON u.user_id=rt.assigned_to '+
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
  body('plannedStartDate').isISO8601(),
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
        const anyTask2 = await db.queryOne("SELECT task_id FROM crms_release_tasks WHERE release_id="+rid+" AND phase_code='"+checkPhase+"' FETCH FIRST 1 ROWS ONLY", {});
        if (!anyTask2) return res.status(400).json({ error:'At least one sub-task must be created and all sub-tasks must be closed for the '+cur+' before advancing. Click "+ Add Sub-Task" in the Sub-Tasks tab.' });
        const openTask2 = await db.queryOne("SELECT task_id,task_number FROM crms_release_tasks WHERE release_id="+rid+" AND phase_code='"+checkPhase+"' AND state='Open' FETCH FIRST 1 ROWS ONLY", {});
        if (openTask2) return res.status(400).json({ error:'Sub-task '+openTask2.TASK_NUMBER+' is still open. Close it before advancing.' });
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
            priority, description, plannedStartDate, plannedEndDate } = req.body;
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
      "planned_start_date,planned_end_date) "+
      "VALUES('"+taskNum+"',"+rid+",'"+safe(phaseCode)+"','"+safe(shortDescription)+"',"+
      agVal+","+atVal+","+prioVal+",'"+safe(description||'')+"',"+
      safeDate(plannedStartDate)+","+safeDate(plannedEndDate)+")", {}
    );
    if (uid && uid !== '0') await db.executeWithCommit("INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES('Task Created',"+uid+",'"+release.RELEASE_NUMBER+"','"+taskNum+" ("+phaseCode+") created')", {});
    if (assignedToUserId && num(assignedToUserId) !== '0') {
      await db.executeWithCommit("INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+num(assignedToUserId)+",'Sub-Task Assigned: "+taskNum+"','"+safe(taskNum+' — '+phaseCode+' task on '+release.RELEASE_NUMBER)+"',"+rid+")", {});
    }
    logger.info('Phase task created', { taskNum, phaseCode, releaseId:rid });
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
      'u.full_name AS assigned_to,u.user_id AS assigned_to_id,'+
      'ag.group_name AS assignment_group '+
      'FROM crms_release_tasks rt '+
      'JOIN crms_users u ON u.user_id=rt.assigned_to '+
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
    if (req.user.role !== 'admin' && String(task.ASSIGNED_TO) !== String(req.user.userId))
      return res.status(403).json({ error:'Only the assigned person can close this task' });
    if (!task.UPLOAD_ATTACHMENT_ID) return res.status(422).json({ error:'Please upload a document before closing this task.' });
    // Use user-provided actual_end_date if already set, otherwise use SYSDATE
    const existingEnd = await db.queryOne('SELECT actual_end_date FROM crms_release_tasks WHERE task_id='+taskId, {});
    const endDateExpr = (existingEnd && existingEnd.ACTUAL_END_DATE) ? 'actual_end_date' : 'SYSDATE';
    await db.executeWithCommit('UPDATE crms_release_tasks SET state=\'Closed\',closed_by='+uid+',closed_at=SYSDATE,actual_end_date='+endDateExpr+' WHERE task_id='+taskId, {});
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
      'ag.group_name AS assignment_group '+
      'FROM crms_release_tasks rt '+
      'JOIN crms_releases r ON r.release_id=rt.release_id AND r.is_deleted=0 '+
      'LEFT JOIN crms_assignment_groups ag ON ag.group_id=rt.assignment_group_id '+
      'LEFT JOIN crms_users u ON u.user_id=rt.assigned_to '+
      'WHERE rt.assigned_to='+uid+' AND rt.state=\'Open\' ORDER BY rt.created_at DESC', {}
    );
    return res.json(rows.map(t=>({
      taskId:t.TASK_ID, taskNumber:t.TASK_NUMBER, phaseCode:t.PHASE_CODE,
      state:t.STATE, shortDescription:t.SHORT_DESCRIPTION, priority:t.PRIORITY,
      uploadAttachmentId:t.UPLOAD_ATTACHMENT_ID,
      plannedStartDate:t.PLANNED_START_DATE, plannedEndDate:t.PLANNED_END_DATE,
      closedAt:t.CLOSED_AT, assignmentGroup:t.ASSIGNMENT_GROUP,
      assignedTo:t.ASSIGNED_TO_NAME,
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
  await db.executeWithCommit("UPDATE crms_releases SET state='"+safe(toState)+"',updated_at=SYSDATE WHERE release_id="+rid, {});
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
      'r.cost_saving,r.manpower_saving,'+
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


module.exports = {
  nextNumber, getAll, getOne,
  create, createValidation,
  advanceState,
  createPhaseTask, updatePhaseTask,
  myPhaseTasks,
  getPhaseTasks, closePhaseTask, uploadTaskDocument, markTemplateDownloaded,
  rdExport,
  reassign, remove, notifyReviewer,
  myReviews, isReviewer, passReview, completeReview,
  assignPhaseTasks, writeStateChange, stateToPhaseCode, phaseToState, AFTER_APPROVAL,
  fullHistory,
};
