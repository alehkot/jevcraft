'use strict';
// Stay-close distances (src/stay-close.js readControl, src/guide.js): any whole number of blocks, held out of sight and
// for the trips taken while work waits. Asked for 2026-11-23,
// after "stay max 50 bloxks away" was answered "I can't set a 50-block limit, but I can stay within 8 blocks of you":
// the guide's instructions gave the distance as a fixed 8 where the engine takes any number.
//
//   node test/stay-close.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readControl } = require('../src/stay-close');
const { SYSTEM } = require('../src/guide');

test('a distance in blocks is read directly, whatever the number', () => {
  for (const [said, radius] of [
    ['stay within 50 blocks of me', 50], ['stay within 50 blocks', 50], ['stay within 50 blocks from me', 50],
    ['stay max 50 blocks away', 50], ['stay at most 50 blocks from me', 50], ['keep no more than 120 blocks away from me', 120],
    ['stay up to 30 blocks away', 30], ['be within 50 blocks of me', 50], ['stay close to me, max 50 blocks', 50],
    ['stay within 8 blocks of me', 8], ['Stay within 50 blocks of me!', 50], ['please stay within 64 blocks of me', 64]])
    assert.deepEqual(readControl(said), { mode: 'on', radius }, said);
  assert.deepEqual(readControl('stay close to me'), { mode: 'on', radius: undefined }, 'no number: the default or the last one');
  assert.deepEqual(readControl('stay within 0 blocks of me'), { mode: 'invalid' });
  assert.deepEqual(readControl('stop staying close'), { mode: 'off' });
});

test('what is not a distance from the speaker is left to the guide and the interpreter', () => {
  for (const said of ['stay within 50 blocks of the house', 'stay max 50 bloxks away', '50 blocks are fine', 'stay here',
    'build within 50 blocks of me', 'get me 50 blocks of stone', 'stay away'])
    assert.equal(readControl(said), null, said);
});

test('the guide is told that any number of blocks is a stay-close distance', () => {
  const text = SYSTEM('Jev');
  assert.match(text, /"stay within <N> blocks of me"/);
  assert.doesNotMatch(text, /"stay within 8 blocks of me"/, 'no fixed distance for the model to read as the only one');
  assert.match(text, /"stay max 50 blocks away"/);
  assert.match(text, /A number is never the reason/);
});

test('JEV_STAY_CLOSE: a default for the player the bot is with, replaced by a player\'s own, and kept off once turned off', () => {
  const close = require('../src/stay-close');
  const saved = process.env.JEV_STAY_CLOSE;
  process.env.JEV_STAY_CLOSE = '75';
  try {
    const bot = { username: 'Jev', entity: { position: { x: 0, y: 64, z: 0 } }, game: {},
      players: { Jev: {}, Robin: { entity: { position: { x: 10, y: 64, z: 0 } } }, Sky: { entity: { position: { x: 3, y: 64, z: 0 } } } },
      companionMemory: { state: {}, flush() {} } };
    const first = close.preference(bot);
    assert.deepEqual(first, { player: 'Sky', radius: 75, byDefault: true }, 'with nobody yet: the nearest in sight');
    assert.equal(close.preference(bot), first, 'the same object while it holds');
    bot._company = { name: 'Robin', position: { x: 10, y: 64, z: 0 }, at: 0 };
    assert.equal(close.preference(bot).player, 'Robin', 'the player it is with');
    assert.match(close.status(bot), /within 75 blocks of Robin \(my default\)\. We're 10 blocks apart/);
    close.applyControl(bot, 'Robin', readControl('stay close to me'));
    assert.deepEqual(close.preference(bot), { player: 'Robin', radius: 12 }, '"stay close to me" is 12 blocks, not the default');
    close.applyControl(bot, 'Robin', readControl('stop staying close'));
    assert.deepEqual(bot.companionMemory.state.stayClose, { off: true });
    assert.equal(close.preference(bot), null, 'off stays off: the default does not come back');
    assert.equal(close.status(bot), 'Stay-close mode is off.');
    close.applyControl(bot, 'Sky', readControl('stay within 50 blocks of me'));
    assert.deepEqual(close.preference(bot), { player: 'Sky', radius: 50 });
    // A walk the player sent it on is not cut short by the default; a player's own stay-close holds for it, as before.
    delete bot.companionMemory.state.stayClose;
    assert.equal(close.exempt(bot, { kind: 'visit' }), true);
    assert.equal(close.exempt(bot, { kind: 'find' }), true);
    assert.equal(close.exempt(bot, { kind: 'obtain' }), false);
    assert.equal(close.exempt(bot, { kind: 'come' }), true);
    bot.companionMemory.state.stayClose = { player: 'Sky', radius: 50 };
    assert.equal(close.exempt(bot, { kind: 'visit' }), false);
    delete process.env.JEV_STAY_CLOSE; delete bot.companionMemory.state.stayClose;
    assert.equal(close.preference(bot), undefined, 'unset: no default, as before');
    close.applyControl(bot, 'Robin', readControl('stop staying close'));
    assert.equal(bot.companionMemory.state.stayClose, undefined, 'unset: off leaves nothing stored, as before');
  } finally { if (saved === undefined) delete process.env.JEV_STAY_CLOSE; else process.env.JEV_STAY_CLOSE = saved; }
});

test('out of sight it keeps to where the player was last seen; trips may end a little past the radius, no further', async () => {
  const close = require('../src/stay-close');
  const saved = process.env.JEV_STAY_CLOSE, log = console.log;
  process.env.JEV_STAY_CLOSE = '75';
  console.log = () => {};
  try {
    const bot = { username: 'Jev', entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' },
      players: { Jev: {}, Robin: { entity: { position: { x: 10, y: 64, z: 0 } } } }, companionMemory: { state: {}, flush() {} } };
    const t = Date.now();
    assert.equal(close.anchor(bot, t).seen, true);
    assert.equal(close.excursion(75), 37.5, 'half the radius at most');
    assert.equal(close.excursion(200), 67.5, 'or a walk out and back in ninety seconds');
    const options = () => ({ travel_desert: { to: { x: 150, z: 0 } }, travel_river: { to: { x: 50, z: 10 } }, travel_savanna: { to: { x: 115, z: 0 } },
      explore: { walkBlocks: 40 }, deep_dark: {}, stock_wood: { item: 'oak_log' }, visit_village: { to: { x: -120, z: 0 } } });
    const kept = (goal, opts) => Object.keys(close.boundOffers(bot, goal, options(), opts));
    const near = ['travel_river', 'travel_savanna', 'explore', 'stock_wood'];
    assert.deepEqual(kept({ kind: 'obtain' }, { filler: true }), near, 'while work waits: only trips ending within 112.5 blocks of the player');
    assert.deepEqual(kept({ kind: 'obtain' }), Object.keys(options()), "a player's own request: its trips as before");
    assert.deepEqual(kept({ kind: 'craft', weaponErrand: true }), near, "work of the bot's own: the same");
    // A step of the first tools (JEV_START=tools) as session.js launchArms makes one: an errand of the bot's own.
    assert.deepEqual(kept({ kind: 'craft', item: 'stone_pickaxe', count: 1, deliver: false, weaponErrand: true, mission: true }), near, 'a step of the first tools: the same');
    assert.deepEqual(kept({ kind: 'come' }, { filler: true }), Object.keys(options()), 'a come is not bounded');
    // Past the tracking range the server no longer sends the player.
    bot.players.Robin = {};
    bot.entity.position = { x: 130, y: 64, z: 0 };
    const out = close.anchor(bot, t + 1000);
    assert.deepEqual([out.seen, out.position], [false, { x: 10, y: 64, z: 0 }], 'where last seen');
    assert.equal(close.preference(bot).player, 'Robin', 'still the default player while online');
    assert.match(close.status(bot), /out of sight; I last saw them 120 blocks from here/);
    assert.ok(close.travelScore(bot, { x: 60, y: 64, z: 0 }) < close.travelScore(bot, { x: 200, y: 64, z: 0 }), 'the pull holds out of sight');
    assert.deepEqual(kept({ kind: 'craft', weaponErrand: true }), ['travel_river', 'travel_savanna', 'stock_wood'], 'round where last seen; the walk from here would end 160 off');
    assert.equal(close.due(bot, true), true, 'waiting this far off: back');
    let toward = null;
    assert.equal(await close.regroup(bot, { check() {} }, async (b, task, goal) => { toward = goal; }, true), true);
    assert.deepEqual([toward?.constructor?.name, toward?.x, toward?.z], ['GoalNear', 10, 0], 'to where they were last seen');
    assert.equal(close.anchor(bot, t + close.LAST_SEEN_MS + 2000), null, 'not after ten minutes');
    delete bot.players.Robin;
    assert.equal(close.anchor(bot), null, 'nor once they are gone');
  } finally { console.log = log; if (saved === undefined) delete process.env.JEV_STAY_CLOSE; else process.env.JEV_STAY_CLOSE = saved; }
});

test("the bot's own work may be outside the radius for a short time only (JEV_STAY_CLOSE_OUT)", async () => {
  const close = require('../src/stay-close');
  const saved = { radius: process.env.JEV_STAY_CLOSE, out: process.env.JEV_STAY_CLOSE_OUT }, log = console.log;
  process.env.JEV_STAY_CLOSE = '75';
  delete process.env.JEV_STAY_CLOSE_OUT;
  console.log = () => {};
  try {
    assert.equal(close.outMs({}), 90000, 'ninety seconds when unset');
    assert.equal(close.outMs({ JEV_STAY_CLOSE_OUT: '30' }), 30000);
    assert.equal(close.outMs({ JEV_STAY_CLOSE_OUT: '0' }), 0, 'not at all');
    assert.equal(close.outMs({ JEV_STAY_CLOSE_OUT: 'soon' }), 90000);
    // A player standing still, the bot sent out by its own errand.
    const bot = { username: 'Jev', entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' },
      players: { Jev: {}, Robin: { entity: { position: { x: 10, y: 64, z: 0 } } } }, companionMemory: { state: {}, flush() {} } };
    const own = { kind: 'craft', weaponErrand: true }, asked = { kind: 'obtain' }, t0 = Date.now() - 300000;
    assert.equal(close.due(bot, false, t0, own), false, 'inside');
    bot.entity.position = { x: 140, y: 64, z: 0 };
    assert.equal(close.due(bot, false, t0 + 1000, own), false, 'just outside: on with the work');
    assert.equal(close.due(bot, false, t0 + 60000, own), false);
    assert.equal(close.due(bot, false, t0 + 91000, own), 'out', 'ninety seconds outside: back');
    assert.equal(close.due(bot, false, t0 + 91000, { kind: 'craft', item: 'stone_pickaxe', count: 1, deliver: false, weaponErrand: true, mission: true }), 'out', 'a step of the first tools, as launchArms makes one: the same');
    assert.equal(close.due(bot, false, t0 + 91000, asked), false, "a player's own request: the player standing still, as before");
    bot.entity.position = { x: 70, y: 64, z: 0 };
    assert.equal(close.due(bot, false, t0 + 92000, own), false, 'back inside: the time starts again');
    assert.equal(bot._stayOut, undefined);
    bot.entity.position = { x: 140, y: 64, z: 0 };
    assert.equal(close.due(bot, false, t0 + 93000, own), false);
    process.env.JEV_STAY_CLOSE_OUT = '0';
    let opts = null;
    assert.equal(await close.regroup(bot, { check() {} }, async (b, task, goal, o) => { opts = o; }, false, own), true, 'with 0, back at once');
    assert.ok(opts.timeoutMs >= 130 / 1.5 * 1000, 'the walk is all the way back: ' + opts.timeoutMs);
  } finally {
    console.log = log;
    for (const [key, name] of [['radius', 'JEV_STAY_CLOSE'], ['out', 'JEV_STAY_CLOSE_OUT']]) if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
  }
});
