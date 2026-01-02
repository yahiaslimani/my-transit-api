// src/routes/auth.js (Example file)
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database'); // Import your DB connection pool

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your_default_secret_key'; // Use a strong secret from env variables
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h'; // Token expiry time

// --- Login Endpoint ---
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  try {
    // 1. Find the driver by username in the database
    const driverQuery = 'SELECT id, username, password_hash FROM "Driver" WHERE username = $1';
    const driverResult = await pool.query(driverQuery, [username]);

    if (driverResult.rows.length === 0) {
      // Always delay the response slightly to prevent timing attacks revealing if a user exists
      await bcrypt.compare(password, '$2a$10$dummy_hash_that_takes_time'); // Use a dummy hash
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const driver = driverResult.rows[0];

    // 2. Compare the provided password with the hashed password stored in the database
    const isPasswordValid = await bcrypt.compare(password, driver.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    // 3. Generate a JWT token
    const token = jwt.sign(
      { driverId: driver.id, username: driver.username }, // Payload
      JWT_SECRET, // Secret key
      { expiresIn: JWT_EXPIRES_IN } // Expiry time
    );

    // 4. Send the token back to the client
    res.status(200).json({
      success: true,
      message: 'Login successful.',
      token: token,
      driver: { id: driver.id, username: driver.username } // Send minimal user info if needed
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// --- Signup Endpoint (Optional) ---
router.post('/signup', async (req, res) => {
  const { username, password, name, phone } = req.body; // Add other required fields

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  try {
    // 1. Check if username already exists
    const checkUserQuery = 'SELECT id FROM "Driver" WHERE username = $1';
    const checkResult = await pool.query(checkUserQuery, [username]);

    if (checkResult.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'Username already exists.' });
    }

    // 2. Hash the password
    const saltRounds = 10; // Standard number of rounds for bcrypt
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // 3. Insert the new driver into the database
    const insertDriverQuery = `
      INSERT INTO "Driver" (username, password_hash, name, phone)
      VALUES ($1, $2, $3, $4)
      RETURNING id, username;
    `;
    const insertResult = await pool.query(insertDriverQuery, [username, hashedPassword, name, phone]);

    const newDriver = insertResult.rows[0];

    // 4. Optionally, create a default configuration entry for the driver
    // const insertConfigQuery = 'INSERT INTO "DriverConfiguration" (driver_id) VALUES ($1)';
    // await pool.query(insertConfigQuery, [newDriver.id]);

    res.status(201).json({
      success: true,
      message: 'Driver created successfully.',
      driver: { id: newDriver.id, username: newDriver.username } // Send minimal user info
    });

  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// --- Verify Token Endpoint (Optional, for checking validity) ---
router.post('/verify-token', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ success: false, message: 'Token is required.' });
  }

  try {
    // Verify the token
    const decoded = jwt.verify(token, JWT_SECRET);

    // Optionally, fetch user details again from DB using decoded.driverId to ensure user still exists/isActive
    // const driverQuery = 'SELECT id, username FROM "Driver" WHERE id = $1';
    // const driverResult = await pool.query(driverQuery, [decoded.driverId]);
    // if (driverResult.rows.length === 0) {
    //   return res.status(401).json({ success: false, message: 'Token is valid but user not found.' });
    // }

    res.status(200).json({
      success: true,
      message: 'Token is valid.',
      driverId: decoded.driverId,
      username: decoded.username
    });

  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ success: false, message: 'Token has expired.' });
    } else if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ success: false, message: 'Invalid token.' });
    } else {
      console.error('Token verification error:', error);
      return res.status(500).json({ success: false, message: 'Server Error' });
    }
  }
});

module.exports = router;