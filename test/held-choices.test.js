'use strict';
// What the bot holds over from before and when it lets go of it (found reading the trial of 2026-11-22):
// - the wait for daylight chosen sealed (survival.js sealedWaitHolds) ended on real time and hunger alone, so players
//   sleeping the night away left the bot sealed into the morning, and three of the four places that read it did not
//   ask whether the bot was to stay out with a player;
// - the stance kept in the saved state was the last connection's, its mobs named by ids no longer theirs
//   (recovery.js newConnection).
//
//   node test/held-choices.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const survival = require('../src/survival');
const { DAY } = require('../src/day');

const NOON = 6000, MIDNIGHT = 18000;
// The bot alone on open ground: hunger fifteen, not healing.
const alone = (timeOfDay, { day = 3, food = 15 } = {}) => ({ username: 'Jev', food, health: 12, entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, entities: {}, players: {},
  game: { dimension: 'overworld', gameMode: 'survival' }, time: { timeOfDay, time: day * 24000 + timeOfDay } });
const quiet = fn => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

test('the sealed wait holds by real time and hunger, as it did', () => {
  const now = Date.now(), state = { sealedWait: { until: now + 60000 } };
  assert.equal(survival.sealedWaitHolds(alone(MIDNIGHT), state, null, now), true);
  assert.equal(survival.sealedWaitHolds(alone(MIDNIGHT), state, null, now + 60001), false, 'its real time is up');
  assert.equal(survival.sealedWaitHolds(alone(MIDNIGHT, { food: 18 }), state, null, now), false, 'hunger eighteen: health comes back');
  assert.equal(survival.sealedWaitHolds(alone(MIDNIGHT), {}, null, now), false, 'no wait');
  assert.equal(survival.sealedWaitHolds(alone(NOON), state, null, now), true, 'a wait saved before the clock was kept with it holds by its real time');
});

test('a wait chosen at night ends when the day has come, however it came', () => {
  const now = Date.now(), state = { sealedWait: { until: now + 8 * 60000, night: true, dawnAt: 3 * 24000 + DAY.DAWN } };
  assert.equal(survival.sealedWaitHolds(alone(MIDNIGHT), state, null, now), true, 'the night goes on');
  assert.equal(survival.sealedWaitHolds(alone(DAY.DAWN - 1), state, null, now), true, 'a tick before dawn');
  assert.equal(survival.sealedWaitHolds(alone(DAY.DAWN), state, null, now), false, 'dawn');
  assert.equal(survival.sealedWaitHolds(alone(0, { day: 4 }), state, null, now), false, 'the players slept: morning, eight real minutes early');
  assert.equal(survival.sealedWaitHolds(alone(1000, { day: 0 }), state, null, now), false, 'the time set to day, the count gone back');
});

test('a wait chosen by day runs through dusk and the night, to the dawn it waited for', () => {
  // Chosen at noon of day 3: the dawn waited for is that night's end.
  const now = Date.now(), state = { sealedWait: { until: now + 15 * 60000, dawnAt: 3 * 24000 + DAY.DAWN } };
  assert.equal(survival.sealedWaitHolds(alone(NOON), state, null, now), true, 'the day it was chosen in');
  assert.equal(survival.sealedWaitHolds(alone(MIDNIGHT), state, null, now), true, 'the night');
  assert.equal(survival.sealedWaitHolds(alone(DAY.DAWN), state, null, now), false, 'its dawn');
  assert.equal(survival.sealedWaitHolds(alone(0, { day: 4 }), state, null, now), false, 'the players slept through to it');
});

test('the wait does not hold while the bot guards a player in view, and holds again when it does not', () => {
  const now = Date.now(), state = { sealedWait: { until: now + 60000, night: true } };
  const bot = alone(MIDNIGHT);
  const robin = { id: 2, type: 'player', username: 'Robin', position: new Vec3(3.5, 64, 0.5), height: 1.8, isValid: true };
  bot.entities[2] = robin; bot.players.Robin = { username: 'Robin', entity: robin };
  const guarding = { kind: 'follow', guard: true, from: 'Robin', target: 'Robin' };
  assert.equal(survival.sealedWaitHolds(bot, state, guarding, now), false, 'guarding');
  assert.equal(survival.sealedWaitHolds(bot, state, { kind: 'follow', from: 'Robin', target: 'Robin' }, now), true, 'following, not guarding (JEV_NIGHT not set here)');
  bot.health = 8;
  assert.equal(survival.sealedWaitHolds(bot, state, guarding, now), true, 'at eight health the bot may save itself');
});

test('the claim: a wait chosen at night is the turn at night and not in the morning (survival.js claim)', () => {
  const registry = require('prismarine-registry')('26.1');
  const Chunk = require('prismarine-chunk')(registry), World = require('prismarine-world')(registry);
  const world = new World().sync;
  for (let cx = -2; cx <= 1; cx++) for (let cz = -2; cz <= 1; cz++) world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) { world.setBlockStateId(new Vec3(x, 63, z), registry.blocksByName.grass_block.defaultState); world.setBlockStateId(new Vec3(x, 62, z), registry.blocksByName.stone.defaultState); }
  const make = timeOfDay => {
    const me = { id: 1, type: 'player', username: 'Jev', position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, width: 0.6 };
    return Object.assign(new EventEmitter(), { username: 'Jev', registry, world, blockAt: p => world.getBlock(p), entity: me, entities: { 1: me }, players: { Jev: { username: 'Jev', entity: me } },
      game: { dimension: 'overworld', difficulty: 'normal', gameMode: 'survival' }, time: { timeOfDay, time: 3 * 24000 + timeOfDay, age: 3 * 24000 + timeOfDay },
      health: 12, food: 15, oxygenLevel: 20, inventory: { slots: [], items: () => [], count: () => 0 }, heldItem: null, findBlock: () => null, findBlocks: () => [],
      pathfinder: { setGoal() {}, goal: null, isMoving: () => false, stop() {} }, clearControlStates() {}, setControlState() {}, chat() {} });
  };
  const held = () => ({ state: { sealedWait: { until: Date.now() + 8 * 60000, night: true, dawnAt: 3 * 24000 + DAY.DAWN } } });
  const goal = { kind: 'follow', from: 'Robin', target: 'Robin' };
  assert.equal(quiet(() => survival.claim(make(MIDNIGHT), goal, held()))?.action, 'wait_for_day_sealed', 'at night the wait is the turn');
  assert.notEqual(quiet(() => survival.claim(make(0), goal, held()))?.action, 'wait_for_day_sealed', 'in the morning it is not');
});

test('a new connection drops the stance and its book, and nothing else (recovery.js newConnection)', () => {
  const { newConnection, STANCE_KEYS } = require('../src/recovery');
  const state = { shelters: [{ x: 1 }], sealedWait: { until: 5 }, home: { origin: { x: 0, y: 64, z: 0 } }, stance: { choice: 'retreat', ids: [41, 42], at: Date.now() - 75446500 },
    stanceFailed: [{ choice: 'fight' }], retreatScout: { at: 1 }, standing: { id: 41 }, creeperStandoff: { id: 7 } };
  assert.deepEqual(newConnection(state).sort(), ['creeperStandoff', 'retreatScout', 'stance', 'stanceFailed', 'standing']);
  assert.deepEqual(Object.keys(state).sort(), ['home', 'sealedWait', 'shelters']);
  assert.deepEqual(newConnection(state), [], 'nothing left to drop');
  assert.deepEqual(newConnection(undefined), []);
  assert.ok(STANCE_KEYS.includes('stance'));
});

// The waiting bot answers a mob in reach by its own two ways (reactive-wait.js), outside the stance and its book, and
// wrote none of it down: in that trial it went 109 blocks from the player beside it in under a minute with an empty log.
test("what the waiting bot chose against a mob is in the log, once a mob and choice (reactive-wait.js said)", () => {
  const { said } = require('../src/reactive-wait');
  const bot = { entity: { position: {} }, _company: { name: 'Steve' }, players: { Steve: { entity: { position: { distanceTo: () => 14.4 } } } } };
  const zombie = { entity: { id: 7, name: 'zombie' }, distance: 2.14 };
  const lines = [], log = console.log; console.log = l => lines.push(l);
  try {
    assert.equal(said(bot, zombie, 'retreat', true, 1000), '[wait] the zombie 2.1 blocks off: retreat; Steve 14 blocks off');
    assert.equal(said(bot, zombie, 'retreat', true, 3000), null, 'the same within five seconds is said once');
    assert.equal(said(bot, zombie, 'fight', true, 3500), '[wait] the zombie 2.1 blocks off: fight; Steve 14 blocks off');
    assert.equal(said(bot, zombie, 'fight', true, 9000), '[wait] the zombie 2.1 blocks off: fight; Steve 14 blocks off', 'and again after five');
    delete bot.players.Steve;
    assert.equal(said(bot, zombie, undefined, false, 20000), '[wait] the zombie 2.1 blocks off: nothing chosen, not acted on; Steve out of sight');
    assert.equal(said({ entity: { position: {} } }, { entity: { id: 9, name: 'spider' } }, 'fight', true, 1), '[wait] the spider: fight');
  } finally { console.log = log; }
  assert.equal(lines.length, 5);
});
