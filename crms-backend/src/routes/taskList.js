'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/taskListController');

router.get   ('/',       ctrl.getTaskList);   // GET  /task-list
router.post  ('/',       ctrl.createTask);    // POST /task-list
router.post  ('/bulk',   ctrl.bulkUpsert);    // POST /task-list/bulk (save all)
router.delete('/bulk',   ctrl.bulkDelete);    // DELETE /task-list/bulk (delete many)
router.patch ('/:id',    ctrl.updateTask);    // PATCH /task-list/:id
router.delete('/:id',    ctrl.deleteTask);    // DELETE /task-list/:id

module.exports = router;
