// src/routes/driverLocationWs.js
const WebSocket = require('ws');
const { processLocationData, injectPassengerConnections } = require('../services/realtimeProcessor'); // Import the processing function and injection function

// Store active passenger connections
const passengerConnections = new Set();

/**
 * Handles the WebSocket connection from the driver's phone app.
 * @param {WebSocket} socket - The WebSocket connection object for the driver.
 */
function handleDriverConnection(socket) {
  console.log('Driver connected to /api/driver-location-ws');

  socket.on('message', async (data) => {
    try {
      // Parse incoming driver data
      const messageStr = data.toString();
      console.log('Raw message received from driver app:', messageStr);

      let driverData;
      try {
          // Attempt to parse the received string directly as JSON
          driverData = JSON.parse(messageStr);
      } catch (e) {
          console.error('Error parsing message from driver app as JSON:', e);
          console.error('Problematic message:', messageStr);
          // Optionally, send an error message back to the client
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON received' }));
          return; // Exit if parsing fails
      }

      console.log('Parsed data from driver app:', driverData);

      if (driverData && typeof driverData === 'object' && driverData.busId) {
        // Process the parsed data using the function from realtimeProcessor
        // The processor now handles rt_id determination internally
        await processLocationData(driverData); // Await if processLocationData is async
      } else {
        console.warn('Received message from driver app is not a valid object with busId:', driverData);
        socket.send(JSON.stringify({ type: 'error', message: 'Valid object with busId required' }));
      }
    } catch (error) {
      console.error('Error processing message from driver app:', error);
      console.error('Raw data causing error:', data.toString());
      // Optionally, send an error message back
       socket.send(JSON.stringify({ type: 'error', message: 'Server error processing message' }));
    }
  });

  socket.on('close', () => {
    console.log('Driver disconnected from /api/driver-location-ws');
  });

  socket.on('error', (error) => {
    console.error('Driver connection error:', error);
  });

  // Optionally, send a welcome message
  socket.send(JSON.stringify({ type: 'connected', message: 'Connected to driver location service' }));
}

/**
 * Handles the WebSocket connection from the passenger's app.
 * @param {WebSocket} socket - The WebSocket connection object for the passenger.
 */
function handlePassengerConnection(socket) {
  console.log('Passenger connected to /api/passenger-realtime-ws');
  passengerConnections.add(socket);

  // Send welcome message
  socket.send(JSON.stringify({
    type: 'connection',
    message: 'Connected to real-time location service',
    timestamp: new Date().toISOString()
  }));

  // Handle passenger disconnection
  socket.on('close', () => {
    console.log('Passenger disconnected. Active passengers:', passengerConnections.size);
    passengerConnections.delete(socket);
  });

  socket.on('error', (error) => {
    console.error('Passenger connection error:', error);
    passengerConnections.delete(socket); // Clean up on error
  });
}

// --- Inject Passenger Connections and Broadcast Function ---
// This function is called once when the module is loaded (ideally after server.js starts)
function initializeRealtimeProcessor() {
    // Define the broadcast function that uses the passengerConnections set
    const broadcastToPassengers = (message) => {
        if (passengerConnections.size > 0) {
            const messageStr = JSON.stringify(message);
            passengerConnections.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(messageStr);
                }
            });
            console.log('Broadcasted message to', passengerConnections.size, 'passenger(s):', messageStr);
        } else {
            console.log('No passengers connected, message not broadcasted:', message);
        }
    };

    // Inject the set and the function into the realtimeProcessor module
    injectPassengerConnections(passengerConnections, broadcastToPassengers);
}

// Call the initialization function
initializeRealtimeProcessor();

module.exports = { handleDriverConnection, handlePassengerConnection };