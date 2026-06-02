'use strict';
/**
 * Task List Controller
 * ════════════════════
 * CRITICAL: All functions here are called from setImmediate() AFTER the
 * HTTP response is sent. The request-scoped AsyncLocalStorage connection
 * is already closed at that point. We MUST use getFreshConn() directly
 * instead of relying on db.executeWithCommit / db.query which use the
 * stored async-local connection.
 */
const db     = require('../config/db');
const logger = require('../config/logger');
const oracledb = db.oracledb;

// ── Raw DB helpers that bypass AsyncLocalStorage ──────────────────────
async function rawExec(sql) {
  const conn = await oracledb.getConnection('crmsPool');
  try {
    await conn.execute(sql, {}, { autoCommit: true });
  } finally {
    try { await conn.close(); } catch(e) {}
  }
}

async function rawQuery(sql) {
  const conn = await oracledb.getConnection('crmsPool');
  try {
    const r = await conn.execute(sql, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r && r.rows) ? r.rows : [];
  } finally {
    try { await conn.close(); } catch(e) {}
  }
}

async function rawQueryOne(sql) {
  const rows = await rawQuery(sql);
  return rows[0] || null;
}

// ── Safe string escape ────────────────────────────────────────────────
function s(v) { return v != null ? String(v).replace(/'/g, "''") : ''; }
function n(v) { return parseInt(v, 10) || 0; }
function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-IN'); } catch(e) { return String(d); }
}

// ══════════════════════════════════════════════════════════════════════
// CORE: ensureTaskListRow
// Called on CR create AND on sub-task create/update.
// Creates the row if it doesn't exist, updates it if it does.
// This is the single source of truth for task list population.
// ══════════════════════════════════════════════════════════════════════
async function ensureTaskListRow(releaseNumber, updateFields) {
  // updateFields: { requester, title, project, module, owner, crOwner,
  //   pendingWith, stage, status, cemli, smartSheet, process,
  //   md50St, md50End, devSt, devEnd, tftSt, tftEnd,
  //   rdApprovalDt, uatClosedOn, deployedSamil, deployedMswil,
  //   approved1On, approved2On, approved3On }
  try {
    const existing = await rawQueryOne(
      "SELECT task_list_id FROM crms_task_list " +
      "WHERE cr_number='" + s(releaseNumber) + "' AND is_deleted=0 " +
      "FETCH FIRST 1 ROWS ONLY"
    );

    if (existing) {
      // ── UPDATE existing row ────────────────────────────────────────
      const sets = [];
      const f = updateFields;

      // Always updateable
      if (f.pendingWith  !== undefined) sets.push("pending_with='"  + s(f.pendingWith)  + "'");
      if (f.stage        !== undefined) sets.push("stage='"         + s(f.stage)        + "'");
      if (f.status       !== undefined) sets.push("status='"        + s(f.status)       + "'");

      // Project / module / title — update if provided
      if (f.project      !== undefined) sets.push("project='"       + s(f.project)      + "'");
      if (f.module       !== undefined) sets.push("module='"        + s(f.module)       + "'");
      if (f.title        !== undefined) sets.push("task_title='"    + s(f.title)        + "'");

      // Owner is locked once set — only update if current owner is blank
      if (f.owner || f.crOwner) {
        const ownerChk = await rawQueryOne(
          "SELECT owner FROM crms_task_list WHERE cr_number='" + s(releaseNumber) + "' AND is_deleted=0 FETCH FIRST 1 ROWS ONLY"
        );
        const curOwner = ownerChk ? (ownerChk.OWNER || '') : '';
        if (!curOwner && (f.owner || f.crOwner)) {
          sets.push("owner='"    + s(f.owner    || f.crOwner || '') + "'");
          sets.push("cr_owner='" + s(f.crOwner  || f.owner   || '') + "'");
        } else if (f.crOwner && curOwner) {
          // Already locked — never change owner, but update cr_owner display
          sets.push("cr_owner='" + s(f.crOwner) + "'");
        }
      }

      // CEMLI, SmartSheet, Process — update whenever provided (not just non-empty, allows clearing)
      if (f.cemli       !== undefined) sets.push("cemli='"       + s(f.cemli       || '') + "'");
      if (f.smartSheet  !== undefined) sets.push("smart_sheet='" + s(f.smartSheet  || '') + "'");
      if (f.process     !== undefined) sets.push("process='"     + s(f.process     || '') + "'");

      // Phase dates — only overwrite with non-empty values
      if (f.md50St)       sets.push("md50_st='"        + s(f.md50St)       + "'");
      if (f.md50End)      sets.push("md50_end='"       + s(f.md50End)      + "'");
      if (f.md50AppBy)    sets.push("md50_app_by='"    + s(f.md50AppBy)    + "'");
      if (f.md50AppOn)    sets.push("md50_app_on='"    + s(f.md50AppOn)    + "'");
      if (f.devSt)        sets.push("dev_st='"         + s(f.devSt)        + "'");
      if (f.devEnd)       sets.push("dev_end='"        + s(f.devEnd)       + "'");
      if (f.tftSt)        sets.push("tft_st='"         + s(f.tftSt)        + "'");
      if (f.tftEnd)       sets.push("tft_end='"        + s(f.tftEnd)       + "'");
      if (f.uatClosedOn)  sets.push("uat_closed_on='"  + s(f.uatClosedOn)  + "'");
      if (f.rdApprovalDt) sets.push("rd_approval_dt='" + s(f.rdApprovalDt) + "'");
      if (f.approved1On)  sets.push("approved1_on='"   + s(f.approved1On)  + "'");
      if (f.approved2On)  sets.push("approved2_on='"   + s(f.approved2On)  + "'");
      if (f.approved3On)  sets.push("approved3_on='"   + s(f.approved3On)  + "'");
      if (f.deployedSamil)sets.push("deployed_samil='" + s(f.deployedSamil)+ "'");
      if (f.deployedMswil)sets.push("deployed_mswil='" + s(f.deployedMswil)+ "'");

      if (sets.length) {
        await rawExec(
          "UPDATE crms_task_list SET " + sets.join(',') +
          " WHERE cr_number='" + s(releaseNumber) + "' AND is_deleted=0"
        );
        logger.info('[TL] ensureTaskListRow UPDATE', { releaseNumber, fields: Object.keys(updateFields) });
      }
    } else {
      // ── INSERT new row ─────────────────────────────────────────────
      const f = updateFields;
      const today = new Date().toLocaleDateString('en-IN');
      const cols = [
        'reported_on','requester','ticket_no','project','module','process','task_title',
        'owner','cr_owner','status','stage','pending_with',
        'md50_st','md50_end','dev_st','dev_end','tft_st','tft_end',
        'cr_number','auto_populated','created_by'
      ];
      const vals = [
        "'"  + s(f.reportedOn || today)       + "'",
        "'"  + s(f.requester  || '')          + "'",
        "'"  + s(releaseNumber)               + "'",
        "'"  + s(f.project    || '')          + "'",
        "'"  + s(f.module     || '')          + "'",
        "'"  + s(f.process    || '')          + "'",
        "'"  + s(f.title      || '')          + "'",
        "'"  + s(f.owner      || '')          + "'",
        "'"  + s(f.crOwner    || '')          + "'",
        "'"  + s(f.status     || 'OPEN')      + "'",
        "'"  + s(f.stage      || 'NOT STARTED') + "'",
        "'"  + s(f.pendingWith|| '')          + "'",
        "'"  + s(f.md50St     || '')          + "'",
        "'"  + s(f.md50End    || '')          + "'",
        "'"  + s(f.devSt      || '')          + "'",
        "'"  + s(f.devEnd     || '')          + "'",
        "'"  + s(f.tftSt      || '')          + "'",
        "'"  + s(f.tftEnd     || '')          + "'",
        "'"  + s(f.cemli      || '')          + "'",
        "'"  + s(f.smartSheet || '')          + "'",
        "'"  + s(releaseNumber)               + "'",
        "1",
        s(f.createdBy || '1'),
      ];
      await rawExec(
        "INSERT INTO crms_task_list (" + cols.join(',') + ") VALUES (" + vals.join(',') + ")"
      );
      logger.info('[TL] ensureTaskListRow INSERT', { releaseNumber });
    }
  } catch(e) {
    logger.error('[TL] ensureTaskListRow FAILED', {
      releaseNumber, error: e.message,
      stack: e.stack ? e.stack.split('\n').slice(0,3).join(' | ') : ''
    });
  }
}

// ══════════════════════════════════════════════════════════════════════
// createOnCRCreate — called when a new CR is created
// Creates the initial task list row with RD PENDING status
// ══════════════════════════════════════════════════════════════════════
async function createOnCRCreate(data) {
  await ensureTaskListRow(data.releaseNumber, {
    requester:   data.requestedByName || '',
    title:       data.title           || '',
    project:     data.company         || '',
    module:      data.moduleName      || '',
    owner:       '',
    crOwner:     '',
    pendingWith: '',
    stage:       'RD PENDING',
    status:      'OPEN',
    createdBy:   data.createdBy || 1,
  });
}

// ══════════════════════════════════════════════════════════════════════
// upsertFromSubTask — called when a sub-task is created/assigned
// Updates (or creates) the task list row with phase-specific data
// ══════════════════════════════════════════════════════════════════════
async function upsertFromSubTask(data) {
  const {
    releaseNumber, title, requestedByName, moduleName,
    crOwnerName, project, phaseCode, assigneeName, createdBy,
    cemli, smartsheetId, processName,
    plannedStartDate, plannedEndDate,
  } = data;

  const phaseToStage = {
    RD: 'RD PENDING', FSD: 'MD50 CREATION', DEV: 'DEVELOPMENT QUEUE',
    TESTING: 'TFT TESTING', UAT: 'UAT', DEPLOYMENT: 'DEPLOYMENT',
  };

  const fields = {
    requester:   requestedByName || '',
    title:       title           || '',
    project:     project         || '',
    module:      moduleName      || '',
    owner:       crOwnerName     || '',
    crOwner:     crOwnerName     || '',
    pendingWith: assigneeName    || '',
    stage:       phaseToStage[phaseCode] || 'NOT STARTED',
    status:      'OPEN',
    createdBy:   createdBy       || 1,
  };

  // CEMLI / SmartSheet / Process
  if (cemli)       fields.cemli      = cemli;
  if (smartsheetId)fields.smartSheet = smartsheetId;
  if (processName) fields.process    = processName;

  // Phase-specific date columns
  const fmt = fmtDate;
  if (phaseCode === 'FSD') {
    if (plannedStartDate) fields.md50St  = fmt(plannedStartDate);
    if (plannedEndDate)   fields.md50End = fmt(plannedEndDate);
  } else if (phaseCode === 'DEV') {
    if (plannedStartDate) fields.devSt   = fmt(plannedStartDate);
    if (plannedEndDate)   fields.devEnd  = fmt(plannedEndDate);
  } else if (phaseCode === 'TESTING') {
    if (plannedStartDate) fields.tftSt   = fmt(plannedStartDate);
    if (plannedEndDate)   fields.tftEnd  = fmt(plannedEndDate);
  }

  await ensureTaskListRow(releaseNumber, fields);
}

// ══════════════════════════════════════════════════════════════════════
// updatePhaseDate — called by writeStateChange and closePhaseTask
// ══════════════════════════════════════════════════════════════════════
async function updatePhaseDate(crNumber, toState, approverNameOrUid) {
  try {
    const today = new Date().toLocaleDateString('en-IN');
    const fields = {};

    // Task closed signals
    if (toState && toState.startsWith('task_closed_')) {
      const phase = toState.replace('task_closed_', '');
      if (phase === 'FSD')     fields.md50End     = today;
      if (phase === 'DEV')     fields.devEnd      = today;
      if (phase === 'TESTING') fields.tftEnd      = today;
      if (phase === 'UAT')     fields.uatClosedOn = today;
      if (Object.keys(fields).length) await ensureTaskListRow(crNumber, fields);
      return;
    }

    // State → date column + stage
    const stateMap = {
      'RD Phase':                 { stage: 'RD PENDING' },
      'RD Awaiting Approval L1':  { rdApprovalDt: today, stage: 'RD DISCUSSION' },
      'RD Awaiting Approval L2':  { rdApprovalDt: today, stage: 'RD DISCUSSION' },
      'RD Awaiting Approval L3':  { rdApprovalDt: today, stage: 'RD DISCUSSION' },
      'RD Approval L1':           { rdApprovalDt: today, stage: 'RD DISCUSSION' },
      'RD Approval L2':           { rdApprovalDt: today, stage: 'RD DISCUSSION' },
      'RD Approval L3':           { rdApprovalDt: today, stage: 'RD DISCUSSION' },
      'FSD Phase':                { md50St: today, stage: 'MD50 CREATION' },
      'FSD Awaiting Approval L1': { md50End: today, stage: 'MD50 APPROVAL' },
      'FSD Awaiting Approval L2': { md50End: today, stage: 'MD50 APPROVAL' },
      'FSD Awaiting Approval L3': { md50End: today, stage: 'MD50 APPROVAL' },
      'Development Phase':        { devSt:   today, stage: 'DEVELOPMENT QUEUE' },
      'Testing Phase':            { tftSt:   today, stage: 'TFT TESTING' },
      'UAT Phase':                { uatClosedOn: today, stage: 'UAT' },
      'Deployment Approval L1':   { approved1On: today, stage: 'MOVEMENT APPROVAL' },
      'Deployment Approval L2':   { approved2On: today, stage: 'MOVEMENT APPROVAL' },
      'Deployment Approval L3':   { approved3On: today, stage: 'MOVEMENT APPROVAL' },
      'Deployment Phase':         { deployedSamil: today, stage: 'DEPLOYMENT' },
      'Closed':                   { deployedMswil: today, stage: 'DEPLOYMENT', status: 'COMPLETE' },
      'Cancelled':                { stage: 'DROP', status: 'DROP' },
      'On Hold':                  { stage: 'FOLLOW UP' },
    };

    const mapping = stateMap[toState];
    if (!mapping) return;

    Object.assign(fields, mapping);

    // FSD Awaiting → look up approver name
    if (toState.startsWith('FSD Awaiting') || toState.startsWith('FSD Approval')) {
      fields.md50AppOn = today;
      if (approverNameOrUid) {
        if (!isNaN(Number(approverNameOrUid))) {
          try {
            const row = await rawQueryOne('SELECT full_name FROM crms_users WHERE user_id=' + Number(approverNameOrUid));
            if (row) fields.md50AppBy = row.FULL_NAME;
          } catch(e) {}
        } else {
          fields.md50AppBy = approverNameOrUid;
        }
      }
    }

    await ensureTaskListRow(crNumber, fields);
  } catch(e) {
    logger.error('[TL] updatePhaseDate FAILED', { crNumber, toState, error: e.message });
  }
}

// ══════════════════════════════════════════════════════════════════════
// updateOwner — called by setCrOwner when CR Owner is set/locked
// ══════════════════════════════════════════════════════════════════════
async function updateOwner(crNumber, ownerName) {
  try {
    await rawExec(
      "UPDATE crms_task_list SET owner='" + s(ownerName) + "',cr_owner='" + s(ownerName) + "' " +
      "WHERE cr_number='" + s(crNumber) + "' AND is_deleted=0"
    );
    logger.info('[TL] updateOwner', { crNumber, ownerName });
  } catch(e) {
    logger.error('[TL] updateOwner FAILED', { error: e.message });
  }
}

// ══════════════════════════════════════════════════════════════════════
// REST API endpoints
// ══════════════════════════════════════════════════════════════════════
const SEL_COLS =
  'task_list_id,reported_on,requester,service_now_id,ticket_no,smart_sheet,' +
  'project,module,process,task_title,owner,cr_owner,status,stage,pending_with,' +
  'cr_task_id,cr_number,auto_populated,created_by,created_at,updated_at';

const SEL_COLS_FULL =
  SEL_COLS + ',' +
  'delay_reason,comments,tracker_comments,' +
  'rd_approval_dt,md50_st,md50_end,md50_app_by,md50_app_on,' +
  'dev_st,dev_end,tft_st,tft_end,uat_closed_on,' +
  'approved1_on,approved2_on,approved3_on,' +
  'deployed_samil,deployed_mswil';

function camel(r) {
  return {
    taskListId:   r.TASK_LIST_ID,
    reportedOn:   r.REPORTED_ON    || '', requester:    r.REQUESTER      || '',
    serviceNowId: r.SERVICE_NOW_ID || '', ticketNo:     r.TICKET_NO      || '',
    smartSheet:   r.SMART_SHEET    || '', project:      r.PROJECT        || '',
    module:       r.MODULE         || '', process:      r.PROCESS        || '',
    taskTitle:    r.TASK_TITLE     || '', owner:        r.OWNER          || '',
    crOwner:      r.CR_OWNER       || '', status:       r.STATUS         || 'OPEN',
    stage:        r.STAGE          || '', pendingWith:  r.PENDING_WITH   || '',
    crTaskId:     r.CR_TASK_ID     || '', crNumber:     r.CR_NUMBER      || '',
    autoPopulated:r.AUTO_POPULATED === 1,
    delayReason:  r.DELAY_REASON   || '', comments:     r.COMMENTS       || '',
    trackerComments: r.TRACKER_COMMENTS || '',
    rdApprovalDt: r.RD_APPROVAL_DT || '', md50St:       r.MD50_ST        || '',
    md50End:      r.MD50_END       || '', md50AppBy:    r.MD50_APP_BY    || '',
    md50AppOn:    r.MD50_APP_ON    || '', devSt:        r.DEV_ST         || '',
    devEnd:       r.DEV_END        || '', tftSt:        r.TFT_ST         || '',
    tftEnd:       r.TFT_END        || '', uatClosedOn:  r.UAT_CLOSED_ON  || '',
    approved1On:  r.APPROVED1_ON   || '', approved2On:  r.APPROVED2_ON   || '',
    approved3On:  r.APPROVED3_ON   || '',
    deployedSamil:r.DEPLOYED_SAMIL || '', deployedMswil:r.DEPLOYED_MSWIL || '',
    createdAt:    r.CREATED_AT,   updatedAt: r.UPDATED_AT,
  };
}

async function getTaskList(req, res, next) {
  try {
    let rows;
    try {
      rows = await db.query('SELECT ' + SEL_COLS_FULL + ' FROM crms_task_list WHERE is_deleted=0 ORDER BY task_list_id ASC', {});
    } catch(e) {
      logger.warn('[TL] Full SELECT failed, fallback', { err: e.message });
      rows = await db.query('SELECT ' + SEL_COLS + ' FROM crms_task_list WHERE is_deleted=0 ORDER BY task_list_id ASC', {});
    }
    return res.json(rows.map(camel));
  } catch(err) { next(err); }
}

async function canEdit(req, res, next) {
  try {
    if (req.user.role === 'admin') return res.json({ canEdit: true });
    const row = await db.queryOne('SELECT editor_id FROM crms_task_list_editors WHERE user_id=' + n(req.user.userId), {});
    return res.json({ canEdit: !!row });
  } catch(err) { next(err); }
}

function buildSet(b) {
  const cols = [
    ['reported_on', b.reportedOn], ['requester', b.requester], ['service_now_id', b.serviceNowId],
    ['ticket_no', b.ticketNo], ['smart_sheet', b.smartSheet], ['project', b.project],
    ['module', b.module], ['process', b.process], ['task_title', b.taskTitle],
    ['owner', b.owner], ['cr_owner', b.crOwner||''],
    ['status', b.status||'NOT STARTED'], ['stage', b.stage||'NOT STARTED'],
    ['pending_with', b.pendingWith],
    ['delay_reason', b.delayReason||''], ['comments', b.comments||''],
    ['tracker_comments', b.trackerComments||''],
  ];
  return cols.map(([c,v]) => c+"='"+s(v||'')+"'").join(',');
}

async function createTask(req, res, next) {
  try {
    const b = req.body;
    const uid = n(req.user.userId);
    await db.executeWithCommit(
      "INSERT INTO crms_task_list (reported_on,requester,service_now_id,ticket_no,smart_sheet," +
      "project,module,process,task_title,owner,cr_owner,status,stage,pending_with," +
      "delay_reason,comments,tracker_comments,cr_task_id,cr_number,auto_populated,created_by) VALUES (" +
      "'"+s(b.reportedOn)+"','"+s(b.requester)+"','"+s(b.serviceNowId||'')+"','"+s(b.ticketNo)+"'," +
      "'"+s(b.smartSheet||'')+"','"+s(b.project)+"','"+s(b.module)+"','"+s(b.process||'')+"'," +
      "'"+s(b.taskTitle)+"','"+s(b.owner||'')+"','"+s(b.crOwner||'')+"'," +
      "'"+s(b.status||'NOT STARTED')+"','"+s(b.stage||'NOT STARTED')+"','"+s(b.pendingWith||'')+"'," +
      "'"+s(b.delayReason||'')+"','"+s(b.comments||'')+"','"+s(b.trackerComments||'')+"'," +
      "'"+s(b.crTaskId||'')+"','"+s(b.crNumber||'')+"',0,"+uid+")", {}
    );
    const newRow = await db.queryOne('SELECT MAX(task_list_id) AS new_id FROM crms_task_list WHERE created_by='+uid, {});
    return res.status(201).json({ taskListId: newRow && newRow.NEW_ID, message: 'Created' });
  } catch(err) { next(err); }
}

async function bulkUpsert(req, res, next) {
  try {
    const rows = req.body.rows;
    if (!Array.isArray(rows)||!rows.length) return res.status(422).json({error:'rows required'});
    const uid = n(req.user.userId);
    let created=0, updated=0;
    for (const b of rows) {
      if (b.taskListId) {
        await db.executeWithCommit('UPDATE crms_task_list SET '+buildSet(b)+' WHERE task_list_id='+n(b.taskListId), {});
        updated++;
      } else {
        await db.executeWithCommit(
          "INSERT INTO crms_task_list (reported_on,requester,service_now_id,ticket_no,smart_sheet,project,module,process,task_title,owner,cr_owner,status,stage,pending_with,delay_reason,comments,tracker_comments,cr_number,auto_populated,created_by) VALUES (" +
          "'"+s(b.reportedOn)+"','"+s(b.requester)+"','"+s(b.serviceNowId||'')+"','"+s(b.ticketNo||'')+"','"+s(b.smartSheet||'')+"'," +
          "'"+s(b.project||'')+"','"+s(b.module||'')+"','"+s(b.process||'')+"','"+s(b.taskTitle||'')+"','"+s(b.owner||'')+"','"+s(b.crOwner||'')+"'," +
          "'"+s(b.status||'NOT STARTED')+"','"+s(b.stage||'NOT STARTED')+"','"+s(b.pendingWith||'')+"'," +
          "'"+s(b.delayReason||'')+"','"+s(b.comments||'')+"','"+s(b.trackerComments||'')+"'," +
          "'"+s(b.crNumber||'')+"',0,"+uid+")", {}
        );
        created++;
      }
    }
    return res.json({ message:'Saved', created, updated });
  } catch(err) { next(err); }
}

async function updateTask(req, res, next) {
  try {
    const b = req.body;
    await db.executeWithCommit('UPDATE crms_task_list SET '+buildSet(b)+' WHERE task_list_id='+n(req.params.id)+' AND is_deleted=0', {});
    return res.json({ message:'Updated' });
  } catch(err) { next(err); }
}

async function deleteTask(req, res, next) {
  try {
    await db.executeWithCommit('UPDATE crms_task_list SET is_deleted=1 WHERE task_list_id='+n(req.params.id), {});
    return res.json({ message:'Deleted' });
  } catch(err) { next(err); }
}

async function bulkDelete(req, res, next) {
  try {
    const ids = (req.body.ids||[]).map(n).filter(Boolean);
    if (!ids.length) return res.status(422).json({error:'ids required'});
    await db.executeWithCommit('UPDATE crms_task_list SET is_deleted=1 WHERE task_list_id IN ('+ids.join(',')+')', {});
    return res.json({ message:'Deleted', count:ids.length });
  } catch(err) { next(err); }
}


// ══════════════════════════════════════════════════════════════════════
// getLiveTaskList — GET /task-list/live
// Builds task list directly from live CR data (releases + history + tasks).
// One row per CR. No dependency on crms_task_list stored table.
// This mirrors the Download Center state history but condensed into
// one row showing the complete lifecycle with all phase dates.
// ══════════════════════════════════════════════════════════════════════
async function getLiveTaskList(req, res, next) {
  try {
    // ── 1. Load all active releases ──────────────────────────────────
    const releases = await db.query(
      "SELECT r.release_id,r.release_number,r.title,r.state,r.company,r.module_id," +
      "r.planned_start_date,r.created_at,r.cr_owner_user_id," +
      "r.cemli,r.smartsheet_id,r.process_name," +
      "m.module_name," +
      "u_req.full_name AS requested_by," +
      "u_own.full_name AS cr_owner_name," +
      "u_cur.full_name AS current_assignee," +
      "ag.group_name   AS assignment_group " +
      "FROM crms_releases r " +
      "LEFT JOIN crms_modules m          ON m.module_id  = r.module_id " +
      "LEFT JOIN crms_users u_req        ON u_req.user_id = r.requested_by " +
      "LEFT JOIN crms_users u_own        ON u_own.user_id = r.cr_owner_user_id " +
      "LEFT JOIN crms_users u_cur        ON u_cur.user_id = r.assigned_to_user_id " +
      "LEFT JOIN crms_assignment_groups ag ON ag.group_id = r.assignment_group_id " +
      "WHERE r.is_deleted=0 ORDER BY r.created_at DESC", {}
    );

    if (!releases.length) return res.json([]);

    const releaseIds = releases.map(function(r){ return r.RELEASE_ID; });
    const idList = releaseIds.join(',');

    // ── 2. Load ALL sub-tasks for these releases in one query ─────────
    const tasks = await db.query(
      "SELECT rt.release_id,rt.phase_code,rt.task_number,rt.state," +
      "rt.planned_start_date,rt.planned_end_date,rt.closed_at," +
      "rt.cemli,rt.smartsheet_id,rt.process_name," +
      "u_at.full_name AS assigned_to," +
      "u_cl.full_name AS closed_by " +
      "FROM crms_release_tasks rt " +
      "LEFT JOIN crms_users u_at ON u_at.user_id = rt.assigned_to " +
      "LEFT JOIN crms_users u_cl ON u_cl.user_id = rt.closed_by " +
      "WHERE rt.release_id IN (" + idList + ") " +
      "ORDER BY rt.release_id, rt.created_at ASC", {}
    ).catch(function(){ return []; });

    // ── 3. Load ALL history for these releases in one query ───────────
    const history = await db.query(
      "SELECT h.release_id,h.to_state,h.changed_at,u.full_name AS changed_by " +
      "FROM crms_release_history h " +
      "JOIN crms_users u ON u.user_id = h.changed_by " +
      "WHERE h.release_id IN (" + idList + ") " +
      "ORDER BY h.release_id, h.changed_at ASC", {}
    ).catch(function(){ return []; });

    // ── 4. Load existing task-list rows for manual fields ────────────
    // (Delay Reason, Comments, Tracker Comments set by users)
    const tlRows = await db.query(
      "SELECT cr_number,delay_reason,comments,tracker_comments " +
      "FROM crms_task_list WHERE is_deleted=0", {}
    ).catch(function(){ return []; });

    const tlMap = {};
    tlRows.forEach(function(r){ tlMap[r.CR_NUMBER] = r; });

    // ── 5. Index tasks and history by release_id ──────────────────────
    const tasksByRel = {};
    tasks.forEach(function(t){
      const rid = t.RELEASE_ID;
      if (!tasksByRel[rid]) tasksByRel[rid] = [];
      tasksByRel[rid].push(t);
    });

    const histByRel = {};
    history.forEach(function(h){
      const rid = h.RELEASE_ID;
      if (!histByRel[rid]) histByRel[rid] = [];
      histByRel[rid].push(h);
    });

    // ── 6. Build one row per release ──────────────────────────────────
    function fmtDate(d) {
      if (!d) return '';
      try {
        var dt = d instanceof Date ? d : new Date(d);
        return dt.toLocaleDateString('en-IN');
      } catch(e){ return String(d); }
    }

    // State → Stage LOV
    var stageMap = {
      'RD Phase':'RD PENDING',
      'RD Awaiting Approval L1':'RD DISCUSSION','RD Awaiting Approval L2':'RD DISCUSSION',
      'RD Awaiting Approval L3':'RD DISCUSSION',
      'RD Approval L1':'RD DISCUSSION','RD Approval L2':'RD DISCUSSION',
      'FSD Phase':'MD50 CREATION',
      'FSD Awaiting Approval L1':'MD50 APPROVAL','FSD Awaiting Approval L2':'MD50 APPROVAL',
      'FSD Awaiting Approval L3':'MD50 APPROVAL',
      'Development Phase':'DEVELOPMENT QUEUE',
      'Testing Phase':'TFT TESTING',
      'UAT Phase':'UAT',
      'Deployment Approval L1':'MOVEMENT APPROVAL',
      'Deployment Approval L2':'MOVEMENT APPROVAL',
      'Deployment Approval L3':'MOVEMENT APPROVAL',
      'Deployment Phase':'DEPLOYMENT',
      'Closed':'DEPLOYMENT','Cancelled':'DROP','On Hold':'FOLLOW UP',
    };

    var rows = releases.map(function(rel) {
      var rid    = rel.RELEASE_ID;
      var relNum = rel.RELEASE_NUMBER;
      var rTasks = tasksByRel[rid] || [];
      var rHist  = histByRel[rid]  || [];
      var tlRow  = tlMap[relNum]   || {};

      // Helper: get first task for a phase
      function pt(phase) { return rTasks.find(function(t){ return t.PHASE_CODE===phase; }) || null; }
      function ptAll(phase) { return rTasks.filter(function(t){ return t.PHASE_CODE===phase; }); }

      // Current assignee = latest sub-task assignee in current phase
      // or current_assignee from releases
      var pendingWith = rel.CURRENT_ASSIGNEE || '';
      // More precise: find the open task assignee
      var openTask = rTasks.find(function(t){ return t.STATE==='Open' && t.ASSIGNED_TO; });
      if (openTask) pendingWith = openTask.ASSIGNED_TO;

      // Stage = from current state
      var stage  = stageMap[rel.STATE] || rel.STATE || 'NOT STARTED';
      // Status = OPEN unless Closed/Cancelled
      var status = rel.STATE === 'Closed'    ? 'COMPLETE'
                 : rel.STATE === 'Cancelled' ? 'DROP'
                 : 'OPEN';

      // Project = company name (first segment of assignment group as fallback)
      var project = rel.COMPANY || (rel.ASSIGNMENT_GROUP||'').split(/[-_]/)[0].toUpperCase() || '';

      // Sub-task dates — first task per phase
      var fsd  = pt('FSD');
      var dev  = pt('DEV');
      var test = pt('TESTING');
      var uat  = pt('UAT');
      var dep  = pt('DEPLOYMENT');

      // RD Approval date = when first RD Awaiting/Approval state was reached
      var rdApprDt = '';
      var rdHist = rHist.find(function(h){
        return h.TO_STATE && (h.TO_STATE.startsWith('RD Awaiting') || h.TO_STATE.startsWith('RD Approval'));
      });
      if (rdHist) rdApprDt = fmtDate(rdHist.CHANGED_AT);

      // MD50 App By and On = approver when FSD Awaiting was reached
      var md50AppBy = '', md50AppOn = '';
      var fsdApprHist = rHist.find(function(h){
        return h.TO_STATE && (h.TO_STATE.startsWith('FSD Awaiting') || h.TO_STATE.startsWith('FSD Approval'));
      });
      if (fsdApprHist) {
        md50AppBy = fsdApprHist.CHANGED_BY || '';
        md50AppOn = fmtDate(fsdApprHist.CHANGED_AT);
      }

      // Deployed On SAMIL = date of Deployment Phase state
      var depHist = rHist.find(function(h){ return h.TO_STATE === 'Deployment Phase'; });
      var deployedSamil = depHist ? fmtDate(depHist.CHANGED_AT) : '';

      // Deployed On MSWIL = date of Closed state
      var closedHist = rHist.find(function(h){ return h.TO_STATE === 'Closed'; });
      var deployedMswil = closedHist ? fmtDate(closedHist.CHANGED_AT) : '';

      // 1st/2nd/3rd Approved On = Deployment Approval L1/L2/L3
      var dep1 = rHist.find(function(h){ return h.TO_STATE === 'Deployment Approval L1'; });
      var dep2 = rHist.find(function(h){ return h.TO_STATE === 'Deployment Approval L2'; });
      var dep3 = rHist.find(function(h){ return h.TO_STATE === 'Deployment Approval L3'; });

      // CEMLI, SmartSheet, Process:
      // Priority 1 — saved on CR detail screen (crms_releases)
      // Priority 2 — saved on FSD sub-task creation (crms_release_tasks)
      var cemli      = rel.CEMLI         || (fsd ? (fsd.CEMLI        ||'') : '');
      var smartSheet = rel.SMARTSHEET_ID || (fsd ? (fsd.SMARTSHEET_ID||'') : '');
      var process    = rel.PROCESS_NAME  || (fsd ? (fsd.PROCESS_NAME ||'') : '');

      return {
        // Identity
        releaseNumber:   relNum,
        ticketNo:        relNum,
        // Header fields
        reportedOn:      fmtDate(rel.CREATED_AT),
        requester:       rel.REQUESTED_BY    || '',
        cemli:           cemli,
        serviceNowId:    '',
        smartSheet:      smartSheet,
        project:         project,
        module:          rel.MODULE_NAME     || '',
        process:         process,
        taskTitle:       rel.TITLE           || '',
        // Owner — CR Owner (locked in FSD)
        owner:           rel.CR_OWNER_NAME   || '',
        crOwner:         rel.CR_OWNER_NAME   || '',
        // Current state
        status:          status,
        stage:           stage,
        pendingWith:     pendingWith,
        // Manually editable fields (from crms_task_list if exists)
        delayReason:     tlRow.DELAY_REASON      || '',
        comments:        tlRow.COMMENTS          || '',
        trackerComments: tlRow.TRACKER_COMMENTS  || '',
        // RD approval
        rdApprovalDt:    rdApprDt,
        // MD50 (FSD phase)
        md50St:          fsd  ? fmtDate(fsd.PLANNED_START_DATE) : '',
        md50End:         fsd  ? (fsd.CLOSED_AT ? fmtDate(fsd.CLOSED_AT) : (fsd.PLANNED_END_DATE ? fmtDate(fsd.PLANNED_END_DATE) : '')) : '',
        md50AppBy:       md50AppBy,
        md50AppOn:       md50AppOn,
        // Development
        devSt:           dev  ? fmtDate(dev.PLANNED_START_DATE)  : '',
        devEnd:          dev  ? (dev.CLOSED_AT  ? fmtDate(dev.CLOSED_AT)  : '') : '',
        // Testing
        tftSt:           test ? fmtDate(test.PLANNED_START_DATE) : '',
        tftEnd:          test ? (test.CLOSED_AT ? fmtDate(test.CLOSED_AT) : '') : '',
        // UAT
        uatClosedOn:     uat  ? (uat.CLOSED_AT  ? fmtDate(uat.CLOSED_AT)  : '') : '',
        // Deployment approvals
        approved1On:     dep1 ? fmtDate(dep1.CHANGED_AT) : '',
        approved2On:     dep2 ? fmtDate(dep2.CHANGED_AT) : '',
        approved3On:     dep3 ? fmtDate(dep3.CHANGED_AT) : '',
        deployedSamil:   deployedSamil,
        deployedMswil:   deployedMswil,
        // Source
        autoPopulated:   true,
        crNumber:        relNum,
        state:           rel.STATE,
      };
    });

    return res.json(rows);
  } catch(err) { next(err); }
}
// ── POST /task-list/save-manual — save 3 editable fields for one CR ──
async function saveManual(req, res, next) {
  try {
    const { crNumber, delayReason, comments, trackerComments } = req.body;
    if (!crNumber) return res.status(422).json({ error: 'crNumber required' });
    const s = function(v) { return v != null ? String(v).replace(/'/g,"''") : ''; };
    // Upsert into crms_task_list for the editable columns only
    // Check if row exists
    const existing = await db.queryOne(
      "SELECT task_list_id FROM crms_task_list WHERE cr_number='" + s(crNumber) + "' AND is_deleted=0 FETCH FIRST 1 ROWS ONLY", {}
    );
    if (existing) {
      await db.executeWithCommit(
        "UPDATE crms_task_list SET " +
        "delay_reason='"     + s(delayReason||'')     + "'," +
        "comments='"         + s(comments||'')         + "'," +
        "tracker_comments='" + s(trackerComments||'')  + "' " +
        "WHERE cr_number='"  + s(crNumber)             + "' AND is_deleted=0", {}
      );
    } else {
      await db.executeWithCommit(
        "INSERT INTO crms_task_list(cr_number,delay_reason,comments,tracker_comments,auto_populated,created_by) " +
        "VALUES('" + s(crNumber) + "','" + s(delayReason||'') + "','" + s(comments||'') + "','" + s(trackerComments||'') + "',1," + n(req.user.userId) + ")", {}
      );
    }
    return res.json({ message: 'Saved' });
  } catch(err) { next(err); }
}

// ── POST /task-list/save-manual-bulk — save editable fields for many CRs
async function saveManualBulk(req, res, next) {
  try {
    const rows = req.body.rows;
    if (!Array.isArray(rows)||!rows.length) return res.status(422).json({error:'rows required'});
    for (const row of rows) {
      req.body = row;
      const mockRes = { json: function(){}, status: function(){ return this; } };
      await saveManual({ ...req, body: row }, mockRes, function(e){ if(e) throw e; });
    }
    return res.json({ message: 'Saved', count: rows.length });
  } catch(err) { next(err); }
}

// ── updateCemliFields — safe update that handles missing columns ──────
// If the cemli/smart_sheet/process columns don't exist yet, silently skips them
async function updateCemliFields(crNumber, cemli, smartSheet, process) {
  // Try updating all three columns; if any column doesn't exist, try individually
  const crn = s(crNumber);
  try {
    const sets = [];
    if (cemli      !== undefined) sets.push("cemli='"      + s(cemli||'')      + "'");
    if (smartSheet !== undefined) sets.push("smart_sheet='" + s(smartSheet||'') + "'");
    if (process    !== undefined) sets.push("process='"     + s(process||'')    + "'");
    if (!sets.length) return;
    await rawExec("UPDATE crms_task_list SET " + sets.join(',') + " WHERE cr_number='" + crn + "' AND is_deleted=0");
  } catch(e) {
    if (e.message && (e.message.includes('ORA-00904') || e.message.includes('invalid identifier'))) {
      logger.warn('[TL] updateCemliFields: column missing — run crms_task_list_v2_ddl.sql to add cemli/smart_sheet/process columns');
      // Try to update just the process column which is in the base DDL
      if (process !== undefined) {
        try {
          await rawExec("UPDATE crms_task_list SET process='" + s(process||'') + "' WHERE cr_number='" + crn + "' AND is_deleted=0");
        } catch(e2) { /* process column also missing */ }
      }
    } else {
      logger.error('[TL] updateCemliFields failed', { error: e.message });
    }
  }
}

module.exports = {
  getTaskList, getLiveTaskList, canEdit, createTask, bulkUpsert, updateTask, deleteTask, bulkDelete,
  saveManual, saveManualBulk, updateCemliFields,
  createOnCRCreate, upsertFromSubTask, updatePhaseDate, updateOwner,
  ensureTaskListRow,
};
