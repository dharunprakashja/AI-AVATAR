import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const canvas = document.getElementById('vrm-canvas');
const shadowEl = document.getElementById('model-shadow');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
    44,
    window.innerWidth / window.innerHeight,
    0.1, 20
);

const modelRoot = new THREE.Group();
scene.add(modelRoot);

// Default camera — slight bust-up framing
camera.position.set(0, 1.1, 3.8);
camera.lookAt(0, 0.8, 0);

const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
    precision: 'highp',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = false; // keep shadows off — not needed, saves memory

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

// ─── WEBGL CONTEXT LOSS RECOVERY ──────────────────────────────────────────────
// When GPU runs out of memory (e.g. after many audio reconnects), Three.js
// loses the WebGL context. We reload the VRM to rebuild all GPU resources.
canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('[vrm] WebGL context lost — will reload VRM on restore');
    vrm = null;
    vrmVisible = true;
}, false);

canvas.addEventListener('webglcontextrestored', () => {
    console.log('[vrm] WebGL context restored — reloading VRM');
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    loadVRM();
}, false);

// Lighting — warm, romantic feel
const ambientLight = new THREE.AmbientLight(0xfff0e8, 1.4);
scene.add(ambientLight);
const key = new THREE.DirectionalLight(0xffe8d0, 1.3);
key.position.set(0.5, 2, 2);
scene.add(key);
const fill = new THREE.DirectionalLight(0xd0e8ff, 0.5);
fill.position.set(-1, 0.5, 1);
scene.add(fill);
const backLight = new THREE.DirectionalLight(0xffeedd, 0.3);
backLight.position.set(0, 1, -2);
scene.add(backLight);

let vrm = null;
let vrmVisible = true;
let pendingShow = false;

// ─── STATE MACHINE ────────────────────────────────────────────────────────────
// States: idle | bot | user | excited | laugh | shy | sad | teasing | thinking | listening
let animState = 'idle';
let prevAnimState = 'idle';
let stateTransitionProgress = 0; // 0→1 blend when switching states
const STATE_BLEND_SPEED = 3.0;

// ─── TIMING ───────────────────────────────────────────────────────────────────
let prevTime = performance.now();
let elapsedTime = 0;
let lipPhase = 0;
let blinkTimer = 0;
let blinkInterval = 3.5;   // randomized each blink
let headNodTimer = 0;
let gestureTimer = 0;
let gesturePhase = 0;       // 0 = rest, 1 = active
let idleSwayPhase = 0;
let breathPhase = 0;

// ─── EMOTION SYSTEM ───────────────────────────────────────────────────────────
// Auto-detect emotion from text keywords → override animState briefly
let emotionOverride = null;
let emotionOverrideTimer = 0;

// ─── VRMA ANIMATION SYSTEM ────────────────────────────────────────────────────
// These .vrma files are plain GLB files containing a standard Three.js AnimationClip.
// We load them with a plain GLTFLoader (no VRMAnimationLoaderPlugin) and apply
// gltf.animations[0] directly to the AnimationMixer bound to the VRM scene.

let mixer = null;
let vrmaAction = null;        // currently playing THREE.AnimationAction
const vrmaFadeTime = 0.6;     // crossfade seconds — slow enough for smooth loop restart

// Preloaded THREE.AnimationClip objects keyed by state name
const vrmaClips = {};

// Map state names → VRMA file URLs.
// idle uses Angry.vrma so the model always looks engaged while waiting.
const VRMA_STATES = {
    idle:       '/static/VRMA/LookAround.vrma',
    angry:      '/static/VRMA/Angry.vrma',
    blush:      '/static/VRMA/Blush.vrma',
    clapping:   '/static/VRMA/Clapping.vrma',
    goodbye:    '/static/VRMA/Goodbye.vrma',
    jump:       '/static/VRMA/Jump.vrma',
    lookAround: '/static/VRMA/LookAround.vrma',
    relax:      '/static/VRMA/Relax.vrma',
    sad:        '/static/VRMA/Sad.vrma',
    sleepy:     '/static/VRMA/Sleepy.vrma',
    surprised:  '/static/VRMA/Surprised.vrma',
    thinking:   '/static/VRMA/Thinking.vrma',
};

// Plain loader — no VRM-specific plugins needed for these files
const vrmaLoader = new GLTFLoader();

// Helper to map generic VRMA bone names to your specific model's bone names
function retargetVRMAClip(vrm, clip) {
    const tracks = [];
    clip.tracks.forEach((track) => {
        const parts = track.name.split('.');
        if (parts.length !== 2) return;

        const boneName = parts[0];     // e.g., "LeftUpperArm"
        const property = parts[1];     // e.g., "quaternion"

        // Convert PascalCase (VRMA standard) to camelCase (VRM node standard)
        const vrmBoneName = boneName.charAt(0).toLowerCase() + boneName.slice(1);

        // Find the actual bone node in this specific loaded VRM
        const boneNode = vrm.humanoid.getNormalizedBoneNode(vrmBoneName);

        if (boneNode) {
            // Clone the track and update the target name to the actual mesh bone name
            const newTrack = track.clone();
            newTrack.name = `${boneNode.name}.${property}`;
            tracks.push(newTrack);
        }
    });

    // Return a new clip that the Three.js AnimationMixer can successfully bind
    return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

function loadVRMAClip(state, url) {
    vrmaLoader.load(
        url,
        (gltf) => {
            const clips = gltf.animations;
            if (!clips || clips.length === 0) {
                console.warn(`[vrma] no animations found in ${url}`);
                return;
            }
            let clip = clips[0];
            if (vrm) clip = retargetVRMAClip(vrm, clip); // Retarget bone names
            vrmaClips[state] = clip;
            console.log(`[vrma] clip loaded: ${state} (${clip.name || 'unnamed'}, ${clip.duration.toFixed(2)}s)`);
            // If we're already waiting in this state, start immediately
            const active = emotionOverride || animState;
            if (active === state && mixer) {
                playVRMAState(state);
            }
        },
        undefined,
        (e) => console.warn(`[vrma] load error (${state}):`, e.message)
    );
}

function playVRMAState(state) {
    if (!mixer || !vrmaClips[state]) return;

    const clip = vrmaClips[state];
    const newAction = mixer.clipAction(clip);
    newAction.setLoop(THREE.LoopRepeat, Infinity);
    newAction.clampWhenFinished = false;

    // Same clip already playing — do nothing (avoids restart glitch on re-entry)
    if (vrmaAction === newAction && newAction.isRunning()) return;

    if (vrmaAction && vrmaAction !== newAction) {
        // Different clip — smooth crossfade
        newAction.reset();
        newAction.enabled = true;
        newAction.setEffectiveTimeScale(1);
        newAction.setEffectiveWeight(1);
        newAction.crossFadeFrom(vrmaAction, vrmaFadeTime, true);
        newAction.play();
    } else {
        // First play or same clip restarted after a stop
        newAction.reset().play();
    }
    vrmaAction = newAction;
}

function stopVRMA() {
    if (vrmaAction) {
        vrmaAction.fadeOut(vrmaFadeTime);
        vrmaAction = null;
    }
}

// ─── CAMERA MOTION ────────────────────────────────────────────────────────────
const CAM_BASE = new THREE.Vector3(0, 1.1, 3.8);
const CAM_TARGET = new THREE.Vector3(0, 0.8, 0);
let camOffset = new THREE.Vector3();

let isDragging = false;
let lastPointerX = 0;
let lastPointerY = 0;
let targetYaw = 0;
let targetPitch = 0;
const ROTATE_SPEED = 0.005;
const PITCH_LIMIT = Math.PI / 2 - 0.15;

canvas.style.touchAction = 'none';
canvas.addEventListener('pointerdown', (e) => {
    isDragging = true;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastPointerX;
    const dy = e.clientY - lastPointerY;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    targetYaw += dx * ROTATE_SPEED;
    targetPitch += dy * ROTATE_SPEED;
    targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, targetPitch));
});

canvas.addEventListener('pointerup', (e) => {
    isDragging = false;
    canvas.releasePointerCapture(e.pointerId);
});

canvas.addEventListener('pointercancel', (e) => {
    isDragging = false;
    canvas.releasePointerCapture(e.pointerId);
});

const loader = new GLTFLoader();
loader.register(parser => new VRMLoaderPlugin(parser));

function disposeVRM(v) {
    if (!v) return;
    modelRoot.remove(v.scene);
    v.scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach(m => {
                // Dispose every texture slot
                Object.values(m).forEach(val => {
                    if (val && val.isTexture) val.dispose();
                });
                m.dispose();
            });
        }
    });
}

function loadVRM() {
    if (vrm) { disposeVRM(vrm); vrm = null; }
    if (mixer) { mixer.stopAllAction(); mixer = null; }
    vrmaAction = null;
    Object.keys(vrmaClips).forEach(k => delete vrmaClips[k]);

    loader.load(
        '/static/Furry.vrm',
        (gltf) => {
            vrm = gltf.userData.vrm;
            VRMUtils.rotateVRM0(vrm);
            VRMUtils.removeUnnecessaryJoints(vrm.scene);
            vrm.scene.traverse((child) => {
                if (child.isSkinnedMesh) child.frustumCulled = false;
            });
            setIdlePose(vrm);
            vrm.scene.visible = vrmVisible;
            modelRoot.add(vrm.scene);
            targetYaw = 0;
            targetPitch = 0;

            // Create AnimationMixer bound to this VRM scene
            mixer = new THREE.AnimationMixer(vrm.scene);

            // Preload all VRMA clips — deduplicate by URL so shared files load once
            const urlToStates = {};
            Object.entries(VRMA_STATES).forEach(([state, url]) => {
                if (!urlToStates[url]) urlToStates[url] = [];
                urlToStates[url].push(state);
            });
            Object.entries(urlToStates).forEach(([url, states]) => {
                vrmaLoader.load(
                    url,
                    (gltf) => {
                        const clips = gltf.animations;
                        if (!clips || clips.length === 0) {
                            console.warn(`[vrma] no animations in ${url}`);
                            return;
                        }
                        let clip = clips[0];
                        
                        // Retarget the VRMA clip's generic bone names to this specific VRM's bone names
                        clip = retargetVRMAClip(vrm, clip);

                        // Assign the same mapped clip object to all states sharing this URL
                        states.forEach(s => { vrmaClips[s] = clip; });
                        console.log(`[vrma] loaded: ${states.join('/')} (${clip.duration.toFixed(2)}s)`);
                        
                        // If already waiting in one of these states, start playing
                        const active = emotionOverride || animState;
                        if (states.includes(active) && mixer) playVRMAState(active);
                    },
                    undefined,
                    (e) => console.warn(`[vrma] load error (${url}):`, e.message)
                );
            });

            console.log('[vrm] loaded ✨');
            _show();
        },
        (p) => console.log('[vrm] loading', ((p.loaded / p.total) * 100 | 0) + '%'),
        (e) => console.warn('[vrm] load error\n', e.message)
    );
}

loadVRM();

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const getBone = name => vrm?.humanoid?.getNormalizedBoneNode(name) ?? null;
const setExpr = (name, v) => vrm?.expressionManager?.setValue(name, Math.max(0, Math.min(1, v)));

function lerpAngle(current, target, t) {
    return current + (target - current) * t;
}

function smoothLerp(a, b, t) {
    return a + (b - a) * (t * t * (3 - 2 * t)); // smoothstep
}

function setArmPose(side, upper, lower, hand = { x: 0, y: 0, z: 0 }) {
    const upperArm = getBone(`${side}UpperArm`);
    const lowerArm = getBone(`${side}LowerArm`);
    const handBone = getBone(`${side}Hand`);
    if (upperArm) upperArm.rotation.set(upper.x, upper.y, upper.z);
    if (lowerArm) lowerArm.rotation.set(lower.x, lower.y, lower.z);
    if (handBone) handBone.rotation.set(hand.x, hand.y, hand.z);
}

// ─── IDLE POSE ────────────────────────────────────────────────────────────────
// VRM normalized T-pose = arms fully horizontal (rotation all zero).
// Lower arms to sides: upperArm.z ≈ +1.3 (left) / -1.3 (right)
// x controls forward/backward tilt of the arm.
function setIdlePose(v) {
    const h = v.humanoid;
    const nb = n => h.getNormalizedBoneNode(n);

    if (nb('leftUpperArm')) nb('leftUpperArm').rotation.set(0.05, 0, -1.3);
    if (nb('rightUpperArm')) nb('rightUpperArm').rotation.set(0.05, 0, 1.3);
    if (nb('leftLowerArm')) nb('leftLowerArm').rotation.set(0, 0, -0.1);
    if (nb('rightLowerArm')) nb('rightLowerArm').rotation.set(0, 0, 0.1);
    if (nb('leftHand')) nb('leftHand').rotation.set(0, 0, 0.05);
    if (nb('rightHand')) nb('rightHand').rotation.set(0, 0, -0.05);
    if (nb('spine')) nb('spine').rotation.x = 0.04;
    if (nb('chest')) nb('chest').rotation.x = -0.02;
    if (nb('neck')) nb('neck').rotation.x = 0.02;
    if (nb('head')) nb('head').rotation.x = 0.04;
}

// ─── BLINK SYSTEM ─────────────────────────────────────────────────────────────
// Returns blink value 0–1
function updateBlink(dt) {
    blinkTimer += dt;
    const c = blinkTimer % blinkInterval;
    const closeTime = 0.07;
    const openTime = 0.10;
    if (c > blinkInterval - closeTime - openTime) {
        const phase = c - (blinkInterval - closeTime - openTime);
        if (phase < closeTime) return phase / closeTime;
        else return 1 - (phase - closeTime) / openTime;
    }
    if (blinkTimer > blinkInterval) {
        blinkTimer = 0;
        blinkInterval = 2.5 + Math.random() * 3;
    }
    return 0;
}

// ─── BREATH SYSTEM ────────────────────────────────────────────────────────────
function updateBreath(dt, speed = 1.0) {
    breathPhase += dt * speed;
    const spine = getBone('spine');
    const chest = getBone('chest');
    if (spine) spine.rotation.x = 0.04 + Math.sin(breathPhase * 0.8) * 0.008;
    if (chest) chest.rotation.x = -0.02 + Math.sin(breathPhase * 0.8 + 0.3) * 0.006;
}

// ─── LIP SYNC ─────────────────────────────────────────────────────────────────
function updateLip(dt, intensity = 1.0) {
    lipPhase += dt * 10;
    // Multi-sine for more natural lip movement
    const raw = (Math.sin(lipPhase) * 0.45 + Math.sin(lipPhase * 2.3) * 0.25 + Math.sin(lipPhase * 0.7) * 0.3);
    const aa = Math.max(0, raw * 0.55 + 0.25) * intensity;
    const oh = Math.max(0, Math.sin(lipPhase * 0.5) * 0.2) * intensity;
    setExpr('aa', aa);
    setExpr('oh', oh);
}

function stopLip() {
    setExpr('aa', 0);
    setExpr('oh', 0);
    lipPhase = 0;
}

// ─── HEAD NOD (listening / affirmative) ───────────────────────────────────────
function updateHeadNod(dt, t, intensity = 0.5) {
    headNodTimer += dt;
    const head = getBone('head');
    const neck = getBone('neck');
    if (head) head.rotation.x = 0.04 + Math.sin(headNodTimer * 3.5) * 0.04 * intensity;
    if (neck) neck.rotation.x = 0.02 + Math.sin(headNodTimer * 3.5 + 0.2) * 0.02 * intensity;
}

// ─── IDLE ANIMATION ───────────────────────────────────────────────────────────
function doIdle(dt, t) {
    updateBreath(dt, 1.0);

    const spine = getBone('spine');
    if (spine) {
        spine.rotation.z = Math.sin(t * 0.9) * 0.008;
        spine.rotation.y = Math.sin(t * 0.45) * 0.006;
    }
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.y = Math.sin(t * 0.38) * 0.025;
        neck.rotation.z = Math.sin(t * 0.30) * 0.012;
    }
    const head = getBone('head');
    if (head) {
        head.rotation.y = Math.sin(t * 0.38) * 0.018;
    }
    // Arms hang naturally at sides — all axes set every frame
    const idleSwing = Math.sin(t * 0.55) * 0.015;
    setArmPose('left', { x: 0.05, y: 0, z: -1.3 - idleSwing }, { x: 0, y: 0, z: -0.1 }, { x: 0, y: 0, z: 0.05 });
    setArmPose('right', { x: 0.05, y: 0, z: 1.3 + idleSwing }, { x: 0, y: 0, z: 0.1 }, { x: 0, y: 0, z: -0.05 });

    setExpr('blink', updateBlink(dt));
}

// ─── BOT SPEAKING ─────────────────────────────────────────────────────────────
function doBot(dt, t) {
    updateBreath(dt, 1.3);
    updateLip(dt, 1.0);

    // Animated head tilt — engaged storyteller
    const head = getBone('head');
    if (head) {
        head.rotation.x = 0.05 + Math.sin(t * 4.2) * 0.028;
        head.rotation.y = Math.sin(t * 0.6) * 0.04;
        head.rotation.z = Math.sin(t * 0.4) * 0.018;
    }
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.y = Math.sin(t * 0.55) * 0.03;
        neck.rotation.z = Math.sin(t * 0.3) * 0.015;
    }
    const spine = getBone('spine');
    if (spine) {
        spine.rotation.z = Math.sin(t * 1.1) * 0.012;
        spine.rotation.x = 0.04 + Math.sin(t * 0.9) * 0.012;
        spine.rotation.y = Math.sin(t * 0.45) * 0.02;
    }
    // Arms stay naturally at sides while talking — no gestures
    const idleSwing = Math.sin(t * 0.55) * 0.008;
    setArmPose('left',  { x: 0.05, y: 0, z: -1.3 - idleSwing }, { x: 0, y: 0, z: -0.1 }, { x: 0, y: 0, z: 0.05 });
    setArmPose('right', { x: 0.05, y: 0, z:  1.3 + idleSwing }, { x: 0, y: 0, z:  0.1 }, { x: 0, y: 0, z: -0.05 });

    setExpr('blink', updateBlink(dt));
    setExpr('happy', 0.3 + Math.sin(t * 0.5) * 0.1);
}

// ─── USER SPEAKING (listening) ────────────────────────────────────────────────
function doUser(dt, t) {
    updateBreath(dt, 0.9);
    stopLip();
    updateHeadNod(dt, t, 0.6);

    const spine = getBone('spine');
    if (spine) {
        spine.rotation.x = 0.06; // lean slightly forward — attentive
        spine.rotation.z = Math.sin(t * 0.6) * 0.006;
    }
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.y = Math.sin(t * 0.3) * 0.02;
    }

    const listenSway = Math.sin(t * 0.6) * 0.03;
    setArmPose('left', { x: 0.02, y: 0.05, z: -1.15 }, { x: 0.02, y: 0, z: -0.2 }, { x: 0, y: 0, z: 0.1 });
    setArmPose('right', { x: 0.02, y: -0.05, z: 1.15 }, { x: 0.02, y: 0, z: 0.2 }, { x: 0, y: 0, z: -0.1 });
    if (spine) spine.rotation.y += listenSway;

    setExpr('blink', updateBlink(dt));
    setExpr('happy', 0.2);
}

// ─── EXCITED ANIMATION ────────────────────────────────────────────────────────
function doExcited(dt, t) {
    updateBreath(dt, 1.8);
    updateLip(dt, 0.7);

    const bounce = Math.sin(t * 8) * 0.04;

    const spine = getBone('spine');
    if (spine) {
        spine.rotation.x = 0.02 + Math.sin(t * 6) * 0.02;
        spine.rotation.z = Math.sin(t * 5) * 0.02;
        spine.rotation.y = Math.sin(t * 4) * 0.03;
    }
    // Bounce in head
    const head = getBone('head');
    if (head) {
        head.rotation.x = 0.04 + Math.sin(t * 7) * 0.04;
        head.rotation.z = Math.sin(t * 4) * 0.04;
    }
    // Arms raise and swing — excited celebration
    setArmPose(
        'left',
        { x: -0.55 + bounce, y: 0.1, z: -0.6 },
        { x: -0.2 + bounce, y: 0, z: -0.05 },
        { x: 0, y: 0, z: 0.1 }
    );
    setArmPose(
        'right',
        { x: -0.55 + bounce, y: -0.1, z: 0.6 },
        { x: -0.2 + bounce, y: 0, z: 0.05 },
        { x: 0, y: 0, z: -0.1 }
    );

    setExpr('blink', updateBlink(dt) * 0.4);
    setExpr('happy', 0.8 + Math.sin(t * 3) * 0.2);
    setExpr('surprised', 0.3 + Math.sin(t * 4) * 0.15);
}

// ─── LAUGH ANIMATION ──────────────────────────────────────────────────────────
function doLaugh(dt, t) {
    updateBreath(dt, 2.5);

    const giggle = Math.sin(t * 10) * 0.05;

    const spine = getBone('spine');
    if (spine) {
        spine.rotation.x = 0.1 + Math.sin(t * 9) * 0.06; // shaking laugh
        spine.rotation.z = Math.sin(t * 8) * 0.03;
        spine.rotation.y = giggle * 0.5;
    }
    const head = getBone('head');
    if (head) {
        head.rotation.x = 0.08 + Math.sin(t * 8) * 0.05;
        head.rotation.z = Math.sin(t * 6) * 0.03;
    }
    const neck = getBone('neck');
    if (neck) neck.rotation.x = 0.06 + Math.sin(t * 8) * 0.04;
    // Hands come up near face — laughing gesture
    setArmPose(
        'left',
        { x: -0.6, y: 0.05, z: -0.65 },
        { x: -0.4 + giggle, y: 0, z: -0.12 },
        { x: 0.1, y: 0, z: 0.2 }
    );
    setArmPose(
        'right',
        { x: -0.6, y: -0.05, z: 0.65 },
        { x: -0.4 + giggle, y: 0, z: 0.12 },
        { x: 0.1, y: 0, z: -0.2 }
    );

    // Laugh blink — eyes squint
    const blink = 0.5 + Math.sin(t * 9) * 0.4;
    setExpr('blinkLeft', blink * 0.6);
    setExpr('blinkRight', blink * 0.6);
    setExpr('happy', 1.0);
    setExpr('aa', Math.max(0, Math.sin(t * 8) * 0.7));
}

// ─── SHY / FLUSTERED ANIMATION ────────────────────────────────────────────────
function doShy(dt, t) {
    updateBreath(dt, 0.9);
    stopLip();

    const fidget = Math.sin(t * 3.5) * 0.04;

    const head = getBone('head');
    if (head) {
        // Look down-side — shy tilt
        head.rotation.x = 0.15 + Math.sin(t * 0.5) * 0.02;
        head.rotation.y = -0.12 + Math.sin(t * 0.3) * 0.015;
        head.rotation.z = 0.06;
    }
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.x = 0.08;
        neck.rotation.y = -0.06;
    }
    const spine = getBone('spine');
    if (spine) spine.rotation.x = 0.08; // slight inward lean
    // Arms pulled closer — closed shy pose, all axes
    setArmPose(
        'left',
        { x: 0.08, y: 0.15, z: -1.45 + fidget },
        { x: 0.05, y: 0, z: -0.2 },
        { x: 0, y: 0, z: 0.15 }
    );
    setArmPose(
        'right',
        { x: 0.08, y: -0.15, z: 1.45 - fidget },
        { x: 0.05, y: 0, z: 0.2 },
        { x: 0, y: 0, z: -0.15 }
    );

    setExpr('blink', updateBlink(dt) * 1.2);
    // Rosy shy expression
    setExpr('happy', 0.5 + Math.sin(t * 0.8) * 0.1);
    setExpr('blushLevel', 0.6); // if model supports it
}

// ─── SAD / COMFORTING ANIMATION ───────────────────────────────────────────────
function doSad(dt, t) {
    updateBreath(dt, 0.7);
    stopLip();

    const slump = Math.sin(t * 0.5) * 0.01;

    const head = getBone('head');
    if (head) {
        head.rotation.x = 0.12; // looking down
        head.rotation.y = Math.sin(t * 0.25) * 0.02;
        head.rotation.z = Math.sin(t * 0.2) * 0.015;
    }
    const spine = getBone('spine');
    if (spine) spine.rotation.x = 0.1 + slump; // slightly hunched
    const neck = getBone('neck');
    if (neck) neck.rotation.x = 0.06;
    setArmPose(
        'left',
        { x: 0.14, y: 0.02, z: -1.5 },
        { x: 0.15, y: 0, z: -0.2 },
        { x: 0.05, y: 0, z: 0.12 }
    );
    setArmPose(
        'right',
        { x: 0.14, y: -0.02, z: 1.5 },
        { x: 0.15, y: 0, z: 0.2 },
        { x: 0.05, y: 0, z: -0.12 }
    );

    setExpr('blink', updateBlink(dt));
    setExpr('sad', 0.6 + Math.sin(t * 0.4) * 0.1);
    setExpr('happy', 0);
}

// ─── TEASING ANIMATION ────────────────────────────────────────────────────────
function doTeasing(dt, t) {
    updateBreath(dt, 1.2);
    updateLip(dt, 0.5);

    const flick = Math.sin(t * 3.5) * 0.15;

    const head = getBone('head');
    if (head) {
        // Playful head tilt
        head.rotation.x = 0.06;
        head.rotation.y = 0.1 + Math.sin(t * 0.8) * 0.04;
        head.rotation.z = 0.1 + Math.sin(t * 1.2) * 0.02; // coy tilt
    }
    const spine = getBone('spine');
    if (spine) {
        spine.rotation.z = 0.03 + Math.sin(t * 0.9) * 0.01;
        spine.rotation.x = 0.05;
    }
    // Left arm down, right arm flicking — coy gesture
    setArmPose('left', { x: 0.05, y: 0, z: -1.3 }, { x: 0, y: 0, z: -0.1 }, { x: 0, y: 0, z: 0.08 });
    setArmPose(
        'right',
        { x: 0.02, y: 0.08, z: 0.9 },
        { x: -0.1 + flick, y: 0, z: 0.2 },
        { x: 0, y: 0, z: -0.2 + flick }
    );

    setExpr('blink', updateBlink(dt) * 0.8);
    setExpr('happy', 0.65 + Math.sin(t * 1.2) * 0.15);
    // Wink timing
    const winkCycle = t % 8;
    if (winkCycle > 7.6) setExpr('blinkRight', (winkCycle - 7.6) / 0.15);
    else if (winkCycle > 7.75) setExpr('blinkRight', 1 - (winkCycle - 7.75) / 0.15);
    else setExpr('blinkRight', 0);
}

// ─── THINKING ANIMATION ───────────────────────────────────────────────────────
function doThinking(dt, t) {
    updateBreath(dt, 0.8);
    stopLip();

    const tap = Math.sin(t * 2.2) * 0.05;

    const head = getBone('head');
    if (head) {
        // Tilted — thinking pose
        head.rotation.x = 0.05;
        head.rotation.y = 0.08 + Math.sin(t * 0.3) * 0.02;
        head.rotation.z = -0.05;
    }
    const neck = getBone('neck');
    if (neck) neck.rotation.y = 0.04;
    // Left arm down, right arm raised to chin — thinking pose, all axes
    setArmPose(
        'left',
        { x: 0.05, y: 0, z: -1.3 },
        { x: 0, y: 0, z: -0.1 },
        { x: 0, y: 0, z: 0.05 }
    );
    setArmPose(
        'right',
        { x: -0.85, y: 0.1, z: 0.4 },
        { x: -0.55 + tap, y: 0, z: 0.15 },
        { x: 0.15, y: 0, z: 0.05 }
    );

    setExpr('blink', updateBlink(dt));
    setExpr('happy', 0.1);
}

// ─── ANGRY ANIMATION ──────────────────────────────────────────────────────────
// Leaning forward, arms stiff at sides, tense body, furrowed brow
function doAngry(dt, t) {
    updateBreath(dt, 1.6);
    stopLip();

    const tremor = Math.sin(t * 14) * 0.008; // subtle body shake
    const clench = Math.sin(t * 12) * 0.012;

    const spine = getBone('spine');
    if (spine) {
        spine.rotation.x = 0.12 + tremor;   // lean forward aggressively
        spine.rotation.z = tremor * 0.5;
        spine.rotation.y = Math.sin(t * 0.4) * 0.01;
    }
    const chest = getBone('chest');
    if (chest) {
        chest.rotation.x = 0.06 + tremor;
    }
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.x = -0.04;            // head tilts back slightly — defiant
        neck.rotation.z = tremor;
    }
    const head = getBone('head');
    if (head) {
        head.rotation.x = -0.05 + Math.sin(t * 13) * 0.006;
        head.rotation.y = Math.sin(t * 0.5) * 0.015;
        head.rotation.z = tremor * 0.6;
    }
    // Arms rigid at sides, slightly pushed forward — ready to argue
    setArmPose(
        'left',
        { x: 0.1 + clench, y: 0.06, z: -1.25 },
        { x: 0.05, y: 0, z: -0.12 },
        { x: clench, y: 0, z: 0.1 }
    );
    setArmPose(
        'right',
        { x: 0.1 + clench, y: -0.06, z: 1.25 },
        { x: 0.05, y: 0, z: 0.12 },
        { x: clench, y: 0, z: -0.1 }
    );

    setExpr('blink', updateBlink(dt) * 0.3);  // eyes wide open
    setExpr('angry', 0.8 + Math.sin(t * 2) * 0.1);
    setExpr('happy', 0);
}

// ─── BLUSH ANIMATION ──────────────────────────────────────────────────────────
// Hands come up toward cheeks, head tips down shyly, soft expressions
function doBlush(dt, t) {
    updateBreath(dt, 0.85);
    stopLip();

    const flutter = Math.sin(t * 3.0) * 0.03;
    const pulse   = (Math.sin(t * 1.5) * 0.5 + 0.5); // 0→1 pulse

    const head = getBone('head');
    if (head) {
        head.rotation.x =  0.18 + Math.sin(t * 0.4) * 0.01; // look down
        head.rotation.y = -0.06 + Math.sin(t * 0.25) * 0.01;
        head.rotation.z =  0.08;                              // slight tilt
    }
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.x = 0.10;
        neck.rotation.y = -0.04;
    }
    const spine = getBone('spine');
    if (spine) spine.rotation.x = 0.09;
    // Both hands raised toward face — covering-cheeks gesture
    setArmPose(
        'left',
        { x: -0.55 + flutter, y: 0.10, z: -0.80 },
        { x: -0.45 + flutter, y: 0, z: -0.15 },
        { x: 0.15, y: 0, z: 0.20 }
    );
    setArmPose(
        'right',
        { x: -0.55 + flutter, y: -0.10, z: 0.80 },
        { x: -0.45 + flutter, y: 0, z: 0.15 },
        { x: 0.15, y: 0, z: -0.20 }
    );

    setExpr('blink', updateBlink(dt) * 1.4);
    setExpr('happy', 0.55 + pulse * 0.2);
    setExpr('surprised', 0.15 + pulse * 0.1);
}

// ─── CLAPPING ANIMATION ───────────────────────────────────────────────────────
// Both arms swing toward centre in opposite phase — hands clap together
function doClapping(dt, t) {
    updateBreath(dt, 1.5);
    stopLip();

    // clap rhythm — snappy 4 Hz
    const clap   = Math.sin(t * Math.PI * 4);
    const bounce = Math.abs(Math.sin(t * Math.PI * 4)) * 0.03;

    const spine = getBone('spine');
    if (spine) {
        spine.rotation.x = 0.05 + bounce;
        spine.rotation.z = Math.sin(t * 2.5) * 0.008;
    }
    const head = getBone('head');
    if (head) {
        head.rotation.x = 0.04 + bounce;
        head.rotation.y = Math.sin(t * 0.6) * 0.03;
        head.rotation.z = Math.sin(t * 0.4) * 0.015;
    }
    // Arms swing horizontally — right goes left, left goes right on each beat
    const spread = 0.55 + clap * 0.25;   // upper arm spread
    const meet   = -0.55 - clap * 0.35;  // lower arm meets in front
    setArmPose(
        'left',
        { x: -0.30, y: -0.10 + clap * 0.08, z: -spread },
        { x: meet, y: 0, z: -0.05 },
        { x: 0.05, y: 0, z: 0.05 }
    );
    setArmPose(
        'right',
        { x: -0.30, y:  0.10 - clap * 0.08, z:  spread },
        { x: meet, y: 0, z:  0.05 },
        { x: 0.05, y: 0, z: -0.05 }
    );

    setExpr('blink', updateBlink(dt));
    setExpr('happy', 0.7 + Math.abs(clap) * 0.2);
    setExpr('surprised', 0.25);
}

// ─── GOODBYE / WAVE ANIMATION ─────────────────────────────────────────────────
// Right arm raised high, hand waves side-to-side, slight body lean
function doGoodbye(dt, t) {
    updateBreath(dt, 1.0);
    stopLip();

    // wave rhythm ~2 Hz
    const wave  = Math.sin(t * Math.PI * 2);
    const smile = 0.5 + Math.sin(t * 0.5) * 0.1;

    const spine = getBone('spine');
    if (spine) {
        spine.rotation.z = wave * 0.025;  // subtle body sway with wave
        spine.rotation.x = 0.04;
    }
    const head = getBone('head');
    if (head) {
        head.rotation.x = 0.04;
        head.rotation.y = wave * 0.04;
        head.rotation.z = wave * 0.012;
    }
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.y = wave * 0.03;
    }
    // Right arm raised — wave hand (z-rotation oscillates)
    setArmPose(
        'right',
        { x: -0.90, y: 0.05, z: 0.30 },
        { x: -0.20 + wave * 0.08, y: 0, z: 0.10 },
        { x: 0, y: 0, z: wave * 0.55 }  // hand waves
    );
    // Left arm relaxed at side
    setArmPose(
        'left',
        { x: 0.05, y: 0, z: -1.3 },
        { x: 0, y: 0, z: -0.1 },
        { x: 0, y: 0, z: 0.05 }
    );

    setExpr('blink', updateBlink(dt));
    setExpr('happy', smile);
}

// ─── JUMP ANIMATION ───────────────────────────────────────────────────────────
// Arms thrust up, spine arches back on apex, lands with a bounce
function doJump(dt, t) {
    // jump cycle: 0→takeoff→apex→land→settle, ~1.2 s period
    const cycle  = (t % 1.2) / 1.2;      // 0..1 within each jump
    const apex   = Math.sin(cycle * Math.PI); // 0→1→0 peak in middle
    const land   = Math.max(0, Math.sin(cycle * Math.PI * 2 - Math.PI)) * 0.6;

    const spine = getBone('spine');
    if (spine) {
        spine.rotation.x =  0.04 - apex * 0.12; // arch back at apex
        spine.rotation.z = Math.sin(t * 1.2) * 0.01;
    }
    const chest = getBone('chest');
    if (chest) chest.rotation.x = -0.02 - apex * 0.08;
    const neck = getBone('neck');
    if (neck)  neck.rotation.x  =  0.02 + apex * 0.04;
    const head = getBone('head');
    if (head) {
        head.rotation.x = 0.04 + apex * 0.06;  // look up slightly at apex
        head.rotation.z = Math.sin(t * 1.8) * 0.015;
    }
    // Arms thrust overhead at takeoff, flare out on landing
    const armRaise = apex;                // 0=down  1=overhead
    setArmPose(
        'left',
        { x: -armRaise * 1.2, y: 0.05, z: -(1.3 - armRaise * 0.7) },
        { x: -armRaise * 0.3, y: 0, z: -0.1 + land * 0.2 },
        { x: 0, y: 0, z: 0.05 }
    );
    setArmPose(
        'right',
        { x: -armRaise * 1.2, y: -0.05, z:  (1.3 - armRaise * 0.7) },
        { x: -armRaise * 0.3, y: 0, z:  0.1 - land * 0.2 },
        { x: 0, y: 0, z: -0.05 }
    );

    setExpr('blink', apex < 0.3 ? 1.0 : updateBlink(dt)); // squeeze on takeoff
    setExpr('happy', 0.6 + apex * 0.35);
    setExpr('surprised', apex * 0.5);
}

// ─── LOOK AROUND ANIMATION ────────────────────────────────────────────────────
// Head slowly scans left → right → up → down, curious body language
function doLookAround(dt, t) {
    updateBreath(dt, 0.9);
    stopLip();

    // 8-second full scan cycle: left(0-2s) → centre(2-3s) → right(3-5s) → centre(5-6s) → up(6-7s) → down(7-8s)
    const phase = (t % 8);
    let targetHeadY = 0, targetHeadX = 0.04;

    if (phase < 2.0)        { targetHeadY =  0.30; targetHeadX = 0.04; }      // look left
    else if (phase < 3.0)   { targetHeadY =  0.00; targetHeadX = 0.04; }      // centre
    else if (phase < 5.0)   { targetHeadY = -0.30; targetHeadX = 0.04; }      // look right
    else if (phase < 6.0)   { targetHeadY =  0.00; targetHeadX = 0.04; }      // centre
    else if (phase < 7.0)   { targetHeadY =  0.05; targetHeadX = -0.10; }     // look up
    else                    { targetHeadY =  0.05; targetHeadX =  0.18; }     // look down

    const head = getBone('head');
    if (head) {
        head.rotation.y = smoothLerp(head.rotation.y, targetHeadY, dt * 1.8);
        head.rotation.x = smoothLerp(head.rotation.x, targetHeadX, dt * 1.8);
        head.rotation.z = Math.sin(t * 0.4) * 0.01;
    }
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.y = smoothLerp(neck.rotation.y, targetHeadY * 0.4, dt * 1.5);
        neck.rotation.x = smoothLerp(neck.rotation.x, targetHeadX * 0.3, dt * 1.5);
    }
    const spine = getBone('spine');
    if (spine) {
        spine.rotation.x = 0.04;
        spine.rotation.z = Math.sin(t * 0.5) * 0.006;
        spine.rotation.y = targetHeadY * 0.08; // subtle body follow
    }
    setArmPose('left',  { x: 0.05, y: 0, z: -1.3 }, { x: 0, y: 0, z: -0.1 }, { x: 0, y: 0, z: 0.05 });
    setArmPose('right', { x: 0.05, y: 0, z:  1.3 }, { x: 0, y: 0, z:  0.1 }, { x: 0, y: 0, z: -0.05 });

    setExpr('blink', updateBlink(dt));
    setExpr('happy', 0.2);
}

// ─── RELAX ANIMATION ──────────────────────────────────────────────────────────
// Shoulders drop, spine eases back, slow deep breathing, eyes half-closed
function doRelax(dt, t) {
    updateBreath(dt, 0.5);  // very slow breath
    stopLip();

    const sway = Math.sin(t * 0.4) * 0.006;

    const spine = getBone('spine');
    if (spine) {
        spine.rotation.x = -0.02 + Math.sin(breathPhase * 0.8) * 0.01; // slight lean back
        spine.rotation.z = sway;
        spine.rotation.y = Math.sin(t * 0.25) * 0.005;
    }
    const chest = getBone('chest');
    if (chest) chest.rotation.x = -0.04;
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.x = -0.02;
        neck.rotation.z = sway * 0.6;
    }
    const head = getBone('head');
    if (head) {
        head.rotation.x = -0.02 + Math.sin(t * 0.3) * 0.01;
        head.rotation.y =  Math.sin(t * 0.28) * 0.018;
        head.rotation.z = sway;
    }
    // Arms hang loosely — slightly further out than idle, totally relaxed
    const droop = Math.sin(t * 0.5) * 0.01;
    setArmPose(
        'left',
        { x: 0.02, y: 0.02, z: -1.35 + droop },
        { x: 0.02, y: 0, z: -0.05 },
        { x: 0, y: 0, z: 0.03 }
    );
    setArmPose(
        'right',
        { x: 0.02, y: -0.02, z:  1.35 - droop },
        { x: 0.02, y: 0, z:  0.05 },
        { x: 0, y: 0, z: -0.03 }
    );

    // Half-closed relaxed eyes
    const blinkVal = updateBlink(dt);
    setExpr('blink', Math.max(blinkVal, 0.25));  // minimum 0.25 — droopy lids
    setExpr('relaxed', 0.6);
    setExpr('happy', 0.15);
}

// ─── SLEEPY ANIMATION ─────────────────────────────────────────────────────────
// Head droops, body slumps, yawns, very slow heavy blinks
let sleepyBlinkTimer = 0;
let sleepyBlinkPhase = 'open'; // 'open' | 'closing' | 'closed' | 'opening'
let sleepyBlinkProgress = 0;

function doSleepy(dt, t) {
    updateBreath(dt, 0.4);  // slow sleepy breathing
    stopLip();

    // heavy slow blink state machine
    sleepyBlinkTimer += dt;
    let droopVal = 0.55;  // base droop
    const blinkDuration = { closing: 0.4, closed: 0.6, opening: 0.6 };
    const blinkCycle = 4.5 + Math.random() * 2; // blink every ~4-6 s

    if (sleepyBlinkPhase === 'open') {
        droopVal = 0.50;
        if (sleepyBlinkTimer > blinkCycle) { sleepyBlinkPhase = 'closing'; sleepyBlinkTimer = 0; sleepyBlinkProgress = 0; }
    } else if (sleepyBlinkPhase === 'closing') {
        sleepyBlinkProgress += dt / blinkDuration.closing;
        droopVal = 0.50 + sleepyBlinkProgress * 0.50;
        if (sleepyBlinkProgress >= 1) { sleepyBlinkPhase = 'closed'; sleepyBlinkTimer = 0; }
    } else if (sleepyBlinkPhase === 'closed') {
        droopVal = 1.0;
        if (sleepyBlinkTimer > blinkDuration.closed) { sleepyBlinkPhase = 'opening'; sleepyBlinkTimer = 0; sleepyBlinkProgress = 0; }
    } else if (sleepyBlinkPhase === 'opening') {
        sleepyBlinkProgress += dt / blinkDuration.opening;
        droopVal = 1.0 - sleepyBlinkProgress * 0.50;  // only open half-way back
        if (sleepyBlinkProgress >= 1) { sleepyBlinkPhase = 'open'; sleepyBlinkTimer = 0; }
    }

    // Head slowly droops forward
    const nod = 0.18 + Math.sin(breathPhase * 0.4) * 0.06;  // rhythmic droop
    const sway = Math.sin(t * 0.2) * 0.015;

    const head = getBone('head');
    if (head) {
        head.rotation.x = nod;
        head.rotation.z = sway;
        head.rotation.y = Math.sin(t * 0.15) * 0.012;
    }
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.x = nod * 0.5;
        neck.rotation.z = sway * 0.5;
    }
    const spine = getBone('spine');
    if (spine) {
        spine.rotation.x = 0.08 + Math.sin(breathPhase * 0.4) * 0.01;
        spine.rotation.z = sway * 0.4;
    }
    const chest = getBone('chest');
    if (chest) chest.rotation.x = 0.04;

    // Arms hang heavier — slightly more forward
    setArmPose(
        'left',
        { x: 0.10, y: 0.02, z: -1.35 },
        { x: 0.08, y: 0, z: -0.08 },
        { x: 0.04, y: 0, z: 0.05 }
    );
    setArmPose(
        'right',
        { x: 0.10, y: -0.02, z:  1.35 },
        { x: 0.08, y: 0, z:  0.08 },
        { x: 0.04, y: 0, z: -0.05 }
    );

    setExpr('blink', droopVal);
    setExpr('relaxed', 0.8);
    setExpr('happy', 0);
}

// ─── SURPRISED ANIMATION ──────────────────────────────────────────────────────
// Spine jolts back, arms fly out, eyes wide, mouth open — sharp reaction
let surprisedTimer = 0;

function doSurprised(dt, t) {
    surprisedTimer += dt;
    const settle = Math.min(surprisedTimer / 0.6, 1.0); // 0.6 s to settle

    // On initial jolt — spine snaps back, then slowly recovers
    const jolt = (1 - settle) * 0.18;  // spine jolt decays
    const breathSpeed = 1.0 + (1 - settle) * 1.5;
    updateBreath(dt, breathSpeed);
    stopLip();

    const spine = getBone('spine');
    if (spine) {
        spine.rotation.x = -jolt + 0.03 + Math.sin(t * 1.5) * 0.008 * settle;
        spine.rotation.z = Math.sin(t * 8) * 0.012 * (1 - settle); // jitter fades
    }
    const chest = getBone('chest');
    if (chest) chest.rotation.x = -jolt * 0.6 - 0.02;
    const neck = getBone('neck');
    if (neck) {
        neck.rotation.x = -jolt * 0.5 + Math.sin(t * 7) * 0.008 * (1 - settle);
    }
    const head = getBone('head');
    if (head) {
        head.rotation.x = -jolt * 0.4 + Math.sin(t * 6) * 0.01 * (1 - settle);
        head.rotation.y = Math.sin(t * 0.5) * 0.02 * settle;
        head.rotation.z = Math.sin(t * 7) * 0.015 * (1 - settle);
    }
    // Arms fly out to sides on jolt then drift back
    const flyOut = (1 - settle) * 0.45;
    setArmPose(
        'left',
        { x: -flyOut * 0.5, y: 0.08 + flyOut * 0.1, z: -(1.3 - flyOut * 0.6) },
        { x: -flyOut * 0.3, y: 0, z: -0.1 },
        { x: 0, y: 0, z: 0.05 + flyOut * 0.2 }
    );
    setArmPose(
        'right',
        { x: -flyOut * 0.5, y: -(0.08 + flyOut * 0.1), z:  (1.3 - flyOut * 0.6) },
        { x: -flyOut * 0.3, y: 0, z:  0.1 },
        { x: 0, y: 0, z: -(0.05 + flyOut * 0.2) }
    );

    // Eyes wide open, mouth open — fades to normal
    setExpr('blink', 0);                                        // eyes wide
    setExpr('surprised', Math.max(0, 1.0 - settle * 0.5));
    setExpr('aa', Math.max(0, 0.7 - settle * 0.6));            // mouth drops open
    setExpr('happy', settle * 0.2);
}

// ─── CAMERA GENTLE DRIFT ──────────────────────────────────────────────────────
function updateCamera(dt, t, stateKey) {
    let targetOffset = new THREE.Vector3(0, 0, 0);

    switch (stateKey) {
        case 'excited':
        case 'clapping':
        case 'jump':
            targetOffset.set(Math.sin(t * 1.2) * 0.02, Math.sin(t * 0.9) * 0.01, 0);
            break;
        case 'shy':
        case 'blush':
            targetOffset.set(0.05, -0.03, 0.1); // pull back — give space
            break;
        case 'bot':
            targetOffset.set(Math.sin(t * 0.4) * 0.01, Math.sin(t * 0.3) * 0.008, 0);
            break;
        case 'angry':
            targetOffset.set(Math.sin(t * 3) * 0.006, 0, 0.05); // slightly further back
            break;
        case 'surprised':
            targetOffset.set(Math.sin(t * 2) * 0.015, Math.sin(t * 1.5) * 0.01, -0.03); // pull closer
            break;
        case 'relax':
        case 'sleepy':
            targetOffset.set(Math.sin(t * 0.15) * 0.006, Math.sin(t * 0.12) * 0.005, 0.04); // further, calm
            break;
        case 'goodbye':
            targetOffset.set(0, 0.04, 0.06); // pull back to see the wave
            break;
        default:
            targetOffset.set(Math.sin(t * 0.25) * 0.008, Math.sin(t * 0.2) * 0.006, 0);
    }

    camOffset.lerp(targetOffset, dt * 1.5);
    camera.position.copy(CAM_BASE).add(camOffset);
    camera.lookAt(CAM_TARGET);
}

// ─── MAIN ANIMATION LOOP ──────────────────────────────────────────────────────
(function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min((now - prevTime) / 1000, 0.05);
    prevTime = now;
    elapsedTime += dt;
    const t = elapsedTime;

    modelRoot.rotation.y = lerpAngle(modelRoot.rotation.y, targetYaw, Math.min(1, dt * 10));
    modelRoot.rotation.x = lerpAngle(modelRoot.rotation.x, targetPitch, Math.min(1, dt * 10));

    if (vrm && vrmVisible) {
        // Emotion override countdown
        if (emotionOverride) {
            emotionOverrideTimer -= dt;
            if (emotionOverrideTimer <= 0) {
                emotionOverride = null;
                // Return to current base state (VRMA or procedural)
                _applyState(animState);
            }
        }

        const activeState = emotionOverride || animState;

        // Tick the VRMA mixer every frame (safe even if no action playing)
        if (mixer) mixer.update(dt);

        // Only run procedural code for states NOT driven by VRMA
        if (!VRMA_STATES[activeState]) {
            switch (activeState) {
                case 'bot':      doBot(dt, t);      break;
                case 'user':     doUser(dt, t);     break;
                case 'excited':  doExcited(dt, t);  break;
                case 'laugh':    doLaugh(dt, t);    break;
                case 'shy':      doShy(dt, t);      break;
                case 'teasing':  doTeasing(dt, t);  break;
                default:         doIdle(dt, t);     break;
            }
        } else {
            // VRMA-driven: only run blink on top
            // Removed updateBreath(dt, 0.9) to prevent it from overriding the VRMA animation!
            updateBlink(dt);
            setExpr('blink', updateBlink(dt));
        }

        updateCamera(dt, t, activeState);

        vrm.expressionManager?.update();
        vrm.update(dt);
    }
    // Only render when visible — saves GPU when model is hidden
    if (vrmVisible || vrm === null) {
        renderer.render(scene, camera);
    }
})();

// ─── SHOW / HIDE ──────────────────────────────────────────────────────────────
function _show() {
    vrmVisible = true;
    vrm.scene.visible = true;
    shadowEl?.classList.remove('hidden');
}

window.vrmShow = () => {
    if (!vrm) { pendingShow = true; return; }
    _show();
};

window.vrmHide = () => {
    pendingShow = false;
    if (!vrm) return;
    vrmVisible = true;
    vrm.scene.visible = true;
    shadowEl?.classList.remove('hidden');
};

// ─── STATE SETTER ─────────────────────────────────────────────────────────────
/**
 * States (all hardcoded procedural — no VRMA files needed):
 * idle       – standing, gentle sway
 * bot        – speaking, lip sync, gestures
 * user       – listening, attentive nod
 * excited    – bouncy, arms up, wide eyes
 * laugh      – shaking laugh, squint eyes
 * shy        – head down-tilt, pulled in
 * sad        – hunched, sad expression
 * teasing    – coy head tilt, wink
 * thinking   – hand on chin, look away
 * angry      – leaning forward, tense, tremor
 * blush      – hands to cheeks, head down, rosy
 * clapping   – both arms clap in front rhythmically
 * goodbye    – right arm raised, hand waves
 * jump       – arms thrust up, arc body at apex
 * lookAround – head scans left/right/up/down
 * relax      – shoulders drop, slow breath, droopy eyes
 * sleepy     – head nods, slow heavy blinks
 * surprised  – spine jolt back, arms fly out, wide eyes
 */
// ─── INTERNAL STATE APPLIER ───────────────────────────────────────────────────
// Called on state entry and when emotion override expires
function _applyState(state) {
    if (VRMA_STATES[state]) {
        playVRMAState(state);
    } else {
        // Procedural state — fade out any active VRMA
        stopVRMA();
    }
}

window.vrmSetState = (state) => {
    if (animState !== state) {
        prevAnimState = animState;
    }
    animState = state;

    // Reset per-state timers on entry
    if (state === 'surprised') surprisedTimer = 0;
    if (state === 'sleepy')    { sleepyBlinkTimer = 0; sleepyBlinkPhase = 'open'; sleepyBlinkProgress = 0; }

    // Clear lingering expressions on state change
    if (state !== 'bot')      stopLip();
    if (state !== 'laugh')    { setExpr('blinkLeft', 0); setExpr('blinkRight', 0); }
    if (state !== 'sad')      setExpr('sad', 0);
    if (state !== 'shy')      setExpr('blushLevel', 0);
    if (state !== 'angry')    setExpr('angry', 0);
    if (state !== 'relax' && state !== 'sleepy') setExpr('relaxed', 0);
    if (!['excited', 'bot', 'jump', 'surprised'].includes(state)) setExpr('surprised', 0);

    // Start VRMA or switch to procedural
    _applyState(state);
};

/**
 * Trigger a temporary emotion override (auto-reverts after `duration` seconds).
 * Called from transcript keyword detection in chat.js.
 */
window.vrmTriggerEmotion = (emotion, duration = 3.0) => {
    emotionOverride = emotion;
    emotionOverrideTimer = duration;
    // Re-reset arm poses so each procedural emotion starts fresh
    if (vrm && !VRMA_STATES[emotion]) setIdlePose(vrm);
    // If this emotion has a VRMA, play it; otherwise stopVRMA for procedural
    _applyState(emotion);
};

// ─── KEYWORD → EMOTION DETECTOR ───────────────────────────────────────────────
// Call this from chat.js when assistant transcript arrives.
window.vrmDetectEmotion = (text) => {
    if (!text) return;
    const t = text.toLowerCase();

    // Laugh / funny
    if (/haha|lol|lmao|omg that's funny|stoppp|nooo|😂|😆/.test(t)) {
        window.vrmTriggerEmotion('laugh', 3.5);
    }
    // Excited / happy
    else if (/oh my god|wait really|that's so|amazing|love it|yay|excited|wow/.test(t)) {
        window.vrmTriggerEmotion('excited', 3.0);
    }
    // Clapping / applause
    else if (/clap|bravo|well done|great job|congrats|congratulations|👏/.test(t)) {
        window.vrmTriggerEmotion('clapping', 3.5);
    }
    // Jump / super excited
    else if (/yes!!|woohoo|let's go|finally|i can't believe/.test(t)) {
        window.vrmTriggerEmotion('jump', 2.5);
    }
    // Surprised
    else if (/what!|no way|seriously|are you kidding|omg|oh wow|😲|😮/.test(t)) {
        window.vrmTriggerEmotion('surprised', 3.0);
    }
    // Angry / frustrated
    else if (/that's not fair|ugh|so annoying|i'm angry|stop it|😤|😠/.test(t)) {
        window.vrmTriggerEmotion('angry', 3.5);
    }
    // Blush / flattery
    else if (/aww|that's sweet|you're so|blush|that made me smile|❤️|😊|you're cute/.test(t)) {
        window.vrmTriggerEmotion('blush', 4.0);
    }
    // Shy / flustered (lighter version)
    else if (/i don't know|maybe|um|i guess|nervous|😳/.test(t)) {
        window.vrmTriggerEmotion('shy', 3.5);
    }
    // Goodbye / farewell
    else if (/bye|goodbye|see you|take care|goodnight|talk later|👋/.test(t)) {
        window.vrmTriggerEmotion('goodbye', 4.0);
    }
    // Teasing
    else if (/noo|you're kidding|tease|playful|come on|😏|😜/.test(t)) {
        window.vrmTriggerEmotion('teasing', 3.5);
    }
    // Sad / comforting
    else if (/i'm sorry|that's sad|aww no|it's okay|i understand|😢|😔/.test(t)) {
        window.vrmTriggerEmotion('sad', 4.0);
    }
    // Sleepy / tired
    else if (/sleepy|tired|exhausted|yawn|i need sleep|goodnight|😴/.test(t)) {
        window.vrmTriggerEmotion('sleepy', 5.0);
    }
    // Relax / calm
    else if (/relax|chill|take it easy|calm down|breathe|it's fine|no worries/.test(t)) {
        window.vrmTriggerEmotion('relax', 4.5);
    }
    // Look around / curious
    else if (/where|looking for|i wonder|curious|let me see|what's that/.test(t)) {
        window.vrmTriggerEmotion('lookAround', 4.0);
    }
    // Thinking
    else if (/hmm|let me think|i wonder|actually|wait|well/.test(t)) {
        window.vrmTriggerEmotion('thinking', 2.5);
    }
};