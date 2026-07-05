#!/usr/bin/env node
// Offline AI simulator: replicates AICar.update() from main.js over the
// shipped racing line, no browser needed. Reports per-rival lap times and
// how far outside the road edge they ever get.
//
//   node tools/simai.js            # current tuning (A_LAT 12 + corridor clamp)
//   node tools/simai.js --old      # pre-fix tuning (A_LAT 15, no clamp)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OLD = process.argv.includes('--old');
const here = dirname(fileURLToPath(import.meta.url));
const wayPts = JSON.parse(readFileSync(join(here, '../assets/racingline.json'), 'utf8')).pts;
const n = wayPts.length;

// --- specs copied from main.js ---
const CARS = {
  hemicuda: { topSpeed: 72, accel: 15.0 },
  mustang:  { topSpeed: 63, accel: 12.0 },
  chiron:   { topSpeed: 105, accel: 22.0 },
};
const RIVALS = [
  { key: 'hemicuda', skill: 0.99, latOffset: -1.8 },
  { key: 'mustang',  skill: 0.93, latOffset: 1.6 },
  { key: 'chiron',   skill: 0.87, latOffset: 0 },
];

function computeCornerSpeeds(pts) {
  const A_LAT = OLD ? 15 : 12, A_BRK = 15, VMAX = 88, WP_STEP = 7;
  const sp = new Float32Array(n);
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
const wpSpeeds = computeCornerSpeeds(wayPts);

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const d2 = (px, pz, w) => { const dx = px - w.x, dz = pz - w.z; return dx * dx + dz * dz; };

// signed lateral offset from the segment idx -> idx+1
function lateral(px, pz, idx) {
  const a = wayPts[idx], b = wayPts[(idx + 1) % n];
  let tx = b.x - a.x, tz = b.z - a.z;
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl; tz /= tl;
  return { lat: (px - a.x) * tz - (pz - a.z) * tx, tx, tz };
}

function simulate(r) {
  const spec = CARS[r.key];
  let x = wayPts[0].x, z = wayPts[0].z;
  let idx = 0, lap = 0, speed = 0, steer = 0;
  const b0 = wayPts[2];
  let yaw = Math.atan2(b0.x - x, b0.z - z);
  const dt = 1 / 60;
  const stats = { maxOver: 0, overSteps: 0, steps: 0, laps: [], maxLat: 0 };
  let lapT = 0;

  for (let t = 0; t < 60 * 60 * 12 && lap < 3; t++) { // cap 12 min sim time
    stats.steps++; lapT += dt;
    for (let k = 0; k < 6; k++) {
      const j = (idx + 1) % n;
      if (d2(x, z, wayPts[j]) < d2(x, z, wayPts[idx])) {
        idx = j;
        if (j === 0) { lap++; stats.laps.push(lapT); lapT = 0; }
      } else break;
    }
    const lookN = 2 + Math.floor(speed / 9);
    const t1 = wayPts[(idx + lookN) % n], t2 = wayPts[(idx + lookN + 1) % n];
    let hx = t2.x - t1.x, hz = t2.z - t1.z;
    const hl = Math.hypot(hx, hz) || 1;
    const off = r.latOffset * Math.min(1, (t1.w - 5) / 8);
    const tx2 = t1.x + (hz / hl) * off, tz2 = t1.z + (-hx / hl) * off;
    const desired = Math.atan2(tx2 - x, tz2 - z);
    let err = desired - yaw;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const maxTurn = (1.5 + 1.2 / (1 + speed * 0.06)) * dt;
    yaw += clamp(err, -maxTurn, maxTurn);
    steer += (clamp(err * 2, -1, 1) - steer) * Math.min(1, dt * 6);
    let target = Math.min(wpSpeeds[idx] * r.skill, spec.topSpeed * 0.97);
    target *= 1 - Math.min(0.6, Math.abs(err) * 0.8);
    if (target > speed) speed = Math.min(target, speed + spec.accel * 0.9 * dt);
    else speed = Math.max(target, speed - 22 * dt);
    x += Math.sin(yaw) * speed * dt;
    z += Math.cos(yaw) * speed * dt;
    if (!OLD) {
      const { lat, tx, tz } = lateral(x, z, idx);
      const halfW = Math.max(2.5, (wayPts[idx].w || 8) / 2 - 1.4);
      if (Math.abs(lat) > halfW) {
        const fix = (Math.abs(lat) - halfW) * Math.sign(lat);
        x -= tz * fix;
        z += tx * fix;
        speed *= 1 - Math.min(0.5, dt * 2);
      }
    }
    // measure against the actual road edge (half the recorded width)
    const { lat } = lateral(x, z, idx);
    const edge = (wayPts[idx].w || 8) / 2;
    stats.maxLat = Math.max(stats.maxLat, Math.abs(lat));
    if (Math.abs(lat) > edge) {
      stats.overSteps++;
      stats.maxOver = Math.max(stats.maxOver, Math.abs(lat) - edge);
    }
  }
  return stats;
}

console.log(`racing line: ${n} waypoints, tuning: ${OLD ? 'OLD (A_LAT 15, no clamp)' : 'NEW (A_LAT 12 + corridor clamp)'}`);
for (const r of RIVALS) {
  const s = simulate(r);
  const laps = s.laps.map(t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`).join(' ');
  console.log(
    `${r.key.padEnd(9)} laps [${laps}]  ` +
    `off-road: ${(100 * s.overSteps / s.steps).toFixed(2)}% of steps, ` +
    `worst ${s.maxOver.toFixed(2)} m past edge, max |lat| ${s.maxLat.toFixed(1)} m`
  );
}
