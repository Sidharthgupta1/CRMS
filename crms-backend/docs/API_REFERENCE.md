# Motherson CR Management System — API Reference
**Version:** 2.0 | **Base URL:** `http://localhost:3000/api/v1`

---

## Authentication

All endpoints (except `/auth/login`) require a **Bearer token** in the `Authorization` header:
```
Authorization: Bearer <accessToken>
```

Tokens expire in **8 hours**. Use `/auth/refresh` to obtain a new one.

---

## 1. Auth Endpoints

### POST `/auth/login`
Authenticate a user and receive access + refresh tokens.

**Request Body:**
```json
{ "initials": "SG", "password": "admin123" }
```
**Response `200`:**
```json
{
  "accessToken":  "eyJ...",
  "refreshToken": "eyJ...",
  "user": {
    "userId": 1, "initials": "SG",
    "fullName": "Sandeep Gupta", "role": "admin"
  }
}
```
**Errors:** `401 Invalid credentials`

---

### POST `/auth/refresh`
Exchange a refresh token for a new access token.

**Request Body:** `{ "refreshToken": "eyJ..." }`
**Response `200`:** `{ "accessToken": "eyJ...", "refreshToken": "eyJ..." }`

---

### POST `/auth/logout`  🔒
Invalidate the current session.

**Response `200`:** `{ "message": "Logged out successfully" }`

---

### GET `/auth/me`  🔒
Get the currently authenticated user's profile and group memberships.

**Response `200`:**
```json
{
  "userId": 1, "initials": "SG", "fullName": "Sandeep Gupta",
  "role": "admin", "lastLogin": "2025-04-01T09:00:00Z",
  "groups": ["MSSL-Oracle-Functional"]
}
```

---

## 2. Releases (Change Requests)

### GET `/releases`  🔒
Fetch releases. Admins see all; regular users see their own + their group's.

**Query Parameters:**

| Parameter         | Type   | Description                              |
|-------------------|--------|------------------------------------------|
| `state`           | string | Filter by lifecycle state                |
| `priority`        | string | `1` `2` `3` `4`                          |
| `assignmentGroup` | string | Filter by group name                     |
| `requestedBy`     | string | Filter by full name of creator           |
| `fromDate`        | date   | Planned start date ≥ (YYYY-MM-DD)        |
| `toDate`          | date   | Planned start date ≤ (YYYY-MM-DD)        |
| `search`          | string | Full-text search on title / number       |
| `page`            | int    | Page number (default: 1)                 |
| `pageSize`        | int    | Records per page (default: 50, max: 200) |

**Response `200`:**
```json
{
  "data": [
    {
      "releaseId": 1, "releaseNumber": "RLSE0011972",
      "state": "BRD Phase", "priority": "3",
      "title": "IDACS Phase 2 Pick Release Integration",
      "requestedBy": "Sandeep Gupta",
      "assignmentGroup": "MSSL-Oracle-Functional",
      "plannedStartDate": "2025-04-01T00:00:00Z",
      "targetEndDate": "2025-06-30T00:00:00Z",
      "createdAt": "2025-04-01T09:12:00Z"
    }
  ],
  "pagination": { "page": 1, "pageSize": 50, "total": 3, "totalPages": 1 }
}
```

---

### POST `/releases`  🔒
Create a new Change Request.

**Request Body:**
```json
{
  "priority":          "3",
  "title":             "Oracle Payroll Module Upgrade",
  "summary":           "Upgrade Oracle Payroll from R12 to Cloud.",
  "company":           "MSSL",
  "service":           "Oracle",
  "plannedStartDate":  "2025-05-01",
  "targetEndDate":     "2025-08-31",
  "assignmentGroupId": 1,
  "assignedToUserId":  2
}
```

**Validation Rules:**
- `priority` — required, one of `1` `2` `3` `4`
- `title` — required, max 200 chars
- `summary` — required
- `company` — required
- `service` — required
- `plannedStartDate` — required, ISO date
- `targetEndDate` — optional, must be ≥ `plannedStartDate`

**Response `201`:**
```json
{
  "releaseId": 4, "releaseNumber": "RLSE0011975",
  "state": "Draft", "message": "Release created"
}
```

---

### GET `/releases/:releaseId`  🔒
Get a single release with full detail including history.

**Response `200`:**
```json
{
  "releaseId": 1, "releaseNumber": "RLSE0011972",
  "state": "BRD Phase", "priority": "3",
  "title": "IDACS Phase 2 Pick Release Integration",
  "summary": "Review and integrate...",
  "company": "MSSL", "service": "Oracle",
  "requestedBy": "Sandeep Gupta",
  "assignedTo": "Priya Mehta",
  "assignmentGroup": "MSSL-Oracle-Functional",
  "plannedStartDate": "2025-04-01T00:00:00Z",
  "targetEndDate": "2025-06-30T00:00:00Z",
  "createdAt": "2025-04-01T09:12:00Z",
  "history": [
    { "action": "Created",      "fromState": null,    "toState": "Draft",     "changedBy": "Sandeep Gupta", "changedAt": "..." },
    { "action": "State Change", "fromState": "Draft", "toState": "BRD Phase", "changedBy": "Sandeep Gupta", "changedAt": "..." }
  ]
}
```

---

### PATCH `/releases/:releaseId/advance`  🔒
Advance a release to the next state, or force it to `On Hold` / `Cancelled`.

**Request Body (normal advance):** `{}` *(empty)*

**Request Body (force to On Hold or Cancelled):**
```json
{ "force": "On Hold" }
```
or
```json
{ "force": "Cancelled" }
```

**State Transition Map:**
```
Draft → BRD Phase → FSD Phase → Awaiting approval
  → Development Phase → Testing/QA → UAT → Deployment → Closed
On Hold (from any active) → Development Phase
Cancelled (from any active) → terminal
```

**Response `200`:**
```json
{ "releaseId": 1, "fromState": "Draft", "toState": "BRD Phase" }
```
**Errors:** `400 Cannot advance from terminal state` | `404 Release not found`

---

### DELETE `/releases/:releaseId`  🔒 Admin only
Soft-delete a release (`is_deleted = 1`).

**Response `200`:** `{ "message": "Release deleted" }`

---

## 3. Tasks

### GET `/releases/:releaseId/tasks`  🔒
List all tasks for a release. Filter by phase with `?phase=BRD`.

**Query Parameters:** `phase` — `BRD` `FSD` `Dev` `Testing` `UAT`

**Response `200`:**
```json
[
  {
    "taskId": 1, "taskNumber": "RTSK0015933",
    "phase": "BRD", "taskType": "BRD Task",
    "state": "Open",
    "shortDescription": "Review BRD document",
    "assignmentGroup": "MSSL-Oracle-Functional",
    "assignedTo": "Priya Mehta",
    "releaseNumber": "RLSE0011972",
    "createdAt": "2025-04-01T10:00:00Z"
  }
]
```

---

### POST `/releases/:releaseId/tasks`  🔒
Create a new phase task.

**Request Body:**
```json
{
  "phase":             "BRD",
  "shortDescription":  "Prepare BRD sign-off document",
  "assignmentGroupId": 1,
  "assignedToUserId":  3
}
```

**Response `201`:**
```json
{
  "taskId": 5, "taskNumber": "RTSK0015937",
  "phase": "BRD", "taskType": "BRD Task",
  "state": "Open", "message": "Task created"
}
```

---

### GET `/tasks/my`  🔒
Get all open tasks assigned to the currently logged-in user.

---

### PATCH `/tasks/:taskId/close`  🔒
Close an open task.

**Response `200`:** `{ "message": "Task closed" }`

---

## 4. Comments

### GET `/releases/:releaseId/comments`  🔒

**Response `200`:**
```json
[
  {
    "commentId": 1,
    "text": "BRD review meeting scheduled for next week.",
    "author": "Sandeep Gupta",
    "createdAt": "2025-04-02T11:00:00Z"
  }
]
```

---

### POST `/releases/:releaseId/comments`  🔒

**Request Body:** `{ "text": "Please update the gap analysis section." }`
**Response `201`:** `{ "message": "Comment posted" }`

---

## 5. Notifications

### GET `/notifications`  🔒
Get the current user's notifications (latest 50).

**Response `200`:**
```json
{
  "notifications": [
    {
      "id": 1, "title": "State Updated",
      "message": "RLSE0011972 moved from Draft to BRD Phase",
      "isRead": false, "releaseId": 1,
      "releaseNumber": "RLSE0011972",
      "createdAt": "2025-04-01T09:30:00Z"
    }
  ],
  "unreadCount": 1
}
```

---

### PATCH `/notifications/:id/read`  🔒
Mark a single notification as read.

### PATCH `/notifications/read-all`  🔒
Mark all notifications as read.

---

## 6. Audit Log

### GET `/audit`  🔒
Retrieve audit log entries. **Admins** see all entries; **regular users** see only their own.

**Query Parameters (Admin only):**

| Parameter  | Description                    |
|------------|--------------------------------|
| `userId`   | Filter by specific user ID     |
| `action`   | Filter by action label         |
| `crNumber` | Filter by CR number            |
| `fromDate` | From date (YYYY-MM-DD)         |
| `toDate`   | To date (YYYY-MM-DD)           |
| `search`   | Full-text search on details    |
| `page`     | Page number                    |
| `pageSize` | Records per page               |

**Response `200`:**
```json
{
  "data": [
    {
      "auditId": 1, "action": "Login",
      "performedBy": "Sandeep Gupta",
      "crNumber": "--",
      "details": "Sandeep Gupta logged in",
      "createdAt": "2025-04-01T09:00:00Z"
    }
  ],
  "pagination": { "page": 1, "pageSize": 50, "total": 12, "totalPages": 1 }
}
```

---

## 7. Analytics

### GET `/analytics/summary`  🔒
Get aggregated analytics. Apply filters to drill down.

**Query Parameters:**

| Parameter          | Description                     |
|--------------------|---------------------------------|
| `assignmentGroupId`| Filter by group ID              |
| `userId`           | Filter by user ID               |
| `priority`         | Filter by priority (`1`-`4`)    |

**Response `200`:**
```json
{
  "summary": {
    "total": 3, "open": 2, "closed": 0,
    "cancelled": 0, "critical": 1, "tasks": 4
  },
  "byState": [
    { "state": "BRD Phase",         "count": 1 },
    { "state": "Development Phase", "count": 1 },
    { "state": "Testing/QA",        "count": 1 }
  ],
  "byPriority": [
    { "priority": "1", "label": "1 – Critical", "count": 1 },
    { "priority": "2", "label": "2 – High",     "count": 1 },
    { "priority": "3", "label": "3 – Moderate", "count": 1 }
  ],
  "byGroup": [
    { "group": "MSSL-Oracle-Functional", "count": 2 },
    { "group": "MSSL-Oracle-Technical",  "count": 1 }
  ],
  "byUser": [
    { "user": "Sandeep Gupta", "count": 1 },
    { "user": "Rohit Kumar",   "count": 1 },
    { "user": "Priya Mehta",   "count": 1 }
  ]
}
```

---

## 8. Admin Endpoints  🔒 Admin only

All `/admin/*` endpoints require Admin role.

### Users

| Method | Path                              | Description              |
|--------|-----------------------------------|--------------------------|
| GET    | `/admin/users`                    | List all users           |
| POST   | `/admin/users`                    | Create new user          |
| PATCH  | `/admin/users/:userId/toggle`     | Activate / deactivate    |
| PATCH  | `/admin/users/:userId/password`   | Change password          |

**POST `/admin/users` body:**
```json
{
  "fullName": "Vijay Sharma", "initials": "VS",
  "role": "user", "password": "secure123"
}
```

---

### Assignment Groups

| Method | Path                              | Description                   |
|--------|-----------------------------------|-------------------------------|
| GET    | `/admin/groups`                   | List all groups with members  |
| POST   | `/admin/groups`                   | Create new group              |
| PUT    | `/admin/groups/:groupId/members`  | Replace group members         |

**PUT `/admin/groups/:groupId/members` body:**
```json
{ "memberUserIds": [1, 3] }
```

---

### Companies & Services

| Method | Path               | Description       |
|--------|--------------------|-------------------|
| GET    | `/admin/companies` | List companies    |
| POST   | `/admin/companies` | Add company       |
| GET    | `/admin/services`  | List services     |
| POST   | `/admin/services`  | Add service       |

---

## Error Response Format

All errors follow this structure:

```json
{
  "error": "Human-readable error message",
  "details": [
    { "field": "priority", "message": "Priority must be 1-4" }
  ]
}
```

| HTTP Code | Meaning                            |
|-----------|------------------------------------|
| `400`     | Bad request / business rule error  |
| `401`     | Unauthenticated / token expired    |
| `403`     | Forbidden (insufficient role)      |
| `404`     | Resource not found                 |
| `409`     | Conflict (duplicate record)        |
| `422`     | Validation failed                  |
| `429`     | Rate limit exceeded                |
| `500`     | Internal server error              |
| `503`     | Database unavailable               |

---

## Health Check

### GET `/health`  *(no auth required)*
```json
{ "status": "ok", "db": "connected", "ts": "2025-04-01T09:00:00.000Z" }
```
