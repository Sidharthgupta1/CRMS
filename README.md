# Motherson CR Management System

> Node.js + Express REST API backed by Oracle Database.  
> Provides persistence, JWT authentication, and full CRUD for all CRMS entities.

---

## Tech Stack

| Layer          | Technology                |
|----------------|---------------------------|
| Runtime        | Node.js ≥ 18              |
| Framework      | Express 4                 |
| Database       | Oracle Database 19c / 21c |
| ORM / Driver   | oracledb v6 (Thin mode)   |
| Auth           | JWT (jsonwebtoken)        |
| Password hash  | bcryptjs                  |
| Logging        | Winston + daily-rotate    |
| Validation     | express-validator         |
| Security       | helmet, cors, rate-limit  |

---

## Project Structure

```
crms-backend/
├── .env.example               ← Environment variable template
├── package.json
├── src/
│   ├── server.js              ← Express app entry point
│   ├── config/
│   │   ├── db.js              ← Oracle connection pool
│   │   └── logger.js          ← Winston logger
│   ├── middleware/
│   │   ├── auth.js            ← JWT verify, requireAdmin
│   │   ├── errorHandler.js    ← Central error + 404 handler
│   │   └── validate.js        ← express-validator helper
│   ├── routes/
│   │   ├── index.js           ← Master router
│   │   ├── auth.js
│   │   ├── releases.js        ← CRs + nested tasks/comments
│   │   ├── tasks.js
│   │   ├── notifications.js
│   │   ├── audit.js
│   │   ├── analytics.js
│   │   └── admin.js
│   ├── controllers/
│   │   ├── authController.js
│   │   ├── releaseController.js
│   │   ├── taskController.js
│   │   ├── commentController.js
│   │   ├── notificationController.js
│   │   ├── auditController.js
│   │   ├── adminController.js
│   │   └── analyticsController.js
│   └── utils/
│       └── pagination.js
├── scripts/
│   ├── migrate.js             ← Creates all Oracle tables, sequences, indexes
│   └── seed.js                ← Seeds demo users, groups, releases, tasks
└── docs/
    └── API_REFERENCE.md       ← Complete REST API documentation
```

---

## Prerequisites

1. **Node.js ≥ 18** — [nodejs.org](https://nodejs.org)
2. **Oracle Database 19c or 21c** — running and accessible
3. **Oracle DB user** with CREATE TABLE, CREATE SEQUENCE, CREATE TRIGGER privileges
4. No Oracle Instant Client needed — oracledb v6 uses Thin mode by default

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/motherson/crms-backend.git
cd crms-backend
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your Oracle connection details:

```env
DB_USER=crms_user
DB_PASSWORD=your_password
DB_CONNECTION_STRING=localhost:1521/ORCL
JWT_SECRET=your_long_random_secret_here
JWT_REFRESH_SECRET=another_long_random_secret_here
```

### 3. Create Oracle database user (run as DBA)

```sql
-- Connect as SYSDBA or DBA
CREATE USER crms_user IDENTIFIED BY your_password
  DEFAULT TABLESPACE USERS
  TEMPORARY TABLESPACE TEMP
  QUOTA UNLIMITED ON USERS;

GRANT CONNECT, RESOURCE TO crms_user;
GRANT CREATE TABLE, CREATE SEQUENCE, CREATE TRIGGER, CREATE VIEW TO crms_user;
```

### 4. Run database migration

```bash
npm run db:migrate
```

Creates all 10 tables, 2 sequences, triggers, views, and indexes.

### 5. Seed demo data

```bash
npm run db:seed
```

Seeds companies, services, 4 users, 3 groups, 3 demo releases, 4 tasks, comments.

### 6. Start the server

```bash
# Development (auto-restart on file changes)
npm run dev

# Production
npm start
```

Server runs on `http://localhost:3000`

---

## Database Schema

### Tables

| Table                    | Description                                    | Rows (demo) |
|--------------------------|------------------------------------------------|-------------|
| `crms_users`             | System users with hashed passwords             | 4           |
| `crms_assignment_groups` | Named teams (e.g. MSSL-Oracle-Functional)      | 3           |
| `crms_group_members`     | User ↔ Group many-to-many                      | 5           |
| `crms_companies`         | Company reference list                         | 4           |
| `crms_services`          | Service/module reference list                  | 5           |
| `crms_releases`          | Main CR table (11-state lifecycle)             | 3           |
| `crms_release_history`   | Per-CR state transition log                    | 7           |
| `crms_tasks`             | Phase tasks (BRD/FSD/Dev/Testing/UAT)          | 4           |
| `crms_comments`          | CR thread comments                             | 2           |
| `crms_notifications`     | User notifications (state changes, tasks)      | 0           |
| `crms_audit`             | System-wide audit trail                        | 10          |

### Views

| View                     | Description                                     |
|--------------------------|-------------------------------------------------|
| `vw_releases_summary`    | Enriched release view with SLA age, task counts |
| `vw_analytics_by_group`  | Group-level CR counts for analytics dashboard   |

### Sequences

| Sequence           | Start  | Format              |
|--------------------|--------|---------------------|
| `crms_release_seq` | 11973  | `RLSE0011973`       |
| `crms_task_seq`    | 15933  | `RTSK0015933`       |

---

## API Endpoints Summary

| Method | Path                                | Auth     | Description                  |
|--------|-------------------------------------|----------|------------------------------|
| POST   | `/api/v1/auth/login`                | Public   | Login → tokens               |
| POST   | `/api/v1/auth/refresh`              | Public   | Refresh access token         |
| POST   | `/api/v1/auth/logout`               | 🔒 User  | Logout                       |
| GET    | `/api/v1/auth/me`                   | 🔒 User  | Current user profile         |
| GET    | `/api/v1/releases`                  | 🔒 User  | List releases (scoped)       |
| POST   | `/api/v1/releases`                  | 🔒 User  | Create release               |
| GET    | `/api/v1/releases/:id`              | 🔒 User  | Get release + history        |
| PATCH  | `/api/v1/releases/:id/advance`      | 🔒 User  | Advance state                |
| DELETE | `/api/v1/releases/:id`              | 🔒 Admin | Soft delete release          |
| GET    | `/api/v1/releases/:id/tasks`        | 🔒 User  | List tasks by phase          |
| POST   | `/api/v1/releases/:id/tasks`        | 🔒 User  | Create task                  |
| GET    | `/api/v1/releases/:id/comments`     | 🔒 User  | List comments                |
| POST   | `/api/v1/releases/:id/comments`     | 🔒 User  | Post comment                 |
| GET    | `/api/v1/tasks/my`                  | 🔒 User  | My assigned tasks            |
| PATCH  | `/api/v1/tasks/:id/close`           | 🔒 User  | Close a task                 |
| GET    | `/api/v1/notifications`             | 🔒 User  | My notifications             |
| PATCH  | `/api/v1/notifications/read-all`    | 🔒 User  | Mark all read                |
| PATCH  | `/api/v1/notifications/:id/read`    | 🔒 User  | Mark one read                |
| GET    | `/api/v1/audit`                     | 🔒 User  | Audit log (scoped by role)   |
| GET    | `/api/v1/analytics/summary`         | 🔒 User  | Analytics with filters       |
| GET    | `/api/v1/admin/users`               | 🔒 Admin | List users                   |
| POST   | `/api/v1/admin/users`               | 🔒 Admin | Create user                  |
| PATCH  | `/api/v1/admin/users/:id/toggle`    | 🔒 Admin | Activate/deactivate user     |
| PATCH  | `/api/v1/admin/users/:id/password`  | 🔒 Admin | Change user password         |
| GET    | `/api/v1/admin/groups`              | 🔒 Admin | List groups + members        |
| POST   | `/api/v1/admin/groups`              | 🔒 Admin | Create group                 |
| PUT    | `/api/v1/admin/groups/:id/members`  | 🔒 Admin | Update group members         |
| GET    | `/api/v1/admin/companies`           | 🔒 Admin | List companies               |
| POST   | `/api/v1/admin/companies`           | 🔒 Admin | Add company                  |
| GET    | `/api/v1/admin/services`            | 🔒 Admin | List services                |
| POST   | `/api/v1/admin/services`            | 🔒 Admin | Add service                  |
| GET    | `/health`                           | Public   | DB health check              |

Full request/response details: **[docs/API_REFERENCE.md](docs/API_REFERENCE.md)**

---

## Connecting the Phase 1 Frontend

To wire the Phase 1 HTML prototype to this Phase 2 backend:

1. Replace the in-memory `DB` object calls with `fetch()` API calls to the endpoints above
2. Store the `accessToken` in `sessionStorage` after login
3. Add `Authorization: Bearer ${token}` to every request header
4. Handle `401 TOKEN_EXPIRED` responses by calling `/auth/refresh` automatically

Example:
```javascript
// Login
const res = await fetch('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ initials: 'SG', password: 'admin123' })
});
const { accessToken, user } = await res.json();
sessionStorage.setItem('token', accessToken);

// Fetch releases
const releases = await fetch('/api/v1/releases', {
  headers: { 'Authorization': `Bearer ${sessionStorage.getItem('token')}` }
}).then(r => r.json());
```

---

## Environment Variables Reference

| Variable                  | Required | Default       | Description                          |
|---------------------------|----------|---------------|--------------------------------------|
| `NODE_ENV`                | No       | `development` | `development` / `production` / `test`|
| `PORT`                    | No       | `3000`        | HTTP port                            |
| `API_PREFIX`              | No       | `/api/v1`     | API route prefix                     |
| `DB_USER`                 | **Yes**  | —             | Oracle username                      |
| `DB_PASSWORD`             | **Yes**  | —             | Oracle password                      |
| `DB_CONNECTION_STRING`    | **Yes**  | —             | `host:port/service` or TNS alias     |
| `DB_POOL_MIN`             | No       | `2`           | Min pool connections                 |
| `DB_POOL_MAX`             | No       | `10`          | Max pool connections                 |
| `JWT_SECRET`              | **Yes**  | —             | Access token signing secret (≥32 chars)|
| `JWT_EXPIRES_IN`          | No       | `8h`          | Access token TTL                     |
| `JWT_REFRESH_SECRET`      | **Yes**  | —             | Refresh token signing secret         |
| `JWT_REFRESH_EXPIRES_IN`  | No       | `7d`          | Refresh token TTL                    |
| `CORS_ORIGIN`             | No       | `localhost:8080` | Comma-separated allowed origins   |
| `LOG_LEVEL`               | No       | `info`        | `debug` `info` `warn` `error`        |
| `LOG_DIR`                 | No       | `./logs`      | Log file directory                   |
| `RATE_LIMIT_MAX`          | No       | `200`         | Max requests per 15-min window       |
| `DEFAULT_PAGE_SIZE`       | No       | `50`          | Default pagination size              |

---

## Demo Credentials

| Name            | Initials | Role  | Password  |
|-----------------|----------|-------|-----------|
| Sandeep Gupta   | SG       | Admin | admin123  |
| Rohit Kumar     | RK       | User  | pass123   |
| Priya Mehta     | PM       | User  | pass123   |
| Amit Verma      | AV       | User  | pass123   |

---

*Motherson Technology Division — CRMS Phase 2 Backend v2.0*
