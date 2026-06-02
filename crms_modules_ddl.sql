-- ============================================================
-- CRMS PHASE 2 — Module Mapping & Approval Flow DDL
-- Run as: APPS user on ebs_MSWILDEV
-- Run AFTER crms_ddl.sql (existing tables must exist)
-- ============================================================

SET ECHO OFF
SET SERVEROUTPUT ON
SET DEFINE OFF
WHENEVER SQLERROR CONTINUE

BEGIN
  DBMS_OUTPUT.PUT_LINE('===========================================');
  DBMS_OUTPUT.PUT_LINE('CRMS Module DDL Migration - Starting');
  DBMS_OUTPUT.PUT_LINE('Time : ' || TO_CHAR(SYSDATE,'DD-MON-YYYY HH24:MI:SS'));
  DBMS_OUTPUT.PUT_LINE('===========================================');
END;
/

-- ============================================================
-- TABLE: CRMS_MODULES
-- Defines business modules e.g. Manufacturing, Purchasing, Finance
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_MODULES';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_modules (
        module_id       NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        module_name     VARCHAR2(200)  NOT NULL,
        description     VARCHAR2(500),
        is_active       NUMBER(1)      DEFAULT 1 NOT NULL
                          CONSTRAINT chk_mod_active CHECK (is_active IN (0,1)),
        created_at      TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT uq_module_name UNIQUE (module_name)
      )';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_modules');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_modules (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_MODULE_GROUPS
-- Maps which assignment groups belong to which module
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_MODULE_GROUPS';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_module_groups (
        module_id   NUMBER NOT NULL
            CONSTRAINT fk_mg_module REFERENCES crms_modules(module_id) ON DELETE CASCADE,
        group_id    NUMBER NOT NULL
            CONSTRAINT fk_mg_group  REFERENCES crms_assignment_groups(group_id) ON DELETE CASCADE,
        CONSTRAINT pk_module_groups PRIMARY KEY (module_id, group_id)
      )';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_module_groups');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_module_groups (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_MODULE_USERS
-- Maps which users are business users in which module
-- role: 'requester' (can create RDs) or 'approver' (can approve)
-- A user can be both requester and approver in the same module
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_MODULE_USERS';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_module_users (
        module_user_id  NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        module_id       NUMBER         NOT NULL
            CONSTRAINT fk_mu_module REFERENCES crms_modules(module_id) ON DELETE CASCADE,
        user_id         NUMBER         NOT NULL
            CONSTRAINT fk_mu_user   REFERENCES crms_users(user_id) ON DELETE CASCADE,
        is_requester    NUMBER(1)      DEFAULT 1 NOT NULL
                          CONSTRAINT chk_mu_req CHECK (is_requester IN (0,1)),
        is_approver     NUMBER(1)      DEFAULT 0 NOT NULL
                          CONSTRAINT chk_mu_app CHECK (is_approver IN (0,1)),
        created_at      TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT uq_module_user UNIQUE (module_id, user_id)
      )';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_mu_user   ON crms_module_users(user_id)';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_mu_module ON crms_module_users(module_id)';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_module_users');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_module_users (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_APPROVAL_FLOWS
-- Defines N-level approval chain per module
-- level_order: 1 = first approver, 2 = second, etc.
-- auto_approve: if only 1 level and this = 1, skip approval entirely
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_APPROVAL_FLOWS';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_approval_flows (
        flow_id         NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        module_id       NUMBER         NOT NULL
            CONSTRAINT fk_af_module REFERENCES crms_modules(module_id) ON DELETE CASCADE,
        level_order     NUMBER         NOT NULL,
        approver_user_id NUMBER        NOT NULL
            CONSTRAINT fk_af_approver REFERENCES crms_users(user_id),
        auto_approve    NUMBER(1)      DEFAULT 0 NOT NULL
                          CONSTRAINT chk_af_auto CHECK (auto_approve IN (0,1)),
        created_at      TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT uq_flow_level UNIQUE (module_id, level_order)
      )';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_af_module ON crms_approval_flows(module_id)';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_approval_flows');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_approval_flows (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_RELEASE_APPROVALS
-- Tracks the per-release approval status at each level
-- status: 'Pending', 'Approved', 'Rejected'
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_RELEASE_APPROVALS';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_release_approvals (
        approval_id      NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        release_id       NUMBER         NOT NULL
            CONSTRAINT fk_ra_release REFERENCES crms_releases(release_id) ON DELETE CASCADE,
        module_id        NUMBER         NOT NULL
            CONSTRAINT fk_ra_module  REFERENCES crms_modules(module_id),
        level_order      NUMBER         NOT NULL,
        approver_user_id NUMBER         NOT NULL
            CONSTRAINT fk_ra_approver REFERENCES crms_users(user_id),
        status           VARCHAR2(20)   DEFAULT ''Pending'' NOT NULL
            CONSTRAINT chk_ra_status CHECK (status IN (''Pending'',''Approved'',''Rejected'')),
        comments         VARCHAR2(1000),
        actioned_at      TIMESTAMP,
        created_at       TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL
      )';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_ra_release  ON crms_release_approvals(release_id)';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_ra_approver ON crms_release_approvals(approver_user_id)';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_ra_status   ON crms_release_approvals(status)';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_release_approvals');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_release_approvals (exists)');
  END IF;
END;
/

-- ============================================================
-- TABLE: CRMS_RELEASE_REVIEWS
-- Tracks phase-wise review assignments created from "Send for Review"
-- status: 'Pending' or 'Referred'
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM user_tables WHERE table_name = 'CRMS_RELEASE_REVIEWS';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_release_reviews (
        review_id           NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        release_id          NUMBER         NOT NULL
            CONSTRAINT fk_rr_release REFERENCES crms_releases(release_id) ON DELETE CASCADE,
        module_id           NUMBER         NOT NULL
            CONSTRAINT fk_rr_module REFERENCES crms_modules(module_id),
        phase_code          VARCHAR2(20)   NOT NULL,
        reviewer_user_id    NUMBER         NOT NULL
            CONSTRAINT fk_rr_reviewer REFERENCES crms_users(user_id),
        created_by_user_id  NUMBER         NOT NULL
            CONSTRAINT fk_rr_created_by REFERENCES crms_users(user_id),
        parent_review_id    NUMBER
            CONSTRAINT fk_rr_parent REFERENCES crms_release_reviews(review_id),
        status              VARCHAR2(20)   DEFAULT ''Pending'' NOT NULL
            CONSTRAINT chk_rr_status CHECK (status IN (''Pending'',''Referred'')),
        actioned_at         TIMESTAMP,
        created_at          TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL
      )';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_rr_reviewer ON crms_release_reviews(reviewer_user_id, status)';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_rr_release  ON crms_release_reviews(release_id, phase_code)';
    DBMS_OUTPUT.PUT_LINE('  CREATED : crms_release_reviews');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_release_reviews (exists)');
  END IF;
END;
/

-- ============================================================
-- ALTER crms_releases — add module_id column
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists
    FROM user_tab_columns
   WHERE table_name = 'CRMS_RELEASES' AND column_name = 'MODULE_ID';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE crms_releases ADD (module_id NUMBER CONSTRAINT fk_rel_module REFERENCES crms_modules(module_id))';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_rel_module ON crms_releases(module_id)';
    DBMS_OUTPUT.PUT_LINE('  ALTERED : crms_releases — added module_id');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_releases.module_id (exists)');
  END IF;
END;
/

-- ============================================================
-- ALTER crms_releases — add current_approval_level column
-- tracks which approval level is currently awaiting action
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists
    FROM user_tab_columns
   WHERE table_name = 'CRMS_RELEASES' AND column_name = 'CURRENT_APPROVAL_LEVEL';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE crms_releases ADD (current_approval_level NUMBER DEFAULT 0)';
    DBMS_OUTPUT.PUT_LINE('  ALTERED : crms_releases — added current_approval_level');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  SKIPPED : crms_releases.current_approval_level (exists)');
  END IF;
END;
/

-- ============================================================
-- UPDATE crms_releases check constraint to include new states
-- Drop old constraint and add new one with RD Phase + Awaiting Approval Lx
-- ============================================================
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists
    FROM user_constraints
   WHERE table_name = 'CRMS_RELEASES' AND constraint_name = 'CHK_RELEASE_STATE';
  IF v_exists > 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE crms_releases DROP CONSTRAINT chk_release_state';
    DBMS_OUTPUT.PUT_LINE('  DROPPED : chk_release_state constraint');
  END IF;
END;
/

-- Add new state constraint that includes RD Phase and dynamic Awaiting Approval states
-- We use a more flexible CHECK that allows Awaiting Approval L[0-9]
-- Since Oracle CHECK cannot use REGEXP easily, we use a broader approach:
-- Remove the constraint and enforce state transitions in application layer
-- (The 11 original states + RD Phase + Awaiting Approval L1..L9)
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists
    FROM user_constraints
   WHERE table_name = 'CRMS_RELEASES' AND constraint_name = 'CHK_RELEASE_STATE';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE crms_releases ADD CONSTRAINT chk_release_state
      CHECK (state IN (
        'Draft','RD Phase','Awaiting Approval L1','Awaiting Approval L2',
        'Awaiting Approval L3','Awaiting Approval L4','Awaiting Approval L5',
        'FSD Phase','Awaiting approval','On Hold',
        'Development Phase','Testing/QA','UAT','Deployment','Closed','Cancelled'
      ))]';
    DBMS_OUTPUT.PUT_LINE('  CREATED : chk_release_state (updated with RD Phase + Approval levels)');
  END IF;
END;
/

-- ============================================================
-- SEED DATA — Demo modules
-- ============================================================
MERGE INTO crms_modules t
USING (
  SELECT 'Manufacturing' AS mn, 'Manufacturing division modules' AS ds FROM dual UNION ALL
  SELECT 'Purchasing',          'Purchasing & procurement modules'      FROM dual UNION ALL
  SELECT 'Finance',             'Finance & accounts modules'            FROM dual
) s ON (t.module_name = s.mn)
WHEN NOT MATCHED THEN INSERT (module_name, description) VALUES (s.mn, s.ds);

COMMIT;

-- ============================================================
-- Link existing groups to modules
-- ============================================================
DECLARE
  v_mfg_id  NUMBER;
  v_pur_id  NUMBER;
  v_fin_id  NUMBER;
  v_fg_id   NUMBER;
  v_tg_id   NUMBER;
  v_sg_id   NUMBER;
BEGIN
  SELECT module_id INTO v_mfg_id FROM crms_modules WHERE module_name = 'Manufacturing';
  SELECT module_id INTO v_pur_id FROM crms_modules WHERE module_name = 'Purchasing';
  SELECT module_id INTO v_fin_id FROM crms_modules WHERE module_name = 'Finance';

  -- Try to get groups (may not exist)
  BEGIN SELECT group_id INTO v_fg_id FROM crms_assignment_groups WHERE group_name = 'MSSL-Oracle-Functional'; EXCEPTION WHEN NO_DATA_FOUND THEN v_fg_id := NULL; END;
  BEGIN SELECT group_id INTO v_tg_id FROM crms_assignment_groups WHERE group_name = 'MSSL-Oracle-Technical';  EXCEPTION WHEN NO_DATA_FOUND THEN v_tg_id := NULL; END;
  BEGIN SELECT group_id INTO v_sg_id FROM crms_assignment_groups WHERE group_name = 'MSSL-SAP-Basis';         EXCEPTION WHEN NO_DATA_FOUND THEN v_sg_id := NULL; END;

  -- Map groups to modules
  IF v_fg_id IS NOT NULL THEN
    INSERT INTO crms_module_groups (module_id, group_id)
      SELECT v_mfg_id, v_fg_id FROM dual
      WHERE NOT EXISTS (SELECT 1 FROM crms_module_groups WHERE module_id=v_mfg_id AND group_id=v_fg_id);
    DBMS_OUTPUT.PUT_LINE('  MAPPED  : MSSL-Oracle-Functional -> Manufacturing');
  END IF;

  IF v_tg_id IS NOT NULL THEN
    INSERT INTO crms_module_groups (module_id, group_id)
      SELECT v_pur_id, v_tg_id FROM dual
      WHERE NOT EXISTS (SELECT 1 FROM crms_module_groups WHERE module_id=v_pur_id AND group_id=v_tg_id);
    DBMS_OUTPUT.PUT_LINE('  MAPPED  : MSSL-Oracle-Technical -> Purchasing');
  END IF;

  IF v_sg_id IS NOT NULL THEN
    INSERT INTO crms_module_groups (module_id, group_id)
      SELECT v_fin_id, v_sg_id FROM dual
      WHERE NOT EXISTS (SELECT 1 FROM crms_module_groups WHERE module_id=v_fin_id AND group_id=v_sg_id);
    DBMS_OUTPUT.PUT_LINE('  MAPPED  : MSSL-SAP-Basis -> Finance');
  END IF;
END;
/

-- ============================================================
-- Seed demo module users (SG and PM as requesters in Manufacturing)
-- SG also as approver L2, PM as approver L1
-- ============================================================
DECLARE
  v_mfg_id NUMBER;
  v_sg_id  NUMBER;
  v_pm_id  NUMBER;
  v_rk_id  NUMBER;
  v_av_id  NUMBER;
  v_pur_id NUMBER;
BEGIN
  SELECT module_id INTO v_mfg_id FROM crms_modules WHERE module_name = 'Manufacturing';
  SELECT module_id INTO v_pur_id FROM crms_modules WHERE module_name = 'Purchasing';
  SELECT user_id   INTO v_sg_id  FROM crms_users WHERE initials = 'SG';
  SELECT user_id   INTO v_pm_id  FROM crms_users WHERE initials = 'PM';
  SELECT user_id   INTO v_rk_id  FROM crms_users WHERE initials = 'RK';
  SELECT user_id   INTO v_av_id  FROM crms_users WHERE initials = 'AV';

  -- Manufacturing: SG = requester + approver, PM = requester + approver
  MERGE INTO crms_module_users t
  USING (SELECT v_mfg_id AS mid, v_sg_id AS uid, 1 AS req, 1 AS app FROM dual) s
  ON (t.module_id=s.mid AND t.user_id=s.uid)
  WHEN NOT MATCHED THEN INSERT (module_id,user_id,is_requester,is_approver) VALUES (s.mid,s.uid,s.req,s.app);

  MERGE INTO crms_module_users t
  USING (SELECT v_mfg_id AS mid, v_pm_id AS uid, 1 AS req, 1 AS app FROM dual) s
  ON (t.module_id=s.mid AND t.user_id=s.uid)
  WHEN NOT MATCHED THEN INSERT (module_id,user_id,is_requester,is_approver) VALUES (s.mid,s.uid,s.req,s.app);

  -- Purchasing: RK = requester, AV = approver
  MERGE INTO crms_module_users t
  USING (SELECT v_pur_id AS mid, v_rk_id AS uid, 1 AS req, 0 AS app FROM dual) s
  ON (t.module_id=s.mid AND t.user_id=s.uid)
  WHEN NOT MATCHED THEN INSERT (module_id,user_id,is_requester,is_approver) VALUES (s.mid,s.uid,s.req,s.app);

  MERGE INTO crms_module_users t
  USING (SELECT v_pur_id AS mid, v_av_id AS uid, 0 AS req, 1 AS app FROM dual) s
  ON (t.module_id=s.mid AND t.user_id=s.uid)
  WHEN NOT MATCHED THEN INSERT (module_id,user_id,is_requester,is_approver) VALUES (s.mid,s.uid,s.req,s.app);

  DBMS_OUTPUT.PUT_LINE('  SEEDED  : Module users');
END;
/

-- ============================================================
-- Seed demo approval flows
-- Manufacturing: 2-level (PM approves L1, SG approves L2)
-- Purchasing:    1-level auto-approve
-- ============================================================
DECLARE
  v_mfg_id NUMBER;
  v_pur_id NUMBER;
  v_sg_id  NUMBER;
  v_pm_id  NUMBER;
  v_av_id  NUMBER;
BEGIN
  SELECT module_id INTO v_mfg_id FROM crms_modules WHERE module_name = 'Manufacturing';
  SELECT module_id INTO v_pur_id FROM crms_modules WHERE module_name = 'Purchasing';
  SELECT user_id   INTO v_sg_id  FROM crms_users WHERE initials = 'SG';
  SELECT user_id   INTO v_pm_id  FROM crms_users WHERE initials = 'PM';
  SELECT user_id   INTO v_av_id  FROM crms_users WHERE initials = 'AV';

  -- Manufacturing: L1 = PM, L2 = SG
  MERGE INTO crms_approval_flows t
  USING (SELECT v_mfg_id AS mid, 1 AS lvl, v_pm_id AS uid, 0 AS auto FROM dual) s
  ON (t.module_id=s.mid AND t.level_order=s.lvl)
  WHEN NOT MATCHED THEN INSERT (module_id,level_order,approver_user_id,auto_approve) VALUES (s.mid,s.lvl,s.uid,s.auto);

  MERGE INTO crms_approval_flows t
  USING (SELECT v_mfg_id AS mid, 2 AS lvl, v_sg_id AS uid, 0 AS auto FROM dual) s
  ON (t.module_id=s.mid AND t.level_order=s.lvl)
  WHEN NOT MATCHED THEN INSERT (module_id,level_order,approver_user_id,auto_approve) VALUES (s.mid,s.lvl,s.uid,s.auto);

  -- Purchasing: L1 = AV, auto_approve = 1 (skip approval, go straight to FSD)
  MERGE INTO crms_approval_flows t
  USING (SELECT v_pur_id AS mid, 1 AS lvl, v_av_id AS uid, 1 AS auto FROM dual) s
  ON (t.module_id=s.mid AND t.level_order=s.lvl)
  WHEN NOT MATCHED THEN INSERT (module_id,level_order,approver_user_id,auto_approve) VALUES (s.mid,s.lvl,s.uid,s.auto);

  DBMS_OUTPUT.PUT_LINE('  SEEDED  : Approval flows');
END;
/

COMMIT;

-- ============================================================
-- VERIFICATION
-- ============================================================
DECLARE
  PROCEDURE show_count(p_table VARCHAR2) IS
    v_cnt NUMBER;
  BEGIN
    EXECUTE IMMEDIATE 'SELECT COUNT(*) FROM ' || p_table INTO v_cnt;
    DBMS_OUTPUT.PUT_LINE('  ' || RPAD(p_table,35) || ' : ' || v_cnt || ' rows');
  EXCEPTION WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('  ' || RPAD(p_table,35) || ' : ERROR - ' || SQLERRM);
  END;
BEGIN
  DBMS_OUTPUT.PUT_LINE(CHR(10) || '===========================================');
  DBMS_OUTPUT.PUT_LINE('Module DDL Row Counts:');
  DBMS_OUTPUT.PUT_LINE('===========================================');
  show_count('crms_modules');
  show_count('crms_module_groups');
  show_count('crms_module_users');
  show_count('crms_approval_flows');
  show_count('crms_release_approvals');
  show_count('crms_release_reviews');
  DBMS_OUTPUT.PUT_LINE('===========================================');
  DBMS_OUTPUT.PUT_LINE('Module migration complete.');
  DBMS_OUTPUT.PUT_LINE('===========================================');
END;
/
