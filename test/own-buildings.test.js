'use strict';
// Jev's own buildings as they stand (the build registry's planned blocks,
// there) are not dug through on a walk (movement.js safeToBreak), its own laid
// blocks included; ground elsewhere, a cell holding other than its plan's
// block and its own laid blocks elsewhere are as before.
//
//   node test/own-buildings.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const { SurvivalMovements } = require('../src/movement');
const { BuildRegistry } = require('../src/builds');

function scene(planned) {
  const world = new World().sync;
  world.setColumn(0, 0, new Chunk({ minY: -64, worldHeight: 384 }));
  const set = (p, name) => world.setBlockStateId(p, registry.blocksByName[name].defaultState);
  const blockAt = p => { const q = p.floored(), b = Block.fromStateId(world.getBlockStateId(q), 0); b.position = q; return b; };
  for (const [x, name] of [[1, 'dirt'], [2, 'dirt'], [3, 'cobblestone'], [4, 'cobblestone'], [5, 'dirt']]) set(new Vec3(x, 64, 1), name);
  const bot = { registry, world, blockAt, version: '26.1', game: { dimension: 'overworld', minY: -64, height: 384 },
    entity: { position: new Vec3(0.5, 64, 0.5) }, inventory: { items: () => [] },
    // Both cobblestones laid by the bot (own-blocks.js), the second in its house.
    _laid: new Map([['3,64,1', { name: 'cobblestone' }], ['4,64,1', { name: 'cobblestone' }]]),
    buildRegistry: { all: () => [{ blueprint: { blocks: planned.map(([x, material]) => ({ x, y: 64, z: 1, material })) } }] } };
  const movements = new SurvivalMovements(bot);
  movements.blocksCantBreak.add(registry.blocksByName.cobblestone.id);
  return { movements, at: x => blockAt(new Vec3(x, 64, 1)) };
}

test("a cell of Jev's own building is not dug through on a walk", () => {
  const { movements, at } = scene([[2, 'dirt'], [4, 'cobblestone'], [5, 'oak_planks']]);
  assert.equal(movements.safeToBreak(at(1)), true, 'ground');
  assert.equal(movements.safeToBreak(at(2)), false, 'the dirt its plan has there');
  assert.equal(movements.safeToBreak(at(3)), true, 'its own laid block elsewhere');
  assert.equal(movements.safeToBreak(at(4)), false, 'its own laid block in its building');
  assert.equal(movements.safeToBreak(at(5)), true, 'dirt where its plan has planks not yet laid');
});

test('a newly registered wall is protected immediately and a forgotten one is released', () => {
  const { movements, at } = scene([]);
  const bot = movements.bot;
  bot.buildRegistry = new BuildRegistry();
  const p = { x: 2, y: 64, z: 1 };
  const plan = { blueprint: { origin: p, bounds: { min: p, max: p }, blocks: [{ ...p, material: 'dirt' }] } };
  assert.equal(movements.safeToBreak(at(2)), true);
  const entry = bot.buildRegistry.remember(plan, { dimension: 'overworld', status: 'complete' });
  assert.equal(movements.safeToBreak(at(2)), false);
  bot.buildRegistry.forget(entry.id);
  assert.equal(movements.safeToBreak(at(2)), true);
});
