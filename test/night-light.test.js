'use strict';
// The ground about the bot lit enough to pass the night without a shelter (src/night-light.js, asked for 2026-11-22):
// the ring 24 to 40 blocks off read, as monsters never spawn nearer a player than 24 blocks; torches all about it is
// lit, none or half is not; the answer kept a minute where the bot stands; and the night's shelter not claimed alone
// at night on lit ground.
//
//   node test/night-light.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const light = require('../src/night-light');

// A lawn at y 63 (feet at 64), 44 blocks each way, and the torches put on it.
function lawn(torchesAt = []) {
  const world = new World().sync;
  for (let cx = -3; cx <= 2; cx++) for (let cz = -3; cz <= 2; cz++) world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
  const set = (x, y, z, name) => world.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState);
  for (let x = -44; x <= 44; x++) for (let z = -44; z <= 44; z++) { set(x, 63, z, 'grass_block'); set(x, 62, z, 'stone'); }
  const lights = torchesAt.map(([x, z]) => new Vec3(x, 64, z));
  for (const p of lights) set(p.x, p.y, p.z, 'torch');
  const bot = Object.assign(new EventEmitter(), { username: 'Jev', registry, world, blockAt: p => world.getBlock(p),
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, width: 0.6 },
    findBlocks: ({ maxDistance, point, count = 256 }) => lights.filter(p => p.distanceTo(point) <= maxDistance).slice(0, count),
    players: {}, entities: {}, game: { dimension: 'overworld', difficulty: 'normal', gameMode: 'survival' }, time: { timeOfDay: 16000, age: 16000 },
    health: 20, food: 20, oxygenLevel: 20, inventory: { slots: [], items: () => [], count: () => 0 }, heldItem: null, findBlock: () => null,
    pathfinder: { setGoal() {}, goal: null, isMoving: () => false, stop() {} }, clearControlStates() {}, setControlState() {}, chat() {} });
  return { bot, set, lights };
}
const grid = (step, from = -40, to = 40) => { const out = []; for (let x = from; x <= to; x += step) for (let z = from; z <= to; z += step) out.push([x, z]); return out; };
const quiet = fn => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

test('the ring read is 24 to 40 blocks off, the top standing cell of every third column', () => {
  const { bot } = lawn();
  const spots = light.ringSpots(bot, bot.entity.position.floored());
  assert.ok(spots.length >= light.MIN_SPOTS, String(spots.length));
  for (const s of spots) {
    const d = Math.hypot(s.x, s.z);
    assert.ok(d >= light.INNER && d <= light.OUTER, `${s} at ${d}`);
    assert.equal(s.y, 64);
  }
});

test('no torches: not lit; torches every ten blocks: lit; torches on one side only: not lit', () => {
  const dark = light.survey(lawn().bot);
  assert.equal(dark.lit, false); assert.equal(dark.litSpots, 0);
  const lit = light.survey(lawn(grid(10)).bot);
  assert.equal(lit.lit, true, JSON.stringify(lit)); assert.ok(lit.share >= light.LIT_SHARE);
  const half = light.survey(lawn(grid(10).filter(([x]) => x >= 0)).bot);
  assert.equal(half.lit, false, JSON.stringify(half)); assert.ok(half.share > 0.3 && half.share < 0.8, JSON.stringify(half));
});

test('kept a minute where the bot stands; read again when it has moved', () => {
  const s = lawn(grid(10));
  const t0 = 1_000_000;
  assert.equal(quiet(() => light.wellLit(s.bot, t0)), true);
  for (const [x, z] of grid(10)) s.set(x, 64, z, 'air');
  s.lights.length = 0;
  assert.equal(light.wellLit(s.bot, t0 + 30000), true, 'kept');
  assert.equal(quiet(() => light.wellLit(s.bot, t0 + 61000)), false, 'a minute on, read again');
  s.bot._wellLit = { at: t0, where: s.bot.entity.position.clone(), lit: true };
  s.bot.entity.position = new Vec3(9.5, 64, 0.5);
  assert.equal(quiet(() => light.wellLit(s.bot, t0 + 1000)), false, 'moved nine blocks');
});

test('alone at night on lit ground the night\'s shelter is not claimed; on dark ground it is', () => {
  const survival = require('../src/survival');
  const goal = { kind: 'survive', request: 'Stay alive' };
  const dark = lawn();
  assert.equal(quiet(() => survival.claim(dark.bot, goal, null))?.action, 'secure_shelter');
  const lit = lawn(grid(10));
  assert.notEqual(quiet(() => survival.claim(lit.bot, goal, null))?.action, 'secure_shelter');
});
