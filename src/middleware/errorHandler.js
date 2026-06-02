'use strict';

const logger = require('../config/logger');

/**
 * Central Express error handler.
 * Must be registered LAST with app.use(errorHandler).
 */
function errorHandler(err, req, res, next) {          // eslint-disable-line no-unused-vars
  // Validation errors from express-validator (already handled in controllers, this is a safety net)
  if (err.type === 'validation') {
    return res.status(422).json({ error: 'Validation failed', details: err.details });
  }

  // Oracle unique constraint violation
  if (err.errorNum === 1) {
    return res.status(409).json({ error: 'Duplicate record — a record with this identifier already exists.' });
  }

  // Oracle foreign key violation
  if (err.errorNum === 2292) {
    return res.status(409).json({ error: 'Cannot delete — referenced by child records.' });
  }

  // Oracle no-data-found (raised via RAISE_APPLICATION_ERROR in procedures)
  if (err.errorNum === 20001) {
    return res.status(404).json({ error: err.message.replace('ORA-20001: ', '') });
  }

  // Business rule violations from procedures
  if (err.errorNum >= 20000 && err.errorNum <= 20999) {
    return res.status(400).json({ error: err.message.replace(/ORA-\d+: /g, '') });
  }

  // JWT errors (should be caught in auth middleware, but belt-and-suspenders)
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Log unexpected errors
  logger.error('Unhandled error', {
    path:    req.path,
    method:  req.method,
    userId:  req.user?.userId,
    error:   err.message,
    stack:   process.env.NODE_ENV !== 'production' ? err.stack : undefined,
  });

  // Include Oracle error number if available (helps diagnose DB issues)
  const oraDetail = err.errorNum ? 'ORA-'+err.errorNum+': '+err.message : err.message;
  return res.status(500).json({
    error:  'Internal server error',
    detail: oraDetail,
  });
}

/**
 * 404 handler — register before errorHandler.
 */
function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

module.exports = { errorHandler, notFound };
