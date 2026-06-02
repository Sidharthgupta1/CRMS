'use strict';

const db     = require('../config/db');
const logger = require('../config/logger');

function safe(s) { return String(s||'').replace(/'/g,"''"); }
function num(n)  { return String(parseInt(n,10)||0); }

const APPROVAL_PHASES = ['DRAFT','RD','FSD','DEPLOYMENT'];
const ALL_PHASES      = ['DRAFT','RD','FSD','DEV','TESTING','UAT','DEPLOYMENT'];

// ── GET /modules ──────────────────────────────────────────────────────
async function getAll(req, res, next) {
  try {
    const modules = await db.query(
      "SELECT module_id,module_name,description,is_active FROM crms_modules ORDER BY module_name", {}
    );

    const result = [];
    for (const m of modules) {
      const mid = num(m.MODULE_ID);

      // Phase groups (DRAFT,RD,FSD,DEV,TESTING,UAT,DEPLOYMENT)
      const groups = await db.query(
        "SELECT pg.phase_code,ag.group_id,ag.group_name "+
        "FROM crms_phase_groups pg "+
        "JOIN crms_assignment_groups ag ON ag.group_id=pg.group_id "+
        "WHERE pg.module_id="+mid+" ORDER BY pg.phase_code", {}
      );

      // Approval flows per phase
      const flows = await db.query(
        "SELECT af.phase_code,af.level_order,af.approver_user_id,af.auto_approve,u.full_name AS approver_name "+
        "FROM crms_approval_flows af "+
        "JOIN crms_users u ON u.user_id=af.approver_user_id "+
        "WHERE af.module_id="+mid+" ORDER BY af.phase_code,af.level_order", {}
      );

      // Templates (RD only)
      const templates = await db.query(
        "SELECT phase_code,file_name,created_at FROM crms_phase_templates WHERE module_id="+mid, {}
      );

      // Build phaseGroups map (last group per phase, for backward compat)
      const phaseGroups = {};
      groups.forEach(g => {
        phaseGroups[g.PHASE_CODE] = { groupId: g.GROUP_ID, groupName: g.GROUP_NAME };
      });
      // Also build phaseGroupsList — all groups per phase (multi-group support)
      const phaseGroupsAll = {};
      groups.forEach(g => {
        if (!phaseGroupsAll[g.PHASE_CODE]) phaseGroupsAll[g.PHASE_CODE] = [];
        phaseGroupsAll[g.PHASE_CODE].push({ groupId: g.GROUP_ID, groupName: g.GROUP_NAME });
      });
      // Flat list of all unique groups for this module (for filtering in create modal)
      const moduleGroupIds = {};
      groups.forEach(g => { moduleGroupIds[String(g.GROUP_ID)] = { groupId: g.GROUP_ID, groupName: g.GROUP_NAME }; });
      const moduleGroups = Object.values(moduleGroupIds);

      // Build approvalFlows map — keyed by phase_code
      const approvalFlows = {};
      flows.forEach(f => {
        if (!approvalFlows[f.PHASE_CODE]) approvalFlows[f.PHASE_CODE] = [];
        approvalFlows[f.PHASE_CODE].push({
          levelOrder:     Number(f.LEVEL_ORDER),
          approverUserId: f.APPROVER_USER_ID,
          fullName:       f.APPROVER_NAME,
          autoApprove:    !!Number(f.AUTO_APPROVE),
        });
      });

      // Phase reviewers per phase
      const reviewers = await db.query(
        'SELECT pr.phase_code,pr.group_id,ag.group_name,pr.user_id,u.full_name '+
        'FROM crms_phase_reviewers pr '+
        'JOIN crms_users u ON u.user_id=pr.user_id '+
        'JOIN crms_assignment_groups ag ON ag.group_id=pr.group_id '+
        'WHERE pr.module_id='+mid+' ORDER BY pr.phase_code,u.full_name', {}
      ).catch(function(){ return []; });

      // Phase process owners per phase
      const processOwners = await db.query(
        'SELECT po.phase_code,po.group_id,ag.group_name,po.user_id,u.full_name '+
        'FROM crms_phase_process_owners po '+
        'JOIN crms_users u ON u.user_id=po.user_id '+
        'JOIN crms_assignment_groups ag ON ag.group_id=po.group_id '+
        'WHERE po.module_id='+mid+' ORDER BY po.phase_code', {}
      ).catch(function(){ return []; });

      // Build maps
      const reviewersByPhase = {};
      reviewers.forEach(r => {
        if (!reviewersByPhase[r.PHASE_CODE]) reviewersByPhase[r.PHASE_CODE] = [];
        reviewersByPhase[r.PHASE_CODE].push({ groupId:r.GROUP_ID, groupName:r.GROUP_NAME, userId:r.USER_ID, fullName:r.FULL_NAME });
      });
      const processOwnerByPhase = {};
      processOwners.forEach(po => {
        processOwnerByPhase[po.PHASE_CODE] = { groupId:po.GROUP_ID, groupName:po.GROUP_NAME, userId:po.USER_ID, fullName:po.FULL_NAME };
      });

      result.push({
        moduleId:      m.MODULE_ID,
        moduleName:    m.MODULE_NAME,
        description:   m.DESCRIPTION,
        isActive:      !!Number(m.IS_ACTIVE),
        phaseGroups,
        phaseGroupsAll,
        moduleGroups,
        reviewersByPhase,
        processOwnerByPhase,
        approvalFlows,
        // Legacy aliases so old frontend code still works
        groups:            groups.map(g => ({ groupId:g.GROUP_ID, groupName:g.GROUP_NAME, phaseCode:g.PHASE_CODE })),
        rdApprovalFlow:    approvalFlows['RD']   || [],
        fsdApprovalFlow:   approvalFlows['FSD']  || [],
        draftApprovalFlow: approvalFlows['DRAFT'] || [],
        deployApprovalFlow:approvalFlows['DEPLOYMENT'] || [],
        templates: templates.reduce((acc, t) => {
          acc[t.PHASE_CODE] = { fileName: t.FILE_NAME, createdAt: t.CREATED_AT };
          return acc;
        }, {}),
      });
    }
    return res.json(result);
  } catch(err) { next(err); }
}

// ── POST /modules ─────────────────────────────────────────────────────
async function create(req, res, next) {
  try {
    const { moduleName, description } = req.body;
    if (!moduleName) return res.status(422).json({ error:'Module name required' });
    await db.executeWithCommit(
      "INSERT INTO crms_modules(module_name,description) VALUES('"+safe(moduleName)+"','"+safe(description||'')+"')", {}
    );
    logger.info('Module created', { moduleName });
    return res.status(201).json({ message:'Module created' });
  } catch(err) { next(err); }
}

// ── PUT /modules/:moduleId/groups — set multiple phase groups at once ─
async function updateGroups(req, res, next) {
  try {
    const mid = num(req.params.moduleId);
    const { groupIds, phaseCode, groupId } = req.body;

    // Single phase update: { phaseCode, groupId }
    if (phaseCode && groupId) {
      return setPhaseGroup({ params:{ moduleId:mid }, body:{ phaseCode, groupId } }, res, next);
    }

    // Legacy: { groupIds: [...] } — assign same groups to all phases
    if (Array.isArray(groupIds)) {
      // For legacy support: set the first groupId to all unset phases
      for (const gid of groupIds) {
        for (const phase of ALL_PHASES) {
          const existing = await db.queryOne(
            "SELECT phase_group_id FROM crms_phase_groups WHERE module_id="+mid+" AND phase_code='"+phase+"'", {}
          );
          if (!existing) {
            await db.executeWithCommit(
              "INSERT INTO crms_phase_groups(module_id,phase_code,group_id) VALUES("+mid+",'"+phase+"',"+num(gid)+")", {}
            );
          }
        }
      }
      return res.json({ message:'Groups updated' });
    }
    return res.status(422).json({ error:'Provide phaseCode+groupId or groupIds array' });
  } catch(err) { next(err); }
}

// ── PUT /modules/:moduleId/phase-group ────────────────────────────────
async function setPhaseGroup(req, res, next) {
  try {
    const mid       = num(req.params.moduleId || req.params.id);
    const { phaseCode, groupId } = req.body;
    if (!ALL_PHASES.includes(phaseCode)) return res.status(422).json({ error:'Invalid phase: '+phaseCode });
    if (!groupId) return res.status(422).json({ error:'groupId required' });

    const existing = await db.queryOne(
      "SELECT phase_group_id FROM crms_phase_groups WHERE module_id="+mid+" AND phase_code='"+phaseCode+"'", {}
    );
    if (existing) {
      await db.executeWithCommit(
        "UPDATE crms_phase_groups SET group_id="+num(groupId)+" WHERE module_id="+mid+" AND phase_code='"+phaseCode+"'", {}
      );
    } else {
      await db.executeWithCommit(
        "INSERT INTO crms_phase_groups(module_id,phase_code,group_id) VALUES("+mid+",'"+phaseCode+"',"+num(groupId)+")", {}
      );
    }
    return res.json({ message:'Phase group updated' });
  } catch(err) { next(err); }
}

// ── PUT /modules/:moduleId/users — legacy endpoint (no-op for now) ────
async function updateUsers(req, res, next) {
  // In V2 there are no module_users table — users belong to groups
  // Return success so old frontend code doesn't break
  return res.json({ message:'Users updated' });
}

// ── PUT /modules/:moduleId/flow — RD + FSD approval flows ─────────────
// Accepts { rdLevels: [{approverUserId, autoApprove}], fsdLevels: [...] }
// Also accepts { phaseCode, levels } for single-phase update
async function updateFlow(req, res, next) {
  try {
    const mid = num(req.params.moduleId);
    const { rdLevels, fsdLevels, phaseCode, levels } = req.body;

    // Single phase: { phaseCode, levels }
    if (phaseCode && Array.isArray(levels)) {
      await saveLevels(mid, phaseCode, levels);
      return res.json({ message:'Approval flow saved for '+phaseCode });
    }

    // Multi-phase: { rdLevels, fsdLevels }
    if (rdLevels)  await saveLevels(mid, 'RD',  rdLevels);
    if (fsdLevels) await saveLevels(mid, 'FSD', fsdLevels);
    return res.json({ message:'Approval flows saved' });
  } catch(err) { next(err); }
}

// ── PUT /modules/:moduleId/approval-flow ─────────────────────────────
async function setApprovalFlow(req, res, next) {
  try {
    const mid = num(req.params.moduleId);
    const { phaseCode, levels } = req.body;
    if (!APPROVAL_PHASES.includes(phaseCode)) return res.status(422).json({ error:'Approval phases: DRAFT, RD, FSD, DEPLOYMENT' });
    if (!Array.isArray(levels)) return res.status(422).json({ error:'levels array required' });
    await saveLevels(mid, phaseCode, levels);
    return res.json({ message:'Approval flow saved for '+phaseCode });
  } catch(err) { next(err); }
}

async function saveLevels(mid, phaseCode, levels) {
  await db.executeWithCommit(
    "DELETE FROM crms_approval_flows WHERE module_id="+mid+" AND phase_code='"+phaseCode+"'", {}
  );
  for (let i = 0; i < levels.length; i++) {
    const lvl = levels[i];
    const uid = num(lvl.approverUserId || lvl.userId);
    if (!uid || uid === '0') continue;
    await db.executeWithCommit(
      "INSERT INTO crms_approval_flows(module_id,phase_code,level_order,approver_user_id,auto_approve) "+
      "VALUES("+mid+",'"+phaseCode+"',"+(i+1)+","+uid+","+(lvl.autoApprove?1:0)+")", {}
    );
  }
}

// ── POST /modules/:moduleId/templates/:phaseCode ──────────────────────
async function uploadTemplate(req, res, next) {
  try {
    const mid       = num(req.params.moduleId);
    const phaseCode = req.params.phaseCode.toUpperCase();
    const uid       = num(req.user.userId);
    const { fileName, fileType, fileData } = req.body;
    if (!fileName || !fileData) return res.status(422).json({ error:'fileName and fileData required' });

    const existing = await db.queryOne(
      "SELECT template_id FROM crms_phase_templates WHERE module_id="+mid+" AND phase_code='"+phaseCode+"'", {}
    );
    const chunk0 = safe(fileData.substring(0,4000));
    if (existing) {
      await db.executeWithCommit(
        "UPDATE crms_phase_templates SET file_name='"+safe(fileName)+"',file_type='"+safe(fileType||'')+"',"+
        "file_data=TO_CLOB('"+chunk0+"'),uploaded_by="+uid+",created_at=SYSTIMESTAMP "+
        "WHERE module_id="+mid+" AND phase_code='"+phaseCode+"'", {}
      );
    } else {
      await db.executeWithCommit(
        "INSERT INTO crms_phase_templates(module_id,phase_code,file_name,file_type,file_data,uploaded_by) "+
        "VALUES("+mid+",'"+phaseCode+"','"+safe(fileName)+"','"+safe(fileType||'')+"',TO_CLOB('"+chunk0+"'),"+uid+")", {}
      );
    }
    // Append remaining chunks for large files
    if (fileData.length > 4000) {
      const tmpl = await db.queryOne(
        "SELECT template_id FROM crms_phase_templates WHERE module_id="+mid+" AND phase_code='"+phaseCode+"'", {}
      );
      let offset = 4000;
      while (offset < fileData.length) {
        const chunk = safe(fileData.substring(offset, offset+4000));
        await db.executeWithCommit(
          "UPDATE crms_phase_templates SET file_data=file_data||TO_CLOB('"+chunk+"') "+
          "WHERE template_id="+num(tmpl.TEMPLATE_ID), {}
        );
        offset += 4000;
      }
    }
    return res.json({ message:'Template uploaded for '+phaseCode });
  } catch(err) { next(err); }
}

// ── GET /modules/:moduleId/templates/:phaseCode/download ─────────────
async function downloadTemplate(req, res, next) {
  try {
    const mid       = num(req.params.moduleId);
    const phaseCode = req.params.phaseCode.toUpperCase();
    const row = await db.queryOne(
      "SELECT file_name,file_type,file_data FROM crms_phase_templates WHERE module_id="+mid+" AND phase_code='"+phaseCode+"'", {}
    );
    if (!row) return res.status(404).json({ error:'No template for '+phaseCode+'. Ask Admin to upload it.' });
    return res.json({ fileName:row.FILE_NAME, fileType:row.FILE_TYPE, fileData:row.FILE_DATA });
  } catch(err) { next(err); }
}

// ── GET /ref/modules — lightweight module list for dropdowns ──────────
async function getModulesRef(req, res, next) {
  try {
    const rows = await db.query(
      'SELECT module_id,module_name FROM crms_modules WHERE is_active=1 ORDER BY module_name', {}
    );
    return res.json(rows.map(function(r) {
      return { moduleId: r.MODULE_ID, moduleName: r.MODULE_NAME };
    }));
  } catch(err) { next(err); }
}


// ── PUT /modules/:moduleId/phase-groups — set multiple groups per phase ──
async function setPhaseGroupMulti(req, res, next) {
  try {
    const mid      = String(parseInt(req.params.moduleId, 10)||0);
    const { phaseCode, groupIds } = req.body;
    if (!phaseCode)                return res.status(422).json({ error:'phaseCode required' });
    if (!Array.isArray(groupIds))  return res.status(422).json({ error:'groupIds array required' });

    const safe = s => String(s||'').replace(/'/g,"''");
    const num  = n => String(parseInt(n,10)||0);

    // Delete all existing rows for this module+phase
    await db.executeWithCommit(
      "DELETE FROM crms_phase_groups WHERE module_id="+mid+" AND phase_code='"+safe(phaseCode)+"'", {}
    );

    // Insert one row per groupId
    for (const gid of groupIds) {
      if (!gid) continue;
      await db.executeWithCommit(
        "INSERT INTO crms_phase_groups(module_id,phase_code,group_id) VALUES("+mid+",'"+safe(phaseCode)+"',"+num(gid)+")", {}
      );
    }

    logger.info('Phase groups updated', { moduleId:mid, phaseCode, groupIds });
    return res.json({ message:'Phase groups updated for '+phaseCode });
  } catch(err) { next(err); }
}


// ── PUT /modules/:moduleId/phase-reviewers — set reviewers for a phase ──
async function setPhaseReviewers(req, res, next) {
  try {
    const mid = String(parseInt(req.params.moduleId,10)||0);
    const { phaseCode, reviewers } = req.body; // reviewers: [{groupId, userId}]
    if (!phaseCode) return res.status(422).json({ error:'phaseCode required' });
    const safe = s => String(s||'').replace(/'/g,"''");
    const num  = n => String(parseInt(n,10)||0);
    await db.executeWithCommit(
      "DELETE FROM crms_phase_reviewers WHERE module_id="+mid+" AND phase_code='"+safe(phaseCode)+"'", {}
    );
    for (const rv of (reviewers||[])) {
      if (!rv.userId || !rv.groupId) continue;
      await db.executeWithCommit(
        "INSERT INTO crms_phase_reviewers(module_id,phase_code,group_id,user_id) VALUES("+
        mid+",'"+safe(phaseCode)+"',"+num(rv.groupId)+","+num(rv.userId)+")", {}
      );
    }
    return res.json({ message:'Reviewers updated for '+phaseCode });
  } catch(err) { next(err); }
}

// ── PUT /modules/:moduleId/phase-process-owner — set process owner for a phase ──
async function setPhaseProcessOwner(req, res, next) {
  try {
    const mid = String(parseInt(req.params.moduleId,10)||0);
    const { phaseCode, groupId, userId } = req.body;
    if (!phaseCode || !userId) return res.status(422).json({ error:'phaseCode and userId required' });
    const safe = s => String(s||'').replace(/'/g,"''");
    const num  = n => String(parseInt(n,10)||0);
    await db.executeWithCommit(
      "DELETE FROM crms_phase_process_owners WHERE module_id="+mid+" AND phase_code='"+safe(phaseCode)+"'", {}
    );
    if (userId) {
      await db.executeWithCommit(
        "INSERT INTO crms_phase_process_owners(module_id,phase_code,group_id,user_id) VALUES("+
        mid+",'"+safe(phaseCode)+"',"+num(groupId)+","+num(userId)+")", {}
      );
    }
    return res.json({ message:'Process owner updated for '+phaseCode });
  } catch(err) { next(err); }
}


module.exports = {
  getModulesRef,
  getAll, create,
  setPhaseReviewers, setPhaseProcessOwner,
  updateGroups, setPhaseGroup, setPhaseGroupMulti, updateUsers,
  updateFlow, setApprovalFlow,
  uploadTemplate, downloadTemplate,
};
