// src/config/database.js
const { Pool } = require('pg');

// Create a connection pool
const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 5432, // Ensure port is a number
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // Explicitly configure SSL for Neon
  ssl: {
    // Disable host verification (often necessary for cloud providers like Neon)
    // Be cautious with this in production with unknown certificates
    rejectUnauthorized: false
  }
  // Alternative, simpler ssl: true might also work with Neon
  // ssl: true
});

// Function to connect and test the database
const connectDB = async () => {
  try {
    // Test the connection
    const client = await pool.connect();
    console.log('Connected to PostgreSQL database (Neon)');
    client.release(); // Release the client back to the pool
  } catch (err) {
    console.error('Database connection error:', err);
    process.exit(1); // Exit the process if connection fails
  }
};

module.exports = { pool, connectDB };