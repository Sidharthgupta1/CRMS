'use strict';

const router     = require('express').Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const adminCtrl  = require('../controllers/adminController');

// ── Auth (public) ─────────────────────────────────────────────────────
router.use('/auth', require('./auth'));

// ── All routes below require valid JWT ───────────────────────────────
router.use(verifyToken);

// ── Reference data — readable by ALL logged-in users ─────────────────
// These were previously admin-only, causing company/service dropdowns
// to be empty for non-admin users
router.get('/ref/groups',    adminCtrl.getGroups);
router.get('/ref/companies', adminCtrl.getCompanies);
router.get('/ref/services',  adminCtrl.getServices);
router.get('/ref/users',     adminCtrl.getUsers);
router.get('/ref/company-mapping', require('../controllers/adminController').getCompanyMappingRef);
router.get('/ref/company-services',  require('../controllers/adminController').getCompanyServicesRef);
router.get('/ref/modules',   require('../controllers/moduleController').getModulesRef);

// ── Core resources ────────────────────────────────────────────────────
router.use('/releases',      require('./releases'));
router.use('/task-list',     require('./taskList'));
router.use('/tasks',         require('./tasks'));
router.use('/notifications', require('./notifications'));
router.use('/audit',         require('./audit'));
router.use('/analytics',     require('./analytics'));

// ── Modules & Approvals ───────────────────────────────────────────────
router.use('/modules',   require('./modules'));
router.use('/approvals', require('./approvals'));

// ── Admin-only write operations ───────────────────────────────────────
router.use('/admin', requireAdmin, require('./admin'));

// ── ServiceNow admin endpoints (requireAdmin) ────────────────────────
router.use('/admin/servicenow', requireAdmin, require('./servicenow'));

module.exports = router;
