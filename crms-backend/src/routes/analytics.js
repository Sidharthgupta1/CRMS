'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/analyticsController');

router.get('/summary', ctrl.getSummary);

module.exports = router;
