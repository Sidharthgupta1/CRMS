'use strict';
/**
 * ══════════════════════════════════════════════════════════════════════
 * CRMS ↔ ServiceNow Integration Service
 * ══════════════════════════════════════════════════════════════════════
 *
 * ARCHITECTURE OVERVIEW
 * ─────────────────────
 * CRMS is the master system for Change Request lifecycle.
 * ServiceNow is the enterprise ITSM platform.
 *
 * SYNC DIRECTION:
 *   CRMS → ServiceNow (push)   : Every CRMS state change pushes an
 *                                 update to the linked ServiceNow
 *                                 Change Request (CHG number).
 *   ServiceNow → CRMS (pull)   : CRMS exposes a webhook endpoint that
 *                                 ServiceNow calls when a CHG record
 *                                 is updated (e.g. approval in SNow).
 *
 * SERVICENOW TABLE USED:
 *   change_request              : Standard ITSM Change table
 *                                 (scope: global, table API name:
 *                                  change_request)
 *
 * MAPPING:
 *   CRMS state         → SNow state / phase field
 *   RLSE number        → SNow u_crms_release_number (custom field)
 *   CRMS user name     → SNow assigned_to (by email lookup)
 *
 * REQUIRED ENV VARS:
 *   SNOW_INSTANCE      your-instance.service-now.com (no https://)
 *   SNOW_CLIENT_ID     OAuth 2.0 Client ID from SNow App Registry
 *   SNOW_CLIENT_SECRET OAuth 2.0 Client Secret
 *   SNOW_USERNAME      ServiceNow user with itil + change_manager roles
 *   SNOW_PASSWORD      Password for above user
 *   SNOW_AUTH_TYPE     oauth | basic  (default: basic)
 *   SNOW_WEBHOOK_SECRET Shared secret to validate incoming webhooks
 *
 * OPTIONAL ENV VARS:
 *   SNOW_ENABLED       true | false  (default: true if SNOW_INSTANCE set)
 *   SNOW_SYNC_ON_HOLD  true | false  (sync On Hold / Cancelled, default: true)
 *   SNOW_DRY_RUN       true          (log but don't actually call SNow API)
 * ══════════════════════════════════════════════════════════════════════
 */

const logger = require('../config/logger');
const crypto = require('crypto');

// ── Configuration (read once at startup) ──────────────────────────────
const CFG = {
  instance:      process.env.SNOW_INSTANCE      || '',
  clientId:      process.env.SNOW_CLIENT_ID     || '',
  clientSecret:  process.env.SNOW_CLIENT_SECRET || '',
  username:      process.env.SNOW_USERNAME      || '',
  password:      process.env.SNOW_PASSWORD      || '',
  authType:      (process.env.SNOW_AUTH_TYPE    || 'basic').toLowerCase(),
  webhookSecret: process.env.SNOW_WEBHOOK_SECRET || '',
  dryRun:        process.env.SNOW_DRY_RUN       === 'true',
  syncOnHold:    process.env.SNOW_SYNC_ON_HOLD  !== 'false',
  enabled:       !!(process.env.SNOW_INSTANCE),
};

if (process.env.SNOW_ENABLED === 'false') CFG.enabled = false;
if (process.env.SNOW_ENABLED === 'true')  CFG.enabled = true;

// ── Cached OAuth token ─────────────────────────────────────────────────
let _oauthToken     = null;
let _oauthExpiresAt = 0;

// ── CRMS state → ServiceNow Change Request state + phase mapping ───────
//
// ServiceNow Change Request states (standard values):
//   -5  = New
//   -4  = Assess
//   -3  = Authorize
//   -2  = Scheduled
//   -1  = Implement
//    0  = Review
//    3  = Closed
//    4  = Cancelled
//
// We also map to the SNow "phase" field (used in Release Management):
//   requested, draft, review, authorize, scheduled, implement, review, close
//
const STATE_MAP = {
  // CRMS State                        SNow state_code   SNow phase          SNow risk  SNow type
  'Draft':                           { state: '-5', phase: 'requested',    risk: '2', type: 'comprehensive' },
  'RD Phase':                        { state: '-4', phase: 'assess',       risk: '2', type: 'comprehensive' },
  'RD Awaiting Approval L1':         { state: '-3', phase: 'authorize',    risk: '2', type: 'comprehensive' },
  'RD Awaiting Approval L2':         { state: '-3', phase: 'authorize',    risk: '2', type: 'comprehensive' },
  'RD Awaiting Approval L3':         { state: '-3', phase: 'authorize',    risk: '2', type: 'comprehensive' },
  'RD Awaiting Approval L4':         { state: '-3', phase: 'authorize',    risk: '2', type: 'comprehensive' },
  'RD Awaiting Approval L5':         { state: '-3', phase: 'authorize',    risk: '2', type: 'comprehensive' },
  'FSD Phase':                       { state: '-4', phase: 'assess',       risk: '2', type: 'comprehensive' },
  'FSD Awaiting Approval L1':        { state: '-3', phase: 'authorize',    risk: '2', type: 'comprehensive' },
  'FSD Awaiting Approval L2':        { state: '-3', phase: 'authorize',    risk: '2', type: 'comprehensive' },
  'FSD Awaiting Approval L3':        { state: '-3', phase: 'authorize',    risk: '2', type: 'comprehensive' },
  'FSD Awaiting Approval L4':        { state: '-3', phase: 'authorize',    risk: '2', type: 'comprehensive' },
  'FSD Awaiting Approval L5':        { state: '-3', phase: 'authorize',    risk: '2', type: 'comprehensive' },
  'Development Phase':               { state: '-2', phase: 'scheduled',    risk: '2', type: 'comprehensive' },
  'Testing Phase':                   { state: '-2', phase: 'scheduled',    risk: '2', type: 'comprehensive' },
  'UAT Phase':                       { state: '-1', phase: 'implement',    risk: '2', type: 'comprehensive' },
  'Deployment Awaiting Approval L1': { state: '-3', phase: 'authorize',    risk: '1', type: 'comprehensive' },
  'Deployment Awaiting Approval L2': { state: '-3', phase: 'authorize',    risk: '1', type: 'comprehensive' },
  'Deployment Awaiting Approval L3': { state: '-3', phase: 'authorize',    risk: '1', type: 'comprehensive' },
  'Deployment Awaiting Approval L4': { state: '-3', phase: 'authorize',    risk: '1', type: 'comprehensive' },
  'Deployment Awaiting Approval L5': { state: '-3', phase: 'authorize',    risk: '1', type: 'comprehensive' },
  'Deployment Phase':                { state: '-1', phase: 'implement',    risk: '1', type: 'comprehensive' },
  'Closed':                          { state:  '3', phase: 'close',        risk: '2', type: 'comprehensive' },
  'Cancelled':                       { state:  '4', phase: 'close',        risk: '2', type: 'comprehensive' },
  'On Hold':                         { state: '-3', phase: 'authorize',    risk: '2', type: 'comprehensive' },
};

// ServiceNow → CRMS state mapping (for incoming webhooks)
const SNOW_TO_CRMS = {
  '-5': 'Draft',
  '-4': 'RD Phase',
  '-3': 'RD Awaiting Approval L1',
  '-2': 'Development Phase',
  '-1': 'Deployment Phase',
  '3':  'Closed',
  '4':  'Cancelled',
};

// CRMS priority → ServiceNow risk and priority
const PRIORITY_MAP = {
  '1': { risk: '1', priority: '1' },  // Critical → Critical
  '2': { risk: '2', priority: '2' },  // High → High
  '3': { risk: '3', priority: '3' },  // Moderate → Moderate
  '4': { risk: '4', priority: '4' },  // Low → Low
};

// ═══════════════════════════════════════════════════════════════════════
// HTTP HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get an authorization header value.
 * Supports Basic auth and OAuth 2.0 (Resource Owner Password Credentials).
 */
async function getAuthHeader() {
  if (CFG.authType === 'oauth') {
    // OAuth: cache token, refresh when within 60s of expiry
    const now = Date.now();
    if (_oauthToken && now < _oauthExpiresAt - 60000) {
      return 'Bearer ' + _oauthToken;
    }
    const tokenUrl = 'https://' + CFG.instance + '/oauth_token.do';
    const body = new URLSearchParams({
      grant_type:    'password',
      client_id:     CFG.clientId,
      client_secret: CFG.clientSecret,
      username:      CFG.username,
      password:      CFG.password,
    });
    const resp = await snowFetch(tokenUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
      _skipAuth: true,
    });
    if (!resp.ok) throw new Error('OAuth token fetch failed: ' + resp.status);
    const data = await resp.json();
    _oauthToken     = data.access_token;
    _oauthExpiresAt = now + (data.expires_in || 1800) * 1000;
    return 'Bearer ' + _oauthToken;
  }
  // Basic auth
  const creds = Buffer.from(CFG.username + ':' + CFG.password).toString('base64');
  return 'Basic ' + creds;
}

/**
 * Low-level fetch wrapper for ServiceNow REST API calls.
 * Includes retry (once) on 401 for OAuth token refresh.
 */
async function snowFetch(url, options = {}, retried = false) {
  // Node 18+ has native fetch; for Node 16 fallback to http module
  const fetchFn = typeof fetch !== 'undefined' ? fetch : require('https').request;
  if (typeof fetch === 'undefined') {
    return snowFetchNative(url, options);
  }
  const headers = { ...(options.headers || {}) };
  if (!options._skipAuth) {
    headers['Authorization'] = await getAuthHeader();
  }
  headers['Accept']       = 'application/json';
  headers['Content-Type'] = headers['Content-Type'] || 'application/json';

  const resp = await fetch(url, { ...options, headers });

  if (resp.status === 401 && !retried && CFG.authType === 'oauth') {
    _oauthToken = null; // force token refresh
    return snowFetch(url, options, true);
  }
  return resp;
}

/**
 * Native HTTPS implementation for Node < 18 (no global fetch).
 * Returns a response-like object with { ok, status, json() }.
 */
function snowFetchNative(url, options = {}) {
  return new Promise(async (resolve, reject) => {
    const https   = require('https');
    const urlObj  = new URL(url);
    const auth    = await getAuthHeader();
    const headers = {
      'Authorization': auth,
      'Accept':        'application/json',
      'Content-Type':  'application/json',
      ...(options.headers || {}),
    };
    const body = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined;
    if (body) headers['Content-Length'] = Buffer.byteLength(body);

    const req = https.request({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   options.method || 'GET',
      headers,
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        resolve({
          ok:     res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json:   () => Promise.resolve(raw ? JSON.parse(raw) : {}),
          text:   () => Promise.resolve(raw),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Call the ServiceNow Table API.
 * @param {string} method   GET | POST | PUT | PATCH
 * @param {string} path     e.g. '/change_request' or '/change_request/sys_id'
 * @param {object} body     Request body for POST/PATCH
 * @param {object} params   Query string parameters
 */
async function snowAPI(method, path, body = null, params = {}) {
  const qs = new URLSearchParams({
    sysparm_display_value: 'false',
    ...params
  }).toString();
  const url = 'https://' + CFG.instance + '/api/now/table' + path + '?' + qs;

  if (CFG.dryRun) {
    logger.info('[SNOW DRY-RUN] ' + method + ' ' + url, { body });
    return { result: {} };
  }

  const resp = await snowFetch(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: { message: text } }; }

  if (!resp.ok) {
    const msg = (data.error && data.error.message) || ('ServiceNow API error ' + resp.status);
    throw new Error('[SNow ' + resp.status + '] ' + msg);
  }
  return data;
}

// ═══════════════════════════════════════════════════════════════════════
// OUTBOUND: CRMS → ServiceNow
// ═══════════════════════════════════════════════════════════════════════

/**
 * Push a CRMS state change to ServiceNow.
 * Called from writeStateChange() in releaseController.js after
 * every state transition is committed to Oracle.
 *
 * Flow:
 *   1. Look up an existing CHG by u_crms_release_number (custom field)
 *   2. If found → PATCH the change_request record
 *   3. If not found → POST a new change_request and store sys_id in crms_releases
 *
 * @param {object} payload
 *   - releaseId       CRMS release_id (Oracle PK)
 *   - releaseNumber   e.g. "RLSE0011972"
 *   - fromState       previous CRMS state
 *   - toState         new CRMS state
 *   - title           CR title
 *   - summary         CR summary
 *   - priority        "1"|"2"|"3"|"4"
 *   - requestedBy     full name of requester
 *   - assignedTo      full name of assignee (may be null)
 *   - assignmentGroup group name
 *   - company         company name
 *   - service         service name (Oracle / SAP etc.)
 *   - startDate       planned start (YYYY-MM-DD)
 *   - endDate         target end (YYYY-MM-DD)
 *   - changedBy       full name of user who made the state change
 *   - snowSysId       existing SNow sys_id if known (may be null)
 */
async function pushStateChange(payload) {
  if (!CFG.enabled) return { skipped: true, reason: 'ServiceNow integration disabled' };
  if (!CFG.instance) return { skipped: true, reason: 'SNOW_INSTANCE not configured' };

  const { toState } = payload;
  if (!CFG.syncOnHold && ['On Hold', 'Cancelled'].includes(toState)) {
    return { skipped: true, reason: 'On Hold/Cancelled sync disabled by SNOW_SYNC_ON_HOLD=false' };
  }

  const snowState = STATE_MAP[toState] || STATE_MAP['Draft'];
  const pMap      = PRIORITY_MAP[payload.priority || '3'] || PRIORITY_MAP['3'];

  // Build the ServiceNow record payload
  const snowRecord = {
    short_description:      '[CRMS ' + payload.releaseNumber + '] ' + (payload.title || ''),
    description:            buildDescription(payload),
    state:                  snowState.state,
    phase:                  snowState.phase,
    risk:                   pMap.risk,
    priority:               pMap.priority,
    type:                   snowState.type,
    category:               'software',
    u_crms_release_number:  payload.releaseNumber,
    u_crms_state:           toState,
    u_crms_from_state:      payload.fromState || '',
    u_crms_last_sync:       new Date().toISOString(),
    u_crms_changed_by:      payload.changedBy || '',
    assignment_group:       payload.assignmentGroup || '',
    company:                payload.company || '',
    // Dates: ServiceNow uses format 'YYYY-MM-DD HH:mm:ss'
    ...(payload.startDate ? { start_date: payload.startDate + ' 00:00:00' } : {}),
    ...(payload.endDate   ? { end_date:   payload.endDate   + ' 23:59:59' } : {}),
  };

  try {
    let sysId = payload.snowSysId;
    let action;

    if (sysId) {
      // Known sys_id — PATCH existing record
      await snowAPI('PATCH', '/change_request/' + sysId, snowRecord);
      action = 'updated';
    } else {
      // Search by CRMS release number (custom field u_crms_release_number)
      const search = await snowAPI('GET', '/change_request', null, {
        sysparm_query:  'u_crms_release_number=' + payload.releaseNumber,
        sysparm_limit:  '1',
        sysparm_fields: 'sys_id,number',
      });
      if (search.result && search.result.length > 0) {
        sysId  = search.result[0].sys_id;
        action = 'updated';
        await snowAPI('PATCH', '/change_request/' + sysId, snowRecord);
      } else {
        // Create new change_request
        const created = await snowAPI('POST', '/change_request', snowRecord);
        sysId  = created.result && created.result.sys_id;
        action = 'created';
      }
    }

    logger.info('[SNow] Change request ' + action, {
      releaseNumber: payload.releaseNumber,
      toState,
      sysId,
    });

    return { success: true, action, sysId };

  } catch(err) {
    // Non-blocking — log but don't fail the CRMS state change
    logger.error('[SNow] pushStateChange failed', {
      releaseNumber: payload.releaseNumber,
      error: err.message,
    });
    return { success: false, error: err.message };
  }
}

/**
 * Build a multi-line description for the ServiceNow record.
 */
function buildDescription(payload) {
  return [
    'CRMS Change Request: ' + payload.releaseNumber,
    'State:              ' + payload.toState + (payload.fromState ? ' (from: ' + payload.fromState + ')' : ''),
    'Title:              ' + (payload.title || ''),
    'Requested By:       ' + (payload.requestedBy || ''),
    'Assigned To:        ' + (payload.assignedTo  || 'Unassigned'),
    'Assignment Group:   ' + (payload.assignmentGroup || ''),
    'Company:            ' + (payload.company  || ''),
    'Service:            ' + (payload.service  || ''),
    'Planned Start:      ' + (payload.startDate || 'Not set'),
    'Target End:         ' + (payload.endDate   || 'Not set'),
    '',
    'Summary:',
    payload.summary || '',
    '',
    'Changed by: ' + (payload.changedBy || '') + ' at ' + new Date().toISOString(),
    '─────────────────────────────────────────────',
    'Managed in Motherson CRMS. Do not edit state directly in ServiceNow.',
  ].join('\n');
}

/**
 * Post a comment/work note on the ServiceNow change request.
 * Called when a CRMS comment is posted (optional feature).
 */
async function postWorkNote(sysId, commentText, authorName) {
  if (!CFG.enabled || !sysId) return;
  try {
    await snowAPI('PATCH', '/change_request/' + sysId, {
      work_notes: '[CRMS comment by ' + (authorName || 'Unknown') + ']\n' + commentText,
    });
  } catch(err) {
    logger.warn('[SNow] postWorkNote failed', { sysId, error: err.message });
  }
}

/**
 * Close a ServiceNow change request (move to Review/Closed state).
 */
async function closeChangeRequest(sysId, closeCode, closeNotes) {
  if (!CFG.enabled || !sysId) return;
  try {
    await snowAPI('PATCH', '/change_request/' + sysId, {
      state:       '0',   // Review
      close_code:  closeCode  || 'successful',
      close_notes: closeNotes || 'CR closed in Motherson CRMS. All phases completed.',
    });
    logger.info('[SNow] Change request moved to Review/Close', { sysId });
  } catch(err) {
    logger.warn('[SNow] closeChangeRequest failed', { sysId, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// INBOUND: ServiceNow → CRMS (webhook handler)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Validate the HMAC-SHA256 signature on an incoming ServiceNow webhook.
 * ServiceNow sends the signature in the X-ServiceNow-Signature header.
 *
 * How to configure in ServiceNow:
 *   1. Go to System Web Services → Outbound → REST Messages
 *   2. Create a new REST Message pointing to:
 *      https://your-crms-server.com/api/v1/webhooks/servicenow
 *   3. Add header X-ServiceNow-Signature with value:
 *      ${gs.hmac('SHA-256', SNOW_WEBHOOK_SECRET, current.getDisplayValue())}
 *   4. Set the body to the JSON template shown in docs/servicenow_webhook_template.json
 */
function validateWebhookSignature(rawBody, receivedSig) {
  if (!CFG.webhookSecret) {
    logger.warn('[SNow] SNOW_WEBHOOK_SECRET not set — skipping signature validation');
    return true; // allow in dev, should always be set in production
  }
  const expected = 'sha256=' + crypto
    .createHmac('sha256', CFG.webhookSecret)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(receivedSig || '')
    );
  } catch {
    return false;
  }
}

/**
 * Process an inbound ServiceNow webhook.
 * Expected body (from SNow Business Rule or Flow Designer):
 * {
 *   "sys_id":               "abc123...",
 *   "number":               "CHG0012345",
 *   "u_crms_release_number":"RLSE0011972",
 *   "state":                "-3",
 *   "short_description":    "...",
 *   "close_notes":          "...",
 *   "closed_at":            "2025-04-01 10:00:00",
 *   "assigned_to":          { "value": "user_sys_id", "display_value": "Priya Mehta" },
 *   "approval":             "approved" | "rejected" | "not requested"
 * }
 *
 * @returns { handled, action, message }
 */
async function handleInboundWebhook(body, db) {
  const crmsReleaseNum = body.u_crms_release_number;
  const snowSysId      = body.sys_id;
  const snowNumber     = body.number;
  const snowState      = String(body.state || '');
  const approval       = body.approval || '';

  if (!crmsReleaseNum) {
    return { handled: false, message: 'No u_crms_release_number in payload — not a CRMS-linked record' };
  }

  // Look up the CRMS release
  const release = await db.queryOne(
    "SELECT release_id, state, release_number FROM crms_releases " +
    "WHERE release_number='" + crmsReleaseNum.replace(/'/g,"''") + "' AND is_deleted=0", {}
  );
  if (!release) {
    return { handled: false, message: 'CRMS release not found: ' + crmsReleaseNum };
  }

  const actions = [];

  // Store/update the SNow sys_id on the CRMS release (for future pushes)
  if (snowSysId) {
    await db.executeWithCommit(
      "UPDATE crms_releases SET snow_sys_id='" + snowSysId.replace(/'/g,"''") + "', " +
      "snow_change_number='" + (snowNumber||'').replace(/'/g,"''") + "', " +
      "updated_at=SYSTIMESTAMP " +
      "WHERE release_id=" + release.RELEASE_ID, {}
    );
    actions.push('snow_sys_id stored');
  }

  // Log the webhook to CRMS audit
  await db.executeWithCommit(
    "INSERT INTO crms_audit(action,performed_by,cr_number,details) " +
    "VALUES('ServiceNow Webhook',1,'" + crmsReleaseNum + "'," +
    "'SNow ' + '" + (snowNumber||'') + "' state=" + snowState + " approval=" + approval + "')", {}
  );

  // Handle approval decision from ServiceNow
  if (approval === 'approved') {
    actions.push('approval_received:approved');
    logger.info('[SNow] Approval received for ' + crmsReleaseNum + ' from SNow CHG ' + snowNumber);
    // Note: actual CRMS approval flow is triggered via approvalController
    // This webhook just signals that SNow approved — the approval flow continues in CRMS
  } else if (approval === 'rejected') {
    actions.push('approval_received:rejected');
    logger.info('[SNow] Rejection received for ' + crmsReleaseNum + ' from SNow CHG ' + snowNumber);
  }

  logger.info('[SNow] Webhook processed', { crmsReleaseNum, snowNumber, snowState, actions });
  return { handled: true, actions, crmsReleaseNumber: crmsReleaseNum, snowNumber };
}

// ═══════════════════════════════════════════════════════════════════════
// STATUS / HEALTH
// ═══════════════════════════════════════════════════════════════════════

/**
 * Test the ServiceNow connection by fetching the instance info endpoint.
 * Used by GET /api/v1/admin/servicenow/status
 */
async function testConnection() {
  if (!CFG.enabled) return { connected: false, reason: 'Integration disabled' };
  if (!CFG.instance) return { connected: false, reason: 'SNOW_INSTANCE not set in .env' };
  try {
    const url  = 'https://' + CFG.instance + '/api/now/table/sys_properties?sysparm_query=name=glide.buildname&sysparm_limit=1&sysparm_fields=value';
    const resp = await snowFetch(url, { method: 'GET' });
    if (!resp.ok) return { connected: false, status: resp.status, reason: 'HTTP ' + resp.status };
    const data = await resp.json();
    const ver  = data.result && data.result[0] && data.result[0].value;
    return { connected: true, instance: CFG.instance, version: ver, authType: CFG.authType, dryRun: CFG.dryRun };
  } catch(err) {
    return { connected: false, reason: err.message };
  }
}

/**
 * Get config summary (safe — no secrets).
 */
function getConfig() {
  return {
    enabled:       CFG.enabled,
    instance:      CFG.instance,
    authType:      CFG.authType,
    username:      CFG.username,
    dryRun:        CFG.dryRun,
    syncOnHold:    CFG.syncOnHold,
    webhookSecret: CFG.webhookSecret ? '***configured***' : '(not set)',
  };
}

module.exports = {
  pushStateChange,
  postWorkNote,
  closeChangeRequest,
  validateWebhookSignature,
  handleInboundWebhook,
  testConnection,
  getConfig,
  STATE_MAP,
  SNOW_TO_CRMS,
};
