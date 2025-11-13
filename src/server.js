// src/server.js
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const { connectDB } = require('./config/database');
const errorHandler = require('./middleware/errorHandler');
const stopRoutes = require('./routes/stops');
const lineRoutes = require('./routes/lines');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Connect to the database
connectDB();

// Define routes
app.use('/api/stops', stopRoutes);
app.use('/api/lines', lineRoutes);

// Use error handler middleware
app.use(errorHandler);

// Basic route for testing
app.get('/', (req, res) => {
  res.json({ message: 'Transit API is running!' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});