// public/client.js
import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js'; // Use module version for imports

// --- Global Variables ---
let scene, camera, renderer;
let playerMesh, playerLight; // Our player's representation and a light source following them
let otherPlayers = {}; // Store meshes of other players { socketId: mesh }
let resourcesOnScreen = {}; // Store meshes of resources { resourceId: mesh }
let flowersOnScreen = {}; // Store meshes of flowers { slotId: mesh }
let gardenGrid, gardenPlane;
let keys = {}; // Keep track of currently pressed keys
let clock = new THREE.Clock();
let socket;
let myPlayerId;

// --- DOM Elements ---
const gameContainer = document.getElementById('game-container');
const timerDisplay = document.getElementById('timer');
const resourcesDisplay = document.getElementById('resources');
const weatherDisplay = document.getElementById('weather');
const messageDisplay = document.getElementById('message');

// --- Game State (Client Side) ---
let clientState = {
    resources: { petals: 0, water: 0 },
    weather: 'Sunny',
    timer: 1800,
    flowers: {}, // { slotId: { stage, plantedBy } } - mirrors server state
    flowerSlots: [] // Define positions for flowers
};

// --- Constants ---
const PLAYER_SPEED = 5.0;
const GARDEN_SIZE = 20;
const GRID_DIVISIONS = 20;
const FLOWER_SLOT_POSITIONS = [ // Example positions relative to garden center
    { x: -5, z: -5 }, { x: 0, z: -5 }, { x: 5, z: -5 },
    { x: -5, z: 0 },  { x: 0, z: 0 },  { x: 5, z: 0 },
    { x: -5, z: 5 },  { x: 0, z: 5 },  { x: 5, z: 5 },
];


// --- Initialization ---
function init() {
    // 1. Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB); // Sky blue background

    // 2. Camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 15, 15); // Position camera slightly above and back
    camera.lookAt(0, 0, 0); // Look at the center of the scene

    // 3. Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    gameContainer.appendChild(renderer.domElement);

    // 4. Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6); // Soft white light
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 7);
    scene.add(directionalLight);

    // --- Create Game Elements ---

    // Garden Grid & Plane
    createGarden();

    // Player Mesh (Placeholder Cube)
    const playerGeometry = new THREE.BoxGeometry(1, 1, 1);
    const playerMaterial = new THREE.MeshStandardMaterial({ color: 0x00ff00 }); // Green cube
    playerMesh = new THREE.Mesh(playerGeometry, playerMaterial);
    playerMesh.position.set(0, 0.5, 0); // Start slightly above the ground
    scene.add(playerMesh);
    
    // Add a light source attached to the player
    playerLight = new THREE.PointLight(0xffffff, 0.7, 15); // White light, intensity, distance
    playerLight.position.set(0, 2, 0); // Position relative to player mesh origin
    playerMesh.add(playerLight); // Attach light to player mesh


    // Initialize Flower Slots visually (optional placeholders)
    initFlowerSlots();

    // --- Event Listeners ---
    window.addEventListener('resize', onWindowResize, false);
    document.addEventListener('keydown', onKeyDown, false);
    document.addEventListener('keyup', onKeyUp, false);

    // --- Connect to Server ---
    setupSocketIO();

    // --- Start Animation Loop ---
    animate();
}

// --- Socket.IO Setup ---
function setupSocketIO() {
    // Connect to the Socket.IO server (URL should match your server)
    socket = io(); // Assumes server is on the same host/port

    socket.on('connect', () => {
        console.log('Connected to server!', socket.id);
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from server!');
        messageDisplay.textContent = 'Disconnected. Please refresh.';
        // Handle disconnection state in UI/game
    });

    socket.on('initialState', (state) => {
        console.log('Received initial state:', state);
        myPlayerId = state.playerId;
        clientState.timer = state.timer;
        clientState.weather = state.weather;
        clientState.flowers = state.flowers || {}; // Ensure flowers object exists

        // Set our player's initial position (server might override later if needed)
        if (state.players[myPlayerId]) {
             playerMesh.position.copy(state.players[myPlayerId].position);
             clientState.resources = state.players[myPlayerId].resources; // Get initial resources
        }

        // Add existing players
        for (const id in state.players) {
            if (id !== myPlayerId) {
                addOtherPlayer(state.players[id]);
            }
        }
        
        // Add existing resources
        state.resources.forEach(resource => {
            addResource(resource);
        });
        
        // Render existing flowers based on state
        renderAllFlowersFromState();

        updateUI(); // Update UI with initial state
    });

    socket.on('gameStateReset', (state) => {
        console.log("Received game state reset from server.");
        
        // Clear local resources
        for (const id in resourcesOnScreen) {
            scene.remove(resourcesOnScreen[id]);
        }
        resourcesOnScreen = {};
        
        // Clear local flowers
        renderAllFlowersFromState(); // This will clear based on empty state.flowers
        
        // Update client state variables
        clientState.flowers = state.flowers; // Should be {}
        clientState.timer = state.timer;
        clientState.weather = state.weather;
        
        // Reset player resources locally (server should send updated ones if needed)
        // Or wait for an 'updatePlayerResources' event after reset if server sends it
        // clientState.resources = { petals: 0, water: 0 }; 
        
        messageDisplay.textContent = ''; // Clear end game message
        
        updateUI();
        updateWeatherEffects(clientState.weather);
    });

    socket.on('playerJoined', (playerData) => {
        console.log('Player joined:', playerData.id);
        if (playerData.id !== myPlayerId) {
            addOtherPlayer(playerData);
        }
    });

    socket.on('playerLeft', (playerId) => {
        console.log('Player left:', playerId);
        removeOtherPlayer(playerId);
    });

    socket.on('playerMoved', (data) => {
        if (otherPlayers[data.id]) {
            // Smooth movement could be added here (e.g., lerping)
            otherPlayers[data.id].position.copy(data.position);
        }
    });
    
    socket.on('resourceSpawned', (resource) => {
        console.log('Resource spawned:', resource.id, resource.type);
        addResource(resource);
    });
    
    socket.on('resourceRemoved', (resourceId) => {
        console.log('Resource removed:', resourceId);
        removeResource(resourceId);
    });

    socket.on('updatePlayerResources', (resources) => {
        console.log("My resources updated:", resources);
        clientState.resources = resources;
        updateUI();
    });
    
    socket.on('flowerPlanted', (flowerData) => {
        console.log('Flower planted:', flowerData);
        clientState.flowers[flowerData.slotId] = flowerData;
        renderFlower(flowerData.slotId); // Create or update the flower mesh
        updateUI(); // Potentially update flower status UI element
    });
    
    socket.on('flowerGrown', (flowerData) => {
         console.log('Flower grown:', flowerData);
        clientState.flowers[flowerData.slotId] = flowerData;
        renderFlower(flowerData.slotId); // Update the flower mesh to new stage
        updateUI();
    });
    
    socket.on('weatherUpdate', (newWeather) => {
        console.log('Weather updated:', newWeather);
        clientState.weather = newWeather;
        // Optionally change scene appearance based on weather (e.g., lighting, fog)
        updateWeatherEffects(newWeather); 
        updateUI();
    });
    
    socket.on('timerUpdate', (newTime) => {
        clientState.timer = newTime;
        updateUI();
    });
    
    socket.on('gameOver', (data) => {
        console.log('Game Over:', data.message);
        messageDisplay.textContent = data.message;
        // Freeze player movement, show final screen, etc.
        // For now, just display the message
        keys = {}; // Stop movement
    });

    socket.on('connect_error', (err) => {
        console.error("Connection Error:", err.message);
        messageDisplay.textContent = 'Cannot connect to server. Please refresh later.';
    });
}


// --- Game Element Creation ---

function createGarden() {
    // Garden Plane (Ground)
    const planeGeometry = new THREE.PlaneGeometry(GARDEN_SIZE, GARDEN_SIZE);
    const planeMaterial = new THREE.MeshStandardMaterial({ color: 0x228B22, side: THREE.DoubleSide }); // Forest green
    gardenPlane = new THREE.Mesh(planeGeometry, planeMaterial);
    gardenPlane.rotation.x = -Math.PI / 2; // Rotate to lay flat
    scene.add(gardenPlane);

    // Grid Helper (Visual Aid)
    gardenGrid = new THREE.GridHelper(GARDEN_SIZE, GRID_DIVISIONS, 0x888888, 0x444444);
    gardenGrid.position.y = 0.01; // Slightly above the plane to avoid z-fighting
    scene.add(gardenGrid);
}

function initFlowerSlots() {
    // Optional: Add visual markers for where flowers can be planted
    const slotGeometry = new THREE.CircleGeometry(0.5, 16); // Small circle on the ground
    const slotMaterial = new THREE.MeshBasicMaterial({ color: 0x654321, side: THREE.DoubleSide, transparent: true, opacity: 0.5 }); // Brownish, semi-transparent
    
    FLOWER_SLOT_POSITIONS.forEach((pos, index) => {
        const slotMesh = new THREE.Mesh(slotGeometry, slotMaterial);
        slotMesh.rotation.x = -Math.PI / 2;
        slotMesh.position.set(pos.x, 0.02, pos.z); // Place slightly above ground
        scene.add(slotMesh);
        // Store the slot position with an ID for later reference
        clientState.flowerSlots.push({ id: `slot_${index}`, position: pos });
    });
}

function addOtherPlayer(playerData) {
    if (otherPlayers[playerData.id]) return; // Already exists

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    // Give other players a different color
    const material = new THREE.MeshStandardMaterial({ color: 0xff0000 }); // Red cube
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(playerData.position);
    otherPlayers[playerData.id] = mesh;
    scene.add(mesh);
}

function removeOtherPlayer(playerId) {
    if (otherPlayers[playerId]) {
        scene.remove(otherPlayers[playerId]);
        delete otherPlayers[playerId];
    }
}

function addResource(resource) {
    if (resourcesOnScreen[resource.id]) return; // Avoid duplicates

    let geometry, material;
    if (resource.type === 'petal') {
        geometry = new THREE.SphereGeometry(0.2, 8, 8); // Small sphere
        material = new THREE.MeshBasicMaterial({ color: 0xFFC0CB }); // Pink
    } else { // water
        geometry = new THREE.SphereGeometry(0.2, 8, 8); // Small sphere
        material = new THREE.MeshBasicMaterial({ color: 0xADD8E6 }); // Light Blue
    }
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(resource.position); // Use position from server
    resourcesOnScreen[resource.id] = mesh;
    scene.add(mesh);
}

function removeResource(resourceId) {
    if (resourcesOnScreen[resourceId]) {
        scene.remove(resourcesOnScreen[resourceId]);
        delete resourcesOnScreen[resourceId];
    }
}

// --- Flower Rendering & Growth ---
function renderFlower(slotId) {
    const flowerData = clientState.flowers[slotId];
    if (!flowerData) {
        // Flower might have been removed (if implementing removal)
        if (flowersOnScreen[slotId]) {
            scene.remove(flowersOnScreen[slotId]);
            delete flowersOnScreen[slotId];
        }
        return;
    }

    // Remove existing mesh for this slot if it exists
    if (flowersOnScreen[slotId]) {
        scene.remove(flowersOnScreen[slotId]);
    }

    let geometry, material;
    let scale = 1.0; // Base scale
    const slot = clientState.flowerSlots.find(s => s.id === slotId);
    if (!slot) {
        console.error("Slot not found for ID:", slotId);
        return;
    }
    
    const position = new THREE.Vector3(slot.position.x, 0, slot.position.z); // Base position on ground

    // Define appearance based on growth stage
    switch (flowerData.stage) {
        case 'seed':
            geometry = new THREE.SphereGeometry(0.1, 8, 8);
            material = new THREE.MeshStandardMaterial({ color: 0x8B4513 }); // Brown
            position.y = 0.1;
            break;
        case 'sprout':
            geometry = new THREE.ConeGeometry(0.15, 0.5, 8);
            material = new THREE.MeshStandardMaterial({ color: 0x90EE90 }); // Light Green
            position.y = 0.25; // Adjust height based on cone origin
            break;
        case 'budding':
            geometry = new THREE.SphereGeometry(0.3, 16, 16);
            material = new THREE.MeshStandardMaterial({ color: 0x32CD32 }); // Lime Green
            position.y = 0.6; // Buds are higher
            // Optional: Add a stem (cylinder)
            break;
        case 'bloom':
            // More complex shape - maybe multiple spheres or a custom model later
            geometry = new THREE.SphereGeometry(0.5, 16, 16); 
            // Color based on who planted or random? Example: Pink
            material = new THREE.MeshStandardMaterial({ color: 0xFF69B4, emissive: 0x330000 }); // Hot Pink, slight glow
            position.y = 1.0; 
            break;
        default:
            console.warn("Unknown flower stage:", flowerData.stage);
            return; // Don't render unknown stage
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.scale.set(scale, scale, scale); // Apply scale

    flowersOnScreen[slotId] = mesh;
    scene.add(mesh);

    // Simple animation (e.g., pop-in effect) - optional
    // gsap.from(mesh.scale, { x: 0.1, y: 0.1, z: 0.1, duration: 0.5, ease: "back.out(1.7)" });
}


function renderAllFlowersFromState() {
    console.log("Rendering all flowers based on state:", clientState.flowers);
    // Clear existing flower meshes first
    for (const slotId in flowersOnScreen) {
        scene.remove(flowersOnScreen[slotId]);
    }
    flowersOnScreen = {}; // Clear the tracker

    // Render based on current clientState.flowers (might be empty)
    if (clientState.flowers) { // Check if flowers object exists
        for (const slotId in clientState.flowers) {
            renderFlower(slotId);
        }
    }
}


// --- Player Input & Movement ---

function onKeyDown(event) {
    keys[event.code] = true;
    
    // Planting Action (Example: Press 'P')
    if (event.code === 'KeyP') {
        tryPlantSeed();
    }
    // Nurturing Action (Example: Press 'N')
    if (event.code === 'KeyN') {
        tryNurtureFlower();
    }
}

function onKeyUp(event) {
    keys[event.code] = false;
}

function updatePlayerMovement(deltaTime) {
    if (!playerMesh || !socket || !myPlayerId || clientState.timer <= 0) return; // Don't move if game over or not initialized

    const moveSpeed = PLAYER_SPEED * deltaTime;
    let moved = false;
    let moveDirection = new THREE.Vector3(0, 0, 0);

    if (keys['KeyW'] || keys['ArrowUp']) {
        moveDirection.z -= 1;
        moved = true;
    }
    if (keys['KeyS'] || keys['ArrowDown']) {
        moveDirection.z += 1;
        moved = true;
    }
    if (keys['KeyA'] || keys['ArrowLeft']) {
        moveDirection.x -= 1;
        moved = true;
    }
    if (keys['KeyD'] || keys['ArrowRight']) {
        moveDirection.x += 1;
        moved = true;
    }

    if (moved) {
        moveDirection.normalize(); // Ensure consistent speed diagonally

        // Calculate potential new position
        const potentialPosition = playerMesh.position.clone().add(moveDirection.multiplyScalar(moveSpeed));
        
        // Boundary Check (Simple clamp based on garden size)
        const halfGarden = GARDEN_SIZE / 2 - 0.5; // Subtract half player size
        potentialPosition.x = Math.max(-halfGarden, Math.min(halfGarden, potentialPosition.x));
        potentialPosition.z = Math.max(-halfGarden, Math.min(halfGarden, potentialPosition.z));
        
        // Apply movement
        playerMesh.position.copy(potentialPosition);


        // --- Check for Resource Collection ---
        checkForResourceCollection();

        // --- Send position update to server ---
        // Throttle this later if needed (e.g., send every 100ms)
        socket.emit('playerMove', playerMesh.position);
    }
}


// --- Game Mechanics ---

function checkForResourceCollection() {
    const playerPos = playerMesh.position;
    const collectionRadiusSq = 1.0 * 1.0; // Square of the distance threshold (adjust as needed)

    for (const resourceId in resourcesOnScreen) {
        const resourceMesh = resourcesOnScreen[resourceId];
        const distSq = playerPos.distanceToSquared(resourceMesh.position);

        if (distSq < collectionRadiusSq) {
            console.log("Player near resource:", resourceId);
            // Tell the server we *attempt* to collect this resource
            socket.emit('collectResource', resourceId); 
            // We don't remove/update client state directly. Server will confirm.
            break; // Collect one at a time per check cycle
        }
    }
}

function tryPlantSeed() {
    if (!socket || clientState.resources.petals <= 0) {
        console.log("Cannot plant: No petals or not connected.");
        // Optionally show UI message: "Need Pixel Petals to plant!"
        return; 
    }

    const playerPos = playerMesh.position;
    const plantingRadiusSq = 2.0 * 2.0; // How close player needs to be to a slot
    let closestSlot = null;
    let minDistSq = plantingRadiusSq;

    clientState.flowerSlots.forEach(slot => {
        const slotPos = new THREE.Vector3(slot.position.x, 0, slot.position.z);
        const distSq = playerPos.distanceToSquared(slotPos);
        
        // Find the closest *empty* slot within range
        if (distSq < minDistSq && !clientState.flowers[slot.id]) {
            minDistSq = distSq;
            closestSlot = slot;
        }
    });

    if (closestSlot) {
        console.log("Attempting to plant seed at slot:", closestSlot.id);
        // Tell the server we want to plant here
        socket.emit('plantFlower', { slotId: closestSlot.id });
        // Client state updates will come back from the server on success
    } else {
        console.log("No empty flower slot nearby to plant in.");
         // Optionally show UI message: "Move closer to an empty plot!"
    }
}

function tryNurtureFlower() {
     if (!socket || clientState.resources.water <= 0) {
        console.log("Cannot nurture: No water or not connected.");
        // Optionally show UI message: "Need Water Droplets to nurture!"
        return; 
    }
    
    const playerPos = playerMesh.position;
    const nurturingRadiusSq = 2.0 * 2.0; // How close player needs to be
    let closestFlowerSlotId = null;
    let minDistSq = nurturingRadiusSq;

    for (const slotId in clientState.flowers) {
        const flowerData = clientState.flowers[slotId];
        const slot = clientState.flowerSlots.find(s => s.id === slotId);
        
        if (slot && flowerData.stage !== 'bloom') { // Can only nurture if not fully bloomed
            const slotPos = new THREE.Vector3(slot.position.x, 0, slot.position.z);
             const distSq = playerPos.distanceToSquared(slotPos);
             if (distSq < minDistSq) {
                 minDistSq = distSq;
                 closestFlowerSlotId = slotId;
             }
        }
    }
     
    if (closestFlowerSlotId) {
        console.log("Attempting to nurture flower at slot:", closestFlowerSlotId);
        // Tell the server we want to nurture this flower
        socket.emit('nurtureFlower', { slotId: closestFlowerSlotId });
        // Server handles resource deduction and growth logic
    } else {
         console.log("No growing flower nearby to nurture.");
         // Optionally show UI message: "Move closer to a growing flower!"
    }
}

function updateWeatherEffects(weather) {
    // Example: Change background color or fog
    switch(weather) {
        case 'Sunny':
            scene.background = new THREE.Color(0x87CEEB); // Sky blue
            scene.fog = null; // Remove fog
             // Maybe make directional light brighter
            break;
        case 'Cloudy':
            scene.background = new THREE.Color(0xB0C4DE); // Light steel blue
            scene.fog = new THREE.Fog(0xB0C4DE, 20, 60); // Add some fog
             // Maybe dim lights slightly
            break;
        case 'Rainy':
            scene.background = new THREE.Color(0x778899); // Light slate gray
            scene.fog = new THREE.Fog(0x778899, 10, 40); // Denser fog
            // Optional: Add particle system for rain effect
            break;
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
    
    // Clear previous messages if needed
    // messageDisplay.textContent = ''; // Clear general messages unless there's a persistent one
}

// --- Window Resize ---
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate); // Request next frame

    const deltaTime = clock.getDelta(); // Time since last frame

    // Update player movement based on input
    updatePlayerMovement(deltaTime);
    
    // Other animations (e.g., simple bobbing for resources)
    const time = Date.now() * 0.001; // Get time for smooth animation
     for (const id in resourcesOnScreen) {
         resourcesOnScreen[id].position.y = 0.5 + Math.sin(time * 2 + resourcesOnScreen[id].id * 0.5) * 0.1; // Simple bobbing
     }

    // Render the scene
    renderer.render(scene, camera);
}

// --- Start Everything ---
init(); // Call the initialization function when the script loads