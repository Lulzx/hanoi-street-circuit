import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ---------------------------------------------------------------- setup

const CARS = {
  barracuda: { file: 'assets/barracuda.glb', name: '1970 Plymouth Barracuda 440-6', length: 4.73, topSpeed: 68, accel: 13.5, grip: 1.0,  turn: 1.0  },
  hemicuda:  { file: 'assets/hemicuda.glb',  name: "1971 Plymouth HEMI 'Cuda",      length: 4.71, topSpeed: 72, accel: 15.0, grip: 0.92, turn: 0.95 },
  mustang:   { file: 'assets/mustang.glb',   name: '1965 Ford Mustang Shelby GT350', length: 4.64, topSpeed: 63, accel: 12.0, grip: 1.12, turn: 1.15 },
  chiron:    { file: 'assets/chiron.glb',    name: '2022 Bugatti Chiron Super Sport', length: 4.77, topSpeed: 105, accel: 22.0, grip: 1.35, turn: 1.05 },
};
const AI_COLORS = ['#2f6fe4', '#f2b722', '#3fae4c'];
const LAPS = 3;
const DEG = Math.PI / 180;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
const MAX_RATIO = Math.min(devicePixelRatio, 1.5);
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(MAX_RATIO);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.88;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xa5c6e8, 0.00019);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 7000);

// blue gradient sky (the physical Sky shader stays washed-out near the
// horizon, which is most of what a chase cam sees)
const SUN_DIR = new THREE.Vector3(0.45, 0.42, 0.28).normalize();
{
  const W = 2048, H = 1024;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0.0, '#0f52d9');   // deep zenith blue
  grad.addColorStop(0.2, '#2470e8');
  grad.addColorStop(0.36, '#4a95f2');
  grad.addColorStop(0.455, '#8ec8fa'); // vivid sky blue down low
  grad.addColorStop(0.495, '#d6ecfc'); // thin haze right at the horizon
  grad.addColorStop(0.52, '#b9cddd');
  grad.addColorStop(1.0, '#8d9aa6');   // below horizon
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  // cumulus: clusters of soft white blobs, bigger and denser near the horizon
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 46; i++) {
    const cx = rnd() * W;
    const band = rnd();                       // 0 = high in the sky, 1 = at horizon
    const cy = H * (0.16 + band * 0.30);
    const scale = 18 + band * 55 + rnd() * 25;
    const puffs = 6 + Math.floor(rnd() * 9);
    const alpha = 0.10 + rnd() * 0.16;
    for (let p = 0; p < puffs; p++) {
      const px = cx + (rnd() - 0.5) * scale * 4.2;
      const py = cy + (rnd() - 0.5) * scale * 1.1;
      const pr = scale * (0.55 + rnd() * 0.8);
      const rg = g.createRadialGradient(px, py, 0, px, py, pr);
      rg.addColorStop(0, `rgba(255,255,255,${alpha})`);
      rg.addColorStop(0.65, `rgba(252,253,255,${alpha * 0.55})`);
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg;
      g.beginPath();
      g.ellipse(px, py, pr * 1.6, pr * 0.62, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  // thin cirrus streaks up high
  for (let i = 0; i < 14; i++) {
    const cx = rnd() * W, cy = H * (0.06 + rnd() * 0.14);
    const len = 90 + rnd() * 260, a = 0.05 + rnd() * 0.07;
    const rg = g.createRadialGradient(cx, cy, 0, cx, cy, len);
    rg.addColorStop(0, `rgba(255,255,255,${a})`);
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.beginPath();
    g.ellipse(cx, cy, len, len * 0.10, (rnd() - 0.5) * 0.25, 0, Math.PI * 2);
    g.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
  scene.backgroundIntensity = 1.2;
}

{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(1000);
  envSky.material.uniforms.turbidity.value = 2.5;
  envSky.material.uniforms.rayleigh.value = 1.5;
  envSky.material.uniforms.mieCoefficient.value = 0.003;
  envSky.material.uniforms.mieDirectionalG.value = 0.8;
  envSky.material.uniforms.sunPosition.value.copy(SUN_DIR);
  envScene.add(envSky);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
}

const hemi = new THREE.HemisphereLight(0xbfd6f0, 0x5a564c, 0.55);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d8, 3.0);
sun.position.copy(SUN_DIR).multiplyScalar(700);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 50;
sun.shadow.camera.far = 2000;
sun.shadow.camera.left = sun.shadow.camera.bottom = -150;
sun.shadow.camera.right = sun.shadow.camera.top = 150;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

// post: GTAO grounds the car and barriers, bloom lifts sun glints and lights,
// radial speed blur sells velocity
const composer = new EffectComposer(renderer);
composer.setPixelRatio(MAX_RATIO);
composer.addPass(new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
gtao.output = GTAOPass.OUTPUT.Default;
gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1, thickness: 1, scale: 1.2, samples: 8, distanceFallOff: 1, screenSpaceRadius: false });
gtao.blendIntensity = 0.9;
composer.addPass(gtao);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.22, 0.4, 0.9);
composer.addPass(bloom);

// radial motion blur, centred slightly above screen centre (the horizon the
// car rushes toward); strength driven by speed each frame
const speedBlur = new ShaderPass({
  name: 'SpeedBlurShader',
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0.0 },
    center: { value: new THREE.Vector2(0.5, 0.42) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform vec2 center;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - center;
      float dist = length(dir);
      // keep the car (screen centre) sharp, blur the periphery
      float falloff = smoothstep(0.10, 0.62, dist);
      float amt = strength * falloff;
      vec4 col = texture2D(tDiffuse, vUv);
      if (amt > 0.0005) {
        vec4 sum = col;
        vec2 stepv = dir * amt;
        sum += texture2D(tDiffuse, vUv - stepv * 0.25);
        sum += texture2D(tDiffuse, vUv - stepv * 0.50);
        sum += texture2D(tDiffuse, vUv - stepv * 0.75);
        sum += texture2D(tDiffuse, vUv - stepv * 1.00);
        sum += texture2D(tDiffuse, vUv - stepv * 1.35);
        sum += texture2D(tDiffuse, vUv - stepv * 1.70);
        col = sum / 7.0;
      }
      gl_FragColor = col;
    }`,
});
composer.addPass(speedBlur);
composer.addPass(new OutputPass());

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// adaptive quality: watch the frame-time average and trade pixel ratio /
// GTAO for a stable frame rate, stepping back up when there is headroom
const perf = { acc: 0, n: 0, ratio: MAX_RATIO, cooldown: 0 };
function perfTick(dt) {
  perf.acc += dt; perf.n++;
  if (perf.n < 50) return;
  const avg = perf.acc / perf.n;
  perf.acc = 0; perf.n = 0;
  if (perf.cooldown > 0) { perf.cooldown--; return; }
  if (avg > 0.022) {
    if (perf.ratio > 0.8) {
      perf.ratio = Math.max(0.8, perf.ratio - 0.2);
      renderer.setPixelRatio(perf.ratio);
      composer.setPixelRatio(perf.ratio);
      composer.setSize(innerWidth, innerHeight);
    } else if (gtao.enabled) {
      gtao.enabled = false;
    }
    perf.cooldown = 2;
  } else if (avg < 0.014) {
    if (!gtao.enabled) gtao.enabled = true;
    else if (perf.ratio < MAX_RATIO) {
      perf.ratio = Math.min(MAX_RATIO, perf.ratio + 0.2);
      renderer.setPixelRatio(perf.ratio);
      composer.setPixelRatio(perf.ratio);
      composer.setSize(innerWidth, innerHeight);
    }
    perf.cooldown = 4;
  }
}

// ---------------------------------------------------------------- input

const keys = {};
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'KeyR') { if (mode === 'race' && race.phase) restartRace(); else resetCar(); }
  if (e.code === 'KeyC') camMode = (camMode + 1) % 3;
  if (e.code === 'KeyM') engineAudio.toggle();
  if (e.code === 'Escape') backToMenu();
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', e => { keys[e.code] = false; });
const kd = c => !!keys[c];

// ---------------------------------------------------------------- loading

const overlay = document.getElementById('overlay');
const carsEl = document.getElementById('cars');
const modesEl = document.getElementById('modes');
const modeDescEl = document.getElementById('modedesc');
const loadingEl = document.getElementById('loading');
const loadmsg = document.getElementById('loadmsg');
const loadbar = document.querySelector('#loadbar i');
const hud = document.getElementById('hud');

let mode = 'race';
modesEl.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  mode = btn.dataset.mode;
  for (const b of modesEl.children) b.classList.toggle('active', b === btn);
  modeDescEl.textContent = mode === 'race'
    ? '3 laps against 3 rivals — grid start, live standings'
    : 'No rules, no rivals — just you and the streets of Hanoi';
});

const loader = new GLTFLoader();
let track = null;          // THREE.Group
let trackMeshes = [];      // meshes with BVH for raycasting
let spawn = { pos: new THREE.Vector3(0, 50, 0), yaw: 0 };
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const DOWN = new THREE.Vector3(0, -1, 0);

function setProgress(f, msg) {
  loadbar.style.width = `${Math.round(f * 100)}%`;
  if (msg) loadmsg.textContent = msg;
}

function loadGLB(url, onProgress) {
  return new Promise((res, rej) => loader.load(url, res, ev => onProgress?.(ev), rej));
}

const MB = v => Math.max(1, Math.round(v / 1048576));

async function loadTrack() {
  const gltf = await loadGLB('assets/track.glb', ev => {
    const total = ev.total || 50267480; // slow links must see the bar move
    setProgress(Math.min(1, ev.loaded / total) * 0.6,
      `Loading Hanoi Street Circuit… ${MB(ev.loaded)} / ${MB(total)} MB`);
  });
  setProgress(0.62, 'Building collision data…');
  await new Promise(r => setTimeout(r, 30)); // let the UI paint
  track = gltf.scene;
  track.traverse(o => {
    if (o.isMesh) {
      o.geometry.computeBoundsTree();
      o.receiveShadow = true;
      if (o.material) {
        o.material.side = THREE.DoubleSide;
        o.material.envMapIntensity = 0.3; // textures are baked, keep IBL subtle
        if (o.material.map) o.material.map.anisotropy = 8;
      }
      trackMeshes.push(o);
    }
  });
  fixAlphaMaterials();
  scene.add(track);
  track.updateMatrixWorld(true);
  findSpawn();
  setProgress(0.68, 'Mapping the racing line…');
  await new Promise(r => setTimeout(r, 20));
  await buildRacingLine();
  setProgress(0.8);
}

// the exporter dropped every alphaMode, so foliage/fence cutout textures
// render as black cards; detect alpha in the texture pixels and re-enable it
function fixAlphaMaterials() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const cx = canvas.getContext('2d', { willReadFrequently: true });
  const seen = new Set();
  for (const mesh of trackMeshes) {
    const mat = mesh.material;
    if (!mat || seen.has(mat)) continue;
    seen.add(mat);
    const img = mat.map?.image;
    if (!img) continue;
    try {
      cx.clearRect(0, 0, 64, 64);
      cx.drawImage(img, 0, 0, 64, 64);
      const data = cx.getImageData(0, 0, 64, 64).data;
      let clear = 0, maxA = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 128) clear++;
        if (data[i] > maxA) maxA = data[i];
      }
      if (maxA < 250) {
        // nothing in the texture is opaque — tinted glass, blend it
        mat.transparent = true;
        mat.depthWrite = false;
        mat.needsUpdate = true;
      } else if (clear > 64 * 64 * 0.02) {
        mat.alphaTest = 0.45;
        mat.transparent = false;
        mat.needsUpdate = true;
      }
    } catch { /* texture not drawable — leave it */ }
  }
}

// scan outward from the origin for a spot whose surface is road, then face
// along the direction the road extends furthest
function groundHit(x, z, fromY = 400) {
  raycaster.set(new THREE.Vector3(x, fromY, z), DOWN);
  raycaster.far = 2000;
  const hits = raycaster.intersectObjects(trackMeshes, false);
  return hits[0] || null;
}
// the actual racing surface (street circuit asphalt), by texture
const isRacingSurface = hit => {
  const t = (hit?.object?.material?.map?.name || '').toLowerCase();
  return /asfalto|tarmac|asphalt|road_liso/.test(t);
};
// anything paved enough to grip on
const isRoad = hit => {
  if (isRacingSurface(hit)) return true;
  const n = (hit?.object?.material?.name || '').toLowerCase();
  return n.startsWith('road') || n.includes('tarmac') || n.includes('asfalt') || n.includes('asphalt');
};

// start on the pit straight of the street circuit (found offline from the
// model: road surface nearest the pit buildings)
const PIT_STRAIGHT = new THREE.Vector3(-399.7, 0, -259.7);

function findSpawn() {
  let best = groundHit(PIT_STRAIGHT.x, PIT_STRAIGHT.z);
  if (!best || !isRacingSurface(best)) {
    // fallback: spiral out from the pit straight for racing asphalt
    outer:
    for (let r = 10; r <= 1500; r += 25) {
      const steps = Math.max(8, Math.floor(r / 12));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const h = groundHit(PIT_STRAIGHT.x + Math.cos(a) * r, PIT_STRAIGHT.z + Math.sin(a) * r);
        if (h && isRacingSurface(h)) { best = h; break outer; }
      }
    }
  }
  if (!best) { best = groundHit(0, 0) || { point: new THREE.Vector3(0, 0, 0) }; }
  let p = best.point.clone();
  let yaw = scanHeading(p);
  let c = centerOnRoad(p, yaw);
  // we may have landed on the pit lane: look sideways for a wider ribbon of
  // asphalt (the actual track) and take it if we find one
  const perp = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  for (const s of [1, -1]) {
    for (let t = c.half[s > 0 ? 0 : 1] + 2; t <= 45; t += 1.5) {
      const h = groundHit(c.point.x + perp.x * t * s, c.point.z + perp.z * t * s, c.point.y + 6);
      if (h && isRacingSurface(h) && Math.abs(h.point.y - c.point.y) < 3) {
        const c2 = centerOnRoad(h.point, yaw);
        if (c2.width > c.width + 2) c = c2;
        break;
      }
    }
  }
  p = c.point;
  yaw = refineHeading(p, scanHeading(p));
  spawn.pos.copy(p).y += 0.5;
  spawn.yaw = yaw;
}

// fine pass: within ±12° of the coarse heading, pick the direction that stays
// on asphalt the furthest (long straights need better than 11° accuracy)
function refineHeading(p, coarse) {
  let bestYaw = coarse, bestLen = -1;
  for (let off = -12; off <= 12; off += 1.5) {
    const yaw = coarse + off * Math.PI / 180;
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    let len = 0;
    for (let d = 10; d <= 500; d += 10) {
      const h = groundHit(p.x + dx * d, p.z + dz * d, p.y + 40);
      if (h && isRacingSurface(h) && Math.abs(h.point.y - p.y) < 25) len = d; else break;
    }
    if (len > bestLen || (len === bestLen && Math.abs(off) < Math.abs((bestYaw - coarse) * 180 / Math.PI))) {
      bestLen = len; bestYaw = yaw;
    }
  }
  return bestYaw;
}

// heading along which the racing surface keeps going the longest
function scanHeading(p) {
  let bestYaw = 0, bestLen = -1;
  for (let i = 0; i < 32; i++) {
    const yaw = (i / 32) * Math.PI * 2;
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    let len = 0;
    for (let d = 6; d <= 220; d += 6) {
      const h = groundHit(p.x + dx * d, p.z + dz * d, p.y + 30);
      if (h && isRacingSurface(h) && Math.abs(h.point.y - p.y) < 15) len = d; else break;
    }
    if (len > bestLen) { bestLen = len; bestYaw = yaw; }
  }
  return bestYaw;
}

// slide sideways to sit midway between the road edges
function centerOnRoad(p, yaw) {
  const px = Math.cos(yaw), pz = -Math.sin(yaw); // perpendicular to heading
  const extent = sign => {
    let e = 0;
    for (let t = 0.75; t <= 18; t += 0.75) {
      const h = groundHit(p.x + px * t * sign, p.z + pz * t * sign, p.y + 5);
      if (h && isRacingSurface(h) && Math.abs(h.point.y - p.y) < 2) e = t; else break;
    }
    return e;
  };
  const r = extent(1), l = extent(-1);
  const off = (r - l) / 2;
  const q = p.clone();
  q.x += px * off; q.z += pz * off;
  const h = groundHit(q.x, q.z, p.y + 5);
  if (h) q.y = h.point.y;
  return { point: q, width: r + l, half: [r, l] };
}

// ---------------------------------------------------------------- racing line

// march along the racing surface from the spawn, centring on the road each
// step, until the loop closes; the result drives the AI, laps and minimap
let wayPts = [];           // [{x, y, z, w}]
let wpSpeeds = null;       // Float32Array of corner-limited speeds (m/s)
let lineClosed = false;
const WP_STEP = 7;

async function buildRacingLine() {
  wayPts = [];
  lineClosed = false;
  const p = spawn.pos.clone();
  let yaw = spawn.yaw;
  for (let i = 0; i < 2600; i++) {
    // candidate headings: pick the offset that keeps the most lookahead on
    // asphalt, preferring to go straight
    let bestOff = 0, bestScore = -1;
    for (let off = -35; off <= 35; off += 5) {
      const y2 = yaw + off * DEG;
      const dx = Math.sin(y2), dz = Math.cos(y2);
      let score = 0;
      for (const d of [WP_STEP, WP_STEP * 2, WP_STEP * 3.5]) {
        const h = groundHit(p.x + dx * d, p.z + dz * d, p.y + 15);
        if (h && isRacingSurface(h) && Math.abs(h.point.y - p.y) < 8) score += 1; else break;
      }
      score -= Math.abs(off) * 0.012;
      if (score > bestScore) { bestScore = score; bestOff = off; }
    }
    if (bestScore < 0.9) break; // dead end
    yaw += bestOff * DEG;
    p.x += Math.sin(yaw) * WP_STEP;
    p.z += Math.cos(yaw) * WP_STEP;
    const c = centerOnRoad(p, yaw);
    if (c.width > 3) p.copy(c.point);
    wayPts.push({ x: p.x, y: p.y, z: p.z, w: Math.max(c.width, 6) });
    if (i > 60) {
      const dx = p.x - spawn.pos.x, dz = p.z - spawn.pos.z;
      if (dx * dx + dz * dz < (WP_STEP * 1.8) ** 2) { lineClosed = true; break; }
    }
    if (i % 120 === 0) {
      setProgress(0.68 + Math.min(1, i / 1400) * 0.1);
      await new Promise(r => setTimeout(r));
    }
  }
  if (wayPts.length > 50) wpSpeeds = computeCornerSpeeds(wayPts);
  else wayPts = []; // too short to be useful — race mode falls back gracefully
}

// corner-limited target speed per waypoint plus a backward braking pass so
// the AI slows *before* the corner, not in it
function computeCornerSpeeds(pts) {
  const n = pts.length;
  const sp = new Float32Array(n);
  const A_LAT = 15, A_BRK = 15, VMAX = 88;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 2 + n) % n], b = pts[i], c = pts[(i + 2) % n];
    const v1x = b.x - a.x, v1z = b.z - a.z, v2x = c.x - b.x, v2z = c.z - b.z;
    const l1 = Math.hypot(v1x, v1z) || 1e-4, l2 = Math.hypot(v2x, v2z) || 1e-4;
    const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1z * v2z) / (l1 * l2)));
    const curv = Math.acos(cos) / ((l1 + l2) / 2);
    sp[i] = Math.min(VMAX, Math.sqrt(A_LAT / Math.max(curv, 1e-4)));
  }
  for (let pass = 0; pass < 2; pass++)
    for (let i = n - 1; i >= 0; i--) {
      const next = sp[(i + 1) % n];
      sp[i] = Math.min(sp[i], Math.sqrt(next * next + 2 * A_BRK * WP_STEP));
    }
  return sp;
}

const distXZ2 = (p, w) => { const dx = p.x - w.x, dz = p.z - w.z; return dx * dx + dz * dz; };

function nearestWpIdx(pos) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < wayPts.length; i++) {
    const d = distXZ2(pos, wayPts[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// advance a {idx, lap} tracker toward the nearest forward waypoint
function trackProgress(tr, pos) {
  const n = wayPts.length;
  for (let k = 0; k < 8; k++) {
    const j = (tr.idx + 1) % n;
    if (distXZ2(pos, wayPts[j]) < distXZ2(pos, wayPts[tr.idx])) {
      tr.idx = j;
      if (j === 0) { tr.lap++; tr.wrapped = true; }
    } else break;
  }
}

// ---------------------------------------------------------------- car models

const carTemplates = {};   // key -> prepared, normalised model ready to clone

async function getCarTemplate(key, onProgress) {
  if (carTemplates[key]) return carTemplates[key];
  const spec = CARS[key];
  const gltf = await loadGLB(spec.file, onProgress);
  const model = gltf.scene;
  model.traverse(o => {
    if (o.isMesh) {
      o.castShadow = true;
      if (o.material) {
        o.material.envMapIntensity = 1.3;
        if (o.material.transmission > 0) o.material.transparent = true;
      }
    }
  });
  // normalise scale (models ship at arbitrary units) so length ≈ real car length
  let box = new THREE.Box3().setFromObject(model);
  let size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  model.scale.multiplyScalar(spec.length / maxDim);
  // bottom at y=0, centred in x/z
  box = new THREE.Box3().setFromObject(model);
  const c = box.getCenter(new THREE.Vector3());
  model.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));
  carTemplates[key] = model;
  return model;
}

function instantiateCar(key) {
  const model = carTemplates[key].clone(true);
  const group = new THREE.Group();
  group.add(model);
  return { group, model, wheels: classifyWheels(model) };
}

// repaint the body: find the paint material (by name, else the material
// covering the most geometry) and swap in a tinted clone
function tintCar(model, colorHex) {
  const scores = new Map();
  model.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const m = o.material;
    const n = `${m.name || ''} ${o.name}`.toLowerCase();
    if (/glass|window|windshield|tyre|tire|wheel|rim|chrome|light|lamp|interior|mirror|grille|trim|plate/.test(n)) return;
    const count = o.geometry.attributes.position?.count || 0;
    const boost = /paint|body|carroceria|shell|exterior|main/.test(n) ? 12 : 1;
    scores.set(m, (scores.get(m) || 0) + count * boost);
  });
  let best = null, bestScore = -1;
  for (const [m, s] of scores) if (s > bestScore) { bestScore = s; best = m; }
  if (!best) return;
  const tinted = best.clone();
  tinted.color = new THREE.Color(colorHex);
  model.traverse(o => { if (o.isMesh && o.material === best) o.material = tinted; });
}

// wrap `node` in a Group whose origin sits at the node's visual centre, so we
// can rotate around the hub no matter where the model put the node's pivot
function wrapPivot(node) {
  const parent = node.parent;
  const box = new THREE.Box3().setFromObject(node);
  if (box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  parent.updateWorldMatrix(true, false);
  const pivot = new THREE.Group();
  parent.add(pivot);
  pivot.position.copy(parent.worldToLocal(center));
  pivot.updateMatrixWorld(true);
  pivot.attach(node);
  return pivot;
}

// direction `worldDir` expressed in `obj`'s local space
function localAxis(obj, worldDir) {
  const q = obj.getWorldQuaternion(new THREE.Quaternion()).invert();
  return worldDir.clone().applyQuaternion(q).normalize();
}

function classifyWheels(root) {
  const wh = { spin: [], steer: [] };
  root.updateMatrixWorld(true);
  const found = [];
  const seen = new Set();
  root.traverse(o => {
    const n = o.name.toLowerCase();
    if (!/wheel/.test(n) || /steering|interior/.test(n)) return;
    // take the highest-level wheel nodes only
    let p = o.parent;
    while (p && p !== root) { if (seen.has(p)) return; p = p.parent; }
    // a node spanning most of the car's width is a container of several
    // wheels (e.g. the Chiron's Wheel1A_3D_00) — descend into it instead
    const box = new THREE.Box3().setFromObject(o);
    if (!box.isEmpty() && box.max.x - box.min.x > 1.2) return;
    seen.add(o);
    found.push({ node: o, front: /(^|[^a-z])(lf|rf)|front/.test(n) });
  });
  for (const { node, front } of found) {
    const spinPivot = wrapPivot(node);
    if (!spinPivot) continue;
    // car model faces +Z, so the axle runs along world X (car group is
    // untransformed at load time)
    wh.spin.push({ pivot: spinPivot, axis: localAxis(spinPivot, new THREE.Vector3(1, 0, 0)), angle: 0 });
    if (front) {
      const steerPivot = wrapPivot(spinPivot);
      if (steerPivot) wh.steer.push({ pivot: steerPivot, axis: localAxis(steerPivot, new THREE.Vector3(0, 1, 0)) });
    }
  }
  return wh;
}

// ---------------------------------------------------------------- player car

let car = null;            // group we move around
let carSpec = null;
let playerWheels = { spin: [], steer: [] };
const state = {
  vel: new THREE.Vector3(),
  yaw: 0,
  vy: 0,
  grounded: false,
  onRoad: true,
  steer: 0,
};

async function loadPlayerCar(key) {
  carSpec = CARS[key];
  await getCarTemplate(key, ev => {
    const total = ev.total || 14000000;
    setProgress(0.8 + Math.min(1, ev.loaded / total) * 0.1,
      `Rolling out the ${carSpec.name}… ${MB(ev.loaded)} / ${MB(total)} MB`);
  });
  const inst = instantiateCar(key);
  car = inst.group;
  playerWheels = inst.wheels;
  scene.add(car);
  document.getElementById('carname').textContent = carSpec.name;
  speedo.buildDial(carSpec.topSpeed * 3.6);
}

// grid slot k (0 = pole); two columns, staggered rows behind the start line
function gridSlot(k) {
  const back = 6 + k * 8;
  const side = (k % 2 === 0 ? -1 : 1) * 2.1;
  const sin = Math.sin(spawn.yaw), cos = Math.cos(spawn.yaw);
  const x = spawn.pos.x - sin * back + cos * side;
  const z = spawn.pos.z - cos * back - sin * side;
  const h = groundHit(x, z, spawn.pos.y + 10);
  return new THREE.Vector3(x, (h ? h.point.y : spawn.pos.y) + 0.4, z);
}

function placePlayer(pos, yaw) {
  state.vel.set(0, 0, 0);
  state.vy = 0;
  state.steer = 0;
  state.yaw = yaw;
  car.position.copy(pos);
  car.quaternion.setFromEuler(new THREE.Euler(0, yaw, 0));
  camInit = false;
}

function resetCar() {
  if (!car) return;
  if (mode === 'race' && race.phase && wayPts.length) {
    // drop back onto the racing line at the last waypoint reached
    const wp = wayPts[race.player.idx];
    const nxt = wayPts[(race.player.idx + 1) % wayPts.length];
    placePlayer(new THREE.Vector3(wp.x, wp.y + 0.4, wp.z), Math.atan2(nxt.x - wp.x, nxt.z - wp.z));
  } else {
    placePlayer(spawn.pos, spawn.yaw);
  }
}

function backToMenu() {
  if (!car) return;
  scene.remove(car);
  car = null;
  teardownRace();
  engineAudio.setRunning(false);
  hud.style.display = 'none';
  loadingEl.style.display = 'none';
  carsEl.style.display = 'flex';
  modesEl.style.display = 'flex';
  modeDescEl.style.display = 'block';
  overlay.classList.remove('hidden');
}

// ---------------------------------------------------------------- AI cars

class AICar {
  constructor(inst, spec, startIdx, skill, latOffset, color) {
    this.group = inst.group;
    this.wheels = inst.wheels;
    this.spec = spec;
    this.idx = startIdx;
    this.lap = -1;               // becomes 0 crossing the line at the start
    this.speed = 0;
    this.yaw = spawn.yaw;
    this.steer = 0;
    this.skill = skill;
    this.latOffset = latOffset;
    this.color = color;
    this.wheelAngle = 0;
  }

  update(dt, locked) {
    const n = wayPts.length;
    const pos = this.group.position;
    // advance along the line
    for (let k = 0; k < 6; k++) {
      const j = (this.idx + 1) % n;
      if (distXZ2(pos, wayPts[j]) < distXZ2(pos, wayPts[this.idx])) {
        this.idx = j;
        if (j === 0) this.lap++;
      } else break;
    }
    // steer toward a speed-scaled lookahead point, nudged sideways so the
    // pack doesn't stack on one line
    const lookN = 2 + Math.floor(this.speed / 9);
    const t1 = wayPts[(this.idx + lookN) % n];
    const t2 = wayPts[(this.idx + lookN + 1) % n];
    let hx = t2.x - t1.x, hz = t2.z - t1.z;
    const hl = Math.hypot(hx, hz) || 1;
    const off = this.latOffset * Math.min(1, (t1.w - 5) / 8);
    const tx = t1.x + (hz / hl) * off;
    const tz = t1.z + (-hx / hl) * off;
    const desired = Math.atan2(tx - pos.x, tz - pos.z);
    let err = desired - this.yaw;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const maxTurn = (1.5 + 1.2 / (1 + this.speed * 0.06)) * dt;
    this.yaw += THREE.MathUtils.clamp(err, -maxTurn, maxTurn);
    this.steer += (THREE.MathUtils.clamp(err * 2, -1, 1) - this.steer) * Math.min(1, dt * 6);
    // speed control: corner-limited target, scaled by driver skill
    let target = locked ? 0 : Math.min(wpSpeeds[this.idx] * this.skill, this.spec.topSpeed * 0.97);
    target *= 1 - Math.min(0.6, Math.abs(err) * 0.8);
    if (target > this.speed) this.speed = Math.min(target, this.speed + this.spec.accel * 0.9 * dt);
    else this.speed = Math.max(target, this.speed - 22 * dt);
    pos.x += Math.sin(this.yaw) * this.speed * dt;
    pos.z += Math.cos(this.yaw) * this.speed * dt;
    // ride the road height recorded in the waypoints
    pos.y += (wayPts[this.idx].y - pos.y) * Math.min(1, dt * 8);
    this.group.quaternion.setFromEuler(aiEuler.set(0, this.yaw, 0));
    this.wheelAngle += this.speed / 0.34 * dt;
    for (const w of this.wheels.spin) w.pivot.quaternion.setFromAxisAngle(w.axis, this.wheelAngle);
    for (const s of this.wheels.steer) s.pivot.quaternion.setFromAxisAngle(s.axis, this.steer * 0.4);
  }

  get progress() { return this.lap * wayPts.length + this.idx; }
}
const aiEuler = new THREE.Euler();

// ---------------------------------------------------------------- race

const race = {
  phase: null,               // null | 'countdown' | 'racing' | 'finished'
  t: 0,
  raceTime: 0,
  lapTime: 0,
  lastLap: null,
  bestLap: null,
  ais: [],
  player: { idx: 0, lap: -1, wrapped: false },
  finishPos: 0,
  position: 4,
};

const rpEls = {
  panel: document.getElementById('racepanel'),
  pos: document.getElementById('rp-pos'),
  lap: document.getElementById('rp-lap'),
  time: document.getElementById('rp-time'),
  last: document.getElementById('rp-last'),
  best: document.getElementById('rp-best'),
};
const msgEl = document.getElementById('msg');
let msgTimer = null;
function showMsg(html, holdMs) {
  msgEl.innerHTML = html;
  msgEl.classList.add('show');
  clearTimeout(msgTimer);
  if (holdMs) msgTimer = setTimeout(() => msgEl.classList.remove('show'), holdMs);
}
function hideMsg() { clearTimeout(msgTimer); msgEl.classList.remove('show'); }

function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
}

async function setupRace(playerKey) {
  const rivalKeys = Object.keys(CARS).filter(k => k !== playerKey).slice(0, 3);
  let done = 0;
  for (const k of rivalKeys) {
    await getCarTemplate(k, ev => {
      const total = ev.total || 14000000;
      setProgress(0.9 + (done + Math.min(1, ev.loaded / total)) / rivalKeys.length * 0.1,
        `Rivals arriving… ${CARS[k].name}`);
    });
    done++;
  }
  const skills = [0.99, 0.93, 0.87];
  const latOffs = [-1.8, 1.6, 0];
  race.ais = rivalKeys.map((k, i) => {
    const inst = instantiateCar(k);
    tintCar(inst.model, AI_COLORS[i]);
    const ai = new AICar(inst, CARS[k], 0, skills[i], latOffs[i], AI_COLORS[i]);
    scene.add(ai.group);
    return ai;
  });
  startGrid();
}

function startGrid() {
  // AI take slots 0-2, player starts from the back — earn it
  race.ais.forEach((ai, i) => {
    const slot = gridSlot(i);
    ai.group.position.copy(slot);
    ai.yaw = spawn.yaw;
    ai.speed = 0;
    ai.idx = nearestWpIdx(slot);
    ai.lap = -1;
    ai.group.quaternion.setFromEuler(aiEuler.set(0, spawn.yaw, 0));
  });
  const pSlot = gridSlot(3);
  placePlayer(pSlot, spawn.yaw);
  race.player = { idx: nearestWpIdx(pSlot), lap: -1, wrapped: false };
  race.phase = 'countdown';
  race.t = 0;
  race.raceTime = 0;
  race.lapTime = 0;
  race.lastLap = null;
  race.bestLap = null;
  race.finishPos = 0;
  race.position = 4;
  hideMsg();
}

function restartRace() { if (race.ais.length) startGrid(); }

function teardownRace() {
  for (const ai of race.ais) scene.remove(ai.group);
  race.ais = [];
  race.phase = null;
  hideMsg();
  rpEls.panel.style.display = 'none';
}

function updateRace(dt) {
  const locked = race.phase === 'countdown';
  if (race.phase === 'countdown') {
    race.t += dt;
    const c = 3 - Math.floor(race.t);
    if (race.t < 3) showMsg(`${c}`);
    else {
      race.phase = 'racing';
      showMsg('GO!', 900);
    }
  } else if (race.phase === 'racing' || race.phase === 'finished') {
    race.raceTime += dt;
    race.lapTime += dt;
  }

  for (const ai of race.ais) ai.update(dt, locked);
  resolveCarContacts();

  if (race.phase === 'racing' || race.phase === 'finished') {
    const tr = race.player;
    tr.wrapped = false;
    trackProgress(tr, car.position);
    if (tr.wrapped && race.phase === 'racing') {
      if (tr.lap >= 1) {
        race.lastLap = race.lapTime;
        if (!race.bestLap || race.lapTime < race.bestLap) race.bestLap = race.lapTime;
      }
      race.lapTime = 0;
      if (tr.lap >= LAPS) {
        race.phase = 'finished';
        race.finishPos = race.position;
        const medal = ['🏆', '🥈', '🥉', ''][race.finishPos - 1] || '';
        showMsg(`P${race.finishPos} ${medal}<small>R restart · Esc menu</small>`);
      } else if (tr.lap >= 1) {
        showMsg(`Lap ${tr.lap + 1}/${LAPS}<small>${fmtTime(race.lastLap)}</small>`, 1800);
      }
    }
    // live standings
    const n = wayPts.length;
    const pProg = tr.lap * n + tr.idx;
    let ahead = 0;
    for (const ai of race.ais) if (ai.progress > pProg) ahead++;
    race.position = ahead + 1;
  }

  // HUD race panel
  rpEls.pos.textContent = race.phase === 'finished' ? `P${race.finishPos}` : `${race.position}/4`;
  rpEls.lap.textContent = `${Math.min(Math.max(race.player.lap + 1, 1), LAPS)}/${LAPS}`;
  rpEls.time.textContent = fmtTime(race.raceTime);
  rpEls.last.textContent = race.lastLap ? fmtTime(race.lastLap) : '–';
  rpEls.best.textContent = race.bestLap ? fmtTime(race.bestLap) : '–';
}

// simple arcade contact: push overlapping cars apart, bleed a little speed
function resolveCarContacts() {
  const bodies = [{ p: car.position, player: true }];
  for (const ai of race.ais) bodies.push({ p: ai.group.position, ai });
  const R = 2.3;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const A = bodies[i].p, B = bodies[j].p;
      let dx = B.x - A.x, dz = B.z - A.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const push = (R - d) / 2;
      dx /= d; dz /= d;
      A.x -= dx * push; A.z -= dz * push;
      B.x += dx * push; B.z += dz * push;
      if (bodies[i].player) {
        const into = state.vel.x * dx + state.vel.z * dz;
        if (into > 0) { state.vel.x -= dx * into * 0.6; state.vel.z -= dz * into * 0.6; }
      }
      if (bodies[i].ai) bodies[i].ai.speed *= 0.985;
      if (bodies[j].ai) bodies[j].ai.speed *= 0.985;
    }
  }
}

// ---------------------------------------------------------------- physics

const tmpV = new THREE.Vector3();
const fwdV = new THREE.Vector3();
const rightV = new THREE.Vector3();
const fwdTiltV = new THREE.Vector3();
const basisM = new THREE.Matrix4();
const smoothUp = new THREE.Vector3(0, 1, 0);
const GRAVITY = 22;

function sampleGround() {
  // 4 corner probes relative to heading
  const sin = Math.sin(state.yaw), cos = Math.cos(state.yaw);
  const offsets = [ [0.8, 1.5], [-0.8, 1.5], [0.8, -1.5], [-0.8, -1.5] ];
  let ySum = 0, n = 0, road = false;
  const normal = new THREE.Vector3();
  for (const [ox, oz] of offsets) {
    const wx = car.position.x + ox * cos + oz * sin;
    const wz = car.position.z - ox * sin + oz * cos;
    const h = groundHit(wx, wz, car.position.y + 4);
    if (h) {
      ySum += h.point.y; n++;
      if (isRoad(h)) road = true;
      if (h.face) {
        tmpV.copy(h.face.normal).transformDirection(h.object.matrixWorld);
        if (tmpV.y < 0) tmpV.negate();
        normal.add(tmpV);
      }
    }
  }
  if (!n) return null;
  normal.normalize();
  return { y: ySum / n, normal: normal.lengthSq() ? normal : new THREE.Vector3(0, 1, 0), road, count: n };
}

function stepPhysics(dt, locked) {
  const spec = carSpec;
  const speed = state.vel.length();
  const fwd = fwdV.set(Math.sin(state.yaw), 0, Math.cos(state.yaw));
  const forwardSpeed = state.vel.dot(fwd);

  // --- input (frozen during the countdown)
  const throttle = (!locked && (kd('KeyW') || kd('ArrowUp'))) ? 1 : 0;
  const brake = (!locked && (kd('KeyS') || kd('ArrowDown'))) ? 1 : 0;
  const steerIn = locked ? 0 : (kd('KeyA') || kd('ArrowLeft') ? 1 : 0) - (kd('KeyD') || kd('ArrowRight') ? 1 : 0);
  const handbrake = !locked && kd('Space');
  state.steer += (steerIn - state.steer) * Math.min(1, dt * 8);

  const ground = sampleGround();
  state.grounded = !!ground && car.position.y - ground.y < 1.2;
  state.onRoad = ground ? ground.road : true;
  const surfGrip = state.onRoad ? 1 : 0.45;

  if (state.grounded) {
    // steering: speed-sensitive yaw rate
    const steerAuthority = Math.min(1, speed / 6) * (1 - Math.min(0.6, speed / (spec.topSpeed * 1.6)));
    const dir = forwardSpeed >= -0.5 ? 1 : -1;
    state.yaw += state.steer * spec.turn * 1.9 * steerAuthority * dir * dt;

    // engine / brakes along heading
    let accel = 0;
    if (throttle) {
      if (forwardSpeed < -0.5) accel = spec.accel * 1.4;                    // braking out of reverse
      else accel = spec.accel * (1 - Math.max(0, forwardSpeed) / spec.topSpeed) * surfGrip;
    }
    if (brake) {
      if (forwardSpeed > 0.5) accel -= spec.accel * 1.9;                    // brakes
      else accel -= spec.accel * 0.55 * (1 - Math.abs(forwardSpeed) / (spec.topSpeed * 0.28)); // reverse
    }
    state.vel.addScaledVector(fwd, accel * dt);

    // split velocity into forward + lateral, kill lateral per grip
    const f = state.vel.dot(fwd);
    tmpV.copy(state.vel).addScaledVector(fwd, -f);           // lateral
    const latGrip = (handbrake ? 2.2 : 8.5) * spec.grip * surfGrip;
    tmpV.multiplyScalar(Math.max(0, 1 - latGrip * dt));
    state.vel.copy(tmpV).addScaledVector(fwd, f);

    // rolling resistance + offroad drag
    const drag = (0.35 + (state.onRoad ? 0 : 1.6) + (handbrake ? 3.5 : 0)) * dt;
    state.vel.multiplyScalar(Math.max(0, 1 - drag * 0.35));
    if (state.vel.lengthSq() < 0.02 && !throttle && !brake) state.vel.set(0, 0, 0);
  }

  // gravity / ground snap
  if (ground && car.position.y - ground.y <= 1.2) {
    car.position.y += (ground.y - car.position.y) * Math.min(1, dt * 14);
    state.vy = 0;
  } else {
    state.vy -= GRAVITY * dt;
    car.position.y += state.vy * dt;
  }

  // wall collision: probe along velocity at bumper height
  const spd = state.vel.length();
  if (spd > 2) {
    tmpV.copy(state.vel).normalize();
    raycaster.set(new THREE.Vector3(car.position.x, car.position.y + 0.7, car.position.z), tmpV);
    raycaster.far = 3.2 + spd * 0.06;
    const hit = raycaster.intersectObjects(trackMeshes, false)[0];
    if (hit && hit.face) {
      const n = tmpV.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      if (Math.abs(n.y) < 0.55) { // a wall, not a slope
        const into = state.vel.dot(n);
        if (into < 0) state.vel.addScaledVector(n, -into * 1.35); // bounce a little
        state.vel.multiplyScalar(0.82);
      }
    }
  }

  // side probes: don't let the car scrape up onto walls
  for (const s of [1, -1]) {
    rightV.set(Math.cos(state.yaw) * s, 0, -Math.sin(state.yaw) * s);
    raycaster.set(new THREE.Vector3(car.position.x, car.position.y + 0.55, car.position.z), rightV);
    raycaster.far = 1.25;
    const hit = raycaster.intersectObjects(trackMeshes, false)[0];
    if (hit && hit.face) {
      const n = tmpV.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      if (Math.abs(n.y) < 0.55) {
        n.y = 0; n.normalize();
        if (n.dot(rightV) > 0) n.negate();
        const push = 1.25 - hit.distance;
        car.position.x += n.x * push;
        car.position.z += n.z * push;
        const into = state.vel.dot(n);
        if (into < 0) state.vel.addScaledVector(n, -into);
      }
    }
  }

  car.position.x += state.vel.x * dt;
  car.position.z += state.vel.z * dt;

  // orientation: yaw + tilt to ground normal
  if (ground) smoothUp.lerp(ground.normal, Math.min(1, dt * 5)).normalize();
  const fwdFlat = fwdV.set(Math.sin(state.yaw), 0, Math.cos(state.yaw));
  rightV.crossVectors(smoothUp, fwdFlat).normalize();
  fwdTiltV.crossVectors(rightV, smoothUp).normalize();
  basisM.makeBasis(rightV, smoothUp, fwdTiltV);
  car.quaternion.setFromRotationMatrix(basisM);

  // wheels
  const spin = forwardSpeed / 0.34 * dt;
  for (const w of playerWheels.spin) { w.angle += spin; w.pivot.quaternion.setFromAxisAngle(w.axis, w.angle); }
  for (const s of playerWheels.steer) s.pivot.quaternion.setFromAxisAngle(s.axis, state.steer * 0.45);

  // fell off the world
  if (car.position.y < -400) resetCar();

  return { speed: Math.abs(forwardSpeed), throttle, forwardSpeed };
}

// ---------------------------------------------------------------- camera

let camMode = 0; // 0 chase, 1 far chase, 2 hood
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
const camTargetV = new THREE.Vector3();
const camLookTargetV = new THREE.Vector3();
let camInit = false;

function updateCamera(dt) {
  const sin = Math.sin(state.yaw), cos = Math.cos(state.yaw);
  if (camMode === 2) {
    camPos.set(car.position.x + sin * 0.4, car.position.y + 1.15, car.position.z + cos * 0.4);
    camLook.set(car.position.x + sin * 30, car.position.y + 0.8, car.position.z + cos * 30);
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    return;
  }
  const speed = state.vel.length();
  const dist = (camMode === 0 ? 2.8 : 9) + Math.min(1.0, speed * 0.015); // slight pull-back at speed
  const height = camMode === 0 ? 2.15 : 3.4;
  camTargetV.set(car.position.x - sin * dist, car.position.y + height, car.position.z - cos * dist);
  camLookTargetV.set(car.position.x, car.position.y + 1.3, car.position.z);
  if (!camInit) { camPos.copy(camTargetV); camLook.copy(camLookTargetV); camInit = true; }
  camPos.lerp(camTargetV, 1 - Math.exp(-dt * 14));
  camLook.lerp(camLookTargetV, 1 - Math.exp(-dt * 10));
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

// ---------------------------------------------------------------- audio

// V8 synth: firing-frequency saws + sub + exhaust noise through a soft clip,
// pitched low, with a 5-speed gearbox driving the rpm curve
const GEAR_FRACS = [0.16, 0.30, 0.48, 0.72, 1.02]; // top-of-gear as fraction of topSpeed
const engineAudio = (() => {
  let ctx = null, muted = false, running = false;
  let master, filter, oscFire, oscHalf, oscSub, noiseBP, noiseGain;
  let gear = 0, rpmSmooth = 0.1, shiftDip = 0;

  function makeNoise() {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { // brown noise: deep exhaust texture
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    return src;
  }

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0;

    const shaper = ctx.createWaveShaper();          // soft clip -> growl
    const curve = new Float32Array(512);
    for (let i = 0; i < 512; i++) { const x = (i / 255.5) - 1; curve[i] = Math.tanh(3.0 * x); }
    shaper.curve = curve;

    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 420; filter.Q.value = 1.0;

    const mix = ctx.createGain(); mix.gain.value = 0.5;
    oscFire = ctx.createOscillator(); oscFire.type = 'sawtooth';
    oscHalf = ctx.createOscillator(); oscHalf.type = 'sawtooth'; oscHalf.detune.value = 7;
    oscSub  = ctx.createOscillator(); oscSub.type = 'square';
    const gFire = ctx.createGain(); gFire.gain.value = 0.50;
    const gHalf = ctx.createGain(); gHalf.gain.value = 0.48;
    const gSub  = ctx.createGain(); gSub.gain.value = 0.42;
    oscFire.connect(gFire); oscHalf.connect(gHalf); oscSub.connect(gSub);
    gFire.connect(mix); gHalf.connect(mix); gSub.connect(mix);

    const noise = makeNoise();
    noiseBP = ctx.createBiquadFilter(); noiseBP.type = 'bandpass'; noiseBP.frequency.value = 220; noiseBP.Q.value = 0.7;
    noiseGain = ctx.createGain(); noiseGain.gain.value = 0.0;
    noise.connect(noiseBP); noiseBP.connect(noiseGain); noiseGain.connect(mix);

    mix.connect(shaper); shaper.connect(filter); filter.connect(master);
    master.connect(ctx.destination);
    oscFire.start(); oscHalf.start(); oscSub.start(); noise.start();
  }

  return {
    setRunning(v) { running = v; if (v) init(); if (master && !v) master.gain.value = 0; },
    toggle() { muted = !muted; if (master && muted) master.gain.value = 0; },
    get gear() { return gear; },
    update(speed, throttle, top) {
      if (!ctx || muted || !running) return;
      const s = speed / top;
      // pick gear: shift up near top of band, down with hysteresis
      while (gear < GEAR_FRACS.length - 1 && s > GEAR_FRACS[gear]) { gear++; shiftDip = 1; }
      while (gear > 0 && s < (gear === 0 ? 0 : GEAR_FRACS[gear - 1]) * 0.82) gear--;
      const lo = gear === 0 ? 0 : GEAR_FRACS[gear - 1];
      const hi = GEAR_FRACS[gear];
      let rpm = 0.16 + 0.84 * Math.min(1, Math.max(0, (s - lo) / (hi - lo)));
      shiftDip = Math.max(0, shiftDip - 0.09);            // momentary drop on upshift
      rpm *= 1 - shiftDip * 0.35;
      rpm += throttle * 0.04;
      rpmSmooth += (rpm - rpmSmooth) * 0.35;

      const rot = 10 + rpmSmooth * 60;                    // crank Hz, kept low
      const fire = rot * 4;                               // V8 firing freq
      const t = ctx.currentTime;
      oscFire.frequency.setTargetAtTime(fire, t, 0.03);
      oscHalf.frequency.setTargetAtTime(fire * 0.5, t, 0.03);
      oscSub.frequency.setTargetAtTime(rot, t, 0.03);
      filter.frequency.setTargetAtTime(200 + rpmSmooth * 1500 + throttle * 550, t, 0.06);
      noiseBP.frequency.setTargetAtTime(150 + rpmSmooth * 700, t, 0.06);
      noiseGain.gain.setTargetAtTime(0.12 + throttle * 0.5, t, 0.09);
      master.gain.setTargetAtTime(0.05 + rpmSmooth * 0.08 + throttle * 0.05, t, 0.08);
    },
  };
})();

// ---------------------------------------------------------------- HUD: analog speedometer

const speedo = (() => {
  const cv = document.getElementById('speedo');
  const SIZE = 230;
  const dpr = Math.min(devicePixelRatio, 2);
  cv.width = cv.height = SIZE * dpr;
  cv.style.width = cv.style.height = `${SIZE}px`;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const CX = SIZE / 2, CY = SIZE / 2, R = SIZE / 2 - 8;
  const A0 = 130, A1 = 410;                 // dial sweep in canvas degrees
  let dial = null, maxK = 280, needleV = 0;

  const angOf = v => (A0 + (A1 - A0) * Math.min(1, v / maxK)) * DEG;

  function buildDial(topKmh) {
    maxK = Math.max(120, Math.ceil(topKmh / 40) * 40);
    let major = 20;
    while (maxK / major > 9) major += 20;   // aim for ~7-9 labelled ticks
    dial = document.createElement('canvas');
    dial.width = dial.height = SIZE * dpr;
    const d = dial.getContext('2d');
    d.scale(dpr, dpr);
    // face
    const bg = d.createRadialGradient(CX, CY, R * 0.2, CX, CY, R);
    bg.addColorStop(0, 'rgba(16,20,26,.88)');
    bg.addColorStop(1, 'rgba(8,10,14,.92)');
    d.fillStyle = bg;
    d.beginPath(); d.arc(CX, CY, R, 0, Math.PI * 2); d.fill();
    d.strokeStyle = 'rgba(255,255,255,.14)';
    d.lineWidth = 1.5;
    d.beginPath(); d.arc(CX, CY, R - 0.75, 0, Math.PI * 2); d.stroke();
    // redline arc: top 15% of the dial
    d.strokeStyle = 'rgba(232,65,44,.85)';
    d.lineWidth = 5;
    d.beginPath(); d.arc(CX, CY, R - 12, angOf(maxK * 0.85), angOf(maxK)); d.stroke();
    // ticks + labels
    d.textAlign = 'center'; d.textBaseline = 'middle';
    for (let v = 0; v <= maxK; v += major / 2) {
      const a = angOf(v);
      const majorTick = v % major === 0;
      const r1 = R - 8, r2 = R - (majorTick ? 22 : 15);
      d.strokeStyle = v >= maxK * 0.85 ? 'rgba(232,65,44,.9)' : 'rgba(230,236,245,.85)';
      d.lineWidth = majorTick ? 2.5 : 1.2;
      d.beginPath();
      d.moveTo(CX + Math.cos(a) * r1, CY + Math.sin(a) * r1);
      d.lineTo(CX + Math.cos(a) * r2, CY + Math.sin(a) * r2);
      d.stroke();
      if (majorTick) {
        d.fillStyle = v >= maxK * 0.85 ? '#e8412c' : '#c8d1dc';
        d.font = '600 13px "Avenir Next", "Segoe UI", system-ui, sans-serif';
        d.fillText(String(v), CX + Math.cos(a) * (R - 36), CY + Math.sin(a) * (R - 36));
      }
    }
    d.fillStyle = '#71809296';
    d.font = '600 10px "Avenir Next", system-ui, sans-serif';
    d.fillText('KM/H', CX, CY + R * 0.34);
    needleV = 0;
  }

  function draw(kmh, gearLabel, dt) {
    if (!dial) return;
    needleV += (kmh - needleV) * Math.min(1, dt * 10); // needle inertia
    g.clearRect(0, 0, SIZE, SIZE);
    g.drawImage(dial, 0, 0, SIZE, SIZE);
    // needle
    const a = angOf(needleV);
    g.save();
    g.translate(CX, CY);
    g.rotate(a);
    g.shadowColor = 'rgba(232,65,44,.8)';
    g.shadowBlur = 8;
    g.fillStyle = '#e8412c';
    g.beginPath();
    g.moveTo(-14, -2.4);
    g.lineTo(R - 26, -0.9);
    g.lineTo(R - 26, 0.9);
    g.lineTo(-14, 2.4);
    g.closePath();
    g.fill();
    g.restore();
    // hub
    g.fillStyle = '#11151b';
    g.strokeStyle = 'rgba(232,65,44,.9)';
    g.lineWidth = 2;
    g.beginPath(); g.arc(CX, CY, 7, 0, Math.PI * 2); g.fill(); g.stroke();
    // digital readout + gear
    g.textAlign = 'center';
    g.fillStyle = '#f2f5f9';
    g.font = '800 30px "Avenir Next", "Segoe UI", system-ui, sans-serif';
    g.fillText(String(Math.round(kmh)), CX, CY + R * 0.56);
    g.fillStyle = '#e8412c';
    g.font = '700 14px "Avenir Next", system-ui, sans-serif';
    g.fillText(gearLabel, CX, CY + R * 0.76);
  }

  return { buildDial, draw };
})();

// ---------------------------------------------------------------- HUD: minimap

const minimap = (() => {
  const wrap = document.getElementById('minimap');
  const cv = document.getElementById('minimapCanvas');
  const S = 170;
  const dpr = Math.min(devicePixelRatio, 2);
  cv.width = cv.height = S * dpr;
  cv.style.width = cv.style.height = `${S}px`;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  let path = null, toMap = null;

  function build() {
    if (wayPts.length < 20) { wrap.style.display = 'none'; return; }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of wayPts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    const pad = 12;
    const sc = Math.min((S - pad * 2) / (maxX - minX || 1), (S - pad * 2) / (maxZ - minZ || 1));
    const ox = (S - (maxX - minX) * sc) / 2, oz = (S - (maxZ - minZ) * sc) / 2;
    toMap = (x, z) => [ox + (x - minX) * sc, oz + (z - minZ) * sc];
    path = new Path2D();
    for (let i = 0; i < wayPts.length; i += 2) {
      const [u, v] = toMap(wayPts[i].x, wayPts[i].z);
      i === 0 ? path.moveTo(u, v) : path.lineTo(u, v);
    }
    if (lineClosed) path.closePath();
    wrap.style.display = 'block';
  }

  function dot(x, z, color, r) {
    const [u, v] = toMap(x, z);
    g.fillStyle = color;
    g.beginPath(); g.arc(u, v, r, 0, Math.PI * 2); g.fill();
  }

  function draw() {
    if (!path) return;
    g.clearRect(0, 0, S, S);
    g.lineJoin = g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,.6)';
    g.lineWidth = 4.5;
    g.stroke(path);
    g.strokeStyle = 'rgba(255,255,255,.75)';
    g.lineWidth = 2;
    g.stroke(path);
    // start line
    const [su, sv] = toMap(spawn.pos.x, spawn.pos.z);
    g.fillStyle = '#fff';
    g.fillRect(su - 3, sv - 1.5, 6, 3);
    for (const ai of race.ais) dot(ai.group.position.x, ai.group.position.z, ai.color, 3);
    if (car) dot(car.position.x, car.position.z, '#e8412c', 4);
  }

  return { build, draw };
})();

// ---------------------------------------------------------------- loop

const surfaceEl = document.getElementById('surface');
const clock = new THREE.Clock();
let playing = false;

function gearLabel(forwardSpeed, top) {
  if (forwardSpeed < -0.5) return 'R';
  if (forwardSpeed < 0.5) return 'N';
  const s = forwardSpeed / top;
  for (let i = 0; i < GEAR_FRACS.length; i++) if (s <= GEAR_FRACS[i]) return String(i + 1);
  return String(GEAR_FRACS.length);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (playing && car && carSpec) {
    const locked = race.phase === 'countdown';
    // substep for stable physics at low fps
    const steps = dt > 0.025 ? 2 : 1;
    let info;
    for (let i = 0; i < steps; i++) info = stepPhysics(dt / steps, locked);
    if (mode === 'race' && race.phase) updateRace(dt);
    updateCamera(dt);
    sun.position.copy(car.position).addScaledVector(SUN_DIR, 700);
    sun.target.position.copy(car.position);
    engineAudio.update(info.speed, info.throttle, carSpec.topSpeed);
    // motion blur ramps in above ~90 km/h, harder when flat out
    const kmh = info.speed * 3.6;
    const blurTarget = Math.min(1, Math.max(0, (kmh - 90) / 220)) * 0.09;
    speedBlur.uniforms.strength.value += (blurTarget - speedBlur.uniforms.strength.value) * Math.min(1, dt * 6);
    speedo.draw(kmh, gearLabel(info.forwardSpeed, carSpec.topSpeed), dt);
    minimap.draw();
    surfaceEl.style.opacity = state.onRoad ? 0 : 1;
    perfTick(dt);
  }
  composer.render();
}
animate();

// ---------------------------------------------------------------- boot

let trackPromise = null;

window.__dbg = { scene, camera, state, keys, race, get car() { return car; }, get spawn() { return spawn; }, get trackMeshes() { return trackMeshes; }, get wayPts() { return wayPts; }, THREE };

carsEl.addEventListener('click', async e => {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  const key = cardEl.dataset.car;
  carsEl.style.display = 'none';
  modesEl.style.display = 'none';
  modeDescEl.style.display = 'none';
  loadingEl.style.display = 'flex';
  engineAudio.setRunning(true); // user gesture: unlock audio
  try {
    trackPromise ??= loadTrack();
    await trackPromise;
    await loadPlayerCar(key);
    const raceable = mode === 'race' && wayPts.length > 50 && lineClosed;
    if (mode === 'race' && !raceable) console.warn('racing line incomplete — falling back to free roam');
    if (raceable) {
      await setupRace(key);
      rpEls.panel.style.display = 'block';
    } else {
      rpEls.panel.style.display = 'none';
      placePlayer(spawn.pos, spawn.yaw);
    }
    minimap.build();
    setProgress(1);
    overlay.classList.add('hidden');
    hud.style.display = 'block';
    camInit = false;
    playing = true;
  } catch (err) {
    loadmsg.textContent = 'Failed to load: ' + err.message;
    console.error(err);
  }
});
