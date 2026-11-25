'use strict';
const { move } = require('./motion');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { surveyRoute, navigate } = require('./skills');
const { checkAir } = require('./vitals');
const { placementGoal, buildCellComplete, buildFootprint, isBed } = require('./build-blocks');
const key = p => `${p.x},${p.y},${p.z}`;
const vec = p => new Vec3(p.x, p.y, p.z);
const directions = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)];

// A work destination is a visible face within arm's reach, not an adjacent
// walkable cell. In particular the worker can clear a high bank from below.
class ConstructionGoal extends goals.Goal {
  constructor(bot, point, operation, cell) {
    super(); this.bot = bot; this.pos = vec(point); this.operation = operation;
    if (operation === 'place') this.placement = placementGoal(bot, point, cell);
    // The head of a bed to be placed is no place to stand: the game puts it there as the foot is clicked, and a bed is
    // placed from any side (placementGoal).
    if (operation === 'place' && isBed(cell?.material) && cell?.properties?.part === 'foot') {
      this.head = vec(buildFootprint({ x: point.x, y: point.y, z: point.z, material: cell.material, properties: cell.properties })[1]);
    }
  }
  heuristic(node) { return Math.max(0, node.distanceTo(this.pos) - 3); }
  isEnd(node) {
    const center = new Vec3(node.x + .5, node.y, node.z + .5);
    // Visibility exactly along a block edge can flip with a millimeter of
    // movement. Require a small standing area with a visible face, not one
    // mathematically perfect ray through a corner.
    return [[0, 0], [.18, .18], [-.18, -.18], [.18, -.18], [-.18, .18]]
      .every(([dx, dz]) => {
        const feet = center.offset(dx, 0, dz);
        // Pathfinder indexes a slab by the air cell above it, while its final
        // arrival check floors the actual feet inside that slab. Resolve both
        // to the collision surface before testing eye height and visibility.
        if (!require('./flight').canFly(this.bot)) feet.y = standingHeight(this.bot, feet);
        return this.reachable(feet, .2);
      });
  }
  reachable(feet, margin = 0) {
    const p = this.pos, cell = feet.floored();
    // Never dig the block holding you up, and never try to fill the space your
    // own body occupies. A hovering worker has neither problem: there is no
    // footing to undermine, and it does not stand in the cell it is filling.
    // Without this, a hole whose only opening faces the sky can never be closed.
    if (!require('./flight').canFly(this.bot) &&
      cell.x === p.x && cell.z === p.z && p.y <= cell.y + 1 && (this.operation === 'dig' || p.y >= cell.y - 1)) return false;
    const head = this.head;
    if (head && cell.x === head.x && cell.z === head.z && head.y >= cell.y && head.y <= cell.y + 1) return false;
    const eye = feet.offset(0, 1.62, 0);
    if (this.placement) {
      this.placement.options.range = 4.25 - margin;
      try { return !!this.placement.getFaceAndRef(eye); }
      finally { this.placement.options.range = 4.25; }
    }
    // Grass, a flower or a snow layer has no collision shape, so a ray aimed
    // at it passes straight through to the dirt behind. Demanding a hit on the
    // cell itself would call it unreachable from everywhere in the world and
    // strand the build for good; an unobstructed line to it is the real test.
    const opaque = (this.bot.blockAt(p)?.shapes || []).length > 0;
    return directions.some(face => {
      const aim = p.offset(.5 + .5 * face.x, .5 + .5 * face.y, .5 + .5 * face.z), ray = aim.minus(eye);
      if (ray.norm() > 4.25 - margin || ray.norm() < .01) return false;
      const hit = this.bot.world.raycast(eye, ray.unit(), ray.norm() + .05);
      return hit ? !!hit.position?.equals(p) : !opaque;
    });
  }
}

function standingHeight(bot, point) {
  const cell = point.floored(), surfaces = [];
  for (const y of [cell.y - 1, cell.y]) {
    const block = bot.blockAt(new Vec3(cell.x, y, cell.z));
    for (const [x0, , z0, x1, y1, z1] of block?.shapes || []) {
      if (point.x + .3 > cell.x + x0 && point.x - .3 < cell.x + x1 && point.z + .3 > cell.z + z0 && point.z - .3 < cell.z + z1)
        surfaces.push(y + y1);
    }
  }
  return surfaces.length ? Math.max(...surfaces) : point.y;
}

function entrancePassage(blueprint) {
  if (!blueprint?.entrance || !blueprint.bounds) return new Set();
  const e = vec(blueprint.entrance), {min, max} = blueprint.bounds;
  const dx = e.x < min.x ? -1 : e.x > max.x ? 1 : 0;
  const dz = e.z < min.z ? -1 : e.z > max.z ? 1 : 0;
  const keys = new Set();
  for (let n=0; n<2; n++) for (let y=0; y<2; y++) keys.add(key(e.offset(n*dx,y,n*dz)));
  return keys;
}

// The cells a building keeps for itself: its planned blocks, and for a starter house its rooms and the way in. No
// scaffold goes into them, on the building's own way to its work (constructionMovement) or on any other walk while
// the bot is at it (movement.js SurvivalMovements.exclusionPlace).
const siteSets = new WeakMap(), NO_CELLS = new Set();
function siteCells(goal) {
  const blueprint = goal?.blueprint, blocks = blueprint?.blocks;
  if (!Array.isArray(blocks) || !blocks.length) return NO_CELLS;
  const rooms = !!goal.starterBeds, empty = blueprint.empty || [];
  const held = siteSets.get(blueprint);
  if (held && held.blocks === blocks && held.n === blocks.length && held.empty === empty.length && held.rooms === rooms) return held.cells;
  const cells = new Set(blocks.map(key));
  if (rooms) {
    for (const p of empty) cells.add(key(p));
    for (const k of entrancePassage(blueprint)) cells.add(k);
  }
  siteSets.set(blueprint, { blocks, n: blocks.length, empty: empty.length, rooms, cells });
  return cells;
}

function constructionMovement(bot, goal) {
  const m = bot.pathfinder.movements;
  const previous = { canDig: m.canDig, scafoldingBlocks: m.scafoldingBlocks, exclusionAreasPlace: m.exclusionAreasPlace, countScaffoldingItems: m.countScaffoldingItems, getScaffoldingItem: m.getScaffoldingItem };
  // Creative placement consumes nothing, so the build has no material reserve to
  // protect. Holding one back there only starves access scaffolding to zero.
  const reserved = {};
  if (bot.game?.gameMode !== 'creative') {
    for (const p of goal.blueprint?.blocks || []) if (!p.companion && !buildCellComplete(bot, p)) reserved[p.material] = (reserved[p.material] || 0) + 1;
  }
  const spare = name => goal.buildPhase === 'cleanup' ? 0 : Math.max(0, (bot.inventory?.items() || []).filter(i => i.name === name).reduce((n, i) => n + i.count, 0) - (reserved[name] || 0));
  const planned = siteCells(goal);
  // Access must not demolish the building or consume reserved materials. Use
  // surplus ordinary blocks already carried before making a new gathering trip.
  m.canDig = false;
  m.scafoldingBlocks = ['dirt', 'cobblestone'].map(name => bot.registry.itemsByName[name].id);
  m.countScaffoldingItems = () => spare('dirt') + spare('cobblestone');
  m.getScaffoldingItem = () => (bot.inventory?.items() || []).find(i => ['dirt', 'cobblestone'].includes(i.name) && spare(i.name) > 0) || null;
  m.exclusionAreasPlace = [...(m.exclusionAreasPlace || []), block => planned.has(key(block.position)) ? 100 : 0];
  return () => {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete m[name]; else m[name] = value;
  };
}

async function steadyConstructionSwim(bot, task) {
  if (require('./flight').canFly(bot)) return;
  const feet = bot.entity.position.floored();
  if (bot.blockAt(feet)?.name !== 'water') return;
  let surface = feet.y;
  for (; surface < feet.y + 6 && bot.blockAt(new Vec3(feet.x, surface + 1, feet.z))?.name === 'water'; surface++);
  const above = bot.blockAt(new Vec3(feet.x, surface + 1, feet.z));
  if (!above || !['air', 'cave_air', 'void_air'].includes(above.name) || bot.entity.position.y >= surface + .05) return;
  // Filling a shallow pool changes submerged steps under the swimmer. Stay at
  // its surface before evaluating walking nodes, rather than sinking into a
  // one-cell pocket and treating that momentary footing as a missing resource.
  await move(bot, task, { label: 'swim_to_surface', keys: ['jump'], sneak: false, maxMs: 2500, tick: 50,
    guard: () => checkAir(bot), until: () => bot.entity.position.y >= surface + .1 });
}

// Why no work was found in reach, written to the log at most every 20 s: how each candidate's search ended and how
// long it took, the bot's feet, and the scaffold it may use. In the test window of 2026-11-25 the row of a roof was
// called out of reach for eleven minutes, and nothing told why.
function reachSays(bot, tried) {
  const now = Date.now();
  if (now - (bot._reachSaidAt || 0) < 20000) return;
  bot._reachSaidAt = now;
  const p = bot.entity?.position, feet = p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : 'unknown';
  let scaffold = null;
  try { scaffold = bot.pathfinder?.movements?.countScaffoldingItems?.(); } catch (_) { scaffold = null; }
  console.log(`[reach] no work in reach from ${feet} (scaffold ${scaffold ?? 'unknown'}): ${tried.join('; ') || 'nothing surveyed'}`);
}

const SLOW_RETRIES = 3, SLOW_SURVEY_MS = 2500;
async function chooseConstructionWork(bot, task, goal, candidates) {
  await steadyConstructionSwim(bot, task);
  const restore = constructionMovement(bot, goal);
  try {
    const ordered = candidates.map(candidate => ({ ...candidate, destination: new ConstructionGoal(bot, candidate.position, candidate.operation, candidate) }))
      .sort((a, b) => (a.priority || 0) - (b.priority || 0) || vec(a.position).distanceTo(bot.entity.position) - vec(b.position).distanceTo(bot.entity.position));
    const orderedCleanup = ['cleanup', 'cleanup_access'].includes(goal.buildPhase);
    const ready = !orderedCleanup && ordered.find(c => c.destination.reachable(bot.entity.position));
    if (ready) return ready;
    // Inspect several possible work faces before asking recovery to help with
    // access. One unreachable nearest block must not block the entire site.
    const slow = [], tried = [];
    const look = async (candidate, ms) => {
      const t0 = Date.now(), route = await surveyRoute(bot, task, bot.pathfinder.movements, candidate.destination, ms);
      tried.push(`${candidate.position.x},${candidate.position.y},${candidate.position.z} ${route.status} in ${Date.now() - t0} of ${ms} ms`);
      return route;
    };
    for (const candidate of ordered.slice(0, 16)) {
      task.check();
      if (candidate.destination.reachable(bot.entity.position)) return candidate;
      const route = await look(candidate, 350);
      if (route.status === 'success') return candidate;
      if (route.status === 'timeout') slow.push(candidate);
    }
    // A way up onto a roof or round a wall can take longer to find than that first look, the more so with the event
    // loop held: the nearest few whose search ran out of time are looked at again, for longer, before the work is
    // called out of reach. In the test window of 2026-11-25 the row of a roof over a house's inner wall, reached only
    // from on top of the roof once the rows beside it were laid, was called out of reach for eleven minutes; offline,
    // on that house and from where the bot stood beside it, the way (a pillar beside the wall, then over the roof)
    // took 0.1 to 1.4 s to find for each cell of the row, more than this first look's 350 ms for most of them.
    for (const candidate of slow.slice(0, SLOW_RETRIES)) {
      task.check();
      const route = await look(candidate, SLOW_SURVEY_MS);
      if (route.status === 'success') return candidate;
    }
    reachSays(bot, tried);
    return null;
  } finally { restore(); }
}

async function approachConstruction(bot, task, goal, point, operation, cell) {
  await steadyConstructionSwim(bot, task);
  const restore = constructionMovement(bot, goal);
  try {
    const destination = new ConstructionGoal(bot, point, operation, cell);
    if (!destination.reachable(bot.entity.position)) await navigate(bot, task, destination, { timeoutMs: 20000, stallMs: 5000 });
    task.check();
    // Pathfinder accepts a small distance from a cell center. At a wall corner
    // those last centimeters can still hide the selected face. Align inside
    // the same standing cell, without starting a new path or altering blocks.
    if (!destination.reachable(bot.entity.position)) {
      const cell = bot.entity.position.floored(), center = new Vec3(cell.x + .5, bot.entity.position.y, cell.z + .5), deadline = Date.now() + 1500;
      await move(bot, task, { label: 'center_for_placement', keys: ['forward'], sneak: true, look: center.offset(0, 1.62, 0),
        maxMs: Math.max(0, deadline - Date.now()), tick: 50,
        until: () => destination.reachable(bot.entity.position) || !bot.entity.position.floored().equals(cell) || bot.entity.position.distanceTo(center) <= .04 });
    }
    if (!destination.reachable(bot.entity.position)) throw new Error(`Cannot reach a clear ${operation} face at ${vec(point)} from ${bot.entity.position}; centered=${destination.isEnd(bot.entity.position.floored())}`);
    return destination.placement?.getFaceAndRef(bot.entity.position.offset(0, 1.62, 0));
  } finally { restore(); }
}
// A pathfinder placement can be acknowledged after its work step ends (or
// just after a stop). Only Mineflayer's confirmed bot placement event gives
// ownership, including for temporary scaffolds.
function recordBuildPlacement(goal, block) {
  const bounds = goal?.blueprint?.bounds, p = block?.position;
  if (goal?.kind !== 'build' || !bounds || !p || p.y < bounds.min.y ||
      !['x','y','z'].every(k => p[k] >= bounds.min[k]-3 && p[k] <= bounds.max[k]+3)) return false;
  const owned = require('./build-blocks').blockOwnership(block), key = `${p.x},${p.y},${p.z}`;
  if (JSON.stringify(goal.buildOwned?.[key]) === JSON.stringify(owned)) return false;
  (goal.buildOwned ||= {})[key] = owned;
  return true;
}
module.exports = { entrancePassage, recordBuildPlacement, ConstructionGoal, constructionMovement, chooseConstructionWork, approachConstruction, siteCells };
