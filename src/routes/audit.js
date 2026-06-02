'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/auditController');

router.get('/', ctrl.getAll);

module.exports = router;
