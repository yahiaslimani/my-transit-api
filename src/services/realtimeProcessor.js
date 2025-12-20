// src/services/realtimeProcessor.js
const { pool } = require('../config/database'); // Import your DB connection pool

// --- Configuration ---
const PROCESSING_INTERVAL_MS = 5000; // How often to potentially send 'esta-info' or 'stop' messages

// --- Constants for Direction Detection ---
const MIN_SIGNALS_FOR_DIRECTION = 3; // Minimum number of recent signals needed
const MIN_MOVEMENT_THRESHOLD_METERS = 1.0; // Minimum distance between points to consider for bearing calc
const DIRECTION_MATCH_THRESHOLD_DEGREES = 45.0; // Max angle diff to consider a match
const STOP_DETECTION_RADIUS_METERS = 50; // Radius to consider bus at a stop
const STOP_DETECTION_MIN_TIME_SECONDS = 30; // Minimum time stationary to confirm a stop
const STOP_DEPARTURE_ADD_SECONDS = 30; // Seconds to add to arrival time for departure time

// --- In-Memory Storage for Bus States ---
// Key: busId, Value: Object containing history, rt_id, etc.
const activeBusStates = new Map();

// --- References to Passenger Connections and Broadcast Function (to be injected) ---
let broadcastToRouteClientsFunction = null;

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
  // Validate inputs to prevent NaN - CONVERT TO NUMBER FIRST if they might be strings
  const numLat1 = typeof lat1 === 'string' ? parseFloat(lat1) : lat1;
  const numLon1 = typeof lon1 === 'string' ? parseFloat(lon1) : lon1;
  const numLat2 = typeof lat2 === 'string' ? parseFloat(lat2) : lat2;
  const numLon2 = typeof lon2 === 'string' ? parseFloat(lon2) : lon2;

  if (typeof numLat1 !== 'number' || typeof numLon1 !== 'number' || typeof numLat2 !== 'number' || typeof numLon2 !== 'number' ||
      isNaN(numLat1) || isNaN(numLon1) || isNaN(numLat2) || isNaN(numLon2)) {
    console.error('Invalid coordinates for haversineDistance (after conversion):', { lat1, lon1, lat2, lon2 });
    console.error('Converted values:', { numLat1, numLon1, numLat2, numLon2 });
    return NaN; // Or throw an error if preferred
  }

  const R = 6371e3; // Earth's radius in meters
  const φ1 = numLat1 * Math.PI / 180;
  const φ2 = numLat2 * Math.PI / 180;
  const Δφ = (numLat2 - numLat1) * Math.PI / 180;
  const Δλ = (numLon2 - numLon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
          Math.cos(φ1) * Math.cos(φ2) *
          Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in meters
}
/**
 * Calculates an estimated arrival time based on distance and current velocity.
 * @param {number} distanceMeters - Distance to the destination in meters.
 * @param {number} velocityMps - Current velocity in meters per second.
 * @returns {string|null} Estimated arrival time in 'YYYYMMDD HHmmss' format, or null if velocity is 0.
 */
function calculateEstimatedTime(distanceMeters, velocityMps) {
  if (velocityMps <= 0) {
    console.log('Cannot calculate estimated time: velocity is 0 or negative.');
    return null; // Cannot estimate if not moving or moving backwards
  }

  const timeInSeconds = distanceMeters / velocityMps; // Time in seconds
  const estimatedDate = new Date(Date.now() + timeInSeconds * 1000); // Add time to current time

  // Format the date as 'YYYYMMDD HHmmss'
  const year = estimatedDate.getUTCFullYear();
  const month = String(estimatedDate.getUTCMonth() + 1).padStart(2, '0'); // Month is 0-indexed
  const day = String(estimatedDate.getUTCDate()).padStart(2, '0');
  const hours = String(estimatedDate.getUTCHours()).padStart(2, '0');
  const minutes = String(estimatedDate.getUTCMinutes()).padStart(2, '0');
  const seconds = String(estimatedDate.getUTCSeconds()).padStart(2, '0');

  return `${year}${month}${day} ${hours}${minutes}${seconds}`;
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
  // Convert to numbers if strings
  const numLat1 = typeof lat1 === 'string' ? parseFloat(lat1) : lat1;
  const numLon1 = typeof lon1 === 'string' ? parseFloat(lon1) : lon1;
  const numLat2 = typeof lat2 === 'string' ? parseFloat(lat2) : lat2;
  const numLon2 = typeof lon2 === 'string' ? parseFloat(lon2) : lon2;

  // Validate inputs
  if (typeof numLat1 !== 'number' || typeof numLon1 !== 'number' || typeof numLat2 !== 'number' || typeof numLon2 !== 'number' ||
      isNaN(numLat1) || isNaN(numLon1) || isNaN(numLat2) || isNaN(numLon2)) {
    console.error('Invalid coordinates for calculateBearing (after conversion):', { lat1, lon1, lat2, lon2 });
    console.error('Converted values:', { numLat1, numLon1, numLat2, numLon2 });
    return null;
  }

  const φ1 = numLat1 * Math.PI / 180;
  const φ2 = numLat2 * Math.PI / 180;
  const Δλ = (numLon2 - numLon1) * Math.PI / 180;

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
        console.log(`[Calculation] Calculated bearing ${bearing.toFixed(2)}° for segment ${i - 1} -> ${i} (dist: ${distance.toFixed(2)}m)`);
      } else {
        console.log(`[Calculation] Skipping segment ${i - 1} -> ${i} due to invalid bearing calculation.`);
      }
    } else {
      console.log(`[Calculation] Skipping segment ${i - 1} -> ${i} due to insufficient movement (${distance.toFixed(2)}m < ${MIN_MOVEMENT_THRESHOLD_METERS}m)`);
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
      console.log(`[DB Query] No sublines or stops found for route ID ${routeId}.`);
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

    console.log(`[DB Query] Retrieved stops for ${sublineStopsMap.size} subline(s) associated with route ID ${routeId}.`);
    return sublineStopsMap; // Return the map of sublines -> stops
  } catch (error) {
    console.error(`[DB Error] Error fetching stops for route ID ${routeId}:`, error);
    return null;
  }
}


/**
 * Determines the most likely *subline* ID (the rt_id used for broadcasting) for a bus based on its recent movement history
 * and the sublines belonging to its main route.
 * This function first fetches the sublines belonging to the main route, then compares the average bearing derived
 * from the history against the bearing between consecutive stops on *those specific sublines*.
 * @param {string} busId - The unique ID of the bus.
 * @param {number} mainRouteId - The ID of the main route the bus is assigned to (e.g., 3227).
 * @param {Array<{lat: number, lon: number, timestamp?: string}>} coordHistory - Recent GPS coordinates of the bus.
 * @returns {Promise<number|null>} The matched *subline* ID (which is the rt_id for broadcasting) or null if no match is found.
 */
async function matchBusToSublineByHistoryAndRoute(busId, mainRouteId, coordHistory) {
  console.log(`[${busId}] Attempting to match bus to subline using main route ID ${mainRouteId} and history (${coordHistory.length} points).`);

  if (coordHistory.length < MIN_SIGNALS_FOR_DIRECTION) {
    console.log(`[${busId}] Not enough history points (${coordHistory.length}) to determine direction. Need at least ${MIN_SIGNALS_FOR_DIRECTION}.`);
    return null;
  }

  const avgBearing = calculateAverageBearing(coordHistory); // Pass the whole history array
  if (avgBearing === null) {
    console.log(`[${busId}] Could not calculate average bearing from history.`);
    return null;
  }

  // --- Fetch Sublines and Stops Belonging to the Specified Main Route ---
  console.log(`[${busId}] Fetching sublines and stops for main route ID ${mainRouteId}.`);
  const sublineStopsMap = await getOrderedStopsForRouteSublines(mainRouteId);
  if (sublineStopsMap === null || sublineStopsMap.size === 0) {
    console.log(`[${busId}] No sublines found for main route ID ${mainRouteId}. Cannot match.`);
    return null;
  }

  // --- Compare Bus Bearing to Route Segment Bearings (Only on Sublines for this Route) ---
  let bestMatchSublineId = null;
  let bestMatchScore = -Infinity; // Higher score is better

  for (const [sublineId, stopsOnSubline] of sublineStopsMap.entries()) {
    console.log(`[${busId}] Evaluating subline ID (rt_id): ${sublineId} (Main Route: ${mainRouteId}, Stops: ${stopsOnSubline.length})`);

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
          bestMatchSublineId = sublineId; // Use the subline ID (which is the rt_id for broadcasting)
          console.log(`[${busId}]     Potential best match found! Subline (rt_id): ${sublineId}, Score: ${score.toFixed(2)}, Bus Bearing: ${avgBearing.toFixed(2)}°, Segment Bearing: ${routeSegmentBearing.toFixed(2)}°, Diff: ${angleDiff.toFixed(2)}°`);
        }
      } else {
           console.log(`[${busId}]     Segment bearing (${routeSegmentBearing.toFixed(2)}°) does not match bus bearing (${avgBearing.toFixed(2)}°) within threshold (${DIRECTION_MATCH_THRESHOLD_DEGREES}°). Diff: ${angleDiff.toFixed(2)}°`);
      }
    }
  }

  if (bestMatchSublineId !== null) {
    console.log(`[${busId}] Matched to subline ID (rt_id for broadcasting): ${bestMatchSublineId} (Best Score: ${bestMatchScore.toFixed(2)})`);
    return bestMatchSublineId; // Return the subline ID, which is the rt_id for the WebSocket messages
  } else {
    console.log(`[${busId}] Could not determine best matching subline from ${sublineStopsMap.size} candidates for main route ${mainRouteId} based on historical bearing and threshold of ${DIRECTION_MATCH_THRESHOLD_DEGREES}°.`);
    return null;
  }
}

/**
 * Fetches the main RouteLine ID (e.g., 101) associated with a specific SubLine ID (rt_id, e.g., 1011).
 * @param {number} rtId - The SubLine ID (rt_id).
 * @returns {Promise<number|null>} The main RouteLine ID or null on error/not found.
 */
async function getMainRouteIdFromRtId(rtId) {
    try {
        const query = 'SELECT lineid FROM "SubLine" WHERE id = $1'; // Adjust table/column names if necessary
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
// --- Processing Logic ---

/**
 * Processes the raw location data received from the phone app.
 * Determines the specific subline rt_id based on main routeId and historical movement, calculates estimates, detects stops, and formats output.
 * @param {object} rawData - The raw data object received from the phone (e.g., {routeId, busId, lat, lng, timestamp, velocity}).
 */
async function processLocationData(rawData) {
  const { routeId: mainRouteId, busId, lat, lng, timestamp, velocity } = rawData; // 'routeId' now refers to main RouteLine ID
  const currentTimestamp = new Date(timestamp).toISOString(); // Ensure consistent timestamp format
  const currentLat = lat;
  const currentLng = lng;
  const currentVel = velocity; // Assuming velocity is in m/s from Geolocator
  console.log(`[${busId}] Received raw location data (Main Route: ${mainRouteId}): Lat=${currentLat}, Lng=${currentLng}, Vel=${currentVel}, TS=${currentTimestamp}`);

  // --- Retrieve/Initialize Bus State ---
  let busState = activeBusStates.get(busId) || {
    history: [], // Store recent coordinates
    mainRtId: null, // Store the main routeId (e.g., 3227) the bus is assigned to
    currentSublineRtId: null, // Store the determined *subline* rt_id (e.g., 1189 or 1190) the bus is currently on
    lastProcessedSublineRtId: null, // Store the previous subline rt_id for change detection
    lastProcessedTimestamp: null,
    stopsForCurrentSublineRtId: null, // Cache stops for the current subline rt_id
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

  // --- Determine *Subline* rt_id using Main RouteId and History ---
  let currentSublineRtId = busState.currentSublineRtId; // Start with the previously determined subline ID
  let previousSublineRtId = busState.lastProcessedSublineRtId; // Store the ID from the *last processed* message for change detection

  // Only attempt to determine/reconfirm subline rt_id if we have enough history AND the main route matches
  if (busState.history.length >= MIN_SIGNALS_FOR_DIRECTION && busState.mainRtId === mainRouteId) {
    console.log(`[${busId}] History size (${busState.history.length}) meets minimum requirement (${MIN_SIGNALS_FOR_DIRECTION}) and main route matches (${mainRouteId}). Attempting to determine/reconfirm subline rt_id.`);
    // Use the NEW function that incorporates the main routeId to find the specific subline
    const newlyMatchedSublineRtId = await matchBusToSublineByHistoryAndRoute(busId, mainRouteId, [...busState.history]); // Pass a copy to avoid mutation during async op

    if (newlyMatchedSublineRtId !== null) {
      if (currentSublineRtId === null) {
        // First time a subline rt_id is determined for this bus instance on this main route
        currentSublineRtId = newlyMatchedSublineRtId;
        console.log(`[${busId}] First subline rt_id (on main route ${mainRouteId}) determined: ${currentSublineRtId}`);
      } else if (currentSublineRtId !== newlyMatchedSublineRtId) {
        // Detected a potential subline change (e.g., from Way to Back on the same main route)
        console.log(`[${busId}] Potential subline change detected on main route ${mainRouteId}! Previous subline rt_id: ${currentSublineRtId}, New match: ${newlyMatchedSublineRtId}.`);
        // For now, let's update the subline rt_id. You might want more sophisticated logic here
        // (e.g., require multiple consecutive matches for a new subline rt_id before switching).
        currentSublineRtId = newlyMatchedSublineRtId;
      } else {
        // Match confirmed, subline rt_id remains the same
        console.log(`[${busId}] Subline rt_id confirmed as ${currentSublineRtId} (on main route ${mainRouteId}) based on history.`);
      }
    } else {
        console.log(`[${busId}] Subline/History-based matching returned null for main route ${mainRouteId}. Keeping previous subline rt_id: ${currentSublineRtId}`);
        // Keep the currentSublineRtId as is if matching failed.
    }
  } else {
      if (busState.history.length < MIN_SIGNALS_FOR_DIRECTION) {
          console.log(`[${busId}] Not enough history yet (${busState.history.length}) to determine subline rt_id.`);
      }
      if (busState.mainRtId !== mainRouteId) {
          console.log(`[${busId}] Main route changed from ${busState.mainRtId} to ${mainRouteId}. Resetting subline state.`);
          // If the main route changed, reset the subline-specific state
          busState.mainRtId = mainRouteId;
          busState.currentSublineRtId = null;
          busState.lastProcessedSublineRtId = null;
          busState.stopsForCurrentSublineRtId = null; // Reset cached stops
          currentSublineRtId = null; // Set current to null to trigger re-matching on next data
      }
  }


  // --- Handle Subline Changes (Send 'close' for old subline if applicable) ---
  // This logic would go here if implemented (requires tracking previous state and comparing rt_ids)
  if (previousSublineRtId && previousSublineRtId !== currentSublineRtId) {
     console.log(`[${busId}] Subline change detected: ${previousSublineRtId} -> ${currentSublineRtId}. Sending 'close' for old subline.`);
     const closeMessage = {
         type: "close",
         rt_id: previousSublineRtId, // Use the old subline rt_id
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
     // Broadcast the 'close' message using the injected function
     if (broadcastToRouteClientsFunction) {
         broadcastToRouteClientsFunction(closeMessage);
         console.log(`[${busId}] Sent 'close' message for old subline rt_id ${previousSublineRtId}.`);
     } else {
         console.warn(`[${busId}] Broadcast function not available, cannot send 'close' message for old subline rt_id ${previousSublineRtId}.`);
     }
  }


  // --- Format and Send 'position' message (if subline rt_id is known) ---
  if (currentSublineRtId !== null) {
    // Convert velocity from m/s (Geolocator) to km/h if expected by frontend
    const velocityKmh = currentVel * 3.6;

    const positionMessage = {
      type: "position",
      rt_id: currentSublineRtId, // Use the *subline* ID as the rt_id for broadcasting
      // Format timestamp as "YYYYMMDD HHmmss"
      upd: currentTimestamp.replace('T', ' ').substring(0, 19).replace(/\..*$/, '').replace(/[-:]/g, ''),
      date: currentTimestamp.replace('T', ' ').substring(0, 19).replace(/\..*$/, '').replace(/[-:]/g, ''),
      lat: lat,
      lng: lng,
      // Convert velocity from m/s to km/h if the expected format is km/h
      vel: velocityKmh // Use converted velocity
    };

    // Broadcast the message using the injected function
    if (broadcastToRouteClientsFunction) {
        broadcastToRouteClientsFunction(positionMessage);
        console.log(`[${busId}] Sent 'position' message for subline rt_id ${currentSublineRtId} at (${lat}, ${lng}), vel ${velocityKmh.toFixed(2)} km/h`);
    } else {
        console.warn(`[${busId}] Broadcast function not available, cannot send 'position' message for subline rt_id ${currentSublineRtId}.`);
    }
  } else {
    console.log(`[${busId}] Subline rt_id is unknown (after checking main route ${mainRouteId}), skipping 'position' message.`);
    // Potentially send an error message or a status update to the client if rt_id cannot be determined
    // if (broadcastFunction) broadcastFunction({ type: 'error', busId, message: 'Unable to determine route/direction' });
  }


  // --- Determine Upcoming Stops and Send 'esta-info' (if subline rt_id is known and subline data is available) ---
  if (currentSublineRtId !== null) {
    // Check if stops for this subline are already known and cached in busState or globally
    if (!busState.stopsForCurrentSublineRtId || busState.stopsForCurrentSublineRtId.rtId !== currentSublineRtId) {
         console.log(`[${busId}] Fetching stops for newly matched/confirmed subline rt_id: ${currentSublineRtId}`);
         // We need the mainRouteId to fetch stops via getOrderedStopsForRouteSublines.
         // This function fetches stops for ALL sublines of the main route.
         // We then need to pick the stops for the specific currentSublineRtId.
         const allStopsForMainRoute = await getOrderedStopsForRouteSublines(mainRouteId); // Fetch stops for the main route
         if (allStopsForMainRoute && allStopsForMainRoute.has(currentSublineRtId)) { // Check if the specific subline ID exists in the map
             busState.stopsForCurrentSublineRtId = { rtId: currentSublineRtId, stops: allStopsForMainRoute.get(currentSublineRtId) }; // Get stops for the specific subline ID
             console.log(`[${busId}] Cached ${busState.stopsForCurrentSublineRtId.stops.length} stops for subline rt_id ${currentSublineRtId}`);
         } else {
             console.warn(`[${busId}] Could not fetch or find stops for subline rt_id ${currentSublineRtId} (on main route ${mainRouteId}). Cannot generate 'esta-info'.`);
             busState.stopsForCurrentSublineRtId = { rtId: currentSublineRtId, stops: [] }; // Mark as fetched but empty/failed
         }
    }

    if (busState.stopsForCurrentSublineRtId && busState.stopsForCurrentSublineRtId.rtId === currentSublineRtId && busState.stopsForCurrentSublineRtId.stops.length > 0) {
        const stopsOnSubline = busState.stopsForCurrentSublineRtId.stops;
        const currentTimeFormatted = currentTimestamp.replace('T', ' ').substring(0, 19).replace(/\..*$/, ''); // Format for 'upd'/'date'

        // Find the index of the *next* stop in the sequence based on current position
        // This is a simplified approach: find the stop in the sequence closest to the current bus position *that comes after* the bus's last known position in the sequence.
        // A more robust method involves path-following and distance calculations along the route path between stops.
        let nextStopIndex = -1;
        let minDistanceToNextStop = Infinity;

        // Find the index of the closest stop in the *sequence* to the bus's *current position*
        // This determines where the bus is in the sequence.
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
            const upcomingStopsList = [];

            // Loop through the stops *after* the closest one found in the sequence
            // These are the "upcoming" stops based on the determined direction (subline path).
            for (let i = closestStopIndexInSequence + 1; i < stopsOnSubline.length; i++) {
                const stop = stopsOnSubline[i];

                // Calculate estimated distance and time to this specific stop
                // This is a basic estimate based on straight-line distance and current speed.
                // A more accurate estimate would consider the route path geometry between points.
                const distanceToThisStop = haversineDistance(currentLat, currentLng, stop.lat, stop.lon);
                const estimatedTimeToThisStop = calculateEstimatedTime(distanceToThisStop, currentVel); // Implement this function

                // Derive stop_arrival_time and stop_departure_time (basic estimation based on distance/velocity)
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
                if (upcomingStopsList.length >= 5) { // e.g., show next 5 stops
                    break;
                }
            }

            if (upcomingStopsList.length > 0) {
                // The 'esta-info' message format expects:
                // - stops: Array of upcoming stops (with calculated times/dists)
                // - pos: Current position and velocity of the bus
                // - bus: Static or dynamic bus capacity info (made static here)
                const estaInfoMessage = {
                    type: "esta-info",
                    rt_id: currentSublineRtId, // Use the *subline* ID as the rt_id for broadcasting
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

                // Broadcast the 'esta-info' message using the injected function
                if (broadcastToRouteClientsFunction) {
                    broadcastToRouteClientsFunction(estaInfoMessage);
                    console.log(`[${busId}] Sent 'esta-info' message for subline rt_id ${currentSublineRtId}, next stop: ${upcomingStopsList[0]?.stop_nam ?? 'None'}`);
                } else {
                    console.warn(`[${busId}] Broadcast function not available, cannot send 'esta-info' message for subline rt_id ${currentSublineRtId}.`);
                }
            } else {
                console.log(`[${busId}] No upcoming stops found on subline rt_id ${currentSublineRtId} after the closest stop in sequence.`);
                // Potentially send an 'esta-info' with an empty stops array or a specific message if the bus is at/near the last stop
                const emptyEstaInfoMessage = {
                    type: "esta-info",
                    rt_id: currentSublineRtId, // Use the *subline* ID
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
                if (broadcastToRouteClientsFunction) {
                    broadcastToRouteClientsFunction(emptyEstaInfoMessage);
                    console.log(`[${busId}] Sent 'esta-info' message with empty stops list for subline rt_id ${currentSublineRtId} (likely near end of route).`);
                } else {
                    console.warn(`[${busId}] Broadcast function not available, cannot send empty 'esta-info' message for subline rt_id ${currentSublineRtId}.`);
                }
            }
        } else {
            console.log(`[${busId}] Could not find any stops on subline rt_id ${currentSublineRtId} close enough to determine sequence position.`);
            // Potentially send an 'esta-info' with an empty stops array or a specific message if the bus is far from the route
        }
    } else {
        console.log(`[${busId}] Stops for subline rt_id ${currentSublineRtId} are not available or could not be fetched. Cannot generate 'esta-info'.`);
    }
  } else {
      console.log(`[${busId}] Subline rt_id is unknown, skipping 'esta-info' calculation.`);
  }


  // --- Store/Update Bus State ---
  // Update the state with the new mainRouteId, sublineRtId, and history
  busState.mainRtId = mainRouteId; // Update the main route ID
  busState.currentSublineRtId = currentSublineRtId; // Update the *subline* rt_id
  busState.lastProcessedSublineRtId = currentSublineRtId; // Update the ID used for *next* change detection
  busState.lastProcessedTimestamp = currentTimestamp; // Update the timestamp used for *next* message
  activeBusStates.set(busId, busState);

  console.log(`[${busId}] Finished processing location data. Current main route: ${mainRouteId}, Current subline rt_id: ${currentSublineRtId}, History length: ${busState.history.length}.`);
}

// --- NEW: Helper Function to Find Upcoming Stops on a Specific Subline ---
/**
 * Finds stops that come *after* the bus's current position in the sequence of a specific subline.
 * @param {Array} stopsOnSubline - The ordered array of stops for the subline (from DB query).
 * @param {number} currentLat - The bus's current latitude.
 * @param {number} currentLng - The bus's current longitude.
 * @returns {{closestStopIndex: number, upcomingStops: Array}|null} Object containing the index of the closest stop and the array of upcoming stops, or null if no stops found nearby.
 */
function findUpcomingStopsOnSubline(stopsOnSubline, currentLat, currentLng) {
  if (!stopsOnSubline || stopsOnSubline.length === 0) {
    console.warn('[RealtimeProcessor] No stops provided to findUpcomingStopsOnSubline.');
    return null;
  }

  let closestStopIndexInSequence = -1;
  let minDistanceToAnyStopInSequence = Infinity;

  // Find the stop in the subline sequence closest to the bus's *current* position
  for (let i = 0; i < stopsOnSubline.length; i++) {
    const stop = stopsOnSubline[i];
    const distanceToStop = haversineDistance(currentLat, currentLng, stop.lat, stop.lon);

    if (isNaN(distanceToStop)) {
         console.error('[RealtimeProcessor] haversineDistance returned NaN for stop:', stop);
         continue;
    }

    if (distanceToStop < minDistanceToAnyStopInSequence) {
        minDistanceToAnyStopInSequence = distanceToStop;
        closestStopIndexInSequence = i;
    }
  }

  if (closestStopIndexInSequence === -1) {
      console.log('[RealtimeProcessor] Could not find any stops on the subline close enough to determine sequence position.');
      return null;
  }

  // The upcoming stops are those *after* the closest one found in the sequence
  const upcomingStops = stopsOnSubline.slice(closestStopIndexInSequence + 1);

  console.log(`[RealtimeProcessor] Found ${upcomingStops.length} upcoming stops after closest stop index ${closestStopIndexInSequence} on subline.`);

  return {
    closestStopIndex: closestStopIndexInSequence,
    upcomingStops: upcomingStops
  };
}


// --- NEW: Function to Get Sublines with Buses Heading to a Specific Station ---
/**
 * Finds sublines that have active buses heading towards a specific station.
 * Buses are considered "heading towards" if they are currently located before the station
 * in the subline's stop sequence and are moving in that direction.
 *
 * @param {object} targetStation - The target station object containing its ID (e.g., { id: 984, cod: "40036", ... }).
 * @param {number} numberOfDepartures - The maximum number of sublines with active buses to return.
 * @returns {Promise<Array<object>>} An array of subline information objects with associated bus data, sorted by estimated arrival time.
 */
async function getSublinesWithBusesToStation(targetStation, numberOfDepartures) {
  const targetStationId = targetStation.id;
  const limit = numberOfDepartures;

  console.log(`[RealtimeProcessor] Searching for sublines with buses heading to station ID: ${targetStationId}, limit: ${limit}`);

  try {
    // 1. Find all sublines that include the target station
    // This query gets the subline ID (rt_id) directly, which is the SubLine.id
    const sublinesForStationQuery = `
      SELECT sl.id AS subline_id -- This is the rt_id used for broadcasting
      FROM "SubLine" sl
      JOIN "SubLineStop" sls ON sl.id = sls.sublineid
      WHERE sls.stopid = $1
      ORDER BY sl.id; -- Order by subline ID for consistency
    `;
    const sublinesResult = await pool.query(sublinesForStationQuery, [targetStationId]);
    const sublineIds = sublinesResult.rows.map(row => row.subline_id);

    if (sublineIds.length === 0) {
      console.log(`[RealtimeProcessor] No sublines found serving station ID ${targetStationId}.`);
      return [];
    }

    console.log(`[RealtimeProcessor] Found ${sublineIds.length} subline(s) serving station ID ${targetStationId}:`, sublineIds);

    // 2. Get the ordered stops for each of these specific sublines
    // This query fetches stops for multiple specific subline IDs efficiently
    const stopsForSublinesQuery = `
      SELECT sls.sublineid, s.id AS stop_id, s.cod AS stop_cod, s.nam AS stop_nam, s.lat AS stop_lat, s.lon AS stop_lon, sls.stoporder AS stop_order
      FROM "SubLineStop" sls
      JOIN "Stop" s ON sls.stopid = s.id
      WHERE sls.sublineid = ANY($1) -- Use the array of specific subline IDs
      ORDER BY sls.sublineid, sls.stoporder ASC; -- Order by subline first, then by stop order within each subline
    `;
    const stopsResult = await pool.query(stopsForSublinesQuery, [sublineIds]);

    // Organize the stops by subline ID for quick lookup
    const stopsBySubline = new Map();
    stopsResult.rows.forEach(row => {
      if (!stopsBySubline.has(row.sublineid)) {
        stopsBySubline.set(row.sublineid, []);
      }
      stopsBySubline.get(row.sublineid).push({
        id: row.stop_id,
        cod: row.stop_cod,
        nam: row.stop_nam,
        lat: row.stop_lat,
        lon: row.stop_lon,
        order: row.stop_order,
      });
    });

    // 3. Check active buses against these specific sublines and their stop sequences
    const potentialDepartures = [];

    for (const [busId, busState] of activeBusStates.entries()) {
      const currentRtId = busState.currentSublineRtId; // Use the determined subline ID (SubLine.id)

      // Check if the bus's current rt_id matches one of the sublines serving the target station
      if (currentRtId && sublineIds.includes(currentRtId)) {
        const currentLat = busState.lat;
        const currentLng = busState.lng;
        const currentVel = busState.velocity; // Assuming m/s

        const stopsOnBusSubline = stopsBySubline.get(currentRtId);

        if (!stopsOnBusSubline || stopsOnBusSubline.length === 0) {
          console.warn(`[RealtimeProcessor] No stops found for active bus ${busId} on rt_id ${currentRtId} (which serves target station ${targetStationId}). Cannot determine direction.`);
          continue; // Skip this bus if its subline stops are unknown in our fetched data
        }

        // Find the target station's index within the bus's current subline sequence
        const targetStopIndex = stopsOnBusSubline.findIndex(stop => stop.id === targetStationId);

        if (targetStopIndex === -1) {
          // This should ideally not happen if sublinesForStationQuery was correct and stops were fetched correctly for that subline ID
          console.warn(`[RealtimeProcessor] Target station ${targetStationId} not found in stop sequence for bus ${busId}'s current rt_id ${currentRtId}. This is unexpected.`);
          continue;
        }

        // Use the helper function to find the bus's position in the sequence and upcoming stops
        const sequenceInfo = findUpcomingStopsOnSubline(stopsOnBusSubline, currentLat, currentLng);
        if (!sequenceInfo) {
            console.log(`[RealtimeProcessor] Could not determine sequence position for bus ${busId} on rt_id ${currentRtId}. Skipping.`);
            continue;
        }

        const { closestStopIndex, upcomingStops } = sequenceInfo;

        // 4. Determine if the target station is in the list of upcoming stops
        // This means the bus is currently located *before* the target station in the subline's sequence.
        // A simple check: is the target stop's index *after* the closest stop's index?
        if (targetStopIndex > closestStopIndex) {
          // Calculate estimated time/distance to the target station
          // This is a basic estimate using haversine distance and current speed along the *straight line*.
          // A more accurate estimate would use the route path geometry between stops.
          const targetStopDetails = stopsOnBusSubline[targetStopIndex];
          const distanceToTarget = haversineDistance(currentLat, currentLng, targetStopDetails.lat, targetStopDetails.lon);
          let estimatedTimeSeconds = Infinity;
          let estimatedArrivalTime = null;
          if (currentVel > 0.5) { // Threshold for "moving" (e.g., 0.5 m/s)
              estimatedTimeSeconds = distanceToTarget / currentVel; // Time in seconds
              estimatedArrivalTime = new Date(Date.now() + estimatedTimeSeconds * 1000);
          } else {
              console.log(`[RealtimeProcessor] Bus ${busId} is stationary or moving slowly (< 0.5 m/s), cannot calculate arrival time to station ${targetStationId}.`);
              // Depending on requirements, you might still include it with estimated_time_seconds = Infinity or null,
              // or exclude it entirely if it's not actively approaching.
              // For now, let's include it but mark the time as unavailable or infinite.
              estimatedTimeSeconds = Infinity; // Or null, depending on how the frontend handles it
              estimatedArrivalTime = null; // Or a specific string like "N/A"
          }

          // Find the subline details from the initial query result (or potentially fetch name/code separately if needed)
          // For now, we'll use the rt_id (subline.id) itself and get name/code if required by the API spec later.
          // Assume we have subline details from the initial fetch if needed for response formatting.

          // Add this potential departure to the list
          potentialDepartures.push({
            // Subline info (from DB query - this is the rt_id)
            rt_id: currentRtId, // This is the SubLine.id
            // Optional: Add subline code, name if needed for the API response
            // subline_code: ... (fetch from SubLine table if not already cached)
            // subline_name: ... (fetch from SubLine table if not already cached)

            // Bus info (from activeBusStates)
            bus_id: busId,
            current_pos: { lat: currentLat, lng: currentLng },
            current_vel: currentVel, // m/s
            estimated_arrival_at_station: estimatedArrivalTime?.toISOString() ?? null, // ISO string or null if not calculable
            estimated_time_seconds: estimatedTimeSeconds, // Raw time in seconds (can be Infinity)
            distance_to_station_meters: distanceToTarget, // Raw distance in meters
            // Add other bus-specific info if needed (e.g., passenger count if available from phone app data)
          });

          console.log(`[RealtimeProcessor] Bus ${busId} (rt_id ${currentRtId}) is heading towards station ${targetStationId} (index ${targetStopIndex}). Est. time: ${estimatedTimeSeconds}s.`);
        } else {
            // The target station is *before* or *at* the bus's current position in the sequence, so it's not upcoming.
            console.log(`[RealtimeProcessor] Bus ${busId} (rt_id ${currentRtId}) is past or at the target station ${targetStationId} (current seq index: ${closestStopIndex}, target seq index: ${targetStopIndex}).`);
        }
      }
      // else: Bus is on a subline not serving the target station, ignore it.
    }

    // 5. Sort potential departures by estimated arrival time (ascending - soonest first)
    // Handle Infinity values appropriately in sorting (put them at the end)
    potentialDepartures.sort((a, b) => {
      if (a.estimated_time_seconds === Infinity && b.estimated_time_seconds === Infinity) return 0;
      if (a.estimated_time_seconds === Infinity) return 1;
      if (b.estimated_time_seconds === Infinity) return -1;
      return a.estimated_time_seconds - b.estimated_time_seconds;
    });

    // 6. Limit the results if requested
    const finalDepartures = potentialDepartures.slice(0, limit);

    console.log(`[RealtimeProcessor] Found ${finalDepartures.length} subline(s) with active buses heading towards station ID ${targetStationId} (limited to ${limit}).`);
    return finalDepartures;

  } catch (error) {
    console.error(`[RealtimeProcessor] Error finding sublines with buses heading to station ID ${targetStation.id}:`, error);
    // Depending on requirements, might return an empty array or re-throw
    return [];
  }
}
// --- Output Broadcasting Functions (to be injected) ---

/**
 * Injects the function used to broadcast messages to clients subscribed to a specific route.
 * @param {Function} broadcastFunc - The function to broadcast messages to route-specific clients.
 */
function injectBroadcastFunction(broadcastFunc) {
    console.log('[RealtimeProcessor] Injecting broadcast function.');
    broadcastToRouteClientsFunction = broadcastFunc;
}

// --- Initialization and Teardown ---

// --- Initialization and Teardown ---

function start() {
  console.log('[RealtimeProcessor] Starting real-time processor components...');
  // Initialization logic if needed
  console.log('[RealtimeProcessor] Real-time processor components initialized.');
}

function stop() {
  console.log('[RealtimeProcessor] Stopping real-time processor...');
  // Teardown logic if needed (e.g., clear intervals, close connections if held here)
  console.log('[RealtimeProcessor] Real-time processor stopped.');
}

// Export the processing function and the injection/start/stop functions
module.exports = { processLocationData, start, stop, injectBroadcastFunction, activeBusStates, getSublinesWithBusesToStation };