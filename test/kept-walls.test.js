'use strict';
// A player's blocks that a building keeps (player-build.js keptAt): theirs to every check that would break or dig one
// (movement.js safeToBreak, unstuck.js, skills.js breakable, the dig guard), whatever the work in hand. In the window
// of 2026-11-25 two blocks of a ring the bot was building onto went, beside an inner corner of it, in a run where a
// routine of the night had the bot for a while: every check read the plan in hand alone, and the ring is not a block
// it saw a player lay (the console laid it).
//
//   node test/kept-walls.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const { theirsAt } = require('../src/player-build');
const { breakable, digGuardPlugin } = require('../src/skills');
const { liveView } = require('../src/unstuck');
const { BuildRegistry } = require('../src/builds');
const { Labels, apply } = require('../src/labels');

function scene({ biome = 'plains' } = {}) {
  const world = new World().sync, biomeId = registry.biomesByName[biome].id;
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }));
  const set = (x, y, z, name) => world.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState);
  const blockAt = p => { const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), b = Block.fromStateId(world.getBlockStateId(q), biomeId); b.position = q; return b; };
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) set(x, 63, z, 'stone');
  // Their ring of cobblestone, two high, seven by seven, round (0, 64, 0); and a block of the ground's beside it.
  const ring = [];
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) if (Math.abs(x) === 3 || Math.abs(z) === 3) for (const y of [64, 65]) { set(x, y, z, 'cobblestone'); ring.push({ x, y, z }); }
  set(8, 64, 0, 'cobblestone');
  return { world, set, blockAt, ring };
}
function botIn(world, blockAt) {
  return { username: 'Jev', game: { dimension: 'overworld' }, registry, world, blockAt, labels: new Labels(null), players: {}, health: 20,
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 }, inventory: { items: () => [] }, findBlocks: () => [], buildRegistry: new BuildRegistry(null) };
}
// The house built onto their ring, as the records keep it: the ring its preserved cells, a floor its own.
function remembered(bot, ring, { name = 'Their House', from = 'Alex' } = {}) {
  const blocks = [];
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) blocks.push({ x, y: 63, z, material: 'stone' });
  bot.buildRegistry.remember({ from, kind: 'house', buildName: name, request: 'build a house',
    blueprint: { origin: { x: -3, y: 63, z: -3 }, bounds: { min: { x: -3, y: 63, z: -3 }, max: { x: 3, y: 67, z: 3 } }, blocks, empty: [], preserved: ring } }, { dimension: 'overworld' });
}
const wall = { x: -3, y: 64, z: -2 }, ground = { x: 8, y: 64, z: 0 };

test('their walls a house of the records keeps are theirs with no work in hand: to the walk, the dig into a wall, getting free', () => {
  const { world, blockAt, ring } = scene(), bot = botIn(world, blockAt);
  remembered(bot, ring);
  bot._goal = null;
  // The ground's own cobblestone beside it is no one's: the checks would break that.
  assert.equal(theirsAt(bot, new Vec3(ground.x, ground.y, ground.z)), false);
  assert.equal(breakable(bot, blockAt(new Vec3(ground.x, ground.y, ground.z))), true);
  assert.equal(theirsAt(bot, new Vec3(wall.x, wall.y, wall.z)), true);
  assert.equal(breakable(bot, blockAt(new Vec3(wall.x, wall.y, wall.z))), false);
  assert.equal(liveView(bot).theirs(new Vec3(wall.x, wall.y, wall.z)), true);
  // Nor while some other work has the bot (a night's routine, an errand): its goal has no plan of that house.
  bot._goal = { from: 'Jev', request: 'find a safe spot' };
  assert.equal(theirsAt(bot, new Vec3(wall.x, wall.y, wall.z)), true);
  assert.equal(liveView(bot).theirs(new Vec3(wall.x, wall.y, 1)), true);
});

test('a start found keeps its cells before its plan is drawn; the plan, once drawn, is what keeps them', () => {
  const { world, blockAt, ring } = scene(), bot = botIn(world, blockAt);
  bot._goal = { from: 'Alex', request: 'build a house', playerBuild: { cells: ring.map(c => ({ ...c, name: 'cobblestone' })) } };
  assert.equal(theirsAt(bot, new Vec3(wall.x, wall.y, wall.z)), true);
  assert.equal(breakable(bot, blockAt(new Vec3(wall.x, wall.y, wall.z))), false);
  // Drawn with a doorway cut through their wall, as asked: the doorway is the plan's to clear, the rest kept.
  const door = [{ x: 0, y: 64, z: -3 }, { x: 0, y: 65, z: -3 }];
  bot._goal.blueprint = { blocks: [], empty: door, preserved: ring.filter(c => !door.some(d => d.x === c.x && d.y === c.y && d.z === c.z)) };
  assert.equal(theirsAt(bot, new Vec3(0, 64, -3)), false);
  assert.equal(theirsAt(bot, new Vec3(wall.x, wall.y, wall.z)), true);
});

test('the dig guard: no block a building keeps is dug, whatever asks; where it was asked from is logged once a minute', async () => {
  const { world, blockAt, ring } = scene(), bot = botIn(world, blockAt);
  remembered(bot, ring);
  let dug = 0;
  bot.dig = async () => { dug++; };
  digGuardPlugin(bot);
  const lines = [], log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    for (let i = 0; i < 2; i++) await assert.rejects(bot.dig(blockAt(new Vec3(wall.x, wall.y, wall.z))), e => e.name === 'DigRefused' && /a player's block that Their House keeps/.test(e.message));
  } finally { console.log = log; }
  assert.equal(dug, 0);
  const said = lines.filter(l => /^\[dig\] Not dug: the cobblestone at \(-3, 64, -2\)/.test(l));
  assert.equal(said.length, 1, 'logged once for the two tries');
  assert.match(said[0], /asked from [\w.-]+\.js:\d+/);
  // The ground's own is dug.
  await bot.dig(blockAt(new Vec3(ground.x, ground.y, ground.z)));
  assert.equal(dug, 1);
  // A block of theirs they said it may break (labels.js): dug.
  apply(bot, 'Alex', { do: 'use', what: 'this', thing: 'block', name: null }, { hit: { position: { x: -3, y: 65, z: 1 } }, standing: { x: 0, y: 64, z: 0 }, dimension: 'overworld' });
  await bot.dig(blockAt(new Vec3(-3, 65, 1)));
  assert.equal(dug, 2);
});

test("a room's doorway through their wall, asked for by a player: cut; the bot's own plan over it: not", async () => {
  const { world, blockAt, ring } = scene(), bot = botIn(world, blockAt);
  remembered(bot, ring);
  let dug = 0;
  bot.dig = async () => { dug++; };
  digGuardPlugin(bot);
  const door = { x: 3, y: 64, z: 0 };
  bot._goal = { from: 'Alex', request: 'add a room to my house', buildName: 'room', blueprint: { blocks: [{ ...door, material: 'oak_door' }], empty: [], preserved: [] } };
  assert.equal(theirsAt(bot, new Vec3(door.x, door.y, door.z)), false);
  await bot.dig(blockAt(new Vec3(door.x, door.y, door.z)));
  assert.equal(dug, 1);
  bot._goal = { from: 'Jev', request: 'build my own house', buildName: 'mine', blueprint: { blocks: [], empty: [{ x: 3, y: 65, z: 0 }], preserved: [] } };
  const log = console.log; console.log = () => {};
  try { await assert.rejects(bot.dig(blockAt(new Vec3(3, 65, 0))), e => e.name === 'DigRefused'); } finally { console.log = log; }
  assert.equal(dug, 1);
});

test('a block the bot laid itself where theirs stood is its own; a house remembered later is read at once', () => {
  const { world, set, blockAt, ring } = scene(), bot = botIn(world, blockAt);
  remembered(bot, ring);
  set(-3, 64, 2, 'dirt');
  bot._laid = new Map([['-3,64,2', { name: 'dirt', at: Date.now() }]]);
  assert.equal(theirsAt(bot, new Vec3(-3, 64, 2)), false);
  set(9, 64, 9, 'cobblestone');
  assert.equal(theirsAt(bot, new Vec3(9, 64, 9)), false);
  bot.buildRegistry.remember({ from: 'Alex', kind: 'house', buildName: 'Shed', request: 'build a shed',
    blueprint: { origin: { x: 9, y: 63, z: 9 }, bounds: { min: { x: 9, y: 63, z: 9 }, max: { x: 10, y: 65, z: 10 } }, blocks: [{ x: 10, y: 63, z: 10, material: 'stone' }], empty: [], preserved: [{ x: 9, y: 64, z: 9 }] } }, { dimension: 'overworld' });
  assert.equal(theirsAt(bot, new Vec3(9, 64, 9)), true);
  // Not in another dimension.
  bot.game.dimension = 'the_nether';
  assert.equal(theirsAt(bot, new Vec3(9, 64, 9)), false);
});

test("a ring of theirs where a house of the bot's once stood: theirs, the cells its plan had included", () => {
  const { world, set, blockAt, ring } = scene(), bot = botIn(world, blockAt);
  const { startedAt } = require('../src/player-build');
  // An earlier house of the bot's there, gone but for its plan: planks where their north wall's middle now stands.
  const old = [{ x: 0, y: 64, z: -3, material: 'oak_planks' }, { x: 0, y: 65, z: -3, material: 'oak_planks' }];
  bot.buildRegistry.remember({ from: 'Alex', kind: 'house', buildName: 'Old House', request: 'build a house',
    blueprint: { origin: { x: -3, y: 63, z: -3 }, bounds: { min: { x: -3, y: 63, z: -3 }, max: { x: 3, y: 67, z: 3 } }, blocks: old, empty: [] } }, { dimension: 'overworld' });
  const start = startedAt(bot, { x: 0.5, y: 64, z: 0.5 });
  assert.equal(start.cells.length, ring.length);
  assert.equal(start.closed, true, 'no way in: a doorway to cut');
  // The bot's planks standing there still: its own, not theirs.
  for (const c of old) set(c.x, c.y, c.z, 'oak_planks');
  const again = startedAt(bot, { x: 0.5, y: 64, z: 0.5 });
  assert.equal(again.cells.length, ring.length - 2);
  assert.ok(!again.cells.some(c => c.x === 0 && c.z === -3));
});

test('a house onto a start of theirs, no wood carried nor a tree in view: drawn from a reference in oak, no tree looked for first', () => {
  const { world, blockAt } = scene(), bot = botIn(world, blockAt);
  const { designStarterHouse } = require('../src/starter-house');
  const goal = { starterBeds: 2, buildAnchor: { x: 0, y: 64, z: 0 } };
  // A house of its own on open plains with no wood: trees are looked for first, as before.
  assert.equal(designStarterHouse(bot, goal), null);
  const onto = designStarterHouse(bot, { ...goal, playerBuild: { cells: [] } }, { anyWood: true });
  assert.ok(onto?.source?.palette.includes('oak_planks'), 'a reference drawn in oak');
  assert.ok(onto.source.palette.includes('oak_door'));
});

test("the bot's own door opened, chest paired and torch on a wall are still its own, not their start", () => {
  const { world, set, blockAt, ring } = scene(), bot = botIn(world, blockAt);
  const { startedAt } = require('../src/player-build');
  const at = (x, y, z, name, props) => { const s = Block.fromProperties(name, props, 0); world.setBlockStateId(new Vec3(x, y, z), s.stateId); };
  // A house of the bot's whose north wall's middle is its door, with a chest and a torch inside it.
  const blocks = [
    { x: 0, y: 64, z: -3, material: 'oak_door', properties: { facing: 'south', half: 'lower' } },
    { x: 0, y: 65, z: -3, material: 'oak_door', properties: { facing: 'south', half: 'upper' } },
    { x: 1, y: 64, z: -2, material: 'chest', properties: { facing: 'south', type: 'single', waterlogged: false } },
    { x: 2, y: 64, z: -2, material: 'chest', properties: { facing: 'south', type: 'single', waterlogged: false } },
    { x: -2, y: 65, z: -2, material: 'torch' },
  ];
  bot.buildRegistry.remember({ from: 'Alex', kind: 'house', buildName: 'Its House', request: 'build a house',
    blueprint: { origin: { x: -3, y: 63, z: -3 }, bounds: { min: { x: -3, y: 63, z: -3 }, max: { x: 3, y: 67, z: 3 } }, blocks, empty: [] } }, { dimension: 'overworld' });
  at(0, 64, -3, 'oak_door', { facing: 'south', half: 'lower', open: 'true', hinge: 'left', powered: 'false' });
  at(0, 65, -3, 'oak_door', { facing: 'south', half: 'upper', open: 'true', hinge: 'left', powered: 'false' });
  at(1, 64, -2, 'chest', { facing: 'south', type: 'left', waterlogged: 'false' });
  at(2, 64, -2, 'chest', { facing: 'south', type: 'right', waterlogged: 'false' });
  at(-2, 65, -2, 'wall_torch', { facing: 'south' });
  const start = startedAt(bot, { x: 0.5, y: 64, z: 0.5 });
  const mine = c => blocks.some(b => b.x === c.x && b.y === c.y && b.z === c.z);
  assert.ok(start && !start.cells.some(mine), 'none of the bot\'s own blocks taken for theirs');
  assert.equal(start.cells.length, ring.length - 2, 'their ring but for the bot\'s door');
});
