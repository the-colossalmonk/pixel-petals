// public/client.js
// Use module THREE version if available locally or adjust path
import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js';
// Consider adding OrbitControls for debugging if needed
// import { OrbitControls } from 'https://threejs.org/examples/jsm/controls/OrbitControls.js';
// import { TextGeometry } from 'https://threejs.org/examples/jsm/geometries/TextGeometry.js'; // For 3D text names
// import { FontLoader } from 'https://threejs.org/examples/jsm/loaders/FontLoader.js';     // For 3D text names

// --- Global Variables ---
let scene, camera, renderer, controls; // Added controls for potential debugging
let playerMesh, playerLight, myPlayerNameMesh; // Added name mesh
let otherPlayers = {}; // { socketId: { mesh: playerMesh, nameMesh: nameMesh } }
let resourcesOnScreen = {}; // { resourceId: mesh }
let flowersOnScreen = {}; // { slotId: mesh }
let gardenGrid, gardenPlane;
let keys = {};
let clock = new THREE.Clock();
let socket;
let myPlayerId, myPlayerName, partnerName;
let currentRoomId; // Track the room we are in

// --- Game State (Client Side) ---
let clientState = {
    resources: { petals: 0, water: 0 },
    weather: 'Sunny',
    timer: 1800, // Will be set by server
    gameDuration: 1800, // Will be set by server
    flowers: {},
    flowerSlots: [],
    gameState: 'setup', // 'setup', 'waiting', 'playing', 'finished'
    nearbyAction: null // { type: 'plant'/'nurture', targetId: slotId }
};
let gameStartTime = null; // Track when 'playing' state begins for helpers

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

const gameUI = document.getElementById('game-ui');
const gameContainer = document.getElementById('game-container');
const timerDisplay = document.getElementById('timer');
const resourcesDisplay = document.getElementById('resources');
const weatherDisplay = document.getElementById('weather');
const myNameDisplay = document.getElementById('my-name');
const partnerNameDisplay = document.getElementById('partner-name');
const messageDisplay = document.getElementById('message');
const timedHelperDisplay = document.getElementById('timed-helper');
const actionPromptDisplay = document.getElementById('action-prompt');


// --- Constants ---
const PLAYER_SPEED = 5.0;
const GARDEN_SIZE = 20;
const GRID_DIVISIONS = 20;
const FLOWER_SLOT_POSITIONS = [ // Must match server
    { x: -5, z: -5 }, { x: 0, z: -5 }, { x: 5, z: -5 },
    { x: -5, z: 0 },  { x: 0, z: 0 },  { x: 5, z: 0 },
    { x: -5, z: 5 },  { x: 0, z: 5 },  { x: 5, z: 5 },
];
const PLAYER_NAME_OFFSET = new THREE.Vector3(0, 1.5, 0); // Offset for name tag above player
const CAMERA_OFFSET = new THREE.Vector3(0, 12, 14); // Camera distance from player
const ACTION_RADIUS_SQ = 2.0 * 2.0; // Squared radius for Planting/Nurturing prompts
const HELPER_DURATION = 600; // Show helpers for 10 minutes (600 seconds)


// --- Initialization ---
function init() {
    setupUIListeners();
    // Don't init Three.js until game starts
}

function initThreeJS() {
    if (scene) return; // Prevent double initialization

    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB); // Default sunny sky blue

    // Camera (Perspective)
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    // Camera position will be updated in animate() to follow player

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio); // Better resolution on high DPI screens
    renderer.shadowMap.enabled = true; // Enable shadows for cuter look (needs lights configured)
    gameContainer.appendChild(renderer.domElement);

    // Lighting (Improved for cuteness)
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7); // Brighter ambient
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0); // Brighter directional
    directionalLight.position.set(8, 15, 10);
    directionalLight.castShadow = true; // Enable shadows
    // Configure shadow properties for softness (adjust as needed)
    directionalLight.shadow.mapSize.width = 1024;
    directionalLight.shadow.mapSize.height = 1024;
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far = 50;
    directionalLight.shadow.camera.left = -GARDEN_SIZE / 2;
    directionalLight.shadow.camera.right = GARDEN_SIZE / 2;
    directionalLight.shadow.camera.top = GARDEN_SIZE / 2;
    directionalLight.shadow.camera.bottom = -GARDEN_SIZE / 2;
    scene.add(directionalLight);
    // const lightHelper = new THREE.DirectionalLightHelper(directionalLight, 5); // Debug helper
    // scene.add(lightHelper);
    // const shadowHelper = new THREE.CameraHelper(directionalLight.shadow.camera); // Debug helper
    // scene.add(shadowHelper);


    // --- Create Game Elements ---
    createGarden();
    initFlowerSlots(); // Creates visual markers and populates clientState.flowerSlots

    // Player Mesh (Self) - Use a slightly cuter shape? Sphere for now.
    const playerGeometry = new THREE.SphereGeometry(0.6, 16, 16); // Rounded shape
    const playerMaterial = new THREE.MeshStandardMaterial({ color: 0x90ee90, roughness: 0.7 }); // Light green, less shiny
    playerMesh = new THREE.Mesh(playerGeometry, playerMaterial);
    playerMesh.castShadow = true; // Player casts shadow
    playerMesh.position.set(0, 0.6, 0); // Adjust Y based on sphere radius
    scene.add(playerMesh);

    // Player Point Light (Softer)
    playerLight = new THREE.PointLight(0xfff8d6, 0.6, 10); // Warmer, softer light
    playerLight.position.set(0, 1.5, 0); // Position relative to player mesh
    playerMesh.add(playerLight); // Attach light

    // Player Name Mesh (Placeholder - requires FontLoader and TextGeometry setup)
    // createPlayerNameMesh(myPlayerName || "You", playerMesh); // Create name tag for self

    // --- Controls (Optional: For Debugging) ---
    // controls = new OrbitControls(camera, renderer.domElement);
    // controls.target.copy(playerMesh.position); // Initial target
    // controls.update();

    // Event Listeners for game window
    window.addEventListener('resize', onWindowResize, false);
    document.addEventListener('keydown', onKeyDown, false);
    document.addEventListener('keyup', onKeyUp, false);

    // Start Animation Loop
    animate();
}

// --- UI Setup and Listeners ---
function setupUIListeners() {
    startSetupButton.addEventListener('click', () => {
        introScreen.classList.remove('active');
        introScreen.style.display = 'none'; // Hide completely
        setupScreen.style.display = 'block'; // Show setup
        setupScreen.classList.add('active');
    });

    hostButton.addEventListener('click', () => {
        const name = playerNameInput.value.trim() || `Player_${Math.random().toString(36).substring(7)}`;
        const duration = timeLimitSelect.value;
        if (name) {
            myPlayerName = name;
            myNameDisplay.textContent = myPlayerName; // Update UI immediately
            setSetupStatus("Connecting...", true);
            socket.emit('hostGame', { playerName: name, duration: duration });
        } else {
             setSetupStatus("Please enter a name.", false, true);
        }
    });

    joinButton.addEventListener('click', () => {
        const name = playerNameInput.value.trim() || `Player_${Math.random().toString(36).substring(7)}`;
        const roomId = roomIdInput.value.trim().toUpperCase();
        if (name && roomId) {
             myPlayerName = name;
             myNameDisplay.textContent = myPlayerName; // Update UI immediately
             setSetupStatus("Joining room...", true);
            socket.emit('joinGame', { playerName: name, roomId: roomId });
        } else if (!name) {
             setSetupStatus("Please enter a name.", false, true);
        } else {
            setSetupStatus("Please enter a Room ID.", false, true);
        }
    });

    // Connect to Socket.IO only AFTER basic setup interaction (or on load)
    setupSocketIO();
}

function setSetupStatus(message, isLoading = false, isError = false) {
     setupError.textContent = message;
     setupError.style.color = isError ? '#d9534f' : '#6b4f4f'; // Error color or normal
     waitingMessage.classList.add('hidden'); // Hide waiting message by default
     roomIdDisplay.classList.add('hidden'); // Hide room ID by default

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
    overlay.classList.add('hidden'); // Hide the entire setup overlay
    gameUI.classList.remove('hidden'); // Show the in-game UI
    clientState.gameState = 'playing';
    gameStartTime = Date.now(); // Record game start time for helpers
    initThreeJS(); // Initialize the 3D environment now
}


// --- Socket.IO Setup ---
function setupSocketIO() {
    socket = io();

    socket.on('connect', () => {
        console.log('Connected to server!', socket.id);
        // If returning to setup after disconnect, clear status
        if (clientState.gameState === 'setup') {
            setSetupStatus("");
        }
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from server!');
        // Handle disconnection - show overlay, error message?
         if (clientState.gameState !== 'finished') {
            showOverlayWithMessage("Disconnected from server. Please refresh.");
            clientState.gameState = 'setup'; // Reset state
            // Clear game elements? Or rely on refresh?
         }
    });

    socket.on('connect_error', (err) => {
        console.error("Connection Error:", err.message);
        if (clientState.gameState === 'setup') {
             setSetupStatus(`Cannot connect: ${err.message}`, false, true);
        } else {
            showOverlayWithMessage(`Connection Error: ${err.message}. Please refresh.`);
        }
    });

    socket.on('setupError', ({ message }) => {
        setSetupStatus(message, false, true); // Show error, re-enable buttons
    });

    socket.on('roomCreated', ({ roomId, initialState, playerId }) => {
        console.log(`Room ${roomId} created. Waiting for partner.`);
        currentRoomId = roomId;
        myPlayerId = playerId;
        initializeClientState(initialState);
        clientState.gameState = 'waiting';
        showWaitingState(roomId);
    });

    socket.on('joinedRoom', ({ roomId, initialState, playerId }) => {
        console.log(`Joined room ${roomId}.`);
        currentRoomId = roomId;
        myPlayerId = playerId;
        initializeClientState(initialState);
        // If room already has 2 players, server might immediately send gameStart
        // Otherwise, we wait for partnerJoined or gameStart signal
        if (Object.keys(initialState.players).length === 2) {
            console.log("Room full on join, expecting gameStart soon.");
             partnerName = Object.values(initialState.players).find(p => p.id !== myPlayerId)?.name || 'Partner';
             partnerNameDisplay.textContent = partnerName;
             // Don't start rendering yet, wait for gameStart event
        } else {
             clientState.gameState = 'waiting';
             showWaitingState(roomId); // Should already be waiting, but safe fallback
        }
    });

    socket.on('partnerJoined', (partnerData) => {
        console.log('Partner joined:', partnerData.name);
        partnerName = partnerData.name;
        partnerNameDisplay.textContent = partnerName;
        addOtherPlayer(partnerData); // Add partner's mesh if game already started visually
        waitingMessage.classList.add('hidden'); // Hide waiting message
        // Server will likely send gameStart next
    });

     socket.on('partnerLeft', ({ message }) => {
        console.log('Partner left:', message);
        messageDisplay.textContent = message; // Show disconnect message
        partnerNameDisplay.textContent = "Disconnected";
        clientState.gameState = 'waiting'; // Or 'finished' maybe?
        timedHelperDisplay.classList.add('hidden'); // Hide helpers
        actionPromptDisplay.classList.add('hidden'); // Hide prompts
        // Find and remove partner's mesh
        const partnerId = Object.keys(otherPlayers)[0]; // Assuming only one other player
        if (partnerId) {
            removeOtherPlayer(partnerId);
        }
        // Consider showing the setup overlay again? Or a "Waiting for partner" screen?
        // For now, just stops updates and shows message.
    });

    socket.on('gameStart', ({ message }) => {
        console.log("Game starting!", message);
        messageDisplay.textContent = message;
        setTimeout(() => messageDisplay.textContent = "", 3000); // Clear message after delay
        hideSetupUIAndStartGame(); // Hide setup, init 3D, start rendering
    });

    // --- Game State Sync Handlers ---
    socket.on('initialState', (state) => {
        // This might be redundant now with roomCreated/joinedRoom providing initial state
        console.log('Received initial state (redundant?):', state);
        // initializeClientState(state); // Could use this as a fallback
    });

     socket.on('gameStateReset', (state) => {
        console.log("Received game state reset from server.");
        clearLocalGameState(); // Clear meshes, etc.
        // Re-apply server state
        clientState.timer = state.timer;
        clientState.weather = state.weather;
        clientState.flowers = state.flowers || {};
        clientState.resources = { petals: 0, water: 0 }; // Reset local resources too
        // Re-render based on new empty state
        renderAllFlowersFromState();
        // Resources will be added via resourceSpawned events
        updateUI();
        updateWeatherEffects(clientState.weather);
        messageDisplay.textContent = 'New round started!'; // Or similar
        setTimeout(() => messageDisplay.textContent = "", 3000);
        gameStartTime = Date.now(); // Reset helper timer
    });


    socket.on('playerMoved', (data) => {
        if (otherPlayers[data.id]) {
            // Add smoothing (lerp) for cuter movement
             otherPlayers[data.id].mesh.position.lerp(data.position, 0.3); // Adjust lerp factor (0.1-0.5)
            // Name tag follows mesh
            // if (otherPlayers[data.id].nameMesh) {
            //    otherPlayers[data.id].nameMesh.position.copy(otherPlayers[data.id].mesh.position).add(PLAYER_NAME_OFFSET);
            //}
        } else {
             // If player moved but wasn't added yet (timing issue?), add them now
             // Requires server to send full player data on move, or fetch it
             console.warn("Received move for unknown player:", data.id);
        }
    });

    socket.on('resourceSpawned', (resource) => addResource(resource));
    socket.on('resourceRemoved', (resourceId) => removeResource(resourceId));
    socket.on('updatePlayerResources', (resources) => {
        clientState.resources = resources; updateUI();
    });
    socket.on('flowerPlanted', (flowerData) => {
        clientState.flowers[flowerData.slotId] = flowerData; renderFlower(flowerData.slotId); updateUI();
        // ADD SOUND Placeholder: Planting sound effect
        // console.log("PLAY_SOUND: plant_success.wav");
         // ADD PARTICLE Placeholder: Sparkle effect at plant location
        // console.log("SPAWN_PARTICLE: plant_sparkle at", flowerData.slotId);
    });
    socket.on('flowerGrown', (flowerData) => {
        clientState.flowers[flowerData.slotId] = flowerData; renderFlower(flowerData.slotId); updateUI();
        // ADD SOUND Placeholder: Growth/Level up sound
        // console.log("PLAY_SOUND: flower_grow.wav");
         // ADD PARTICLE Placeholder: Growing sparkle effect
        // console.log("SPAWN_PARTICLE: grow_sparkle at", flowerData.slotId);
        if(flowerData.stage === 'bloom'){
            // ADD SOUND Placeholder: Full bloom magical sound
            // console.log("PLAY_SOUND: flower_bloom_final.wav");
            // ADD PARTICLE Placeholder: Big bloom celebration effect
            // console.log("SPAWN_PARTICLE: bloom_celebration at", flowerData.slotId);
        }
    });
     socket.on('actionFailed', ({ message }) => {
         console.log("Action failed:", message);
         messageDisplay.textContent = message;
         // ADD SOUND Placeholder: Error/fail sound
         // console.log("PLAY_SOUND: action_fail.wav");
         setTimeout(() => messageDisplay.textContent = "", 2000); // Clear fail message
     });
    socket.on('weatherUpdate', (newWeather) => {
        clientState.weather = newWeather; updateWeatherEffects(newWeather); updateUI();
         // ADD SOUND Placeholder: Weather change sound (wind, rain drops, sunny jingle)
        // console.log(`PLAY_SOUND: weather_${newWeather.toLowerCase()}.wav`);
    });
    socket.on('timerUpdate', (newTime) => { clientState.timer = newTime; updateUI(); });
    socket.on('gameOver', (data) => {
        console.log('Game Over:', data.message);
        clientState.gameState = 'finished';
        keys = {}; // Stop movement
        actionPromptDisplay.classList.add('hidden'); // Hide prompts
        timedHelperDisplay.classList.add('hidden'); // Hide helpers
        // Show final message in a more prominent way?
        showOverlayWithMessage(data.message + "\n\nRefresh to play again!");
         // ADD SOUND Placeholder: Game over / results sound
         // console.log("PLAY_SOUND: game_over.wav");
    });
}

function initializeClientState(initialState) {
     console.log("Initializing client state with data:", initialState);
     clientState.timer = initialState.timer || DEFAULT_GAME_DURATION;
     clientState.gameDuration = initialState.gameDuration || DEFAULT_GAME_DURATION;
     clientState.weather = initialState.weather || 'Sunny';
     clientState.flowers = initialState.flowers || {};
     clientState.resources = { petals: 0, water: 0 }; // Start with 0, server will send updates

     // Find my player data and partner data
     const myData = initialState.players[myPlayerId];
     if (myData) {
         clientState.resources = myData.resources; // Get my starting resources
         // Set initial position IF the player mesh exists (may not yet)
         if (playerMesh) playerMesh.position.copy(myData.position);
     }

     // Clear existing local state representations
     clearLocalGameState();

     // Add players (self and partner) from initial state
     for (const pId in initialState.players) {
         if (pId === myPlayerId) {
            // Update self if needed (name already set during setup)
         } else {
             partnerName = initialState.players[pId].name;
             partnerNameDisplay.textContent = partnerName;
             addOtherPlayer(initialState.players[pId]); // Add partner mesh if game view is active
         }
     }

     // Add existing resources & flowers if game view is active
     if (clientState.gameState === 'playing') { // Only render if game already started visually
        initialState.resources?.forEach(res => addResource(res)); // Use ?. for safety
        renderAllFlowersFromState();
     }

     updateUI(); // Update UI elements
     if (scene) updateWeatherEffects(clientState.weather); // Update visual weather if scene exists
}

function clearLocalGameState() {
    // Remove other player meshes
    for (const pId in otherPlayers) {
        removeOtherPlayer(pId);
    }
    otherPlayers = {};
    // Remove resource meshes
    for (const rId in resourcesOnScreen) {
        scene?.remove(resourcesOnScreen[rId]); // Check if scene exists
    }
    resourcesOnScreen = {};
    // Remove flower meshes
    for (const fId in flowersOnScreen) {
        scene?.remove(flowersOnScreen[fId]);
    }
    flowersOnScreen = {};
}

function showOverlayWithMessage(message) {
     // Re-purpose intro screen to show messages
     introScreen.innerHTML = `<h2>Game Over</h2><p>${message.replace(/\n/g, '<br>')}</p>`; // Use innerHTML to allow line breaks
     introScreen.style.display = 'block';
     introScreen.classList.add('active');
     setupScreen.style.display = 'none'; // Hide setup screen
     setupScreen.classList.remove('active');
     overlay.classList.remove('hidden'); // Show the overlay
     gameUI.classList.add('hidden'); // Hide game UI
}


// --- Game Element Creation ---

function createGarden() {
    // Garden Plane (Ground) - Improved look
    const planeGeometry = new THREE.PlaneGeometry(GARDEN_SIZE, GARDEN_SIZE);
    // Use a texture for cuter ground? Placeholder: color
    const planeMaterial = new THREE.MeshStandardMaterial({ color: 0x98bf64, roughness: 0.9 }); // Softer green
    gardenPlane = new THREE.Mesh(planeGeometry, planeMaterial);
    gardenPlane.rotation.x = -Math.PI / 2;
    gardenPlane.receiveShadow = true; // Ground receives shadows
    scene.add(gardenPlane);

    // Grid Helper (Optional: Can be toggled off for cleaner look)
    // gardenGrid = new THREE.GridHelper(GARDEN_SIZE, GRID_DIVISIONS, 0x888888, 0x666666);
    // gardenGrid.position.y = 0.01;
    // scene.add(gardenGrid);
}

function initFlowerSlots() {
    clientState.flowerSlots = []; // Clear existing slots data
    // Slightly raised, cuter dirt plot marker
    const slotGeometry = new THREE.CylinderGeometry(0.6, 0.6, 0.1, 16); // Flat cylinder
    const slotMaterial = new THREE.MeshStandardMaterial({ color: 0x966919, roughness: 0.8 }); // Dirt color
    const slotOutlineMaterial = new THREE.LineBasicMaterial( { color: 0x6b4f4f, linewidth: 2 } ); // Darker outline

    FLOWER_SLOT_POSITIONS.forEach((pos, index) => {
        const slotMesh = new THREE.Mesh(slotGeometry, slotMaterial);
        slotMesh.position.set(pos.x, 0.05, pos.z); // Place slightly above ground
        slotMesh.receiveShadow = true; // Plot receives shadows
        scene.add(slotMesh);

        // Add outline (optional, can impact performance)
        // const edges = new THREE.EdgesGeometry( slotGeometry );
        // const line = new THREE.LineSegments( edges, slotOutlineMaterial );
        // line.position.copy(slotMesh.position);
        // scene.add(line);

        // Store the slot position with an ID for later reference
        clientState.flowerSlots.push({ id: `slot_${index}`, position: pos, mesh: slotMesh /* Store mesh reference */ });
    });
}

function addOtherPlayer(playerData) {
    if (!scene || otherPlayers[playerData.id] || playerData.id === myPlayerId) return; // Don't add self or if scene not ready

    const geometry = new THREE.SphereGeometry(0.6, 16, 16); // Same shape as player
    const material = new THREE.MeshStandardMaterial({ color: 0xffa07a, roughness: 0.7 }); // Light salmon color for partner
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.position.copy(playerData.position);
    scene.add(mesh);

    // Add name tag (Placeholder)
    // const nameMesh = createPlayerNameMesh(playerData.name || "Partner", mesh);

    otherPlayers[playerData.id] = { mesh: mesh /* , nameMesh: nameMesh */ };
}

function removeOtherPlayer(playerId) {
    if (otherPlayers[playerId]) {
        scene.remove(otherPlayers[playerId].mesh);
        // if (otherPlayers[playerId].nameMesh) scene.remove(otherPlayers[playerId].nameMesh);
        delete otherPlayers[playerId];
    }
}

// Placeholder function for creating 3D text name tags
// function createPlayerNameMesh(name, parentMesh) {
//     // Requires FontLoader and TextGeometry
//     // Example (needs font file loaded):
//     /*
//     const loader = new FontLoader();
//     loader.load( 'path/to/font.typeface.json', function ( font ) {
//         const textGeo = new TextGeometry( name, {
//             font: font,
//             size: 0.3, height: 0.05, curveSegments: 4,
//             bevelEnabled: false
//         });
//         const textMaterial = new THREE.MeshBasicMaterial( { color: 0xffffff } );
//         const nameMesh = new THREE.Mesh( textGeo, textMaterial );
//         nameMesh.position.copy(parentMesh.position).add(PLAYER_NAME_OFFSET);
//         scene.add( nameMesh );
//         // Store reference if needed: parentMesh.userData.nameMesh = nameMesh;
//          return nameMesh; // This async nature is tricky here, better handled differently
//     });
//     */
//     console.warn("3D Text name tags require FontLoader setup.");
//     return null; // Placeholder
// }

function addResource(resource) {
    if (!scene || resourcesOnScreen[resource.id]) return;

    let geometry, material;
    const resourceSize = 0.25; // Slightly bigger resources
    if (resource.type === 'petal') {
        // Simple heart shape? Placeholder: Sphere
        geometry = new THREE.SphereGeometry(resourceSize, 12, 12);
        material = new THREE.MeshStandardMaterial({ color: 0xFF69B4, roughness: 0.6, metalness: 0.1 }); // Hot pink, less rough
    } else { // water
        // Teardrop shape? Placeholder: Sphere
        geometry = new THREE.SphereGeometry(resourceSize, 12, 12);
        material = new THREE.MeshStandardMaterial({ color: 0x87CEFA, roughness: 0.4, metalness: 0.2 }); // Light sky blue, slightly metallic
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.position.copy(resource.position);
    resourcesOnScreen[resource.id] = mesh;
    scene.add(mesh);
}

function removeResource(resourceId) {
    if (resourcesOnScreen[resourceId]) {
         // ADD PARTICLE Placeholder: Collection puff/sparkle
        // console.log("SPAWN_PARTICLE: resource_collect at", resourcesOnScreen[resourceId].position);
         // ADD SOUND Placeholder: Resource collection sound
        // console.log("PLAY_SOUND: collect.wav");

        scene.remove(resourcesOnScreen[resourceId]);
        delete resourcesOnScreen[resourceId];
    }
}

// --- Flower Rendering & Growth (More detailed stages) ---
function renderFlower(slotId) {
    const flowerData = clientState.flowers[slotId];
     const slot = clientState.flowerSlots.find(s => s.id === slotId);
     if (!scene || !slot) return; // Check scene exists

    // Remove existing mesh for this slot
    if (flowersOnScreen[slotId]) {
        scene.remove(flowersOnScreen[slotId]);
        delete flowersOnScreen[slotId];
    }

    if (!flowerData) return; // Flower was removed or doesn't exist

    let flowerGroup = new THREE.Group(); // Use a group for multi-part flowers
    const position = new THREE.Vector3(slot.position.x, 0, slot.position.z); // Base position on ground

    let stemHeight = 0;
    const stemGeo = new THREE.CylinderGeometry(0.05, 0.08, 1, 8); // Tapered stem
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x56ab2f, roughness: 0.7 }); // Leafy green

    // Define appearance based on growth stage (using Group)
    switch (flowerData.stage) {
        case 'seed':
            const seedGeo = new THREE.SphereGeometry(0.15, 8, 8);
            const seedMat = new THREE.MeshStandardMaterial({ color: 0x8B4513 }); // Brown
            const seedMesh = new THREE.Mesh(seedGeo, seedMat);
            seedMesh.position.y = 0.1;
            flowerGroup.add(seedMesh);
            break;
        case 'sprout':
            stemHeight = 0.4;
            const sproutStem = new THREE.Mesh(stemGeo, stemMat);
            sproutStem.scale.set(1, stemHeight, 1);
            sproutStem.position.y = stemHeight / 2; // Center the scaled stem
            flowerGroup.add(sproutStem);

            // Add tiny leaves
            const leafGeo = new THREE.SphereGeometry(0.1, 8, 8); // Simple leaf placeholder
            const leafMat = new THREE.MeshStandardMaterial({ color: 0x90EE90 });
            const leaf1 = new THREE.Mesh(leafGeo, leafMat);
            const leaf2 = leaf1.clone();
            leaf1.position.set(0.1, stemHeight * 0.8, 0);
            leaf1.scale.set(1, 0.5, 0.2); // Flattened leaf
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
             const budMat = new THREE.MeshStandardMaterial({ color: 0x32CD32 }); // Lime Green Bud
             const budMesh = new THREE.Mesh(budGeo, budMat);
             budMesh.position.y = stemHeight + 0.1; // Bud sits on top of stem
             flowerGroup.add(budMesh);
            break;
        case 'bloom':
            stemHeight = 1.2;
            const bloomStem = new THREE.Mesh(stemGeo, stemMat);
            bloomStem.scale.set(1, stemHeight, 1);
            bloomStem.position.y = stemHeight / 2;
            flowerGroup.add(bloomStem);

            // Simple flower head - multiple spheres
            const petalGeo = new THREE.SphereGeometry(0.3, 12, 12);
            const petalMat = new THREE.MeshStandardMaterial({ color: 0xFFB6C1, roughness: 0.5 }); // Light Pink petals
            const centerGeo = new THREE.SphereGeometry(0.2, 12, 12);
            const centerMat = new THREE.MeshStandardMaterial({ color: 0xFFFFE0 }); // Light Yellow center

            const centerMesh = new THREE.Mesh(centerGeo, centerMat);
            centerMesh.position.y = stemHeight + 0.2;
            flowerGroup.add(centerMesh);

            const numPetals = 5;
            for (let i = 0; i < numPetals; i++) {
                const angle = (i / numPetals) * Math.PI * 2;
                const petalMesh = new THREE.Mesh(petalGeo, petalMat);
                petalMesh.position.y = centerMesh.position.y;
                petalMesh.position.x = Math.cos(angle) * 0.35;
                petalMesh.position.z = Math.sin(angle) * 0.35;
                petalMesh.scale.set(1, 0.7, 0.5); // Flatten petals
                flowerGroup.add(petalMesh);
            }
            // ADD EFFECT Placeholder: Slight emissive glow for bloom?
            // petalMat.emissive = new THREE.Color(0x331111); // Very subtle glow
            break;
        default:
            console.warn("Unknown flower stage:", flowerData.stage); return;
    }

    flowerGroup.position.copy(position);
    flowerGroup.traverse(child => { if (child.isMesh) child.castShadow = true; }); // All parts cast shadow
    flowersOnScreen[slotId] = flowerGroup;
    scene.add(flowerGroup);

    // Simple "pop-in" animation
    const initialScale = 0.1;
    flowerGroup.scale.set(initialScale, initialScale, initialScale);
    // Need a library like GSAP for nice tweening, or manual lerp in animate()
    // Simple immediate scale for now:
    flowerGroup.scale.set(1,1,1); // Or animate this lerp in animate() loop
}


function renderAllFlowersFromState() {
    if (!scene) return; // Don't render if scene not ready
    console.log("Rendering all flowers based on state:", clientState.flowers);
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
    if (clientState.gameState !== 'playing') return; // Only allow input during play
    keys[event.code] = true;

    // Check for actions based on prompts
    if (clientState.nearbyAction) {
        if (event.code === 'KeyP' && clientState.nearbyAction.type === 'plant') {
             console.log("Attempting to plant seed via prompt at slot:", clientState.nearbyAction.targetId);
             socket.emit('plantFlower', { slotId: clientState.nearbyAction.targetId });
             clientState.nearbyAction = null; // Consume action
             actionPromptDisplay.classList.add('hidden');
        } else if (event.code === 'KeyN' && clientState.nearbyAction.type === 'nurture') {
             console.log("Attempting to nurture flower via prompt at slot:", clientState.nearbyAction.targetId);
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
    if (!playerMesh || !socket || !myPlayerId || clientState.gameState !== 'playing') return;

    const moveSpeed = PLAYER_SPEED * deltaTime;
    let moved = false;
    let moveDirection = new THREE.Vector3(0, 0, 0);

    if (keys['KeyW'] || keys['ArrowUp']) { moveDirection.z -= 1; moved = true; }
    if (keys['KeyS'] || keys['ArrowDown']) { moveDirection.z += 1; moved = true; }
    if (keys['KeyA'] || keys['ArrowLeft']) { moveDirection.x -= 1; moved = true; }
    if (keys['KeyD'] || keys['ArrowRight']) { moveDirection.x += 1; moved = true; }

    if (moved) {
        moveDirection.normalize();
        const potentialPosition = playerMesh.position.clone().add(moveDirection.multiplyScalar(moveSpeed));
        const halfGarden = GARDEN_SIZE / 2 - 0.6; // Based on player sphere radius
        potentialPosition.x = Math.max(-halfGarden, Math.min(halfGarden, potentialPosition.x));
        potentialPosition.z = Math.max(-halfGarden, Math.min(halfGarden, potentialPosition.z));
        playerMesh.position.copy(potentialPosition);

        // Update camera to follow player smoothly
        updateCameraPosition();

        // Check for resource collection (automatic)
        checkForResourceCollection();

        // Check for nearby actions (planting/nurturing prompts)
        checkForNearbyActions();

        // Send position update (consider throttling later)
        socket.emit('playerMove', playerMesh.position);
    }

    // Update player name mesh position
    // if (myPlayerNameMesh) {
    //    myPlayerNameMesh.position.copy(playerMesh.position).add(PLAYER_NAME_OFFSET);
    // }
}

function updateCameraPosition() {
    if (!camera || !playerMesh) return;
     const targetPosition = playerMesh.position.clone().add(CAMERA_OFFSET);
     // Smooth camera movement (lerp)
     camera.position.lerp(targetPosition, 0.1); // Adjust lerp factor (0.05-0.2)
     // Smooth lookAt
     const lookAtTarget = playerMesh.position.clone();
     // Use a temporary variable for lookAt lerping if needed, or just direct lookAt
     camera.lookAt(lookAtTarget);

     // if (controls) controls.target.copy(playerMesh.position); // Update OrbitControls target if used
}


// --- Game Mechanics ---

function checkForResourceCollection() {
    // Automatic collection on overlap
    const playerPos = playerMesh.position;
    const collectionRadiusSq = 1.0 * 1.0; // Player radius + resource radius approx

    for (const resourceId in resourcesOnScreen) {
        const resourceMesh = resourcesOnScreen[resourceId];
        if (playerPos.distanceToSquared(resourceMesh.position) < collectionRadiusSq) {
            // console.log("Player near resource:", resourceId); // Less logging
            socket.emit('collectResource', resourceId);
            // Server confirms removal and resource update
            // No need to break, can potentially collect multiple if perfectly overlapped
        }
    }
}

function checkForNearbyActions() {
    // Checks for potential Plant/Nurture actions and shows prompts
    if (!playerMesh) return;

    const playerPos = playerMesh.position;
    let possibleAction = null;

    // Check for Planting
    if (clientState.resources.petals > 0) {
        let closestEmptySlot = null;
        let minDistSq = ACTION_RADIUS_SQ;

        clientState.flowerSlots.forEach(slot => {
            // Check if slot is empty
             if (!clientState.flowers[slot.id]) {
                 const slotPos = new THREE.Vector3(slot.position.x, 0, slot.position.z);
                 const distSq = playerPos.distanceToSquared(slotPos);
                 if (distSq < minDistSq) {
                     minDistSq = distSq;
                     closestEmptySlot = slot;
                 }
             }
        });
        if (closestEmptySlot) {
            possibleAction = { type: 'plant', targetId: closestEmptySlot.id };
        }
    }

    // Check for Nurturing (only if not already targeting planting)
    if (!possibleAction && clientState.resources.water > 0) {
        let closestNurturableFlower = null;
        let minDistSq = ACTION_RADIUS_SQ;

         for (const slotId in clientState.flowers) {
             const flowerData = clientState.flowers[slotId];
             // Can only nurture if not fully bloomed
             if (flowerData.stage !== 'bloom') {
                 const slot = clientState.flowerSlots.find(s => s.id === slotId);
                 if (slot) {
                    const slotPos = new THREE.Vector3(slot.position.x, 0, slot.position.z);
                    const distSq = playerPos.distanceToSquared(slotPos);
                    if (distSq < minDistSq) {
                        minDistSq = distSq;
                        closestNurturableFlower = slotId;
                    }
                 }
             }
         }
         if (closestNurturableFlower) {
             possibleAction = { type: 'nurture', targetId: closestNurturableFlower };
         }
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
        // No action nearby, clear prompt
        if (clientState.nearbyAction) {
             clientState.nearbyAction = null;
             actionPromptDisplay.classList.add('hidden');
        }
    }
}


function updateWeatherEffects(weather) {
     // Use transitions or GSAP for smoother changes if possible
    console.log("Updating weather effects for:", weather);
    let bgColor, fogColor, fogNear, fogFar;
    switch (weather) {
        case 'Sunny':
            bgColor = new THREE.Color(0x87CEEB); fogColor = bgColor; fogNear = 50; fogFar = 100; // Less fog
             // ADD EFFECT Placeholder: Increase directional light intensity slightly?
            break;
        case 'Cloudy':
            bgColor = new THREE.Color(0xB0C4DE); fogColor = bgColor; fogNear = 20; fogFar = 60;
             // ADD EFFECT Placeholder: Decrease light intensity slightly?
            break;
        case 'Rainy':
            bgColor = new THREE.Color(0x778899); fogColor = bgColor; fogNear = 10; fogFar = 40;
             // ADD PARTICLE Placeholder: Start rain particle effect
             // console.log("START_PARTICLE: rain");
            break;
        default:
            bgColor = new THREE.Color(0x87CEEB); fogColor = bgColor; fogNear = 50; fogFar = 100;
    }

    if (scene) { // Check if scene exists
         // Smooth background color transition? Placeholder: Immediate change
         scene.background = bgColor;
         // Smooth fog transition? Placeholder: Immediate change
         if (fogNear && fogFar) {
             scene.fog = new THREE.Fog(fogColor, fogNear, fogFar);
         } else {
             scene.fog = null;
         }
    }

    // Stop rain particles if weather is not rainy (Placeholder)
    if (weather !== 'Rainy') {
        // console.log("STOP_PARTICLE: rain");
    }
}


// --- UI Update ---
function updateUI() {
    // Timer
    const minutes = Math.floor(clientState.timer / 60);
    const seconds = clientState.timer % 60;
    timerDisplay.textContent = `Time: ${minutes}:${seconds.toString().padStart(2, '0')}`;

    // Resources
    resourcesDisplay.textContent = `Petals: ${clientState.resources.petals} | Water: ${clientState.resources.water}`;

    // Weather
    weatherDisplay.textContent = `Weather: ${clientState.weather}`;

    // Player Names (already updated on join/setup)
}

// --- Timed Helpers ---
function updateTimedHelpers() {
    if (clientState.gameState !== 'playing' || !gameStartTime) {
        timedHelperDisplay.classList.add('hidden');
        return;
    }

    const elapsedSeconds = (Date.now() - gameStartTime) / 1000;
    if (elapsedSeconds > HELPER_DURATION) {
        timedHelperDisplay.classList.add('hidden');
        return;
    }

    let helperText = "";
    // Contextual helpers
    if (elapsedSeconds < 30) {
        helperText = "Use WASD or Arrows to move!";
    } else if (Object.keys(resourcesOnScreen).length > 0 && clientState.resources.petals === 0 && clientState.resources.water === 0) {
         helperText = "Walk over Pink Petals & Blue Water Drops to collect them!";
    } else if (clientState.resources.petals > 0 && !Object.values(clientState.flowers).some(f => f.stage !== 'bloom')) {
         // Has petals, but no flowers planted or all are bloomed
         const hasEmptySlot = clientState.flowerSlots.some(slot => !clientState.flowers[slot.id]);
         if(hasEmptySlot) helperText = "Got petals? Find a brown plot & press 'P' to plant!";
         else helperText = "Collect resources!"; // All plots full?
    } else if (clientState.resources.water > 0 && Object.values(clientState.flowers).some(f => f.stage !== 'seed' && f.stage !== 'bloom')) {
        helperText = "Got water? Find a growing flower & press 'N' to nurture!";
    } else if (elapsedSeconds > 60) { // General tip after a minute
         helperText = "Work together with your partner to grow the garden!";
    }


    if (helperText && timedHelperDisplay.textContent !== helperText) {
        timedHelperDisplay.textContent = helperText;
        timedHelperDisplay.classList.remove('hidden');
    } else if (!helperText) {
        timedHelperDisplay.classList.add('hidden');
    }
}


// --- Window Resize ---
function onWindowResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate);

    // Only run updates if the game is in the 'playing' state
    if (clientState.gameState !== 'playing' || !scene) {
        // If setup/waiting/finished, don't update game logic/render
        return;
    }

    const deltaTime = clock.getDelta();

    // Update player movement based on input
    updatePlayerMovement(deltaTime);

    // Update timed helpers display logic
    updateTimedHelpers();

    // Update other animations (resource bobbing)
    const time = clock.getElapsedTime(); // Use clock's elapsed time for smoother animation
    for (const id in resourcesOnScreen) {
        resourcesOnScreen[id].position.y = 0.5 + Math.sin(time * 3 + parseInt(id.split('_')[1]) * 0.5) * 0.15; // Bobbing effect
        resourcesOnScreen[id].rotation.y += deltaTime * 0.5; // Gentle rotation
    }
    // Flower swaying animation (Placeholder)
    for (const id in flowersOnScreen) {
         if (clientState.flowers[id]?.stage !== 'seed') { // Don't sway seeds
             flowersOnScreen[id].rotation.z = Math.sin(time * 1.5 + parseInt(id.split('_')[1]) * 0.8) * 0.05; // Gentle sway
         }
    }

    // Update controls if used for debugging
    // if (controls) controls.update();

    // Render the scene
    renderer.render(scene, camera);
}

// --- Start Everything ---
init(); // Call the UI initialization function when the script loads