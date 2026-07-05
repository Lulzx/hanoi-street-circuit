import * as THREE from 'three';
import { pass, mrt, output, normalView, renderOutput, uv, vec2, vec3, vec4, mix, smoothstep, float, luminance, time } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { LensflareMesh, LensflareElement } from 'three/addons/objects/LensflareMesh.js';
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

// WebGPU renderer (falls back to WebGL2 automatically where unavailable;
// ?webgl forces the fallback for A/B comparison)
const renderer = new THREE.WebGPURenderer({
  antialias: true,
  powerPreference: 'high-performance',
  forceWebGL: new URLSearchParams(location.search).has('webgl'),
});
const MAX_RATIO = Math.min(devicePixelRatio, 1.5);
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(MAX_RATIO);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95; // grade vignette eats a little light
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x93c1ee, 0.00019); // blue-shifted to match the azure sky

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
  grad.addColorStop(0.0, '#0838c8');   // deep cobalt zenith — open-ocean sky
  grad.addColorStop(0.2, '#155ce4');
  grad.addColorStop(0.36, '#2f86f0');
  grad.addColorStop(0.46, '#6db4f8');  // saturated azure held almost to the horizon
  grad.addColorStop(0.492, '#b7defb'); // haze band kept thin so the blue dominates
  grad.addColorStop(0.52, '#9dbcd8');
  grad.addColorStop(1.0, '#7e93a6');   // below horizon
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
  // the same sky drives image-based lighting, so reflections on the paint
  // match the clouds overhead (WebGPURenderer PMREMs equirects internally)
  scene.environment = tex;
  scene.environmentIntensity = 0.6;
}

const hemi = new THREE.HemisphereLight(0xbfd6f0, 0x5a564c, 0.55);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d8, 3.0);
sun.position.copy(SUN_DIR).multiplyScalar(700);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.near = 50;
sun.shadow.camera.far = 2000;
sun.shadow.camera.left = sun.shadow.camera.bottom = -150;
sun.shadow.camera.right = sun.shadow.camera.top = 150;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

// lens flare on the sun — soft canvas sprites, no external assets
function flareTex(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) rg.addColorStop(o, col);
  g.fillStyle = rg;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
{
  const glow = flareTex(256, [
    [0, 'rgba(255,246,228,1)'], [0.22, 'rgba(255,236,200,.55)'],
    [0.55, 'rgba(255,222,170,.16)'], [1, 'rgba(255,222,170,0)'],
  ]);
  const ghost = flareTex(128, [
    [0, 'rgba(255,255,255,.7)'], [0.4, 'rgba(255,255,255,.18)'], [1, 'rgba(255,255,255,0)'],
  ]);
  const flare = new LensflareMesh();
  flare.addElement(new LensflareElement(glow, 420, 0));
  flare.addElement(new LensflareElement(ghost, 55, 0.35, new THREE.Color(0x6aa8ff)));
  flare.addElement(new LensflareElement(ghost, 90, 0.55, new THREE.Color(0xffa966)));
  flare.addElement(new LensflareElement(ghost, 45, 0.8, new THREE.Color(0x8affcc)));
  flare.addElement(new LensflareElement(ghost, 120, 1.05, new THREE.Color(0xff8a66)));
  sun.add(flare);
}

// post (TSL node graph): GTAO grounds the car and barriers, bloom lifts sun
// glints, then a filmic grade (vibrance + vignette) and FXAA in sRGB space
const postProcessing = new THREE.PostProcessing(renderer);
postProcessing.outputColorTransform = false; // we tonemap mid-chain via renderOutput
const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output, normal: normalView }));
const scenePassColor = scenePass.getTextureNode('output');
const aoPass = ao(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), camera);
if (aoPass.radius) aoPass.radius.value = 0.5;
if (aoPass.scale) aoPass.scale.value = 1.2;
if (aoPass.thickness) aoPass.thickness.value = 1;

// photographic grade: vibrance, warm-light/cool-shade split toning, a gentle
// S-curve, fine animated grain and a corner vignette — the "camera" between
// the renderer and the screen is most of what reads as photoreal
const grade = c => {
  let col = c.rgb;
  col = mix(vec3(luminance(col)), col, float(1.16));                    // vibrance
  const lum = luminance(col);
  const tone = mix(vec3(0.965, 1.0, 1.055), vec3(1.045, 1.0, 0.935),   // cool shadows -> warm highlights
    smoothstep(float(0.12), float(0.75), lum));
  col = col.mul(tone);
  const sCurve = col.mul(col).mul(vec3(3.0).sub(col.mul(2.0)));        // x²(3-2x)
  col = mix(col, sCurve, float(0.3));
  const grain = uv().mul(vec2(1287.4, 718.1)).add(time.mul(60.0))
    .dot(vec2(12.9898, 78.233)).sin().mul(43758.5453).fract().sub(0.5).mul(0.022);
  col = col.add(grain);
  const q = uv().sub(0.5);
  const vig = float(1.0).sub(smoothstep(float(0.45), float(1.4), q.dot(q).mul(2.0)).mul(0.32));
  return vec4(col.mul(vig), c.a);
};
const buildChain = lit => fxaa(grade(renderOutput(lit.add(bloom(lit, 0.3, 0.5, 0.8)))));
const chainAO = buildChain(scenePassColor.mul(aoPass.getTextureNode()));
const chainPlain = buildChain(scenePassColor);
postProcessing.outputNode = chainAO;
let aoOn = true;
function setAO(v) {
  if (aoOn === v) return;
  aoOn = v;
  postProcessing.outputNode = v ? chainAO : chainPlain;
  postProcessing.needsUpdate = true;
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
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
    } else if (aoOn) {
      setAO(false);
    }
    perf.cooldown = 2;
  } else if (avg < 0.014) {
    if (!aoOn) setAO(true);
    else if (perf.ratio < MAX_RATIO) {
      perf.ratio = Math.min(MAX_RATIO, perf.ratio + 0.2);
      renderer.setPixelRatio(perf.ratio);
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

// tiling micro-detail normal map for asphalt: multi-octave value noise,
// converted to normals — gives the road real texture under the sun without
// touching the baked color maps
const asphaltNormal = (() => {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  let seed = 1234;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // height field: layered random blobs, drawn wrapped so the tile is seamless
  g.fillStyle = '#808080';
  g.fillRect(0, 0, S, S);
  for (const [count, rad, amp] of [[900, 3, 14], [2600, 1.4, 18], [200, 8, 8]]) {
    for (let i = 0; i < count; i++) {
      const x = rnd() * S, y = rnd() * S, r = rad * (0.6 + rnd() * 0.8);
      const v = Math.round((rnd() - 0.5) * 2 * amp);
      g.fillStyle = `rgba(${128 + v},${128 + v},${128 + v},0.5)`;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        g.beginPath(); g.arc(x + ox, y + oy, r, 0, Math.PI * 2); g.fill();
      }
    }
  }
  const h = g.getImageData(0, 0, S, S).data;
  const out = g.createImageData(S, S);
  const H = (x, y) => h[(((y + S) % S) * S + ((x + S) % S)) * 4];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) / 255;
      const dz = (H(x, y + 1) - H(x, y - 1)) / 255;
      const inv = 1 / Math.hypot(dx * 2, dz * 2, 1);
      const i = (y * S + x) * 4;
      out.data[i] = 128 + dx * 2 * inv * 127;
      out.data[i + 1] = 128 - dz * 2 * inv * 127;
      out.data[i + 2] = inv * 255;
      out.data[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(28, 28);
  return t;
})();

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/libs/draco/gltf/');
loader.setDRACOLoader(draco);
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
    const total = ev.total || 18113496; // slow links must see the bar move
    setProgress(Math.min(1, ev.loaded / total) * 0.6,
      `Loading Hanoi Street Circuit… ${MB(ev.loaded)} / ${MB(total)} MB`);
  });
  setProgress(0.62, 'Building collision data…');
  await new Promise(r => setTimeout(r, 30)); // let the UI paint
  track = gltf.scene;
  // the model ships editor marker props (yellow FRONTAL/TOP arrow boxes,
  // material NODE.* / texture "node") littered along the circuit — drop them
  const markers = [];
  track.traverse(o => {
    if (o.isMesh && (o.material?.map?.name === 'node' || /^node/i.test(o.material?.name || ''))) markers.push(o);
  });
  for (const m of markers) m.removeFromParent();
  track.traverse(o => {
    if (o.isMesh) {
      o.geometry.computeBoundsTree();
      o.receiveShadow = true;
      if (o.material) {
        o.material.side = THREE.DoubleSide;
        o.material.envMapIntensity = 0.3; // textures are baked, keep IBL subtle
        if (o.material.map) o.material.map.anisotropy = 8;
        // asphalt gets micro-normals and a grazing-angle sheen so the sun
        // actually plays on the road surface
        const mapName = (o.material.map?.name || '').toLowerCase();
        if (/asfalto|tarmac|asphalt|road_liso/.test(mapName)) {
          o.material.normalMap = asphaltNormal;
          o.material.normalScale = new THREE.Vector2(0.45, 0.45);
          o.material.roughness = 0.72;
          o.material.metalness = 0;
          o.material.envMapIntensity = 0.5;
          o.material.needsUpdate = true;
        }
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
  // the circuit loop is precomputed offline (tools/buildline.js) and shipped
  // as an asset; the runtime tracer remains as a fallback
  try {
    const res = await fetch('assets/racingline.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    if (!Array.isArray(data.pts) || data.pts.length < 50) throw new Error('bad line data');
    wayPts = data.pts;
    lineClosed = true;
    wpSpeeds = computeCornerSpeeds(wayPts);
    const a = wayPts[0], b = wayPts[2];
    spawn.pos.set(a.x, a.y + 0.5, a.z);
    spawn.yaw = Math.atan2(b.x - a.x, b.z - a.z);
  } catch (err) {
    console.warn('racing line asset unavailable, tracing live:', err.message);
    await buildRacingLine();
  }
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

// like groundHit, but returns the racing-surface hit closest in height to
// refY — under overpasses/tents the first hit from above isn't the road,
// and buried road meshes below terrain must not count
function racingHitNear(x, z, refY, tol = 2.5) {
  raycaster.set(new THREE.Vector3(x, refY + 30, z), DOWN);
  raycaster.far = 2000;
  raycaster.firstHitOnly = false;
  const hits = raycaster.intersectObjects(trackMeshes, false); // sorted top-down
  raycaster.firstHitOnly = true;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (!isRacingSurface(h)) continue;
    if (Math.abs(h.point.y - refY) > tol) continue;
    // asphalt with something resting just above it is buried under terrain,
    // not drivable; tents and bridges sit well higher and stay valid
    if (i > 0 && hits[i - 1].point.y - h.point.y < 2.2) continue;
    return h;
  }
  return null;
}

async function buildRacingLine() {
  // depth-first search over the asphalt network: march forward, remember
  // junctions where another road forked off, and on a dead end rewind to
  // the last junction and take the fork instead
  const attempt = async (startYaw, progressBase) => {
    const pts = [];
    const p = spawn.pos.clone();
    let yaw = startYaw;
    let rescues = 0, sinceRescue = 99, deadEnds = 0;
    let forcedOff = null;
    const branches = []; // {len, x, y, z, yaw, alts}
    let closed = false;
    let iters = 0;
    for (let i = 0; i < 20000; i++) {
      iters = i;
      let bestOff;
      if (forcedOff !== null) {
        bestOff = forcedOff;
        forcedOff = null;
      } else {
        // score each heading by how far the racing asphalt continues; the
        // fan spans ±90° because street circuits have true right-angle
        // turns (e.g. onto the return carriageway of an out-and-back)
        const scored = [];
        for (let off = -90; off <= 90; off += 7.5) {
          const y2 = yaw + off * DEG;
          const dx = Math.sin(y2), dz = Math.cos(y2);
          let raw = 0;
          for (const d of [WP_STEP, WP_STEP * 2, WP_STEP * 3.5]) {
            if (racingHitNear(p.x + dx * d, p.z + dz * d, p.y, 2.5 + d * 0.12)) raw += 1; else break;
          }
          scored.push({ off, raw, score: raw - Math.abs(off) * 0.012 });
        }
        scored.sort((a, b) => b.score - a.score);
        const best = scored[0];
        if (best.score < 0.9) {
          // rescue: probe ahead over the gap (start-line paint, sponsor
          // tents, bridge joints) for more racing asphalt and jump it
          let jumped = false;
          if (rescues < 400 && sinceRescue > 0) {
            outer:
            for (let jump = 2; jump <= 9; jump++) {
              for (const off of [0, -8, 8, -16, 16, -25, 25, -34, 34]) {
                const y2 = yaw + off * DEG;
                const jx = p.x + Math.sin(y2) * WP_STEP * jump;
                const jz = p.z + Math.cos(y2) * WP_STEP * jump;
                const h = racingHitNear(jx, jz, p.y, Math.min(6, 2.5 + jump * 0.6));
                // require the road to continue past the landing spot so we
                // don't hop onto a parallel sliver of asphalt
                if (h && racingHitNear(jx + Math.sin(y2) * WP_STEP, jz + Math.cos(y2) * WP_STEP, h.point.y)) {
                  p.set(h.point.x, h.point.y, h.point.z);
                  yaw = y2;
                  pts.push({ x: p.x, y: p.y, z: p.z, w: 8 });
                  rescues++; sinceRescue = 0; jumped = true;
                  break outer;
                }
              }
            }
          }
          if (jumped) continue;
          // true dead end (plaza, service spur) — rewind to the last
          // junction that still has an untried fork
          let br = null;
          while (branches.length) {
            const c = branches[branches.length - 1];
            if (c.alts.length) { br = c; break; }
            branches.pop();
          }
          if (!br || ++deadEnds > 400) break;
          pts.length = br.len;
          p.set(br.x, br.y, br.z);
          yaw = br.yaw;
          forcedOff = br.alts.shift();
          sinceRescue = 99;
          continue;
        }
        bestOff = best.off;
        // a genuinely different direction that also carries full road is a
        // junction — remember it in case this way dead-ends
        const alts = [];
        for (const s of scored) {
          if (s.raw < 3 || Math.abs(s.off - bestOff) < 20) continue;
          if (alts.some(a => Math.abs(a - s.off) < 25)) continue;
          alts.push(s.off);
          if (alts.length >= 3) break;
        }
        if (alts.length) branches.push({ len: pts.length, x: p.x, y: p.y, z: p.z, yaw, alts });
      }
      sinceRescue++;
      yaw += bestOff * DEG;
      p.x += Math.sin(yaw) * WP_STEP;
      p.z += Math.cos(yaw) * WP_STEP;
      const h = racingHitNear(p.x, p.z, p.y);
      if (h) p.y = h.point.y;
      const c = centerOnRoad(p, yaw);
      if (c.width > 3) p.copy(c.point);
      pts.push({ x: p.x, y: p.y, z: p.z, w: Math.max(c.width, 6) });
      // closed the loop? near ANY earlier waypoint travelling the same way
      // (the start may sit on a pit-straight spur that isn't part of the
      // loop itself — everything before the join gets trimmed)
      if (pts.length > 90) {
        const dirX = Math.sin(yaw), dirZ = Math.cos(yaw);
        const limit = pts.length - 90;
        for (let j = 0; j < limit; j++) {
          const dxc = p.x - pts[j].x, dzc = p.z - pts[j].z;
          if (dxc * dxc + dzc * dzc > 100) continue; // 10 m
          const n = pts[j + 1];
          const jx = n.x - pts[j].x, jz = n.z - pts[j].z;
          const jl = Math.hypot(jx, jz) || 1;
          if (dirX * jx / jl + dirZ * jz / jl > 0.5) {
            pts.splice(0, j);
            closed = true;
          }
          break;
        }
        if (closed) break;
      }
      if (i % 120 === 0) {
        setProgress(progressBase + Math.min(1, i / 1600) * 0.05);
        await new Promise(r => setTimeout(r));
      }
    }
    return { pts, closed, debug: { deadEnds, rescues, iters, branchesLeft: branches.length } };
  };

  let r = await attempt(spawn.yaw, 0.68);
  if (!r.closed) {
    // try lapping the circuit the other way round
    const r2 = await attempt(spawn.yaw + Math.PI, 0.73);
    if (r2.closed || r2.pts.length > r.pts.length) r = r2;
  }
  wayPts = r.pts;
  lineClosed = r.closed;
  window.__lineDebug = r.debug;
  if (lineClosed) {
    // the pre-join spur was trimmed, so anchor the spawn/grid to the loop
    const a = wayPts[0], b = wayPts[2];
    spawn.pos.set(a.x, a.y + 0.5, a.z);
    spawn.yaw = Math.atan2(b.x - a.x, b.z - a.z);
  }
  if (wayPts.length > 50) wpSpeeds = computeCornerSpeeds(wayPts);
  else wayPts = []; // too short to be useful — race mode falls back gracefully
}

// corner-limited target speed per waypoint plus a backward braking pass so
// the AI slows *before* the corner, not in it
function computeCornerSpeeds(pts) {
  const n = pts.length;
  const sp = new Float32Array(n);
  const A_LAT = 12, A_BRK = 15, VMAX = 88; // A_LAT trimmed so the AI leave margin in corners
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
  // showroom paint: give the body material a clear coat so the sky and sun
  // streak across the shell instead of a flat diffuse sheen
  const paint = findPaintMaterial(model);
  if (paint) {
    let pm = paint;
    if (!paint.isMeshPhysicalMaterial) {
      pm = new THREE.MeshPhysicalMaterial({
        name: paint.name,
        color: paint.color.clone(),
        map: paint.map,
        metalness: Math.max(paint.metalness ?? 0, 0.25),
        roughness: Math.min(paint.roughness ?? 1, 0.42),
        metalnessMap: paint.metalnessMap,
        roughnessMap: paint.roughnessMap,
        normalMap: paint.normalMap,
        emissive: paint.emissive?.clone(),
        emissiveMap: paint.emissiveMap,
        emissiveIntensity: paint.emissiveIntensity ?? 1,
      });
      if (paint.normalMap) pm.normalScale.copy(paint.normalScale);
      model.traverse(o => { if (o.isMesh && o.material === paint) o.material = pm; });
    }
    pm.clearcoat = 1;
    pm.clearcoatRoughness = 0.06;
    pm.envMapIntensity = 1.6;
  }
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

// the paint material: by name, else the material covering the most geometry
function findPaintMaterial(model) {
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
  return best;
}

// repaint the body: swap the paint material for a tinted clone
function tintCar(model, colorHex) {
  const best = findPaintMaterial(model);
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
    const total = ev.total || 5000000;
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
    // hard corridor: never drift further from the racing line than the road
    // is wide (kept them out of walls when a corner is overshot)
    {
      const a = wayPts[this.idx], b = wayPts[(this.idx + 1) % n];
      let tx = b.x - a.x, tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const rx = pos.x - a.x, rz = pos.z - a.z;
      const lat = rx * tz - rz * tx;           // signed offset, +ve = left of line
      const halfW = Math.max(2.5, (a.w || 8) / 2 - 1.4);
      if (Math.abs(lat) > halfW) {
        const fix = (Math.abs(lat) - halfW) * Math.sign(lat);
        pos.x -= tz * fix;
        pos.z += tx * fix;
        this.speed *= 1 - Math.min(0.5, dt * 2); // scrubbing the wall costs pace
      }
    }
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
      const total = ev.total || 5000000;
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

// mouse free-look: drag to orbit around the car; a moment after release the
// camera eases back to the usual chase view
const orbit = { yaw: 0, pitch: 0, dragging: false, lastT: -1e9 };
addEventListener('pointerdown', e => {
  if (playing && e.target === renderer.domElement) {
    orbit.dragging = true;
    orbit.lastT = performance.now();
  }
});
addEventListener('pointerup', () => { orbit.dragging = false; orbit.lastT = performance.now(); });
addEventListener('pointermove', e => {
  if (!orbit.dragging) return;
  orbit.yaw -= e.movementX * 0.0065;
  orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + e.movementY * 0.004, -0.2, 0.85);
  orbit.lastT = performance.now();
});

function updateCamera(dt) {
  // spring back to the chase view after a beat of no mouse input
  if (!orbit.dragging && performance.now() - orbit.lastT > 1300 && (orbit.yaw || orbit.pitch)) {
    const f = Math.exp(-dt * 5);
    orbit.yaw *= f;
    orbit.pitch *= f;
    if (Math.abs(orbit.yaw) < 0.003) orbit.yaw = 0;
    if (Math.abs(orbit.pitch) < 0.003) orbit.pitch = 0;
  }
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
  // orbit offsets rotate the boom around the car and tilt it up
  const oYaw = state.yaw + orbit.yaw;
  const cosP = Math.cos(orbit.pitch);
  const boom = dist + orbit.pitch * 2.5; // pull back a little when looking down
  camTargetV.set(
    car.position.x - Math.sin(oYaw) * boom * cosP,
    car.position.y + height + boom * Math.sin(orbit.pitch),
    car.position.z - Math.cos(oYaw) * boom * cosP,
  );
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

// Forza-style rotating minimap: heading-up, zoomed around the player, the
// track drawn as a cased ribbon, player as an arrow at the centre
const minimap = (() => {
  const wrap = document.getElementById('minimap');
  const cv = document.getElementById('minimapCanvas');
  const S = 170;
  const R = S / 2 - 3;               // visible circle radius
  const RANGE = 165;                 // metres of world shown from centre to rim
  const dpr = Math.min(devicePixelRatio, 2);
  cv.width = cv.height = S * dpr;
  cv.style.width = cv.style.height = `${S}px`;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  let ready = false;
  let smoothYaw = 0, yawInit = false;

  function build() {
    ready = wayPts.length >= 20;
    wrap.style.display = ready ? 'block' : 'none';
    yawInit = false;
  }

  function draw() {
    if (!ready || !car) return;
    // ease the rotation so the map doesn't jitter with steering corrections
    let dy = state.yaw - smoothYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    if (!yawInit) { smoothYaw = state.yaw; yawInit = true; }
    else smoothYaw += dy * 0.15;
    const sin = Math.sin(smoothYaw), cos = Math.cos(smoothYaw);
    const k = R / RANGE;
    const cx = car.position.x, cz = car.position.z;
    // world offset -> map px: right of car = +x, ahead of car = -y (up)
    const toMap = (wx, wz) => {
      const dx = wx - cx, dz = wz - cz;
      return [(dx * cos - dz * sin) * k, -(dx * sin + dz * cos) * k];
    };

    g.clearRect(0, 0, S, S);
    g.save();
    g.translate(S / 2, S / 2);
    g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.clip();
    g.fillStyle = 'rgba(8,11,16,.78)';
    g.fillRect(-S / 2, -S / 2, S, S);

    // track ribbon (casing + fill), only segments near enough to matter
    g.lineJoin = g.lineCap = 'round';
    const n = wayPts.length;
    const lim2 = (RANGE * 1.9) ** 2;
    const path = new Path2D();
    let pen = false;
    for (let i = 0; i <= n; i++) {
      const p = wayPts[i % n];
      const dx = p.x - cx, dz = p.z - cz;
      if (dx * dx + dz * dz > lim2) { pen = false; continue; }
      const [u, v] = toMap(p.x, p.z);
      pen ? path.lineTo(u, v) : path.moveTo(u, v);
      pen = true;
    }
    g.strokeStyle = 'rgba(0,0,0,.85)';
    g.lineWidth = 14 * k;             // road ribbon casing (metres * px/m)
    g.stroke(path);
    g.strokeStyle = 'rgba(228,234,242,.92)';
    g.lineWidth = 10 * k;             // inner fill
    g.stroke(path);
    g.strokeStyle = 'rgba(120,130,145,.9)';
    g.setLineDash([3, 5]);
    g.lineWidth = 1;
    g.stroke(path);                   // centreline
    g.setLineDash([]);

    // start/finish: short checkered bar across the track
    {
      const a = wayPts[0], b = wayPts[1];
      const [u, v] = toMap(a.x, a.z);
      if (u * u + v * v < (R + 20) ** 2) {
        const [u2, v2] = toMap(b.x, b.z);
        g.save();
        g.translate(u, v);
        g.rotate(Math.atan2(v2 - v, u2 - u) + Math.PI / 2);
        const hw = 10 * k / 2;
        for (let s = 0; s < 4; s++) {
          g.fillStyle = s % 2 ? '#111' : '#fff';
          g.fillRect(-hw + (s * hw) / 2, -2, hw / 2, 4);
        }
        g.restore();
      }
    }

    // rivals
    for (const ai of race.ais) {
      const [u, v] = toMap(ai.group.position.x, ai.group.position.z);
      if (u * u + v * v > (R + 8) ** 2) continue;
      g.fillStyle = ai.color;
      g.strokeStyle = 'rgba(255,255,255,.9)';
      g.lineWidth = 1.4;
      g.beginPath(); g.arc(u, v, 4, 0, Math.PI * 2); g.fill(); g.stroke();
    }

    // player arrow at centre, pointing up
    g.fillStyle = '#e8412c';
    g.strokeStyle = '#fff';
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(0, -7); g.lineTo(5.2, 5.6); g.lineTo(0, 2.6); g.lineTo(-5.2, 5.6);
    g.closePath(); g.fill(); g.stroke();

    // north tick on the rim (world -z mapped through the same rotation)
    {
      const nu = Math.sin(smoothYaw), nv = Math.cos(smoothYaw);
      const px = nu * (R - 9), py = nv * (R - 9);
      g.fillStyle = 'rgba(255,255,255,.85)';
      g.font = '700 9px "Avenir Next", system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('N', px, py);
    }
    g.restore();

    // rim
    g.strokeStyle = 'rgba(255,255,255,.22)';
    g.lineWidth = 1.5;
    g.beginPath(); g.arc(S / 2, S / 2, R, 0, Math.PI * 2); g.stroke();
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
    const kmh = info.speed * 3.6;
    speedo.draw(kmh, gearLabel(info.forwardSpeed, carSpec.topSpeed), dt);
    minimap.draw();
    surfaceEl.style.opacity = state.onRoad ? 0 : 1;
    perfTick(dt);
  }
  postProcessing.render();
}
renderer.setAnimationLoop(animate); // also awaits async WebGPU device init

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
