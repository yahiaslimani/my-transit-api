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
const { attachDriverLocationWS } = require('./routes/driverLocationWs'); // Import the driver WS setup
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

// Basic route for testing
app.get('/', (req, res) => {
  res.json({ message: 'Transit API is running!' });
});

// Create the HTTP server instance using Express app
const server = http.createServer(app);

// Attach the driver location WebSocket *before* starting the server
attachDriverLocationWS(server);

// Create the output WebSocket server instance (for passenger app)
const outputWsServer = new WebSocket.Server({ noServer: true, path: '/api/passenger-realtime-ws' }); // Define a path for output

// Handle upgrade requests for the output WebSocket
server.on('upgrade', (request, socket, head) => {
  // Check if the upgrade request is for the output WebSocket path
  if (request.url === '/api/passenger-realtime-ws') {
    outputWsServer.handleUpgrade(request, socket, head, (ws) => {
      outputWsServer.emit('connection', ws, request);
    });
  } else {
    // If it's not for the output WS path, let Express handle it or deny
    socket.destroy(); // Deny upgrade for unknown paths
  }
});

// Start the main HTTP server
server.listen(PORT, () => {
  console.log(`Main server is running on port ${PORT}`);

  // Now that the HTTP server is listening, initialize the real-time processor
  // Pass the output WebSocket server instance to it
  console.log('Initializing real-time processor...');
  realtimeProcessor.start(outputWsServer); // Pass the output server instance

  // Optional: Set up a periodic task for complex calculations like 'esta-info' or 'stop' detection
  // setInterval(async () => {
  //   // Iterate through activeBusStates and perform calculations
  //   console.log('Periodic processing task running...');
  // }, PROCESSING_INTERVAL_MS);
});

/*
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
*/