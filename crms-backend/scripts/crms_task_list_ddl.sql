-- ============================================================
-- CRMS Task List Table
-- Run as APPS user on ebs_MSWILDEV
-- ============================================================
SET SERVEROUTPUT ON
SET DEFINE OFF

DECLARE v NUMBER;
BEGIN
  SELECT COUNT(*) INTO v FROM user_tables WHERE table_name = 'CRMS_TASK_LIST';
  IF v = 0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_task_list (
        task_list_id     NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        reported_on      VARCHAR2(50),
        requester        VARCHAR2(200),
        cemli            VARCHAR2(200),
        service_now_id   VARCHAR2(200),
        ticket_no        VARCHAR2(200),
        smart_sheet      VARCHAR2(500),
        project          VARCHAR2(200),
        module           VARCHAR2(200),
        process          VARCHAR2(200),
        task_title       VARCHAR2(1000),
        owner            VARCHAR2(200),
        status           VARCHAR2(50)  DEFAULT ''NOT STARTED''
                           CONSTRAINT chk_tl_status CHECK (status IN (
                             ''OPEN'',''HOLD'',''DROP'',''COMPLETE'',''NOT STARTED''
                           )),
        stage            VARCHAR2(100),
        pending_with     VARCHAR2(200),
        cr_task_id       VARCHAR2(200),
        cr_number        VARCHAR2(50),
        auto_populated   NUMBER(1)     DEFAULT 0
                           CONSTRAINT chk_tl_auto CHECK (auto_populated IN (0,1)),
        created_by       NUMBER        NOT NULL
                           CONSTRAINT fk_tl_created_by REFERENCES crms_users(user_id),
        created_at       TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
        updated_at       TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
        is_deleted       NUMBER(1)     DEFAULT 0
                           CONSTRAINT chk_tl_deleted CHECK (is_deleted IN (0,1))
      )';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_tl_created_by  ON crms_task_list(created_by)';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_tl_status      ON crms_task_list(status)';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_tl_cr_number   ON crms_task_list(cr_number)';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_tl_cr_task_id  ON crms_task_list(cr_task_id)';
    DBMS_OUTPUT.PUT_LINE('CREATED: crms_task_list');
  ELSE
    DBMS_OUTPUT.PUT_LINE('EXISTS:  crms_task_list');
  END IF;
END;
/

-- Auto-update trigger
CREATE OR REPLACE TRIGGER trg_task_list_updated_at
  BEFORE UPDATE ON crms_task_list
  FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;
/

COMMIT;
DBMS_OUTPUT.PUT_LINE('Task List DDL complete.');
