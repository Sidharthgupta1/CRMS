'use strict';
/**
 * ServiceNow Controller
 * Handles: admin status/config/test, inbound webhooks
 */
const snow   = require('../services/servicenowService');
const logger = require('../config/logger');
const db     = require('../config/db');

// ── GET /admin/servicenow/status ──────────────────────────────────────
async function getStatus(req, res, next) {
  try {
    const [config, connection] = await Promise.all([
      snow.getConfig(),
      snow.testConnection(),
    ]);
    return res.json({ config, connection });
  } catch(err) { next(err); }
}

// ── GET /admin/servicenow/config ──────────────────────────────────────
async function getConfig(req, res, next) {
  try {
    return res.json(snow.getConfig());
  } catch(err) { next(err); }
}

// ── POST /admin/servicenow/test-push  { releaseId } ──────────────────
// Manually push a single CR to ServiceNow (for testing)
async function testPush(req, res, next) {
  try {
    const { releaseId } = req.body;
    if (!releaseId) return res.status(422).json({ error: 'releaseId required' });

    const release = await db.queryOne(
      "SELECT r.release_id, r.release_number, r.state, r.title, r.summary, " +
      "r.priority, r.planned_start_date, r.target_end_date, r.snow_sys_id, " +
      "u1.full_name AS requested_by, u2.full_name AS assigned_to, " +
      "ag.group_name AS assignment_group, r.company, r.service " +
      "FROM crms_releases r " +
      "LEFT JOIN crms_users u1 ON u1.user_id = r.requested_by " +
      "LEFT JOIN crms_users u2 ON u2.user_id = r.assigned_to_user_id " +
      "LEFT JOIN crms_assignment_groups ag ON ag.group_id = r.assignment_group_id " +
      "WHERE r.release_id = " + String(parseInt(releaseId,10)) + " AND r.is_deleted = 0", {}
    );
    if (!release) return res.status(404).json({ error: 'Release not found' });

    const result = await snow.pushStateChange({
      releaseId:       release.RELEASE_ID,
      releaseNumber:   release.RELEASE_NUMBER,
      fromState:       null,
      toState:         release.STATE,
      title:           release.TITLE,
      summary:         release.SUMMARY || '',
      priority:        release.PRIORITY,
      requestedBy:     release.REQUESTED_BY,
      assignedTo:      release.ASSIGNED_TO,
      assignmentGroup: release.ASSIGNMENT_GROUP,
      company:         release.COMPANY,
      service:         release.SERVICE,
      startDate:       release.PLANNED_START_DATE,
      endDate:         release.TARGET_END_DATE,
      changedBy:       req.user.fullName || 'Admin Test Push',
      snowSysId:       release.SNOW_SYS_ID || null,
    });
    return res.json({ release: release.RELEASE_NUMBER, result });
  } catch(err) { next(err); }
}

// ── GET /admin/servicenow/state-map ──────────────────────────────────
// Return the CRMS → SNow state mapping for reference
async function getStateMap(req, res, next) {
  try {
    return res.json({
      stateMap:    snow.STATE_MAP,
      snowToCrms:  snow.SNOW_TO_CRMS,
    });
  } catch(err) { next(err); }
}

// ── GET /admin/servicenow/sync-log  (last 50 audit entries for SNow) ─
async function getSyncLog(req, res, next) {
  try {
    const rows = await db.query(
      "SELECT audit_id, action, cr_number, details, created_at " +
      "FROM crms_audit " +
      "WHERE action IN ('ServiceNow Push','ServiceNow Webhook','ServiceNow Error') " +
      "ORDER BY created_at DESC FETCH FIRST 100 ROWS ONLY", {}
    );
    return res.json(rows.map(r => ({
      auditId:   r.AUDIT_ID,
      action:    r.ACTION,
      crNumber:  r.CR_NUMBER,
      details:   r.DETAILS,
      createdAt: r.CREATED_AT,
    })));
  } catch(err) { next(err); }
}

// ── POST /webhooks/servicenow  (PUBLIC — ServiceNow calls this) ───────
// This endpoint is NOT behind verifyToken — ServiceNow uses a shared
// HMAC secret instead (X-ServiceNow-Signature header).
async function inboundWebhook(req, res, next) {
  try {
    // Validate HMAC signature
    const rawBody  = JSON.stringify(req.body);
    const sig      = req.headers['x-servicenow-signature'] || '';
    if (!snow.validateWebhookSignature(rawBody, sig)) {
      logger.warn('[SNow] Webhook rejected — invalid signature', { sig: sig.slice(0,16) });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const result = await snow.handleInboundWebhook(req.body, db);
    logger.info('[SNow] Inbound webhook processed', result);
    return res.json({ received: true, ...result });
  } catch(err) {
    logger.error('[SNow] Webhook handler error', { error: err.message });
    next(err);
  }
}

module.exports = {
  getStatus, getConfig, testPush, getStateMap, getSyncLog, inboundWebhook,
};
