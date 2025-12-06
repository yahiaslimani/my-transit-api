// src/services/realtimeProcessor.js
const WebSocket = require('ws');
const { pool } = require('../config/database'); // Import your DB connection pool

// --- Configuration ---
const OUTPUT_WS_PORT = process.env.REALTIME_WS_PORT || 8081; // Port for the output WS (could be different if needed, but often same server)

// --- In-Memory Storage for Bus States ---
// Key: busId, Value: Object containing latest position, calculated rt_id, etc.
const activeBusStates = new Map();

// --- WebSocket Server (for output) ---
let outputWsServer = null;

// --- Helper Functions (same as before) ---

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth's radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
          Math.cos(φ1) * Math.cos(φ2) *
          Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in meters
}

function calculateBearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) -
          Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  const bearing = (θ * 180 / Math.PI + 360) % 360;
  return bearing;
}

// --- Database Query Function ---

/**
 * Matches a bus's GPS location to the most likely subline (rt_id) based on stop proximity and sequence.
 * This function is called from the input WebSocket handler.
 * @param {string} busId - The unique ID of the bus.
 * @param {number} lat - Current latitude.
 * @param {number} lon - Current longitude.
 * @param {number} [speed] - Current speed (optional, can be used for filtering).
 * @param {number} [heading] - Current heading (optional, can be used for direction matching).
 * @returns {Promise<number|null>} The rt_id (subline.id) if a match is found, otherwise null.
 */
async function matchBusToSubline(busId, lat, lon, speed, heading) {
  const proximityThresholdMeters = 200; // Adjust as needed

  try {
    // Find all stops within the proximity threshold using PostGIS
    const nearbyStopsQuery = `
      SELECT id, cod, lat, lon
      FROM "Stop"
      WHERE ST_DistanceSphere(ST_Point(lon, lat), ST_Point($1, $2)) < $3
      ORDER BY ST_DistanceSphere(ST_Point(lon, lat), ST_Point($1, $2)) ASC;
    `;
    console.log(`(${lat}, ${lon})`);
    const nearbyStopsResult = await pool.query(nearbyStopsQuery, [lon, lat, proximityThresholdMeters]);
    console.log(nearbyStopsQuery.rows.length);
    if (nearbyStopsResult.rows.length === 0) {
      console.log(`[${busId}] No stops found near current location (${lat}, ${lon}).`);
      return null;
    }

    // For each nearby stop, find the associated sublines
    const potentialSublines = new Map(); // Key: sublineId, Value: {stopId, distanceToStop, stopOrder}

    for (const stop of nearbyStopsResult.rows) {
      const stopDistance = haversineDistance(lat, lon, stop.lat, stop.lon);

      // Find sublines that include this stop
      const sublinesForStopQuery = `
        SELECT sl.id AS subline_id, sls.stoporder
        FROM "SubLineStop" sls
        JOIN "SubLine" sl ON sls.sublineid = sl.id
        WHERE sls.stopid = $1
        ORDER BY sls.stoporder; -- Get the order of the stop within the subline
      `;
      const sublinesResult = await pool.query(sublinesForStopQuery, [stop.id]);

      for (const sublineRow of sublinesResult.rows) {
        // Only add if not already present, or update if closer
        if (!potentialSublines.has(sublineRow.subline_id) || potentialSublines.get(sublineRow.subline_id).distanceToStop > stopDistance) {
            potentialSublines.set(sublineRow.subline_id, {
                stopId: stop.id,
                distanceToStop: stopDistance,
                stopOrder: sublineRow.stoporder // Store order for later use
            });
        }
      }
    }

    if (potentialSublines.size === 0) {
      console.log(`[${busId}] Nearby stops (${nearbyStopsResult.rows.length}) found, but none belong to known sublines.`);
      return null;
    }

    // Determine the most likely subline based on distance to the stop and the order of the stop in the sequence
    let bestMatchSublineId = null;
    let bestMatchDistance = Infinity;
    let bestMatchOrder = Infinity;

    for (const [sublineId, details] of potentialSublines.entries()) {
      if (details.distanceToStop < bestMatchDistance ||
          (details.distanceToStop === bestMatchDistance && details.stopOrder < bestMatchOrder)) {
        bestMatchSublineId = sublineId;
        bestMatchDistance = details.distanceToStop;
        bestMatchOrder = details.stopOrder;
      }
    }

    console.log(`[${busId}] Matched to subline ID (rt_id): ${bestMatchSublineId} (Distance: ${bestMatchDistance.toFixed(2)}m, Order: ${bestMatchOrder})`);
    return bestMatchSublineId; // This is the rt_id
  } catch (error) {
    console.error(`[${busId}] Error matching bus to subline:`, error);
    return null;
  }
}


// --- Processing Logic (called from input WS handler) ---

/**
 * Processes the raw location data received from the phone app via the input WebSocket.
 * Determines rt_id, calculates estimates, detects stops, and formats output.
 * This function is now called externally.
 * @param {object} rawData - The raw data object received from the phone (e.g., {routeId, busId, lat, lng, timestamp, velocity}).
 */
async function processLocationData(rawData) {
  const { routeId, busId, lat, lng, timestamp, velocity } = rawData;
  console.log(`[${busId}] Received raw location data: Lat=${lat}, Lng=${lng}, Vel=${velocity}, TS=${timestamp}`);

  let currentRtId = null;
  let previousRtId = null;
  let currentVel = velocity; // m/s from Geolocator
  let currentTimestamp = timestamp;

  // Get previous state if available
  const previousState = activeBusStates.get(busId);
  // --- Determine/Confirm rt_id (Subline ID) ---
  currentRtId = await matchBusToSubline(busId, /*lat*/7.7476606, /*lng*/35.267647, /*velocity*/30);
  if (currentRtId === null) {
    console.warn(`[${busId}] Could not determine rt_id for current location. Cannot process further.`);
    // Update state with new data but rt_id is null
    activeBusStates.set(busId, {
      ...previousState, // Carry over previous state if any
      lat, lng, timestamp, velocity, rtId: null // Update with new data, rt_id is null
    });
    return; // Exit processing if rt_id cannot be determined
  }

  // --- Check for Route Change ---
  if (previousState && previousState.rtId && previousState.rtId !== currentRtId) {
    console.log(`[${busId}] Detected route change from rt_id ${previousState.rtId} to ${currentRtId}. Sending 'close' for old route.`);
    const closeMessage = {
      type: "close",
      rt_id: previousState.rtId, // Use the old rt_id
      upd: previousState.timestamp ? previousState.timestamp.replace('T', ' ').substring(0, 17).replace(/\..*$/, '') : currentTimestamp.replace('T', ' ').substring(0, 17).replace(/\..*$/, ''), // Format timestamp
      date: previousState.timestamp ? previousState.timestamp.replace('T', ' ').substring(0, 17).replace(/\..*$/, '') : currentTimestamp.replace('T', ' ').substring(0, 17).replace(/\..*$/, ''),
      del: 0, // Delay
      pass: "0", // Passengers (placeholder)
      lat: previousState.lat,
      lng: previousState.lng,
      stop_id: 0, // Placeholder
      stop_code: "-", // Placeholder
      stop_nam: "-" // Placeholder
    };
    broadcastToClients(closeMessage);
  }

  // --- Format and Send 'position' message ---
  // Convert velocity from m/s (Geolocator) to km/h if the expected format is km/h (check original data)
  // Original data showed vel: 81.29629516601562 which seems high for km/h, might be m/s already or needs conversion.
  // Let's assume the output format expects the same unit as input (m/s) unless specified otherwise.
  // If the original API expected km/h, multiply by 3.6: vel: currentVel * 3.6
  const positionMessage = {
    type: "position",
    rt_id: currentRtId,
    upd: currentTimestamp.replace('T', ' ').substring(0, 17).replace(/\..*$/, ''), // Format timestamp
    date: currentTimestamp.replace('T', ' ').substring(0, 17).replace(/\..*$/, ''),
    lat: lat,
    lng: lng,
    // Check original format: is 'vel' in m/s or km/h? Geolocator gives m/s.
    // Original example: "vel":81.29629516601562 (high, might be m/s or a calculation error in original source)
    // Let's pass the raw velocity for now, you might need to convert: vel: currentVel * 3.6 if output expects km/h
    vel: currentVel // Assuming m/s, adjust if needed
  };
  broadcastToClients(positionMessage);
  console.log(`[${busId}] Sent 'position' message for rt_id ${currentRtId}`);

  // --- Store/Update Bus State ---
  activeBusStates.set(busId, {
    rtId: currentRtId,
    lat, lng, timestamp, velocity,
    lastProcessedVelocity: currentVel,
    lastProcessedTimestamp: currentTimestamp,
    // Add other relevant state variables here if needed
  });
}

// --- Output WebSocket Server (for broadcasting to passenger apps) ---

/**
 * Starts the output WebSocket server for clients (like the Passenger Flutter app).
 */
function startOutputWSServer() {
  // Use the same HTTP server instance from Express if possible (requires more setup)
  // For now, let's assume it runs on a separate port or the same port with different path handled by Express
  // Option 1: Separate port (as before)
  // outputWsServer = new WebSocket.Server({ port: OUTPUT_WS_PORT });

  // Option 2: Integrated with Express (more common for single deployment)
  // This requires passing the HTTP server instance from server.js
  // Let's define the function but don't start it here if it's handled by Express middleware/routing
  console.log(`Output WebSocket server setup logic initialized on port ${OUTPUT_WS_PORT} (or integrated with Express)`);
  // The actual server startup will be handled in server.js where the HTTP server instance is available
}

/**
 * Broadcasts a message to all connected clients on the output WebSocket server.
 * @param {object} message - The message object to send (e.g., {type: 'position', ...}).
 */
function broadcastToClients(message) {
  if (outputWsServer && outputWsServer.clients.size > 0) {
    const messageStr = JSON.stringify(message);
    outputWsServer.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    });
    // console.log('Broadcasted message:', messageStr); // Uncomment for verbose logging
  } else {
    // console.log('No clients connected to output WebSocket, message queued or dropped:', message); // Log only if needed frequently
  }
}

/**
 * Starts the real-time processing service components (currently just the output server setup).
 * The input WebSocket server is now handled by Express routing.
 */
function start(outputServerInstance) { // Accept the WS server instance from Express
  console.log('Initializing real-time processor components...');
  outputWsServer = outputServerInstance; // Assign the server instance
  // startOutputWSServer(); // Called by Express setup now
  console.log(`Output WebSocket broadcasting ready.`);
}

/**
 * Stops the real-time processing service.
 */
function stop() {
  console.log('Stopping real-time processor...');
  if (outputWsServer) {
    outputWsServer.close();
  }
}

// Export the processing function and the start/stop functions
module.exports = { processLocationData, start, stop, broadcastToClients, activeBusStates };