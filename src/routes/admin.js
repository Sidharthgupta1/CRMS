'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/adminController');

// ── Users ─────────────────────────────────────────────────────────────
router.get  ('/users',                          ctrl.getUsers);
router.post ('/users',  ctrl.createUserValidation, ctrl.createUser);
router.patch('/users/:userId/toggle',           ctrl.toggleUser);
router.patch('/users/:userId/password',         ctrl.changePassword);

// ── Assignment Groups ─────────────────────────────────────────────────
router.get  ('/groups',                             ctrl.getGroups);
router.post ('/groups',  ctrl.createGroupValidation, ctrl.createGroup);
router.put  ('/groups/:groupId/members',            ctrl.updateGroupMembers);

// ── Companies ─────────────────────────────────────────────────────────
router.get  ('/companies',  ctrl.getCompanies);
router.post ('/companies',  ctrl.createCompany);

// ── Services ──────────────────────────────────────────────────────────
router.get  ('/services',   ctrl.getServices);
router.post ('/services',   ctrl.createService);

// ── Company Mapping ───────────────────────────────────────────────────
router.get  ('/company-mapping',                     ctrl.getCompanyMapping);
router.post ('/company-mapping/service',             ctrl.addCompanyServiceMap);
router.delete('/company-mapping/service/:mapId',     ctrl.removeCompanyServiceMap);
router.post ('/company-mapping/phase-group',         ctrl.addCompanyPhaseGroup);
router.delete('/company-mapping/phase-group/:mapId', ctrl.removeCompanyPhaseGroup);

// ── RD Approval Group mappings ───────────────────────────────────────
router.get   ('/approval-groups',     ctrl.getApprovalGroupMappings);
router.post  ('/approval-groups',     ctrl.createApprovalGroupMapping);
router.delete('/approval-groups/:id', ctrl.deleteApprovalGroupMapping);

module.exports = router;
