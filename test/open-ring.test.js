'use strict';
// A house built onto a player's open ring of walls (the test window of 2026-11-25), where the bot dug a block of
// theirs to get free, took a dirt of its own for a stranger's and asked the player to break it, and could not reach
// the row of the roof over the inner wall once the rows on both sides of it were laid: only from on top of the roof,
// and the search for the way up there was given 350 ms. Once the roof was done (the window that followed it), every
// walk to the bedroom from beside the house ended "No route" at the search's first, empty, part; and, two stalls just
// inside its one door later, every search for the way in ran out with their cost on it.
//
//   node test/open-ring.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const { localMoves, liveView, risePlan } = require('../src/unstuck');
const { PlacedLog, theirsAt } = require('../src/player-build');
const { breakable, searchGoesOn, searchOpen, stallCostOff, badSteps } = require('../src/skills');
const { SurvivalMovements } = require('../src/movement');
const { matchesOwnership } = require('../src/build-blocks');
const { canClearSchematicBlock, schematicScaffolding } = require('../src/designer');
const { laidAt, ownBlocksPlugin } = require('../src/own-blocks');
const { siteCells, chooseConstructionWork, ConstructionGoal } = require('../src/construction-access');

const keyOf = p => `${p.x},${p.y},${p.z}`;
function scene() {
  const world = new World().sync;
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }));
  const set = (p, name) => world.setBlockStateId(p, registry.blocksByName[name].defaultState);
  const blockAt = p => { const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), b = Block.fromStateId(world.getBlockStateId(q), 0); b.position = q; return b; };
  return { world, set, blockAt };
}

test("a player's block beside the feet is not dug to get free; ground and the bot's own are", () => {
  const cells = new Map(), set = (x, y, z, name) => cells.set(keyOf({ x, y, z }), name);
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) { set(x, 63, z, 'stone'); set(x, 64, z, 'air'); set(x, 65, z, 'air'); set(x, 66, z, 'stone'); }
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [64, 65]) set(x, y, z, 'cobblestone');
  const theirs = new Set(['1,64,0', '1,65,0']), laid = new Set(['0,64,1']);
  const view = { name: p => cells.get(keyOf(p)) ?? 'stone', block: () => null, laid: p => laid.has(keyOf(p)) ? { name: 'cobblestone', at: 0 } : null,
    theirs: p => theirs.has(keyOf(p)), carried: {}, pickaxe: 'stone_pickaxe', pickaxeUses: 100, axe: null, health: 20, lavaTouch: null, corrections: null };
  const feet = new Vec3(0, 64, 0);
  const dug = () => localMoves(view, feet, { goal: 'away', from: feet }).moves.filter(m => m.kind === 'dig').map(m => keyOf(m.cell));
  assert.ok(!dug().includes('1,64,0') && !dug().includes('1,65,0'), "the player's cobblestone");
  assert.ok(dug().includes('-1,64,0'), 'cobblestone no one is known to have laid, as ground');
  assert.ok(dug().includes('0,64,1'), "the bot's own");
  // Theirs, even with a record of the bot's laying one there.
  laid.add('1,64,0');
  assert.ok(!dug().includes('1,64,0'));
});

test("rising through the rock overhead stops at a player's block", () => {
  const cells = new Map(), set = (x, y, z, name) => cells.set(keyOf({ x, y, z }), name);
  for (let y = 60; y <= 70; y++) for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) set(x, y, z, 'stone');
  for (const y of [64, 65, 67, 68, 69, 70]) set(0, y, 0, 'air');
  set(0, 66, 0, 'cobblestone');
  const theirs = new Set();
  const view = { name: p => cells.get(keyOf(p)) ?? 'air', block: () => null, laid: () => null, theirs: p => theirs.has(keyOf(p)),
    carried: { cobblestone: 10 }, pickaxe: 'stone_pickaxe', pickaxeUses: 100, axe: null, health: 20, lavaTouch: null, corrections: null };
  const feet = new Vec3(0, 64, 0);
  assert.equal(risePlan(view, feet)?.move?.key, 'rise_through');
  theirs.add('0,66,0');
  const plan = risePlan(view, feet);
  assert.equal(plan?.move, undefined);
  assert.match(plan?.blocked || '', /a player laid/);
});

test("whose a block is: one a player was seen to lay, or one of theirs the building keeps", () => {
  const { set, blockAt } = scene();
  for (const x of [1, 2, 3]) set(new Vec3(x, 64, 1), 'cobblestone');
  const bot = { blockAt, game: { dimension: 'overworld' }, placedLog: new PlacedLog(), inventory: { items: () => [] } };
  bot.placedLog.note('overworld', '1,64,1', 'cobblestone');
  bot._goal = { kind: 'build', blueprint: { blocks: [], preserved: [{ x: 2, y: 64, z: 1 }] } };
  assert.equal(theirsAt(bot, new Vec3(1, 64, 1)), true, 'seen laid');
  assert.equal(theirsAt(bot, new Vec3(2.5, 64.2, 1.7)), true, 'kept by the building');
  assert.equal(theirsAt(bot, new Vec3(3, 64, 1)), false, 'no one known');
  const view = liveView(bot);
  assert.equal(view.theirs(new Vec3(2, 64, 1)), true);
  assert.equal(view.theirs(new Vec3(3, 64, 1)), false);
  // Not once something else stands there.
  set(new Vec3(1, 64, 1), 'stone');
  assert.equal(theirsAt(bot, new Vec3(1, 64, 1)), false);
});

test("shaking loose does not break a player's block", () => {
  const { set, blockAt } = scene();
  for (const x of [1, 2]) set(new Vec3(x, 64, 1), 'cobblestone');
  const bot = { blockAt, game: { dimension: 'overworld' }, placedLog: new PlacedLog() };
  bot.placedLog.note('overworld', '1,64,1', 'cobblestone');
  assert.equal(breakable(bot, blockAt(new Vec3(1, 64, 1)), { natural: true }), false);
  assert.equal(breakable(bot, blockAt(new Vec3(2, 64, 1)), { natural: true }), true);
});

test("a walk neither digs a player's block nor puts a scaffold into the building's cells", () => {
  const { world, set, blockAt } = scene();
  for (const x of [1, 2]) set(new Vec3(x, 64, 1), 'dirt');
  const bot = { registry, world, blockAt, version: '26.1', game: { dimension: 'overworld', minY: -64, height: 384 },
    entity: { position: new Vec3(0.5, 64, 0.5) }, inventory: { items: () => [] }, buildRegistry: { all: () => [] }, placedLog: new PlacedLog() };
  bot.placedLog.note('overworld', '1,64,1', 'dirt');
  const movements = new SurvivalMovements(bot);
  assert.equal(movements.safeToBreak(blockAt(new Vec3(1, 64, 1))), false, "the player's dirt");
  assert.equal(movements.safeToBreak(blockAt(new Vec3(2, 64, 1))), true, 'dirt of the ground');
  assert.equal(movements.exclusionPlace(blockAt(new Vec3(4, 64, 4))), 0, 'no building');
  bot._goal = { kind: 'build', starterBeds: 2, blueprint: { blocks: [{ x: 4, y: 64, z: 4, material: 'red_bed', properties: { facing: 'south', part: 'foot' } }],
    empty: [{ x: 5, y: 64, z: 4 }], bounds: { min: { x: 3, y: 63, z: 3 }, max: { x: 7, y: 67, z: 7 } }, entrance: { x: 5, y: 64, z: 2 } } };
  assert.ok(movements.exclusionPlace(blockAt(new Vec3(4, 64, 4))) >= 100, "a bed's place");
  assert.ok(movements.exclusionPlace(blockAt(new Vec3(5, 64, 4))) >= 100, 'a room');
  assert.ok(movements.exclusionPlace(blockAt(new Vec3(5, 65, 2))) >= 100, 'the way in');
  assert.equal(movements.exclusionPlace(blockAt(new Vec3(9, 64, 9))), 0, 'outside it');
});

test("a dirt of the bot's own that grass has grown over is its own still", () => {
  const { set, blockAt } = scene();
  const dirt = registry.blocksByName.dirt.defaultState, at = new Vec3(1, 64, 1);
  set(at, 'grass_block');
  const grass = blockAt(at), blueprint = { initialNames: {}, initialBlocks: {} };
  assert.equal(matchesOwnership(grass, dirt), true);
  assert.equal(matchesOwnership(grass, registry.blocksByName.cobblestone.defaultState), false);
  assert.equal(canClearSchematicBlock(blueprint, { '1,64,1': dirt }, grass), true);
  assert.equal(canClearSchematicBlock(blueprint, {}, grass), false, 'with no record of it');
  // A scaffold of it is cleared away with the rest.
  const goal = { blueprint: { blocks: [], bounds: { min: { x: 0, y: 63, z: 0 }, max: { x: 3, y: 66, z: 3 } } }, buildOwned: { '1,64,1': dirt } };
  assert.deepEqual(schematicScaffolding({ blockAt }, goal), [{ x: 1, y: 64, z: 1 }]);
  // And laid by it, as own-blocks.js keeps it.
  const bot = { blockAt, _laid: new Map([['1,64,1', { name: 'dirt', at: 1 }]]) };
  assert.deepEqual(laidAt(bot, at), { name: 'dirt', at: 1 });
  set(at, 'stone');
  assert.equal(laidAt(bot, at), null);
});

test("the pathfinder's placements given up on are kept for the site's log", () => {
  const bot = Object.assign(new EventEmitter(), { entity: { position: new Vec3(1.4, 64, 2.6) }, heldItem: { name: 'dirt' } });
  ownBlocksPlugin(bot);
  bot.emit('path_reset', 'stuck');
  bot.emit('path_reset', 'place_error');
  assert.equal(bot._placeErrors.length, 1);
  assert.deepEqual({ feet: bot._placeErrors[0].feet, held: bot._placeErrors[0].held }, { feet: { x: 1, y: 64, z: 2 }, held: 'dirt' });
});

test("the building's cells: its blocks, and a starter house's rooms and way in", () => {
  const blueprint = { blocks: [{ x: 0, y: 64, z: 0, material: 'cobblestone' }], empty: [{ x: 1, y: 64, z: 1 }],
    bounds: { min: { x: 0, y: 64, z: 0 }, max: { x: 4, y: 67, z: 4 } }, entrance: { x: 2, y: 64, z: -1 } };
  assert.deepEqual([...siteCells({ blueprint })], ['0,64,0']);
  assert.deepEqual([...siteCells({ blueprint, starterBeds: 2 })].sort(), ['0,64,0', '1,64,1', '2,64,-1', '2,64,-2', '2,65,-1', '2,65,-2'].sort());
  assert.equal(siteCells({ kind: 'come' }).size, 0);
});

test('work whose route search ran out of time is looked at again, for longer', async () => {
  const { world, set, blockAt } = scene();
  for (let x = -4; x <= 20; x++) for (let z = -4; z <= 20; z++) set(new Vec3(x, 63, z), 'stone');
  const run = async status => {
    const budgets = [];
    const bot = { registry, world, blockAt, game: { gameMode: 'survival', dimension: 'overworld' }, entity: { position: new Vec3(0.5, 64, 0.5) },
      oxygenLevel: 20, health: 20, inventory: { items: () => [] },
      pathfinder: { movements: { exclusionAreasPlace: [] }, *getPathFromTo(_m, _from, _goal, { timeout }) { budgets.push(timeout); yield { result: { status: status(timeout), path: [] } }; } } };
    const candidate = { position: { x: 15, y: 64, z: 15, material: 'cobblestone' }, operation: 'place', material: 'cobblestone' };
    const chosen = await chooseConstructionWork(bot, { check() {} }, { kind: 'build', blueprint: { blocks: [candidate.position] } }, [candidate]);
    return { chosen: chosen?.position === candidate.position, budgets };
  };
  assert.deepEqual(await run(ms => ms >= 1000 ? 'success' : 'timeout'), { chosen: true, budgets: [350, 2500] });
  assert.deepEqual(await run(() => 'noPath'), { chosen: false, budgets: [350] });
});

test("a walk waits for a search that goes on past its first empty part", async () => {
  const pending = p => { let state = 'pending'; p.then(() => { state = 'resolved'; }, e => { state = 'rejected: ' + e.name; }); return () => state; };
  const tick = ms => new Promise(r => setTimeout(r, ms));
  const goal = { name: 'the bedroom' }, empty = { status: 'partial', path: [] };
  // Found later and walked to the end.
  let bot = Object.assign(new EventEmitter(), { pathfinder: { goal } }), latest = empty;
  let state = pending(searchGoesOn(bot, goal, () => latest, Date.now() + 3000));
  bot.emit('path_update', empty); await tick(150);
  assert.equal(state(), 'pending');
  latest = { status: 'success', path: [{ x: 1, y: 64, z: 0 }] }; bot.emit('path_update', latest); await tick(150);
  assert.equal(state(), 'pending');
  bot.emit('goal_reached', goal); await tick(20);
  assert.equal(state(), 'resolved');
  // Nothing found by the time given: the wait ends, the route still the empty part.
  bot = Object.assign(new EventEmitter(), { pathfinder: { goal } }); latest = empty;
  state = pending(searchGoesOn(bot, goal, () => latest, Date.now() + 250));
  await tick(150); assert.equal(state(), 'pending');
  await tick(250); assert.equal(state(), 'resolved');
  assert.equal(bot.listenerCount('path_update'), 0);
  // The search's own end with no route, said before the listeners or after: done; one with a route but no path: an error.
  bot = Object.assign(new EventEmitter(), { pathfinder: { goal } }); latest = { status: 'noPath', path: [] };
  state = pending(searchGoesOn(bot, goal, () => latest, Date.now() + 3000)); await tick(20);
  assert.equal(state(), 'resolved');
  bot = Object.assign(new EventEmitter(), { pathfinder: { goal } }); latest = empty;
  state = pending(searchGoesOn(bot, goal, () => latest, Date.now() + 3000));
  bot.emit('path_update', { status: 'noPath', path: [{ x: 1, y: 64, z: 0 }] }); await tick(20);
  assert.equal(state(), 'rejected: NoPath');
  bot = Object.assign(new EventEmitter(), { pathfinder: { goal } });
  state = pending(searchGoesOn(bot, goal, () => latest, Date.now() + 3000));
  bot.emit('goal_updated', { name: 'elsewhere' }); await tick(20);
  assert.equal(state(), 'rejected: GoalChanged');
  // The goal gone from the pathfinder (reached or stopped before the listeners): done.
  bot = Object.assign(new EventEmitter(), { pathfinder: { goal: null } });
  state = pending(searchGoesOn(bot, goal, () => latest, Date.now() + 3000)); await tick(250);
  assert.equal(state(), 'resolved');
});

test("the stall spots' cost is no wall: a search it keeps from ending is made again without it", () => {
  const now = Date.now(), spot = (x, y, z) => ({ dim: 'overworld', x, y, z, n: 2, first: now, last: now });
  const bot = { game: { dimension: 'overworld' }, _stallSpots: [spot(33, 71, -50), spot(29, 70, -49), spot(24, 70, -49)] };
  // A walk to a house's work is going to its cell: the stall spots within four blocks of it are not routed round.
  const work = new ConstructionGoal(bot, { x: 31, y: 70, z: -47 }, 'dig', null);
  assert.deepEqual(badSteps(bot, work).map(s => s.x), [24]);
  assert.equal(badSteps(bot, { isEnd: () => false }).length, 3);
  // The search ran out, with or without part of a way: made again with the lava's and the hazards' costs alone.
  const named = (name, message) => Object.assign(new Error(message), { name });
  assert.ok(searchOpen(named('NoRoute', 'No route from here to the destination (partial)')));
  assert.ok(searchOpen(named('NoRoute', 'No route from here to (3, 64, 5) (timeout): the way passes beside lava')));
  assert.ok(searchOpen(named('Timeout', 'Took to long to decide path to goal!')));
  assert.ok(!searchOpen(named('NoRoute', 'No route from here to the destination (noPath)')));
  assert.ok(!searchOpen(new Error('Navigation ended before reaching the destination')));
  // A stall at the end of part of a way, the search going on: the search's; a stall on the way: a bad step's.
  assert.ok(searchOpen(Object.assign(new Error('navigation timed out without reaching new ground'), { searchOpen: true })));
  assert.ok(!searchOpen(new Error('navigation timed out without reaching new ground')));
  const lava = { x: 2, y: 9, z: 2, lava: true }, hazard = { x: 3, y: 9, z: 3, hazard: true };
  assert.deepEqual(stallCostOff([spot(1, 9, 1), lava, hazard]), [lava, hazard]);
  assert.equal(stallCostOff([lava, hazard]), null);
});
