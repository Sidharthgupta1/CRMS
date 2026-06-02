'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/analyticsController');

router.get('/summary', ctrl.getSummary);

router.get('/subtask-assignees', ctrl.getSubtaskAssignees);

module.exports = router;
