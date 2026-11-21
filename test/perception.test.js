'use strict';
// JEV_PERCEPTION=player (block-search.js): an ore search returns the ore a
// player could see, not the veins inside the rock.
//
//   node test/perception.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const { installBlockSearch } = require('../src/block-search');

// Stone from y 40 to 79, a cave 9 long, 5 wide, 3 high with the bot in it
// (x -4..4, y 60..62, z -2..2), and a second cave behind its east wall.
function cave() {
  const world = new World().sync;
  for (let cx = -1; cx <= 0; cx++) for (let cz = -1; cz <= 0; cz++) world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
  const set = (x, y, z, name) => world.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState);
  for (let x = -12; x <= 12; x++) for (let y = 40; y < 80; y++) for (let z = -12; z <= 12; z++) set(x, y, z, 'stone');
  for (let x = -4; x <= 4; x++) for (let y = 60; y <= 62; y++) for (let z = -2; z <= 2; z++) set(x, y, z, 'air');
  for (let x = 7; x <= 9; x++) for (let y = 60; y <= 62; y++) for (let z = -2; z <= 2; z++) set(x, y, z, 'air');
  const ore = {
    wall: new Vec3(-5, 61, 0),     // in the west wall, facing the bot
    floor: new Vec3(4, 59, 2),     // in the floor at the far corner, seen at a slant
    behind: new Vec3(6, 61, 0),    // in the rock between the caves, open only to the other one
    buried: new Vec3(0, 50, 0),    // inside the rock
  };
  for (const p of Object.values(ore)) set(p.x, p.y, p.z, 'iron_ore');
  const blockAt = p => { const q = p.floored(), b = Block.fromStateId(world.getBlockStateId(q), 0); b.position = q; return b; };
  const bot = { registry, world, blockAt, game: { dimension: 'overworld', minY: -64, height: 384 },
    entity: { position: new Vec3(-2.5, 60, 0.5), eyeHeight: 1.62 }, findBlocks: () => { throw new Error('not the scan'); } };
  installBlockSearch(bot);
  return { bot, ore };
}
const search = bot => bot.findBlocks({ matching: [registry.blocksByName.iron_ore.id], maxDistance: 32, count: 10 }).map(String).sort();

test('player perception: the ore in sight, not the ore inside the rock', () => {
  const { bot, ore } = cave();
  process.env.JEV_PERCEPTION = 'player';
  try { assert.deepEqual(search(bot), [ore.floor, ore.wall].map(String).sort()); }
  finally { delete process.env.JEV_PERCEPTION; }
});

test('unset: every vein in reach, as before', () => {
  const { bot, ore } = cave();
  assert.deepEqual(search(bot), Object.values(ore).map(String).sort());
});

test('a search for no ore is not changed', () => {
  const { bot } = cave();
  process.env.JEV_PERCEPTION = 'player';
  try { assert.equal(bot.findBlocks({ matching: [registry.blocksByName.stone.id], maxDistance: 4, count: 3 }).length, 3); }
  finally { delete process.env.JEV_PERCEPTION; }
});
