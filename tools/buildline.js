// One-off racing-line builder. Run in the live game page (needs window.__dbg):
//   import('/tools/buildline.js')
// then poll window.__lineStatus / window.__builtLine.
//
// Strategy: flood-fill a grid over the drivable racing surface from the
// spawn, then extract the circuit loop as two vertex-disjoint shortest
// paths between the spawn and a far point on the loop.

const d = window.__dbg;
const THREE = d.THREE;
const CELL = 3.5;

window.__lineStatus = 'starting';
window.__builtLine = null;

const rc = new THREE.Raycaster();
rc.far = 2000;
rc.firstHitOnly = false;
const DOWN = new THREE.Vector3(0, -1, 0);
const isRacing = h => /asfalto|tarmac|asphalt|road_liso/.test(
  ((h.object.material && h.object.material.map && h.object.material.map.name) || '').toLowerCase());

// topmost racing-surface hit near refY; buried asphalt (something resting
// just above it) doesn't count
function surfAt(x, z, refY, tol = 3) {
  rc.set(new THREE.Vector3(x, refY + 25, z), DOWN);
  const hits = rc.intersectObjects(d.trackMeshes, false);
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (!isRacing(h)) continue;
    if (Math.abs(h.point.y - refY) > tol) continue;
    if (i > 0 && hits[i - 1].point.y - h.point.y < 2.2) continue;
    return h.point.y;
  }
  return null;
}

const key = (ix, iz) => ix * 100000 + iz;

async function main() {
  const t0 = performance.now();
  const spawn = d.spawn;
  const cells = new Map(); // key -> {ix, iz, x, z, y, dist, parent, blocked}

  // ---- flood fill
  window.__lineStatus = 'flood-fill';
  const six = Math.round(spawn.pos.x / CELL), siz = Math.round(spawn.pos.z / CELL);
  const y0 = surfAt(six * CELL, siz * CELL, spawn.pos.y, 5);
  if (y0 === null) { window.__lineStatus = 'FAIL: spawn not on surface'; return; }
  const start = { ix: six, iz: siz, x: six * CELL, z: siz * CELL, y: y0, dist: 0, parent: null };
  cells.set(key(six, siz), start);
  const queue = [start];
  let qi = 0;
  const N8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  while (qi < queue.length) {
    const c = queue[qi++];
    for (const [dx, dz] of N8) {
      const ix = c.ix + dx, iz = c.iz + dz;
      const k = key(ix, iz);
      if (cells.has(k)) continue;
      const x = ix * CELL, z = iz * CELL;
      const y = surfAt(x, z, c.y);
      if (y === null) { cells.set(k, null); continue; }
      const n = { ix, iz, x, z, y, dist: c.dist + 1, parent: c };
      cells.set(k, n);
      queue.push(n);
    }
    if (qi % 4000 === 0) {
      window.__lineStatus = `flood-fill ${qi}/${queue.length}`;
      await new Promise(r => setTimeout(r));
    }
  }
  const drivable = queue.length;

  // ---- pick M: drivable cell nearest the far side of the loop
  // (a point on the western leg, read off the exploration map)
  const MX = -1319, MZ = 200;
  let M = null, bestD = Infinity;
  for (const c of queue) {
    if (!c) continue;
    const dx = c.x - MX, dz = c.z - MZ;
    const dd = dx * dx + dz * dz;
    if (dd < bestD) { bestD = dd; M = c; }
  }

  // ---- BFS shortest path helper (re-runs over the cell graph)
  function bfs(src, dst, blockedSet) {
    const dist = new Map(), par = new Map();
    dist.set(key(src.ix, src.iz), 0);
    const q = [src];
    let i = 0;
    while (i < q.length) {
      const c = q[i++];
      if (c === dst) break;
      for (const [dx, dz] of N8) {
        const k = key(c.ix + dx, c.iz + dz);
        const n = cells.get(k);
        if (!n || dist.has(k)) continue;
        if (blockedSet && blockedSet.has(k)) continue;
        dist.set(k, dist.get(key(c.ix, c.iz)) + 1);
        par.set(k, c);
        q.push(n);
      }
    }
    const dk = key(dst.ix, dst.iz);
    if (!par.has(dk) && src !== dst) return null;
    const path = [dst];
    let cur = dst;
    while (cur !== src) { cur = par.get(key(cur.ix, cur.iz)); path.push(cur); }
    return path.reverse();
  }

  window.__lineStatus = 'path 1';
  await new Promise(r => setTimeout(r));
  const p1 = bfs(start, M, null);
  if (!p1) { window.__lineStatus = 'FAIL: no path to M'; return; }

  // carve a corridor around path 1 (except near the endpoints) and route
  // the second, disjoint path — together they form the circuit loop
  window.__lineStatus = 'path 2';
  await new Promise(r => setTimeout(r));
  const blocked = new Set();
  const R = 3; // cells (~10.5 m)
  const endFree = 18; // cells (~63 m) around S and M stay open
  for (const c of p1) {
    const nearEnd =
      (Math.abs(c.ix - start.ix) < endFree && Math.abs(c.iz - start.iz) < endFree) ||
      (Math.abs(c.ix - M.ix) < endFree && Math.abs(c.iz - M.iz) < endFree);
    if (nearEnd) continue;
    for (let dx = -R; dx <= R; dx++)
      for (let dz = -R; dz <= R; dz++)
        blocked.add(key(c.ix + dx, c.iz + dz));
  }
  const p2 = bfs(start, M, blocked);
  if (!p2) { window.__lineStatus = 'FAIL: no disjoint return path'; return; }

  // ---- assemble the cycle S -> M (path1) -> S (path2 reversed)
  let cyc = p1.concat(p2.slice(0, p2.length - 1).reverse());

  // orient along spawn.yaw
  const a0 = cyc[0], a5 = cyc[Math.min(8, cyc.length - 1)];
  const fwd = { x: Math.sin(spawn.yaw), z: Math.cos(spawn.yaw) };
  if ((a5.x - a0.x) * fwd.x + (a5.z - a0.z) * fwd.z < 0) cyc = [cyc[0]].concat(cyc.slice(1).reverse());

  // ---- smooth (positions only) and thin to ~7 m spacing
  let pts = cyc.map(c => ({ x: c.x, y: c.y, z: c.z }));
  for (let pass = 0; pass < 4; pass++) {
    const n = pts.length;
    pts = pts.map((p, i) => {
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      return { x: (a.x + 2 * p.x + b.x) / 4, y: p.y, z: (a.z + 2 * p.z + b.z) / 4 };
    });
  }
  const out = [];
  let acc = 1e9, prev = null;
  for (const p of pts) {
    if (prev) acc += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
    if (acc >= 7) { out.push(p); acc = 0; }
  }

  // ---- centre each waypoint between the road edges + measure width
  window.__lineStatus = 'centering';
  const centered = [];
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    const nx = out[(i + 1) % out.length];
    const yaw = Math.atan2(nx.x - p.x, nx.z - p.z);
    const px = Math.cos(yaw), pz = -Math.sin(yaw);
    const extent = sign => {
      let e = 0;
      for (let t = 0.75; t <= 18; t += 0.75) {
        if (surfAt(p.x + px * t * sign, p.z + pz * t * sign, p.y, 2) !== null) e = t; else break;
      }
      return e;
    };
    const r = extent(1), l = extent(-1);
    const off = (r - l) / 2;
    const q = { x: p.x + px * off, y: p.y, z: p.z + pz * off, w: Math.max(r + l, 6) };
    const qy = surfAt(q.x, q.z, p.y, 3);
    if (qy !== null) q.y = qy;
    centered.push(q);
    if (i % 80 === 0) {
      window.__lineStatus = `centering ${i}/${out.length}`;
      await new Promise(r2 => setTimeout(r2));
    }
  }
  // final light smoothing of the centred line
  for (let pass = 0; pass < 2; pass++) {
    const n = centered.length;
    for (let i = 0; i < n; i++) {
      const a = centered[(i - 1 + n) % n], b = centered[(i + 1) % n], p = centered[i];
      p.x = (a.x + 2 * p.x + b.x) / 4;
      p.z = (a.z + 2 * p.z + b.z) / 4;
    }
  }

  const lengthM = centered.reduce((s, p, i) => {
    const n = centered[(i + 1) % centered.length];
    return s + Math.hypot(n.x - p.x, n.z - p.z);
  }, 0);

  window.__builtLine = {
    cell: CELL,
    drivableCells: drivable,
    lengthM: Math.round(lengthM),
    pts: centered.map(p => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), w: +p.w.toFixed(1) })),
  };
  window.__lineStatus = `done in ${((performance.now() - t0) / 1000).toFixed(1)}s: ${centered.length} pts, ${Math.round(lengthM)} m`;
}

main().catch(e => { window.__lineStatus = 'FAIL: ' + (e.stack || e.message); });
