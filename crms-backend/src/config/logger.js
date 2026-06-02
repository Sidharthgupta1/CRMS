'use strict';

const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

const LOG_DIR   = process.env.LOG_DIR || './logs';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const isProd    = process.env.NODE_ENV === 'production';

const consoleFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: 'HH:mm:ss' }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} [${level}] ${message}${extra}`;
  })
);

const fileFormat = format.combine(
  format.timestamp(),
  format.errors({ stack: true }),
  format.json()
);

const logger = createLogger({
  level: LOG_LEVEL,
  transports: [
    // Always write to console (suppressed in test)
    new transports.Console({
      silent: process.env.NODE_ENV === 'test',
      format: consoleFormat,
    }),

    // Rotating daily log — info level
    new transports.DailyRotateFile({
      dirname:       LOG_DIR,
      filename:      'crms-%DATE%.log',
      datePattern:   'YYYY-MM-DD',
      maxFiles:      '30d',
      zippedArchive: true,
      level:         'info',
      format:        fileFormat,
    }),

    // Separate error log
    new transports.DailyRotateFile({
      dirname:       LOG_DIR,
      filename:      'crms-error-%DATE%.log',
      datePattern:   'YYYY-MM-DD',
      maxFiles:      '90d',
      zippedArchive: true,
      level:         'error',
      format:        fileFormat,
    }),
  ],
});

module.exports = logger;
