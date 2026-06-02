'use strict';

const db = require('../config/db');

function num(n) { return String(parseInt(n,10)||0); }
function safe(s) { return String(s||'').replace(/'/g,"''"); }

async function getSummary(req, res, next) {
  try {
    const w = ['r.is_deleted=0'];
    if (req.query.assignmentGroupId) w.push('r.assignment_group_id='+num(req.query.assignmentGroupId));
    if (req.query.userId)            w.push('r.requested_by='+num(req.query.userId));
    if (req.query.priority)          w.push("r.priority='"+safe(req.query.priority)+"'");
    const WHERE = 'WHERE '+w.join(' AND ');

    const [summary, byState, byPriority, byGroup, byUser, taskCount] = await Promise.all([
      db.queryOne(
        "SELECT COUNT(*) AS total,"+
        "COUNT(CASE WHEN r.state NOT IN('Closed','Cancelled') THEN 1 END) AS open_count,"+
        "COUNT(CASE WHEN r.state='Closed' THEN 1 END) AS closed_count,"+
        "COUNT(CASE WHEN r.state='Cancelled' THEN 1 END) AS cancelled_count,"+
        "COUNT(CASE WHEN r.priority='1' THEN 1 END) AS critical_count "+
        "FROM crms_releases r "+WHERE, {}
      ),
      db.query(
        "SELECT r.state,COUNT(*) AS cnt FROM crms_releases r "+WHERE+
        " GROUP BY r.state ORDER BY MIN(CASE r.state "+
        "WHEN 'Draft' THEN 1 WHEN 'BRD Phase' THEN 2 WHEN 'FSD Phase' THEN 3 "+
        "WHEN 'Awaiting approval' THEN 4 WHEN 'On Hold' THEN 5 "+
        "WHEN 'Development Phase' THEN 6 WHEN 'Testing/QA' THEN 7 "+
        "WHEN 'UAT' THEN 8 WHEN 'Deployment' THEN 9 WHEN 'Closed' THEN 10 ELSE 11 END)", {}
      ),
      db.query(
        "SELECT r.priority,"+
        "CASE r.priority WHEN '1' THEN '1 - Critical' WHEN '2' THEN '2 - High' "+
        "WHEN '3' THEN '3 - Moderate' WHEN '4' THEN '4 - Low' END AS lbl,"+
        "COUNT(*) AS cnt FROM crms_releases r "+WHERE+" GROUP BY r.priority ORDER BY r.priority", {}
      ),
      db.query(
        "SELECT NVL(ag.group_name,'(Unassigned)') AS grp,COUNT(*) AS cnt "+
        "FROM crms_releases r LEFT JOIN crms_assignment_groups ag ON ag.group_id=r.assignment_group_id "+
        WHERE+" GROUP BY ag.group_name ORDER BY cnt DESC", {}
      ),
      db.query(
        "SELECT u.full_name AS uname,COUNT(*) AS cnt "+
        "FROM crms_releases r JOIN crms_users u ON u.user_id=r.requested_by "+
        WHERE+" GROUP BY u.full_name ORDER BY cnt DESC", {}
      ),
      db.queryOne(
        "SELECT COUNT(*) AS total FROM crms_tasks t JOIN crms_releases r ON r.release_id=t.release_id "+WHERE, {}
      ),
    ]);

    return res.json({
      summary:{ total:Number(summary.TOTAL), open:Number(summary.OPEN_COUNT), closed:Number(summary.CLOSED_COUNT), cancelled:Number(summary.CANCELLED_COUNT), critical:Number(summary.CRITICAL_COUNT), tasks:Number(taskCount.TOTAL) },
      byState:    byState.map(r=>({ state:r.STATE, count:Number(r.CNT) })),
      byPriority: byPriority.map(r=>({ priority:r.PRIORITY, label:r.LBL, count:Number(r.CNT) })),
      byGroup:    byGroup.map(r=>({ group:r.GRP, count:Number(r.CNT) })),
      byUser:     byUser.map(r=>({ user:r.UNAME, count:Number(r.CNT) })),
    });
  } catch(err) { next(err); }
}

module.exports = { getSummary };
