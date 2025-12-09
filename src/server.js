// src/server.js
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const http = require('http'); // Need the raw HTTP server
const WebSocket = require('ws'); // Import ws for output server
const path = require('path');
const { connectDB } = require('./config/database');
const errorHandler = require('./middleware/errorHandler');
const stopRoutes = require('./routes/stops');
const lineRoutes = require('./routes/lines');
const sublineRoutes = require('./routes/sublines');
const { handleDriverConnection, handlePassengerConnection } = require('./routes/driverLocationWs'); // Import the driver WS setup
const realtimeProcessor = require('./services/realtimeProcessor'); // Import the processor

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

const server = http.createServer(app);

// Basic route for testing
app.get('/', (req, res) => {
  res.json({ message: 'Transit API is running!' });
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (socket, req) => {
  const url = req.url;
  
  if (url === '/api/driver-location-ws') {
    handleDriverConnection(socket);
  } else if (url === '/api/passenger-realtime-ws') {
    handlePassengerConnection(socket);
  } else {
    socket.close(1008, 'Invalid endpoint');
  }
});

// Start the main HTTP server
server.listen(PORT, () => {
  console.log(`Main server is running on port ${PORT}`);
  console.log(`Driver endpoint: /api/driver-location-ws`);
  console.log(`Passenger endpoint: /api/passenger-realtime-ws`);

  // Initialize the real-time processor if needed
  // Note: You may need to adjust how you pass the WebSocket server to the processor
  // based on your existing realtimeProcessor implementation
  console.log('Initializing real-time processor...');
  realtimeProcessor.start(); // Call the start function here
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  realtimeProcessor.stop(); // Stop the processors if you have this
  server.close(() => {
    console.log('Process terminated.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  realtimeProcessor.stop(); // Stop the processors if you have this
  server.close(() => {
    console.log('Process terminated.');
    process.exit(0);
  });
});