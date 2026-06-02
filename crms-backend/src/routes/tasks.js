'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/taskController');

router.get  ('/my',          ctrl.myTasks);            // GET  /tasks/my
router.patch('/:taskId/close', ctrl.closeTask);         // PATCH /tasks/:taskId/close

module.exports = router;
