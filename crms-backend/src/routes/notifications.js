'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/notificationController');

router.get  ('/',            ctrl.getAll);
router.patch('/read-all',    ctrl.markAllRead);
router.patch('/:id/read',    ctrl.markRead);

module.exports = router;
