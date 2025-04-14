// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
// const { Vector3 } = require('three'); // Only if needed for complex server calcs

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] } // Restrict origin in production
});

const PORT = process.env.PORT || 3000;

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Game Constants ---
const GARDEN_SIZE_SERVER = 20;
const DEFAULT_GAME_DURATION = 1800; // Default 30 mins
const RESOURCE_SPAWN_RATE = 5000; // ms
const WEATHER_CHANGE_RATE = 30000; // ms
const MAX_RESOURCES_PER_ROOM = 30;
const FLOWER_GROWTH_TIMES = { 'seed': 1, 'sprout': 2, 'budding': 3, 'bloom': Infinity };
const FLOWER_SLOT_POSITIONS_SERVER = [
    { x: -5, z: -5 }, { x: 0, z: -5 }, { x: 5, z: -5 },
    { x: -5, z: 0 },  { x: 0, z: 0 },  { x: 5, z: 0 },
    { x: -5, z: 5 },  { x: 0, z: 5 },  { x: 5, z: 5 },
].map((pos, index) => ({ id: `slot_${index}`, position: pos }));
const WEATHER_TYPES = ['Sunny', 'Cloudy', 'Rainy'];
const WEATHER_GROWTH_MODIFIERS = { 'Sunny': 1.0, 'Cloudy': 0.7, 'Rainy': 1.5 };
const RECONNECT_TIMEOUT = 45000; // How long (ms) to keep player data after disconnect (45s)

// --- Game State Management (Per Room) ---
let rooms = {};
// Structure:
// rooms[roomId] = {
//     players: { socketId: { id, name, position, resources } }, // Active players
//     disconnectedPlayers: { originalSocketId: { data: playerData, timestamp } }, // Recently disconnected
//     resources: { resourceId: { id, type, position } },
//     flowers: { slotId: { slotId, stage, plantedBy, nurtureProgress } },
//     timer: Number,
//     weather: String,
//     gameDuration: Number,
//     state: String ('waiting', 'playing', 'paused', 'finished'),
//     intervals: { timer, resource, weather },
//     nextResourceId: Number,
//     hostId: String // Original socket ID of the host
// }


function generateRoomId() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function createRoom(hostSocketId, hostName, gameDuration) {
    const roomId = generateRoomId();
    rooms[roomId] = {
        players: {
            [hostSocketId]: {
                id: hostSocketId, // Store original socket ID as persistent ID
                name: hostName || `Player_${hostSocketId.substring(0,4)}`,
                position: { x: (Math.random() - 0.5) * 5, y: 0.6, z: (Math.random() - 0.5) * 5 }, // Start closer, adjust Y for player size
                resources: { petals: 0, water: 0 }
            }
        },
        disconnectedPlayers: {}, // Initialize disconnected list
        resources: {},
        flowers: {},
        timer: gameDuration || DEFAULT_GAME_DURATION,
        weather: 'Sunny',
        gameDuration: gameDuration || DEFAULT_GAME_DURATION,
        state: 'waiting',
        intervals: {},
        nextResourceId: 0,
        hostId: hostSocketId
    };
    console.log(`[${roomId}] Room created by ${hostName} (${hostSocketId})`);
    return roomId;
}

// Finds player data by original socket ID, checking active and disconnected lists
function getPlayerDataFromAnyRoom(originalPlayerId) {
    for (const roomId in rooms) {
        // Check active players first (using the player.id which holds the original socket id)
        for (const currentSocketId in rooms[roomId].players) {
             if (rooms[roomId].players[currentSocketId].id === originalPlayerId) {
                 // Found active player, return with current socket id
                 return { room: rooms[roomId], player: rooms[roomId].players[currentSocketId], currentSocketId: currentSocketId };
             }
        }
         // Check disconnected players (key is the original socket id)
         if (rooms[roomId].disconnectedPlayers[originalPlayerId]) {
              return { room: rooms[roomId], player: rooms[roomId].disconnectedPlayers[originalPlayerId].data, disconnected: true };
         }
    }
    return null;
}


// Finds the room ID associated with a *current* socket connection
function getRoomIdByCurrentSocketId(currentSocketId) {
     for (const roomId in rooms) {
        if (rooms[roomId].players[currentSocketId]) {
            return roomId;
        }
    }
    return null;
}

// Finds the Room object associated with a *current* socket connection
function getRoomByCurrentSocketId(currentSocketId) {
    const roomId = getRoomIdByCurrentSocketId(currentSocketId);
    return roomId ? rooms[roomId] : null;
}


// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // --- Hosting and Joining ---
    socket.on('hostGame', ({ playerName, duration }) => {
        console.log(`Host attempt by ${playerName} (${socket.id})`);
        // Prevent hosting if already in a room (check by original ID concept if possible, using socket.id for now)
        if (getRoomByCurrentSocketId(socket.id)) {
             console.warn(`[${socket.id}] Host rejected: Already in a room.`);
             socket.emit('setupError', { message: "You are already in a room!" });
             return;
        }
        const gameDuration = parseInt(duration, 10) || DEFAULT_GAME_DURATION;
        const roomId = createRoom(socket.id, playerName, gameDuration);
        socket.join(roomId);
        socket.emit('roomCreated', {
             roomId,
             initialState: getSanitizedRoomState(rooms[roomId]), // Send initial state
             playerId: socket.id // Send player's ID (which is their original socket ID)
        });
        console.log(`[${roomId}] Player ${playerName} (${socket.id}) hosted.`);
    });

    socket.on('joinGame', ({ playerName, roomId }) => {
        roomId = roomId?.toUpperCase(); // Normalize room ID
        console.log(`Join attempt by ${playerName} (${socket.id}) to room ${roomId}`);
        if (getRoomByCurrentSocketId(socket.id)) {
             console.warn(`[${socket.id}] Join rejected: Already in a room.`);
             socket.emit('setupError', { message: "You are already in a room!" });
             return;
        }

        const room = rooms[roomId];

        if (!room) {
            console.log(`[${roomId || '???'}] Join rejected: Room not found.`);
            socket.emit('setupError', { message: "Room not found." });
            return;
        }
        // Check if room is full (considering active players only)
        if (Object.keys(room.players).length >= 2) {
             console.log(`[${roomId}] Join rejected: Room is full.`);
             socket.emit('setupError', { message: "Room is already full." });
             return;
        }
        // Allow joining only if waiting
        if (room.state !== 'waiting') {
             console.log(`[${roomId}] Join rejected: Room is not waiting (State: ${room.state})`);
             socket.emit('setupError', { message: "Game is already in progress or finished." });
             return;
        }


        socket.join(roomId);
        room.players[socket.id] = { // Add player using current socket ID
            id: socket.id, // Store original socket ID as persistent ID
            name: playerName || `Player_${socket.id.substring(0,4)}`,
            position: { x: (Math.random() - 0.5) * 5, y: 0.6, z: (Math.random() - 0.5) * 5 },
            resources: { petals: 0, water: 0 }
        };
        console.log(`[${roomId}] Player ${playerName} (${socket.id}) joined.`);

        // Send confirmation and current state to joining player
        socket.emit('joinedRoom', {
             roomId,
             initialState: getSanitizedRoomState(room),
             playerId: socket.id
        });

        // Notify the host player about the new partner
        const hostSocketId = findCurrentSocketIdForPlayer(room, room.hostId); // Find host's current socket ID
        if (hostSocketId && hostSocketId !== socket.id) { // Ensure host is still connected and not self
             console.log(`[${roomId}] Notifying host ${hostSocketId} that partner joined.`);
             io.to(hostSocketId).emit('partnerJoined', room.players[socket.id]); // Send new player's data
        } else {
            console.warn(`[${roomId}] Host ${room.hostId} not found or is the joining player.`);
        }

        // Start game as room is now full
        if (Object.keys(room.players).length === 2) {
            room.state = 'playing';
            startGameLoop(roomId);
            console.log(`[${roomId}] Room full. Starting game.`);
            io.to(roomId).emit('gameStart', { message: "Partner joined! Let's grow!" });
        }
    });

    // --- Reconnect Logic ---
    socket.on('reconnectPlayer', ({ roomId, playerId }) => {
        // playerId here is the ORIGINAL socket ID the player connected with initially
        roomId = roomId?.toUpperCase();
        console.log(`[${roomId}] Reconnect attempt for player ID ${playerId} with new socket ${socket.id}`);
        const room = rooms[roomId];
        if (!room) {
            console.log(`[${roomId}] Reconnect failed: Room not found.`);
            socket.emit('reconnectFailed', { message: "Room not found. Maybe the game ended?" });
            return;
        }

        // Is the player already actively connected? (Maybe multiple tabs?)
         const existingPlayerData = Object.values(room.players).find(p => p.id === playerId);
         if (existingPlayerData) {
             console.log(`[${roomId}] Reconnect ignored: Player ${playerId} is already connected.`);
             // Optionally: Kick the old socket and replace with new? For now, just fail the reconnect.
             socket.emit('reconnectFailed', { message: "You seem to be already connected in another tab/window." });
             return;
         }

        const disconnectedData = room.disconnectedPlayers[playerId];
        if (!disconnectedData) {
            console.log(`[${roomId}] Reconnect failed: Player ${playerId} not found in disconnected list.`);
            socket.emit('reconnectFailed', { message: "Could not find your previous session." });
            return;
        }

        if (Date.now() - disconnectedData.timestamp > RECONNECT_TIMEOUT) {
            console.log(`[${roomId}] Reconnect failed: Player ${playerId} timed out.`);
            delete room.disconnectedPlayers[playerId]; // Clean up expired data
            socket.emit('reconnectFailed', { message: "Reconnect timed out." });
            return;
        }

        // ---- Reconnect Success ----
        const reconnectedPlayerName = disconnectedData.data.name;
        console.log(`[${roomId}] Reconnecting player ${reconnectedPlayerName} (ID: ${playerId}) with new socket ${socket.id}`);
        delete room.disconnectedPlayers[playerId]; // Remove from disconnected

        // Add back to active players using NEW socket.id, but keeping ORIGINAL player id inside data
        room.players[socket.id] = disconnectedData.data;
        room.players[socket.id].id = playerId; // Ensure the original ID is preserved inside the data object
                                               // The key in room.players is now the *new* socket.id

        socket.join(roomId); // Re-join Socket.IO room

        // Send state to reconnected player
        socket.emit('reconnectSuccess', {
            roomId,
            initialState: getSanitizedRoomState(room), // Send full current state
            playerId: playerId // Send back the ORIGINAL persistent player ID
        });

        // Notify the partner (find partner's current socket ID)
        const partnerSocketId = Object.keys(room.players).find(sid => sid !== socket.id);
        if (partnerSocketId) {
            console.log(`[${roomId}] Notifying partner ${partnerSocketId} about reconnect.`);
            io.to(partnerSocketId).emit('partnerReconnected', room.players[socket.id]); // Send reconnected player's data
        }

        // Restart game loop if it was paused and now has 2 players
        if (room.state === 'paused' && Object.keys(room.players).length === 2) {
            console.log(`[${roomId}] Restarting game after reconnect.`);
            room.state = 'playing';
            startGameLoop(roomId);
            io.to(roomId).emit('gameResumed', { message: `${reconnectedPlayerName} reconnected! Game resumed!` });
        } else if (room.state === 'waiting' && Object.keys(room.players).length === 2) {
            // Case where host reconnects before partner joins fully
             console.log(`[${roomId}] Room full after host reconnect. Starting game.`);
             room.state = 'playing';
             startGameLoop(roomId);
             io.to(roomId).emit('gameStart', { message: "Partner joined! Let's grow!" });
        }
    });


    // --- Game Event Handlers ---
    socket.on('playerMove', (position) => {
        const room = getRoomByCurrentSocketId(socket.id);
        if (!room || !room.players[socket.id] || room.state !== 'playing') return; // Robustness check

        room.players[socket.id].position = position;
        // Broadcast only to others in the room
        socket.to(room.id).emit('playerMoved', { id: room.players[socket.id].id, position }); // Send persistent ID
    });

    socket.on('collectResource', (resourceId) => {
        const room = getRoomByCurrentSocketId(socket.id);
        if (!room) return;
        const player = room.players[socket.id];
        const resource = room.resources[resourceId];

        if (!player) { console.warn(`[${room.id}] Collect: Player not found for socket ${socket.id}.`); return; }
        if (room.state !== 'playing') { /* console.log(`[${room.id}] Collect: Ignored, game not playing.`); */ return; }
        if (!resource) { /* console.log(`[${room.id}] Collect: Resource ${resourceId} already gone?`); */ return; }

        // Optional distance check here

        console.log(`[${room.id}] Player ${player.name} collected ${resource.type} (${resourceId})`);

        if (resource.type === 'petal') player.resources.petals++;
        else player.resources.water++;

        delete room.resources[resourceId];

        socket.emit('updatePlayerResources', player.resources);
        io.to(room.id).emit('resourceRemoved', resourceId);
    });

    socket.on('plantFlower', (data) => {
        const room = getRoomByCurrentSocketId(socket.id);
        if (!room) return;
        const player = room.players[socket.id];
        const slotId = data?.slotId;

        if (!player) { console.warn(`[${room.id}] Plant: Player not found.`); return; }
        if (room.state !== 'playing') { socket.emit('actionFailed', { message: "Game not active." }); return; }
        if (!slotId || !FLOWER_SLOT_POSITIONS_SERVER.some(s => s.id === slotId)) { socket.emit('actionFailed', { message: "Invalid location." }); return;}
        if (room.flowers[slotId]) { socket.emit('actionFailed', { message: "Plot already used!" }); return; }
        if (player.resources.petals <= 0) { socket.emit('actionFailed', { message: "Not enough Petals!" }); return; }

        // Optional distance check

        console.log(`[${room.id}] Player ${player.name} planted seed @ ${slotId}`);
        player.resources.petals--;
        room.flowers[slotId] = {
            slotId: slotId,
            stage: 'seed',
            plantedBy: player.id, // Use persistent player ID
            nurtureProgress: 0
        };

        socket.emit('updatePlayerResources', player.resources);
        io.to(room.id).emit('flowerPlanted', room.flowers[slotId]);
    });

    socket.on('nurtureFlower', (data) => {
        const room = getRoomByCurrentSocketId(socket.id);
        if (!room) return;
        const player = room.players[socket.id];
        const slotId = data?.slotId;
        const flower = room.flowers[slotId];

        if (!player) { console.warn(`[${room.id}] Nurture: Player not found.`); return; }
        if (room.state !== 'playing') { socket.emit('actionFailed', { message: "Game not active." }); return; }
        if (!flower) { socket.emit('actionFailed', { message: "Nothing here to nurture!" }); return; }
        if (flower.stage === 'bloom') { socket.emit('actionFailed', { message: "Already fully bloomed!" }); return; }
        if (player.resources.water <= 0) { socket.emit('actionFailed', { message: "Not enough Water!" }); return; }

        // Optional distance check

        console.log(`[${room.id}] Player ${player.name} nurtured flower @ ${slotId}`);
        player.resources.water--;
        const modifier = WEATHER_GROWTH_MODIFIERS[room.weather] || 1.0;
        flower.nurtureProgress += (1 * modifier);

        let grown = false;
        const requiredProgress = FLOWER_GROWTH_TIMES[flower.stage];

        if (requiredProgress !== Infinity && flower.nurtureProgress >= requiredProgress) {
            grown = true;
            flower.nurtureProgress = 0;
            switch (flower.stage) {
                case 'seed':   flower.stage = 'sprout'; break;
                case 'sprout': flower.stage = 'budding'; break;
                case 'budding':flower.stage = 'bloom'; break;
            }
            console.log(`[${room.id}] Flower ${slotId} grew to stage: ${flower.stage}`);
        }

        socket.emit('updatePlayerResources', player.resources);
        if (grown) {
            io.to(room.id).emit('flowerGrown', flower);
        }
    });


    socket.on('disconnect', (reason) => {
        console.log(`User disconnected: ${socket.id}. Reason: ${reason}`);
        const roomId = getRoomIdByCurrentSocketId(socket.id); // Find room using the disconnected socket ID
        if (roomId && rooms[roomId] && rooms[roomId].players[socket.id]) {
            const room = rooms[roomId];
            const disconnectingPlayer = { ...room.players[socket.id] }; // Copy player data before deleting
            const originalPlayerId = disconnectingPlayer.id; // Get the persistent ID

            console.log(`[${roomId}] Player ${disconnectingPlayer.name} (Original ID: ${originalPlayerId}, Socket: ${socket.id}) disconnected.`);

            // Move player data to disconnectedPlayers using ORIGINAL ID as key
            room.disconnectedPlayers[originalPlayerId] = {
                 data: disconnectingPlayer,
                 timestamp: Date.now()
            };
            delete room.players[socket.id]; // Remove from active players using current socket ID

            // Clean up old disconnected players periodically
            cleanupDisconnectedPlayers(room);

            // Notify remaining player (find their current socket ID)
            const partnerSocketId = Object.keys(room.players).find(sid => sid !== socket.id); // Should be only one left
            if (partnerSocketId) {
                io.to(partnerSocketId).emit('partnerDisconnected', {
                    name: disconnectingPlayer.name,
                    message: `${disconnectingPlayer.name} disconnected. Waiting ${RECONNECT_TIMEOUT / 1000}s for reconnect...`
                });
                // Pause the game if it was playing
                if (room.state === 'playing') {
                    console.log(`[${roomId}] Pausing game due to disconnect.`);
                    stopGameLoop(roomId);
                    room.state = 'paused';
                    io.to(partnerSocketId).emit('gamePaused', { message: `Waiting for ${disconnectingPlayer.name} to reconnect...` });
                }
            } else {
                // Room is now empty
                console.log(`[${roomId}] Room empty. Stopping loops, waiting for reconnect.`);
                stopGameLoop(roomId);
                room.state = 'waiting'; // Keep room state as waiting
                // Consider deleting the room if no one reconnects after timeout? Handled by cleanup potentially.
            }
        } else {
             console.log(`Socket ${socket.id} disconnected but was not found in an active room session.`);
        }
    });
});


// --- Game Loop Functions (Per Room) ---
function startGameLoop(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') {
        console.warn(`[${roomId}] Attempted to start loop but state is ${room?.state}`);
        return;
    }
    stopGameLoop(roomId); // Ensure no duplicates

    console.log(`[${roomId}] Starting game loop. Duration: ${room.gameDuration}s`);
    // Reset timer only if not resuming from pause? Or always reset? Let's reset.
    room.timer = room.gameDuration;
    io.to(roomId).emit('timerUpdate', room.timer);

    // Store interval IDs within the room object
    room.intervals.timer = setInterval(() => {
        const currentRoom = rooms[roomId]; // Re-fetch room state inside interval
        if (!currentRoom || currentRoom.state !== 'playing') {
            // console.log(`[${roomId}] Timer interval stopping: Room gone or not playing.`);
            stopGameLoop(roomId); // Stop all loops if state is wrong
            return;
        }
        currentRoom.timer--;
        io.to(roomId).emit('timerUpdate', currentRoom.timer);
        if (currentRoom.timer <= 0) {
            endGame(roomId);
        }
    }, 1000);

    room.intervals.resource = setInterval(() => spawnResource(roomId), RESOURCE_SPAWN_RATE);
    room.intervals.weather = setInterval(() => changeWeather(roomId), WEATHER_CHANGE_RATE);
}

function stopGameLoop(roomId) {
    const room = rooms[roomId];
    if (room?.intervals && Object.keys(room.intervals).length > 0) {
        // console.log(`[${roomId}] Stopping game loop intervals.`);
        clearInterval(room.intervals.timer);
        clearInterval(room.intervals.resource);
        clearInterval(room.intervals.weather);
        room.intervals = {};
    }
    // Ensure intervals object exists even if empty
    if (room && !room.intervals) {
        room.intervals = {};
    }
}

function endGame(roomId) {
    const room = rooms[roomId];
    if (!room || room.state === 'finished') return; // Prevent double execution

    console.log(`[${roomId}] Game Over!`);
    room.state = 'finished';
    stopGameLoop(roomId);

    let finalMessage = "Time's up! Look at the beautiful garden you grew together!";
    let fullyBloomed = Object.values(room.flowers).filter(f => f.stage === 'bloom').length;
    finalMessage += ` You bloomed ${fullyBloomed} Love Blooms!`;

    io.to(roomId).emit('gameOver', { message: finalMessage });
    // Consider deleting the room after a delay?
     setTimeout(() => {
         if (rooms[roomId] && rooms[roomId].state === 'finished') {
             console.log(`[${roomId}] Deleting finished room.`);
             delete rooms[roomId];
         }
     }, 20000); // Delete after 20 seconds
}


function spawnResource(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return; // Check state

    if (Object.keys(room.resources).length >= MAX_RESOURCES_PER_ROOM) return;

    const resourceId = `res_${roomId}_${room.nextResourceId++}`; // Room-specific ID
    const type = Math.random() < 0.6 ? 'petal' : 'water';
    const position = {
        x: (Math.random() - 0.5) * GARDEN_SIZE_SERVER,
        y: 0.5, // Spawn slightly above ground
        z: (Math.random() - 0.5) * GARDEN_SIZE_SERVER
    };

    const newResource = { id: resourceId, type, position };
    room.resources[resourceId] = newResource;

    // console.log(`[${roomId}] Spawning resource: ${type}`); // Less verbose log
    io.to(roomId).emit('resourceSpawned', newResource);
}

function changeWeather(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return; // Check state

    const previousWeather = room.weather;
    const possibleWeathers = WEATHER_TYPES.filter(w => w !== previousWeather);
    room.weather = possibleWeathers[Math.floor(Math.random() * possibleWeathers.length)];

    console.log(`[${roomId}] Weather changed to: ${room.weather}`);
    io.to(roomId).emit('weatherUpdate', room.weather);
}

// Helper to get room state suitable for sending to clients (omits intervals etc.)
function getSanitizedRoomState(room) {
    if (!room) return null;
    return {
        players: room.players,
        resources: Object.values(room.resources), // Send as array
        flowers: room.flowers,
        timer: room.timer,
        weather: room.weather,
        gameDuration: room.gameDuration,
        state: room.state,
        hostId: room.hostId // Might be useful on client
    };
}

// Helper to find the current socket ID for a given original player ID within a room
function findCurrentSocketIdForPlayer(room, originalPlayerId) {
    if (!room || !room.players) return null;
    for (const currentSocketId in room.players) {
        if (room.players[currentSocketId].id === originalPlayerId) {
            return currentSocketId;
        }
    }
    return null; // Player not found among active players
}

// Helper to clean up old disconnected player data
function cleanupDisconnectedPlayers(room) {
    if (!room || !room.disconnectedPlayers) return;
    const now = Date.now();
    for (const originalPlayerId in room.disconnectedPlayers) {
        if (now - room.disconnectedPlayers[originalPlayerId].timestamp > RECONNECT_TIMEOUT) {
            console.log(`[${room.id || 'Unknown Room'}] Cleaning up expired disconnected player ${originalPlayerId}`);
            delete room.disconnectedPlayers[originalPlayerId];
        }
    }
     // Optional: If room is empty and has no disconnected players waiting, delete it?
     if (Object.keys(room.players).length === 0 && Object.keys(room.disconnectedPlayers).length === 0 && room.state !== 'playing') {
          console.log(`[${room.id || 'Unknown Room'}] Room empty and no pending reconnects. Deleting.`);
          const roomIdToDelete = Object.keys(rooms).find(rid => rooms[rid] === room); // Find ID to delete
          if (roomIdToDelete) delete rooms[roomIdToDelete];
     }
}
// Periodically clean up all rooms (optional, helps if disconnect logic misses something)
setInterval(() => {
     // console.log("Running periodic cleanup...");
     for(const roomId in rooms) {
          cleanupDisconnectedPlayers(rooms[roomId]);
     }
}, 60000); // Run every minute


// Add room ID property to room objects for easier access inside handlers
Object.values(rooms).forEach((room, index) => {
     const roomId = Object.keys(rooms)[index];
     room.id = roomId;
});


// --- Start Server ---
server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
});