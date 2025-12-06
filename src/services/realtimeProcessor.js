// src/services/realtimeProcessor.js
const WebSocket = require('ws');
const { pool } = require('../config/database'); // Import your DB connection pool

// --- Configuration ---
const PHONE_WS_URL = process.env.PHONE_WS_URL || 'ws://localhost:8080/driver-location-ws'; // URL for the phone app WS server
const OUTPUT_WS_PORT = process.env.REALTIME_WS_PORT || 8081; // Port for the output WS server
const PROCESSING_INTERVAL_MS = 5000; // How often to potentially send 'esta-info' or 'stop' messages

// --- In-Memory Storage for Bus States ---
// Key: busId, Value: Object containing rt_id, currentPos, currentVel, lastProcessedTimestamp, upcomingStops, etc.
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
 * Matches a bus's GPS location to the most likely subline (rt_id) based on stop proximity and sequence.
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
    // Find all stops within the proximity threshold using ST_DWithin for efficiency
    // Note: ST_DWithin requires PostGIS. Ensure it's enabled on your Neon DB.
    const nearbyStopsQuery = `
      SELECT id, cod, lat, lon
      FROM "Stop"
      WHERE ST_DWithin(ST_Point(lon, lat)::geography, ST_Point($1, $2)::geography, $3)
      ORDER BY ST_Distance(ST_Point(lon, lat)::geography, ST_Point($1, $2)::geography) ASC;
    `;
    const nearbyStopsResult = await pool.query(nearbyStopsQuery, [lon, lat, proximityThresholdMeters]);

    if (nearbyStopsResult.rows.length === 0) {
      console.log(`[${busId}] No stops found near current location (${lat}, ${lon}) within ${proximityThresholdMeters}m.`);
      return null;
    }

    console.log(`[${busId}] Found ${nearbyStopsResult.rows.length} nearby stops.`);

    // For each nearby stop, find the associated sublines and their stop orders
    const potentialSublines = new Map(); // Key: sublineId, Value: Array of {stopId, distanceToStop, stopOrder}

    for (const stop of nearbyStopsResult.rows) {
      const stopDistance = haversineDistance(lat, lon, stop.lat, stop.lon); // Fallback Haversine if needed

      // Find sublines that include this stop and get the stop's order on that subline
      const sublinesForStopQuery = `
        SELECT sl.id AS subline_id, sls.stoporder
        FROM "SubLineStop" sls
        JOIN "SubLine" sl ON sls.sublineid = sl.id
        WHERE sls.stopid = $1
        ORDER BY sls.stoporder; -- Get the order of the stop within the subline
      `;
      const sublinesResult = await pool.query(sublinesForStopQuery, [stop.id]);

      for (const sublineRow of sublinesResult.rows) {
        if (!potentialSublines.has(sublineRow.subline_id)) {
          potentialSublines.set(sublineRow.subline_id, []);
        }
        potentialSublines.get(sublineRow.subline_id).push({
          stopId: stop.id,
          distanceToStop: stopDistance, // Haversine distance (fallback)
          stopOrder: sublineRow.stoporder,
          stopLat: stop.lat, // Include coordinates for potential heading check later
          stopLon: stop.lon,
        });
      }
    }

    if (potentialSublines.size === 0) {
      console.log(`[${busId}] Nearby stops found, but none belong to known sublines.`);
      return null;
    }

    // Determine the most likely subline
    // Strategy: Prioritize sublines where the closest stop has a lower order number,
    // suggesting the bus is earlier in the journey on that specific directional route.
    let bestMatchSublineId = null;
    let bestMatchScore = Infinity; // Lower score is better

    for (const [sublineId, stopDetailsList] of potentialSublines.entries()) {
      // Find the closest stop for *this specific subline*
      let closestStopOnSubline = null;
      let minDistanceOnSubline = Infinity;

      for (const stopDetail of stopDetailsList) {
        if (stopDetail.distanceToStop < minDistanceOnSubline) {
          minDistanceOnSubline = stopDetail.distanceToStop;
          closestStopOnSubline = stopDetail;
        }
      }

      if (closestStopOnSubline) {
        // Score based on distance to the closest stop AND its order (earlier in route is better if distance is similar)
        // Simple scoring: distance + (order * penalty_factor)
        const orderPenaltyFactor = 100; // Adjust this factor relative to distance units
        const score = minDistanceOnSubline + (closestStopOnSubline.stopOrder * orderPenaltyFactor);

        if (score < bestMatchScore) {
          bestMatchSublineId = sublineId;
          bestMatchScore = score;
        }
      }
    }

    if (bestMatchSublineId !== null) {
      console.log(`[${busId}] Matched to subline ID (rt_id): ${bestMatchSublineId} (Score: ${bestMatchScore.toFixed(2)})`);
      return bestMatchSublineId; // This is the rt_id
    } else {
      console.log(`[${busId}] Could not determine best matching subline from candidates.`);
      return null;
    }

  } catch (error) {
    console.error(`[${busId}] Error matching bus to subline:`, error);
    return null;
  }
}

/**
 * Determines the upcoming stops for a bus on a specific subline, starting from the stop *after* its current closest stop.
 * @param {number} rt_id - The ID of the subline.
 * @param {number} currentLat - The bus's current latitude.
 * @param {number} currentLon - The bus's current longitude.
 * @returns {Promise<Array<Object>>} An array of upcoming stop objects [{id, cod, lat, lon, nam, ref, distanceToNext, estimatedTimeToNext}, ...] or an empty array.
 */
async function getUpcomingStopsForSubline(rt_id, currentLat, currentLon) {
  try {
    console.log(`Fetching stops for rt_id: ${rt_id}`);

    // Get all stops for the specific subline, ordered by their sequence (stoporder)
    const stopsOnSublineQuery = `
      SELECT s.id, s.cod, s.lat, s.lon, s.nam, s.ref
      FROM "Stop" s
      JOIN "SubLineStop" sls ON s.id = sls.stopid
      JOIN "SubLine" sl ON sls.sublineid = sl.id
      WHERE sl.id = $1
      ORDER BY sls.stoporder ASC;
    `;
    const stopsResult = await pool.query(stopsOnSublineQuery, [rt_id]);

    const allStopsOnSubline = stopsResult.rows;
    console.log(`Found ${allStopsOnSubline.length} stops on subline ${rt_id}`);

    if (allStopsOnSubline.length === 0) {
      console.log(`No stops found for rt_id ${rt_id}.`);
      return [];
    }

    // Find the stop on this subline that is closest to the bus's current position
    let closestStopIndex = -1;
    let minDistance = Infinity;

    for (let i = 0; i < allStopsOnSubline.length; i++) {
      const stop = allStopsOnSubline[i];
      const distance = haversineDistance(currentLat, currentLon, stop.lat, stop.lon);

      if (distance < minDistance) {
        minDistance = distance;
        closestStopIndex = i;
      }
    }

    if (closestStopIndex === -1) {
      console.error(`Could not find any stop on rt_id ${rt_id} near current location (${currentLat}, ${currentLon}). This is unexpected after a successful match.`);
      return [];
    }

    console.log(`Closest stop index on subline ${rt_id} is ${closestStopIndex} (${allStopsOnSubline[closestStopIndex].nam}, dist: ${minDistance.toFixed(2)}m)`);

    // The upcoming stops are those *after* the closest stop in the sequence
    const upcomingStops = allStopsOnSubline.slice(closestStopIndex + 1);

    console.log(`Identified ${upcomingStops.length} upcoming stops for rt_id ${rt_id}.`);

    // Optional: Add distance/estimated time calculations here if needed by the frontend
    // This requires knowing the bus's current speed and potentially route geometry.
    // For now, just return the list of upcoming stops in order.
    return upcomingStops.map(stop => ({
      stop_id: stop.id,
      stop_code: stop.cod,
      stop_nam: stop.nam,
      // Add ref, lat, lon if the frontend needs them for display
      ref: stop.ref,
      lat: stop.lat,
      lon: stop.lon,
      // Add placeholder for distance/time if calculated later
      // distance_to_next: null,
      // estimated_time_to_next: null,
    }));

  } catch (error) {
    console.error(`Error fetching or processing upcoming stops for rt_id ${rt_id}:`, error);
    return []; // Return an empty list on error
  }
}


// --- Processing Logic ---

/**
 * Processes the raw location data received from the phone app.
 * Determines rt_id, calculates estimates, detects stops, and formats output.
 * @param {object} rawData - The raw data object received from the phone (e.g., {routeId, busId, lat, lng, timestamp, velocity}).
 */
async function processLocationData(rawData) {
  const { routeId, busId, lat, lng, timestamp, velocity } = rawData;
  console.log(`[${busId}] Received raw location data: Lat=${lat}, Lng=${lng}, Vel=${velocity}, TS=${timestamp}`);

  let currentRtId = null;
  let previousState = activeBusStates.get(busId) || null;
  let previousRtId = previousState ? previousState.rtId : null;
  let currentPos = { lat, lng };
  let currentVel = velocity; // Assuming velocity is in m/s from Geolocator
  let currentTimestamp = timestamp; // Assuming timestamp is an ISO string from Geolocator

  // --- Determine/Confirm rt_id (Subline ID) ---
  // Use the matchBusToSubline function to find the most likely subline for the current position.
  currentRtId = await matchBusToSubline(busId, lat, lng, velocity);

  if (currentRtId === null) {
    console.warn(`[${busId}] Could not determine rt_id for current location. Cannot process further.`);
    // Update state with new data but rt_id remains null or previous
    activeBusStates.set(busId, {
      ...previousState, // Carry over previous state if any
      lat, lng, timestamp, velocity, rtId: previousRtId // Keep previous rt_id if couldn't determine new one
    });
    return; // Exit processing if rt_id cannot be determined
  }

  // --- Check for Route Change (Subline Change) ---
  // If the determined rt_id is different from the previous one, send a 'close' message for the old route
  // and potentially a 'position' message for the new one.
  if (previousState && previousState.rtId && previousState.rtId !== currentRtId) {
    console.log(`[${busId}] Detected route change from rt_id ${previousState.rtId} to ${currentRtId}.`);

    // 1. Send 'close' message for the old rt_id
    const closeMessage = {
      type: "close",
      rt_id: previousState.rtId,
      // Use the timestamp from the state *before* the change
      upd: previousState.timestamp ? new Date(previousState.timestamp).toISOString().replace('T', ' ').substring(0, 19) : new Date().toISOString().replace('T', ' ').substring(0, 19),
      date: previousState.timestamp ? new Date(previousState.timestamp).toISOString().replace('T', ' ').substring(0, 19) : new Date().toISOString().replace('T', ' ').substring(0, 19),
      del: 0, // Delay (placeholder)
      pass: "0", // Passengers (placeholder)
      lat: previousState.lat,
      lng: previousState.lng,
      stop_id: 0, // Placeholder
      stop_code: "-", // Placeholder
      stop_nam: "-" // Placeholder
    };
    broadcastToClients(closeMessage);
    console.log(`[${busId}] Sent 'close' message for old rt_id ${previousState.rtId}`);

    // 2. Optionally, send an initial 'position' message for the new rt_id
    // This might not always be necessary depending on how the frontend handles new connections after a close.
    // For now, let's send it to ensure the new position is known.
    const initialPositionMessage = {
      type: "position",
      rt_id: currentRtId,
      upd: new Date(currentTimestamp).toISOString().replace('T', ' ').substring(0, 19), // Format timestamp
      date: new Date(currentTimestamp).toISOString().replace('T', ' ').substring(0, 19),
      lat: lat,
      lng: lng,
      vel: currentVel * 3.6 // Convert m/s to km/h if expected by frontend
    };
    broadcastToClients(initialPositionMessage);
    console.log(`[${busId}] Sent initial 'position' message for new rt_id ${currentRtId}`);
  } else if (!previousState || !previousState.rtId) {
     // If this is the first time seeing this bus, send an initial 'position' message
     const initialPositionMessage = {
      type: "position",
      rt_id: currentRtId,
      upd: new Date(currentTimestamp).toISOString().replace('T', ' ').substring(0, 19), // Format timestamp
      date: new Date(currentTimestamp).toISOString().replace('T', ' ').substring(0, 19),
      lat: lat,
      lng: lng,
      vel: currentVel * 3.6 // Convert m/s to km/h if expected by frontend
    };
    broadcastToClients(initialPositionMessage);
    console.log(`[${busId}] Sent initial 'position' message for new bus on rt_id ${currentRtId}`);
  }


  // --- Determine Upcoming Stops for the Current rt_id ---
  // Call the new function to get the list of stops coming up on the current subline
  const upcomingStops = await getUpcomingStopsForSubline(currentRtId, lat, lng);
  console.log(`[${busId}] Upcoming stops for rt_id ${currentRtId}:`, upcomingStops.map(s => s.stop_nam)); // Log just names for brevity


  // --- Format and Send 'esta-info' message (if upcoming stops exist) ---
  if (upcomingStops.length > 0) {
    // Take the *first* upcoming stop as the primary one for 'esta-info'
    const nextStop = upcomingStops[0];
    // Calculate distance to the *next* stop (simplified, using haversine)
    const distanceToNext = haversineDistance(lat, lng, nextStop.lat, nextStop.lon);
    // Calculate estimated time to next stop (simplified: time = distance / speed)
    // Ensure speed is in m/s for this calculation. vel from Geolocator is m/s.
    // If currentVel is 0, estimation is impossible, set time to null or a large value.
    let estimatedTimeToNext = null;
    if (currentVel > 0) {
        // Distance in meters, speed in m/s -> time in seconds
        const timeInSeconds = distanceToNext / currentVel;
        // Add this time to the current timestamp to get an estimated arrival time
        estimatedTimeToNext = new Date(Date.now() + timeInSeconds * 1000).toISOString().replace('T', ' ').substring(0, 19);
    }

    const estaInfoMessage = {
      type: "esta-info",
      rt_id: currentRtId,
      upd: new Date(currentTimestamp).toISOString().replace('T', ' ').substring(0, 19), // Format timestamp
      date: new Date(currentTimestamp).toISOString().replace('T', ' ').substring(0, 19),
      stops: [
        {
          stop_id: nextStop.stop_id,
          stop_code: nextStop.stop_code,
          stop_nam: nextStop.stop_nam,
          arr_t: "", // Scheduled arrival time (if available from stop data, otherwise "")
          // Use the calculated distance and estimated time
          esta_dist: distanceToNext, // Distance in meters
          esta_time: estimatedTimeToNext, // Estimated arrival time string
          // Add other fields if required by the frontend format
          // Example: pass (passengers alighting? Estimated?), del (delay? Calculated?)
          pass: 0, // Placeholder
          del: 0, // Placeholder (could be calculated based on schedule if available)
        }
      ],
      // Include current bus position and potentially stats (cap, pas) if available
      pos: {
        lat: lat,
        lng: lng,
        vel: currentVel * 3.6, // Convert m/s to km/h
        time: new Date(currentTimestamp).toISOString().replace('T', ' ').substring(0, 19) // Format timestamp
      },
      bus: {
        pas: 0, // Placeholder - get from phone app data if available
        cap: 50, // Placeholder - get from route/subline data if available
        cap_seated: 30, // Placeholder
        cap_standing: 20, // Placeholder
      }
    };
    broadcastToClients(estaInfoMessage);
    console.log(`[${busId}] Sent 'esta-info' message for rt_id ${currentRtId}, next stop: ${nextStop.stop_nam}`);
  } else {
    console.log(`[${busId}] No upcoming stops found for rt_id ${currentRtId} at this location.`);
    // Depending on requirements, you might still send an 'esta-info' with an empty stops array
    // or perhaps a 'stop' message if the bus seems to be at the end of the line.
    // For now, we just log and continue.
  }


  // --- Store/Update Bus State ---
  // Store the latest known state for this bus, including the determined rt_id and upcoming stops.
  activeBusStates.set(busId, {
    rtId: currentRtId,
    lat, lng, timestamp, velocity,
    lastProcessedTimestamp: currentTimestamp,
    // Store the list of upcoming stops for potential later use (e.g., detecting arrival/departure)
    upcomingStops: upcomingStops,
    // Store the closest stop seen *on this subline* for potential stop detection logic
    closestSublineStopIndex: activeBusStates.get(busId)?.closestSublineStopIndex || 0, // Initialize if needed
    // Add other relevant state variables here if needed
  });

  // --- Detect Stops and Send 'stop' Messages (Basic Example) ---
  // This is a simplified check: if speed is very low (< 1 m/s) and close to a known stop on the current subline,
  // consider it a stop event.
  // A more robust system might track proximity over time or use acceleration data.
  if (Math.abs(currentVel) < 1.0) { // Threshold for "stopped" (1 m/s = ~3.6 km/h)
    const allStopsOnCurrentSublineQuery = `
      SELECT s.id, s.cod, s.lat, s.lon, s.nam, s.ref, sls.stoporder
      FROM "Stop" s
      JOIN "SubLineStop" sls ON s.id = sls.stopid
      JOIN "SubLine" sl ON sls.sublineid = sl.id
      WHERE sl.id = $1
      ORDER BY sls.stoporder ASC;
    `;
    const allStopsResult = await pool.query(allStopsOnCurrentSublineQuery, [currentRtId]);
    const allStopsOnCurrentSubline = allStopsResult.rows;

    let closestStopOnRoute = null;
    let minStopDistance = Infinity;
    for (const stop of allStopsOnCurrentSubline) {
      const distance = haversineDistance(lat, lng, stop.lat, stop.lon);
      if (distance < minStopDistance) {
        minStopDistance = distance;
        closestStopOnRoute = stop;
      }
    }

    // Define a distance threshold for considering the bus "at" a stop (e.g., 50 meters)
    const stopDetectionThresholdMeters = 50;

    if (closestStopOnRoute && minStopDistance <= stopDetectionThresholdMeters) {
      console.log(`[${busId}] Bus appears stopped near stop ${closestStopOnRoute.nam} (ID: ${closestStopOnRoute.id}, Dist: ${minStopDistance.toFixed(2)}m). Sending 'stop' message.`);

      const stopMessage = {
        type: "stop",
        rt_id: currentRtId,
        upd: new Date(currentTimestamp).toISOString().replace('T', ' ').substring(0, 19), // Format timestamp
        date: new Date(currentTimestamp).toISOString().replace('T', ' ').substring(0, 19),
        lat: lat,
        lng: lng,
        vel: currentVel * 3.6, // Convert m/s to km/h
        del: 0, // Placeholder
        pass: 0, // Placeholder - get from phone app data if available
        stop_id: closestStopOnRoute.id,
        stop_code: closestStopOnRoute.cod,
        stop_nam: closestStopOnRoute.nam,
        arr_t: "", // Scheduled arrival time (if available)
        arr_rt: new Date(currentTimestamp).toISOString().replace('T', ' ').substring(0, 19), // Real-time arrival
        stp_rt: "", // Scheduled stop time (if applicable)
        dep_rt: ""  // Scheduled departure time (if applicable)
      };

      broadcastToClients(stopMessage);
      console.log(`[${busId}] Sent 'stop' message for rt_id ${currentRtId}, stop: ${closestStopOnRoute.nam} (${closestStopOnRoute.id})`);
    }
  }

  console.log(`[${busId}] Finished processing location data for rt_id ${currentRtId}.`);
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