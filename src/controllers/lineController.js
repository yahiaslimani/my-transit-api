// src/controllers/lineController.js
const { pool } = require('../config/database');

const getAllLines = async (req, res) => {
  try {
    // Destructure query parameters including the new 'dateNotActive', 'page', and 'limit'
    let { page = 1, limit = -1, cod, nam} = req.query;

    // Validate page and limit to be positive numbers
    page = parseInt(page);
    limit = parseInt(limit);

    if (isNaN(page) || page < 1) {
      return res.status(400).json({ success: false, message: 'Page must be a positive integer.' });
    }

    // Check if limit is -1 for all data
    const retrieveAll = limit === -1;
    if (isNaN(limit) || (limit < 1 && !retrieveAll)) {
      return res.status(400).json({ success: false, message: 'Limit must be a positive integer or -1 for all data.' });
    }

    // Define allowed filter parameters and their corresponding DB columns and operators
    const allowedFilters = {
      cod: { column: 'cod', operator: '=' },
      nam: { column: 'nam', operator: 'ILIKE' },
    };

    // Build the WHERE clause dynamically based only on allowed parameters present in req.query
    const filters = [];
    const params = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries({ cod, nam })) {
      // Check if the parameter exists in the request query and is defined in allowedFilters
      if (value !== undefined && allowedFilters[key]) {
        const { column, operator } = allowedFilters[key];
        let condition = '';
        if (operator === 'ILIKE') {
          // Use $paramIndex for the value placeholder in ILIKE (for text searches)
          condition = `${column} ${operator} $${paramIndex}`;
          params.push(`%${value}%`); // Add wildcards for partial matching
        } else {
          // Use $paramIndex for the value placeholder in other comparisons (e.g., = for dates/strings)
          condition = `${column} ${operator} $${paramIndex}`;
          params.push(value);
        }
        filters.push(condition);
        paramIndex++;
      }
    }

    // Combine filters with AND if any exist
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    // Calculate offset for pagination (only if not retrieving all)
    let offset = 0;
    if (!retrieveAll) {
      offset = (page - 1) * limit;
    }

    // Add LIMIT and OFFSET to the query (only if not retrieving all)
    let limitClause = '';
    if (retrieveAll) {
      // No LIMIT clause for retrieving all
      limitClause = `ORDER BY id -- Optional: add an order for consistent results when retrieving all`;
    } else {
      // Add LIMIT and OFFSET
      limitClause = `ORDER BY id -- Optional: add an order for consistent pagination
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      // Add limit and offset to the params array
      params.push(limit, offset);
    }

    // Construct the final query
    let query;
    if (retrieveAll) {
      query = `
        SELECT id, act, cod, nam, color, typ
        FROM "RouteLine"
        ${whereClause}
        ${limitClause};
      `;
      // No need to push limit/offset for 'all' query, they are not in the query string
    } else {
      query = `
        SELECT id, act, cod, nam, color, typ
        FROM "RouteLine"
        ${whereClause}
        ${limitClause};
      `;
      // params already has limit and offset pushed earlier in the 'if' block
    }

    const result = await pool.query(query, params);

    // Calculate pagination info if not retrieving all
    let pagination = null;
    if (!retrieveAll) {
      // Optional: Get total count for pagination metadata (requires a separate query)
      // This is commented out as it's an additional query, but often desired for pagination
      // const countQuery = `SELECT COUNT(*) FROM "RouteLine" ${whereClause}`;
      // const countResult = await pool.query(countQuery, whereClause ? params.slice(0, paramIndex - 2) : []);
      // const total = parseInt(countResult.rows[0].count);
      // const totalPages = Math.ceil(total / limit);

      pagination = {
        page: page,
        limit: limit,
        // total: total,      // Uncomment if you add the count query
        // totalPages: totalPages, // Uncomment if you add the count query
        hasNext: result.rows.length === limit, // Simple check: if we got 'limit' rows, there might be more
        hasPrev: page > 1,
      };
    }

    res.status(200).json({
      success: true,
      count: result.rows.length,
      pagination: pagination, // Include pagination info if applicable
      linesInfo: result.rows, // Send the rows under an explicit 'data' key
    });
  } catch (error) {
    console.error('Error fetching lines:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const getLineByCod = async (req, res) => {
  try {
    const { cod } = req.params;
    // Include 'dateNotActive' in the SELECT clause
    const query = 'SELECT id, act, cod, nam, color, typ FROM "RouteLine" WHERE cod = $1';
    const result = await pool.query(query, [cod]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Line not found' });
    }

    res.status(200).json({
      success: true,
      data: result.rows[0], // Send the row under an explicit 'data' key
    });
  } catch (error) {
    console.error('Error fetching line by cod:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const getLineById = async (req, res) => {
  try {
    const { id } = req.params;
    // Include 'dateNotActive' in the SELECT clause
    const query = 'SELECT id, act, cod, nam, color, typ FROM "RouteLine" WHERE id = $1';
    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Line not found' });
    }

    res.status(200).json({
      success: true,
      data: result.rows[0], // Send the row under an explicit 'data' key
    });
  } catch (error) {
    console.error('Error fetching line by id:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

module.exports = {
  getAllLines,
  getLineByCod,
  getLineById,
};