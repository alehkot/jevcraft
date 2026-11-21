'use strict';
// Furnishings in a designed building (build-blocks.js, designer.js): a
// furnace or a chest is drawn with the side its front opens to, placed
// looking the other way, and a chest is never drawn beside another.
//
//   node test/furnishings.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const { regionProperties, placementFacing, placementPitch, blockOwnership, matchesOwnership } = require('../src/build-blocks');
const { validateSchematic, buildPalette } = require('../src/designer');
const { place } = require('../src/work');
const { orderBuildCells } = require('../src/build-batch');

test('regions: a front for a furnace or chest, none for a table', () => {
  assert.deepEqual(regionProperties('furnace', { facing: 'north', half: null }), { facing: 'north' });
  assert.deepEqual(regionProperties('chest', { facing: 'east', half: null }), { facing: 'east', type: 'single', waterlogged: false });
  assert.equal(regionProperties('crafting_table', null), undefined);
  assert.throws(() => regionProperties('furnace', null), /cardinal facing/);
  assert.ok(['furnace', 'chest', 'barrel', 'crafting_table'].every(n => buildPalette(registry).includes(n)));
  assert.ok(!buildPalette(registry).includes('copper_chest'));
  assert.equal(placementFacing('furnace', 'north'), 'south');
  assert.equal(placementFacing('oak_stairs', 'north'), 'north');
  assert.equal(placementPitch('barrel', 0.8), 0);
});

test('a lit furnace is still the one placed', () => {
  const state = lit => Block.fromStateId(Block.fromProperties('furnace', { facing: 'north', lit }, 0).stateId, 0);
  assert.ok(matchesOwnership(state(true), blockOwnership(state(false))));
});

const design = chests => ({ name: 'store', description: 'a floor and chests', size: [3, 2, 3], palette: ['cobblestone', 'chest'], entrance: null,
  regions: [{ from: [0, 0, 0], to: [2, 0, 2], block: 'cobblestone', properties: null },
    ...chests.map(x => ({ from: [x, 1, 1], to: [x, 1, 1], block: 'chest', properties: { facing: 'south', half: null } }))] });
test('a chest beside another of its kind is not drawn', () => {
  assert.doesNotThrow(() => validateSchematic(design([0, 2]), registry));
  assert.throws(() => validateSchematic(design([0, 1]), registry), /beside another chest/);
});

// The bot at `standing` places `material` at `at` on a stone floor, the game
// turning its front to the player, the way the player last looked.
async function placing(material, properties, at, standing, state) {
  const world = new World().sync;
  world.setColumn(0, 0, new Chunk({ minY: -64, worldHeight: 384 }));
  for (let x = 0; x < 3; x++) for (let z = 0; z < 4; z++) world.setBlockStateId(new Vec3(x, 63, z), registry.blocksByName.stone.defaultState);
  const blockAt = p => { const q = p.floored(), b = Block.fromStateId(world.getBlockStateId(q), 0); b.position = q; return b; };
  const looked = { 0: 'north', [Math.PI / 2]: 'west', [Math.PI]: 'south', [-Math.PI / 2]: 'east' }, opposite = { north: 'south', south: 'north', east: 'west', west: 'east' };
  const looks = [];
  const bot = { registry, world, blockAt, version: '26.1', game: { dimension: 'overworld', gameMode: 'survival', minY: -64, height: 384 },
    entity: { position: standing, height: 1.8, width: 0.6, eyeHeight: 1.62, onGround: true, effects: {}, metadata: [] },
    entities: {}, players: {}, controlState: {}, health: 20, food: 20, oxygenLevel: 20,
    inventory: { items: () => [{ name: material, type: registry.itemsByName[material].id, count: 1 }] },
    equip: async () => {}, waitForTicks: async () => {}, getControlState: () => false, setControlState() {},
    look: async (yaw, pitch) => { looks.push({ yaw, pitch }); },
    _placeBlockWithOptions: async (ref, face) => {
      const facing = opposite[looked[looks.at(-1).yaw]];
      world.setBlockStateId(ref.position.plus(face), Block.fromProperties(material, { facing, ...state }, 0).stateId);
    } };
  await place(bot, { cancelled: false, label: 'test', check() {} }, at, material, { properties });
  return { looks, placed: blockAt(at).getProperties() };
}

test('placed looking away from the side its front is to face', async () => {
  const { looks, placed } = await placing('furnace', { facing: 'north' }, new Vec3(0, 64, 2), new Vec3(0.5, 64, 0.5), { lit: false });
  assert.equal(looks[0].yaw, Math.PI);
  assert.equal(placed.facing, 'north');
});

// A chest's type (single) is not a slab's half (build-blocks.js placedHalf).
test('a chest with nothing beside it goes on the floor under it', async () => {
  const single = { type: 'single', waterlogged: false };
  const { placed } = await placing('chest', { facing: 'north', ...single }, new Vec3(1, 64, 2), new Vec3(1.5, 64, 0.5), single);
  assert.deepEqual(placed, { facing: 'north', ...single });
});
test('a chest is built once its floor is, not last', () => {
  const ground = { name: 'stone', boundingBox: 'block', getProperties: () => ({}) }, air = { name: 'air', boundingBox: 'empty', getProperties: () => ({}) };
  const bot = { blockAt: p => p.y < 0 ? ground : air };
  const cells = [{ x: 0, y: 0, z: 0, material: 'stone' }, { x: 5, y: 0, z: 0, material: 'stone' },
    { x: 0, y: 1, z: 0, material: 'chest', properties: { facing: 'north', type: 'single', waterlogged: false } }, { x: 5, y: 1, z: 0, material: 'stone' }];
  assert.deepEqual(orderBuildCells(bot, cells).map(c => `${c.material}@${c.x},${c.y}`), ['stone@0,0', 'stone@5,0', 'chest@0,1', 'stone@5,1']);
});
