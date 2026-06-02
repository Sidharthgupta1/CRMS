'use strict';

const db = require('../config/db');

function num(n)  { return String(parseInt(n,10)||0); }
function safe(s) { return String(s||'').replace(/'/g,"''"); }

async function getAll(req, res, next) {
  try {
    const isAdmin = req.user.role === 'admin';
    const page    = Math.max(1,parseInt(req.query.page,10)||1);
    const limit   = Math.min(200,parseInt(req.query.pageSize,10)||50);
    const offset  = (page-1)*limit;

    const w = [];
    if (!isAdmin) w.push('a.performed_by='+num(req.user.userId));
    else if (req.query.userId) w.push('a.performed_by='+num(req.query.userId));
    if (req.query.action)   w.push("a.action='"+safe(req.query.action)+"'");
    if (req.query.crNumber) w.push("a.cr_number='"+safe(req.query.crNumber)+"'");
    if (req.query.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(req.query.fromDate))
      w.push("a.created_at>=TO_DATE('"+req.query.fromDate+"','YYYY-MM-DD')");
    if (req.query.toDate && /^\d{4}-\d{2}-\d{2}$/.test(req.query.toDate))
      w.push("a.created_at<TO_DATE('"+req.query.toDate+"','YYYY-MM-DD')+1");

    const WHERE = w.length ? 'WHERE '+w.join(' AND ') : '';
    const countRow = await db.queryOne('SELECT COUNT(*) AS total FROM crms_audit a '+WHERE, {});
    const total    = Number(countRow.TOTAL);

    const rows = await db.query(
      'SELECT a.audit_id,a.action,a.cr_number,a.details,a.created_at,u.full_name AS performed_by '+
      'FROM crms_audit a JOIN crms_users u ON u.user_id=a.performed_by '+
      WHERE+' ORDER BY a.created_at DESC '+
      'OFFSET '+offset+' ROWS FETCH NEXT '+limit+' ROWS ONLY', {}
    );

    return res.json({
      data: rows.map(r=>({ auditId:r.AUDIT_ID, action:r.ACTION, performedBy:r.PERFORMED_BY, crNumber:r.CR_NUMBER, details:r.DETAILS, createdAt:r.CREATED_AT })),
      pagination:{ page, pageSize:limit, total, totalPages:Math.ceil(total/limit) },
    });
  } catch(err) { next(err); }
}

module.exports = { getAll };
