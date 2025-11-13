// src/routes/stops.js
const express = require('express');
const router = express.Router();
const { getAllSubLines, getSubLineByCod, getSubLineById, getSubLineByLineCode } = require('../controllers/sublineController');

// GET all stops with optional filtering and pagination
router.get('/', getAllSubLines);

// GET a single stop by its 'cod' field
router.get('/cod/:cod', getSubLineByCod);

// GET a single stop by its 'id' field (assuming 'id' is the primary key)
router.get('/id/:id', getSubLineById);

// GET a single stop by its 'id' field (assuming 'id' is the primary key)
router.get('/linecode/:linecod', getSubLineByLineCode);

//GET http://localhost:3000/api/lines
//GET http://localhost:3000/api/lines?page=2
//GET http://localhost:3000/api/lines?limit=-1
module.exports = router;