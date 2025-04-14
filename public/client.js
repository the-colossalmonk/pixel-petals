// public/client.js
// Use module THREE version via import map
// import * as THREE from 'three';
// import { FontLoader } from 'FontLoader';
// import { TextGeometry } from 'TextGeometry';
import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
// import { FontLoader } from 'https://unpkg.com/three@0.128.0/examples/jsm/loaders/FontLoader.js';
import { FontLoader } from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/loaders/FontLoader.js';
import { TextGeometry } from 'https://unpkg.com/three@0.128.0/examples/jsm/geometries/TextGeometry.js';


// --- Global Variables ---
let scene, camera, renderer;
let playerMesh, playerLight, myPlayerNameMesh;
// Use persistent original player ID as key for robust handling across reconnects
let otherPlayers = {}; // { originalPlayerId: { data: playerData, mesh: playerMesh, nameMesh: nameMesh, targetPosition?: Vector3 } }
let resourcesOnScreen = {}; // { resourceId: mesh }
let flowersOnScreen = {}; // { slotId: mesh }
let gardenGrid, gardenPlane;
let keys = {}; // Tracks keyboard state
let clock = new THREE.Clock();
let socket;
let myPlayerId; // Stores the ORIGINAL (persistent) socket ID received on join/host
let myCurrentSocketId; // Stores the current connection's socket ID
let myPlayerName, partnerName;
let currentRoomId; // Track the room we are in
let font = null; // To store the loaded font
let lastSentPosition = new THREE.Vector3(); // For throttling movement updates
const MOVE_UPDATE_THRESHOLD = 0.05; // How much position change triggers update

// --- Game State (Client Side) ---
let clientState = {
    players: {}, // Store player data keyed by original ID { originalPlayerId: playerData }
    resources: { petals: 0, water: 0 },
    weather: 'Sunny',
    timer: 1800,
    gameDuration: 1800,
    flowers: {},
    flowerSlots: [],
    gameState: 'setup', // 'setup', 'connecting', 'waiting', 'playing', 'paused', 'finished', 'reconnecting'
    nearbyAction: null, // { type: 'plant'/'nurture', targetId: slotId }
    // Store previous connection details for reconnect
    lastRoomId: null,
    lastPlayerId: null // Stores the original player ID for reconnect logic
};
let gameStartTime = null; // Track when 'playing' state begins
let helperOverlayStartTime = null; // Track when overlay helper starts
const HELPER_OVERLAY_DURATION = 60; // Show overlay helper for 60 seconds
const HELPER_HINT_DURATION = 600; // Show corner hints for 10 minutes total

// --- Constants ---
const PLAYER_SPEED = 5.0;
const GARDEN_SIZE = 20;
const GRID_DIVISIONS = 20; // Keep if grid helper is used
const FLOWER_SLOT_POSITIONS = [ // Must match server
    { x: -5, z: -5 }, { x: 0, z: -5 }, { x: 5, z: -5 },
    { x: -5, z: 0 },  { x: 0, z: 0 },  { x: 5, z: 0 },
    { x: -5, z: 5 },  { x: 0, z: 5 },  { x: 5, z: 5 },
];
const PLAYER_NAME_OFFSET = new THREE.Vector3(0, 1.5, 0); // Offset for name tag above player
const CAMERA_OFFSET = new THREE.Vector3(0, 12, 14); // Camera distance from player
const ACTION_RADIUS_SQ = 2.0 * 2.0; // Squared radius for Planting/Nurturing prompts

// --- DOM Elements ---
const overlay = document.getElementById('overlay');
const introScreen = document.getElementById('intro-screen');
const setupScreen = document.getElementById('setup-screen');
const startSetupButton = document.getElementById('start-setup-button');
const playerNameInput = document.getElementById('player-name');
const hostButton = document.getElementById('host-button');
const joinButton = document.getElementById('join-button');
const timeLimitSelect = document.getElementById('time-limit');
const roomIdInput = document.getElementById('room-id-input');
const roomIdDisplay = document.getElementById('room-id-display');
const roomIdText = roomIdDisplay.querySelector('strong');
const setupError = document.getElementById('setup-error');
const waitingMessage = document.getElementById('waiting-message');
const reconnectPrompt = document.getElementById('reconnect-prompt');
const reconnectMessage = document.getElementById('reconnect-message');
const forceRefreshButton = document.getElementById('force-refresh-button');

const gameUI = document.getElementById('game-ui');
const gameContainer = document.getElementById('game-container');
const timerDisplay = document.getElementById('timer');
const resourcesDisplay = document.getElementById('resources');
const weatherDisplay = document.getElementById('weather');
const myNameDisplay = document.getElementById('my-name');
const partnerNameDisplay = document.getElementById('partner-name');
const roomCodeValue = document.getElementById('room-code-value'); // Get element for room code
const messageDisplay = document.getElementById('message');
const timedHelperDisplay = document.getElementById('timed-helper');
const hintCornerDisplay = document.getElementById('hint-corner'); // Get hint element
const actionPromptDisplay = document.getElementById('action-prompt');

// Mobile controls
const joystickArea = document.getElementById('joystick-area');
const joystickThumb = document.getElementById('joystick-thumb');
const buttonPlant = document.getElementById('button-plant');
const buttonNurture = document.getElementById('button-nurture');

// Mobile joystick state
let joystickActive = false;
let joystickTouchId = null;
let joystickStartPos = { x: 0, y: 0 };
let joystickCurrentPos = { x: 0, y: 0 };
const JOYSTICK_MAX_RADIUS = 50; // Max distance thumb moves from center (pixels)


// --- Initialization ---
function init() {
    console.log("[Client] Initializing...");
    loadFont();
    setupUIListeners();
    setupMobileControls();
    setupSocketIO(); // Connect socket immediately
}

async function loadFont() {
    const loader = new FontLoader();
    try {
        // *** IMPORTANT: Ensure 'public/fonts/helvetiker_regular.typeface.json' exists ***
        font = await loader.loadAsync('fonts/helvetiker_regular.typeface.json');
        console.log("[Client] Font loaded successfully.");
    } catch (error) {
        console.error("[Client] Failed to load font. 3D Name Tags disabled.", error);
        font = null;
    }
}


function initThreeJS() {
    if (scene) return;
    console.log("[Client] Initializing Three.js scene...");

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    gameContainer.appendChild(renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    directionalLight.position.set(8, 15, 10);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 1024;
    directionalLight.shadow.mapSize.height = 1024;
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far = 50;
    directionalLight.shadow.camera.left = -GARDEN_SIZE / 2;
    directionalLight.shadow.camera.right = GARDEN_SIZE / 2;
    directionalLight.shadow.camera.top = GARDEN_SIZE / 2;
    directionalLight.shadow.camera.bottom = -GARDEN_SIZE / 2;
    scene.add(directionalLight);

    // Create Static Game Elements
    createGarden();
    initFlowerSlots();

    // Ensure meshes for known players are created
    console.log("[Client] initThreeJS: Re-creating player meshes from state:", clientState.players);
    clearAndAddPlayers(clientState.players, myPlayerId); // Use persistent ID

    // Event Listeners
    window.addEventListener('resize', onWindowResize, false);
    document.addEventListener('keydown', onKeyDown, false);
    document.addEventListener('keyup', onKeyUp, false);

    console.log("[Client] Three.js initialized.");
    animate(); // Start the rendering loop
}

// --- UI Setup and Listeners ---
function setupUIListeners() {
    startSetupButton.addEventListener('click', () => {
        introScreen.classList.remove('active');
        introScreen.style.display = 'none';
        setupScreen.style.display = 'block';
        setupScreen.classList.add('active');
    });

    hostButton.addEventListener('click', () => {
        const name = playerNameInput.value.trim() || `Player_${Math.random().toString(36).substring(7)}`;
        const duration = timeLimitSelect.value;
        if (name && socket?.connected) { // Check socket connection
            myPlayerName = name;
            myNameDisplay.textContent = myPlayerName;
            setSetupStatus("Hosting game...", true);
            clientState.gameState = 'connecting';
            console.log("[Client] Emitting hostGame");
            socket.emit('hostGame', { playerName: name, duration: duration });
        } else if (!socket?.connected) {
             setSetupStatus("Not connected to server.", false, true);
        } else {
             setSetupStatus("Please enter a name.", false, true);
        }
    });

    joinButton.addEventListener('click', () => {
        const name = playerNameInput.value.trim() || `Player_${Math.random().toString(36).substring(7)}`;
        const roomId = roomIdInput.value.trim().toUpperCase();
        if (name && roomId && socket?.connected) { // Check socket connection
             myPlayerName = name;
             myNameDisplay.textContent = myPlayerName;
             setSetupStatus("Joining room...", true);
             clientState.gameState = 'connecting';
             console.log("[Client] Emitting joinGame");
             socket.emit('joinGame', { playerName: name, roomId: roomId });
        } else if (!socket?.connected) {
            setSetupStatus("Not connected to server.", false, true);
        } else if (!name) {
             setSetupStatus("Please enter a name.", false, true);
        } else {
            setSetupStatus("Please enter a Room ID.", false, true);
        }
    });

    forceRefreshButton.addEventListener('click', () => window.location.reload());
}

function setSetupStatus(message, isLoading = false, isError = false) {
     setupError.textContent = message;
     setupError.style.color = isError ? '#d9534f' : '#6b4f4f';
     waitingMessage.classList.add('hidden');
     roomIdDisplay.classList.add('hidden');

     hostButton.disabled = isLoading;
     joinButton.disabled = isLoading;
     playerNameInput.disabled = isLoading;
     roomIdInput.disabled = isLoading;
     timeLimitSelect.disabled = isLoading;
}

function showWaitingState(roomId) {
    setSetupStatus("", true); // Clear errors, disable buttons
    roomIdText.textContent = roomId;
    roomIdDisplay.classList.remove('hidden');
    waitingMessage.classList.remove('hidden');
}

function hideSetupUIAndStartGame() {
    console.log("[Client] Hiding setup UI, starting game visuals.");
    overlay.classList.add('hidden');
    gameUI.classList.remove('hidden');
    clientState.gameState = 'playing'; // Set state first
    gameStartTime = Date.now();
    helperOverlayStartTime = Date.now();
    if (!scene) {
        initThreeJS(); // Initialize the 3D environment now
    } else {
        // Scene exists (maybe from reconnect?), ensure players are correct
        clearAndAddPlayers(clientState.players, myPlayerId);
        animate(); // Ensure animation loop is running
    }
}

function showOverlayWithMessage(message) {
     console.log("[Client] Showing overlay message:", message);
     // Use reconnect prompt structure for consistency
     reconnectMessage.textContent = message.replace(/\n/g, '<br>');
     forceRefreshButton.textContent = "Refresh"; // Change button text
     forceRefreshButton.classList.remove('hidden');
     overlay.classList.remove('hidden');
     introScreen.classList.remove('active');
     setupScreen.classList.remove('active');
     reconnectPrompt.classList.add('active'); // Show reconnect prompt style
     gameUI.classList.add('hidden');
     clientState.gameState = 'finished'; // Or appropriate end state
}

function showReconnectPrompt(message) {
     console.log("[Client] Showing reconnect prompt:", message);
     reconnectMessage.textContent = message;
     overlay.classList.remove('hidden');
     introScreen.classList.remove('active');
     setupScreen.classList.remove('active');
     reconnectPrompt.classList.add('active');
     gameUI.classList.add('hidden');
     forceRefreshButton.classList.add('hidden'); // Hide refresh initially
}
function hideReconnectPrompt() {
     console.log("[Client] Hiding reconnect prompt.");
     reconnectPrompt.classList.remove('active');
     // Overlay might still be hidden by other logic (e.g., hideSetupUIAndStartGame)
}


// --- Socket.IO Setup and Handlers ---
function setupSocketIO() {
    if (socket) return;

    console.log("[Client] Setting up Socket.IO connection...");
    socket = io({
        reconnectionAttempts: 5,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 5000,
        timeout: 10000,
    });

    socket.on('connect', () => {
        myCurrentSocketId = socket.id; // Update current socket ID
        console.log(`[Client] Connected to server! Socket ID: ${myCurrentSocketId}`);

        if (clientState.lastRoomId && clientState.lastPlayerId && clientState.gameState === 'reconnecting') {
            console.log(`[Client] Attempting reconnect for player ${clientState.lastPlayerId} in room ${clientState.lastRoomId}`);
            reconnectMessage.textContent = "Reconnecting...";
            forceRefreshButton.classList.add('hidden');
            socket.emit('reconnectPlayer', {
                roomId: clientState.lastRoomId,
                playerId: clientState.lastPlayerId // Send original player/socket ID
            });
        } else {
             // Normal connection or first connection
             if (clientState.gameState !== 'setup') { // Avoid resetting if already in setup
                 console.log("[Client] Resetting to setup state on connect.");
                 clientState.gameState = 'setup';
                 overlay.classList.remove('hidden');
                 setupScreen.classList.add('active');
                 introScreen.classList.remove('active');
                 reconnectPrompt.classList.remove('active');
                 gameUI.classList.add('hidden');
             }
             setSetupStatus(""); // Clear status messages
        }
    });

    socket.on('disconnect', (reason) => {
        console.warn(`[Client] Disconnected from server! Reason: ${reason}. Current State: ${clientState.gameState}`);
        myCurrentSocketId = null;

        // Only attempt reconnect if we were actively in a game state and have the necessary IDs
        if ((clientState.gameState === 'playing' || clientState.gameState === 'paused' || clientState.gameState === 'waiting') && clientState.lastPlayerId && clientState.lastRoomId) {
            console.log("[Client] Game was active, entering reconnect state.");
            clientState.gameState = 'reconnecting';
            showReconnectPrompt(`Disconnected: ${reason}. Trying to reconnect...`);
            setTimeout(() => {
                 if (clientState.gameState === 'reconnecting') {
                     console.error("[Client] Auto-reconnect likely failed.");
                     reconnectMessage.textContent = "Reconnect attempt failed. Server might be unavailable.";
                     forceRefreshButton.classList.remove('hidden');
                 }
             }, 15000); // Show refresh button after 15 seconds
        } else if (clientState.gameState !== 'finished') {
            console.log("[Client] Disconnected during non-game state, likely needs setup reset.");
            // Let the 'connect' handler reset to setup UI when connection re-established
        }
        // Clear interaction prompts/hints
        actionPromptDisplay.classList.add('hidden');
        timedHelperDisplay.classList.add('hidden');
        hintCornerDisplay.classList.add('hidden');
    });

    socket.on('connect_error', (err) => {
        console.error("[Client] Connection Error:", err.message);
        if (clientState.gameState === 'reconnecting') {
            reconnectMessage.textContent = `Connection Error: ${err.message}. Server may be down.`;
            forceRefreshButton.classList.remove('hidden');
        } else if (clientState.gameState !== 'finished') {
            setSetupStatus(`Cannot connect: ${err.message}`, false, true);
        }
    });

    // --- Room and Game State Handlers ---
    socket.on('roomCreated', ({ roomId, initialState, playerId }) => {
        console.log(`[Client] <- roomCreated. Room ${roomId}. My Player ID: ${playerId}`);
        currentRoomId = roomId;
        myPlayerId = playerId; // This is the persistent ID
        clientState.lastRoomId = roomId; // Store for potential reconnect
        clientState.lastPlayerId = playerId;
        roomCodeValue.textContent = roomId;
        initializeClientState(initialState, myPlayerId); // Use persistent ID
        clientState.gameState = 'waiting';
        showWaitingState(roomId);
    });

    socket.on('joinedRoom', ({ roomId, initialState, playerId }) => {
        console.log(`[Client] <- joinedRoom. Room ${roomId}. My Player ID: ${playerId}`);
        currentRoomId = roomId;
        myPlayerId = playerId; // Persistent ID
        clientState.lastRoomId = roomId;
        clientState.lastPlayerId = playerId;
        roomCodeValue.textContent = roomId;
        initializeClientState(initialState, myPlayerId); // Use persistent ID

        if (Object.keys(initialState.players).length < 2) {
            clientState.gameState = 'waiting';
            showWaitingState(roomId);
        } else {
             clientState.gameState = 'waiting'; // Wait for gameStart
             setSetupStatus("Partner found! Starting game...", true);
        }
    });

     socket.on('reconnectSuccess', ({ roomId, initialState, playerId }) => {
         // playerId here is the ORIGINAL persistent player ID
         console.log(`[Client] <- reconnectSuccess. Room ${roomId}. My Player ID: ${playerId}. Current Socket: ${socket.id}`);
         currentRoomId = roomId;
         myPlayerId = playerId; // Ensure persistent ID is set
         clientState.lastRoomId = roomId;
         clientState.lastPlayerId = playerId;
         myCurrentSocketId = socket.id; // Update current socket ID
         roomCodeValue.textContent = roomId;

         hideReconnectPrompt();
         overlay.classList.add('hidden');
         gameUI.classList.remove('hidden');

         initializeClientState(initialState, myPlayerId); // Use persistent ID

         clientState.gameState = initialState.state;

         console.log(`[Client] Reconnected. Restored game state: ${clientState.gameState}`);

         if (clientState.gameState === 'playing') {
             if (!scene) initThreeJS();
             else clearAndAddElementsFromState(initialState);
             gameStartTime = Date.now() - ((initialState.gameDuration - initialState.timer) * 1000);
             helperOverlayStartTime = Date.now();
             animate();
         } else { // Game was paused/waiting
             if (!scene) initThreeJS();
             else clearAndAddElementsFromState(initialState);
             messageDisplay.textContent = "Reconnected! Waiting for game to resume...";
             animate(); // Make sure rendering starts/continues
         }
     });

     socket.on('reconnectFailed', ({ message }) => {
         console.error(`[Client] <- reconnectFailed: ${message}`);
         showReconnectPrompt(message);
         forceRefreshButton.classList.remove('hidden');
         clientState.lastRoomId = null;
         clientState.lastPlayerId = null;
         clientState.gameState = 'setup';
     });

    socket.on('partnerJoined', (partnerData) => {
        // partnerData contains { id(original), name, position, resources }
        console.log(`[Client] <- partnerJoined: ${partnerData.name} (ID: ${partnerData.id})`);
        const originalPlayerId = partnerData.id;
        if (!clientState.players[originalPlayerId]) {
            clientState.players[originalPlayerId] = partnerData;
        }
        if (!otherPlayers[originalPlayerId]) {
             partnerName = partnerData.name;
             partnerNameDisplay.textContent = partnerName;
             addOtherPlayer(partnerData); // Add data and visuals
             console.log(`[Client] Added partner ${partnerData.name} visuals.`);
         } else {
             console.warn(`[Client] Partner ${partnerData.name} joined but already exists? Updating data.`);
             otherPlayers[originalPlayerId].data = partnerData; // Update data
             partnerNameDisplay.textContent = partnerData.name;
             // Ensure visuals are correct
             if(scene) addOtherPlayerMesh(originalPlayerId);
         }
        waitingMessage.classList.add('hidden');
    });

     socket.on('partnerDisconnected', ({ name, message }) => {
        console.log(`[Client] <- partnerDisconnected: ${name}`);
        messageDisplay.textContent = message;
        partnerNameDisplay.textContent = "Disconnected";
        // Don't change gameState here, wait for gamePaused event
        // Find partner by name is unreliable, find by ID if possible
        const partnerEntry = Object.entries(otherPlayers).find(([pId, pData]) => pData?.data?.name === name);
         if (partnerEntry) {
             const originalPlayerId = partnerEntry[0];
             console.log(`[Client] Removing visuals for disconnected partner ${originalPlayerId}`);
             removeOtherPlayerVisuals(originalPlayerId); // Remove visuals, keep data entry in otherPlayers
         } else {
             console.warn(`[Client] Could not find partner ${name} to remove visuals.`);
         }
    });

     socket.on('partnerReconnected', (partnerData) => {
         // partnerData contains { id(original), name, position, resources }
         const originalPlayerId = partnerData.id;
         console.log(`[Client] <- partnerReconnected: ${partnerData.name} (ID: ${originalPlayerId})`);
         messageDisplay.textContent = `${partnerData.name} reconnected!`;
         setTimeout(() => { if (messageDisplay.textContent === `${partnerData.name} reconnected!`) messageDisplay.textContent = ""; }, 3000);
         partnerName = partnerData.name;
         partnerNameDisplay.textContent = partnerName;

         // Update client state players list
         clientState.players[originalPlayerId] = partnerData;

         // Ensure visual representation exists or is updated
         if (!otherPlayers[originalPlayerId]) {
             addOtherPlayer(partnerData); // Add data and create visuals
         } else {
             otherPlayers[originalPlayerId].data = partnerData; // Update data
             otherPlayers[originalPlayerId].targetPosition = new THREE.Vector3().copy(partnerData.position); // Update target
             if(scene) addOtherPlayerMesh(originalPlayerId); // Ensure mesh exists
         }
         // Game state might resume via 'gameResumed'
    });


    socket.on('gameStart', ({ message }) => {
        console.log("[Client] <- gameStart", message);
        messageDisplay.textContent = message;
        setTimeout(() => { if (messageDisplay.textContent === message) messageDisplay.textContent = ""; }, 3000);
        hideSetupUIAndStartGame();
    });

    socket.on('gamePaused', ({ message }) => {
         console.log("[Client] <- gamePaused:", message);
         messageDisplay.textContent = message;
         clientState.gameState = 'paused';
         timedHelperDisplay.classList.add('hidden');
         hintCornerDisplay.classList.add('hidden');
         actionPromptDisplay.classList.add('hidden');
         keys = {}; // Stop movement inputs
     });

     socket.on('gameResumed', ({ message }) => {
         console.log("[Client] <- gameResumed:", message);
         messageDisplay.textContent = message;
         setTimeout(() => { if (messageDisplay.textContent === message) messageDisplay.textContent = ""; }, 3000);
         clientState.gameState = 'playing';
         gameStartTime = Date.now() - ((clientState.gameDuration - clientState.timer) * 1000);
         helperOverlayStartTime = Date.now();
     });

    // --- Standard Game Event Handlers ---
    socket.on('playerMoved', (data) => {
        // data = { id: originalPlayerId, position }
        if (!scene || data.id === myPlayerId) return; // Ignore self

        // console.log(`[Client] <- playerMoved: Player ${data.id}`); // Less verbose
        if (otherPlayers[data.id]) {
             otherPlayers[data.id].targetPosition = new THREE.Vector3().copy(data.position);
             // Ensure mesh exists
             if (!otherPlayers[data.id].mesh) {
                 console.warn(`[Client] Mesh missing for moved player ${data.id}, creating.`);
                 addOtherPlayerMesh(data.id); // Pass original ID
             }
        } else {
             console.warn(`[Client] Received move for unknown partner ID: ${data.id}.`);
             // TODO: Potentially request full player data if partner is missing entirely?
        }
    });

    socket.on('resourceSpawned', (resource) => {
        if (!scene) return;
        // console.log(`[Client] <- resourceSpawned: ${resource.id}`);
        addResource(resource);
    });
    socket.on('resourceRemoved', (resourceId) => {
        if (!scene) return;
        // console.log(`[Client] <- resourceRemoved: ${resourceId}`);
        removeResource(resourceId);
    });
    socket.on('updatePlayerResources', (resources) => {
        // console.log("[Client] <- updatePlayerResources:", resources);
        clientState.resources = resources;
        updateUI();
    });
    socket.on('flowerPlanted', (flowerData) => {
        if (!scene) return;
        console.log(`[Client] <- flowerPlanted at ${flowerData.slotId}`);
        clientState.flowers[flowerData.slotId] = flowerData;
        renderFlower(flowerData.slotId);
        updateUI();
        // console.log("PLAY_SOUND: plant_success.wav");
        // console.log("SPAWN_PARTICLE: plant_sparkle at", flowerData.slotId);
    });
    socket.on('flowerGrown', (flowerData) => {
        if (!scene) return;
         console.log(`[Client] <- flowerGrown at ${flowerData.slotId} to ${flowerData.stage}`);
        clientState.flowers[flowerData.slotId] = flowerData;
        renderFlower(flowerData.slotId);
        updateUI();
        // console.log("PLAY_SOUND: flower_grow.wav");
        // console.log("SPAWN_PARTICLE: grow_sparkle at", flowerData.slotId);
        if(flowerData.stage === 'bloom'){
            // console.log("PLAY_SOUND: flower_bloom_final.wav");
            // console.log("SPAWN_PARTICLE: bloom_celebration at", flowerData.slotId);
        }
    });
    socket.on('actionFailed', ({ message }) => {
         console.warn("[Client] <- actionFailed:", message);
         messageDisplay.textContent = message;
         // console.log("PLAY_SOUND: action_fail.wav");
         setTimeout(() => { if (messageDisplay.textContent === message) messageDisplay.textContent = ""; }, 2000);
     });
    socket.on('weatherUpdate', (newWeather) => {
        console.log("[Client] <- weatherUpdate:", newWeather);
        clientState.weather = newWeather;
        updateWeatherEffects(newWeather);
        updateUI();
        // console.log(`PLAY_SOUND: weather_${newWeather.toLowerCase()}.wav`);
    });
    socket.on('timerUpdate', (newTime) => {
        clientState.timer = newTime;
        updateUI();
    });
    socket.on('gameOver', (data) => {
        console.log('[Client] <- gameOver:', data.message);
        clientState.gameState = 'finished';
        clientState.lastRoomId = null;
        clientState.lastPlayerId = null;
        keys = {};
        actionPromptDisplay.classList.add('hidden');
        timedHelperDisplay.classList.add('hidden');
        hintCornerDisplay.classList.add('hidden');
        showOverlayWithMessage(data.message + "\n\nRefresh to play again!");
        // console.log("PLAY_SOUND: game_over.wav");
    });

} // End of setupSocketIO


// Initializes client state based on data received from server
function initializeClientState(initialState, currentPlayerId) {
    console.log("[Client] Initializing state. My Persistent ID:", currentPlayerId, "State:", initialState);
    clientState.timer = initialState.timer ?? 1800;
    clientState.gameDuration = initialState.gameDuration ?? 1800;
    clientState.weather = initialState.weather ?? 'Sunny';
    clientState.flowers = initialState.flowers ?? {};
    clientState.resources = { petals: 0, water: 0 }; // Reset local count
    clientState.players = initialState.players ?? {}; // Store player data keyed by CURRENT socket ID from server

    // Find my data using the persistent ID
    let myCurrentData = null;
    for(const currentSocketId in clientState.players) {
        if(clientState.players[currentSocketId].id === currentPlayerId) {
            myCurrentData = clientState.players[currentSocketId];
            myCurrentSocketId = currentSocketId; // Update our current socket ID ref if needed
            break;
        }
    }

    if (myCurrentData) {
        clientState.resources = myCurrentData.resources;
        myPlayerName = myCurrentData.name;
        myNameDisplay.textContent = myPlayerName;
        console.log("[Client] My initial data found. Resources:", clientState.resources);
    } else {
        console.error("[Client] CRITICAL: Could not find my own player data in initial state using persistent ID:", currentPlayerId);
        // Fallback: Use the first player entry if only one? Risky.
    }

    // Update partner name display
    const partnerData = Object.values(clientState.players).find(p => p.id !== currentPlayerId);
    if(partnerData) {
         partnerName = partnerData.name;
         partnerNameDisplay.textContent = partnerName;
    } else {
         partnerNameDisplay.textContent = "Waiting...";
    }

    // Clear and Re-add 3D elements if scene exists
    if (scene) {
        console.log("[Client] Scene exists, clearing and adding elements from initial state.");
        clearAndAddElementsFromState(initialState);
    } else {
         console.log("[Client] Scene does not exist yet, elements will be added on initThreeJS/game start.");
    }

    updateUI();
    console.log("[Client] State Initialized. Current players in state:", Object.keys(clientState.players).length);
}

// Clears and re-adds players, resources, flowers based on state
function clearAndAddElementsFromState(state) {
    if (!scene) return;
    console.log("[Client] Clearing and adding elements from state:", state);
    clearLocalGameState(); // Clear meshes first
    clearAndAddPlayers(state.players, myPlayerId); // Add player meshes based on persistent ID
    clearAndAddResources(state.resources); // Add resource meshes (expects array)
    renderAllFlowersFromState(); // Add flower meshes (uses clientState.flowers)
    updateWeatherEffects(state.weather);
}

// Clears only the 3D meshes from the scene
function clearLocalGameState() {
    if (!scene) return;
    console.log("[Client] Clearing local game meshes.");
    // Remove other player meshes
    for (const pId in otherPlayers) {
        removeOtherPlayerVisuals(pId);
    }
    otherPlayers = {};
    // Remove resource meshes
    for (const rId in resourcesOnScreen) {
        if (resourcesOnScreen[rId]) scene.remove(resourcesOnScreen[rId]);
    }
    resourcesOnScreen = {};
    // Remove flower meshes
    for (const fId in flowersOnScreen) {
        if (flowersOnScreen[fId]) scene.remove(flowersOnScreen[fId]);
    }
    flowersOnScreen = {};
     // Remove own player mesh
     if (playerMesh) scene.remove(playerMesh); playerMesh = null;
     if (myPlayerNameMesh) scene.remove(myPlayerNameMesh); myPlayerNameMesh = null;
     console.log("[Client] Local meshes cleared.");
}


// --- Game Element Creation ---
function createGarden() {
    if (!scene) return;
    const planeGeometry = new THREE.PlaneGeometry(GARDEN_SIZE, GARDEN_SIZE);
    const planeMaterial = new THREE.MeshStandardMaterial({ color: 0x98bf64, roughness: 0.9 });
    gardenPlane = new THREE.Mesh(planeGeometry, planeMaterial);
    gardenPlane.rotation.x = -Math.PI / 2;
    gardenPlane.receiveShadow = true;
    scene.add(gardenPlane);
}

function initFlowerSlots() {
    if (!scene) return;
    clientState.flowerSlots = []; // Clear existing slots data
    const slotGeometry = new THREE.CylinderGeometry(0.6, 0.6, 0.1, 16);
    const slotMaterial = new THREE.MeshStandardMaterial({ color: 0x966919, roughness: 0.8 });

    FLOWER_SLOT_POSITIONS.forEach((pos, index) => {
        const slotMesh = new THREE.Mesh(slotGeometry, slotMaterial.clone()); // Clone material
        slotMesh.position.set(pos.x, 0.05, pos.z);
        slotMesh.receiveShadow = true;
        scene.add(slotMesh);
        clientState.flowerSlots.push({ id: `slot_${index}`, position: pos, mesh: slotMesh });
    });
}

// Creates self player mesh and name tag
function createPlayerMesh(playerData) {
    if (!scene || !playerData || playerMesh) return; // Don't recreate if exists

    console.log(`[Client] Creating mesh for SELF: ${playerData.name} (ID: ${playerData.id})`);
    const playerGeometry = new THREE.SphereGeometry(0.6, 16, 16);
    const playerMaterial = new THREE.MeshStandardMaterial({ color: 0x90ee90, roughness: 0.7 });
    playerMesh = new THREE.Mesh(playerGeometry, playerMaterial);
    playerMesh.castShadow = true;
    playerMesh.position.copy(playerData.position);
    scene.add(playerMesh);

    playerLight = new THREE.PointLight(0xfff8d6, 0.6, 10);
    playerLight.position.set(0, 1.5, 0);
    playerMesh.add(playerLight);

    myPlayerNameMesh = createPlayerNameTag(playerData.name || "You");
    if (myPlayerNameMesh) {
         myPlayerNameMesh.position.copy(playerMesh.position).add(PLAYER_NAME_OFFSET);
         scene.add(myPlayerNameMesh);
    }
}

// Stores partner data and creates visuals if scene ready
function addOtherPlayer(playerData) {
    if (!playerData || playerData.id === myPlayerId) {
        // console.log(`[Client] Skipping addOtherPlayer for self or invalid data:`, playerData?.id);
        return;
    }
    const originalPlayerId = playerData.id; // This is the persistent ID
    console.log(`[Client] Storing/Updating data for other player: ${playerData.name} (ID: ${originalPlayerId})`);

    // Update or add player data, keyed by original ID
    otherPlayers[originalPlayerId] = {
        ...(otherPlayers[originalPlayerId] || {}), // Preserve existing mesh/tag refs if any
        data: playerData,
        targetPosition: new THREE.Vector3().copy(playerData.position) // Init/Update target pos
    };

    // Create/update visuals if scene exists
    if (scene) {
        addOtherPlayerMesh(originalPlayerId);
    }
}

// Creates/updates partner visuals based on stored data (keyed by original ID)
function addOtherPlayerMesh(originalPlayerId) {
    if (!scene || !otherPlayers[originalPlayerId]?.data) {
        console.warn(`[Client] Cannot add/update mesh for ${originalPlayerId}, no data or scene.`);
        return; // Need scene and data
    }

    const playerData = otherPlayers[originalPlayerId].data;
    let playerVis = otherPlayers[originalPlayerId]; // Reference to entry in otherPlayers

    // Create mesh if it doesn't exist
    if (!playerVis.mesh) {
        console.log(`[Client] Creating mesh for other player: ${playerData.name}`);
        const geometry = new THREE.SphereGeometry(0.6, 16, 16);
        const material = new THREE.MeshStandardMaterial({ color: 0xffa07a, roughness: 0.7 });
        playerVis.mesh = new THREE.Mesh(geometry, material);
        playerVis.mesh.castShadow = true;
        playerVis.mesh.position.copy(playerData.position);
        scene.add(playerVis.mesh);
    } else {
         // Mesh exists, ensure position is correct (teleport if needed on initial add)
         // Lerping happens in animate loop based on targetPosition
         if (!playerVis.targetPosition) { // If targetPosition isn't set, snap position
            playerVis.mesh.position.copy(playerData.position);
         }
    }
     // Ensure targetPosition is set
     playerVis.targetPosition = new THREE.Vector3().copy(playerData.position);


    // Create name tag if it doesn't exist and font is loaded
    if (!playerVis.nameMesh && font) {
        playerVis.nameMesh = createPlayerNameTag(playerData.name || "Partner");
        if (playerVis.nameMesh) {
             // Set initial position
             if (playerVis.mesh) { // Position relative to mesh
                  playerVis.nameMesh.position.copy(playerVis.mesh.position).add(PLAYER_NAME_OFFSET);
             } else { // Fallback if mesh somehow still not ready
                  playerVis.nameMesh.position.copy(playerData.position).add(PLAYER_NAME_OFFSET);
             }
             scene.add(playerVis.nameMesh);
             console.log(`[Client] Added name tag for ${playerData.name}`);
        }
    } else if (playerVis.nameMesh && playerVis.mesh) {
        // Update name tag position if it already exists
         playerVis.nameMesh.position.copy(playerVis.mesh.position).add(PLAYER_NAME_OFFSET);
    }
}

// Removes partner visuals from scene based on original ID
function removeOtherPlayerVisuals(originalPlayerId) {
    if (otherPlayers[originalPlayerId]) {
        const playerVis = otherPlayers[originalPlayerId];
        console.log(`[Client] Removing visuals for player: ${playerVis.data?.name} (${originalPlayerId})`);
        if (playerVis.mesh) scene?.remove(playerVis.mesh);
        if (playerVis.nameMesh) scene?.remove(playerVis.nameMesh);
        playerVis.mesh = null; // Clear references
        playerVis.nameMesh = null;
    } else {
         console.warn(`[Client] Tried to remove visuals for non-existent player ${originalPlayerId}`);
    }
}
// Removes partner completely (data and visuals) based on original ID
function removeOtherPlayer(originalPlayerId) {
     removeOtherPlayerVisuals(originalPlayerId);
     delete otherPlayers[originalPlayerId]; // Delete data entry
     console.log(`[Client] Removed player data entry for ${originalPlayerId}`);
}


// Function to create 3D name tag mesh
function createPlayerNameTag(name) {
    if (!font) { return null; } // Font check
    try {
        const textGeo = new TextGeometry(name, {
            font: font, size: 0.3, height: 0.02, curveSegments: 4, bevelEnabled: false
        });
        textGeo.computeBoundingBox();
        const textWidth = textGeo.boundingBox.max.x - textGeo.boundingBox.min.x;
        textGeo.translate(-textWidth / 2, 0, 0); // Center horizontally

        const textMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.8 });
        const nameMesh = new THREE.Mesh(textGeo, textMaterial);
        return nameMesh;
    } catch (error) {
        console.error("[Client] Error creating TextGeometry for", name, ":", error);
        return null;
    }
}

// --- Resource/Flower Rendering ---
function addResource(resource) {
    if (!scene || resourcesOnScreen[resource.id]) return;
    let geometry, material;
    const resourceSize = 0.25;
    if (resource.type === 'petal') {
        geometry = new THREE.SphereGeometry(resourceSize, 12, 12);
        material = new THREE.MeshStandardMaterial({ color: 0xFF69B4, roughness: 0.6, metalness: 0.1 });
    } else { // water
        geometry = new THREE.SphereGeometry(resourceSize, 12, 12);
        material = new THREE.MeshStandardMaterial({ color: 0x87CEFA, roughness: 0.4, metalness: 0.2 });
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.position.copy(resource.position);
    resourcesOnScreen[resource.id] = mesh;
    scene.add(mesh);
}

function removeResource(resourceId) {
    if (resourcesOnScreen[resourceId]) {
        // console.log("PLAY_SOUND: collect.wav");
        // console.log("SPAWN_PARTICLE: resource_collect at", resourcesOnScreen[resourceId].position);
        scene?.remove(resourcesOnScreen[resourceId]); // Use optional chaining
        delete resourcesOnScreen[resourceId];
    }
}

function renderFlower(slotId) {
    // ... (Keep detailed flower rendering logic as before) ...
    // Ensure scene checks within the function if needed, though called contexts should check
     const flowerData = clientState.flowers[slotId];
     const slot = clientState.flowerSlots.find(s => s.id === slotId);
     if (!scene || !slot) return; // Check scene exists

    // Remove existing mesh for this slot
    if (flowersOnScreen[slotId]) {
        scene.remove(flowersOnScreen[slotId]);
        delete flowersOnScreen[slotId];
    }

    if (!flowerData) return; // Flower was removed or doesn't exist

    let flowerGroup = new THREE.Group();
    const position = new THREE.Vector3(slot.position.x, 0, slot.position.z);

    let stemHeight = 0;
    const stemGeo = new THREE.CylinderGeometry(0.05, 0.08, 1, 8);
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x56ab2f, roughness: 0.7 });

    switch (flowerData.stage) {
        case 'seed':
            const seedGeo = new THREE.SphereGeometry(0.15, 8, 8);
            const seedMat = new THREE.MeshStandardMaterial({ color: 0x8B4513 });
            const seedMesh = new THREE.Mesh(seedGeo, seedMat);
            seedMesh.position.y = 0.1;
            flowerGroup.add(seedMesh);
            break;
        case 'sprout':
            stemHeight = 0.4;
            const sproutStem = new THREE.Mesh(stemGeo, stemMat);
            sproutStem.scale.set(1, stemHeight, 1);
            sproutStem.position.y = stemHeight / 2;
            flowerGroup.add(sproutStem);
            const leafGeo = new THREE.SphereGeometry(0.1, 8, 8);
            const leafMat = new THREE.MeshStandardMaterial({ color: 0x90EE90 });
            const leaf1 = new THREE.Mesh(leafGeo, leafMat);
            const leaf2 = leaf1.clone();
            leaf1.position.set(0.1, stemHeight * 0.8, 0);
            leaf1.scale.set(1, 0.5, 0.2);
            leaf2.position.set(-0.1, stemHeight * 0.8, 0);
            leaf2.scale.copy(leaf1.scale);
            flowerGroup.add(leaf1);
            flowerGroup.add(leaf2);
            break;
        case 'budding':
             stemHeight = 0.8;
             const buddingStem = new THREE.Mesh(stemGeo, stemMat);
             buddingStem.scale.set(1, stemHeight, 1);
             buddingStem.position.y = stemHeight / 2;
             flowerGroup.add(buddingStem);
             const budGeo = new THREE.SphereGeometry(0.25, 12, 12);
             const budMat = new THREE.MeshStandardMaterial({ color: 0x32CD32 });
             const budMesh = new THREE.Mesh(budGeo, budMat);
             budMesh.position.y = stemHeight + 0.1;
             flowerGroup.add(budMesh);
            break;
        case 'bloom':
            stemHeight = 1.2;
            const bloomStem = new THREE.Mesh(stemGeo, stemMat);
            bloomStem.scale.set(1, stemHeight, 1);
            bloomStem.position.y = stemHeight / 2;
            flowerGroup.add(bloomStem);
            const petalGeo = new THREE.SphereGeometry(0.3, 12, 12);
            const petalMat = new THREE.MeshStandardMaterial({ color: 0xFFB6C1, roughness: 0.5 });
            const centerGeo = new THREE.SphereGeometry(0.2, 12, 12);
            const centerMat = new THREE.MeshStandardMaterial({ color: 0xFFFFE0 });
            const centerMesh = new THREE.Mesh(centerGeo, centerMat);
            centerMesh.position.y = stemHeight + 0.2;
            flowerGroup.add(centerMesh);
            const numPetals = 5;
            for (let i = 0; i < numPetals; i++) {
                const angle = (i / numPetals) * Math.PI * 2;
                const petalMesh = new THREE.Mesh(petalGeo, petalMat.clone()); // Clone material
                petalMesh.position.y = centerMesh.position.y;
                petalMesh.position.x = Math.cos(angle) * 0.35;
                petalMesh.position.z = Math.sin(angle) * 0.35;
                petalMesh.scale.set(1, 0.7, 0.5);
                flowerGroup.add(petalMesh);
            }
            break;
        default:
            console.warn("[Client] Unknown flower stage:", flowerData.stage); return;
    }

    flowerGroup.position.copy(position);
    flowerGroup.traverse(child => { if (child.isMesh) child.castShadow = true; });
    flowersOnScreen[slotId] = flowerGroup;
    scene.add(flowerGroup);

    // Simple "pop-in" animation placeholder
    flowerGroup.scale.set(1,1,1);
}

function renderAllFlowersFromState() {
    if (!scene) return;
    console.log("[Client] Rendering all flowers based on state:", clientState.flowers);
    // Clear existing flower meshes first
    for (const slotId in flowersOnScreen) {
        scene.remove(flowersOnScreen[slotId]);
    }
    flowersOnScreen = {};

    if (clientState.flowers) {
        for (const slotId in clientState.flowers) {
            renderFlower(slotId);
        }
    }
}


// --- Player Input & Movement & Actions ---
function onKeyDown(event) {
    // Only allow input if playing
    if (clientState.gameState !== 'playing') return;
    keys[event.code] = true;

    // Check for actions based on prompts
    if (clientState.nearbyAction) {
        if (event.code === 'KeyP' && clientState.nearbyAction.type === 'plant') {
             console.log("[Client] -> plantFlower:", clientState.nearbyAction.targetId);
             socket.emit('plantFlower', { slotId: clientState.nearbyAction.targetId });
             clientState.nearbyAction = null; // Consume action
             actionPromptDisplay.classList.add('hidden');
        } else if (event.code === 'KeyN' && clientState.nearbyAction.type === 'nurture') {
             console.log("[Client] -> nurtureFlower:", clientState.nearbyAction.targetId);
             socket.emit('nurtureFlower', { slotId: clientState.nearbyAction.targetId });
             clientState.nearbyAction = null; // Consume action
             actionPromptDisplay.classList.add('hidden');
        }
    }
}

function onKeyUp(event) {
    keys[event.code] = false;
}

function updatePlayerMovement(deltaTime) {
     if (!playerMesh || !socket || !myPlayerId) return;

     let moveDirection = new THREE.Vector3(0, 0, 0);

     // Determine Move Direction (Keyboard / Joystick)
     let movedByKey = false; // Use specific keys for joystick to avoid conflict
     if (keys['KeyW'] || keys['ArrowUp'] || keys['JoyW']) { moveDirection.z -= 1; movedByKey = true; }
     if (keys['KeyS'] || keys['ArrowDown']|| keys['JoyS']) { moveDirection.z += 1; movedByKey = true; }
     if (keys['KeyA'] || keys['ArrowLeft']|| keys['JoyA']) { moveDirection.x -= 1; movedByKey = true; }
     if (keys['KeyD'] || keys['ArrowRight']|| keys['JoyD']) { moveDirection.x += 1; movedByKey = true; }

     if (moveDirection.lengthSq() > 0) {
          moveDirection.normalize();
     }

     // Apply Movement (Only if playing)
     if (clientState.gameState === 'playing' && moveDirection.lengthSq() > 0) {
         const moveSpeed = PLAYER_SPEED * deltaTime;
         // Calculate potential new position carefully
         const deltaMovement = moveDirection.multiplyScalar(moveSpeed);
         const potentialPosition = playerMesh.position.clone().add(deltaMovement);

         // Boundary Check
         const halfGarden = GARDEN_SIZE / 2 - 0.6; // Player radius
         potentialPosition.x = Math.max(-halfGarden, Math.min(halfGarden, potentialPosition.x));
         potentialPosition.z = Math.max(-halfGarden, Math.min(halfGarden, potentialPosition.z));
         playerMesh.position.copy(potentialPosition);

         // Post-movement checks
         checkForResourceCollection();
         checkForNearbyActions();

         // Throttle position updates
         if (playerMesh.position.distanceToSquared(lastSentPosition) > MOVE_UPDATE_THRESHOLD * MOVE_UPDATE_THRESHOLD) {
             // console.log("[Client] -> playerMove"); // Less verbose
             socket.emit('playerMove', playerMesh.position);
             lastSentPosition.copy(playerMesh.position);
         }
     }

     // Update camera and name tags regardless of movement if scene exists
     if (scene && camera) {
         updateCameraPosition();
         // Update player name mesh position & rotation
         if (myPlayerNameMesh) {
             myPlayerNameMesh.position.copy(playerMesh.position).add(PLAYER_NAME_OFFSET);
             myPlayerNameMesh.quaternion.copy(camera.quaternion);
         }
         // Update partner name tags to face camera
         for(const pId in otherPlayers) {
             const partnerVis = otherPlayers[pId];
             if(partnerVis?.nameMesh && partnerVis.mesh) {
                  // Position based on current mesh position (which might be lerping)
                  partnerVis.nameMesh.position.copy(partnerVis.mesh.position).add(PLAYER_NAME_OFFSET);
                  partnerVis.nameMesh.quaternion.copy(camera.quaternion);
             }
         }
     }
}


function updateCameraPosition() {
    if (!camera || !playerMesh) return;
     const targetPosition = playerMesh.position.clone().add(CAMERA_OFFSET);
     camera.position.lerp(targetPosition, 0.1);
     camera.lookAt(playerMesh.position);
}

function checkForResourceCollection() {
    if (!playerMesh || clientState.gameState !== 'playing') return;
    const playerPos = playerMesh.position;
    const collectionRadiusSq = 1.0 * 1.0;

    for (const resourceId in resourcesOnScreen) {
        const resourceMesh = resourcesOnScreen[resourceId];
        if (playerPos.distanceToSquared(resourceMesh.position) < collectionRadiusSq) {
            // console.log(`[Client] -> collectResource: ${resourceId}`);
            socket.emit('collectResource', resourceId);
            // Don't break, allow collecting multiple per frame if close enough
        }
    }
}

function checkForNearbyActions() {
    if (!playerMesh || clientState.gameState !== 'playing') {
        // Ensure prompt is hidden if not playing
        if (clientState.nearbyAction) {
            clientState.nearbyAction = null;
            actionPromptDisplay.classList.add('hidden');
        }
        return;
    }

    const playerPos = playerMesh.position;
    let possibleAction = null;

    // Check for Planting
    if (clientState.resources.petals > 0) {
        let closestEmptySlot = null;
        let minDistSq = ACTION_RADIUS_SQ;
        clientState.flowerSlots.forEach(slot => {
             if (!clientState.flowers[slot.id]) {
                 const slotPos = new THREE.Vector3(slot.position.x, 0, slot.position.z);
                 const distSq = playerPos.distanceToSquared(slotPos);
                 if (distSq < minDistSq) {
                     minDistSq = distSq; closestEmptySlot = slot;
                 }
             }
        });
        if (closestEmptySlot) possibleAction = { type: 'plant', targetId: closestEmptySlot.id };
    }

    // Check for Nurturing
    if (!possibleAction && clientState.resources.water > 0) {
        let closestNurturableFlower = null;
        let minDistSq = ACTION_RADIUS_SQ;
         for (const slotId in clientState.flowers) {
             const flowerData = clientState.flowers[slotId];
             if (flowerData.stage !== 'bloom') {
                 const slot = clientState.flowerSlots.find(s => s.id === slotId);
                 if (slot) {
                    const slotPos = new THREE.Vector3(slot.position.x, 0, slot.position.z);
                    const distSq = playerPos.distanceToSquared(slotPos);
                    if (distSq < minDistSq) {
                        minDistSq = distSq; closestNurturableFlower = slotId;
                    }
                 }
             }
         }
         if (closestNurturableFlower) possibleAction = { type: 'nurture', targetId: closestNurturableFlower };
    }

    // Update UI Prompt
    if (possibleAction) {
        if (!clientState.nearbyAction || clientState.nearbyAction.targetId !== possibleAction.targetId || clientState.nearbyAction.type !== possibleAction.type ) {
             clientState.nearbyAction = possibleAction;
             const actionText = possibleAction.type === 'plant' ? "Press 'P' to Plant Seed" : "Press 'N' to Nurture Flower";
             actionPromptDisplay.textContent = actionText;
             actionPromptDisplay.classList.remove('hidden');
        }
    } else {
        if (clientState.nearbyAction) {
             clientState.nearbyAction = null;
             actionPromptDisplay.classList.add('hidden');
        }
    }
}


function updateWeatherEffects(weather) {
    if (!scene) return;
    console.log("[Client] Updating weather effects for:", weather);
    let bgColor, fogColor, fogNear, fogFar;
    switch (weather) {
        case 'Sunny':
            bgColor = new THREE.Color(0x87CEEB); fogColor = bgColor; fogNear = 50; fogFar = 100;
            break;
        case 'Cloudy':
            bgColor = new THREE.Color(0xB0C4DE); fogColor = bgColor; fogNear = 20; fogFar = 60;
            break;
        case 'Rainy':
            bgColor = new THREE.Color(0x778899); fogColor = bgColor; fogNear = 10; fogFar = 40;
            // console.log("START_PARTICLE: rain");
            break;
        default:
            bgColor = new THREE.Color(0x87CEEB); fogColor = bgColor; fogNear = 50; fogFar = 100;
    }
    scene.background = bgColor;
    if (fogNear && fogFar) scene.fog = new THREE.Fog(fogColor, fogNear, fogFar);
    else scene.fog = null;

    if (weather !== 'Rainy') { /* console.log("STOP_PARTICLE: rain"); */ }
}


// --- UI Update ---
function updateUI() {
    const minutes = Math.floor(clientState.timer / 60);
    const seconds = clientState.timer % 60;
    timerDisplay.textContent = `Time: ${minutes}:${seconds.toString().padStart(2, '0')}`;
    resourcesDisplay.textContent = `Petals: ${clientState.resources.petals} | Water: ${clientState.resources.water}`;
    weatherDisplay.textContent = `Weather: ${clientState.weather}`;
    // Room code and names updated elsewhere
}

// --- Timed Helpers (Adjusted Logic) ---
function updateTimedHelpers() {
    if (clientState.gameState !== 'playing' || !gameStartTime) {
        timedHelperDisplay.classList.add('hidden');
        hintCornerDisplay.classList.add('hidden');
        return;
    }

    const elapsedSeconds = (Date.now() - gameStartTime) / 1000;
    let overlayText = "";
    let hintText = "";

    // Overlay phase
    if (helperOverlayStartTime && (Date.now() - helperOverlayStartTime) < HELPER_OVERLAY_DURATION * 1000) {
         if (elapsedSeconds < 15) overlayText = "Use WASD/Arrows or Joystick to Move!";
         else if (elapsedSeconds < 30) overlayText = "Walk near Pink Petals & Blue Water Drops to collect them.";
         else if (elapsedSeconds < 45 && clientState.resources.petals > 0) overlayText = "Got Petals? Find a brown plot & Press 'P' (or button) to Plant!";
         else if (elapsedSeconds < 60 && clientState.resources.water > 0) overlayText = "Got Water? Find a growing flower & Press 'N' (or button) to Nurture!";
         else overlayText = "Work with your partner to grow the garden!";
    } else {
        // Ensure overlay timer doesn't restart unnecessarily
         if(helperOverlayStartTime) helperOverlayStartTime = null;
    }

    // Hint phase
    if (elapsedSeconds < HELPER_HINT_DURATION && overlayText === "") {
        if (clientState.resources.petals > 0 && clientState.resources.water === 0) hintText = "Collect Blue Water!";
        else if (clientState.resources.water > 0 && clientState.resources.petals === 0) hintText = "Collect Pink Petals!";
        else if (clientState.nearbyAction?.type === 'plant') hintText = "Press 'P'!";
        else if (clientState.nearbyAction?.type === 'nurture') hintText = "Press 'N'!";
        else if (elapsedSeconds > 120) hintText = `Weather: ${clientState.weather}`;
    }

    // Update Overlay Display
    if (overlayText && timedHelperDisplay.textContent !== overlayText) {
        timedHelperDisplay.textContent = overlayText;
        timedHelperDisplay.classList.remove('hidden');
    } else if (!overlayText && !timedHelperDisplay.classList.contains('hidden')) {
         timedHelperDisplay.classList.add('hidden');
    }

     // Update Hint Display
    if (hintText && hintCornerDisplay.textContent !== hintText) {
        hintCornerDisplay.textContent = hintText;
        hintCornerDisplay.classList.remove('hidden');
    } else if (!hintText && !hintCornerDisplay.classList.contains('hidden')) {
         hintCornerDisplay.classList.add('hidden');
    }
}

// --- Mobile Controls Logic ---
function setupMobileControls() {
    joystickArea.addEventListener('touchstart', (e) => {
        if (joystickTouchId === null) {
            e.preventDefault();
            joystickTouchId = e.changedTouches[0].identifier;
            joystickActive = true;
            const rect = joystickArea.getBoundingClientRect();
            // Calculate start relative to base center for easier delta calculation
            joystickStartPos.x = rect.left + rect.width / 2;
            joystickStartPos.y = rect.top + rect.height / 2;
            // Update current immediately
            joystickCurrentPos.x = e.changedTouches[0].clientX;
            joystickCurrentPos.y = e.changedTouches[0].clientY;
            joystickThumb.style.opacity = '1';
            updateJoystickThumb(); // Position thumb immediately
        }
    }, { passive: false });

    joystickArea.addEventListener('touchmove', (e) => {
        if (joystickActive) {
             e.preventDefault();
             for (let i = 0; i < e.changedTouches.length; i++) {
                if (e.changedTouches[i].identifier === joystickTouchId) {
                    joystickCurrentPos.x = e.changedTouches[i].clientX;
                    joystickCurrentPos.y = e.changedTouches[i].clientY;
                    updateJoystickThumb(); // Update visual position and keys
                    break;
                }
            }
        }
    }, { passive: false });

    const handleTouchEnd = (e) => {
         for (let i = 0; i < e.changedTouches.length; i++) {
             if (e.changedTouches[i].identifier === joystickTouchId) {
                 e.preventDefault();
                 joystickActive = false;
                 joystickTouchId = null;
                 joystickThumb.style.left = `50%`; // Reset thumb visual
                 joystickThumb.style.top = `50%`;
                 joystickThumb.style.opacity = '0.6';
                 keys['JoyW'] = keys['JoyS'] = keys['JoyA'] = keys['JoyD'] = false; // Reset keys
                 break;
             }
         }
     };

    joystickArea.addEventListener('touchend', handleTouchEnd);
    joystickArea.addEventListener('touchcancel', handleTouchEnd);

    // Action Button Listeners
    buttonPlant.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (clientState.gameState === 'playing') onKeyDown({ code: 'KeyP' });
        buttonPlant.style.backgroundColor = 'rgba(255, 255, 255, 0.5)';
    }, { passive: false });
    buttonPlant.addEventListener('touchend', (e) => { e.preventDefault(); buttonPlant.style.backgroundColor = 'rgba(255, 105, 180, 0.7)'; });

    buttonNurture.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (clientState.gameState === 'playing') onKeyDown({ code: 'KeyN' });
         buttonNurture.style.backgroundColor = 'rgba(255, 255, 255, 0.5)';
    }, { passive: false });
     buttonNurture.addEventListener('touchend', (e) => { e.preventDefault(); buttonNurture.style.backgroundColor = 'rgba(135, 206, 250, 0.7)'; });
}

function updateJoystickThumb() {
    if (!joystickActive) return;

    let dx = joystickCurrentPos.x - joystickStartPos.x;
    let dy = joystickCurrentPos.y - joystickStartPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const radius = JOYSTICK_MAX_RADIUS;

    if (distance > radius) { // Clamp to radius
        dx *= radius / distance;
        dy *= radius / distance;
    }

    // Update thumb visual position relative to base center
    const baseRect = joystickArea.getBoundingClientRect();
    joystickThumb.style.left = `${(baseRect.width / 2) + dx}px`;
    joystickThumb.style.top = `${(baseRect.height / 2) + dy}px`;

    // Set directional keys based on joystick vector thresholds
    const deadZone = radius * 0.2; // 20% deadzone
    keys['JoyW'] = (dy < -deadZone);
    keys['JoyS'] = (dy > deadZone);
    keys['JoyA'] = (dx < -deadZone);
    keys['JoyD'] = (dx > deadZone);
}


// --- Window Resize ---
function onWindowResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Animation Loop ---
let animationFrameId = null; // Keep track of the animation frame request
function animate() {
    // Always request the next frame
    animationFrameId = requestAnimationFrame(animate);

    // Only run updates if the game is initialized and not finished/setup
    if (!scene || !camera || clientState.gameState === 'finished' || clientState.gameState === 'setup' || clientState.gameState === 'connecting') {
        return;
    }

    const deltaTime = clock.getDelta();

    // Update player movement (handles internal state check)
    updatePlayerMovement(deltaTime);

    // Update timed helpers display logic
    if(clientState.gameState === 'playing') updateTimedHelpers();


    // --- Update other animations ---
    const time = clock.getElapsedTime();
    // Resource bobbing/rotation
    for (const id in resourcesOnScreen) {
        if (resourcesOnScreen[id]) {
            // Extract number part of ID for consistent offset, handle missing number
            const numPart = parseInt(id.split('_').pop() || '0', 10);
            resourcesOnScreen[id].position.y = 0.5 + Math.sin(time * 3 + numPart * 0.5) * 0.15;
            resourcesOnScreen[id].rotation.y += deltaTime * 0.5;
        }
    }
    // Flower swaying
    for (const id in flowersOnScreen) {
        if (flowersOnScreen[id] && clientState.flowers[id]?.stage !== 'seed') {
             const numPart = parseInt(id.split('_').pop() || '0', 10);
             flowersOnScreen[id].rotation.z = Math.sin(time * 1.5 + numPart * 0.8) * 0.05;
        }
    }

    // Lerp partner positions towards target
    for (const id in otherPlayers) {
         const partner = otherPlayers[id];
         if (partner.mesh && partner.targetPosition) {
              partner.mesh.position.lerp(partner.targetPosition, 0.15); // Adjust lerp factor for smoothness
         }
    }

    // Render the scene
    renderer.render(scene, camera);
}

// --- Start Everything ---
init(); // Start UI/Socket setup