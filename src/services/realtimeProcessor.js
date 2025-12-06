// src/services/realtimeProcessor.js
const WebSocket = require('ws');
const { pool } = require('../config/database'); // Import your DB connection pool

// --- Configuration ---
const PHONE_WS_URL = process.env.PHONE_WS_URL || 'ws://localhost:8080/driver-location-ws'; // URL for the phone app WS server
const OUTPUT_WS_PORT = process.env.REALTIME_WS_PORT || 8081; // Port for the output WS server
const PROCESSING_INTERVAL_MS = 5000; // How often to potentially send 'esta-info' or 'stop' messages

// --- Constants for Direction Detection ---
const MIN_SIGNALS_FOR_DIRECTION = 3; // Minimum number of recent signals needed to attempt direction detection
const MIN_DISTANCE_THRESHOLD_METERS = 50.0; // Minimum distance between consecutive points to consider for bearing calculation
const DIRECTION_MATCH_THRESHOLD_DEGREES = 45.0; // Max angle difference between bus bearing and route bearing to consider a match

// --- In-Memory Storage for Bus States ---
// Key: busId, Value: Object containing rt_id, history of positions, calculated direction, etc.
const activeBusStates = new Map();

// --- WebSocket Clients/Servers ---
let phoneWsClient = null;
let outputWsServer = null;
let outputWsClients = new Set(); // Store connected clients for broadcasting

// --- Helper Functions ---

/**
 * Calculates distance between two lat/lon points using Haversine formula.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Distance in meters
 */
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

/**
 * Calculates the initial bearing (forward azimuth) from point 1 to point 2.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Bearing in degrees (0-360)
 */
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

/**
 * Calculates an average bearing from a sequence of coordinates.
 * Only considers segments longer than MIN_DISTANCE_THRESHOLD_METERS.
 * @param {Array<{lat: number, lon: number}>} coordHistory - Array of coordinate objects [{lat, lon}, ...]
 * @returns {number|null} Average bearing in degrees (0-360) or null if insufficient data.
 */
function calculateAverageBearing(coordHistory) {
  if (coordHistory.length < 2) {
    return null;
  }

  const bearings = [];
  for (let i = 1; i < coordHistory.length; i++) {
    const prevCoord = coordHistory[i - 1];
    const currCoord = coordHistory[i];
    const distance = haversineDistance(prevCoord.lat, prevCoord.lon, currCoord.lat, currCoord.lon);

    if (distance >= MIN_DISTANCE_THRESHOLD_METERS) {
      const bearing = calculateBearing(prevCoord.lat, prevCoord.lon, currCoord.lat, currCoord.lon);
      bearings.push(bearing);
    }
  }

  if (bearings.length === 0) {
    console.log(`[Calculation] Insufficient movement (below ${MIN_DISTANCE_THRESHOLD_METERS}m) in history to calculate bearing.`);
    return null;
  }

  // Calculate average bearing (handling angle wrapping correctly might be complex, simple average often suffices for short distances)
  let sumX = 0, sumY = 0;
  for (const bearing of bearings) {
    sumX += Math.cos(bearing * Math.PI / 180);
    sumY += Math.sin(bearing * Math.PI / 180);
  }
  let avgBearing = Math.atan2(sumY, sumX) * 180 / Math.PI;
  avgBearing = (avgBearing + 360) % 360; // Normalize to 0-360

  console.log(`[Calculation] Calculated average bearing from ${bearings.length} segments: ${avgBearing.toFixed(2)}°`);
  return avgBearing;
}

/**
 * Fetches the ordered list of stops and their coordinates for a given subline ID.
 * @param {number} sublineId - The ID of the subline (rt_id).
 * @returns {Promise<Array<{id: number, cod: string, lat: number, lon: number, nam: string, ref: string, dateNotActive: string}>|null>}
 *          An array of stops in order, or null on error.
 */
async function getOrderedStopsForSubline(sublineId) {
  try {
    const query = `
      SELECT s.id, s.cod, s.lat, s.lon, s.nam, s.ref, s."dateNotActive"
      FROM "Stop" s
      JOIN "SubLineStop" sls ON s.id = sls.stopid
      WHERE sls.sublineid = $1
      ORDER BY sls.stoporder ASC;
    `;
    const result = await pool.query(query, [sublineId]);
    console.log(`[DB Query] Retrieved ${result.rows.length} stops for subline ID ${sublineId}.`);
    return result.rows;
  } catch (error) {
    console.error(`[DB Error] Error fetching stops for subline ID ${sublineId}:`, error);
    return null;
  }
}

/**
 * Determines the most likely subline (rt_id) for a bus based on its recent movement history.
 * This function compares the average bearing derived from the history against the bearing
 * between consecutive stops on potential sublines.
 * @param {string} busId - The unique ID of the bus.
 * @param {Array<{lat: number, lon: number}>} coordHistory - Recent GPS coordinates of the bus.
 * @returns {Promise<number|null>} The matched rt_id (subline.id) or null if no match is found.
 */
async function matchBusToSublineByHistory(busId, coordHistory) {
  console.log(`[${busId}] Attempting to match bus to subline using history (${coordHistory.length} points).`);

  if (coordHistory.length < MIN_SIGNALS_FOR_DIRECTION) {
    console.log(`[${busId}] Not enough history points (${coordHistory.length}) to determine direction. Need at least ${MIN_SIGNALS_FOR_DIRECTION}.`);
    return null;
  }

  const avgBearing = calculateAverageBearing(coordHistory);
  if (avgBearing === null) {
    console.log(`[${busId}] Could not calculate average bearing from history.`);
    return null;
  }

  // --- Fetch Potential Sublines ---
  // This is a simplified approach. You might want to first find nearby sublines based on the bus's current location
  // before comparing bearings, to reduce the number of DB queries and comparisons.
  // For now, let's assume we have a way to get a list of potentially relevant sublines.
  // A more robust method might involve querying sublines based on proximity to the *first* point in the history.

  // Option 1: Fetch *all* sublines (inefficient for large datasets)
  // const allSublinesQuery = `SELECT id FROM "SubLine";`; // Gets all subline IDs

  // Option 2: Fetch sublines based on proximity to the *first* point in the history (more efficient)
  const proximityThresholdMeters = 500; // Adjust as needed
  const firstCoord = coordHistory[0]; // Use the oldest point in the current history window
  const nearbySublinesQuery = `
    SELECT DISTINCT sl.id
    FROM "SubLine" sl
    JOIN "SubLineStop" sls ON sl.id = sls.sublineid
    JOIN "Stop" s ON sls.stopid = s.id
    WHERE ST_DWithin(ST_Point(s.lon, s.lat)::geography, ST_Point($1, $2)::geography, $3);
  `;
  try {
    const nearbySublinesResult = await pool.query(nearbySublinesQuery, [firstCoord.lon, firstCoord.lat, proximityThresholdMeters]);
    const candidateSublineIds = nearbySublinesResult.rows.map(row => row.id);
    console.log(`[${busId}] Found ${candidateSublineIds.length} candidate subline IDs near first history point.`);

    if (candidateSublineIds.length === 0) {
      console.log(`[${busId}] No candidate sublines found near the initial history point (${firstCoord.lat}, ${firstCoord.lon}).`);
      return null;
    }

    // --- Compare Bearings ---
    let bestMatchSublineId = null;
    let bestMatchScore = -Infinity; // Higher score is better

    for (const sublineId of candidateSublineIds) {
      console.log(`[${busId}] Evaluating candidate subline ID: ${sublineId}`);
      const stopsForSubline = await getOrderedStopsForSubline(sublineId);
      if (!stopsForSubline || stopsForSubline.length < 2) {
        console.log(`[${busId}] Subline ${sublineId} has fewer than 2 stops, skipping.`);
        continue;
      }

      // Iterate through consecutive stop pairs on this subline
      for (let i = 0; i < stopsForSubline.length - 1; i++) {
        const stopA = stopsForSubline[i];
        const stopB = stopsForSubline[i + 1];

        // Calculate the bearing from Stop A to Stop B on this subline
        const routeBearing = calculateBearing(stopA.lat, stopA.lon, stopB.lat, stopB.lon);

        // Calculate the angular difference between the bus's average bearing and the route segment bearing
        // Use the shortest angular distance (accounting for 0/360 wrap-around)
        let angleDiff = Math.abs(avgBearing - routeBearing);
        angleDiff = Math.min(angleDiff, 360 - angleDiff);

        console.log(`[${busId}]   Segment ${stopA.id} -> ${stopB.id} (Subline ${sublineId}): Route Bearing = ${routeBearing.toFixed(2)}°, Diff = ${angleDiff.toFixed(2)}°`);

        // Check if the bearing difference is within the acceptable threshold
        if (angleDiff <= DIRECTION_MATCH_THRESHOLD_DEGREES) {
          // A simple scoring mechanism: score based on closeness to the route bearing
          // A more complex score could incorporate distance to the stops or the segment itself
          const score = DIRECTION_MATCH_THRESHOLD_DEGREES - angleDiff; // Higher score for smaller difference

          if (score > bestMatchScore) {
            bestMatchScore = score;
            bestMatchSublineId = sublineId;
            console.log(`[${busId}]     Potential match found! Subline: ${sublineId}, Score: ${score.toFixed(2)}, Avg Bearing: ${avgBearing.toFixed(2)}°, Segment Bearing: ${routeBearing.toFixed(2)}°, Diff: ${angleDiff.toFixed(2)}°`);
          }
        } else {
             console.log(`[${busId}]     Segment bearing (${routeBearing.toFixed(2)}°) does not match bus bearing (${avgBearing.toFixed(2)}°) within threshold (${DIRECTION_MATCH_THRESHOLD_DEGREES}°). Diff: ${angleDiff.toFixed(2)}°`);
        }
      }
    }

    if (bestMatchSublineId !== null) {
      console.log(`[${busId}] Matched to subline ID (rt_id) based on historical bearing: ${bestMatchSublineId} (Best Score: ${bestMatchScore.toFixed(2)})`);
      return bestMatchSublineId;
    } else {
      console.log(`[${busId}] Could not determine best matching subline from ${candidateSublineIds.length} candidates based on historical bearing and threshold of ${DIRECTION_MATCH_THRESHOLD_DEGREES}°.`);
      return null;
    }

  } catch (error) {
    console.error(`[${busId}] Error during history-based subline matching:`, error);
    return null;
  }
}


// --- Processing Logic ---

/**
 * Processes the raw location data received from the phone app.
 * Determines rt_id based on historical movement, calculates estimates, detects stops, and formats output.
 * @param {object} rawData - The raw data object received from the phone (e.g., {routeId, busId, lat, lng, timestamp, velocity}).
 */
async function processLocationData(rawData) {
  const { routeId, busId, lat, lng, timestamp, velocity } = rawData;
  const currentTimestamp = new Date(timestamp).toISOString(); // Ensure consistent timestamp format
  const currentLat = lat;
  const currentLng = lng;
  const currentVel = velocity; // Assuming velocity is in m/s from Geolocator
  console.log(`[${busId}] Received raw location data: Lat=${currentLat}, Lng=${currentLng}, Vel=${currentVel}, TS=${currentTimestamp}`);

  // --- Retrieve/Initialize Bus State ---
  let busState = activeBusStates.get(busId) || {
    history: [], // Store recent coordinates
    rtId: null, // Store the determined rt_id (subline ID)
    lastProcessedRtId: null, // Store the previous rt_id for change detection
    lastProcessedTimestamp: null,
    // Add other state variables if needed
  };

  // --- Update History ---
  // Add the new location to the history
  busState.history.push({ lat: currentLat, lng: currentLng, timestamp: currentTimestamp });
  // Keep only the last N points (e.g., 5) to manage memory and focus on recent movement
  const HISTORY_SIZE = 5;
  if (busState.history.length > HISTORY_SIZE) {
    busState.history = busState.history.slice(-HISTORY_SIZE);
  }
  console.log(`[${busId}] Updated history. Current history size: ${busState.history.length}`);

  // --- Determine rt_id (Subline ID) using History ---
  let currentRtId = busState.rtId; // Start with the previously determined ID
  let previousRtId = busState.lastProcessedRtId; // Store the ID from the *last processed* message for change detection

  // Only attempt to determine/reconfirm rt_id if we have enough history
  if (busState.history.length >= MIN_SIGNALS_FOR_DIRECTION) {
    console.log(`[${busId}] History size (${busState.history.length}) meets minimum requirement (${MIN_SIGNALS_FOR_DIRECTION}). Attempting to determine/reconfirm rt_id.`);
    const newlyMatchedRtId = await matchBusToSublineByHistory(busId, [...busState.history]); // Pass a copy to avoid mutation during async op

    if (newlyMatchedRtId !== null) {
      if (currentRtId === null) {
        // First time an rt_id is determined for this bus instance
        currentRtId = newlyMatchedRtId;
        console.log(`[${busId}] First rt_id determined: ${currentRtId}`);
      } else if (currentRtId !== newlyMatchedRtId) {
        // Detected a potential route change
        console.log(`[${busId}] Potential route change detected! Previous rt_id: ${currentRtId}, New match: ${newlyMatchedRtId}.`);
        // For now, let's update the rt_id. You might want more sophisticated logic here
        // (e.g., require multiple consecutive matches for a new rt_id before switching).
        currentRtId = newlyMatchedRtId;
      } else {
        // Match confirmed, rt_id remains the same
        console.log(`[${busId}] rt_id confirmed as ${currentRtId} based on history.`);
      }
    } else {
        console.log(`[${busId}] History-based matching returned null. Keeping previous rt_id: ${currentRtId}`);
        // Keep the currentRtId as is if matching failed.
    }
  } else {
    console.log(`[${busId}] Not enough history yet (${busState.history.length}) to determine rt_id. Keeping previous rt_id: ${currentRtId}`);
  }

  // --- Handle Route Changes (Send 'close' for old route) ---
  if (previousRtId && previousRtId !== currentRtId) {
    console.log(`[${busId}] Confirmed route change from rt_id ${previousRtId} to ${currentRtId}. Sending 'close' for old route.`);
    const closeMessage = {
      type: "close",
      rt_id: previousRtId, // Use the old rt_id
      upd: busState.lastProcessedTimestamp ? new Date(busState.lastProcessedTimestamp).toISOString().replace('T', ' ').substring(0, 19).replace(/\..*$/, '') : currentTimestamp.replace('T', ' ').substring(0, 19).replace(/\..*$/, ''), // Format timestamp
      date: busState.lastProcessedTimestamp ? new Date(busState.lastProcessedTimestamp).toISOString().replace('T', ' ').substring(0, 19).replace(/\..*$/, '') : currentTimestamp.replace('T', ' ').substring(0, 19).replace(/\..*$/, ''),
      del: 0, // Delay (placeholder)
      pass: "0", // Passengers (placeholder)
      lat: busState.history[busState.history.length - 2]?.lat || currentLat, // Use previous known lat if available, otherwise current
      lng: busState.history[busState.history.length - 2]?.lng || currentLng, // Use previous known lng if available, otherwise current
      stop_id: 0, // Placeholder
      stop_code: "-", // Placeholder
      stop_nam: "-" // Placeholder
    };
    broadcastToClients(closeMessage);
    console.log(`[${busId}] Sent 'close' message for old rt_id ${previousRtId}`);
  }


  // --- Format and Send 'position' message (if rt_id is known) ---
  if (currentRtId !== null) {
    const positionMessage = {
      type: "position",
      rt_id: currentRtId,
      upd: currentTimestamp.replace('T', ' ').substring(0, 19).replace(/\..*$/, ''), // Format timestamp (e.g., "20251113 181255")
      date: currentTimestamp.replace('T', ' ').substring(0, 19).replace(/\..*$/, ''), // Format timestamp
      lat: currentLat,
      lng: currentLng,
      vel: currentVel * 3.6 // Convert m/s (Geolocator) to km/h if expected by frontend
    };
    broadcastToClients(positionMessage);
    console.log(`[${busId}] Sent 'position' message for rt_id ${currentRtId} at (${currentLat}, ${currentLng})`);
  } else {
    console.log(`[${busId}] rt_id is unknown, skipping 'position' message.`);
  }


  // --- Store/Update Bus State ---
  // Update the state with the new rt_id and history
  busState.rtId = currentRtId;
  busState.lastProcessedRtId = currentRtId; // Update the ID used for *next* change detection
  busState.lastProcessedTimestamp = currentTimestamp; // Update the timestamp used for *next* message
  activeBusStates.set(busId, busState);

  console.log(`[${busId}] Finished processing location data. Current rt_id: ${currentRtId}, History length: ${busState.history.length}.`);
}


// --- Output WebSocket Server (for broadcasting to passenger apps) ---

/**
 * Starts the output WebSocket server for clients (like the Passenger Flutter app).
 */
function startOutputWSServer() {
  outputWsServer = new WebSocket.Server({ port: OUTPUT_WS_PORT });

  outputWsServer.on('connection', (ws) => {
    console.log('Client connected to output WebSocket server.');
    outputWsClients.add(ws);

    ws.on('close', () => {
      console.log('Client disconnected from output WebSocket server.');
      outputWsClients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('Error in output WebSocket client connection:', error);
      outputWsClients.delete(ws); // Remove client on error
    });

    // Optionally, send a welcome message or initial data if applicable
    // ws.send(JSON.stringify({ type: 'connected', message: 'Connected to real-time data feed' }));
  });

  console.log(`Output WebSocket server listening on port ${OUTPUT_WS_PORT}`);
}

/**
 * Broadcasts a message to all connected clients on the output WebSocket server.
 * @param {object} message - The message object to send (e.g., {type: 'position', rt_id: 123, ...}).
 */
function broadcastToClients(message) {
  if (outputWsServer && outputWsClients.size > 0) {
    const messageStr = JSON.stringify(message);
    outputWsClients.forEach((client) => {
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
 * Starts the entire real-time processing service.
 */
function start() {
  console.log('Starting real-time processor...');
  startOutputWSServer();
  // The phoneWsClient connection logic remains as before, ideally called after the output server starts
  // connectToPhoneWS(); // Call this if you manage the phone connection separately or after server is ready
}

/**
 * Stops the real-time processing service.
 */
function stop() {
  console.log('Stopping real-time processor...');
  if (phoneWsClient) {
    phoneWsClient.close();
  }
  if (outputWsServer) {
    outputWsServer.close(() => {
      console.log('Output WebSocket server closed.');
    });
    outputWsClients.clear(); // Clear the client set
  }
}

// Export functions if needed elsewhere
module.exports = { start, stop, processLocationData, broadcastToClients, activeBusStates };