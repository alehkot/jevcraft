'use strict';
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { isDoor, doorPairMatches } = require('./doors');
const isBed = name => typeof name === 'string' && name.endsWith('_bed');
const bedDirections = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const opposite = { north: 'south', south: 'north', east: 'west', west: 'east' };
const directions = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)];

// Furnishings a design may place (rkhazh/jevcraft df911c12): a table as it
// comes; a furnace, smoker, blast furnace, barrel, stonecutter or loom with
// its front to a side, which it turns to the player placing it (a stair turns
// its back); a single chest the same, never beside another of its kind, which
// it would join. Copper chests weather into other blocks and are left out.
const plainFurnishings = new Set(['crafting_table', 'cartography_table', 'smithing_table', 'fletching_table', 'enchanting_table']);
const facingFurnishings = new Set(['furnace', 'blast_furnace', 'smoker', 'barrel', 'stonecutter', 'loom']);
const singleChest = name => name === 'chest' || name === 'trapped_chest';
const furnishingPlacement = name => plainFurnishings.has(name) ? 'plain' : facingFurnishings.has(name) ? 'facing' : singleChest(name) ? 'single_container' : null;
// The way the bot looks as it places `material` to face `facing`.
const placementFacing = (material, facing) => ['facing', 'single_container'].includes(furnishingPlacement(material)) ? opposite[facing] : facing;
// A barrel faces up or down too, by the pitch it is placed at: looking level, it faces a side.
const placementPitch = (material, aimPitch) => material === 'barrel' ? 0 : aimPitch;
function assertPlacementFootprint(bot, p, material) {
  if (!singleChest(material)) return;
  for (const [dx, dz] of Object.values(bedDirections)) {
    const other = bot.blockAt(new Vec3(p.x + dx, p.y, p.z + dz));
    if (!other) throw new Error(`Cannot see beside the ${material.replaceAll('_', ' ')} at ${p}`);
    if (other.name === material) throw new Error(`A ${material.replaceAll('_', ' ')} at ${p} would join the one beside it`);
  }
}

// The design contract exposes just the states we can deliberately place.
// Minecraft derives stair corners from neighbors; the designer cannot force
// shape, waterlogging, power, or arbitrary registry state IDs.
function regionProperties(material, value) {
  if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('invalid block properties');
  const properties = Object.fromEntries(Object.entries(value || {}).filter(([, v]) => v !== null));
  if (Object.keys(value || {}).some(k => !['facing', 'half'].includes(k))) throw new Error('unsupported block property');
  const stair = material.endsWith('_stairs'), slab = material.endsWith('_slab'), furnishing = furnishingPlacement(material);
  if (furnishing === 'facing' || furnishing === 'single_container') {
    if (!Object.hasOwn(opposite, properties.facing) || properties.half !== undefined) throw new Error(`${material} needs a cardinal facing and no half`);
    return { facing: properties.facing, ...(furnishing === 'single_container' && { type: 'single', waterlogged: false }) };
  }
  if (isBed(material)) {
    if (!Object.hasOwn(opposite, properties.facing)) throw new Error(`${material} needs a cardinal facing`);
    if (properties.half !== undefined) throw new Error('bed regions specify the foot position; half must be null');
    return { facing: properties.facing, part: 'foot' };
  }
  if (isDoor(material)) {
    if (!Object.hasOwn(opposite, properties.facing)) throw new Error(`${material} needs a cardinal facing`);
    if (properties.half !== undefined) throw new Error('door regions specify the bottom position; half must be null');
    return { facing: properties.facing, half: 'lower' };
  }
  if (!stair && !slab) {
    if (Object.keys(properties).length) throw new Error(`${material} does not support oriented properties`);
    return undefined;
  }
  if (!['top', 'bottom'].includes(properties.half)) throw new Error(`${material} needs half top or bottom`);
  if (stair && !Object.hasOwn(opposite, properties.facing)) throw new Error(`${material} needs a cardinal facing`);
  if (slab && properties.facing !== undefined) throw new Error('slabs do not have a facing');
  return stair ? { facing: properties.facing, half: properties.half, waterlogged: false } : { type: properties.half, waterlogged: false };
}

function matchesBuildBlock(block, cell) {
  if (!block || block.name !== cell.material) return false;
  const observed = block.getProperties?.() || {};
  return Object.entries(cell.properties || {}).every(([key, value]) => String(observed[key]) === String(value));
}

function buildFootprint(cell) {
  if (isBed(cell.material) && cell.properties?.part === 'foot') {
    const [dx, dz] = bedDirections[cell.properties.facing];
    return [cell, { ...cell, x: cell.x + dx, z: cell.z + dz, companion: true, properties: { ...cell.properties, part: 'head' } }];
  }
  return isDoor(cell.material) && cell.properties?.half === 'lower' ? [cell,
    { ...cell, y: cell.y + 1, companion: true, properties: { ...cell.properties, half: 'upper' } }] : [cell];
}

// A planned cell with no open face is sealed inside the structure's own mass or
// the hillside it was cut into. Nothing can see it, and placement needs a
// visible face, so nothing can ever reach it either. Swapping the block there
// would change nothing observable, while treating it as outstanding blocks an
// otherwise finished building for ever.
function enclosedCell(bot, cell) {
  if (!bot.blockAt) return false;
  const p = new Vec3(cell.x, cell.y, cell.z);
  // A wrongly oriented piece of our own material is a mistake to correct, not
  // a buried cell to forgive. Burial only excuses a cell that was never built:
  // air, or the terrain the structure was cut into.
  if (bot.blockAt(p)?.name === cell.material) return false;
  return directions.every(face => bot.blockAt(p.plus(face))?.boundingBox === 'block');
}

function bedPairMatches(foot, head) {
  if (!foot || !head || !isBed(foot.name) || foot.name !== head.name) return false;
  const a = foot.getProperties?.() || {}, b = head.getProperties?.() || {};
  return a.part === 'foot' && b.part === 'head' && Object.hasOwn(bedDirections, a.facing) && a.facing === b.facing;
}

// Schematic beds are drawn on full blocks. A slab has a "block" bounding box
// too, so check the actual collision shape when reading the world.
function bedFloor(block) {
  return block?.boundingBox === 'block' && block.shapes?.some(
    ([x, y, z, X, Y, Z]) => x === 0 && y === 0 && z === 0 && X === 1 && Y === 1 && Z === 1);
}

function buildCellComplete(bot, cell) {
  // Objective diagnostics inspect every schematic cell, including companions.
  // A head is complete only when its owning foot and both orientations agree.
  if (isBed(cell.material) && cell.properties?.part === 'head') {
    const [dx, dz] = bedDirections[cell.properties.facing];
    return buildCellComplete(bot, { ...cell, x: cell.x - dx, z: cell.z - dz, companion: false, properties: { ...cell.properties, part: 'foot' } });
  }
  const parts = buildFootprint(cell), observed = parts.map(p => bot.blockAt(new Vec3(p.x, p.y, p.z)));
  if (isBed(cell.material) && parts.length === 2) return parts.every((p, i) => matchesBuildBlock(observed[i], p)) && bedPairMatches(...observed);
  if (parts.every((p, i) => matchesBuildBlock(observed[i], p)) && (parts.length === 1 || doorPairMatches(...observed))) return true;
  return parts.every(p => enclosedCell(bot, p));
}

function blockOwnership(block) {
  if (isBed(block.name)) {
    const p = block.getProperties?.() || {};
    return { stateId: block.stateId, name: block.name, properties: { facing: p.facing, part: p.part } };
  }
  // A furnace lit or a barrel open is in use, not replaced.
  if (furnishingPlacement(block.name)) {
    const p = block.getProperties?.() || {};
    return { stateId: block.stateId, name: block.name, properties: Object.fromEntries(Object.entries(p).filter(([k]) => !['lit', 'open'].includes(k))) };
  }
  if (!isDoor(block.name)) return block.stateId ?? block.name;
  const p = block.getProperties();
  // Opening a door or powering it is normal use, not replacement of the bot's
  // work. Keep its identity and static orientation when recording ownership.
  return { stateId: block.stateId, name: block.name, properties: { facing: p.facing, half: p.half, hinge: p.hinge } };
}

function matchesOwnership(block, owned) {
  return owned && typeof owned === 'object' ? matchesBuildBlock(block, { material: owned.name, properties: owned.properties }) :
    owned === (block.stateId ?? block.name);
}

function placementGoal(bot, point, cell = {}) {
  const p = new Vec3(point.x, point.y, point.z), state = cell.properties || {};
  if (isDoor(cell.material) || isBed(cell.material)) return new goals.GoalPlaceBlock(p, bot.world, { range: 4.25, facing: opposite[state.facing], faces: [new Vec3(0, -1, 0)] });
  const half = state.half || state.type;
  // GoalPlaceBlock's facing means the face toward the player, opposite the
  // player's horizontal look direction used by Minecraft for stairs.
  const goal = new goals.GoalPlaceBlock(p, bot.world, { range: 4.25, facing: opposite[placementFacing(cell.material, state.facing)] });
  if (!half) return goal;
  goal.facesPos = [];
  for (const face of directions) {
    if (face.y && face.y !== (half === 'bottom' ? -1 : 1)) continue;
    const ref = p.plus(face), block = bot.blockAt(ref);
    if (!block) continue;
    // Clicking the exposed horizontal face of the same half slab would merge
    // it into a double slab instead of placing the requested neighboring cell.
    if (face.y && cell.material?.endsWith('_slab') && block.name === cell.material && block.getProperties?.().type !== 'double') continue;
    for (const shape of block.shapes || []) {
      let lo = shape[1], hi = shape[4];
      if (!face.y) { lo = Math.max(lo, half === 'top' ? .5 : 0); hi = Math.min(hi, half === 'bottom' ? .5 : 1); }
      if (hi <= lo) continue;
      const center = new Vec3((shape[0] + shape[3]) / 2, (lo + hi) / 2, (shape[2] + shape[5]) / 2);
      if (face.x) center.x = face.x > 0 ? shape[0] : shape[3];
      if (face.y) center.y = face.y > 0 ? shape[1] : shape[4];
      if (face.z) center.z = face.z > 0 ? shape[2] : shape[5];
      goal.facesPos.push([face, center.plus(ref), ref]);
    }
  }
  return goal;
}

module.exports = { furnishingPlacement, placementFacing, placementPitch, assertPlacementFootprint, isBed, bedFloor, bedPairMatches, regionProperties, matchesBuildBlock, placementGoal, buildFootprint, buildCellComplete, enclosedCell, blockOwnership, matchesOwnership };
