-- ============================================================
-- CRMS Task List V2 — DDL
-- Run as APPS user on ebs_MSWILDEV after backing up existing data
-- ============================================================
SET SERVEROUTPUT ON
SET DEFINE OFF

-- Step 1: Add new columns to crms_task_list (safe if table already exists)
BEGIN
  FOR col IN (
    SELECT column_name, data_type FROM (
      SELECT 'delay_reason'      AS cn, 'VARCHAR2(1000)' AS dt FROM dual UNION ALL
      SELECT 'comments',              'VARCHAR2(2000)'          FROM dual UNION ALL
      SELECT 'tracker_comments',      'VARCHAR2(2000)'          FROM dual UNION ALL
      SELECT 'rd_approval_dt',        'VARCHAR2(50)'            FROM dual UNION ALL
      SELECT 'md50_st',               'VARCHAR2(50)'            FROM dual UNION ALL
      SELECT 'md50_end',              'VARCHAR2(50)'            FROM dual UNION ALL
      SELECT 'md50_app_by',           'VARCHAR2(200)'           FROM dual UNION ALL
      SELECT 'md50_app_on',           'VARCHAR2(50)'            FROM dual UNION ALL
      SELECT 'dev_st',                'VARCHAR2(50)'            FROM dual UNION ALL
      SELECT 'dev_end',               'VARCHAR2(50)'            FROM dual UNION ALL
      SELECT 'tft_st',                'VARCHAR2(50)'            FROM dual UNION ALL
      SELECT 'tft_end',               'VARCHAR2(50)'            FROM dual UNION ALL
      SELECT 'uat_closed_on',         'VARCHAR2(50)'            FROM dual UNION ALL
      SELECT 'approved1_on',          'VARCHAR2(50)'            FROM dual UNION ALL
      SELECT 'approved2_on',          'VARCHAR2(50)'            FROM dual UNION ALL
      SELECT 'approved3_on',          'VARCHAR2(50)'            FROM dual UNION ALL
      SELECT 'deployed_samil',        'VARCHAR2(50)'            FROM dual UNION ALL
      SELECT 'deployed_mswil',        'VARCHAR2(50)'            FROM dual
    ) cols
  ) LOOP
    DECLARE v NUMBER;
    BEGIN
      SELECT COUNT(*) INTO v FROM user_tab_columns
      WHERE table_name='CRMS_TASK_LIST' AND column_name=UPPER(col.cn);
      IF v=0 THEN
        EXECUTE IMMEDIATE 'ALTER TABLE crms_task_list ADD '||col.cn||' '||col.dt;
        DBMS_OUTPUT.PUT_LINE('ADDED: '||col.cn);
      ELSE
        DBMS_OUTPUT.PUT_LINE('EXISTS: '||col.cn);
      END IF;
    END;
  END LOOP;
END;
/

-- Step 2: Create task list editors mapping table
DECLARE v NUMBER;
BEGIN
  SELECT COUNT(*) INTO v FROM user_tables WHERE table_name='CRMS_TASK_LIST_EDITORS';
  IF v=0 THEN
    EXECUTE IMMEDIATE '
      CREATE TABLE crms_task_list_editors (
        editor_id  NUMBER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id    NUMBER         NOT NULL
                     CONSTRAINT fk_tl_editor_user REFERENCES crms_users(user_id) ON DELETE CASCADE,
        added_by   NUMBER         NOT NULL
                     CONSTRAINT fk_tl_editor_addedby REFERENCES crms_users(user_id),
        added_at   TIMESTAMP      DEFAULT SYSTIMESTAMP NOT NULL,
        CONSTRAINT uq_tl_editor UNIQUE (user_id)
      )';
    DBMS_OUTPUT.PUT_LINE('CREATED: crms_task_list_editors');
  ELSE
    DBMS_OUTPUT.PUT_LINE('EXISTS:  crms_task_list_editors');
  END IF;
END;
/

COMMIT;
DBMS_OUTPUT.PUT_LINE('Task List V2 DDL complete.');
