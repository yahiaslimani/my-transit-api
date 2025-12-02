// src/services/realtimeProcessor.js
const WebSocket = require('ws');
const { pool } = require('../config/database'); // Import your DB connection pool

// --- Configuration ---
const PHONE_WS_URL = 'wss://nodejsserver-ek8l.onrender.com/'; // Driver phone app WS URL
const OUTPUT_WS_PORT = process.env.REALTIME_WS_PORT || 8081; // Port for your new output WS server
const PROCESSING_INTERVAL_MS = 5000; // How often to process data and potentially send updates (e.g., for 'esta-info')

// --- In-Memory Storage for Bus States ---
// Key: busId, Value: Object containing latest position, calculated rt_id, etc.
const activeBusStates = new Map();

// --- WebSocket Clients/Servers ---
let phoneWsClient = null;
let outputWsServer = null;

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
 * Calculates bearing from point 1 to point 2.
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
    // 1. Find all stops within the proximity threshold
    // This query finds stops close to the bus's current location.
    // Note: This uses PostGIS ST_DistanceSphere for accurate distance calculation.
    // Ensure PostGIS is enabled in your Neon database.
    const nearbyStopsQuery = `
      SELECT id, cod, lat, lon
      FROM "Stop"
      WHERE ST_DistanceSphere(ST_Point(lon, lat), ST_Point($1, $2)) < $3
      ORDER BY ST_DistanceSphere(ST_Point(lon, lat), ST_Point($1, $2)) ASC;
    `;
    const nearbyStopsResult = await pool.query(nearbyStopsQuery, [lon, lat, proximityThresholdMeters]);

    if (nearbyStopsResult.rows.length === 0) {
      console.log(`[${busId}] No stops found near current location (${lat}, ${lon}).`);
      return null;
    }

    // 2. For each nearby stop, find the associated sublines
    const potentialSublines = new Map(); // Key: sublineId, Value: {stopId, distanceToStop}

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
        potentialSublines.set(sublineRow.subline_id, {
          stopId: stop.id,
          distanceToStop: stopDistance,
          stopOrder: sublineRow.stoporder // Store order for later use
        });
      }
    }

    if (potentialSublines.size === 0) {
      console.log(`[${busId}] Nearby stops (${nearbyStopsResult.rows.length}) found, but none belong to known sublines.`);
      return null;
    }

    // 3. Determine the most likely subline based on sequence and movement
    // For now, prioritize the closest stop's subline with the lowest order (closer to start of route)
    // This is a simplification. A more robust method would involve path matching and checking the *next* stop in sequence.
    let bestMatchSublineId = null;
    let bestMatchDistance = Infinity;
    let bestMatchOrder = Infinity;

    for (const [sublineId, details] of potentialSublines.entries()) {
      // Prioritize based on distance to the stop and the order of the stop in the sequence
      // A lower stop order might indicate the bus is earlier in the route direction.
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


// --- Processing Logic ---

/**
 * Processes the raw location data received from the phone app.
 * Determines rt_id, calculates estimates, detects stops, and formats output.
 * @param {object} rawData - The raw data object received from the phone (e.g., {routeId, busId, lat, lng, timestamp, velocity}).
 */
async function processLocationData(rawData) {
  const { routeId, busId, lat, lng, timestamp, velocity } = rawData;
  console.log(`[${busId}] Received raw data: Lat=${lat}, Lng=${lng}, Vel=${velocity}, TS=${timestamp}`);

  let currentRtId = null;
  let previousRtId = null;
  let currentPos = { lat, lng };
  let currentVel = velocity;
  let currentTimestamp = timestamp;

  // Get previous state if available
  const previousState = activeBusStates.get(busId);
  if (previousState) {
    previousRtId = previousState.rtId;
    // Consider updating the previous state's timestamp/position if needed for calculations
  }

  // --- Determine/Confirm rt_id (Subline ID) ---
  // Use the matchBusToSubline function to find the most likely subline for the current position.
  // This function needs to be async as it queries the database.
  currentRtId = await matchBusToSubline(busId, lat, lng, velocity);

  if (currentRtId === null) {
    console.warn(`[${busId}] Could not determine rt_id for current location. Cannot process further.`);
    // Decide: Should we still store the state without an rt_id? Or skip?
    // For now, let's store what we have, but rt_id will be null.
    activeBusStates.set(busId, {
      ...previousState, // Carry over previous state if any
      lat, lng, timestamp, velocity, rtId: null // Update with new data, rt_id is null
    });
    return; // Exit processing if rt_id cannot be determined
  }


  // --- Check for Route Change ---
  // If the determined rt_id is different from the previous one, send a 'close' for the old one
  // and potentially a 'position' for the new one.
  if (previousRtId && previousRtId !== currentRtId) {
    console.log(`[${busId}] Detected route change from rt_id ${previousRtId} to ${currentRtId}. Sending 'close' for old route.`);
    const closeMessage = {
      type: "close",
      rt_id: previousRtId,
      upd: currentTimestamp.replace('T', ' ').substring(0, 17).replace(/\..*$/, ''), // Format timestamp
      date: currentTimestamp.replace('T', ' ').substring(0, 17).replace(/\..*$/, ''),
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
  const positionMessage = {
    type: "position",
    rt_id: currentRtId,
    upd: currentTimestamp.replace('T', ' ').substring(0, 17).replace(/\..*$/, ''), // Format timestamp
    date: currentTimestamp.replace('T', ' ').substring(0, 17).replace(/\..*$/, ''),
    lat: lat,
    lng: lng,
    vel: currentVel // Ensure velocity is in km/h if expected, geolocator returns m/s
  };
  broadcastToClients(positionMessage);
  console.log(`[${busId}] Sent 'position' message for rt_id ${currentRtId}`);


  // --- Store/Update Bus State ---
  // Store the latest known state for this bus, including the determined rt_id.
  // This state will be used for subsequent processing (e.g., 'esta-info', 'stop' detection).
  activeBusStates.set(busId, {
    rtId: currentRtId,
    lat, lng, timestamp, velocity,
    lastProcessedPosition: currentPos, // Store for future comparisons if needed
    lastProcessedVelocity: currentVel,
    lastProcessedTimestamp: currentTimestamp,
    // Add other relevant state variables here if needed (e.g., last known stop, next stop)
  });

  // --- Detect Stops and Estimate Arrival (Potential Future Enhancement) ---
  // This would require comparing the current position/speed to known stops on the current rt_id's path
  // and checking if the bus is stationary/near a stop for a certain duration (stop detection)
  // or calculating time/distance to the next stop based on current speed (esta-info).
  // This is complex and might be handled in a separate periodic task or triggered by specific conditions.

}


// --- WebSocket Connections ---

/**
 * Connects to the driver's phone app WebSocket.
 */
function connectToPhoneWS() {
  console.log('Connecting to phone app WebSocket at:', PHONE_WS_URL);
  phoneWsClient = new WebSocket(PHONE_WS_URL);

  phoneWsClient.on('open', () => {
    console.log('Connected to phone app WebSocket.');
  });

  phoneWsClient.on('message', (data) => {
    try {
      // Expecting data from the phone app as a stringified object like "{...}"
      // The Flutter app sends: locationData.toString().replaceAll("'", '"')
      // Which results in a string like '{"routeId":1,"busId":"BUS456","lat":39.544647216796875,"lng":2.574617385864258,"timestamp":"2025-11-13T18:12:55.123Z","velocity":22.583333333333332}'
      // We need to parse this string to get the object.
      const messageStr = data.toString();
      console.log('Raw message received from phone app:', messageStr);

      // Attempt to parse the stringified object
      // Note: The Flutter app sends the *toString()* representation, which might need careful parsing.
      // A better approach from the Flutter side would be to send JSON.encode(locationData).
      // For now, we'll try to parse the bracketed content as JSON, assuming it's the object part.
      // Example input: "{routeId: 1, busId: BUS456, lat: 39.544647216796875, lng: 2.574617385864258, timestamp: 2025-11-13T18:12:55.123Z, velocity: 22.583333333333332}"
      // Remove outer curly braces and quotes if necessary, then parse.
      // A more robust solution is to ensure the Flutter app sends proper JSON.
      let parsedData;
      try {
          // Attempt to parse the received string directly as JSON
          // This assumes the Flutter app correctly sends JSON.encode(locationData)
          parsedData = JSON.parse(messageStr);
      } catch (e) {
          console.error('Error parsing raw message as JSON:', e);
          // If direct parsing fails, it might be the Flutter app's toString() format
          // This is fragile and depends on the exact string format of the Dart Map.
          // Example: "{routeId: 1, busId: BUS456, lat: 39.544647216796875, lng: 2.574617385864258, timestamp: 2025-11-13T18:12:55.123Z, velocity: 22.583333333333332}"
          // Remove the outer '{' and '}'
          let trimmedStr = messageStr.trim();
          if (trimmedStr.startsWith('{') && trimmedStr.endsWith('}')) {
              trimmedStr = trimmedStr.substring(1, trimmedStr.length - 1);
              // Split by comma, then by colon to get key-value pairs
              const pairs = trimmedStr.split(', ');
              const obj = {};
              pairs.forEach(pair => {
                  const colonIndex = pair.indexOf(':');
                  if (colonIndex > 0) {
                      let key = pair.substring(0, colonIndex).trim();
                      let value = pair.substring(colonIndex + 1).trim();

                      // Attempt to parse the value as a number, boolean, or string
                      if (value === 'true') value = true;
                      else if (value === 'false') value = false;
                      else if (!isNaN(value) && !value.includes('"')) value = parseFloat(value);
                      else if (value.startsWith('"') && value.endsWith('"')) value = value.substring(1, value.length - 1); // Remove quotes

                      obj[key] = value;
                  }
              });
              parsedData = obj;
          } else {
              console.error('Could not parse message format:', messageStr);
              return; // Exit if format is unrecognizable
          }
      }

      console.log('Parsed data from phone app:', parsedData);

      if (parsedData && typeof parsedData === 'object') {
        // Process the parsed data
        processLocationData(parsedData);
      } else {
        console.warn('Received message from phone app is not a valid object:', parsedData);
      }
    } catch (error) {
      console.error('Error processing message from phone app:', error);
      console.log('Problematic message:', data.toString());
    }
  });

  phoneWsClient.on('error', (error) => {
    console.error('Error with phone app WebSocket:', error);
    // Attempt reconnection logic could go here
  });

  phoneWsClient.on('close', (code, reason) => {
    console.log(`Phone app WebSocket closed. Code: ${code}, Reason: ${reason}`);
    // Attempt reconnection logic could go here
    setTimeout(connectToPhoneWS, 5000); // Retry connection after 5 seconds
  });
}


/**
 * Starts the output WebSocket server for clients (like the Flutter app).
 */
function startOutputWSServer() {
  outputWsServer = new WebSocket.Server({ port: OUTPUT_WS_PORT });

  outputWsServer.on('connection', (ws, req) => {
    console.log('Client connected to output WebSocket server.');

    ws.on('close', () => {
      console.log('Client disconnected from output WebSocket server.');
    });

    ws.on('error', (error) => {
      console.error('Error in output WebSocket client connection:', error);
    });

    // Optionally, send a welcome message or initial data if applicable
    // ws.send(JSON.stringify({ type: 'connected', message: 'Connected to real-time data feed' }));
  });

  console.log(`Output WebSocket server started on port ${OUTPUT_WS_PORT}`);
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
    console.log('Broadcasted message:', messageStr);
  } else {
    // console.log('No clients connected to output WebSocket, message queued or dropped:', message); // Log only if needed frequently
  }
}

/**
 * Starts the entire real-time processing service.
 */
function start() {
  console.log('Starting real-time processor...');
  connectToPhoneWS();
  startOutputWSServer();

  // Optional: Set up a periodic task for complex calculations like 'esta-info' or 'stop' detection
  // based on stored bus states.
  // setInterval(async () => {
  //   // Iterate through activeBusStates and perform calculations
  //   // e.g., calculate next stop arrival time based on current pos/speed and route geometry
  //   // e.g., check if a bus has been stationary near a stop for > X seconds -> 'stop' event
  //   console.log('Periodic processing task running...');
  // }, PROCESSING_INTERVAL_MS);

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
    outputWsServer.close();
  }
}

module.exports = { start, stop, broadcastToClients, activeBusStates }; // Export functions if needed elsewhere