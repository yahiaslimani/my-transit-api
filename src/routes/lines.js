// src/routes/stops.js
const express = require('express');
const router = express.Router();
const { getAllLines, getLineByCod, getLineById } = require('../controllers/lineController');

// GET all stops with optional filtering and pagination
router.get('/', getAllLines);

// GET a single stop by its 'cod' field
router.get('/cod/:cod', getLineByCod);

// GET a single stop by its 'id' field (assuming 'id' is the primary key)
router.get('/id/:id', getLineById);

//GET http://localhost:3000/api/lines
//GET http://localhost:3000/api/lines?page=2
//GET http://localhost:3000/api/lines?limit=-1
module.exports = router;