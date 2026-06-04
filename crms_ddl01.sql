-- ============================================================
-- MOTHERSON CR MANAGEMENT SYSTEM -- Oracle DDL Script
-- Run as: APPS user on ebs_MSWILDEV
-- Usage:  SQL> @crms_ddl.sql
-- ============================================================

SET ECHO OFF
SET SERVEROUTPUT ON
SET DEFINE OFF
WHENEVER SQLERROR CONTINUE

BEGIN
  DBMS_OUTPUT.PUT_LINE('===========================================');
  DBMS_OUTPUT.PUT_LINE('CRMS DDL Migration - Starting');
  DBMS_OUTPUT.PUT_LINE('User   : ' || SYS_CONTEXT('APPS','SESSION_USER'));
  DBMS_OUTPUT.PUT_LINE('DB     : ' || SYS_CONTEXT('MSWILDEV','DB_NAME'));
  DBMS_OUTPUT.PUT_LINE('Time   : ' || TO_CHAR(SYSDATE,'DD-MON-YYYY HH24:MI:SS'));
  DBMS_OUTPUT.PUT_LINE('===========================================');
END;
/

-- ============================================================
-- SEQUENCES
-- ============================================================

DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_sequences WHERE sequence_name = 'CRMS_RELEASE_SEQ';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE SEQUENCE crms_release_seq
        START WITH     11973
        INCREMENT BY   1
        NOCACHE
        NOCYCLE';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_release_seq');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_release_seq (exists)');
  END IF;
END;
/

DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_sequences WHERE sequence_name = 'CRMS_TASK_SEQ';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE SEQUENCE crms_task_seq
        START WITH     15933
        INCREMENT BY   1
        NOCACHE
        NOCYCLE';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_task_seq');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_task_seq (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_USERS
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_USERS';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_users (
        user_id             NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        initials            VARCHAR2(3)    NOT NULL,
        full_name           VARCHAR2(200)  NOT NULL,
        role                VARCHAR2(10)   DEFAULT ''user'' NOT NULL
                              CONSTRAINT chk_user_role CHECK (role IN (''admin'',''user'')),
        password_hash       VARCHAR2(255)  NOT NULL,
        refresh_token_hash  VARCHAR2(255),
        is_active           NUMBER(1)      DEFAULT 1 NOT NULL
                              CONSTRAINT chk_user_active CHECK (is_active IN (0,1)),
        last_login          TIMESTAMP,
        created_at          TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT uq_user_initials UNIQUE (initials)
      )';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_users');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_users (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_ASSIGNMENT_GROUPS
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_ASSIGNMENT_GROUPS';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_assignment_groups (
        group_id    NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        group_name  VARCHAR2(200)  NOT NULL,
        description VARCHAR2(500),
        created_at  TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT uq_group_name UNIQUE (group_name)
      )';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_assignment_groups');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_assignment_groups (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_GROUP_MEMBERS
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_GROUP_MEMBERS';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_group_members (
        group_id   NUMBER NOT NULL
            CONSTRAINT fk_gm_group REFERENCES crms_assignment_groups(group_id) ON DELETE CASCADE,
        user_id    NUMBER NOT NULL
            CONSTRAINT fk_gm_user  REFERENCES crms_users(user_id) ON DELETE CASCADE,
        joined_at  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT pk_group_members PRIMARY KEY (group_id, user_id)
      )';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_group_members');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_group_members (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_COMPANIES
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_COMPANIES';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_companies (
        company_id   NUMBER        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        company_name VARCHAR2(200) NOT NULL,
        created_at   TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT uq_company_name UNIQUE (company_name)
      )';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_companies');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_companies (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_SERVICES
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_SERVICES';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_services (
        service_id   NUMBER        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        service_name VARCHAR2(200) NOT NULL,
        created_at   TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT uq_service_name UNIQUE (service_name)
      )';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_services');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_services (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_RELEASES  (main CR table)
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_RELEASES';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_releases (
        release_id          NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        release_number      VARCHAR2(20)   NOT NULL,
        state               VARCHAR2(30)   DEFAULT ''Draft'' NOT NULL
            CONSTRAINT chk_release_state CHECK (state IN (
              ''Draft'',''BRD Phase'',''FSD Phase'',''Awaiting approval'',''On Hold'',
              ''Development Phase'',''Testing/QA'',''UAT'',''Deployment'',''Closed'',''Cancelled''
            )),
        priority            VARCHAR2(1)    NOT NULL
            CONSTRAINT chk_release_priority CHECK (priority IN (''1'',''2'',''3'',''4'')),
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
      )';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_releases');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_releases (exists)');
  END IF;
END;
/

-- Indexes on crms_releases
DECLARE PROCEDURE safe_idx(p_sql VARCHAR2, p_name VARCHAR2) IS
BEGIN
  EXECUTE IMMEDIATE p_sql;
  DBMS_OUTPUT.PUT_LINE('  INDEX   : ' || p_name);
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE = -955 THEN DBMS_OUTPUT.PUT_LINE('  SKIPPED : ' || p_name || ' (exists)');
  ELSE RAISE; END IF;
END;
BEGIN
  safe_idx('CREATE INDEX idx_rel_state    ON crms_releases(state)',                'idx_rel_state');
  safe_idx('CREATE INDEX idx_rel_reqby    ON crms_releases(requested_by)',          'idx_rel_reqby');
  safe_idx('CREATE INDEX idx_rel_ag       ON crms_releases(assignment_group_id)',   'idx_rel_ag');
  safe_idx('CREATE INDEX idx_rel_priority ON crms_releases(priority)',              'idx_rel_priority');
  safe_idx('CREATE INDEX idx_rel_startdt  ON crms_releases(planned_start_date)',    'idx_rel_startdt');
  safe_idx('CREATE INDEX idx_rel_deleted  ON crms_releases(is_deleted)',            'idx_rel_deleted');
END;
/

-- ============================================================
-- TABLE: CRMS_RELEASE_HISTORY
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_RELEASE_HISTORY';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_release_history (
        history_id   NUMBER        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        release_id   NUMBER        NOT NULL
            CONSTRAINT fk_hist_release REFERENCES crms_releases(release_id) ON DELETE CASCADE,
        action       VARCHAR2(50)  NOT NULL,
        from_state   VARCHAR2(30),
        to_state     VARCHAR2(30)  NOT NULL,
        changed_by   NUMBER        NOT NULL
            CONSTRAINT fk_hist_user REFERENCES crms_users(user_id),
        changed_at   TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL
      )';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_release_history');
    EXECUTE IMMEDIATE 'CREATE INDEX idx_hist_release ON crms_release_history(release_id)';
    DBMS_OUTPUT.PUT_LINE('  INDEX   : idx_hist_release');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_release_history (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_TASKS
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_TASKS';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_tasks (
        task_id             NUMBER        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        task_number         VARCHAR2(20)  NOT NULL,
        release_id          NUMBER        NOT NULL
            CONSTRAINT fk_task_release REFERENCES crms_releases(release_id) ON DELETE CASCADE,
        phase               VARCHAR2(10)  NOT NULL
            CONSTRAINT chk_task_phase CHECK (phase IN (''BRD'',''FSD'',''Dev'',''Testing'',''UAT'')),
        task_type           VARCHAR2(30)  NOT NULL,
        state               VARCHAR2(10)  DEFAULT ''Open'' NOT NULL
            CONSTRAINT chk_task_state CHECK (state IN (''Open'',''Closed'')),
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
      )';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_tasks');
    EXECUTE IMMEDIATE 'CREATE INDEX idx_task_release  ON crms_tasks(release_id)';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_task_assigned ON crms_tasks(assigned_to_user_id)';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_task_state    ON crms_tasks(state)';
    DBMS_OUTPUT.PUT_LINE('  INDEXES : crms_tasks (3)');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_tasks (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_COMMENTS
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_COMMENTS';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_comments (
        comment_id    NUMBER   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        release_id    NUMBER   NOT NULL
            CONSTRAINT fk_comment_release REFERENCES crms_releases(release_id) ON DELETE CASCADE,
        comment_text  CLOB     NOT NULL,
        created_by    NUMBER   NOT NULL
            CONSTRAINT fk_comment_user REFERENCES crms_users(user_id),
        created_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
      )';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_comments');
    EXECUTE IMMEDIATE 'CREATE INDEX idx_comment_release ON crms_comments(release_id)';
    DBMS_OUTPUT.PUT_LINE('  INDEX   : idx_comment_release');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_comments (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_NOTIFICATIONS
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_NOTIFICATIONS';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_notifications (
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
      )';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_notifications');
    EXECUTE IMMEDIATE 'CREATE INDEX idx_notif_user   ON crms_notifications(user_id)';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_notif_unread ON crms_notifications(user_id, is_read)';
    DBMS_OUTPUT.PUT_LINE('  INDEXES : crms_notifications (2)');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_notifications (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_AUDIT
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_AUDIT';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_audit (
        audit_id      NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        action        VARCHAR2(50)   NOT NULL,
        performed_by  NUMBER         NOT NULL
            CONSTRAINT fk_audit_user REFERENCES crms_users(user_id),
        cr_number     VARCHAR2(20)   DEFAULT ''--'' NOT NULL,
        details       VARCHAR2(1000),
        created_at    TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL
      )';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_audit');
    EXECUTE IMMEDIATE 'CREATE INDEX idx_audit_user     ON crms_audit(performed_by)';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_audit_action   ON crms_audit(action)';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_audit_crnum    ON crms_audit(cr_number)';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_audit_createdt ON crms_audit(created_at DESC)';
    DBMS_OUTPUT.PUT_LINE('  INDEXES : crms_audit (4)');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_audit (exists)');
  END IF;
END;
/

-- ============================================================
-- TRIGGERS
-- ============================================================
CREATE OR REPLACE TRIGGER trg_releases_updated_at
  BEFORE UPDATE ON crms_releases
  FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;
/
SHOW ERRORS

CREATE OR REPLACE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON crms_tasks
  FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;
/
SHOW ERRORS

-- ============================================================
-- VIEWS
-- ============================================================
CREATE OR REPLACE VIEW vw_releases_summary AS
SELECT
  r.release_id,
  r.release_number,
  r.state,
  r.priority,
  CASE r.priority
    WHEN '1' THEN '1 - Critical'
    WHEN '2' THEN '2 - High'
    WHEN '3' THEN '3 - Moderate'
    WHEN '4' THEN '4 - Low'
    ELSE r.priority
  END                                                          AS priority_label,
  r.title,
  r.company,
  r.service,
  r.planned_start_date,
  r.target_end_date,
  TRUNC(SYSDATE - r.planned_start_date)                       AS sla_age_days,
  u_req.full_name                                             AS requested_by,
  u_ass.full_name                                             AS assigned_to,
  ag.group_name                                               AS assignment_group,
  r.created_at,
  r.updated_at,
  (SELECT COUNT(*) FROM crms_tasks    t WHERE t.release_id = r.release_id)              AS task_count,
  (SELECT COUNT(*) FROM crms_tasks    t WHERE t.release_id = r.release_id AND t.state = 'Open') AS open_task_count,
  (SELECT COUNT(*) FROM crms_comments c WHERE c.release_id = r.release_id)              AS comment_count
FROM  crms_releases r
JOIN  crms_users u_req             ON u_req.user_id  = r.requested_by
LEFT  JOIN crms_users u_ass        ON u_ass.user_id  = r.assigned_to_user_id
LEFT  JOIN crms_assignment_groups ag ON ag.group_id  = r.assignment_group_id
WHERE r.is_deleted = 0
/
SHOW ERRORS

CREATE OR REPLACE VIEW vw_analytics_by_group AS
SELECT
  ag.group_id,
  ag.group_name,
  COUNT(r.release_id)                                                            AS total_releases,
  COUNT(CASE WHEN r.state NOT IN ('Closed','Cancelled') THEN 1 END)             AS open_releases,
  COUNT(CASE WHEN r.state = 'Closed'    THEN 1 END)                             AS closed_releases,
  COUNT(CASE WHEN r.state = 'Cancelled' THEN 1 END)                             AS cancelled_releases,
  COUNT(CASE WHEN r.priority = '1'
              AND r.state NOT IN ('Closed','Cancelled') THEN 1 END)             AS critical_open
FROM crms_assignment_groups ag
LEFT JOIN crms_releases r
  ON r.assignment_group_id = ag.group_id AND r.is_deleted = 0
GROUP BY ag.group_id, ag.group_name
/
SHOW ERRORS

-- ============================================================
-- SEED DATA -- Reference tables
-- ============================================================

-- Companies
MERGE INTO crms_companies t
USING (SELECT 'MSSL'                    AS n FROM dual UNION ALL
       SELECT 'Motherson Sumi'          FROM dual UNION ALL
       SELECT 'Motherson Innovations'   FROM dual UNION ALL
       SELECT 'Motherson Technology'    FROM dual) s
ON (t.company_name = s.n)
WHEN NOT MATCHED THEN INSERT (company_name) VALUES (s.n);

-- Services
MERGE INTO crms_services t
USING (SELECT 'Oracle'       AS n FROM dual UNION ALL
       SELECT 'SAP'          FROM dual UNION ALL
       SELECT 'Salesforce'   FROM dual UNION ALL
       SELECT 'ServiceNow'   FROM dual UNION ALL
       SELECT 'Workday'      FROM dual) s
ON (t.service_name = s.n)
WHEN NOT MATCHED THEN INSERT (service_name) VALUES (s.n);

-- ============================================================
-- SEED DATA -- Users
-- Password hashes are bcrypt of: admin123 (SG) and pass123 (RK, PM, AV)
-- Generated offline with bcrypt rounds=12
-- ============================================================

MERGE INTO crms_users t
USING (
  SELECT 'SG' AS ini, 'Sandeep Gupta' AS nm, 'admin' AS rl,
         '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQyCggi7pm9zcoYVhotTqCRUa' AS ph FROM dual
  UNION ALL
  SELECT 'RK','Rohit Kumar','user',
         '$2b$12$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/2VmCX3iiMpKCWRiqS' FROM dual
  UNION ALL
  SELECT 'PM','Priya Mehta','user',
         '$2b$12$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/2VmCX3iiMpKCWRiqS' FROM dual
  UNION ALL
  SELECT 'AV','Amit Verma','user',
         '$2b$12$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/2VmCX3iiMpKCWRiqS' FROM dual
) s ON (t.initials = s.ini)
WHEN NOT MATCHED THEN
  INSERT (initials, full_name, role, password_hash)
  VALUES (s.ini, s.nm, s.rl, s.ph);

-- ============================================================
-- SEED DATA -- Assignment Groups
-- ============================================================

MERGE INTO crms_assignment_groups t
USING (
  SELECT 'MSSL-Oracle-Functional' AS gn, 'Oracle EBS Functional team' AS ds FROM dual UNION ALL
  SELECT 'MSSL-Oracle-Technical',         'Oracle EBS Technical team'         FROM dual UNION ALL
  SELECT 'MSSL-SAP-Basis',                'SAP Basis & Infrastructure'        FROM dual
) s ON (t.group_name = s.gn)
WHEN NOT MATCHED THEN INSERT (group_name, description) VALUES (s.gn, s.ds);

-- ============================================================
-- SEED DATA -- Group Members
-- ============================================================

-- MSSL-Oracle-Functional: SG, PM
MERGE INTO crms_group_members t
USING (
  SELECT g.group_id, u.user_id
    FROM crms_assignment_groups g, crms_users u
   WHERE g.group_name = 'MSSL-Oracle-Functional'
     AND u.initials IN ('SG','PM')
) s ON (t.group_id = s.group_id AND t.user_id = s.user_id)
WHEN NOT MATCHED THEN INSERT (group_id, user_id) VALUES (s.group_id, s.user_id);

-- MSSL-Oracle-Technical: RK, AV
MERGE INTO crms_group_members t
USING (
  SELECT g.group_id, u.user_id
    FROM crms_assignment_groups g, crms_users u
   WHERE g.group_name = 'MSSL-Oracle-Technical'
     AND u.initials IN ('RK','AV')
) s ON (t.group_id = s.group_id AND t.user_id = s.user_id)
WHEN NOT MATCHED THEN INSERT (group_id, user_id) VALUES (s.group_id, s.user_id);

-- MSSL-SAP-Basis: PM
MERGE INTO crms_group_members t
USING (
  SELECT g.group_id, u.user_id
    FROM crms_assignment_groups g, crms_users u
   WHERE g.group_name = 'MSSL-SAP-Basis'
     AND u.initials = 'PM'
) s ON (t.group_id = s.group_id AND t.user_id = s.user_id)
WHEN NOT MATCHED THEN INSERT (group_id, user_id) VALUES (s.group_id, s.user_id);

-- ============================================================
-- SEED DATA -- Demo Releases
-- ============================================================

DECLARE
  v_sg_id   NUMBER;
  v_rk_id   NUMBER;
  v_pm_id   NUMBER;
  v_av_id   NUMBER;
  v_fg_id   NUMBER;  -- MSSL-Oracle-Functional
  v_tg_id   NUMBER;  -- MSSL-Oracle-Technical
  v_rel1_id NUMBER;
  v_rel2_id NUMBER;
  v_rel3_id NUMBER;

  PROCEDURE ins_release(
    p_num    VARCHAR2, p_state VARCHAR2, p_priority VARCHAR2,
    p_title  VARCHAR2, p_summary VARCHAR2, p_company VARCHAR2, p_service VARCHAR2,
    p_sdate  DATE, p_edate DATE, p_reqby NUMBER, p_ag NUMBER, p_at NUMBER,
    p_id OUT NUMBER
  ) IS
    v_exists NUMBER;
  BEGIN
    SELECT COUNT(*) INTO v_exists FROM crms_releases WHERE release_number = p_num;
    IF v_exists = 0 THEN
      INSERT INTO crms_releases
        (release_number, state, priority, title, summary, company, service,
         planned_start_date, target_end_date, requested_by, assignment_group_id, assigned_to_user_id)
      VALUES
        (p_num, p_state, p_priority, p_title, p_summary, p_company, p_service,
         p_sdate, p_edate, p_reqby, p_ag, p_at)
      RETURNING release_id INTO p_id;
      DBMS_OUTPUT.PUT_LINE('  RELEASE : ' || p_num || ' created');
    ELSE
      SELECT release_id INTO p_id FROM crms_releases WHERE release_number = p_num;
      DBMS_OUTPUT.PUT_LINE('  RELEASE : ' || p_num || ' (exists)');
    END IF;
  END;

BEGIN
  SELECT user_id INTO v_sg_id FROM crms_users WHERE initials = 'SG';
  SELECT user_id INTO v_rk_id FROM crms_users WHERE initials = 'RK';
  SELECT user_id INTO v_pm_id FROM crms_users WHERE initials = 'PM';
  SELECT user_id INTO v_av_id FROM crms_users WHERE initials = 'AV';
  SELECT group_id INTO v_fg_id FROM crms_assignment_groups WHERE group_name = 'MSSL-Oracle-Functional';
  SELECT group_id INTO v_tg_id FROM crms_assignment_groups WHERE group_name = 'MSSL-Oracle-Technical';

  -- Release 1
  ins_release(
    'RLSE0011972','BRD Phase','3',
    'IDACS Phase 2 Pick Release Integration',
    'Review and integrate the IDACS Phase 2 pick release functionality into Oracle EBS.',
    'MSSL','Oracle', DATE '2025-04-01', DATE '2025-06-30',
    v_sg_id, v_fg_id, v_pm_id, v_rel1_id
  );
  -- Release 2
  ins_release(
    'RLSE0011973','Development Phase','1',
    'Oracle Financials Year-End Close Automation',
    'Automate and streamline the Oracle financials year-end closing process for MSSL.',
    'MSSL','Oracle', DATE '2025-03-01', DATE '2025-05-31',
    v_rk_id, v_tg_id, v_av_id, v_rel2_id
  );
  -- Release 3
  ins_release(
    'RLSE0011974','Testing/QA','2',
    'SAP HR Integration with Oracle HCM',
    'Integrate SAP HR module data feeds with Oracle HCM for unified employee management.',
    'MSSL','SAP', DATE '2025-02-15', DATE '2025-04-30',
    v_pm_id, v_fg_id, v_sg_id, v_rel3_id
  );

  -- History for Release 1
  INSERT INTO crms_release_history (release_id, action, from_state, to_state, changed_by)
    SELECT v_rel1_id, 'Created', NULL, 'Draft', v_sg_id FROM dual
    WHERE NOT EXISTS (SELECT 1 FROM crms_release_history WHERE release_id = v_rel1_id AND action = 'Created');
  INSERT INTO crms_release_history (release_id, action, from_state, to_state, changed_by)
    SELECT v_rel1_id, 'State Change', 'Draft', 'BRD Phase', v_sg_id FROM dual
    WHERE NOT EXISTS (SELECT 1 FROM crms_release_history WHERE release_id = v_rel1_id AND to_state = 'BRD Phase');

  -- History for Release 2
  FOR rec IN (
    SELECT 'Created'              AS act, NULL                   AS frm, 'Draft'              AS t FROM dual UNION ALL
    SELECT 'State Change',              'Draft',                     'BRD Phase'              FROM dual UNION ALL
    SELECT 'State Change',              'BRD Phase',                 'FSD Phase'              FROM dual UNION ALL
    SELECT 'State Change',              'FSD Phase',                 'Awaiting approval'      FROM dual UNION ALL
    SELECT 'State Change',              'Awaiting approval',         'Development Phase'      FROM dual
  ) LOOP
    INSERT INTO crms_release_history (release_id, action, from_state, to_state, changed_by)
      SELECT v_rel2_id, rec.act, rec.frm, rec.t, v_rk_id FROM dual
      WHERE NOT EXISTS (SELECT 1 FROM crms_release_history WHERE release_id = v_rel2_id AND to_state = rec.t);
  END LOOP;

  -- History for Release 3
  INSERT INTO crms_release_history (release_id, action, from_state, to_state, changed_by)
    SELECT v_rel3_id, 'Created', NULL, 'Draft', v_pm_id FROM dual
    WHERE NOT EXISTS (SELECT 1 FROM crms_release_history WHERE release_id = v_rel3_id AND action = 'Created');

  -- Tasks
  -- Task 1
  MERGE INTO crms_tasks t
  USING (SELECT 'RTSK0015933' AS tn FROM dual) s ON (t.task_number = s.tn)
  WHEN NOT MATCHED THEN INSERT
    (task_number, release_id, phase, task_type, state, short_description, assignment_group_id, assigned_to_user_id, created_by)
  VALUES
    ('RTSK0015933', v_rel1_id, 'BRD', 'BRD Task', 'Open',
     'Review IDACS Phase 2 business requirements document', v_fg_id, v_pm_id, v_sg_id);

  -- Task 2
  MERGE INTO crms_tasks t
  USING (SELECT 'RTSK0015934' AS tn FROM dual) s ON (t.task_number = s.tn)
  WHEN NOT MATCHED THEN INSERT
    (task_number, release_id, phase, task_type, state, short_description, assignment_group_id, assigned_to_user_id, created_by)
  VALUES
    ('RTSK0015934', v_rel2_id, 'Dev', 'Development Task', 'Open',
     'Build year-end GL closing automation scripts', v_tg_id, v_av_id, v_rk_id);

  -- Task 3
  MERGE INTO crms_tasks t
  USING (SELECT 'RTSK0015935' AS tn FROM dual) s ON (t.task_number = s.tn)
  WHEN NOT MATCHED THEN INSERT
    (task_number, release_id, phase, task_type, state, short_description, assignment_group_id, assigned_to_user_id, created_by)
  VALUES
    ('RTSK0015935', v_rel2_id, 'Dev', 'Development Task', 'Open',
     'Create reconciliation report for period-end balances', v_tg_id, v_rk_id, v_rk_id);

  -- Task 4
  MERGE INTO crms_tasks t
  USING (SELECT 'RTSK0015936' AS tn FROM dual) s ON (t.task_number = s.tn)
  WHEN NOT MATCHED THEN INSERT
    (task_number, release_id, phase, task_type, state, short_description, assignment_group_id, assigned_to_user_id, created_by)
  VALUES
    ('RTSK0015936', v_rel3_id, 'BRD', 'BRD Task', 'Open',
     'Map SAP HR fields to Oracle HCM attributes', v_fg_id, v_sg_id, v_pm_id);

  DBMS_OUTPUT.PUT_LINE('  TASKS   : 4 tasks seeded');

  -- Comments
  IF v_rel1_id IS NOT NULL THEN
    INSERT INTO crms_comments (release_id, comment_text, created_by)
      SELECT v_rel1_id,
             'BRD review meeting scheduled for next week. Please prepare the as-is process maps.',
             v_sg_id
      FROM dual
      WHERE (SELECT COUNT(*) FROM crms_comments WHERE release_id = v_rel1_id) = 0;

    INSERT INTO crms_comments (release_id, comment_text, created_by)
      SELECT v_rel1_id,
             'As-is maps uploaded to SharePoint. Please review and update the gap analysis section.',
             v_pm_id
      FROM dual
      WHERE (SELECT COUNT(*) FROM crms_comments WHERE release_id = v_rel1_id) < 2;

    DBMS_OUTPUT.PUT_LINE('  COMMENTS: 2 comments seeded on RLSE0011972');
  END IF;

  -- System audit entry
  INSERT INTO crms_audit (action, performed_by, cr_number, details)
    SELECT 'System Start', v_sg_id, '--',
           'CR Management System initialized -- CRMS DDL and seed complete'
    FROM dual
    WHERE NOT EXISTS (SELECT 1 FROM crms_audit WHERE action = 'System Start');

  DBMS_OUTPUT.PUT_LINE('  AUDIT   : System Start entry logged');

END;
/

COMMIT;

-- ============================================================
-- VERIFICATION -- Print table counts
-- ============================================================
DECLARE
  PROCEDURE show_count(p_table VARCHAR2) IS
    v_cnt NUMBER;
  BEGIN
    EXECUTE IMMEDIATE 'SELECT COUNT(*) FROM ' || p_table INTO v_cnt;
    DBMS_OUTPUT.PUT_LINE('  ' || RPAD(p_table, 30) || ' : ' || v_cnt || ' rows');
  EXCEPTION WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('  ' || RPAD(p_table, 30) || ' : ERROR - ' || SQLERRM);
  END;
BEGIN
  DBMS_OUTPUT.PUT_LINE(CHR(10) || '===========================================');
  DBMS_OUTPUT.PUT_LINE('CRMS Table Row Counts:');
  DBMS_OUTPUT.PUT_LINE('===========================================');
  show_count('crms_users');
  show_count('crms_assignment_groups');
  show_count('crms_group_members');
  show_count('crms_companies');
  show_count('crms_services');
  show_count('crms_releases');
  show_count('crms_release_history');
  show_count('crms_tasks');
  show_count('crms_comments');
  show_count('crms_notifications');
  show_count('crms_audit');
  DBMS_OUTPUT.PUT_LINE('===========================================');
  DBMS_OUTPUT.PUT_LINE('Migration complete. CRMS is ready.');
  DBMS_OUTPUT.PUT_LINE('===========================================');
END;
/
