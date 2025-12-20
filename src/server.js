// src/server.js
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const http = require('http'); // Need the raw HTTP server
const WebSocket = require('ws'); // Import ws for the single server
const path = require('path');
const { connectDB } = require('./config/database');
const errorHandler = require('./middleware/errorHandler');
const stopRoutes = require('./routes/stops');
const lineRoutes = require('./routes/lines');
const sublineRoutes = require('./routes/sublines');
const { injectBroadcastFunction, start: startRealtimeProcessor, stop: stopRealtimeProcessor, processLocationData } = require('./services/realtimeProcessor'); // Import processor functions

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

// Create the raw HTTP server instance
const server = http.createServer(app);

// --- SINGLE WebSocket Server Instance ---
// Create one WebSocket server instance attached to the HTTP server
const wss = new WebSocket.Server({ noServer: true }); // Create without attaching to 'server' yet

// --- NEW: Manage Passenger Connections by Route ---
// Key: routeId (e.g., "101"), Value: Set of WebSocket clients interested in that route
const passengerConnectionsByRoute = new Map();

// --- NEW: Broadcast Function for Specific Routes ---
// This function will be called by the realtimeProcessor
function broadcastToRouteClients(rtId, message) {
  console.log("yahia");
  console.log(rtId);
  console.log(message);
  
  // Determine the main routeId from the rt_id (e.g., if rt_id is 1011, routeId might be 101)
  // You need to implement this helper function to map the subline ID back to the main line ID.
  getMainRouteIdFromRtId(rtId).then(routeId => {
      if (routeId) {
          const clients = passengerConnectionsByRoute.get(routeId.toString()); // Ensure routeId is a string for the map key
          if (clients && clients.size > 0) {
            const messageStr = JSON.stringify(message);
            clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(messageStr);
              }
            });
            console.log(`[Broadcast] Sent message to ${clients.size} client(s) on route ${routeId} (from rt_id ${rtId})`);
          } else {
            // console.log(`[Broadcast] No active clients for route ${routeId} (from rt_id ${rtId}), message not sent:`, messageStr); // Log only if needed frequently
          }
      } else {
          console.warn(`[Broadcast] Could not determine main routeId for rt_id ${rtId}, cannot broadcast.`);
      }
  }).catch(error => {
      console.error(`[Broadcast] Error getting main route ID for rt_id ${rtId}:`, error);
  });
}

// Helper function to get main routeId from rt_id (subline_id)
// You need to implement this, likely requiring a DB query or a cached map.
// Example: SELECT lineid FROM "SubLine" WHERE id = $1;
async function getMainRouteIdFromRtId(rtId) {
    // This is a placeholder. You should implement a DB query or use a cached map.
    // For now, let's assume rt_id itself is the routeId (which is often not the case).
    // If rt_id is the subline ID, you need to fetch the parent line ID.
    // Import your database pool if not already available in this scope
    const { pool } = require('./config/database'); // Adjust path if pool is defined differently

    try {
        const query = 'SELECT lineid FROM "SubLine" WHERE id = $1'; // Assuming "SubLine" table has "lineid" column linking to main "RouteLine"
        const result = await pool.query(query, [rtId]);
        if (result.rows.length > 0) {
            return result.rows[0].lineid; // Return the main route ID
        } else {
            console.error(`[DB Query] Could not find main route ID for subline rt_id: ${rtId}`);
            return null;
        }
    } catch (error) {
        console.error(`[DB Error] Error fetching main route ID for rt_id ${rtId}:`, error);
        return null;
    }
}

server.on('upgrade', (request, socket, head) => {
  const url = request.url;

  // --- Handle Driver WebSocket Upgrade ---
  if (url === '/api/driver-location-ws') {
    console.log('Driver app WebSocket upgrade request received for /api/driver-location-ws');
    // Use the single WSS instance to handle the upgrade
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, 'driver'); // Emit connection event with a type indicator
    });
    return; // Exit after handling driver upgrade
  }

  // --- Handle Passenger WebSocket Upgrade ---
  // Match the path: /api/passenger-realtime-ws/{routeId}
  const passengerWsRegex = /^\/api\/passenger-realtime-ws\/(\d+)$/;
  const match = url.match(passengerWsRegex);

  if (match) {
    const routeId = match[1]; // Extract the routeId from the URL (e.g., "101")
    console.log(`Passenger WebSocket upgrade request received for routeId: ${routeId}`);

    // Use the single WSS instance to handle the upgrade
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, 'passenger', routeId); // Emit connection event with type and routeId
    });
    return; // Exit after handling passenger upgrade
  }

  // If the URL doesn't match any known WebSocket path, destroy the socket
  console.warn(`Unknown WebSocket path requested: ${url}, closing connection.`);
  socket.destroy();
});

// --- Handle WebSocket Connections (Driver Input & Passenger Output) ---
wss.on('connection', (ws, request, connectionType, routeId) => {
  if (connectionType === 'driver') {
    console.log('Driver app connected to /api/driver-location-ws');
    // Handle messages from the driver's phone app
    ws.on('message', (data) => {
      try {
        //const messageStr = data.toString();
        //console.log('Raw message received from driver app:', messageStr);
        
        let parsedData;
        try {
          parsedData = JSON.parse(data.toString());
        } catch (e) {
          //console.error('Error parsing message from driver app as JSON:', e);
          //console.log('Problematic message:', messageStr);
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON received' }));
          return; // Exit if parsing fails
        }

        console.log('Parsed data from driver app:', parsedData);

        if (parsedData && typeof parsedData === 'object' && parsedData.busId) {
          // Process the parsed data using the function from realtimeProcessor
          processLocationData(parsedData); // Pass the raw data object
        } else {
          console.warn('Received message from driver app is not a valid object with busId:', parsedData);
          ws.send(JSON.stringify({ type: 'error', message: 'Valid object with busId required' }));
        }
      } catch (error) {
        console.error('Error processing message from driver app:', error);
        // Optionally, send an error message back
         ws.send(JSON.stringify({ type: 'error', message: 'Server error processing message' }));
      }
    });

    ws.on('close', () => {
      console.log('Driver app disconnected from /api/driver-location-ws');
    });

    ws.on('error', (error) => {
      console.error('Error in driver app WebSocket connection:', error);
    });

    // Optionally, send a welcome message to the driver app
    ws.send(JSON.stringify({ type: 'connected', message: 'Connected to driver location service' }));

  } else if (connectionType === 'passenger' && routeId) {
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

  } else {
    // This shouldn't happen if the upgrade logic is correct, but just in case.
    console.warn('WebSocket connection received with unknown type or missing routeId, closing.');
    ws.close(1008, 'Invalid connection type or missing routeId'); // Close with 'Policy Violation' code
  }
});

wss.on('error', (error) => {
  console.error('WebSocket Server Error:', error);
});

// --- Inject the Broadcast Function into the Realtime Processor ---
// This must happen *after* the broadcastToRouteClients function is defined
injectBroadcastFunction(broadcastToRouteClients);

server.listen(PORT, () => {
  console.log(`Main server is running on port ${PORT}`);
  console.log(`Driver endpoint: /api/driver-location-ws`);
  console.log(`Passenger endpoint: /api/passenger-realtime-ws/{routeId}`); // Updated message

  // Initialize the real-time processor after the server is listening
  // Pass the single WSS instance if the processor needs to interact with it directly (though it shouldn't for just broadcasting)
  console.log('Initializing real-time processor...');
  startRealtimeProcessor(); // Call the start function from the processor module
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  stopRealtimeProcessor(); // Stop the processors if you have this function
  server.close(() => {
    console.log('Process terminated.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  stopRealtimeProcessor(); // Stop the processors if you have this function
  server.close(() => {
    console.log('Process terminated.');
    process.exit(0);
  });
});