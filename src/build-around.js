'use strict';
// Building around what a player puts on a site while the bot builds there (asked for 2026-11-22: "jev should
// accomodate me participating in house builds i.e. if i put things that may disrupt jev's build and jev is in progress
// of building house he should replan and work around that instead of asking me to remove he can still ask to remove if
// something is certainly necessary"). A player's house once stopped on their grave (a player head, GravesX) and
// on a crafting table they had put down on the site, each with "The building site changed at ...; preserving the
// unexpected ...", and nothing more was built until a block was moved.
//
// A block on the site that the bot did not put there and may not clear (designer.js canClearSchematicBlock) is:
// - in the way of what the building is for: a door's cells, a bed's or a ladder's, the way in (the entrance, the
//   door's inside cell and the head room over both), a floor under a door or bed that is not a full block, or the only
//   walk from the door to a bed. Then the player is asked to move it, as before (work.js siteChanged);
// - else left where it stands while the rest is built (deferred), and when nothing else is left to do, taken into the
//   building: its cell dropped from the plan and kept in blueprint.preserved, as the blocks a site already had are at
//   its choosing (designer.js selectSchematicSite), with the bot's own torches, ladders or carpets that would have hung
//   on it when it is not a full block. One gone by then (a grave looted) is built as planned.
const { Vec3 } = require('vec3');

const key = p => `${p.x},${p.y},${p.z}`;
const xyz = k => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; };
const v = p => new Vec3(p.x, p.y, p.z);
const ATTACHED = /(?:^|_)(?:torch|ladder|button|lever|sign|carpet|pressure_plate|lantern|banner|rail|flower_pot|candle)$/;
const NOT_STURDY = /head|skull|carpet|slab|stairs|fence|wall|pane|bars|chest|anvil|_bed$|door|campfire|lantern|pot|candle|cake|banner|sign|button|plate|rail|torch|flower|sapling|grass|fern|vine|ladder|snow$|leaves|glass|ice$|scaffolding|cauldron|hopper|lectern|grindstone|bell|chain|rod|amethyst_cluster|bud$/;
const sturdy = block => !!block && block.boundingBox === 'block' && !NOT_STURDY.test(block.name || '');
const passable = block => !block || block.boundingBox === 'empty';
const H = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// The cells of a blueprint a player's block may not stand in, each with what it is for: { always: Map, floor: Map }
// (floor: only a sturdy block will do there).
function needs(blueprint) {
  const always = new Map(), floor = new Map();
  const put = (map, p, why) => { if (!map.has(key(p))) map.set(key(p), why); };
  const blocks = blueprint?.blocks || [], empty = new Set((blueprint?.empty || []).map(key));
  for (const c of blocks) {
    const m = String(c.material || '');
    if (/_door$/.test(m)) { put(always, c, 'the doorway'); put(floor, { ...c, y: c.y - 1 }, 'the floor under the door'); }
    else if (/_bed$/.test(m)) { put(always, c, "a bed's place"); put(floor, { ...c, y: c.y - 1 }, 'the floor under a bed'); }
    else if (m === 'ladder') put(always, c, "the ladder's place");
    // The way in: the cell inside each door, and the head room over it.
    if (/_door$/.test(m) && c.properties?.half !== 'upper') for (const [dx, dz] of H) {
      const inside = { x: c.x + dx, y: c.y, z: c.z + dz };
      if (empty.has(key(inside))) { put(always, inside, 'the way in'); put(always, { ...inside, y: inside.y + 1 }, 'the way in'); }
    }
  }
  if (blueprint?.entrance) { const e = blueprint.entrance; put(always, e, 'the way in'); put(always, { ...e, y: e.y + 1 }, 'the way in'); }
  try { for (const k of require('./construction-access').entrancePassage(blueprint)) if (!always.has(k)) always.set(k, 'the way in'); } catch (_) { /* none */ }
  return { always, floor };
}

// The walk from the door to the beds: interior air cells with air over them, stood on the plan's own floor. -> the
// keys of the cells beside a bed that the walk reaches, with `blocked` cells taken as walls.
function bedsReached(blueprint, blocked = new Set()) {
  const blocks = blueprint?.blocks || [];
  // A torch or a carpet planned in the way is walked through, as in the game.
  const SOFT = /torch|carpet|button|lever|sign|banner|rail|pressure_plate|lantern|candle|flower_pot|ladder/;
  const soft = new Set(blocks.filter(c => SOFT.test(c.material || '')).map(key));
  const solid = new Set(blocks.filter(c => !/_door$|_bed$/.test(c.material || '') && !SOFT.test(c.material || '')).map(key));
  const empty = new Set((blueprint?.empty || []).map(key));
  const open = k => (empty.has(k) || soft.has(k)) && !blocked.has(k);
  const walk = k => { const p = xyz(k); return open(k) && open(key({ ...p, y: p.y + 1 })) && solid.has(key({ ...p, y: p.y - 1 })); };
  const start = [];
  for (const c of blocks) if (/_door$/.test(c.material || '') && c.properties?.half !== 'upper')
    for (const [dx, dz] of H) { const k = key({ x: c.x + dx, y: c.y, z: c.z + dz }); if (walk(k)) start.push(k); }
  const seen = new Set(start), queue = [...start];
  while (queue.length) {
    const p = xyz(queue.shift());
    for (const [dx, dz] of H) for (const dy of [0, 1, -1]) {
      const k = key({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
      if (!seen.has(k) && walk(k)) { seen.add(k); queue.push(k); }
    }
  }
  const beside = new Set();
  for (const c of blocks) if (/_bed$/.test(c.material || '')) for (const [dx, dz] of H) {
    const k = key({ x: c.x + dx, y: c.y, z: c.z + dz });
    if (seen.has(k)) beside.add(k);
  }
  return beside;
}

// The player's blocks found on the site, sorted: { ask: the first that must go, or null; defer: the rest }.
function classify(bot, goal, cells) {
  const blueprint = goal?.blueprint, { always, floor } = needs(blueprint);
  const unique = [...new Map((cells || []).map(c => [key(c), { x: c.x, y: c.y, z: c.z }])).values()];
  const ask = unique.find(c => always.has(key(c)) || (floor.has(key(c)) && !sturdy(bot.blockAt(v(c)))));
  if (ask) return { ask: { ...ask, why: always.get(key(ask)) || floor.get(key(ask)) }, defer: [] };
  // In the only walk from the door to a bed: what is solid there is in the way.
  const walls = new Set(unique.filter(c => !passable(bot.blockAt(v(c)))).map(key));
  if (walls.size && (blueprint?.blocks || []).some(c => /_bed$/.test(c.material || ''))) {
    const before = bedsReached(blueprint), after = bedsReached(blueprint, walls);
    if (before.size && !after.size) {
      const inWay = unique.find(c => walls.has(key(c)) && (blueprint.empty || []).some(e => key(e) === key(c)));
      if (inWay) return { ask: { ...inWay, why: 'the only way to the beds' }, defer: [] };
    }
  }
  return { ask: null, defer: unique };
}

// Records the cells left for now: -> the names newly left (said once).
function note(goal, bot, cells) {
  const d = (goal.deferredCells ||= {}), fresh = [];
  for (const c of cells || []) {
    const k = key(c), name = bot.blockAt(v(c))?.name || 'block';
    if (!d[k]) { d[k] = { name, at: new Date().toISOString() }; fresh.push(name); }
    else d[k].name = name;
  }
  if (!Object.keys(d).length) delete goal.deferredCells;
  return fresh;
}

// The cells still left for the player's blocks: those whose block is still not the bot's to clear.
function deferredKeys(bot, goal, canClear) {
  const d = goal?.deferredCells || {}, out = new Set();
  for (const k of Object.keys(d)) {
    const block = bot.blockAt(v(xyz(k)));
    if (block && !canClear(goal.blueprint, goal.buildOwned, block)) out.add(k); else delete d[k];
  }
  if (goal?.deferredCells && !Object.keys(goal.deferredCells).length) delete goal.deferredCells;
  return out;
}

// Takes the player's blocks still standing into the building: -> their names, or [] for none.
function accept(bot, goal, canClear) {
  const bp = goal?.blueprint;
  if (!bp) return [];
  const keys = deferredKeys(bot, goal, canClear);
  if (!keys.size) { delete goal.deferredCells; return []; }
  const names = [...keys].map(k => bot.blockAt(v(xyz(k)))?.name || goal.deferredCells?.[k]?.name || 'block');
  const soft = [...keys].filter(k => !sturdy(bot.blockAt(v(xyz(k))))).map(xyz);
  const hangs = c => ATTACHED.test(c.material || '') && soft.some(s => Math.abs(s.x - c.x) + Math.abs(s.y - c.y) + Math.abs(s.z - c.z) === 1);
  bp.blocks = bp.blocks.filter(c => !keys.has(key(c)) && !hangs(c));
  bp.empty = (bp.empty || []).filter(c => !keys.has(key(c)));
  if (bp.terrain) {
    if (Array.isArray(bp.terrain.clear)) bp.terrain.clear = bp.terrain.clear.filter(c => !keys.has(key(c)));
    if (Array.isArray(bp.terrain.fill)) bp.terrain.fill = bp.terrain.fill.filter(c => !keys.has(key(c)));
  }
  const kept = new Set((bp.preserved || []).map(key));
  bp.preserved = [...(bp.preserved || []), ...[...keys].filter(k => !kept.has(k)).map(xyz)];
  for (const k of keys) if (goal.buildOwned) delete goal.buildOwned[k];
  delete goal.deferredCells; delete goal.buildBatch;
  return names;
}

// "crafting table and 2 player heads": said after "your" (work.js), so with no article of its own
function said(names) {
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  const parts = [...counts].map(([n, c]) => c === 1 ? n.replaceAll('_', ' ') : `${c} ${n.replaceAll('_', ' ')}s`);
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

module.exports = { needs, bedsReached, classify, note, deferredKeys, accept, said, sturdy };
