// src/controllers/stopController.js
const { pool } = require('../config/database');
const { getSublinesWithBusesToStation } = require('../services/realtimeProcessor'); // Import the new function

const getAllStops = async (req, res) => {
  try {
    // Destructure query parameters including the new 'dateNotActive', 'page', and 'limit'
    let { page = 1, limit = -1, cod, nam, ref } = req.query;

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
      ref: { column: 'ref', operator: 'ILIKE' },
    };

    // Build the WHERE clause dynamically based only on allowed parameters present in req.query
    const filters = [];
    const params = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries({ cod, nam, ref })) {
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
        SELECT id, cod, lat, lon, nam, ref
        FROM "Stop"
        ${whereClause}
        ${limitClause};
      `;
      // No need to push limit/offset for 'all' query, they are not in the query string
    } else {
      query = `
        SELECT id, cod, lat, lon, nam, ref
        FROM "Stop"
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
      // const countQuery = `SELECT COUNT(*) FROM "Stop" ${whereClause}`;
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
      stopsInfo: result.rows, // Send the rows under an explicit 'data' key
    });
  } catch (error) {
    console.error('Error fetching stops:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const getStopByCod = async (req, res) => {
  try {
    const { cod } = req.params;
    // Include 'dateNotActive' in the SELECT clause
    const query = `
      SELECT s.id, s.cod, s.lat, s.lon, s.nam, s.ref,
             l.id AS lineid, l.cod AS line_code, l.nam AS line_name, l.act AS line_active, l.color AS line_color, l.typ AS line_type
      FROM "Stop" s
      LEFT JOIN "SubLineStop" ss ON s.id = ss.stopid
      LEFT JOIN "SubLine" sl ON ss.sublineid = sl.id
      LEFT JOIN "RouteLine" l ON sl.lineid = l.id 
      WHERE s.cod = $1
      ORDER BY l.cod, sl.cod;
    `;
    const result = await pool.query(query, [cod]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Stop not found' });
    }
    // The result might have multiple rows if the stop is on multiple lines/sublines.
    // Group the line information for the response.
    const stopData = { ...result.rows[0] }; // Start with the first row's stop data
    console.log(result.rows[0]);
    const lines = [];

    result.rows.forEach(row => {
      // If the line details exist in the row, add them to the lines array
      if (row.lineid !== null) { // Check if the join found a line
        const lineInfo = {
          id: row.linid,
          cod: row.line_code,
          nam: row.line_name,
          act: row.line_active,
          color: row.line_color,
          typ: row.line_type,
          // Optionally, include subline info if needed
          // subline_api_id: row.subline_api_id, // This would be from the sl table if selected
          // subline_code: row.subline_code,     // This would be from the sl table if selected
        };

        // Avoid duplicates if a stop appears multiple times for the same line due to different sublines
        // This assumes line_api_id uniquely identifies a line entry in the result set for this stop
        // If you need to distinguish by subline within the lines array, adjust the logic
        if (!lines.some(l => l.id === lineInfo.id)) {
            lines.push(lineInfo);
        }
      }
    });

    // Attach the lines array to the stop data object
    stopData.lines = lines;

    // Remove the individual line columns from the final stop object
    delete stopData.lineid;
    delete stopData.line_code;
    delete stopData.line_name;
    delete stopData.line_active;
    delete stopData.line_color;
    delete stopData.line_type;

    res.status(200).json({
      success: true,
      data: stopData, // Send the stop data with the attached lines array
    });
  } catch (error) {
    console.error('Error fetching stop by cod:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const getStopById = async (req, res) => {
  try {
    const { id } = req.params;
    // Include 'dateNotActive' in the SELECT clause
    const query = 'SELECT id, cod, lat, lon, nam, ref FROM "Stop" WHERE id = $1';
    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Stop not found' });
    }

    res.status(200).json({
      success: true,
      data: result.rows[0], // Send the row under an explicit 'data' key
    });
  } catch (error) {
    console.error('Error fetching stop by id:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// Example controller function for the route
const getDeparturesForStation = async (req, res) => {
  try {
    const { stationCode } = req.params;
    const numberOfDepartures = parseInt(req.query.res) || 10; // Use 'res' as per your original example, default to 10

    // First, find the station details using its code from the database
    const stationQuery = 'SELECT id, cod, lat, lon, nam FROM "Stop" WHERE cod = $1';
    const stationResult = await pool.query(stationQuery, [stationCode]);

    if (stationResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Station not found' });
    }

    const targetStation = stationResult.rows[0]; // Get the station object

    // Now, call the new function to find active buses heading to this station
    const departures = await getSublinesWithBusesToStation(targetStation, numberOfDepartures);

    // Format the response similarly to your original API example if needed
    // This is a basic example, adjust the structure as required by your frontend
    // The format might need to match the original TIB API response structure closely
    const formattedResponse = departures.map(dep => ({
      // Map the fields from the function's return object to your desired API response format
      // Example mapping, adjust based on your exact needs and the original API format:
      rt_id: dep.rt_id, // The subline ID
      bus_id: dep.bus_id, // The bus identifier
      estimated_arrival_time: dep.estimated_arrival_at_station, // ISO string or null
      estimated_minutes: dep.estimated_time_seconds === Infinity ? null : Math.round(dep.estimated_time_seconds / 60), // Convert seconds to minutes and round, or null
      distance_to_stop: dep.distance_to_station_meters, // In meters
      // Add other fields as needed, potentially fetching subline code/name from the DB if required
      // subline_code: ... (fetch if needed)
      // subline_name: ... (fetch if needed)
      // type: "esta-info", // If the frontend expects this specific type
      // ... other fields ...
    }));

    res.status(200).json({
      success: true,
       formattedResponse, // Send the list of upcoming departures
    });

  } catch (error) {
    console.error('Error fetching departures for station:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};
module.exports = {
  getAllStops,
  getStopByCod,
  getStopById,
  getDeparturesForStation
};