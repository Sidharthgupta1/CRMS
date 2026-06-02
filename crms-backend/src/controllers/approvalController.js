'use strict';

const db     = require('../config/db');
const logger = require('../config/logger');

function safe(s) { return String(s||'').replace(/'/g,"''"); }
function num(n)  { return String(parseInt(n,10)||0); }

const AFTER_APPROVAL = {
  'DRAFT':      'RD Phase',
  'RD':         'FSD Phase',
  'FSD':        'Development Phase',
  'DEPLOYMENT': 'Closed',
};

// ── triggerApproval ───────────────────────────────────────────────────
// Called when a phase is ready for approval
// Returns { newState, approverName } or { autoApproved:true } or { error }
async function triggerApproval(releaseId, relNum, requestedBy, modId, phaseCode, selectedApproverId) {
  const rid  = num(releaseId);
  const reqBy = num(requestedBy);

  if (!modId || String(modId) === 'NULL')
    return { autoApproved:true, reason:'no_module' };

  const mid  = num(String(modId));

  // Get approval flow for this phase
  const flow = await db.query(
    "SELECT level_order,approver_user_id,auto_approve "+
    "FROM crms_approval_flows WHERE module_id="+mid+
    " AND phase_code='"+phaseCode+"' ORDER BY level_order", {}
  );

  if (!flow.length)
    return { autoApproved:true, reason:'no_flow' };

  // Dynamic approver override: if caller selected a specific approver, use only them
  let effectiveFlow = flow;
  if (selectedApproverId) {
    const sid = String(parseInt(selectedApproverId,10)||0);
    const found = flow.find(f => String(f.APPROVER_USER_ID) === sid);
    if (found) {
      // Route only to the selected approver at level 1
      effectiveFlow = [{ ...found, LEVEL_ORDER: 1 }];
    }
  }

  const isAuto = effectiveFlow.length === 1 && !!Number(effectiveFlow[0].AUTO_APPROVE);

  const afterState = AFTER_APPROVAL[phaseCode];
  const fromState  = phaseCodeToState(phaseCode);

  if (isAuto) {
    // Auto-approve: skip to next state immediately
    await db.executeWithCommit(
      "UPDATE crms_releases SET state='"+safe(afterState)+"',current_approval_level=0,updated_at=SYSDATE WHERE release_id="+rid, {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_release_history(release_id,action,from_state,to_state,changed_by) "+
      "VALUES("+rid+",'State Change','"+safe(fromState)+"','"+safe(afterState)+"',"+reqBy+")", {}
    );
    if (reqBy && reqBy !== '0') {
      await db.executeWithCommit(
        "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+
        reqBy+",'Auto-Approved','"+safe(relNum+' '+phaseCode+' auto-approved -> '+afterState)+"',"+rid+")", {}
      );
    }
    return { autoApproved:true, newState:afterState };
  }

  // Clear previous approvals for this phase
  await db.executeWithCommit(
    "DELETE FROM crms_release_approvals WHERE release_id="+rid+" AND phase_code='"+phaseCode+"'", {}
  );

  // Insert approval records for all levels
  for (const lvl of effectiveFlow) {
    await db.executeWithCommit(
      "INSERT INTO crms_release_approvals(release_id,module_id,phase_code,level_order,approver_user_id,status) "+
      "VALUES("+rid+","+mid+",'"+phaseCode+"',"+num(lvl.LEVEL_ORDER)+","+num(lvl.APPROVER_USER_ID)+",'Pending')", {}
    );
  }

  const firstLevel  = Number(effectiveFlow[0].LEVEL_ORDER);
  const firstAprUid = num(effectiveFlow[0].APPROVER_USER_ID);
  const phasePrefix = { DRAFT:'Draft', RD:'RD', FSD:'FSD', DEPLOYMENT:'Deployment' };
  // Use shorter 'Approval' suffix for Deployment to stay within VARCHAR2(30)
  const newState = phaseCode === 'DEPLOYMENT'
    ? 'Deployment Approval L' + firstLevel
    : (phasePrefix[phaseCode]||phaseCode) + ' Awaiting Approval L' + firstLevel;

  await db.executeWithCommit(
    "UPDATE crms_releases SET state='"+safe(newState)+"',current_approval_level="+firstLevel+",updated_at=SYSDATE WHERE release_id="+rid, {}
  );
  await db.executeWithCommit(
    "INSERT INTO crms_release_history(release_id,action,from_state,to_state,changed_by) "+
    "VALUES("+rid+",'State Change','"+safe(fromState)+"','"+safe(newState)+"',"+reqBy+")", {}
  );

  const aprRow = await db.queryOne('SELECT full_name FROM crms_users WHERE user_id='+firstAprUid, {});
  const approverName = aprRow ? aprRow.FULL_NAME : 'Approver';

  // Notify approver
  await db.executeWithCommit(
    "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+
    firstAprUid+",'Approval Required — "+phaseCode+"','"+
    safe(relNum+' requires your '+phaseCode+' approval (Level '+firstLevel+')')+"',"+rid+")", {}
  );
  // Notify requester (guard against invalid userId)
  if (reqBy && reqBy !== '0') {
    await db.executeWithCommit(
      "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+
      reqBy+",'Pending "+phaseCode+" Approval','"+
      safe(relNum+' is pending '+phaseCode+' approval with '+approverName+' (Level '+firstLevel+')')+"',"+rid+")", {}
    );
  }

  logger.info('Approval triggered', { releaseId:rid, phaseCode, firstLevel, approverName });
  return { newState, approverName, flowType:phaseCode };
}

// ── POST /releases/:releaseId/approve ────────────────────────────────
async function approve(req, res, next) {
  try {
    const rid      = num(req.params.releaseId);
    const uid      = num(req.user.userId);
    const comments = (req.body.comments||'').trim();

    const release = await db.queryOne(
      'SELECT release_id,state,release_number,module_id,current_approval_level,requested_by '+
      'FROM crms_releases WHERE release_id='+rid+' AND is_deleted=0', {}
    );
    if (!release) return res.status(404).json({ error:'Release not found' });

    const curState  = release.STATE;
    const curLevel  = Number(release.CURRENT_APPROVAL_LEVEL);
    const relNum    = release.RELEASE_NUMBER;
    const reqUserId = num(release.REQUESTED_BY);
    const mid       = num(String(release.MODULE_ID));

    // Determine phase from state name
    const phaseCode = stateToApprovalPhase(curState);
    if (!phaseCode)
      return res.status(400).json({ error:'Release is not in an approval state: '+curState });

    // Verify this user is the pending approver
    const myApproval = await db.queryOne(
      "SELECT approval_id FROM crms_release_approvals "+
      "WHERE release_id="+rid+" AND level_order="+curLevel+
      " AND approver_user_id="+uid+" AND status='Pending' AND phase_code='"+phaseCode+"'", {}
    );
    if (!myApproval)
      return res.status(403).json({ error:'You are not the approver for this level, or it has already been actioned.' });

    // Mark this level approved
    await db.executeWithCommit(
      "UPDATE crms_release_approvals SET status='Approved',comments='"+safe(comments)+"',actioned_at=SYSDATE "+
      "WHERE approval_id="+num(myApproval.APPROVAL_ID), {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES("+
      "'Approval',"+uid+",'"+relNum+"','"+phaseCode+" Level "+curLevel+" approved by "+safe(req.user.fullName)+"')", {}
    );

    // Check next level
    const nextLvl = await db.queryOne(
      "SELECT level_order,approver_user_id FROM crms_approval_flows "+
      "WHERE module_id="+mid+" AND phase_code='"+phaseCode+"' AND level_order="+(curLevel+1), {}
    );

    let newState, message;

    if (nextLvl) {
      // More levels remaining
      const nextLevel   = Number(nextLvl.LEVEL_ORDER);
      const nextAprUid  = num(nextLvl.APPROVER_USER_ID);
      var pp = { DRAFT:'Draft', RD:'RD', FSD:'FSD', DEPLOYMENT:'Deployment' };
      newState = phaseCode === 'DEPLOYMENT'
        ? 'Deployment Approval L' + nextLevel
        : (pp[phaseCode]||phaseCode) + ' Awaiting Approval L' + nextLevel;

      await db.executeWithCommit(
        "UPDATE crms_releases SET state='"+safe(newState)+"',current_approval_level="+nextLevel+",updated_at=SYSDATE WHERE release_id="+rid, {}
      );
      await db.executeWithCommit(
        "INSERT INTO crms_release_history(release_id,action,from_state,to_state,changed_by) "+
        "VALUES("+rid+",'State Change','"+safe(curState)+"','"+safe(newState)+"',"+uid+")", {}
      );

      const nextAprRow = await db.queryOne('SELECT full_name FROM crms_users WHERE user_id='+nextAprUid, {});
      const nextName   = nextAprRow ? nextAprRow.FULL_NAME : 'Approver';

      await db.executeWithCommit(
        "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+
        nextAprUid+",'Approval Required — "+phaseCode+"','"+
        safe(relNum+' requires your '+phaseCode+' approval (Level '+nextLevel+')')+"',"+rid+")", {}
      );
      await db.executeWithCommit(
        "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+
        reqUserId+",'Approval Progressing','"+
        safe(relNum+' '+phaseCode+' L'+curLevel+' approved. Now with '+nextName+' (L'+nextLevel+')')+"',"+rid+")", {}
      );
      message = phaseCode+' Level '+curLevel+' approved. Sent to Level '+nextLevel+' ('+nextName+').';
    } else {
      // All levels approved — move to next state
      const afterState = AFTER_APPROVAL[phaseCode];
      newState = afterState;

      await db.executeWithCommit(
        "UPDATE crms_releases SET state='"+safe(afterState)+"',current_approval_level=0,updated_at=SYSDATE WHERE release_id="+rid, {}
      );
      await db.executeWithCommit(
        "INSERT INTO crms_release_history(release_id,action,from_state,to_state,changed_by) "+
        "VALUES("+rid+",'State Change','"+safe(curState)+"','"+safe(afterState)+"',"+uid+")", {}
      );
      await db.executeWithCommit(
        "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES("+
        "'State Change',"+uid+",'"+relNum+"','"+phaseCode+" fully approved -> "+safe(afterState)+"')", {}
      );
      await db.executeWithCommit(
        "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+
        reqUserId+",'"+phaseCode+" Fully Approved','"+
        safe(relNum+' '+phaseCode+' fully approved. Moved to '+afterState)+"',"+rid+")", {}
      );

      // Auto-assign Process Owner for the next phase (if mapped)
      try {
        if (release.MODULE_ID) {
          const midStr = num(release.MODULE_ID);
          // RD approved → FSD phase; FSD approved → DEV; etc.
          const phaseToNext = { 'RD':'FSD', 'FSD':'DEV', 'DEV':'TESTING', 'TESTING':'UAT', 'UAT':'DEPLOYMENT' };
          const nextPhaseCode = phaseToNext[phaseCode];
          if (nextPhaseCode) {
            const po = await db.queryOne(
              "SELECT user_id FROM crms_phase_process_owners WHERE module_id="+midStr+
              " AND phase_code='"+nextPhaseCode+"'", {}
            );
            if (po && po.USER_ID) {
              const poUid = num(po.USER_ID);
              await db.executeWithCommit(
                "UPDATE crms_releases SET assigned_to_user_id="+poUid+",updated_at=SYSDATE WHERE release_id="+rid, {}
              );
              await db.executeWithCommit(
                "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+
                poUid+",'CR Auto-Assigned — Process Owner','"+
                safe(relNum+" moved to "+afterState+". You are the Process Owner for the "+nextPhaseCode+" phase.")+
                "',"+rid+")", {}
              );
            }
          }
        }
      } catch(e2) { /* table may not exist yet — skip */ }

      // Auto-assign tasks for the next phase
      const rc = require('./releaseController');
      const nextPhase = rc.stateToPhaseCode(afterState);
      if (nextPhase && release.MODULE_ID) {
        await rc.assignPhaseTasks(rid, release.MODULE_ID, nextPhase, uid);
      }

      message = phaseCode+' fully approved. Moved to '+afterState+'.';
    }

    return res.json({ message, newState, approvedLevel:curLevel, flowType:phaseCode });
  } catch(err) { next(err); }
}

// ── POST /releases/:releaseId/reject ─────────────────────────────────
async function reject(req, res, next) {
  try {
    const rid      = num(req.params.releaseId);
    const uid      = num(req.user.userId);
    const comments = (req.body.comments||'').trim();
    if (!comments) return res.status(422).json({ error:'Rejection reason is required.' });

    const release = await db.queryOne(
      'SELECT release_id,state,release_number,current_approval_level,requested_by '+
      'FROM crms_releases WHERE release_id='+rid+' AND is_deleted=0', {}
    );
    if (!release) return res.status(404).json({ error:'Release not found' });

    const curState  = release.STATE;
    const curLevel  = Number(release.CURRENT_APPROVAL_LEVEL);
    const relNum    = release.RELEASE_NUMBER;
    const reqUserId = num(release.REQUESTED_BY);
    const phaseCode = stateToApprovalPhase(curState);
    if (!phaseCode)
      return res.status(400).json({ error:'Release is not in an approval state.' });

    // Return to the phase state
    const returnState = phaseCodeToState(phaseCode);

    const myApproval = await db.queryOne(
      "SELECT approval_id FROM crms_release_approvals "+
      "WHERE release_id="+rid+" AND level_order="+curLevel+
      " AND approver_user_id="+uid+" AND status='Pending' AND phase_code='"+phaseCode+"'", {}
    );
    if (!myApproval)
      return res.status(403).json({ error:'You are not the approver for this level.' });

    // Mark all pending rejected
    await db.executeWithCommit(
      "UPDATE crms_release_approvals SET status='Rejected',comments='"+safe(comments)+"',actioned_at=SYSDATE "+
      "WHERE release_id="+rid+" AND status='Pending' AND phase_code='"+phaseCode+"'", {}
    );
    await db.executeWithCommit(
      "UPDATE crms_releases SET state='"+safe(returnState)+"',current_approval_level=0,updated_at=SYSDATE WHERE release_id="+rid, {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_release_history(release_id,action,from_state,to_state,changed_by) "+
      "VALUES("+rid+",'State Change','"+safe(curState)+"','"+safe(returnState)+"',"+uid+")", {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES("+
      "'Rejection',"+uid+",'"+relNum+"','"+phaseCode+" L"+curLevel+" rejected: "+safe(comments.substring(0,80))+"')", {}
    );
    // Post comment
    await db.executeWithCommit(
      "INSERT INTO crms_comments(release_id,comment_text,created_by) VALUES("+
      rid+",'REJECTED ("+phaseCode+" Level "+curLevel+"): "+safe(comments)+"',"+uid+")", {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_notifications(user_id,title,message,release_id) VALUES("+
      reqUserId+",'"+phaseCode+" Rejected','"+
      safe(relNum+' '+phaseCode+' rejected by '+req.user.fullName+': '+comments.substring(0,80))+"',"+rid+")", {}
    );

    return res.json({ message:'Rejected. Release returned to '+returnState+'.', newState:returnState });
  } catch(err) { next(err); }
}

// ── GET /approvals/pending ────────────────────────────────────────────
async function myPendingApprovals(req, res, next) {
  try {
    const uid  = num(req.user.userId);
    const rows = await db.query(
      'SELECT ra.approval_id,ra.release_id,ra.level_order,ra.phase_code,ra.created_at,'+
      'r.release_number,r.title,r.state,m.module_name,u.full_name AS requested_by '+
      'FROM crms_release_approvals ra '+
      'JOIN crms_releases r ON r.release_id=ra.release_id '+
      'LEFT JOIN crms_modules m ON m.module_id=r.module_id '+
      'JOIN crms_users u ON u.user_id=r.requested_by '+
      'WHERE ra.approver_user_id='+uid+" AND ra.status='Pending' "+
      'AND r.is_deleted=0 AND r.current_approval_level=ra.level_order ORDER BY ra.created_at ASC', {}
    );
    return res.json(rows.map(r => ({
      approvalId:    r.APPROVAL_ID,
      releaseId:     r.RELEASE_ID,
      releaseNumber: r.RELEASE_NUMBER,
      title:         r.TITLE,
      state:         r.STATE,
      levelOrder:    Number(r.LEVEL_ORDER),
      phaseCode:     r.PHASE_CODE,
      moduleName:    r.MODULE_NAME||'—',
      requestedBy:   r.REQUESTED_BY,
      createdAt:     r.CREATED_AT,
    })));
  } catch(err) { next(err); }
}

// ── GET /releases/:releaseId/approval-status ──────────────────────────
async function getApprovalStatus(req, res, next) {
  try {
    const rid  = num(req.params.releaseId);
    const rows = await db.query(
      'SELECT ra.phase_code,ra.level_order,ra.status,ra.comments,ra.actioned_at,u.full_name AS approver_name '+
      'FROM crms_release_approvals ra JOIN crms_users u ON u.user_id=ra.approver_user_id '+
      'WHERE ra.release_id='+rid+' ORDER BY ra.phase_code,ra.level_order', {}
    );
    return res.json(rows.map(r => ({
      phaseCode:    r.PHASE_CODE,
      levelOrder:   Number(r.LEVEL_ORDER),
      status:       r.STATUS,
      approverName: r.APPROVER_NAME,
      comments:     r.COMMENTS,
      actionedAt:   r.ACTIONED_AT,
    })));
  } catch(err) { next(err); }
}

// ── GET /approvals/my-release-status ─────────────────────────────────
async function myReleaseApprovalStatus(req, res, next) {
  try {
    const uid  = num(req.user.userId);
    const rows = await db.query(
      'SELECT ra.release_id,ra.level_order,ra.phase_code,u.full_name AS approver_name '+
      'FROM crms_release_approvals ra '+
      'JOIN crms_users u ON u.user_id=ra.approver_user_id '+
      'JOIN crms_releases r ON r.release_id=ra.release_id '+
      "WHERE r.requested_by="+uid+" AND ra.status='Pending' "+
      'AND r.is_deleted=0 AND r.current_approval_level=ra.level_order ORDER BY ra.release_id', {}
    );
    return res.json(rows.map(r => ({
      releaseId:    r.RELEASE_ID,
      levelOrder:   Number(r.LEVEL_ORDER),
      phaseCode:    r.PHASE_CODE,
      approverName: r.APPROVER_NAME,
    })));
  } catch(err) { next(err); }
}

// ── HELPERS ───────────────────────────────────────────────────────────
function stateToApprovalPhase(state) {
  if (!state) return null;
  var s = state.toLowerCase();
  if (s.startsWith('rd awaiting') || s.startsWith('rd approval'))           return 'RD';
  if (s.startsWith('fsd awaiting') || s.startsWith('fsd approval'))         return 'FSD';
  if (s.startsWith('deployment approval') || s.startsWith('deployment awaiting')) return 'DEPLOYMENT';
  return null;
}

function phaseCodeToState(code) {
  const map = {
    'DRAFT':'Draft', 'RD':'RD Phase', 'FSD':'FSD Phase',
    'DEV':'Development Phase', 'TESTING':'Testing Phase',
    'UAT':'UAT Phase', 'DEPLOYMENT':'Deployment Phase',
  };
  return map[code] || code;
}

// ── GET /approvals/pending — CRs pending current user's approval ──────
async function getPendingApprovals(req, res, next) {
  try {
    const uid = String(parseInt(req.user.userId,10)||0);
    const rows = await db.query(
      'SELECT ra.approval_id,ra.phase_code,ra.level_order,ra.status,'+
      'r.release_id,r.release_number,r.state,r.title,r.priority,r.planned_start_date,'+
      'u_req.full_name AS requested_by,r.created_at '+
      'FROM crms_release_approvals ra '+
      'JOIN crms_releases r ON r.release_id=ra.release_id AND r.is_deleted=0 '+
      'JOIN crms_users u_req ON u_req.user_id=r.requested_by '+
      'WHERE ra.approver_user_id='+uid+" AND ra.status='Pending' "+
      'ORDER BY r.created_at DESC', {}
    );
    return res.json(rows.map(function(r) {
      return {
        approvalId:     r.APPROVAL_ID,
        phaseCode:      r.PHASE_CODE,
        levelOrder:     Number(r.LEVEL_ORDER),
        status:         r.STATUS,
        releaseId:      r.RELEASE_ID,
        releaseNumber:  r.RELEASE_NUMBER,
        releaseState:   r.STATE,
        releaseTitle:   r.TITLE,
        priority:       r.PRIORITY,
        plannedStartDate: r.PLANNED_START_DATE,
        requestedBy:    r.REQUESTED_BY,
        createdAt:      r.CREATED_AT,
      };
    }));
  } catch(err) { next(err); }
}

// ── GET /approvals/is-approver — check if current user is an approver ─
async function isApprover(req, res, next) {
  try {
    const uid = String(parseInt(req.user.userId,10)||0);
    const row = await db.queryOne(
      'SELECT COUNT(*) AS cnt FROM crms_approval_flows WHERE approver_user_id='+uid, {}
    );
    const pending = await db.queryOne(
      'SELECT COUNT(*) AS cnt FROM crms_release_approvals WHERE approver_user_id='+uid+" AND status='Pending'", {}
    );
    return res.json({
      isApprover: Number(row.CNT) > 0,
      pendingCount: Number(pending.CNT),
    });
  } catch(err) { next(err); }
}


module.exports = {
  triggerApproval,
  approve, reject,
  myPendingApprovals, getApprovalStatus, myReleaseApprovalStatus,
  getPendingApprovals, isApprover,
};
