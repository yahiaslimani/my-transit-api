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
const { realtimeProcessor, processLocationData, broadcastToRouteClients, initializeBroadcastFunction } = require('./services/realtimeProcessor'); // Import the processor

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

const server = http.createServer(app);

// Create the main WebSocket server instance (for driver app)
const driverWss = new WebSocket.Server({ noServer: true });

// --- NEW: Manage Passenger Connections by Route ---
// Key: routeId (e.g., "101"), Value: Set of WebSocket clients interested in that route
const passengerConnectionsByRoute = new Map();

// --- NEW: Passenger WebSocket Upgrade Handler ---
server.on('upgrade', (request, socket, head) => {
  const url = request.url;

  // --- Handle Driver WebSocket Upgrade ---
  if (url === '/api/driver-location-ws') {
    driverWss.handleUpgrade(request, socket, head, (ws) => {
      driverWss.emit('connection', ws, request);
    });
    return; // Exit after handling driver upgrade
  }

  // --- Handle Passenger WebSocket Upgrade ---
  // Match the path: /api/passenger-realtime-ws/{routeId}
  const passengerWsRegex = /^\/api\/passenger-realtime-ws\/(\d+)$/;
  const match = url.match(passengerWsRegex);

  if (match) {
    const routeId = match[1]; // Extract the routeId from the URL (e.g., "101")
    console.log(`Passenger WebSocket upgrade request for routeId: ${routeId}`);

    // Prepare the WebSocket server instance for this specific route
    // We'll create a temporary server just for this upgrade, then add the client to our map
    const tempWss = new WebSocket.Server({ noServer: true });

    tempWss.handleUpgrade(request, socket, head, (ws) => {
      tempWss.emit('connection', ws, request, routeId); // Pass routeId to the connection handler
    });

    // Handle the connection for this specific route
    tempWss.on('connection', (ws, request, routeId) => {
      console.log(`Passenger connected to /api/passenger-realtime-ws/${routeId}`);

      // Add the client to the specific route's set
      if (!passengerConnectionsByRoute.has(routeId)) {
        passengerConnectionsByRoute.set(routeId, new Set());
      }
      passengerConnectionsByRoute.get(routeId).add(ws);

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'connection',
        message: `Connected to real-time feed for route ${routeId}`,
        timestamp: new Date().toISOString()
      }));

      // Handle client disconnection
      ws.on('close', () => {
        console.log(`Passenger disconnected from /api/passenger-realtime-ws/${routeId}`);
        const routeClients = passengerConnectionsByRoute.get(routeId);
        if (routeClients) {
          routeClients.delete(ws);
          // Optional: Clean up the route set if it becomes empty
          if (routeClients.size === 0) {
            passengerConnectionsByRoute.delete(routeId);
            console.log(`No more clients for route ${routeId}, cleaned up connection set.`);
          }
        }
      });

      ws.on('error', (error) => {
        console.error(`Passenger connection error on route ${routeId}:`, error);
        // Remove client on error
        const routeClients = passengerConnectionsByRoute.get(routeId);
        if (routeClients) {
          routeClients.delete(ws);
        }
      });
    });

    // Important: Delete the temporary server instance after handling this specific upgrade
    // to avoid accumulating unused server instances. The client is now managed by the map.
    // In practice, you wouldn't create a new WSS instance per upgrade this way.
    // A better approach is to use a single WSS instance and handle routing within the connection handler.
    // Let's revise this part.

    return; // Exit after handling passenger upgrade
  }

  // If the URL doesn't match any known WebSocket path, destroy the socket
  socket.destroy();
});

// --- NEW: Broadcast Function for Specific Routes ---
// This function will be called by the realtimeProcessor
function broadcastToRouteClients(rtId, message) {
  // Determine the main routeId from the rt_id if needed.
  // For example, if rt_id is "L101-1-way", the routeId might be "101".
  // You might need a helper function or a lookup table (rt_id -> routeId) if the format is complex.
  // For now, let's assume rt_id itself is used as the route identifier for the broadcast map,
  // OR that the processor calculates the main routeId from the rt_id before calling this function.
  // The most common scenario is that rt_id *is* the subline id (e.g., SubLine.id from the DB),
  // and you might want to broadcast to clients subscribed to the *main* RouteLine.
  // Let's assume the processor knows the main routeId associated with the rt_id.

  // For this example, let's assume rt_id corresponds directly to the routeId used in the URL (e.g., rt_id = 101, URL = /101)
  // OR, more accurately, rt_id corresponds to a specific subline, and clients connect to the *main* route ID.
  // We need a mapping from rt_id (subline) to the main routeId (line).
  // This could be fetched from the DB or cached. Let's call a helper function for now.
  // const routeId = getRouteIdFromRtId(rtId); // Implement this helper if needed

  // For now, let's assume rt_id *is* the routeId for simplicity in this broadcast function.
  // In reality, you might want to broadcast to the main 'routeId' (e.g., L101) which encompasses multiple sublines (rt_ids like L101-1-way, L101-1-back).
  // This requires fetching the main line ID from the SubLine table using the rt_id.
  // Let's assume the processor calculates the main routeId before calling this broadcast function.

  const routeId = getMainRouteIdFromRtId(rtId); // You need to implement this helper function

  if (routeId) {
      const clients = passengerConnectionsByRoute.get(routeId);
      if (clients && clients.size > 0) {
        const messageStr = JSON.stringify(message);
        clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(messageStr);
          }
        });
        console.log(`Broadcasted message to ${clients.size} client(s) on route ${routeId} (from rt_id ${rtId}):`, messageStr);
      } else {
        // console.log(`No active clients connected for route ${routeId} (from rt_id ${rtId}), message not sent:`, messageStr); // Log only if needed frequently
      }
  } else {
      console.warn(`Could not determine main routeId for rt_id ${rtId}, cannot broadcast.`);
  }
}

// Helper function to get main routeId from rt_id (subline_id)
// You need to implement this, likely requiring a DB query or a cached map.
// Example: SELECT lineid FROM "SubLine" WHERE id = $1;
async function getMainRouteIdFromRtId(rtId) {
    // This is a placeholder. You should implement a DB query or use a cached map.
    // For now, let's assume rt_id itself is the routeId (which is often not the case).
    // If rt_id is the subline ID, you need to fetch the parent line ID.
    try {
        const query = 'SELECT lineid FROM "SubLine" WHERE id = $1'; // Assuming "SubLine" table has "lineid" column linking to main "RouteLine"
        const result = await pool.query(query, [rtId]);
        if (result.rows.length > 0) {
            return result.rows[0].lineid; // Return the main route ID
        } else {
            console.error(`Could not find main route ID for subline rt_id: ${rtId}`);
            return null;
        }
    } catch (error) {
        console.error(`Error fetching main route ID for rt_id ${rtId}:`, error);
        return null;
    }
}

// --- Initialize the realtimeProcessor with the new broadcast function ---
// This should happen after the server.listen() call or when the server instance is ready.
// We need to pass the broadcast function to the processor.
initializeBroadcastFunction(broadcastToRouteClients); // Pass the new broadcast function


server.listen(PORT, () => {
  console.log(`Main server is running on port ${PORT}`);
  console.log(`Driver endpoint: /api/driver-location-ws`);
  console.log(`Passenger endpoint: /api/passenger-realtime-ws/{routeId}`); // Updated message

  // Initialize the real-time processor if needed
  // realtimeProcessor.start(wss); // Pass the driver WS server instance if needed
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  // realtimeProcessor.stop(); // Stop the processors if you have this
  server.close(() => {
    console.log('Process terminated.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  // realtimeProcessor.stop(); // Stop the processors if you have this
  server.close(() => {
    console.log('Process terminated.');
    process.exit(0);
  });
});