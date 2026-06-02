'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/servicenowController');

// Admin routes (all protected by requireAdmin in index.js)
router.get ('/status',     ctrl.getStatus);
router.get ('/config',     ctrl.getConfig);
router.post('/test-push',  ctrl.testPush);
router.get ('/state-map',  ctrl.getStateMap);
router.get ('/sync-log',   ctrl.getSyncLog);

module.exports = router;
