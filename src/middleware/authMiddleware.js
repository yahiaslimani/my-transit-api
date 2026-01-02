// src/middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'your_default_secret_key';

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Fetch user details from DB using decoded.driverId to attach to request object
    const driverQuery = 'SELECT id, username FROM "Driver" WHERE id = $1';
    const driverResult = await pool.query(driverQuery, [decoded.driverId]);

    if (driverResult.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Token is valid but user not found.' });
    }

    req.driver = driverResult.rows[0]; // Attach driver info to the request object
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ success: false, message: 'Token has expired.' });
    } else if (error instanceof jwt.JsonWebTokenError) {
      return res.status(403).json({ success: false, message: 'Invalid token.' });
    } else {
      console.error('Auth middleware error:', error);
      return res.status(500).json({ success: false, message: 'Server Error' });
    }
  }
};

module.exports = { authenticateToken };