'use strict';
const router      = require('express').Router();
const ctrl        = require('../controllers/releaseController');
const cmtCtrl     = require('../controllers/commentController');
const tskCtrl     = require('../controllers/taskController');
const approvalCtrl= require('../controllers/approvalController');
const attCtrl     = require('../controllers/attachmentController');
const { requireAdmin } = require('../middleware/auth');

// ── Static routes MUST come before /:releaseId param routes ──────────
router.get('/next-number',          ctrl.nextNumber);
router.get('/my-phase-tasks',       ctrl.myPhaseTasks);  // ← BEFORE /:releaseId

// ── Collection routes ─────────────────────────────────────────────────
router.get   ('/',                                              ctrl.getAll);
router.post  ('/',                                              ctrl.createValidation, ctrl.create);

// ── Param routes (:releaseId) ─────────────────────────────────────────
router.get   ('/:releaseId/full-history',                        ctrl.fullHistory);
router.get   ('/:releaseId',                                    ctrl.getOne);
router.patch ('/:releaseId/advance',                            ctrl.advanceState);
router.patch ('/:releaseId/reassign',                           ctrl.reassign);
router.delete('/:releaseId',                                    requireAdmin, ctrl.remove);

// Approvals
router.post  ('/:releaseId/approve',                            approvalCtrl.approve);
router.post  ('/:releaseId/reject',                             approvalCtrl.reject);
router.get   ('/:releaseId/approval-status',                    approvalCtrl.getApprovalStatus);

// Phase sub-tasks
router.get   ('/:releaseId/phase-tasks',                        ctrl.getPhaseTasks);
router.post  ('/:releaseId/phase-tasks',                        ctrl.createPhaseTask);
router.patch ('/:releaseId/phase-tasks/:taskId',                ctrl.updatePhaseTask);
router.patch ('/:releaseId/phase-tasks/:taskId/close',          ctrl.closePhaseTask);
router.post  ('/:releaseId/phase-tasks/:taskId/upload',         ctrl.uploadTaskDocument);
router.patch ('/:releaseId/phase-tasks/:taskId/download',       ctrl.markTemplateDownloaded);

// Attachments
router.get   ('/:releaseId/attachments',                        attCtrl.getByRelease);
router.post  ('/:releaseId/attachments',                        attCtrl.upload);
router.get   ('/:releaseId/attachments/:attId/download',        attCtrl.download);
router.delete('/:releaseId/attachments/:attId',                 attCtrl.remove);

router.post  ('/:releaseId/notify-reviewer',                ctrl.notifyReviewer);

// Reviewer queue
router.get   ('/reviews/my',                                   ctrl.myReviews);
router.get   ('/reviews/is-reviewer',                          ctrl.isReviewer);
router.post  ('/reviews/:reviewId/pass',                       ctrl.passReview);
router.post  ('/reviews/:reviewId/complete',                   ctrl.completeReview);

// RD Export
router.get   ('/:releaseId/rd-export',                               ctrl.rdExport);

// Comments & legacy tasks
router.get   ('/:releaseId/tasks',                              tskCtrl.getByRelease);
router.post  ('/:releaseId/tasks',                              tskCtrl.createValidation, tskCtrl.create);
router.get   ('/:releaseId/comments',                           cmtCtrl.getByRelease);
router.post  ('/:releaseId/comments',                           cmtCtrl.createValidation, cmtCtrl.create);

module.exports = router;
