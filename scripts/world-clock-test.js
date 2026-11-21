'use strict';
// The time of day comes from the Overworld's own clock (src/world-clock.js). No
// server: the library's own time plugin on packets shaped as a 26.1 server
// sends them, with the registries in the plain game's order and in the order
// a datapack with a dimension type of its own gives them.
//
//   node scripts/world-clock-test.js
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const timePlugin = require('mineflayer/lib/plugins/time');
const clock = require('../src/world-clock');

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok  ${name}`); };

const PLAIN = ['overworld', 'overworld_caves', 'the_end', 'the_nether'];
const WITH_PACK = ['somepack:wide_world', 'overworld', 'overworld_caves', 'the_end', 'the_nether'];
const CLOCKS = ['minecraft:overworld', 'minecraft:the_end'];

// A bot as far as the time plugin knows one. `fixed`: with src/world-clock.js.
function botWith(types, { fixed = true, dimension = 'overworld', clocks = CLOCKS } = {}) {
  const bot = new EventEmitter();
  bot._client = new EventEmitter();
  bot.game = { dimension };
  bot.registry = { dimensionsById: Object.fromEntries(types.map((name, id) => [id, { name }])) };
  if (fixed) clock.install(bot);            // as session.js does: before the plugins are in
  bot._client.emit('registry_data', { id: 'minecraft:world_clock', entries: clocks.map(key => ({ key, value: null })) });
  timePlugin(bot);
  return bot;
}
// The world is `age` ticks old; its day was set on, so the Overworld's clock is ahead of it.
const packet = (age, overworld, order = [1, 0]) => ({ age: [0, age],
  clockUpdates: order.map(id => ({ id, totalTicks: id === 0 ? overworld : age, partialTick: 0, rate: 1 })) });

const warnings = [], realError = console.error;
(async () => {
  console.error = (...args) => { warnings.push(args.join(' ')); };

  await check('the plain game: the Overworld clock is the time of day', async () => {
    const bot = botWith(PLAIN);
    bot._client.emit('update_time', packet(16000, 76000));
    assert.equal(bot.time.timeOfDay, 76000 % 24000);
    assert.equal(bot.time.isDay, true);
    assert.equal(bot.time.age, 16000);
  });

  await check('a datapack dimension type ahead of the Overworld: still the Overworld clock', async () => {
    for (const order of [[1, 0], [0, 1]]) {
      const bot = botWith(WITH_PACK);
      bot._client.emit('update_time', packet(16000, 76000, order));
      assert.equal(bot.time.timeOfDay, 4000, `clocks sent in the order ${order}`);
      assert.equal(bot.time.isDay, true);
      assert.equal(bot.time.doDaylightCycle, true);
    }
  });

  await check('the fault it answers: the library alone reads the End clock there', async () => {
    const bot = botWith(WITH_PACK, { fixed: false });
    bot._client.emit('update_time', packet(16000, 76000));
    // If this fails, mineflayer files the clocks by name itself now: take src/world-clock.js out.
    assert.equal(bot.time.timeOfDay, 16000, 'the library is expected to get this wrong');
    assert.equal(bot.time.isDay, false);
  });

  await check('a packet with no clocks in it keeps the time, and the clock runs on between packets', async () => {
    const bot = botWith(WITH_PACK);
    bot._client.emit('update_time', packet(16000, 76000));
    for (let i = 0; i < 20; i++) bot.emit('physicsTick');
    bot._client.emit('update_time', { age: [0, 16020], clockUpdates: [] });
    assert.equal(bot.time.timeOfDay, 4020);
  });

  await check('the time set while connected: the new count replaces the old', async () => {
    const bot = botWith(WITH_PACK);
    bot._client.emit('update_time', packet(16000, 76000));
    bot._client.emit('update_time', { age: [0, 16040], clockUpdates: [{ id: 0, totalTicks: 97000, partialTick: 0, rate: 1 }] });
    assert.equal(bot.time.timeOfDay, 1000);
    for (let i = 0; i < 10; i++) bot.emit('physicsTick');
    bot._client.emit('update_time', { age: [0, 16050], clockUpdates: [] });
    assert.equal(bot.time.timeOfDay, 1010);
  });

  await check('in the End the End clock is read, and a stopped clock is not a running day', async () => {
    const bot = botWith(WITH_PACK, { dimension: 'the_end' });
    bot._client.emit('update_time', packet(16000, 76000));
    assert.equal(bot.time.time, 16000);
    const still = botWith(WITH_PACK);
    still._client.emit('update_time', { age: [0, 500], clockUpdates: [{ id: 0, totalTicks: 6000, partialTick: 0, rate: 0 }] });
    assert.equal(still.time.timeOfDay, 6000);
    assert.equal(still.time.doDaylightCycle, false);
  });

  await check('a clock with no dimension of its name is left out, not filed under another', async () => {
    const bot = botWith(WITH_PACK, { clocks: ['minecraft:overworld', 'somepack:moon_base'] });
    bot._client.emit('update_time', packet(16000, 76000));
    assert.equal(bot.time.timeOfDay, 4000);
    assert.deepEqual(Object.keys(bot.time.clocks), ['overworld']);
  });

  await check('the registry not seen: the plain game\'s two clocks are assumed', async () => {
    const bot = new EventEmitter();
    bot._client = new EventEmitter(); bot.game = { dimension: 'overworld' };
    bot.registry = { dimensionsById: Object.fromEntries(WITH_PACK.map((name, id) => [id, { name }])) };
    clock.install(bot); timePlugin(bot);
    bot._client.emit('update_time', packet(16000, 76000));
    assert.equal(bot.time.timeOfDay, 4000);
  });

  await check('nothing is said while the library files the clocks as expected', async () => {
    const bot = botWith(WITH_PACK);
    bot._client.emit('update_time', packet(16000, 76000));
    bot._client.emit('update_time', packet(16020, 76020));           // two in one read, as at login
    bot._client.emit('update_time', { age: [0, 16040], clockUpdates: [] });
    assert.deepEqual(warnings, []);
  });

  await check('it says so once if the library stops filing them where they were put', async () => {
    const bot = botWith(WITH_PACK);
    bot._client.removeAllListeners('update_time');           // a library that reads the packet some other way
    clock.install(bot);
    bot.time = { clocks: {} };
    for (let i = 0; i < 3; i++) bot._client.emit('update_time', packet(16000 + 20 * i, 76000 + 20 * i));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[clock\]/);
  });

  console.error = realError;
  console.log(`\n${passed} checks passed`);
})().catch(err => { console.error = realError; console.error(err); process.exit(1); });
