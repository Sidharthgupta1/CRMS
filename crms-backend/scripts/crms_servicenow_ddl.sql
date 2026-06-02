-- ============================================================
-- CRMS ServiceNow Integration — DDL
-- Run as APPS user on ebs_MSWILDEV
-- ============================================================
SET SERVEROUTPUT ON
SET DEFINE OFF

-- Add ServiceNow tracking columns to crms_releases
DECLARE v NUMBER;
BEGIN
  SELECT COUNT(*) INTO v FROM user_tab_columns
  WHERE table_name='CRMS_RELEASES' AND column_name='SNOW_SYS_ID';
  IF v=0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE crms_releases ADD snow_sys_id VARCHAR2(40)';
    EXECUTE IMMEDIATE 'ALTER TABLE crms_releases ADD snow_change_number VARCHAR2(20)';
    EXECUTE IMMEDIATE 'ALTER TABLE crms_releases ADD snow_last_sync TIMESTAMP';
    EXECUTE IMMEDIATE 'CREATE INDEX idx_rel_snow_sysid ON crms_releases(snow_sys_id)';
    DBMS_OUTPUT.PUT_LINE('CREATED: snow_sys_id, snow_change_number, snow_last_sync columns');
  ELSE
    DBMS_OUTPUT.PUT_LINE('EXISTS:  snow columns already present');
  END IF;
END;
/

-- Add ServiceNow audit actions to crms_audit (no DDL needed — action is VARCHAR2(50))
-- Just verify the column is wide enough
DECLARE v NUMBER;
BEGIN
  SELECT data_length INTO v FROM user_tab_columns
  WHERE table_name='CRMS_AUDIT' AND column_name='ACTION';
  IF v < 50 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE crms_audit MODIFY action VARCHAR2(50)';
    DBMS_OUTPUT.PUT_LINE('WIDENED: crms_audit.action to VARCHAR2(50)');
  ELSE
    DBMS_OUTPUT.PUT_LINE('OK: crms_audit.action is '||v||' chars');
  END IF;
END;
/

COMMIT;
DBMS_OUTPUT.PUT_LINE('ServiceNow DDL complete.');
