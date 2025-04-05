// server.js (Additions and Modifications)
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { Vector3 } = require('three'); // Use THREE's Vector3 on server if needed for distance calcs

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// --- Game Constants (Server Side) ---
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
let players = {}; // { socketId: { id, position, resources: { petals, water } } }
let resources = {}; // { resourceId: { id, type, position } } - Use object for easy ID lookup
let flowers = {}; // { slotId: { slotId, stage, plantedBy, nurtureProgress } }
let gameTimer = 1800;
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
        // Random starting position within bounds
        position: { 
             x: (Math.random() - 0.5) * (GARDEN_SIZE_SERVER * 0.8), 
             y: 0.5, 
             z: (Math.random() - 0.5) * (GARDEN_SIZE_SERVER * 0.8) 
        }, 
        resources: { petals: 0, water: 0 }
    };

    // Send initial game state to the newly connected player
    socket.emit('initialState', {
        playerId: socket.id,
        players,
        resources: Object.values(resources), // Send array of resources
        flowers,
        timer: gameTimer,
        weather
    });

    // Broadcast new player to others (excluding the sender)
    socket.broadcast.emit('playerJoined', players[socket.id]);

    // --- Event Handlers ---
    
    socket.on('playerMove', (position) => {
        if (players[socket.id]) {
            // Optional: Add server-side validation/bounds checking here
            players[socket.id].position = position;
            socket.broadcast.emit('playerMoved', { id: socket.id, position });
        }
    });

    socket.on('collectResource', (resourceId) => {
        const player = players[socket.id];
        const resource = resources[resourceId];

        if (!player || !resource) return; // Ignore if player or resource doesn't exist

        // Optional: Server-side distance check (prevent cheating)
        // const playerPos = new Vector3(player.position.x, player.position.y, player.position.z);
        // const resourcePos = new Vector3(resource.position.x, resource.position.y, resource.position.z);
        // if (playerPos.distanceTo(resourcePos) > 2.0) { // Allow slightly larger distance than client check
        //     console.log(`Player ${socket.id} too far to collect ${resourceId}`);
        //     return; 
        // }

        console.log(`Player ${socket.id} collected resource ${resourceId}`);

        // Add resource to player inventory
        if (resource.type === 'petal') {
            player.resources.petals++;
        } else {
            player.resources.water++;
        }

        // Remove resource from world state
        delete resources[resourceId];

        // Notify the collecting player of their updated resources
        socket.emit('updatePlayerResources', player.resources);

        // Notify all players that the resource was removed
        io.emit('resourceRemoved', resourceId);
    });
    
    socket.on('plantFlower', (data) => {
        const player = players[socket.id];
        const slotId = data.slotId;

        if (!player || !slotId || flowers[slotId] || player.resources.petals <= 0) {
            console.log(`Player ${socket.id} failed to plant at ${slotId}. Conditions not met.`);
             // Optionally send a failure message back to the player
             // socket.emit('actionFailed', { reason: "Cannot plant here or insufficient petals." });
            return;
        }
        
        // Optional: Server-side distance check to the slot position
        const slot = FLOWER_SLOT_POSITIONS_SERVER.find(s => s.id === slotId);
        if(!slot) {
             console.error(`Slot ${slotId} not found on server.`);
             return;
        }
        // const playerPos = new Vector3(player.position.x, player.position.y, player.position.z);
        // const slotPos = new Vector3(slot.position.x, 0, slot.position.z);
        // if (playerPos.distanceTo(slotPos) > 3.0) { // Planting range check
        //      console.log(`Player ${socket.id} too far to plant at ${slotId}`);
        //      return;
        // }

        console.log(`Player ${socket.id} planted a seed at ${slotId}`);

        // Deduct resource
        player.resources.petals--;

        // Create flower state
        flowers[slotId] = {
            slotId: slotId,
            stage: 'seed',
            plantedBy: socket.id, // Track who planted it (for potential scoring or effects)
            nurtureProgress: 0 // How many times it's been nurtured towards next stage
        };

        // Notify planting player of resource change
        socket.emit('updatePlayerResources', player.resources);
        
        // Notify all players about the new flower
        io.emit('flowerPlanted', flowers[slotId]); 
    });
    
    socket.on('nurtureFlower', (data) => {
        const player = players[socket.id];
        const slotId = data.slotId;
        const flower = flowers[slotId];

        if (!player || !flower || flower.stage === 'bloom' || player.resources.water <= 0) {
             console.log(`Player ${socket.id} failed to nurture ${slotId}. Conditions not met.`);
             // socket.emit('actionFailed', { reason: "Cannot nurture this flower or insufficient water." });
            return;
        }
        
        // Optional: Server-side distance check
        // ... (similar distance check as planting) ...

        console.log(`Player ${socket.id} nurtured flower at ${slotId}`);
        
        // Deduct resource
        player.resources.water--;
        
        // Apply nurture progress, considering weather
        const modifier = WEATHER_GROWTH_MODIFIERS[weather] || 1.0;
        flower.nurtureProgress += (1 * modifier); // Base progress of 1, modified by weather

        // Check if flower grows to the next stage
        let grown = false;
        const requiredProgress = FLOWER_GROWTH_TIMES[flower.stage];
        
        if (flower.nurtureProgress >= requiredProgress) {
            grown = true;
            flower.nurtureProgress = 0; // Reset progress for next stage
            switch (flower.stage) {
                case 'seed':   flower.stage = 'sprout'; break;
                case 'sprout': flower.stage = 'budding'; break;
                case 'budding':flower.stage = 'bloom'; break;
                // Bloom stage is terminal
            }
            console.log(`Flower ${slotId} grew to stage: ${flower.stage}`);
        }

        // Notify nurturing player of resource change
        socket.emit('updatePlayerResources', player.resources);
        
        // Notify all players if the flower grew
        if (grown) {
             io.emit('flowerGrown', flower);
        } else {
             // Optionally, send a confirmation that nurture happened but didn't cause growth yet
             // io.emit('flowerNurtured', { slotId: slotId, progress: flower.nurtureProgress }); // Less common
        }
    });


    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Remove player from state
        delete players[socket.id];
        // Broadcast player disconnection
        io.emit('playerLeft', socket.id);

        if (Object.keys(players).length === 0) {
            stopGameLoop();
            console.log("No players left. Stopping game loops.");
            // Reset game state fully when last player leaves?
            resetGameState(); 
        }
    });

    // Start game loops if this is the first player
    if (Object.keys(players).length === 1 && !gameTimerInterval) {
        startGameLoop();
        console.log("First player joined. Starting game loops.");
    } else if (Object.keys(players).length > 0 && !gameTimerInterval) {
        // If server restarted but players reconnected, restart loops
         startGameLoop();
         console.log("Players present, restarting game loops.");
    }
});

// --- Game Loop Functions (Server Side - Implementation) ---
function startGameLoop() {
    stopGameLoop(); // Ensure no duplicates run
    resetGameState(); // Start fresh when loops begin
    
    console.log("Starting game loop...");
    gameTimer = 1800; // Reset timer
    io.emit('timerUpdate', gameTimer); // Send initial timer value

    gameTimerInterval = setInterval(() => {
        gameTimer--;
        io.emit('timerUpdate', gameTimer); 
        if (gameTimer <= 0) {
            endGame();
        }
    }, 1000);

    resourceSpawnInterval = setInterval(spawnResource, RESOURCE_SPAWN_RATE);
    weatherChangeInterval = setInterval(changeWeather, WEATHER_CHANGE_RATE);
}

function stopGameLoop() {
    console.log("Stopping game loop intervals.");
    clearInterval(gameTimerInterval);
    clearInterval(resourceSpawnInterval);
    clearInterval(weatherChangeInterval);
    gameTimerInterval = null;
    resourceSpawnInterval = null;
    weatherChangeInterval = null;
}

function resetGameState() {
     console.log("Resetting game state.");
    // Keep players, but reset resources, flowers, timer, weather
    resources = {};
    flowers = {};
    gameTimer = 1800;
    weather = 'Sunny';
    nextResourceId = 0;
    // Notify clients about the reset state (except players list)
     io.emit('gameStateReset', { 
        resources: [], 
        flowers: {}, 
        timer: gameTimer, 
        weather: weather 
    });
    // Clients should handle 'gameStateReset' to clear their local copies
}

function endGame() {
    console.log("Game Over!");
    stopGameLoop();
    // Calculate final results if needed (e.g., total flowers bloomed)
    let finalMessage = "Time's up! Look at the beautiful garden you grew together!";
    let fullyBloomed = 0;
    for(const id in flowers) {
        if (flowers[id].stage === 'bloom') {
            fullyBloomed++;
        }
    }
    finalMessage += ` You bloomed ${fullyBloomed} Love Blooms!`;
    
    io.emit('gameOver', { message: finalMessage }); 
    // Consider delaying the reset or providing a "play again" mechanism
    // setTimeout(resetGameState, 10000); // Example: Reset after 10 seconds
}


function spawnResource() {
    if (Object.keys(resources).length >= MAX_RESOURCES) {
        return; // Don't spawn if max capacity reached
    }
    
    const resourceId = `res_${nextResourceId++}`;
    const type = Math.random() < 0.6 ? 'petal' : 'water'; // 60% chance petals
    const position = {
        x: (Math.random() - 0.5) * GARDEN_SIZE_SERVER,
        y: 0.5, // Spawn slightly above ground
        z: (Math.random() - 0.5) * GARDEN_SIZE_SERVER
    };

    const newResource = { id: resourceId, type, position };
    resources[resourceId] = newResource;

    console.log(`Spawning resource: ${type} at (${position.x.toFixed(1)}, ${position.z.toFixed(1)})`);
    
    // Broadcast the new resource to all clients
    io.emit('resourceSpawned', newResource);
}

function changeWeather() {
    const previousWeather = weather;
    const possibleWeathers = WEATHER_TYPES.filter(w => w !== previousWeather); // Don't pick the same weather twice
    weather = possibleWeathers[Math.floor(Math.random() * possibleWeathers.length)];

    console.log(`Weather changed to: ${weather}`);

    // Broadcast the weather update
    io.emit('weatherUpdate', weather);
}

// Start the server
server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
});