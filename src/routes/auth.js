'use strict';
const router  = require('express').Router();
const ctrl    = require('../controllers/authController');
const ssoCtrl = require('../controllers/ssoController');
const { verifyToken, requireAdmin } = require('../middleware/auth');

router.post('/login',             ctrl.loginValidation, ctrl.login);
router.post('/refresh',           ctrl.refresh);
router.post('/logout',            verifyToken, ctrl.logout);
router.get ('/me',                verifyToken, ctrl.me);
router.get ('/users',             ctrl.listUsers);

// FND Sync — Admin only
router.get ('/fnd-sync-status',   verifyToken, requireAdmin, ctrl.fndSyncStatus);
router.post('/fnd-sync-all',      verifyToken, requireAdmin, ctrl.fndSyncAll);
router.post('/fnd-provision-one',  verifyToken, requireAdmin, ctrl.fndProvisionOne);
router.patch('/crms-user/:userId',verifyToken, requireAdmin, ctrl.updateCrmsUser);

// SSO
router.post('/fnd-token',         ssoCtrl.createFndToken);
router.get ('/fnd-sso',           ssoCtrl.fndSso);
router.get ('/fnd-users',         verifyToken, ssoCtrl.listFndUsers);
router.post('/link-fnd-user',     verifyToken, ssoCtrl.linkFndUser);
router.get ('/ebs-launch',        ssoCtrl.ebsLaunch);
router.get ('/ebs-session-check', ssoCtrl.ebsSessionCheck);

module.exports = router;
