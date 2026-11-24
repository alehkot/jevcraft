'use strict';
// Stay-close distances (src/stay-close.js readControl, src/guide.js): any whole number of blocks. Asked for 2026-11-23,
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
