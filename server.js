// server.js (Major Refactor for Rooms)
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
// const { Vector3 } = require('three'); // Only if needed for complex server calcs

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// --- Game Constants (Server Side - Keep as before or adjust) ---
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

// --- Game State Management (Per Room) ---
let rooms = {}; // { roomId: { players: { socketId: playerData }, resources: {}, flowers: {}, timer, weather, gameDuration, state ('waiting'/'playing'/'finished'), intervals: { timer, resource, weather }, nextResourceId } }

function generateRoomId() {
    // Simple 4-char ID for easy sharing
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function createRoom(hostSocketId, hostName, gameDuration) {
    const roomId = generateRoomId();
    rooms[roomId] = {
        players: {
            [hostSocketId]: {
                id: hostSocketId,
                name: hostName || `Player_${hostSocketId.substring(0,4)}`, // Use name or default
                position: { x: (Math.random() - 0.5) * 5, y: 0.5, z: (Math.random() - 0.5) * 5 }, // Start closer
                resources: { petals: 0, water: 0 }
            }
        },
        resources: {},
        flowers: {},
        timer: gameDuration || DEFAULT_GAME_DURATION,
        weather: 'Sunny',
        gameDuration: gameDuration || DEFAULT_GAME_DURATION,
        state: 'waiting', // 'waiting', 'playing', 'finished'
        intervals: {}, // Store interval IDs here
        nextResourceId: 0,
        hostId: hostSocketId // Track host
    };
    console.log(`Room ${roomId} created by ${hostName} (${hostSocketId})`);
    return roomId;
}

function getRoomBySocketId(socketId) {
    for (const roomId in rooms) {
        if (rooms[roomId].players[socketId]) {
            return rooms[roomId];
        }
    }
    return null;
}

function getRoomIdBySocketId(socketId) {
     for (const roomId in rooms) {
        if (rooms[roomId].players[socketId]) {
            return roomId;
        }
    }
    return null;
}


// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('hostGame', ({ playerName, duration }) => {
        // Ensure player isn't already in a room
        if (getRoomBySocketId(socket.id)) {
             socket.emit('setupError', { message: "You are already in a room!" });
             return;
        }
        const gameDuration = parseInt(duration, 10) || DEFAULT_GAME_DURATION;
        const roomId = createRoom(socket.id, playerName, gameDuration);
        socket.join(roomId); // Join Socket.IO room
        socket.emit('roomCreated', { roomId, initialState: rooms[roomId], playerId: socket.id });
        console.log(`Player ${playerName} (${socket.id}) hosted room ${roomId}`);
    });

    socket.on('joinGame', ({ playerName, roomId }) => {
        // Ensure player isn't already in a room
         if (getRoomBySocketId(socket.id)) {
             socket.emit('setupError', { message: "You are already in a room!" });
             return;
        }

        roomId = roomId.toUpperCase(); // Match generated IDs
        const room = rooms[roomId];

        if (!room) {
            socket.emit('setupError', { message: "Room not found." });
            return;
        }
        if (room.state !== 'waiting') {
            socket.emit('setupError', { message: "Room is already full or in progress." });
            return;
        }
        if (Object.keys(room.players).length >= 2) {
             socket.emit('setupError', { message: "Room is full." });
             return;
        }


        socket.join(roomId); // Join Socket.IO room
        // Add player to room state
        room.players[socket.id] = {
            id: socket.id,
            name: playerName || `Player_${socket.id.substring(0,4)}`,
            position: { x: (Math.random() - 0.5) * 5, y: 0.5, z: (Math.random() - 0.5) * 5 }, // Different start pos
            resources: { petals: 0, water: 0 }
        };
        console.log(`Player ${playerName} (${socket.id}) joined room ${roomId}`);

        // Notify the joining player
        socket.emit('joinedRoom', { roomId, initialState: room, playerId: socket.id });

        // Notify the host player
        const hostSocketId = room.hostId;
        io.to(hostSocketId).emit('partnerJoined', room.players[socket.id]); // Send new player's data

        // Start game if room is now full
        if (Object.keys(room.players).length === 2) {
            room.state = 'playing';
            startGameLoop(roomId);
             io.to(roomId).emit('gameStart', { message: "Partner joined! Let's grow!" }); // Notify both players game starts
            console.log(`Room ${roomId} is now full. Starting game.`);
        }
    });

    // --- Game Event Handlers (Now Room-Specific) ---
    socket.on('playerMove', (position) => {
        const roomId = getRoomIdBySocketId(socket.id);
        const room = rooms[roomId];
        if (!room || !room.players[socket.id] || room.state !== 'playing') return;

        room.players[socket.id].position = position;
        // Broadcast movement ONLY to the other player in the room
        socket.to(roomId).emit('playerMoved', { id: socket.id, position });
    });

    socket.on('collectResource', (resourceId) => {
        const roomId = getRoomIdBySocketId(socket.id);
        const room = rooms[roomId];
        const player = room?.players[socket.id];
        const resource = room?.resources[resourceId];

        if (!player || !resource || room.state !== 'playing') return;

        // Optional: Server-side distance check if needed

        console.log(`[${roomId}] Player ${player.name} collected resource ${resourceId}`);

        if (resource.type === 'petal') player.resources.petals++;
        else player.resources.water++;

        delete room.resources[resourceId];

        socket.emit('updatePlayerResources', player.resources); // Update collector
        io.to(roomId).emit('resourceRemoved', resourceId); // Notify room
    });

    socket.on('plantFlower', (data) => {
        const roomId = getRoomIdBySocketId(socket.id);
        const room = rooms[roomId];
        const player = room?.players[socket.id];
        const slotId = data?.slotId;
        const flower = room?.flowers[slotId];

        if (!player || !slotId || flower || player.resources.petals <= 0 || room.state !== 'playing') {
            console.log(`[${roomId}] Player ${player?.name} failed plant @ ${slotId}. Conditions met? ${!player} ${!slotId} ${!!flower} ${player?.resources.petals <= 0} ${room?.state !== 'playing'}`);
            socket.emit('actionFailed', { message: "Cannot plant here or need more petals!" });
            return;
        }

        // Optional: Server-side distance check
         const slot = FLOWER_SLOT_POSITIONS_SERVER.find(s => s.id === slotId);
        if(!slot) return; // Should not happen if client sends valid ID

        console.log(`[${roomId}] Player ${player.name} planted seed @ ${slotId}`);

        player.resources.petals--;
        room.flowers[slotId] = {
            slotId: slotId, stage: 'seed', plantedBy: socket.id, nurtureProgress: 0
        };

        socket.emit('updatePlayerResources', player.resources);
        io.to(roomId).emit('flowerPlanted', room.flowers[slotId]);
    });

    socket.on('nurtureFlower', (data) => {
         const roomId = getRoomIdBySocketId(socket.id);
         const room = rooms[roomId];
         const player = room?.players[socket.id];
         const slotId = data?.slotId;
         const flower = room?.flowers[slotId];

        if (!player || !flower || flower.stage === 'bloom' || player.resources.water <= 0 || room.state !== 'playing') {
            console.log(`[${roomId}] Player ${player?.name} failed nurture @ ${slotId}. Conditions met? ${!player} ${!flower} ${flower?.stage === 'bloom'} ${player?.resources.water <= 0} ${room?.state !== 'playing'}`);
            socket.emit('actionFailed', { message: "Cannot nurture this or need more water!" });
            return;
        }

        // Optional: Server-side distance check

        console.log(`[${roomId}] Player ${player.name} nurtured flower @ ${slotId}`);

        player.resources.water--;
        const modifier = WEATHER_GROWTH_MODIFIERS[room.weather] || 1.0;
        flower.nurtureProgress += (1 * modifier);

        let grown = false;
        const requiredProgress = FLOWER_GROWTH_TIMES[flower.stage];

        if (flower.nurtureProgress >= requiredProgress) {
            grown = true;
            flower.nurtureProgress = 0;
             switch (flower.stage) {
                case 'seed':   flower.stage = 'sprout'; break;
                case 'sprout': flower.stage = 'budding'; break;
                case 'budding':flower.stage = 'bloom'; break;
            }
             console.log(`[${roomId}] Flower ${slotId} grew to stage: ${flower.stage}`);
        }

        socket.emit('updatePlayerResources', player.resources);
        if (grown) {
            io.to(roomId).emit('flowerGrown', flower);
        } else {
            // Can optionally send nurture success without growth
             // socket.emit('flowerNurtured', { slotId: slotId }); // Notify nurturer
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const roomId = getRoomIdBySocketId(socket.id);
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            const remainingPlayerName = room.players[socket.id]?.name || 'Someone';
            console.log(`${remainingPlayerName} left room ${roomId}`);

            delete room.players[socket.id]; // Remove player

            // Notify remaining player
             socket.to(roomId).emit('partnerLeft', { message: `${remainingPlayerName} disconnected.` });

            // Stop game loops, set room state
            stopGameLoop(roomId);
            room.state = 'waiting'; // Or 'finished'/'aborted'

             // If room becomes empty, delete it after a short delay (cleanup)
             if (Object.keys(room.players).length === 0) {
                console.log(`Room ${roomId} is empty, deleting.`);
                delete rooms[roomId];
             } else {
                // If host leaves, maybe assign host role to remaining player? Or just leave as waiting.
                // For simplicity, just set to waiting. The remaining player might leave too.
                 room.state = 'waiting';
                 console.log(`Room ${roomId} set to 'waiting' after player left.`);
                 // Notify remaining player they can wait or leave
                 // io.to(roomId).emit('roomStateUpdate', { state: 'waiting' });
             }
        }
    });
});

// --- Game Loop Functions (Now Per Room) ---
function startGameLoop(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;

    stopGameLoop(roomId); // Ensure no duplicates

    console.log(`[${roomId}] Starting game loop... Duration: ${room.gameDuration}s`);
    room.timer = room.gameDuration;
    io.to(roomId).emit('timerUpdate', room.timer); // Send initial timer

    // Store interval IDs within the room object
    room.intervals.timer = setInterval(() => {
        if (!rooms[roomId] || room.state !== 'playing') {
            clearInterval(room.intervals.timer); return;
        }
        room.timer--;
        io.to(roomId).emit('timerUpdate', room.timer);
        if (room.timer <= 0) {
            endGame(roomId);
        }
    }, 1000);

    room.intervals.resource = setInterval(() => spawnResource(roomId), RESOURCE_SPAWN_RATE);
    room.intervals.weather = setInterval(() => changeWeather(roomId), WEATHER_CHANGE_RATE);
}

function stopGameLoop(roomId) {
    const room = rooms[roomId];
    if (room?.intervals) {
        console.log(`[${roomId}] Stopping game loop intervals.`);
        clearInterval(room.intervals.timer);
        clearInterval(room.intervals.resource);
        clearInterval(room.intervals.weather);
        room.intervals = {}; // Clear interval IDs
    }
}

function resetRoomGameState(roomId) {
    // Optional: Function to reset a room for a new game without kicking players
    const room = rooms[roomId];
    if (!room) return;
    console.log(`[${roomId}] Resetting game state.`);
    room.resources = {};
    room.flowers = {};
    room.timer = room.gameDuration;
    room.weather = 'Sunny';
    room.nextResourceId = 0;
    room.state = 'playing'; // Or 'waiting' if reset before start
    // Notify clients about the reset state
    io.to(roomId).emit('gameStateReset', {
        resources: [], flowers: {}, timer: room.timer, weather: room.weather
    });
}

function endGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    console.log(`[${roomId}] Game Over!`);
    room.state = 'finished';
    stopGameLoop(roomId);

    let finalMessage = "Time's up! Look at the beautiful garden you grew together!";
    let fullyBloomed = Object.values(room.flowers).filter(f => f.stage === 'bloom').length;
    finalMessage += ` You bloomed ${fullyBloomed} Love Blooms!`;

    io.to(roomId).emit('gameOver', { message: finalMessage });
    // Consider adding a "Play Again" button/flow on the client
}


function spawnResource(roomId) {
    const room = rooms[roomId];
     // Check if room exists and is playing before proceeding
    if (!room || room.state !== 'playing') {
        // If the interval is still running for a non-existent/non-playing room, stop it.
        // This can happen if a room ended/deleted right before the interval fired.
         if (room && room.intervals.resource) {
             clearInterval(room.intervals.resource);
             delete room.intervals.resource;
         }
         return;
    }

    if (Object.keys(room.resources).length >= MAX_RESOURCES_PER_ROOM) {
        return;
    }

    const resourceId = `res_${room.nextResourceId++}`;
    const type = Math.random() < 0.6 ? 'petal' : 'water';
    const position = {
        x: (Math.random() - 0.5) * GARDEN_SIZE_SERVER,
        y: 0.5,
        z: (Math.random() - 0.5) * GARDEN_SIZE_SERVER
    };

    const newResource = { id: resourceId, type, position };
    room.resources[resourceId] = newResource;

    // console.log(`[${roomId}] Spawning resource: ${type}`); // Less verbose logging
    io.to(roomId).emit('resourceSpawned', newResource);
}

function changeWeather(roomId) {
    const room = rooms[roomId];
    // Check if room exists and is playing before proceeding
    if (!room || room.state !== 'playing') {
         if (room && room.intervals.weather) {
            clearInterval(room.intervals.weather);
            delete room.intervals.weather;
         }
        return;
    }

    const previousWeather = room.weather;
    const possibleWeathers = WEATHER_TYPES.filter(w => w !== previousWeather);
    room.weather = possibleWeathers[Math.floor(Math.random() * possibleWeathers.length)];

    console.log(`[${roomId}] Weather changed to: ${room.weather}`);
    io.to(roomId).emit('weatherUpdate', room.weather);
}

// Start the server
server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
});