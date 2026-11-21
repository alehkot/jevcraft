'use strict';
// A workstation with no open cell in the 5x5 round the feet goes in the
// nearest open, supported cell up to 8 off (work.js workstation, the ring
// after the stencil), the same three placements shared, a refused cell
// resting while the next is tried.
//
//   node test/workstation-ring.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const { workstation, stationCellOk } = require('../src/work');

// A one-wide stone bridge along z over a drop, torches on it either side of
// the bot: no stencil cell is open, the bridge 3 or more off is.
function bridge({ refuse = 0 } = {}) {
  const world = new World().sync;
  for (let cx = -1; cx <= 0; cx++) for (let cz = -1; cz <= 0; cz++) world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
  const set = (p, name) => world.setBlockStateId(p, registry.blocksByName[name].defaultState);
  for (let z = -10; z <= 10; z++) set(new Vec3(0, 63, z), 'stone');
  for (const z of [-2, -1, 1, 2]) set(new Vec3(0, 64, z), 'torch');
  const blockAt = p => { const q = p.floored(), b = Block.fromStateId(world.getBlockStateId(q), 0); b.position = q; return b; };
  const placed = [];
  const bot = { registry, world, blockAt, version: '26.1', username: 'Jev', health: 20, food: 20, oxygenLevel: 20,
    game: { dimension: 'overworld', gameMode: 'survival', minY: -64, height: 384 },
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8, width: 0.6, eyeHeight: 1.62, onGround: true, isInWater: false, effects: {}, metadata: [] },
    entities: {}, players: {}, controlState: {}, pathfinder: { movements: {} },
    inventory: { items: () => [{ name: 'furnace', type: registry.itemsByName.furnace.id, count: 1 }] },
    findBlocks: () => [], equip: async () => {}, waitForTicks: async () => {},
    getControlState(k) { return !!this.controlState[k]; }, setControlState(k, v) { this.controlState[k] = v; }, clearControlStates() {},
    _placeBlockWithOptions: async (ref, face) => {
      const q = ref.position.plus(face);
      if (refuse-- > 0) throw new Error('the block is still air');
      set(q, 'furnace'); placed.push(q);
    } };
  return { bot, placed };
}
const task = { cancelled: false, label: 'test', check() {} };

test('placed on the nearest open cell past the stencil', async () => {
  const { bot, placed } = bridge();
  const station = await workstation(bot, task, 'furnace', {});
  assert.equal(station.name, 'furnace');
  assert.deepEqual(placed.map(String), [String(new Vec3(0, 64, 3))]);
});

test('a refused cell rests and the next is tried', async () => {
  const { bot, placed } = bridge({ refuse: 1 }), goal = {};
  const station = await workstation(bot, task, 'furnace', goal);
  assert.equal(station.name, 'furnace');
  assert.deepEqual(placed.map(String), [String(new Vec3(0, 64, -3))]);
});

test('a cell out of sight now is still one to walk to', () => {
  const { bot } = bridge();
  bot.world.setBlockStateId(new Vec3(0, 64, 2), registry.blocksByName.stone.defaultState);
  const q = new Vec3(0, 64, 3);
  assert.equal(stationCellOk(bot, null, q), false, 'placed only where it is seen');
  assert.equal(stationCellOk(bot, null, q, { visibility: false }), true, 'a site to walk to');
});
