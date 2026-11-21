'use strict';
// Jev's own buildings (the build registry's cells) are not dug through on a
// walk (movement.js SurvivalMovements.safeToBreak), its own laid blocks
// included, and other ground and its own laid blocks elsewhere are as before.
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

function scene(claimed) {
  const world = new World().sync;
  world.setColumn(0, 0, new Chunk({ minY: -64, worldHeight: 384 }));
  const set = (p, name) => world.setBlockStateId(p, registry.blocksByName[name].defaultState);
  const blockAt = p => { const q = p.floored(), b = Block.fromStateId(world.getBlockStateId(q), 0); b.position = q; return b; };
  for (const [x, name] of [[1, 'dirt'], [2, 'dirt'], [3, 'cobblestone'], [4, 'cobblestone']]) set(new Vec3(x, 64, 1), name);
  const bot = { registry, world, blockAt, version: '26.1', game: { dimension: 'overworld', minY: -64, height: 384 },
    entity: { position: new Vec3(0.5, 64, 0.5) }, inventory: { items: () => [] },
    // Both cobblestones laid by the bot (own-blocks.js), the second in its house.
    _laid: new Map([['3,64,1', { name: 'cobblestone' }], ['4,64,1', { name: 'cobblestone' }]]),
    buildRegistry: { claimed: () => new Set(claimed) } };
  const movements = new SurvivalMovements(bot);
  movements.blocksCantBreak.add(registry.blocksByName.cobblestone.id);
  return { movements, at: x => blockAt(new Vec3(x, 64, 1)) };
}

test("a cell of Jev's own building is not dug through on a walk", () => {
  const { movements, at } = scene(['2,64,1', '4,64,1']);
  assert.equal(movements.safeToBreak(at(1)), true, 'ground');
  assert.equal(movements.safeToBreak(at(2)), false, 'ground in a building cell');
  assert.equal(movements.safeToBreak(at(3)), true, 'its own laid block elsewhere');
  assert.equal(movements.safeToBreak(at(4)), false, 'its own laid block in its building');
});
