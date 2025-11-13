// src/server.js
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const path = require('path');
const { connectDB } = require('./config/database');
const errorHandler = require('./middleware/errorHandler');
const stopRoutes = require('./routes/stops');
const lineRoutes = require('./routes/lines');
const sublineRoutes = require('./routes/sublines');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Connect to the database
connectDB();


const routePathsDir = path.join(__dirname, 'routePaths'); // __dirname is the directory of server.js (src)

// Serve static files from the routePaths directory under the /api/kml route
app.use('/api/kml', express.static(routePathsDir));
// Define routes
app.use('/api/stops', stopRoutes);
app.use('/api/lines', lineRoutes);
app.use('/api/sublines', sublineRoutes);

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