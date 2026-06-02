'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/approvalController');

// Approvals menu — for users who are approvers
router.get ('/pending',     ctrl.getPendingApprovals);
router.get ('/is-approver', ctrl.isApprover);

module.exports = router;
