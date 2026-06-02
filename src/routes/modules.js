'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/moduleController');
const { requireAdmin } = require('../middleware/auth');

router.get ('/',                                           ctrl.getAll);
router.post('/',                           requireAdmin,  ctrl.create);

// Phase group assignment
router.put ('/:moduleId/phase-group',      requireAdmin,  ctrl.setPhaseGroup);
router.put ('/:moduleId/phase-groups',     requireAdmin,  ctrl.setPhaseGroupMulti); // multi-group
router.put ('/:moduleId/groups',           requireAdmin,  ctrl.updateGroups);   // legacy

// Users (legacy no-op)
router.put ('/:moduleId/users',            requireAdmin,  ctrl.updateUsers);

// Approval flows
router.put ('/:moduleId/flow',             requireAdmin,  ctrl.updateFlow);      // legacy { rdLevels, fsdLevels }
router.put ('/:moduleId/approval-flow',    requireAdmin,  ctrl.setApprovalFlow); // new { phaseCode, levels }

// Reviewers & Process Owners
router.put ('/:moduleId/phase-reviewers',      requireAdmin, ctrl.setPhaseReviewers);
router.put ('/:moduleId/phase-process-owner',  requireAdmin, ctrl.setPhaseProcessOwner);

// Templates (RD phase)
router.post('/:moduleId/templates/:phaseCode', requireAdmin, ctrl.uploadTemplate);
router.get ('/:moduleId/templates/:phaseCode/download',   ctrl.downloadTemplate);

module.exports = router;
