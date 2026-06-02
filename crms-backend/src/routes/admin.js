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

module.exports = router;
