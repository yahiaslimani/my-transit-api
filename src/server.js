// src/server.js
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const path = require('path');
const { connectDB } = require('./config/database');
const errorHandler = require('./middleware/errorHandler');
const stopRoutes = require('./routes/stops');
const lineRoutes = require('./routes/lines');
const sublineRoutes = require('./routes/sublines');
const realtimeProcessor = require('./services/realtimeProcessor'); // Import the processor module

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

// Start the main server
const server = app.listen(PORT, () => {
  console.log(`Main server is running on port ${PORT}`);
});

// Start the real-time processor service *after* the main server starts
server.on('listening', () => {
    console.log('Main server listening, starting real-time processor...');
    realtimeProcessor.start(); // Start the phone WS client and output WS server
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  realtimeProcessor.stop(); // Stop the processors
  server.close(() => {
    console.log('Process terminated.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  realtimeProcessor.stop(); // Stop the processors
  server.close(() => {
    console.log('Process terminated.');
    process.exit(0);
  });
});