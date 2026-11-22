'use strict';
// Torches: where it is dark enough for monsters to spawn, and putting light
// there. Since 1.18 a monster spawns only at block light 0, and a torch gives
// 14, one less a block, so a cell within thirteen steps of a torch (along
// the grid) is lit. Mineflayer on 26.1 does not apply the server's light
// updates (a torch set beside the bot read light 0 at every distance, the
// arena, 2026-09-24), so light is worked out here from the sources in view.
// Light propagates through connected, loaded openings and around corners.
const { Vec3 } = require('vec3');

const EMISSION = {
  torch: 14, wall_torch: 14, lantern: 15, soul_torch: 10, soul_wall_torch: 10, soul_lantern: 10, glowstone: 15, sea_lantern: 15,
  jack_o_lantern: 15, lava: 15, campfire: 15, shroomlight: 15, redstone_torch: 7, redstone_wall_torch: 7, end_rod: 14, froglight: 15,
  ochre_froglight: 15, verdant_froglight: 15, pearlescent_froglight: 15,
};
const taxicab = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);

function lightSources(bot, centre, radius = 16) {
  const ids = Object.keys(EMISSION).map(n => bot.registry?.blocksByName?.[n]?.id).filter(id => id !== undefined);
  if (!ids.length || typeof bot.findBlocks !== 'function') return [];
  return (bot.findBlocks({ matching: ids, maxDistance: radius + 15, count: 256, point: centre }) || [])
    .map(p => {
      const block = bot.blockAt(p), lit = block?.getProperties?.().lit;
      return { position: p, emission: lit === false || lit === 'false' ? 0 : EMISSION[block?.name] || 0 };
    }).filter(s => s.emission);
}

const neighbours = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const key = p => `${p.x},${p.y},${p.z}`;

// Multi-source propagation. Only visit cells that could still illuminate the
// sampled area. A sealed wall can separate two dark rooms a block apart.
function propagatedLight(bot, cells, sources) {
  const levels = new Map();
  if (!cells.length || !sources.length) return levels;
  const lo = cells[0].clone(), hi = lo.clone();
  for (const p of cells) for (const axis of ['x', 'y', 'z']) {
    lo[axis] = Math.min(lo[axis], p[axis]); hi[axis] = Math.max(hi[axis], p[axis]);
  }
  const distance = p => Math.max(0, lo.x - p.x, p.x - hi.x) + Math.max(0, lo.y - p.y, p.y - hi.y) + Math.max(0, lo.z - p.z, p.z - hi.z);
  const layers = Array.from({ length: 16 }, () => []);
  for (const { position, emission } of sources) {
    if (emission > distance(position)) layers[emission].push(position);
  }
  for (let level = 15; level > 0; level--) for (const p of layers[level]) {
    const id = key(p);
    if (levels.has(id)) continue;
    levels.set(id, level);
    if (level < 2) continue;
    for (const offset of neighbours) {
      const q = p.offset(...offset);
      if (distance(q) >= level - 1 || levels.has(key(q))) continue;
      const block = bot.blockAt(q);
      if (!block || (!block.transparent && block.boundingBox !== 'empty')) continue;
      const cost = Math.max(1, block.filterLight || 0);
      if (level > cost) layers[level - cost].push(q);
    }
  }
  return levels;
}

function blockLight(cell, sources, bot) {
  if (bot) return propagatedLight(bot, [cell], sources).get(key(cell)) || 0;
  return Math.max(0, ...sources.map(s => s.emission - taxicab(cell, s.position)));
}

const solidTop = b => !!b && b.boundingBox === 'block' && !/farmland|slab|stairs|leaves|glass|ice|fence|wall|_bed$|chest|furnace|crafting_table|torch|lantern/.test(b.name);
const clearCell = b => b && (b.boundingBox === 'empty' && !/water|lava/.test(b.name));
// Where a monster could stand: solid ground, two clear cells over it.
function spawnable(bot, cell) {
  return solidTop(bot.blockAt(cell.offset(0, -1, 0))) && clearCell(bot.blockAt(cell)) && clearCell(bot.blockAt(cell.offset(0, 1, 0)));
}

// The cells among `cells` (standing cells) a monster could spawn in: block
// light 0. Open ground counts: under the sky monsters spawn there at night,
// and a torch stops that as it does in a cave.
function darkCells(bot, cells, sources = null) {
  const list = cells.map(c => new Vec3(c.x, c.y, c.z));
  const lit = sources || lightSources(bot, list[0] || bot.entity.position);
  const levels = propagatedLight(bot, list, lit);
  return list.filter(c => spawnable(bot, c) && !levels.has(key(c)));
}

// Torches enough to light them: the cell covering most of the dark ones,
// again and again. Returns the cells to put torches in.
function torchPlan(cells, max = 8, bot) {
  let dark = cells.slice();
  const plan = [];
  while (dark.length && plan.length < max) {
    let best = null, covered = -1;
    for (const c of dark) {
      if (bot && !['air', 'cave_air', 'void_air'].includes(bot.blockAt(c)?.name)) continue;
      const n = dark.filter(d => taxicab(c, d) < 14).length; if (n > covered) { best = c; covered = n; } }
    if (!best) break;
    plan.push(best);
    if (bot) {
      const lit = propagatedLight(bot, dark, [{ position: best, emission: 14 }]);
      dark = dark.filter(p => !lit.has(key(p)));
    } else dark = dark.filter(d => taxicab(best, d) >= 14);
  }
  return plan;
}

// Every standing cell over the ground in a square around `centre`: what a
// home, or the ground around the bot, is lit by.
function groundCells(bot, centre, radius) {
  const cells = [];
  for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) {
    for (const dy of [0, -1, 1, -2, 2, -3, 3]) {
      const c = centre.offset(x, dy, z);
      if (spawnable(bot, c)) { cells.push(c); break; }
    }
  }
  return cells;
}

// Stay on the reachable floor around the request. A torch in the next
// sealed room or on the roof does not belong to "light up this room".
function connectedGround(bot, centre, radius) {
  const cells = groundCells(bot, centre, radius);
  const columns = new Map(cells.map(p => [p.x + ',' + p.z, p]));
  const seed = columns.get(centre.x + ',' + centre.z) || cells.filter(p => p.distanceTo(centre) <= 1.5)
    .sort((a,b) => a.distanceTo(centre) - b.distanceTo(centre))[0];
  if (!seed || Math.abs(seed.y - centre.y) > 1) return [];
  const queue = [seed], seen = new Set([key(seed)]);
  for (let i=0; i<queue.length; i++) {
    const p = queue[i];
    for (const [dx,dz] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const next = columns.get((p.x+dx) + ',' + (p.z+dz));
      if (!next || seen.has(key(next)) || Math.abs(next.y-p.y)>1) continue;
      seen.add(key(next)); queue.push(next);
    }
  }
  return queue;
}

async function placeTorches(bot, task, actions, cells, { max = 8 } = {}) {
  let placed = 0;
  for (const cell of cells.slice(0, max)) {
    task.check();
    if (!bot.inventory.items().some(i => i.name === 'torch')) break;
    if (!darkCells(bot, [cell]).length || !['air', 'cave_air', 'void_air'].includes(bot.blockAt(cell)?.name)) continue;
    try { await actions.place(bot, task, cell, 'torch'); placed++; }
    catch (err) { task.check(); if (['NeedsAir', 'NeedsSafety', 'Cancelled'].includes(err.name)) throw err; }
  }
  return placed;
}

module.exports = { EMISSION, propagatedLight, lightSources, blockLight, spawnable, darkCells, torchPlan, groundCells, connectedGround, placeTorches };
