# CRMS ↔ ServiceNow Integration Setup Guide

## Overview

CRMS integrates with ServiceNow Release Management in both directions:

| Direction | Trigger | What Happens |
|---|---|---|
| **CRMS → ServiceNow** | Every CRMS state change | CRMS pushes an update to the linked CHG record in ServiceNow |
| **ServiceNow → CRMS** | Approval / state change in SNow | ServiceNow calls the CRMS webhook endpoint |

---

## Step 1 — Run the DDL

In SQL Developer as APPS user on ebs_MSWILDEV:

```sql
@crms_servicenow_ddl.sql
```

This adds `snow_sys_id`, `snow_change_number`, `snow_last_sync` columns to `crms_releases`.

---

## Step 2 — Configure .env

Add these variables to your `crms-backend/.env` file:

```env
# Required
SNOW_INSTANCE=your-instance.service-now.com
SNOW_USERNAME=crms_integration
SNOW_PASSWORD=your_snow_password

# Auth type (basic is simpler; oauth is recommended for production)
SNOW_AUTH_TYPE=basic

# Webhook security
SNOW_WEBHOOK_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">

# Optional
SNOW_SYNC_ON_HOLD=true
SNOW_DRY_RUN=false
```

---

## Step 3 — ServiceNow: Create Custom Field

In ServiceNow, add a custom field to the `change_request` table:

1. Go to **System Definition → Tables** → find `change_request`
2. Click **Columns** tab → **New**
3. Set:
   - Column label: `CRMS Release Number`
   - Column name: `u_crms_release_number`
   - Type: `String`
   - Max length: `20`
4. Save and publish

---

## Step 4 — ServiceNow: Create Integration User

1. Go to **User Administration → Users** → New
2. Set username: `crms_integration` (or your chosen SNOW_USERNAME)
3. Roles required: `itil`, `change_manager`
4. Set password to match SNOW_PASSWORD in .env

---

## Step 5 — ServiceNow: Create Outbound Webhook (Business Rule)

1. Go to **System Definition → Business Rules** → New
2. Configure:
   - **Name**: CRMS State Change Webhook
   - **Table**: Change Request [change_request]
   - **When**: After → Insert and Update
   - **Filter**: `u_crms_release_number` is not empty
3. In the **Script** tab, paste:

```javascript
(function executeRule(current, previous) {
  var secret = 'YOUR_SNOW_WEBHOOK_SECRET'; // match SNOW_WEBHOOK_SECRET in .env
  var url    = 'https://your-crms-server:3000/api/v1/webhooks/servicenow';

  var body = JSON.stringify({
    sys_id:                current.sys_id.toString(),
    number:                current.number.toString(),
    u_crms_release_number: current.u_crms_release_number.toString(),
    state:                 current.state.toString(),
    approval:              current.approval.toString(),
    short_description:     current.short_description.toString(),
    close_notes:           current.close_notes.toString(),
    closed_at:             current.closed_at.toString()
  });

  // HMAC-SHA256 signature
  var sig = 'sha256=' + GlideDigest.getSHA256Hex(secret + body);

  var request = new sn_ws.RESTMessageV2();
  request.setEndpoint(url);
  request.setHttpMethod('POST');
  request.setRequestHeader('Content-Type', 'application/json');
  request.setRequestHeader('X-ServiceNow-Signature', sig);
  request.setRequestBody(body);
  request.execute();

})(current, previous);
```

---

## Step 6 — Restart CRMS Backend

```bash
npm run dev
# or
pm2 restart crms-backend
```

---

## Step 7 — Test the Integration

1. Log into CRMS as Admin
2. Go to **Admin → ServiceNow** in the sidebar
3. Click **Refresh Status** — should show ✅ Connected
4. Enter a CR number in the Test Push field and click **Push to ServiceNow**
5. Check ServiceNow — a CHG record should appear with `u_crms_release_number` matching your CR

---

## How Syncing Works

### CRMS → ServiceNow (every state change)

1. User advances a CR in CRMS → `advanceState()` runs
2. `writeStateChange()` commits the new state to Oracle
3. `setImmediate()` fires `snow.pushStateChange()` asynchronously
4. CRMS looks up the CHG record by `u_crms_release_number`
5. If found: PATCH the existing CHG. If not: POST a new CHG.
6. The SNow `sys_id` is stored in `crms_releases.snow_sys_id` for future updates
7. The push is logged in `crms_audit` (action: `ServiceNow Push`)

### ServiceNow → CRMS (webhook)

1. SNow Business Rule fires on CHG update
2. POST to `/api/v1/webhooks/servicenow` with HMAC signature
3. CRMS validates the signature using `SNOW_WEBHOOK_SECRET`
4. Looks up the CRMS release by `u_crms_release_number`
5. Stores the `snow_sys_id` on the release
6. Logs the event in `crms_audit` (action: `ServiceNow Webhook`)
7. If `approval=approved` or `approval=rejected`, logs accordingly

---

## Troubleshooting

| Problem | Check |
|---|---|
| Status shows "Not Connected" | Verify SNOW_INSTANCE, SNOW_USERNAME, SNOW_PASSWORD in .env |
| 401 on test push | SNOW_AUTH_TYPE=basic credentials wrong, or user lacks itil role |
| Webhook rejected (401) | SNOW_WEBHOOK_SECRET doesn't match what's in the Business Rule script |
| CHG not created in SNow | Check crms_audit for `ServiceNow Error` action — shows the exact error |
| state not updating | Verify u_crms_release_number field exists on change_request table |
