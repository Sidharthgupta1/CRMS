'use strict';

const db     = require('../config/db');
const logger = require('../config/logger');

function safe(s) { return String(s||'').replace(/'/g,"''"); }
function num(n)  { return String(parseInt(n,10)||0); }

// ── GET /releases/:releaseId/attachments ──────────────────────────────
async function getByRelease(req, res, next) {
  try {
    const rid  = num(req.params.releaseId);
    const rows = await db.query(
      'SELECT a.attachment_id,a.file_name,a.file_type,a.file_size,a.created_at,'+
      'u.full_name AS uploaded_by '+
      'FROM crms_attachments a JOIN crms_users u ON u.user_id=a.uploaded_by '+
      'WHERE a.release_id='+rid+' ORDER BY a.created_at ASC', {}
    );
    return res.json(rows.map(r => ({
      attachmentId: r.ATTACHMENT_ID,
      fileName:     r.FILE_NAME,
      fileType:     r.FILE_TYPE,
      fileSize:     r.FILE_SIZE,
      uploadedBy:   r.UPLOADED_BY,
      createdAt:    r.CREATED_AT,
    })));
  } catch(err) { next(err); }
}

// ── GET /releases/:releaseId/attachments/:attId/download ──────────────
async function download(req, res, next) {
  try {
    const rid = num(req.params.releaseId);
    const aid = num(req.params.attId);
    const row = await db.queryOne(
      'SELECT file_name,file_type,file_data FROM crms_attachments '+
      'WHERE attachment_id='+aid+' AND release_id='+rid, {}
    );
    if (!row) return res.status(404).json({ error:'Attachment not found' });
    return res.json({ fileName:row.FILE_NAME, fileType:row.FILE_TYPE, fileData:row.FILE_DATA });
  } catch(err) { next(err); }
}

// ── POST /releases/:releaseId/attachments ─────────────────────────────
async function upload(req, res, next) {
  try {
    const rid  = num(req.params.releaseId);
    const uid  = num(req.user.userId);
    const { fileName, fileType, fileSize, fileData } = req.body;

    if (!fileName || !fileData)
      return res.status(422).json({ error:'fileName and fileData are required' });

    const rel = await db.queryOne(
      'SELECT release_id,release_number,requested_by,assigned_to_user_id,state '+
      'FROM crms_releases WHERE release_id='+rid+' AND is_deleted=0', {}
    );
    if (!rel) return res.status(404).json({ error:'Release not found' });

    const isAdmin    = req.user.role === 'admin';
    const isCreator  = String(rel.REQUESTED_BY)        === String(req.user.userId);
    const isAssigned = String(rel.ASSIGNED_TO_USER_ID) === String(req.user.userId);
    if (!isAdmin && !isCreator && !isAssigned)
      return res.status(403).json({ error:'Only the release creator or assigned person can upload attachments' });

    // Insert attachment — use executeWithCommit (CLOB handled as long string)
    const fsVal = fileSize ? num(String(Math.floor(fileSize))) : 'NULL';
    await db.executeWithCommit(
      "INSERT INTO crms_attachments(release_id,file_name,file_type,file_size,file_data,uploaded_by) "+
      "VALUES("+rid+",'"+safe(fileName)+"','"+safe(fileType||'')+"',"+fsVal+","+
      "TO_CLOB('"+safe(fileData.substring(0,4000))+"'),"+uid+")", {}
    );

    // For large files (>4000 chars base64), update with full data
    if (fileData.length > 4000) {
      // Get the attachment_id just inserted
      const newAtt = await db.queryOne(
        "SELECT attachment_id FROM crms_attachments WHERE release_id="+rid+
        " AND uploaded_by="+uid+" ORDER BY created_at DESC FETCH FIRST 1 ROWS ONLY", {}
      );
      if (newAtt) {
        // Update CLOB in chunks using concatenation
        const aid = num(newAtt.ATTACHMENT_ID);
        const chunkSize = 4000;
        let offset = 4000;
        while (offset < fileData.length) {
          const chunk = fileData.substring(offset, offset + chunkSize);
          await db.executeWithCommit(
            "UPDATE crms_attachments SET file_data = file_data || TO_CLOB('"+safe(chunk)+"') "+
            "WHERE attachment_id="+aid, {}
          );
          offset += chunkSize;
        }
      }
    }

    await db.executeWithCommit(
      "INSERT INTO crms_audit(action,performed_by,cr_number,details) VALUES("+
      "'Attachment',"+uid+",'"+rel.RELEASE_NUMBER+"','Uploaded: "+safe(fileName)+"')", {}
    );

    logger.info('Attachment uploaded', { releaseId:rid, fileName, uid });
    return res.status(201).json({ fileName, message:'File uploaded successfully' });
  } catch(err) { next(err); }
}

// ── DELETE /releases/:releaseId/attachments/:attId ────────────────────
async function remove(req, res, next) {
  try {
    const rid = num(req.params.releaseId);
    const aid = num(req.params.attId);
    const att = await db.queryOne(
      'SELECT attachment_id,uploaded_by FROM crms_attachments WHERE attachment_id='+aid+' AND release_id='+rid, {}
    );
    if (!att) return res.status(404).json({ error:'Attachment not found' });

    const isAdmin    = req.user.role === 'admin';
    const isUploader = String(att.UPLOADED_BY) === String(req.user.userId);
    if (!isAdmin && !isUploader)
      return res.status(403).json({ error:'Only the uploader or admin can delete this attachment' });

    await db.executeWithCommit('DELETE FROM crms_attachments WHERE attachment_id='+aid, {});
    return res.json({ message:'Attachment deleted' });
  } catch(err) { next(err); }
}

module.exports = { getByRelease, upload, download, remove };
