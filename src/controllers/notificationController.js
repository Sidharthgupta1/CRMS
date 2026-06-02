'use strict';

const db = require('../config/db');

function num(n) { return String(parseInt(n,10)||0); }

async function getAll(req, res, next) {
  try {
    const uid  = num(req.user.userId);
    const rows = await db.query(
      'SELECT n.notification_id,n.title,n.message,n.is_read,n.created_at,'+
      'n.release_id,r.release_number '+
      'FROM crms_notifications n LEFT JOIN crms_releases r ON r.release_id=n.release_id '+
      'WHERE n.user_id='+uid+' ORDER BY n.created_at DESC FETCH FIRST 50 ROWS ONLY', {}
    );
    return res.json({
      notifications: rows.map(r=>({
        id:r.NOTIFICATION_ID, title:r.TITLE, message:r.MESSAGE,
        isRead:!!r.IS_READ, releaseId:r.RELEASE_ID,
        releaseNumber:r.RELEASE_NUMBER, createdAt:r.CREATED_AT,
      })),
      unreadCount: rows.filter(r=>!r.IS_READ).length,
    });
  } catch(err) { next(err); }
}

async function markRead(req, res, next) {
  try {
    await db.executeWithCommit(
      'UPDATE crms_notifications SET is_read=1 WHERE notification_id='+
      num(req.params.id)+' AND user_id='+num(req.user.userId), {}
    );
    return res.json({ message:'Marked as read' });
  } catch(err) { next(err); }
}

async function markAllRead(req, res, next) {
  try {
    const result = await db.executeWithCommit(
      'UPDATE crms_notifications SET is_read=1 WHERE user_id='+num(req.user.userId)+' AND is_read=0', {}
    );
    return res.json({ message:result.rowsAffected+' notifications marked as read' });
  } catch(err) { next(err); }
}

module.exports = { getAll, markRead, markAllRead };
