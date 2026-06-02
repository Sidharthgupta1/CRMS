'use strict';

/**
 * Motherson CRMS — Oracle Database Migration Script
 * Run: node scripts/migrate.js
 *
 * Creates all tables, sequences, indexes, and constraints from scratch.
 * Safe to re-run — uses CREATE OR REPLACE / IF NOT EXISTS patterns.
 */

require('dotenv').config();
const oracledb = require('oracledb');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

// ── All DDL statements in execution order ─────────────────────────────
const DDL = [

  // ════════════════════════════════════════════════════════════════════
  // SEQUENCES
  // ════════════════════════════════════════════════════════════════════

  {
    name: 'SEQ: crms_release_seq',
    sql: `CREATE SEQUENCE crms_release_seq
            START WITH     11973
            INCREMENT BY   1
            NOCACHE
            NOCYCLE`,
  },
  {
    name: 'SEQ: crms_task_seq',
    sql: `CREATE SEQUENCE crms_task_seq
            START WITH     15933
            INCREMENT BY   1
            NOCACHE
            NOCYCLE`,
  },

  // ════════════════════════════════════════════════════════════════════
  // TABLE: crms_users
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'TABLE: crms_users',
    sql: `CREATE TABLE crms_users (
            user_id             NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            initials            VARCHAR2(3)    NOT NULL,
            full_name           VARCHAR2(200)  NOT NULL,
            role                VARCHAR2(10)   DEFAULT 'user' NOT NULL
                                    CONSTRAINT chk_user_role CHECK (role IN ('admin','user')),
            password_hash       VARCHAR2(255)  NOT NULL,
            refresh_token_hash  VARCHAR2(255),
            is_active           NUMBER(1)      DEFAULT 1 NOT NULL
                                    CONSTRAINT chk_user_active CHECK (is_active IN (0,1)),
            last_login          TIMESTAMP,
            created_at          TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
            CONSTRAINT uq_user_initials UNIQUE (initials)
          )`,
  },

  // ════════════════════════════════════════════════════════════════════
  // TABLE: crms_assignment_groups
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'TABLE: crms_assignment_groups',
    sql: `CREATE TABLE crms_assignment_groups (
            group_id    NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            group_name  VARCHAR2(200)  NOT NULL,
            description VARCHAR2(500),
            created_at  TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
            CONSTRAINT uq_group_name UNIQUE (group_name)
          )`,
  },

  // ════════════════════════════════════════════════════════════════════
  // TABLE: crms_group_members  (many-to-many: users ↔ groups)
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'TABLE: crms_group_members',
    sql: `CREATE TABLE crms_group_members (
            group_id   NUMBER NOT NULL
                CONSTRAINT fk_gm_group REFERENCES crms_assignment_groups(group_id) ON DELETE CASCADE,
            user_id    NUMBER NOT NULL
                CONSTRAINT fk_gm_user  REFERENCES crms_users(user_id)             ON DELETE CASCADE,
            joined_at  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            CONSTRAINT pk_group_members PRIMARY KEY (group_id, user_id)
          )`,
  },

  // ════════════════════════════════════════════════════════════════════
  // TABLE: crms_companies
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'TABLE: crms_companies',
    sql: `CREATE TABLE crms_companies (
            company_id   NUMBER        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            company_name VARCHAR2(200) NOT NULL,
            created_at   TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
            CONSTRAINT uq_company_name UNIQUE (company_name)
          )`,
  },

  // ════════════════════════════════════════════════════════════════════
  // TABLE: crms_services
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'TABLE: crms_services',
    sql: `CREATE TABLE crms_services (
            service_id   NUMBER        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            service_name VARCHAR2(200) NOT NULL,
            created_at   TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
            CONSTRAINT uq_service_name UNIQUE (service_name)
          )`,
  },

  // ════════════════════════════════════════════════════════════════════
  // TABLE: crms_releases  (main CR table)
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'TABLE: crms_releases',
    sql: `CREATE TABLE crms_releases (
            release_id          NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            release_number      VARCHAR2(20)   NOT NULL,
            state               VARCHAR2(30)   DEFAULT 'Draft' NOT NULL
                CONSTRAINT chk_release_state CHECK (state IN (
                  'Draft','BRD Phase','FSD Phase','Awaiting approval','On Hold',
                  'Development Phase','Testing/QA','UAT','Deployment','Closed','Cancelled'
                )),
            priority            VARCHAR2(1)    NOT NULL
                CONSTRAINT chk_release_priority CHECK (priority IN ('1','2','3','4')),
            title               VARCHAR2(200)  NOT NULL,
            summary             CLOB,
            company             VARCHAR2(200),
            service             VARCHAR2(200),
            planned_start_date  DATE,
            target_end_date     DATE,
            requested_by        NUMBER         NOT NULL
                CONSTRAINT fk_rel_requested_by REFERENCES crms_users(user_id),
            assignment_group_id NUMBER
                CONSTRAINT fk_rel_ag REFERENCES crms_assignment_groups(group_id),
            assigned_to_user_id NUMBER
                CONSTRAINT fk_rel_assigned_to REFERENCES crms_users(user_id),
            is_deleted          NUMBER(1)      DEFAULT 0 NOT NULL
                CONSTRAINT chk_release_deleted CHECK (is_deleted IN (0,1)),
            created_at          TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
            updated_at          TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
            CONSTRAINT uq_release_number UNIQUE (release_number),
            CONSTRAINT chk_release_dates CHECK (
              target_end_date IS NULL OR target_end_date >= planned_start_date
            )
          )`,
  },

  // ── Indexes on crms_releases ──────────────────────────────────────
  { name: 'IDX: crms_releases_state',    sql: `CREATE INDEX idx_rel_state   ON crms_releases(state)`           },
  { name: 'IDX: crms_releases_reqby',    sql: `CREATE INDEX idx_rel_reqby   ON crms_releases(requested_by)`    },
  { name: 'IDX: crms_releases_ag',       sql: `CREATE INDEX idx_rel_ag      ON crms_releases(assignment_group_id)` },
  { name: 'IDX: crms_releases_priority', sql: `CREATE INDEX idx_rel_priority ON crms_releases(priority)`       },
  { name: 'IDX: crms_releases_startdt',  sql: `CREATE INDEX idx_rel_startdt  ON crms_releases(planned_start_date)` },
  { name: 'IDX: crms_releases_deleted',  sql: `CREATE INDEX idx_rel_deleted  ON crms_releases(is_deleted)`     },

  // ════════════════════════════════════════════════════════════════════
  // TABLE: crms_release_history  (per-CR state change log)
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'TABLE: crms_release_history',
    sql: `CREATE TABLE crms_release_history (
            history_id   NUMBER        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            release_id   NUMBER        NOT NULL
                CONSTRAINT fk_hist_release REFERENCES crms_releases(release_id) ON DELETE CASCADE,
            action       VARCHAR2(50)  NOT NULL,
            from_state   VARCHAR2(30),
            to_state     VARCHAR2(30)  NOT NULL,
            changed_by   NUMBER        NOT NULL
                CONSTRAINT fk_hist_user REFERENCES crms_users(user_id),
            changed_at   TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL
          )`,
  },
  { name: 'IDX: crms_release_history_rel', sql: `CREATE INDEX idx_hist_release ON crms_release_history(release_id)` },

  // ════════════════════════════════════════════════════════════════════
  // TABLE: crms_tasks  (phase tasks)
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'TABLE: crms_tasks',
    sql: `CREATE TABLE crms_tasks (
            task_id             NUMBER        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            task_number         VARCHAR2(20)  NOT NULL,
            release_id          NUMBER        NOT NULL
                CONSTRAINT fk_task_release REFERENCES crms_releases(release_id) ON DELETE CASCADE,
            phase               VARCHAR2(10)  NOT NULL
                CONSTRAINT chk_task_phase CHECK (phase IN ('BRD','FSD','Dev','Testing','UAT')),
            task_type           VARCHAR2(30)  NOT NULL,
            state               VARCHAR2(10)  DEFAULT 'Open' NOT NULL
                CONSTRAINT chk_task_state CHECK (state IN ('Open','Closed')),
            short_description   VARCHAR2(500) NOT NULL,
            assignment_group_id NUMBER
                CONSTRAINT fk_task_ag REFERENCES crms_assignment_groups(group_id),
            assigned_to_user_id NUMBER
                CONSTRAINT fk_task_assigned REFERENCES crms_users(user_id),
            created_by          NUMBER        NOT NULL
                CONSTRAINT fk_task_createdby REFERENCES crms_users(user_id),
            created_at          TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
            updated_at          TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
            CONSTRAINT uq_task_number UNIQUE (task_number)
          )`,
  },
  { name: 'IDX: crms_tasks_release',  sql: `CREATE INDEX idx_task_release  ON crms_tasks(release_id)`          },
  { name: 'IDX: crms_tasks_assigned', sql: `CREATE INDEX idx_task_assigned  ON crms_tasks(assigned_to_user_id)` },
  { name: 'IDX: crms_tasks_state',    sql: `CREATE INDEX idx_task_state     ON crms_tasks(state)`               },

  // ════════════════════════════════════════════════════════════════════
  // TABLE: crms_comments
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'TABLE: crms_comments',
    sql: `CREATE TABLE crms_comments (
            comment_id    NUMBER   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            release_id    NUMBER   NOT NULL
                CONSTRAINT fk_comment_release REFERENCES crms_releases(release_id) ON DELETE CASCADE,
            comment_text  CLOB     NOT NULL,
            created_by    NUMBER   NOT NULL
                CONSTRAINT fk_comment_user REFERENCES crms_users(user_id),
            created_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
          )`,
  },
  { name: 'IDX: crms_comments_release', sql: `CREATE INDEX idx_comment_release ON crms_comments(release_id)` },

  // ════════════════════════════════════════════════════════════════════
  // TABLE: crms_notifications
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'TABLE: crms_notifications',
    sql: `CREATE TABLE crms_notifications (
            notification_id  NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id          NUMBER         NOT NULL
                CONSTRAINT fk_notif_user REFERENCES crms_users(user_id) ON DELETE CASCADE,
            title            VARCHAR2(100)  NOT NULL,
            message          VARCHAR2(500)  NOT NULL,
            is_read          NUMBER(1)      DEFAULT 0 NOT NULL
                CONSTRAINT chk_notif_read CHECK (is_read IN (0,1)),
            release_id       NUMBER
                CONSTRAINT fk_notif_release REFERENCES crms_releases(release_id) ON DELETE SET NULL,
            created_at       TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL
          )`,
  },
  { name: 'IDX: crms_notifications_user',   sql: `CREATE INDEX idx_notif_user   ON crms_notifications(user_id)`            },
  { name: 'IDX: crms_notifications_unread', sql: `CREATE INDEX idx_notif_unread  ON crms_notifications(user_id, is_read)`   },

  // ════════════════════════════════════════════════════════════════════
  // TABLE: crms_audit  (system-wide audit log)
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'TABLE: crms_audit',
    sql: `CREATE TABLE crms_audit (
            audit_id      NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            action        VARCHAR2(50)   NOT NULL,
            performed_by  NUMBER         NOT NULL
                CONSTRAINT fk_audit_user REFERENCES crms_users(user_id),
            cr_number     VARCHAR2(20)   DEFAULT '--' NOT NULL,
            details       VARCHAR2(1000),
            created_at    TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL
          )`,
  },
  { name: 'IDX: crms_audit_user',      sql: `CREATE INDEX idx_audit_user    ON crms_audit(performed_by)`             },
  { name: 'IDX: crms_audit_action',    sql: `CREATE INDEX idx_audit_action   ON crms_audit(action)`                  },
  { name: 'IDX: crms_audit_crnum',     sql: `CREATE INDEX idx_audit_crnum    ON crms_audit(cr_number)`               },
  { name: 'IDX: crms_audit_createdat', sql: `CREATE INDEX idx_audit_createdat ON crms_audit(created_at DESC)`         },

  // ════════════════════════════════════════════════════════════════════
  // TRIGGER: auto-update updated_at on crms_releases
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'TRIGGER: trg_releases_updated_at',
    sql: `CREATE OR REPLACE TRIGGER trg_releases_updated_at
            BEFORE UPDATE ON crms_releases
            FOR EACH ROW
          BEGIN
            :NEW.updated_at := SYSTIMESTAMP;
          END;`,
  },

  // ════════════════════════════════════════════════════════════════════
  // TRIGGER: auto-update updated_at on crms_tasks
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'TRIGGER: trg_tasks_updated_at',
    sql: `CREATE OR REPLACE TRIGGER trg_tasks_updated_at
            BEFORE UPDATE ON crms_tasks
            FOR EACH ROW
          BEGIN
            :NEW.updated_at := SYSTIMESTAMP;
          END;`,
  },

  // ════════════════════════════════════════════════════════════════════
  // VIEW: vw_releases_summary  (convenience view for reporting)
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'VIEW: vw_releases_summary',
    sql: `CREATE OR REPLACE VIEW vw_releases_summary AS
          SELECT
            r.release_id,
            r.release_number,
            r.state,
            r.priority,
            CASE r.priority
              WHEN '1' THEN '1 – Critical' WHEN '2' THEN '2 – High'
              WHEN '3' THEN '3 – Moderate' WHEN '4' THEN '4 – Low'
              ELSE r.priority
            END AS priority_label,
            r.title,
            r.company,
            r.service,
            r.planned_start_date,
            r.target_end_date,
            TRUNC(SYSDATE - r.planned_start_date)          AS sla_age_days,
            u_req.full_name                                 AS requested_by,
            u_ass.full_name                                 AS assigned_to,
            ag.group_name                                   AS assignment_group,
            r.created_at,
            r.updated_at,
            (SELECT COUNT(*) FROM crms_tasks t WHERE t.release_id = r.release_id)       AS task_count,
            (SELECT COUNT(*) FROM crms_tasks t WHERE t.release_id = r.release_id
               AND t.state = 'Open')                                                     AS open_task_count,
            (SELECT COUNT(*) FROM crms_comments c WHERE c.release_id = r.release_id)    AS comment_count
          FROM  crms_releases r
          JOIN  crms_users u_req ON u_req.user_id = r.requested_by
          LEFT  JOIN crms_users u_ass ON u_ass.user_id = r.assigned_to_user_id
          LEFT  JOIN crms_assignment_groups ag ON ag.group_id = r.assignment_group_id
          WHERE r.is_deleted = 0`,
  },

  // ════════════════════════════════════════════════════════════════════
  // VIEW: vw_analytics_by_group  (group-level dashboard data)
  // ════════════════════════════════════════════════════════════════════
  {
    name: 'VIEW: vw_analytics_by_group',
    sql: `CREATE OR REPLACE VIEW vw_analytics_by_group AS
          SELECT
            ag.group_id,
            ag.group_name,
            COUNT(r.release_id)                                           AS total_releases,
            COUNT(CASE WHEN r.state NOT IN ('Closed','Cancelled') THEN 1 END) AS open_releases,
            COUNT(CASE WHEN r.state = 'Closed'    THEN 1 END)            AS closed_releases,
            COUNT(CASE WHEN r.state = 'Cancelled' THEN 1 END)            AS cancelled_releases,
            COUNT(CASE WHEN r.priority = '1' AND r.state NOT IN ('Closed','Cancelled') THEN 1 END) AS critical_open
          FROM crms_assignment_groups ag
          LEFT JOIN crms_releases r
            ON r.assignment_group_id = ag.group_id AND r.is_deleted = 0
          GROUP BY ag.group_id, ag.group_name`,
  },
];

// ── Runner ────────────────────────────────────────────────────────────
async function migrate() {
  let conn;
  try {
    conn = await oracledb.getConnection({
      user:             process.env.DB_USER,
      password:         process.env.DB_PASSWORD,
      connectionString: process.env.DB_CONNECTION_STRING,
    });

    console.log(`\n🔌  Connected to Oracle: ${process.env.DB_CONNECTION_STRING}`);
    console.log(`📋  Running ${DDL.length} DDL statements...\n`);

    let ok = 0, skipped = 0, failed = 0;

    for (const stmt of DDL) {
      try {
        await conn.execute(stmt.sql);
        console.log(`  ✅  ${stmt.name}`);
        ok++;
      } catch (err) {
        // ORA-00955: name already used — object already exists → skip
        // ORA-04043: object does not exist (for DROP) → skip
        if ([955, 4043, 2261].includes(err.errorNum)) {
          console.log(`  ⏭️   ${stmt.name}  (already exists — skipped)`);
          skipped++;
        } else {
          console.error(`  ❌  ${stmt.name}`);
          console.error(`      ORA-${err.errorNum}: ${err.message}`);
          failed++;
        }
      }
    }

    await conn.commit();

    console.log(`\n═══════════════════════════════════════`);
    console.log(`  Migration complete`);
    console.log(`  ✅ Created : ${ok}`);
    console.log(`  ⏭️  Skipped : ${skipped}`);
    console.log(`  ❌ Failed  : ${failed}`);
    console.log(`═══════════════════════════════════════\n`);

    if (failed > 0) process.exit(1);

  } catch (err) {
    console.error('\n💥 Migration failed:', err.message);
    process.exit(1);
  } finally {
    if (conn) await conn.close();
  }
}

migrate();
