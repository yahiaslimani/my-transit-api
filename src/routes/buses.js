// Example: Add this to your server (e.g., in routes/buses.js or a similar file)
const express = require('express');
const { pool } = require('../config/database'); // Import your DB connection pool
const router = express.Router();

// GET /api/buses/available - Fetch buses not currently assigned to an active driver
// This assumes you have a way to track active drivers and their assigned buses
// If you don't have an active driver tracking system yet, you might just return all buses
// or buses where assigned_to_driver_id is NULL.
router.get('/available', async (req, res) => {
  try {
    // --- Option 1: If you simply want all buses where assigned_to_driver_id is NULL ---
    const query = `
      SELECT id, cod, nam, plate, assigned_to_driver_id
      FROM "Bus"
      WHERE assigned_to_driver_id IS NULL
      ORDER BY id; -- Order by ID for consistency
    `;

    // --- Option 2: If you want to exclude buses assigned to *currently active* drivers ---
    // You might need a table like 'DriverSessions' or check 'active' status in the 'Driver' table
    // Example query excluding buses assigned to drivers who have an active session:
    // const query = `
    //   SELECT b.id, b.cod, b.nam, b.plate, b.assigned_to_driver_id
    //   FROM "Bus" b
    //   LEFT JOIN "Driver" d ON b.assigned_to_driver_id = d.id -- Join with Driver table
    //   LEFT JOIN "DriverSession" ds ON d.id = ds.driver_id -- Join with DriverSession table (if exists)
    //   WHERE b.assigned_to_driver_id IS NULL -- Unassigned buses
    //   OR (d.active = true AND ds.status = 'active') IS NOT TRUE; -- OR assigned but driver is not active
    //   ORDER BY b.id;
    // `;

    const result = await pool.query(query);

    res.status(200).json({
      success: true,
      data: result.rows, // Send the list of available buses
    });

  } catch (error) {
    console.error('Error fetching available buses:', error);
    res.status(500).json({
      success: false,
      message: 'Server Error',
    });
  }
});

// GET /api/buses - Fetch all buses (might be useful for admin views)
router.get('/', async (req, res) => {
  try {
    const query = 'SELECT id, cod, nam, plate, assigned_to_driver_id FROM "Bus" ORDER BY id;';
    const result = await pool.query(query);

    res.status(200).json({
      success: true,
      data: result.rows,
    });

  } catch (error) {
    console.error('Error fetching buses:', error);
    res.status(500).json({
      success: false,
      message: 'Server Error',
    });
  }
});

module.exports = router;