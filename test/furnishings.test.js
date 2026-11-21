'use strict';
// Furnishings in a designed building (build-blocks.js, designer.js): a
// furnace or a chest is drawn with the side its front opens to, placed
// looking the other way, and a chest is never drawn beside another and stays
// apart from one already beside it.
//
//   node test/furnishings.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const { regionProperties, placementFacing, placementPitch, placementGoal, blockOwnership, matchesOwnership } = require('../src/build-blocks');
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

// The bot at `standing` places `material` at `at` on a stone floor, beside the
// blocks `around` ([at, name, properties]), the game turning its front to the
// player, the way the player last looked, and joining a chest put down
// standing to a single one of its kind beside it facing the same way.
async function placing(material, properties, at, standing, state, around = [], interruptTurn = false) {
  const world = new World().sync;
  world.setColumn(0, 0, new Chunk({ minY: -64, worldHeight: 384 }));
  for (let x = 0; x < 3; x++) for (let z = 0; z < 4; z++) world.setBlockStateId(new Vec3(x, 63, z), registry.blocksByName.stone.defaultState);
  const put = (p, name, props) => world.setBlockStateId(p, Block.fromProperties(name, props, 0).stateId);
  for (const [p, name, props] of around) put(p, name, props);
  const blockAt = p => { const q = p.floored(), b = Block.fromStateId(world.getBlockStateId(q), 0); b.position = q; return b; };
  const looked = { 0: 'north', [Math.PI / 2]: 'west', [Math.PI]: 'south', [-Math.PI / 2]: 'east' }, opposite = { north: 'south', south: 'north', east: 'west', west: 'east' };
  const looks = [], clicks = [];
  const bot = { registry, world, blockAt, version: '26.1', game: { dimension: 'overworld', gameMode: 'survival', minY: -64, height: 384 },
    entity: { position: standing, height: 1.8, width: 0.6, eyeHeight: 1.62, onGround: true, effects: {}, metadata: [] },
    entities: {}, players: {}, controlState: {}, health: 20, food: 20, oxygenLevel: 20,
    inventory: { items: () => [{ name: material, type: registry.itemsByName[material].id, count: 1 }] },
    equip: async () => {}, waitForTicks: async () => {
      if (interruptTurn && looks.length) { bot.entity.yaw = 0; interruptTurn = false; }
    },
    getControlState(k) { return !!this.controlState[k]; }, setControlState(k, v) { this.controlState[k] = v; },
    look: async (yaw, pitch) => { looks.push({ yaw, pitch }); bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
    _placeBlockWithOptions: async (ref, face) => {
      const q = ref.position.plus(face), facing = opposite[looked[bot.entity.yaw]], sneak = !!bot.controlState.sneak;
      clicks.push({ ref: ref.name, sneak });
      const partner = material === 'chest' && !sneak && [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => blockAt(q.offset(dx, 0, dz)))
        .find(b => b.name === material && b.getProperties().type === 'single' && b.getProperties().facing === facing);
      if (partner) put(partner.position, material, { ...partner.getProperties(), type: 'left' });
      put(q, material, { facing, ...state, ...(partner && { type: 'right' }) });
    } };
  await place(bot, { cancelled: false, label: 'test', check() {} }, at, material, { properties });
  return { bot, blockAt, looks, clicks, placed: blockAt(at).getProperties() };
}

test('placed looking away from the side its front is to face', async () => {
  const { looks, placed } = await placing('furnace', { facing: 'north' }, new Vec3(0, 64, 2), new Vec3(0.5, 64, 0.5), { lit: false });
  assert.equal(looks[0].yaw, Math.PI);
  assert.equal(placed.facing, 'north');
});

test('a turn interrupted before the click is restored before spending the stonecutter', async () => {
  const { looks, clicks, placed } = await placing('stonecutter', { facing: 'north' }, new Vec3(0, 64, 2), new Vec3(0.5, 64, 0.5), {}, [], true);
  assert.equal(looks.length, 2);
  assert.equal(clicks.length, 1);
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

// Beside a chest already in the world: one drawn single is put down crouched,
// not on that chest's side, and both stay single; one asked for with a facing
// alone (home-stash.js expandStash, which makes a double chest) is put down
// standing, and joins.
test('a chest drawn single beside one of its kind stays single', async () => {
  const cell = { facing: 'north', type: 'single', waterlogged: false };
  const { bot, blockAt, clicks, placed } = await placing('chest', cell, new Vec3(1, 64, 2), new Vec3(1.5, 64, 0.5), { type: 'single', waterlogged: false }, [[new Vec3(0, 64, 2), 'chest', cell]]);
  assert.deepEqual(placed, cell);
  assert.equal(blockAt(new Vec3(0, 64, 2)).getProperties().type, 'single');
  assert.deepEqual(clicks, [{ ref: 'stone', sneak: true }]);
  assert.ok(placementGoal(bot, new Vec3(1, 64, 2), { material: 'chest', properties: cell }).facesPos.every(([, , ref]) => blockAt(ref).name !== 'chest'));
});
test('a chest asked for with a facing alone joins the one beside it', async () => {
  const single = { facing: 'north', type: 'single', waterlogged: false };
  const { clicks, placed } = await placing('chest', { facing: 'north' }, new Vec3(1, 64, 2), new Vec3(1.5, 64, 0.5), { type: 'single', waterlogged: false }, [[new Vec3(0, 64, 2), 'chest', single]]);
  assert.equal(placed.facing, 'north');
  assert.notEqual(placed.type, 'single');
  assert.deepEqual(clicks, [{ ref: 'stone', sneak: false }]);
});
