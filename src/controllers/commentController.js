'use strict';

const { body } = require('express-validator');
const db       = require('../config/db');
const { validate } = require('../middleware/validate');

function safe(s) { return String(s||'').replace(/'/g,"''"); }
function num(n)  { return String(parseInt(n,10)||0); }

async function getByRelease(req, res, next) {
  try {
    const rid  = num(req.params.releaseId);
    const rows = await db.query(
      'SELECT c.comment_id,c.comment_text,c.created_at,u.full_name AS author '+
      'FROM crms_comments c JOIN crms_users u ON u.user_id=c.created_by '+
      'WHERE c.release_id='+rid+' ORDER BY c.created_at ASC', {}
    );
    return res.json(rows.map(r=>({ commentId:r.COMMENT_ID, text:r.COMMENT_TEXT, author:r.AUTHOR, createdAt:r.CREATED_AT })));
  } catch(err) { next(err); }
}

const createValidation = [
  body('text').trim().notEmpty().withMessage('Comment text required'),
  validate,
];

async function create(req, res, next) {
  try {
    const rid  = num(req.params.releaseId);
    const uid  = num(req.user.userId);
    const text = req.body.text||'';

    const rel = await db.queryOne(
      'SELECT release_number FROM crms_releases WHERE release_id='+rid+' AND is_deleted=0', {}
    );
    if (!rel) return res.status(404).json({ error:'Release not found' });

    await db.executeWithCommit(
      "INSERT INTO crms_comments(release_id,comment_text,created_by) VALUES("+rid+",'"+safe(text)+"',"+uid+")", {}
    );
    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES("+
      "'Comment',"+uid+",'"+rel.RELEASE_NUMBER+"','"+safe(req.user.fullName+' commented: "'+text.substring(0,50)+'"')+"')", {}
    );
    return res.status(201).json({ message:'Comment posted' });
  } catch(err) { next(err); }
}

module.exports = { getByRelease, create, createValidation };
