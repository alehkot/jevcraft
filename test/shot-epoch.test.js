'use strict';
// A strike Jev chose against a shooter (shot-reflex.js strikeFirst) is not
// swung once the bot's activity has changed: a stop, a death or a new job
// bumps bot._requestActivityEpoch (session.js).
//
//   node test/shot-epoch.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { strikeFirst } = require('../src/shot-reflex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function scene({ lookMs = 0 } = {}) {
  const skeleton = { id: 7, name: 'skeleton', position: new Vec3(1.5, 64, 0.5), width: 0.6, height: 1.99, isValid: true };
  return { _requestActivityEpoch: 1, attacks: 0, entity: { position: new Vec3(0.5, 64, 0.5) }, entities: { 7: skeleton },
    lookAt: () => sleep(lookMs), attack() { this.attacks++; } };
}

test('with nothing changed, the strike swings as the recharge allows', async () => {
  const bot = scene(), run = strikeFirst(bot, 7);
  await sleep(800);
  bot.entities[7].isValid = false;
  await run;
  assert.equal(bot.attacks, 2);
});

test('a stop between two swings ends the strike', async () => {
  const bot = scene(), run = strikeFirst(bot, 7);
  await sleep(100);
  bot._requestActivityEpoch++;
  await run;
  assert.equal(bot.attacks, 1);
});

test('a stop while turning to the shooter swings nothing', async () => {
  const bot = scene({ lookMs: 100 }), run = strikeFirst(bot, 7);
  await sleep(30);
  bot._requestActivityEpoch++;
  await run;
  assert.equal(bot.attacks, 0);
});
