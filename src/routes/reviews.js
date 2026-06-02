'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/reviewController');

router.get('/my', ctrl.listMyReviews);
router.get('/is-reviewer', ctrl.isReviewer);
router.post('/:reviewId/refer', ctrl.referReview);

module.exports = router;
