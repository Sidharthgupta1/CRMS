'use strict';

const db = require('../config/db');

async function getMappedReviewer(moduleId, phaseCode, reviewerUserId) {
  return db.queryOne(
    `SELECT pr.user_id, u.full_name, pr.group_id, ag.group_name
       FROM crms_phase_reviewers pr
       JOIN crms_users u ON u.user_id = pr.user_id
       JOIN crms_assignment_groups ag ON ag.group_id = pr.group_id
      WHERE pr.module_id = :moduleId
        AND pr.phase_code = :phaseCode
        AND pr.user_id = :reviewerUserId`,
    { moduleId, phaseCode, reviewerUserId }
  );
}

async function getMappedReviewers(moduleId, phaseCode) {
  const rows = await db.query(
    `SELECT DISTINCT pr.user_id, u.full_name, pr.group_id, ag.group_name
       FROM crms_phase_reviewers pr
       JOIN crms_users u ON u.user_id = pr.user_id
       JOIN crms_assignment_groups ag ON ag.group_id = pr.group_id
      WHERE pr.module_id = :moduleId
        AND pr.phase_code = :phaseCode
      ORDER BY u.full_name`,
    { moduleId, phaseCode }
  );
  return rows.map(r => ({
    userId: r.USER_ID,
    fullName: r.FULL_NAME,
    groupId: r.GROUP_ID,
    groupName: r.GROUP_NAME,
  }));
}

async function listMyReviews(req, res, next) {
  try {
    const uid = req.user.userId;
    const rows = await db.query(
      `SELECT rr.review_id, rr.release_id, rr.module_id, rr.phase_code, rr.created_at,
              rr.created_by_user_id, rr.parent_review_id,
              r.release_number, r.title, r.state, r.priority, r.planned_start_date,
              rq.user_id AS requested_by_user_id, rq.full_name AS requested_by,
              cb.full_name AS created_by_name,
              m.module_name
         FROM crms_release_reviews rr
         JOIN crms_releases r ON r.release_id = rr.release_id AND r.is_deleted = 0
         LEFT JOIN crms_modules m ON m.module_id = rr.module_id
         LEFT JOIN crms_users rq ON rq.user_id = r.requested_by
         LEFT JOIN crms_users cb ON cb.user_id = rr.created_by_user_id
        WHERE rr.reviewer_user_id = :uid
          AND rr.status = 'Pending'
        ORDER BY rr.created_at DESC`,
      { uid }
    );

    const data = [];
    for (const row of rows) {
      const availableReviewers = await getMappedReviewers(row.MODULE_ID, row.PHASE_CODE);
      data.push({
        reviewId: row.REVIEW_ID,
        releaseId: row.RELEASE_ID,
        releaseNumber: row.RELEASE_NUMBER,
        title: row.TITLE,
        state: row.STATE,
        priority: row.PRIORITY,
        phaseCode: row.PHASE_CODE,
        moduleId: row.MODULE_ID,
        moduleName: row.MODULE_NAME || '—',
        plannedStartDate: row.PLANNED_START_DATE,
        requestedBy: row.REQUESTED_BY || '—',
        requestedByUserId: row.REQUESTED_BY_USER_ID || null,
        createdByName: row.CREATED_BY_NAME || '—',
        parentReviewId: row.PARENT_REVIEW_ID || null,
        createdAt: row.CREATED_AT,
        availableReviewers,
      });
    }

    return res.json(data);
  } catch (err) { next(err); }
}

async function isReviewer(req, res, next) {
  try {
    const uid = req.user.userId;
    const mapped = await db.queryOne(
      `SELECT COUNT(*) AS cnt
         FROM crms_phase_reviewers
        WHERE user_id = :uid`,
      { uid }
    );
    const pending = await db.queryOne(
      `SELECT COUNT(*) AS cnt
         FROM crms_release_reviews
        WHERE reviewer_user_id = :uid
          AND status = 'Pending'`,
      { uid }
    );
    return res.json({
      isReviewer: Number((mapped && mapped.CNT) || 0) > 0 || Number((pending && pending.CNT) || 0) > 0,
      pendingCount: Number((pending && pending.CNT) || 0),
    });
  } catch (err) { next(err); }
}

async function referReview(req, res, next) {
  try {
    const reviewId = parseInt(req.params.reviewId, 10) || 0;
    const uid = req.user.userId;
    const reviewerUserId = parseInt((req.body || {}).reviewerUserId, 10) || 0;
    if (!reviewerUserId) return res.status(422).json({ error: 'reviewerUserId required' });

    const review = await db.queryOne(
      `SELECT rr.review_id, rr.release_id, rr.module_id, rr.phase_code, rr.reviewer_user_id,
              r.release_number
         FROM crms_release_reviews rr
         JOIN crms_releases r ON r.release_id = rr.release_id
        WHERE rr.review_id = :reviewId
          AND rr.status = 'Pending'`,
      { reviewId }
    );
    if (!review) return res.status(404).json({ error: 'Pending review not found' });
    if (String(review.REVIEWER_USER_ID) !== String(uid) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the assigned reviewer can refer this item' });
    }
    if (String(review.REVIEWER_USER_ID) === String(reviewerUserId)) {
      return res.status(422).json({ error: 'Select a different reviewer' });
    }

    const mappedReviewer = await getMappedReviewer(review.MODULE_ID, review.PHASE_CODE, reviewerUserId);
    if (!mappedReviewer) {
      return res.status(422).json({ error: 'Selected reviewer is not mapped for this phase' });
    }

    await db.transaction(async function(conn) {
      await conn.execute(
        `UPDATE crms_release_reviews
            SET status = 'Referred',
                actioned_at = SYSTIMESTAMP
          WHERE review_id = :reviewId`,
        { reviewId }
      );
      await conn.execute(
        `INSERT INTO crms_release_reviews(
            release_id, module_id, phase_code, reviewer_user_id,
            created_by_user_id, parent_review_id, status
         ) VALUES(
            :releaseId, :moduleId, :phaseCode, :reviewerUserId,
            :createdByUserId, :parentReviewId, 'Pending'
         )`,
        {
          releaseId: review.RELEASE_ID,
          moduleId: review.MODULE_ID,
          phaseCode: review.PHASE_CODE,
          reviewerUserId,
          createdByUserId: uid,
          parentReviewId: review.REVIEW_ID,
        }
      );
      await conn.execute(
        `INSERT INTO crms_notifications(user_id, title, message, release_id)
         VALUES(:userId, :title, :message, :releaseId)`,
        {
          userId: reviewerUserId,
          title: 'Review Referred — ' + review.PHASE_CODE + ' Phase',
          message: review.RELEASE_NUMBER + ' has been referred to you for review (' + review.PHASE_CODE + ' phase).',
          releaseId: review.RELEASE_ID,
        }
      );
      await conn.execute(
        `INSERT INTO crms_audit(action, performed_by, cr_number, details)
         VALUES('Review Referred', :uid, :releaseNumber, :details)`,
        {
          uid,
          releaseNumber: review.RELEASE_NUMBER,
          details: 'Referred ' + review.PHASE_CODE + ' review to ' + mappedReviewer.FULL_NAME,
        }
      );
    });

    return res.json({ message: 'Referred to ' + mappedReviewer.FULL_NAME });
  } catch (err) { next(err); }
}

module.exports = {
  listMyReviews,
  isReviewer,
  referReview,
  getMappedReviewer,
};
