// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { Vector3 } = require('three'); // Use THREE's Vector3 on server if needed for distance calcs

const app = express();
const server = http.createServer(app);
// Configure Socket.IO with CORS settings - adjust origin as needed for security
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for development, restrict in production
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Game State (Server Side - Simplified for now) ---
const GARDEN_SIZE_SERVER = 20; // Keep consistent with client
const RESOURCE_SPAWN_RATE = 5000; // ms between spawns
const WEATHER_CHANGE_RATE = 30000; // ms between weather changes
const MAX_RESOURCES = 30; // Limit total resources on map
const FLOWER_GROWTH_TIMES = { // Time units (e.g., nurture ticks) per stage
    'seed': 1, 
    'sprout': 2,
    'budding': 3,
    'bloom': Infinity // Already bloomed
};
const FLOWER_SLOT_POSITIONS_SERVER = [ // Needs to match client
    { x: -5, z: -5 }, { x: 0, z: -5 }, { x: 5, z: -5 },
    { x: -5, z: 0 },  { x: 0, z: 0 },  { x: 5, z: 0 },
    { x: -5, z: 5 },  { x: 0, z: 5 },  { x: 5, z: 5 },
].map((pos, index) => ({ id: `slot_${index}`, position: pos })); // Add IDs

const WEATHER_TYPES = ['Sunny', 'Cloudy', 'Rainy'];
const WEATHER_GROWTH_MODIFIERS = {
    'Sunny': 1.0,  // Normal growth
    'Cloudy': 0.7, // Slower growth
    'Rainy': 1.5   // Faster growth (water helps!)
};

// --- Game State (Server Side - More Detailed) ---
// In a real game, you'd manage rooms, player pairs, authoritative state, etc.
let players = {}; // Store player data { socketId: { position, resources, ... } }
let resources = []; // Store resource data { id, type, position }
let flowers = {}; // Store flower data { slotId: { stage, plantedBy } }
let gameTimer = 1800; // Example: 30 minutes
let weather = 'Sunny';
let resourceSpawnInterval;
let weatherChangeInterval;
let gameTimerInterval;
let nextResourceId = 0; // Simple way to generate unique IDs

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Initialize player state on server
    players[socket.id] = {
        id: socket.id,
        position: { x: 0, y: 0.5, z: 0 }, // Initial position
        resources: { petals: 0, water: 0 }
    };

    // Send initial game state to the newly connected player
    socket.emit('initialState', {
        playerId: socket.id,
        players,
        resources,
        flowers,
        timer: gameTimer,
        weather
    });

    // Broadcast new player to others
    socket.broadcast.emit('playerJoined', players[socket.id]);

    // Handle player movement
    socket.on('playerMove', (position) => {
        if (players[socket.id]) {
            players[socket.id].position = position;
            // Broadcast movement to other players
            socket.broadcast.emit('playerMoved', { id: socket.id, position });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Remove player from state
        delete players[socket.id];
        // Broadcast player disconnection
        io.emit('playerLeft', socket.id);

        // If no players left, potentially stop intervals
        if (Object.keys(players).length === 0) {
            stopGameLoop(); 
            console.log("No players left. Stopping game loops.");
        }
    });

    // --- Placeholder for other game events ---
    // socket.on('collectResource', (resourceId) => { /* ... server logic ... */ });
    // socket.on('plantFlower', (slotId) => { /* ... server logic ... */ });
    // socket.on('nurtureFlower', (slotId) => { /* ... server logic ... */ });

    // Start game loops if this is the first player (or restart if needed)
    if (Object.keys(players).length === 1) {
        startGameLoop();
        console.log("First player joined. Starting game loops.");
    }
});

// --- Game Loop Functions (Server Side) ---
function startGameLoop() {
    // Clear existing intervals if any (safety measure)
    stopGameLoop(); 

    // Start Timer
    gameTimer = 1800; // Reset timer
    gameTimerInterval = setInterval(() => {
        gameTimer--;
        io.emit('timerUpdate', gameTimer); // Broadcast timer update
        if (gameTimer <= 0) {
            endGame();
        }
    }, 1000); // Update every second

    // Start Resource Spawning
    startResourceSpawning(5000); // Spawn every 5 seconds (example)

    // Start Weather Changes
    startWeatherChanges(30000); // Change weather every 30 seconds (example)
}

function stopGameLoop() {
    clearInterval(gameTimerInterval);
    clearInterval(resourceSpawnInterval);
    clearInterval(weatherChangeInterval);
    gameTimerInterval = null;
    resourceSpawnInterval = null;
    weatherChangeInterval = null;
}

function endGame() {
    console.log("Game Over!");
    stopGameLoop();
    // Send final message/image data to clients
    io.emit('gameOver', { message: "Time's up! Look at the beautiful garden you grew together!" }); 
    // Potentially reset server state here or after a delay
}

// --- Placeholder functions for server logic ---
function startResourceSpawning(rate) {
    clearInterval(resourceSpawnInterval); // Ensure only one interval runs
    resourceSpawnInterval = setInterval(() => {
        spawnResource();
    }, rate);
}

function startWeatherChanges(rate) {
     clearInterval(weatherChangeInterval); // Ensure only one interval runs
    weatherChangeInterval = setInterval(() => {
         changeWeather();
    }, rate);
}

function spawnResource() { /* ... To be implemented ... */ console.log("Spawn Resource Tick (Not Implemented)");}
function changeWeather() { /* ... To be implemented ... */ console.log("Change Weather Tick (Not Implemented)"); }


// Start the server
server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
});