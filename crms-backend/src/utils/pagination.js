'use strict';

const DEFAULT_PAGE_SIZE = parseInt(process.env.DEFAULT_PAGE_SIZE, 10) || 50;
const MAX_PAGE_SIZE     = parseInt(process.env.MAX_PAGE_SIZE,     10) || 200;

/**
 * Parse page/pageSize from query params and return Oracle OFFSET/FETCH binds.
 *
 * Usage:
 *   const { offset, limit, meta } = parsePagination(req.query);
 *   // append to SQL: OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY
 *   // include meta in response: { data: rows, pagination: meta }
 */
function parsePagination(query = {}) {
  const page  = Math.max(1, parseInt(query.page,     10) || 1);
  let   limit = Math.min(MAX_PAGE_SIZE, parseInt(query.pageSize, 10) || DEFAULT_PAGE_SIZE);
  if (limit < 1) limit = DEFAULT_PAGE_SIZE;

  const offset = (page - 1) * limit;

  return {
    page,
    limit,
    offset,
    meta: (total) => ({
      page,
      pageSize: limit,
      total,
      totalPages: Math.ceil(total / limit),
    }),
  };
}

/**
 * Build a paginated response envelope.
 */
function paginatedResponse(rows, totalCount, pag) {
  return {
    data:       rows,
    pagination: pag.meta(totalCount),
  };
}

module.exports = { parsePagination, paginatedResponse };
