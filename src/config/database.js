// src/config/database.js
const { Pool } = require('pg');

// Create a connection pool
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false, // Configure SSL based on env
});

// Function to connect and test the database
const connectDB = async () => {
  try {
    // Test the connection
    const client = await pool.connect();
    console.log('Connected to PostgreSQL database');
    client.release(); // Release the client back to the pool
  } catch (err) {
    console.error('Database connection error:', err);
    process.exit(1); // Exit the process if connection fails
  }
};

module.exports = { pool, connectDB };