'use strict';
// The fall under the body's middle (motion.js fallUnder, centerContact): what
// the body stands on is read from the collision shapes under its middle, so a
// bottom slab or a stair's low step over air is footing, and a body whose
// middle is past the edge is over the fall.
//
//   node test/footing.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const { fallUnder, centerContact } = require('../src/motion');

// A ledge 20 blocks over stone: the column at x 0 is open from y 63 down to 44.
function ledge(top) {
  const world = new World().sync;
  for (let cx = -1; cx <= 0; cx++) for (let cz = -1; cz <= 0; cz++) world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
  const set = (x, y, z, name, props) => {
    const block = registry.blocksByName[name];
    let state = block.defaultState;
    if (props) state = require('prismarine-block')(registry).fromProperties(name, props, 0).stateId;
    world.setBlockStateId(new Vec3(x, y, z), state);
  };
  for (let x = -4; x <= 3; x++) for (let z = -4; z <= 3; z++) set(x, 43, z, 'stone');
  if (top) set(0, 64, 0, ...top);
  const Block = require('prismarine-block')(registry);
  const bot = { registry, world, health: 20, entity: { position: new Vec3(0.5, 65, 0.5) },
    blockAt: p => { const b = Block.fromStateId(world.getBlockStateId(p), 0); b.position = p; return b; } };
  return bot;
}

test('a bottom slab over a drop is footing; past its edge is the fall', () => {
  const bot = ledge(['oak_slab', { type: 'bottom', waterlogged: false }]);
  bot.entity.position = new Vec3(0.5, 64.5, 0.5);
  assert.equal(centerContact(bot), true);
  assert.equal(fallUnder(bot), null);
  bot.entity.position = new Vec3(1.2, 64.5, 0.5);
  assert.ok(fallUnder(bot), 'the middle past the slab is over twenty blocks of air');
});

test("a stair's low step over a drop is footing", () => {
  const bot = ledge(['oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: false }]);
  // The low half of a north-facing stair is its south half (z 0.5 to 1).
  bot.entity.position = new Vec3(0.5, 64.5, 0.75);
  assert.equal(fallUnder(bot), null);
  // On its high step.
  bot.entity.position = new Vec3(0.5, 65, 0.25);
  assert.equal(fallUnder(bot), null);
});

test('a full block and a fence top hold as before; air over the drop does not', () => {
  const full = ledge(['stone']);
  full.entity.position = new Vec3(0.5, 65, 0.5);
  assert.equal(fallUnder(full), null);
  const fence = ledge(['oak_fence', { north: false, south: false, east: false, west: false, waterlogged: false }]);
  fence.entity.position = new Vec3(0.5, 65.5, 0.5);
  assert.equal(fallUnder(fence), null);
  const open = ledge(null);
  open.entity.position = new Vec3(0.5, 64, 0.5);
  assert.ok(fallUnder(open));
});
