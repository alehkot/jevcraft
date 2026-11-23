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
