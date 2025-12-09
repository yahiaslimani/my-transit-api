// src/services/realtimeProcessor.js
const WebSocket = require('ws');
const { pool } = require('../config/database'); // Import your DB connection pool

// --- Configuration ---
const PHONE_WS_URL = process.env.PHONE_WS_URL || 'ws://localhost:8080/driver-location-ws'; // URL for the phone app WS server
const OUTPUT_WS_PORT = process.env.REALTIME_WS_PORT || 8081; // Port for the output WS server
const PROCESSING_INTERVAL_MS = 5000; // How often to potentially send 'esta-info' or 'stop' messages

// --- Constants for Calculations ---
const MIN_SIGNALS_FOR_DIRECTION = 3; // Minimum number of recent signals needed
const MIN_MOVEMENT_THRESHOLD_METERS = 1.0; // Minimum distance between points to consider for bearing calc
const DIRECTION_MATCH_THRESHOLD_DEGREES = 45.0; // Max angle diff to consider a match
const STOP_DETECTION_RADIUS_METERS = 50; // Radius to consider bus at a stop
const STOP_DETECTION_MIN_TIME_SECONDS = 30; // Minimum time stationary to confirm a stop
const STOP_DEPARTURE_ADD_SECONDS = 30; // Seconds to add to arrival time for departure time

// --- In-Memory Storage for Bus States ---
// Key: busId, Value: Object containing rt_id, currentPos, currentVel, lastProcessedTimestamp, etc.
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
  // Validate inputs to prevent NaN
  if (typeof lat1 !== 'number' || typeof lon1 !== 'number' || typeof lat2 !== 'number' || typeof lon2 !== 'number' ||
      isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) {
    console.error('Invalid coordinates for haversineDistance:', { lat1, lon1, lat2, lon2 });
    return NaN; // Or throw an error if preferred
  }

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
 * @returns {number|null} Bearing in degrees (0-360) or null if invalid coordinates
 */
function calculateBearing(lat1, lon1, lat2, lon2) {
  // Validate inputs
  if (typeof lat1 !== 'number' || typeof lon1 !== 'number' || typeof lat2 !== 'number' || typeof lon2 !== 'number' ||
      isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) {
    console.error('Invalid coordinates for calculateBearing:', { lat1, lon1, lat2, lon2 });
    return null;
  }

  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) -
          Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  let bearing = (θ * 180 / Math.PI + 360) % 360;
  return bearing;
}

/**
 * Calculates an average bearing from a sequence of coordinates.
 * Only considers segments longer than MIN_MOVEMENT_THRESHOLD_METERS.
 * @param {Array<{lat: number, lon: number, timestamp?: string}>} coordHistory - Array of coordinate objects [{lat, lng, timestamp?}, ...]
 * @returns {number|null} Average bearing in degrees (0-360) or null if insufficient data or valid coordinates.
 */
function calculateAverageBearing(coordHistory) {
  if (coordHistory.length < 2) {
    console.log('[Calculation] Need at least 2 points to calculate bearing.');
    return null;
  }

  const bearings = [];
  for (let i = 1; i < coordHistory.length; i++) {
    const prevCoord = coordHistory[i - 1];
    const currCoord = coordHistory[i];

    // Validate *individual* coordinate objects within the history array
    if (!prevCoord || !currCoord || typeof prevCoord.lat !== 'number' || typeof prevCoord.lng !== 'number' ||
        typeof currCoord.lat !== 'number' || typeof currCoord.lng !== 'number' ||
        isNaN(prevCoord.lat) || isNaN(prevCoord.lng) || isNaN(currCoord.lat) || isNaN(currCoord.lng)) {
      console.error('[Calculation] Invalid coordinate object in history array:', { prevCoord, currCoord });
      continue; // Skip this pair if invalid
    }

    const distance = haversineDistance(prevCoord.lat, prevCoord.lng, currCoord.lat, currCoord.lng);

    // Check for NaN from haversineDistance
    if (isNaN(distance)) {
      console.error('[Calculation] haversineDistance returned NaN for points:', prevCoord, currCoord);
      continue; // Skip this pair if distance calculation failed
    }

    if (distance >= MIN_MOVEMENT_THRESHOLD_METERS) {
      const bearing = calculateBearing(prevCoord.lat, prevCoord.lng, currCoord.lat, currCoord.lng);
      if (bearing !== null) { // Check if calculateBearing succeeded
        bearings.push(bearing);
        console.log(`[Calculation] Calculated bearing ${bearing.toFixed(2)}° for segment ${i-1} -> ${i} (dist: ${distance.toFixed(2)}m)`);
      } else {
        console.log(`[Calculation] Skipping segment ${i-1} -> ${i} due to invalid bearing calculation.`);
      }
    } else {
        console.log(`[Calculation] Skipping segment ${i-1} -> ${i} due to insufficient movement (${distance.toFixed(2)}m < ${MIN_MOVEMENT_THRESHOLD_METERS}m)`);
    }
  }

  if (bearings.length === 0) {
    console.log(`[Calculation] Insufficient valid movement (above ${MIN_MOVEMENT_THRESHOLD_METERS}m) or valid bearings in history to calculate average.`);
    return null;
  }

  // Calculate average bearing (handles angle wrapping correctly using complex numbers)
  let sumX = 0, sumY = 0;
  for (const bearing of bearings) {
    sumX += Math.cos(bearing * Math.PI / 180);
    sumY += Math.sin(bearing * Math.PI / 180);
  }
  let avgBearing = Math.atan2(sumY, sumX) * 180 / Math.PI;
  avgBearing = (avgBearing + 360) % 360; // Normalize to 0-360

  console.log(`[Calculation] Calculated average bearing from ${bearings.length} valid segments: ${avgBearing.toFixed(2)}°`);
  return avgBearing;
}


/**
 * Fetches the ordered list of stops and their coordinates for sublines associated with a given main RouteLine ID.
 * @param {number} routeId - The ID of the main RouteLine (e.g., 3227).
 * @returns {Promise<Map<number, Array<{id: number, cod: string, lat: number, lon: number, nam: string, ref: string}>>|null>}
 *          A Map where the key is the subline ID (rt_id) and the value is the array of ordered stops for that subline,
 *          or null on error.
 */
async function getOrderedStopsForRouteSublines(routeId) {
  try {
    // Query to get all sublines for a given routeId and their associated ordered stops
    const query = `
      SELECT
        sl.id AS subline_id,
        s.id AS stop_id,
        s.cod AS stop_cod,
        s.lat AS stop_lat,
        s.lon AS stop_lon,
        s.nam AS stop_nam,
        s.ref AS stop_ref,
        sls.stoporder AS stop_order
      FROM "SubLine" sl
      JOIN "SubLineStop" sls ON sl.id = sls.sublineid
      JOIN "Stop" s ON sls.stopid = s.id
      WHERE sl.lineid = $1 -- Filter by the main RouteLine ID
      ORDER BY sl.id ASC, sls.stoporder ASC; -- Order by subline first, then by stop order within each subline
    `;
    const result = await pool.query(query, [routeId]);

    if (result.rows.length === 0) {
      console.log(`[DB Query] No active sublines or stops found for route ID ${routeId}.`);
      return new Map(); // Return an empty map if no sublines exist for the route
    }

    // Organize the results into a Map: Key=subline_id, Value=array of stops for that subline
    const sublineStopsMap = new Map();
    for (const row of result.rows) {
      const sublineId = row.subline_id;
      const stopInfo = {
        id: row.stop_id,
        cod: row.stop_cod,
        lat: row.stop_lat,
        lon: row.stop_lon,
        nam: row.stop_nam,
        ref: row.stop_ref,
        order: row.stop_order, // Include the order for reference
      };

      if (!sublineStopsMap.has(sublineId)) {
        sublineStopsMap.set(sublineId, []);
      }
      sublineStopsMap.get(sublineId).push(stopInfo);
    }

    console.log(`[DB Query] Retrieved ${result.rows.length} active stops for ${sublineStopsMap.size} subline(s) associated with route ID ${routeId}.`);
    return sublineStopsMap; // Return the map of sublines -> stops
  } catch (error) {
    console.error(`[DB Error] Error fetching stops for route ID ${routeId}:`, error);
    return null;
  }
}


/**
 * Determines the most likely subline (rt_id) for a bus based on its recent movement history and the specified route.
 * This function first fetches the sublines belonging to the route, then compares the average bearing derived
 * from the history against the bearing between consecutive stops on *those specific sublines*.
 * @param {string} busId - The unique ID of the bus.
 * @param {number} routeId - The ID of the main route the bus is assigned to (e.g., 3227).
 * @param {Array<{lat: number, lon: number, timestamp?: string}>} coordHistory - Recent GPS coordinates of the bus.
 * @returns {Promise<number|null>} The matched rt_id (subline.id) or null if no match is found.
 */
async function matchBusToSublineByHistoryAndRoute(busId, routeId, coordHistory) {
  console.log(`[${busId}] Attempting to match bus to subline using route ID ${routeId} and history (${coordHistory.length} points).`);

  if (coordHistory.length < MIN_SIGNALS_FOR_DIRECTION) {
    console.log(`[${busId}] Not enough history points (${coordHistory.length}) to determine direction. Need at least ${MIN_SIGNALS_FOR_DIRECTION}.`);
    return null;
  }

  const avgBearing = calculateAverageBearing(coordHistory); // Pass the whole history array
  if (avgBearing === null) {
    console.log(`[${busId}] Could not calculate average bearing from history.`);
    return null;
  }

  // --- Fetch Sublines and Stops Belonging to the Specified Route ---
  console.log(`[${busId}] Fetching sublines and stops for route ID ${routeId}.`);
  const sublineStopsMap = await getOrderedStopsForRouteSublines(routeId);
  if (sublineStopsMap === null || sublineStopsMap.size === 0) {
    console.log(`[${busId}] No sublines found for route ID ${routeId}. Cannot match.`);
    return null;
  }

  // --- Compare Bus Bearing to Route Segment Bearings (Only on Sublines for this Route) ---
  let bestMatchSublineId = null;
  let bestMatchScore = -Infinity; // Higher score is better

  for (const [sublineId, stopsOnSubline] of sublineStopsMap.entries()) {
    console.log(`[${busId}] Evaluating subline ID: ${sublineId} (Route: ${routeId}, Stops: ${stopsOnSubline.length})`);

    if (stopsOnSubline.length < 2) {
      console.log(`[${busId}] Subline ${sublineId} has fewer than 2 stops, skipping.`);
      continue;
    }

    // Iterate through consecutive stop pairs on this specific subline
    for (let i = 0; i < stopsOnSubline.length - 1; i++) {
      const stopA = stopsOnSubline[i];
      const stopB = stopsOnSubline[i + 1];

      // Calculate the bearing from Stop A to Stop B on this specific subline
      const routeSegmentBearing = calculateBearing(stopA.lat, stopA.lon, stopB.lat, stopB.lon);

      if (routeSegmentBearing === null) {
          console.log(`[${busId}] Could not calculate bearing for route segment ${stopA.id} (${stopA.nam}) -> ${stopB.id} (${stopB.nam}) on subline ${sublineId}. Skipping segment.`);
          continue; // Skip this segment if bearing calculation failed
      }

      // Calculate the angular difference between the bus's average bearing and the route segment bearing
      // Use the shortest angular distance (accounting for 0/360 wrap-around)
      let angleDiff = Math.abs(avgBearing - routeSegmentBearing);
      angleDiff = Math.min(angleDiff, 360 - angleDiff);

      console.log(`[${busId}]   Segment ${stopA.id} (${stopA.nam}) -> ${stopB.id} (${stopB.nam}): Route Bearing = ${routeSegmentBearing.toFixed(2)}°, Bus Avg Bearing = ${avgBearing.toFixed(2)}°, Diff = ${angleDiff.toFixed(2)}°`);

      // Check if the bearing difference is within the acceptable threshold
      if (angleDiff <= DIRECTION_MATCH_THRESHOLD_DEGREES) {
        // A simple scoring mechanism: score based on closeness to the route bearing
        // A more complex score could incorporate distance to the stops or the segment itself
        const score = DIRECTION_MATCH_THRESHOLD_DEGREES - angleDiff; // Higher score for smaller difference

        if (score > bestMatchScore) {
          bestMatchScore = score;
          bestMatchSublineId = sublineId;
          console.log(`[${busId}]     Potential best match found! Subline: ${sublineId}, Score: ${score.toFixed(2)}, Bus Bearing: ${avgBearing.toFixed(2)}°, Segment Bearing: ${routeSegmentBearing.toFixed(2)}°, Diff: ${angleDiff.toFixed(2)}°`);
        }
      } else {
           console.log(`[${busId}]     Segment bearing (${routeSegmentBearing.toFixed(2)}°) does not match bus bearing (${avgBearing.toFixed(2)}°) within threshold (${DIRECTION_MATCH_THRESHOLD_DEGREES}°). Diff: ${angleDiff.toFixed(2)}°`);
      }
    }
  }

  if (bestMatchSublineId !== null) {
    console.log(`[${busId}] Matched to subline ID (rt_id): ${bestMatchSublineId} (Best Score: ${bestMatchScore.toFixed(2)})`);
    return bestMatchSublineId;
  } else {
    console.log(`[${busId}] Could not determine best matching subline from ${sublineStopsMap.size} candidates for route ${routeId} based on historical bearing and threshold of ${DIRECTION_MATCH_THRESHOLD_DEGREES}°.`);
    return null;
  }
}


// --- Processing Logic ---

/**
 * Processes the raw location data received from the phone app.
 * Determines rt_id based on routeId and historical movement, calculates estimates, detects stops, and formats output.
 * @param {object} rawData - The raw data object received from the phone (e.g., {routeId, busId, lat, lng, timestamp, velocity}).
 */
async function processLocationData(rawData) {
  const { routeId, busId, lat, lng, timestamp, velocity } = rawData;
  const currentTimestamp = new Date(timestamp).toISOString(); // Ensure consistent timestamp format
  const currentLat = lat;
  const currentLng = lng;
  const currentVel = velocity; // Assuming velocity is in m/s from Geolocator
  console.log(`[${busId}] Received raw location data (Route: ${routeId}): Lat=${currentLat}, Lng=${currentLng}, Vel=${currentVel}, TS=${currentTimestamp}`);

  // --- Retrieve/Initialize Bus State ---
  let busState = activeBusStates.get(busId) || {
    history: [], // Store recent coordinates
    rtId: null, // Store the determined rt_id (subline ID)
    lastProcessedRtId: null, // Store the previous rt_id for change detection
    lastProcessedTimestamp: null,
    stopsForCurrentRtId: null, // Cache stops for the current rt_id
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

  // --- Determine rt_id (Subline ID) using RouteId and History ---
  let currentRtId = busState.rtId; // Start with the previously determined ID
  let previousRtId = busState.lastProcessedRtId; // Store the ID from the *last processed* message for change detection

  // Only attempt to determine/reconfirm rt_id if we have enough history
  if (busState.history.length >= MIN_SIGNALS_FOR_DIRECTION) {
    console.log(`[${busId}] History size (${busState.history.length}) meets minimum requirement (${MIN_SIGNALS_FOR_DIRECTION}). Attempting to determine/reconfirm rt_id using routeId ${routeId}.`);
    // Use the NEW function that incorporates the routeId
    const newlyMatchedRtId = await matchBusToSublineByHistoryAndRoute(busId, routeId, [...busState.history]); // Pass a copy to avoid mutation during async op

    if (newlyMatchedRtId !== null) {
      if (currentRtId === null) {
        // First time an rt_id is determined for this bus instance
        currentRtId = newlyMatchedRtId;
        console.log(`[${busId}] First rt_id determined for route ${routeId}: ${currentRtId}`);
      } else if (currentRtId !== newlyMatchedRtId) {
        // Detected a potential route change
        console.log(`[${busId}] Potential route/direction change detected on route ${routeId}! Previous rt_id: ${currentRtId}, New match: ${newlyMatchedRtId}.`);
        // For now, let's update the rt_id. You might want more sophisticated logic here
        // (e.g., require multiple consecutive matches for a new rt_id before switching).
        currentRtId = newlyMatchedRtId;
      } else {
        // Match confirmed, rt_id remains the same
        console.log(`[${busId}] rt_id confirmed as ${currentRtId} (on route ${routeId}) based on history.`);
      }
    } else {
        console.log(`[${busId}] Route/History-based matching returned null for route ${routeId}. Keeping previous rt_id: ${currentRtId}`);
        // Keep the currentRtId as is if matching failed.
    }
  } else {
    console.log(`[${busId}] Not enough history yet (${busState.history.length}) to determine rt_id using route ${routeId}. Keeping previous rt_id: ${currentRtId}`);
  }

  // --- Handle Route Changes (Send 'close' for old route if applicable) ---
  // This logic would go here if implemented (requires tracking previous state and comparing rt_ids)
  if (previousRtId && previousRtId !== currentRtId) {
     console.log(`[${busId}] Route change detected: ${previousRtId} -> ${currentRtId}. Sending 'close' for old route.`);
     const closeMessage = {
         type: "close",
         rt_id: previousRtId,
         // Format timestamp as "YYYYMMDD HHmmss"
         upd: busState.lastProcessedTimestamp ? busState.lastProcessedTimestamp.replace('T', ' ').substring(0, 17).replace(/\..*$/, '').replace(/[-:]/g, '') : currentTimestamp.replace('T', ' ').substring(0, 17).replace(/\..*$/, '').replace(/[-:]/g, ''),
         date: busState.lastProcessedTimestamp ? busState.lastProcessedTimestamp.replace('T', ' ').substring(0, 17).replace(/\..*$/, '').replace(/[-:]/g, '') : currentTimestamp.replace('T', ' ').substring(0, 17).replace(/\..*$/, '').replace(/[-:]/g, ''),
         del: 0, // Delay placeholder
         pass: "0", // Passengers placeholder
         lat: busState.history[busState.history.length - 2]?.lat || currentLat, // Previous known lat if available
         lng: busState.history[busState.history.length - 2]?.lng || currentLng, // Previous known lng if available
         stop_id: 0, // Placeholder
         stop_code: "-", // Placeholder
         stop_nam: "-" // Placeholder
     };
     broadcastToClients(closeMessage);
  }


  // --- Format and Send 'position' message (if rt_id is known) ---
  if (currentRtId !== null) {
    // Convert velocity from m/s (Geolocator) to km/h if expected by frontend
    const velocityKmh = currentVel * 3.6;

    const positionMessage = {
      type: "position",
      rt_id: currentRtId,
      // Format timestamp as "YYYYMMDD HHmmss"
      upd: currentTimestamp.replace('T', ' ').substring(0, 19).replace(/\..*$/, '').replace(/[-:]/g, ''),
      date: currentTimestamp.replace('T', ' ').substring(0, 19).replace(/\..*$/, '').replace(/[-:]/g, ''),
      lat: lat,
      lng: lng,
      // Convert velocity from m/s to km/h if the expected format is km/h
      vel: velocityKmh // Use converted velocity
    };

    // Broadcast the message to connected clients (e.g., Flutter app)
    broadcastToClients(positionMessage);
    console.log(`[${busId}] Sent 'position' message for rt_id ${currentRtId} at (${lat}, ${lng}), vel ${velocityKmh.toFixed(2)} km/h`);
  } else {
    console.log(`[${busId}] rt_id is unknown (after checking route ${routeId}), skipping 'position' message.`);
    // Potentially send an error message or a status update to the client if rt_id cannot be determined
    // broadcastToClients({ type: 'error', busId, message: 'Unable to determine route/direction' });
  }


  // --- Determine Upcoming Stops and Send 'esta-info' (if rt_id is known and subline data is available) ---
  if (currentRtId !== null) {
    // Check if stops for this subline are already known and cached in busState or globally
    if (!busState.stopsForCurrentRtId || busState.stopsForCurrentRtId.rtId !== currentRtId) {
         console.log(`[${busId}] Fetching stops for newly matched/confirmed rt_id: ${currentRtId}`);
         // We need the routeId to fetch stops. We could pass routeId from the raw data if needed,
         // or store it in the busState when rt_id is first matched.
         // For now, let's assume we can get the routeId somehow when needed.
         // A better approach might be to store the routeId alongside rt_id in the busState when matching occurs.
         // This requires fetching the routeId from the SubLine table using the rt_id.
         // Let's fetch the stops directly using the currentRtId (subline.id)
         const stopsForSublineQuery = `
            SELECT s.id, s.cod, s.lat, s.lon, s.nam, s.ref, sls.stoporder
            FROM "Stop" s
            JOIN "SubLineStop" sls ON s.id = sls.stopid
            JOIN "SubLine" sl ON sls.sublineid = sl.id
            WHERE sl.id = $1 -- Filter by the specific SubLine ID (rt_id)
            ORDER BY sls.stoporder ASC; -- Order by the sequence on this specific subline
         `;
         try {
             const stopsResult = await pool.query(stopsForSublineQuery, [currentRtId]);
             if (stopsResult.rows.length > 0) {
                 busState.stopsForCurrentRtId = { rtId: currentRtId, stops: stopsResult.rows };
                 console.log(`[${busId}] Cached ${busState.stopsForCurrentRtId.stops.length} stops for rt_id ${currentRtId}`);
             } else {
                 console.warn(`[${busId}] Could not fetch stops for rt_id ${currentRtId}. Cannot generate 'esta-info'.`);
                 busState.stopsForCurrentRtId = { rtId: currentRtId, stops: [] }; // Mark as fetched but empty/failed
             }
         } catch (error) {
             console.error(`[${busId}] Error fetching stops for rt_id ${currentRtId}:`, error);
             busState.stopsForCurrentRtId = { rtId: currentRtId, stops: [] }; // Mark as failed
         }
    }

    if (busState.stopsForCurrentRtId && busState.stopsForCurrentRtId.rtId === currentRtId && busState.stopsForCurrentRtId.stops.length > 0) {
        const stopsOnSubline = busState.stopsForCurrentRtId.stops;
        const currentTimeFormatted = currentTimestamp.replace('T', ' ').substring(0, 19).replace(/\..*$/, ''); // Format for 'upd'/'date'

        // Find the index of the *next* stop in the sequence based on current position
        // This is a simplified approach: find the closest upcoming stop *in the sequence*.
        let nextStopIndex = -1;
        let minDistanceToNextStop = Infinity;

        // Start searching from the stop *after* the one we last knew the bus was closest to (or from the beginning if unknown)
        // We need to find the current position relative to the stop sequence.
        // A simple heuristic: find the stop in the sequence closest to the current bus position.
        // Then, the *next* stops in the *sequence* (with higher stoporder) are the upcoming ones.
        let closestStopIndexInSequence = -1;
        let minDistanceToAnyStopInSequence = Infinity;

        for (let i = 0; i < stopsOnSubline.length; i++) {
            const stop = stopsOnSubline[i];
            const distanceToStop = haversineDistance(currentLat, currentLng, stop.lat, stop.lon);

            // Check for NaN from haversineDistance
            if (isNaN(distanceToStop)) {
                 console.error(`[${busId}] haversineDistance returned NaN for stop ${stop.id} (${stop.nam}). Skipping.`);
                 continue;
            }

            if (distanceToStop < minDistanceToAnyStopInSequence) {
                minDistanceToAnyStopInSequence = distanceToStop;
                closestStopIndexInSequence = i;
            }
        }

        if (closestStopIndexInSequence !== -1) {
            // The next stops are those in the sequence *after* the closest one found
            const upcomingStopsList = [];

            // Loop through the stops *after* the closest one found
            for (let i = closestStopIndexInSequence + 1; i < stopsOnSubline.length; i++) {
                const stop = stopsOnSubline[i];

                // Calculate estimated distance and time to this specific stop
                const distanceToThisStop = haversineDistance(currentLat, currentLng, stop.lat, stop.lon);
                const estimatedTimeToThisStop = calculateEstimatedTime(distanceToThisStop, currentVel);

                // Derive stop_arrival_time and stop_departure_time
                let stopArrivalTime = estimatedTimeToThisStop; // Use the calculated time as arrival
                let stopDepartureTime = null;
                if (stopArrivalTime) {
                    // Calculate departure time as arrival time + 30 seconds
                    const arrivalDate = new Date(`${stopArrivalTime.substring(0, 8)}T${stopArrivalTime.substring(9, 11)}:${stopArrivalTime.substring(11, 13)}:${stopArrivalTime.substring(13, 15)}`);
                    const departureDate = new Date(arrivalDate.getTime() + STOP_DEPARTURE_ADD_SECONDS * 1000);
                    stopDepartureTime = `${departureDate.getUTCFullYear()}${String(departureDate.getUTCMonth() + 1).padStart(2, '0')}${String(departureDate.getUTCDate()).padStart(2, '0')} ${String(departureDate.getUTCHours()).padStart(2, '0')}${String(departureDate.getUTCMinutes()).padStart(2, '0')}${String(departureDate.getUTCSeconds()).padStart(2, '0')}`;
                }

                // Add the stop info to the list, including the calculated times
                upcomingStopsList.push({
                    stop_id: stop.id,
                    stop_code: stop.cod,
                    stop_nam: stop.nam,
                    // Use the scheduled arrival time from the DB if available, otherwise use the calculated estimate or placeholder
                    // For now, use the calculated arrival time
                    arr_t: stopArrivalTime ? stopArrivalTime.replace(' ', '').substring(8) : "000000", // Format as HHMMSS or fallback
                    // Add the calculated departure time
                    dep_t: stopDepartureTime ? stopDepartureTime.replace(' ', '').substring(8) : "000030", // Format as HHMMSS or fallback (e.g., arrival + 30s)
                    // Calculate estimated distance and time based on current pos/vel (relative to the *first* stop in the list for overall estimate)
                    // Note: The example format shows 'esta_dist' and 'esta_time' relative to the *first* upcoming stop,
                    // implying these fields in the 'esta-info' message relate to the *next immediate stop*,
                    // even though the list contains more stops. This is a quirk of the format.
                    // The 'esta_dist' and 'esta_time' are likely recalculated for each message based on the FIRST stop in the list.
                    esta_dist: distanceToThisStop, // Distance to the *first* upcoming stop found
                    esta_time: estimatedTimeToThisStop, // Estimated arrival time at the *first* upcoming stop found
                });

                // For simplicity in this basic example, let's limit the list to the next few upcoming stops
                // and recalculate 'esta_dist' and 'esta_time' for each one relative to the bus's *current* position.
                // A production system would likely calculate these based on the route path and predicted travel times between stops.
            }

            // The 'esta-info' message format expects:
            // - stops: Array of upcoming stops (with calculated times/dists)
            // - pos: Current position and velocity of the bus
            // - bus: Static or dynamic bus capacity info (made static here)
            const estaInfoMessage = {
                type: "esta-info",
                rt_id: currentRtId,
                // Use the current timestamp for 'upd' and 'date'
                upd: currentTimeFormatted.replace(/\s|-|:/g, ''), // Format as YYYYMMDD HHmmss
                date: currentTimeFormatted.replace(/\s|-|:/g, ''),
                stops: upcomingStopsList, // Send the list of upcoming stops
                pos: { // Send the current position and velocity
                    lat: currentLat,
                    lng: currentLng,
                    vel: currentVel * 3.6, // Convert m/s to km/h
                    time: currentTimeFormatted.replace(/\s|-|:/g, ''), // Format as YYYYMMDD HHmmss
                },
                bus: { // Static capacity info for now
                    pas: 0, // Placeholder - get from phone app data if available
                    cap: 50, // Placeholder
                    cap_seated: 30, // Placeholder
                    cap_standing: 20, // Placeholder
                }
            };

            // Broadcast the 'esta-info' message
            broadcastToClients(estaInfoMessage);
            console.log(`[${busId}] Sent 'esta-info' message for rt_id ${currentRtId}, next stop: ${upcomingStopsList[0]?.stop_nam ?? 'None'}`);
        } else {
            console.log(`[${busId}] No upcoming stops found on rt_id ${currentRtId} after the closest stop in sequence.`);
            // Potentially send an 'esta-info' with an empty stops array or a specific message if the bus is at/near the last stop
            const emptyEstaInfoMessage = {
                type: "esta-info",
                rt_id: currentRtId,
                upd: currentTimeFormatted.replace(/\s|-|:/g, ''), // Format as YYYYMMDD HHmmss
                date: currentTimeFormatted.replace(/\s|-|:/g, ''),
                stops: [], // Send an empty list if no upcoming stops
                pos: {
                    lat: currentLat,
                    lng: currentLng,
                    vel: currentVel * 3.6,
                    time: currentTimeFormatted.replace(/\s|-|:/g, ''), // Format as YYYYMMDD HHmmss
                },
                bus: {
                    pas: 0,
                    cap: 50,
                    cap_seated: 30,
                    cap_standing: 20,
                }
            };
            broadcastToClients(emptyEstaInfoMessage);
            console.log(`[${busId}] Sent 'esta-info' message with empty stops list for rt_id ${currentRtId} (likely near end of route).`);
        }
    } else {
        console.log(`[${busId}] Stops for rt_id ${currentRtId} are not available or could not be fetched. Cannot generate 'esta-info'.`);
    }
  } else {
      console.log(`[${busId}] rt_id is unknown, skipping 'esta-info' calculation.`);
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
 * @param {*} outputServerInstance - The HTTP server instance to attach the WS server to.
 */
function startOutputWSServer(outputServerInstance) {
  if (!outputServerInstance) {
    console.error("Cannot start output WebSocket server: No HTTP server instance provided.");
    return;
  }

  outputWsServer = new WebSocket.Server({ server: outputServerInstance, path: '/api/passenger-realtime-ws' }); // Define a path

  outputWsServer.on('connection', (ws, req) => {
    console.log('Client connected to output WebSocket server at /api/passenger-realtime-ws.');
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

  console.log(`Output WebSocket server listening on path /api/passenger-realtime-ws`);
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
    console.log('Broadcasted message:', messageStr); // Log for debugging
  } else {
    console.log('No clients connected to output WebSocket, message not sent:', message); // Log only if needed frequently
  }
}

// Export functions if needed elsewhere
module.exports = { processLocationData, startOutputWSServer, broadcastToClients, activeBusStates };