// src/routes/driverLocationWs.js
const WebSocket = require('ws');
const { processLocationData } = require('../services/realtimeProcessor'); // Import the processing function

// Store active passenger connections
const passengerConnections = new Set();

function handleDriverConnection(socket) {
  console.log('Driver connected to /api/driver-location-ws');
  
  socket.on('message', (data) => {
    try {
      // Parse incoming driver data
      const driverData = JSON.parse(data.toString());
      
      // Validate required fields
      if (typeof driverData.lat !== 'number' || typeof driverData.lng !== 'number') {
        console.error('Invalid location data received:', driverData);
        return;
      }
      
      // Process/modify data as needed (currently keeping it the same)
      processLocationData(driverData);
      const processedData = {
        ...driverData,
        // Add server timestamp if needed
        serverTimestamp: new Date().toISOString(),
        // Example of potential modifications:
        // processedVelocity: `${driverData.velocity} m/s`
      };
      
      // Broadcast to all passengers
      const payload = JSON.stringify(processedData);
      const disconnected = [];
      
      for (const passengerSocket of passengerConnections) {
        if (passengerSocket.readyState === WebSocket.OPEN) {
          passengerSocket.send(payload);
        } else {
          disconnected.push(passengerSocket);
        }
      }
      
      // Clean up disconnected passengers
      for (const socket of disconnected) {
        passengerConnections.delete(socket);
      }
      
      console.log(`Broadcasted to ${passengerConnections.size} passengers:`, processedData);
    } catch (error) {
      console.error('Error processing driver message:', error);
      console.error('Raw data:', data.toString());
    }
  });
  
  socket.on('close', () => {
    console.log('Driver disconnected from /api/driver-location-ws');
  });
  
  socket.on('error', (error) => {
    console.error('Driver connection error:', error);
  });
}

// Handle passenger connections
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
    passengerConnections.delete(socket);
    console.log('Passenger disconnected. Active passengers:', passengerConnections.size);
  });
  
  socket.on('error', (error) => {
    console.error('Passenger connection error:', error);
    passengerConnections.delete(socket);
  });
}

module.exports = { handleDriverConnection, handlePassengerConnection };