// src/routes/stops.js
const express = require('express');
const router = express.Router();
const { getAllStops, getStopByCod, getStopById, getDeparturesForStation } = require('../controllers/stopController');

// GET all stops with optional filtering and pagination
router.get('/', getAllStops);

// GET a single stop by its 'cod' field
router.get('/cod/:cod', getStopByCod);

// GET a single stop by its 'id' field (assuming 'id' is the primary key)
router.get('/id/:id', getStopById);

router.get('/:stationCode/departures/ctmr4', getDeparturesForStation); // Use the new controller function

//GET http://localhost:3000/api/stops
//GET http://localhost:3000/api/stops?page=2
//GET http://localhost:3000/api/stops?limit=-1
module.exports = router;