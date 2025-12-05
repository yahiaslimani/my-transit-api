// src/routes/driverLocationWs.js
const WebSocket = require('ws');
const { processLocationData } = require('../services/realtimeProcessor'); // Import the processing function

// Store WebSocket connections if needed for management (optional)
const driverConnections = new Set();

/**
 * Attaches the driver location WebSocket route to the main HTTP server.
 * @param {http.Server} server - The main HTTP server instance from Express.
 */
function attachDriverLocationWS(server) {
  //const wss = new WebSocket.Server({ port: process.env.PORT || 3000 }); // Define the path
  const wss = new WebSocket.Server({ server, port: process.env.PORT || 3000 }); // Define the path

  wss.on('connection', (ws, req) => {
    console.log('Driver app connected to /api/driver-location-ws');

    driverConnections.add(ws);

    ws.on('message', (data) => {
      try {
        const messageStr = data.toString();
        console.log('Raw message received from driver app:', messageStr);

        let parsedData;
        try {
          // Attempt to parse the received string as JSON
          parsedData = JSON.parse(messageStr);
        } catch (e) {
          console.error('Error parsing message from driver app as JSON:', e);
          console.log('Problematic message:', messageStr);
          // Optionally, send an error message back to the client
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON received' }));
          return; // Exit if parsing fails
        }

        console.log('Parsed data from driver app:', parsedData);

        if (parsedData && typeof parsedData === 'object' && parsedData.busId) {
          // Process the parsed data using the function from realtimeProcessor
          processLocationData(parsedData);
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
      driverConnections.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('Error in driver app WebSocket connection:', error);
      driverConnections.delete(ws); // Clean up on error
    });

    // Optionally, send a welcome message
    // ws.send(JSON.stringify({ type: 'connected', message: 'Connected to driver location service' }));
  });

  wss.on('error', (error) => {
    console.error('WebSocket Server Error on /api/driver-location-ws:', error);
  });

  console.log('Driver location WebSocket server attached to path /api/driver-location-ws');
}

module.exports = { attachDriverLocationWS };