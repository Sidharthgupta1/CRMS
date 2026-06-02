-- ============================================================
-- CRMS PASSWORD FIX -- Run in SQL Developer as APPS user
-- This corrects the bcrypt hashes so login works with Node.js
-- ============================================================

SET SERVEROUTPUT ON
SET DEFINE OFF

BEGIN
  -- Update Sandeep Gupta (admin) password: admin123
  UPDATE crms_users
     SET password_hash = '$2b$12$0/3JONBRotJOS5tlxHkYbuPgFP3SqJPsPtKZN9kskdnIv2Y6ITJ5K'
   WHERE initials = 'SG';

  -- Update Rohit Kumar (user) password: pass123
  UPDATE crms_users
     SET password_hash = '$2b$12$GNG5ruA5kI58qTE1teAjS.a5Aksd5/RarlvLxIR9TNDl4QIrJZ666'
   WHERE initials = 'RK';

  -- Update Priya Mehta (user) password: pass123
  UPDATE crms_users
     SET password_hash = '$2b$12$GNG5ruA5kI58qTE1teAjS.a5Aksd5/RarlvLxIR9TNDl4QIrJZ666'
   WHERE initials = 'PM';

  -- Update Amit Verma (user) password: pass123
  UPDATE crms_users
     SET password_hash = '$2b$12$GNG5ruA5kI58qTE1teAjS.a5Aksd5/RarlvLxIR9TNDl4QIrJZ666'
   WHERE initials = 'AV';

  COMMIT;

  DBMS_OUTPUT.PUT_LINE('Password hashes updated for 4 users.');
  DBMS_OUTPUT.PUT_LINE('');
  DBMS_OUTPUT.PUT_LINE('Login credentials:');
  DBMS_OUTPUT.PUT_LINE('  SG / admin123  (Admin)');
  DBMS_OUTPUT.PUT_LINE('  RK / pass123   (User)');
  DBMS_OUTPUT.PUT_LINE('  PM / pass123   (User)');
  DBMS_OUTPUT.PUT_LINE('  AV / pass123   (User)');

EXCEPTION WHEN OTHERS THEN
  ROLLBACK;
  DBMS_OUTPUT.PUT_LINE('ERROR: ' || SQLERRM);
END;
/

-- Verify
SELECT initials, full_name, role,
       SUBSTR(password_hash, 1, 7) AS hash_prefix,
       is_active
  FROM crms_users
 ORDER BY initials;
