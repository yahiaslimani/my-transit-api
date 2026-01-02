// src/routes/drivers.js (Example file for driver-specific APIs)
const express = require('express');
const { authenticateToken } = require('../middleware/authMiddleware'); // Import the middleware
const { pool } = require('../config/database');

const router = express.Router();

// Example: Get driver's configuration (protected route)
router.get('/me/configuration', authenticateToken, async (req, res) => {
  const driverId = req.driver.id; // Get driver ID from the authenticated request object

  try {
    const configQuery = `
      SELECT dc.bus_id, dc.route_id, dc.driver_name, dc.driver_phone, dc.bus_plate, dc.is_sharing, dc.schedule_start_time, dc.schedule_end_time
      FROM "DriverConfiguration" dc
      WHERE dc.driver_id = $1;
    `;
    const configResult = await pool.query(configQuery, [driverId]);

    if (configResult.rows.length === 0) {
      // If no configuration exists, return a default or null response
      return res.status(200).json({
        success: true,
        data: null, // Or return a default config object
        message: 'No configuration found for this driver.'
      });
    }

    const config = configResult.rows[0];
    // Fetch bus and route details using bus_id and route_id if needed
    // ... (fetch bus/route details) ...
    res.status(200).json({
      success: true,
      data: config // Return the configuration object
    });
  } catch (error) {
    console.error('Fetch config error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// Example: Save driver's configuration (protected route)
router.post('/me/configuration', authenticateToken, async (req, res) => {
  const driverId = req.driver.id; // Get driver ID from the authenticated request object
  const { busId, routeId, driverName, driverPhone, busPlate } = req.body;

  try {
    // Optional: Validate busId and routeId exist and are valid before inserting/updating
    // const busExistsQuery = 'SELECT id FROM "Stop" WHERE id = $1'; // Adjust table name if needed
    // const routeExistsQuery = 'SELECT id FROM "SubLine" WHERE id = $1';
    // ... await pool.query checks ...

    // Upsert the configuration (INSERT if not exists, UPDATE if exists)
    const upsertConfigQuery = `
      INSERT INTO "DriverConfiguration" (driver_id, bus_id, route_id, driver_name, driver_phone, bus_plate)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (driver_id) -- Assuming UNIQUE constraint on (driver_id)
      DO UPDATE SET
        bus_id = EXCLUDED.bus_id,
        route_id = EXCLUDED.route_id,
        driver_name = EXCLUDED.driver_name,
        driver_phone = EXCLUDED.driver_phone,
        bus_plate = EXCLUDED.bus_plate,
        updated_at = CURRENT_TIMESTAMP; -- Update timestamp on upsert
    `;
    await pool.query(upsertConfigQuery, [driverId, busId, routeId, driverName, driverPhone, busPlate]);

    res.status(200).json({
      success: true,
      message: 'Configuration saved successfully.'
    });

  } catch (error) {
    console.error('Save config error:', error);
    // Check for specific database errors (e.g., foreign key constraint violation for busId/routeId)
    if (error.code === '23503') { // Foreign key violation code
        return res.status(400).json({ success: false, message: 'Invalid busId or routeId provided.' });
    }
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

module.exports = router;