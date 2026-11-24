'use strict';
// A crafting table that made nothing twice is left for another (work.js
// setTableAfresh, craftAtAnotherTable): the bot's own table is taken back up
// and set down at another cell, and the craft is clicked once more there.
// What the server answered is said on the failure (craft-trace.js), and a
// count of free slots in the failure's record is not full pockets
// (speech.js friendlyProblem).
//
//   node test/table-afresh.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const Item = require('prismarine-item')(registry);
const { craft, workstation } = require('../src/work');
const { startCraftTrace } = require('../src/craft-trace');
const { friendlyProblem } = require('../src/speech');

// A flat stone yard, the bot in its middle with planks, sticks and one table.
// The first table the craft is clicked at makes nothing; any other makes it
// (`never`: none does).
function yard({ tables = [], carriedTables = 1, never = false } = {}) {
  const world = new World().sync;
  for (let cx = -1; cx <= 0; cx++) for (let cz = -1; cz <= 0; cz++) world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
  const set = (p, name) => world.setBlockStateId(p, registry.blocksByName[name].defaultState);
  for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) set(new Vec3(x, 63, z), 'stone');
  for (const t of tables) set(t, 'crafting_table');
  const blockAt = p => { const q = p.floored(), b = Block.fromStateId(world.getBlockStateId(q), 0); b.position = q; return b; };
  const slots = new Array(46).fill(null);
  const give = (name, count) => {
    const id = registry.itemsByName[name].id;
    let i = slots.findIndex((s, k) => k >= 9 && k < 45 && s?.name === name && s.count + count <= s.stackSize);
    if (i >= 0) { slots[i].count += count; return; }
    i = slots.findIndex((s, k) => k >= 9 && k < 45 && !s);
    slots[i] = new Item(id, count); slots[i].slot = i;
  };
  const take = (name, count) => {
    for (let i = 9; i < 45 && count > 0; i++) {
      const s = slots[i]; if (s?.name !== name) continue;
      const n = Math.min(count, s.count); s.count -= n; count -= n;
      if (!s.count) { slots[i] = null; if (bot.heldItem === s) bot.heldItem = null; }
    }
  };
  const inventory = { slots, selectedItem: null, inventoryStart: 9, inventoryEnd: 45,
    items: () => slots.slice(9, 45).filter(Boolean), emptySlotCount: () => slots.slice(9, 45).filter(s => !s).length };
  const clicked = [];
  let badAt = null;
  const placeHeld = async (ref, face) => { const q = ref.position.plus(face), held = bot.heldItem; take(held.name, 1); set(q, held.name); };
  const bot = { registry, world, blockAt, version: '26.1', username: 'Jev', health: 20, food: 20, oxygenLevel: 20,
    game: { dimension: 'overworld', gameMode: 'survival', minY: -64, height: 384 },
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), height: 1.8, width: 0.6, eyeHeight: 1.62, onGround: true, isInWater: false, effects: {}, metadata: [] },
    entities: {}, players: {}, controlState: {}, inventory, heldItem: null,
    pathfinder: { movements: {}, setGoal() {}, goto: async () => {}, isMoving: () => false, stop() {} },
    findBlocks: ({ matching, maxDistance = 16, count = 1 }) => {
      const ids = [].concat(matching), found = [];
      for (let x = -10; x <= 10; x++) for (let y = 60; y <= 70; y++) for (let z = -10; z <= 10; z++) {
        const q = new Vec3(x, y, z);
        if (ids.includes(blockAt(q).type) && q.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position) <= maxDistance) found.push(q);
      }
      return found.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)).slice(0, count);
    },
    equip: async item => { bot.heldItem = item; }, waitForTicks: async () => {}, lookAt: async () => {}, look: async () => {},
    getControlState(k) { return !!this.controlState[k]; }, setControlState(k, v) { this.controlState[k] = v; }, clearControlStates() {},
    canDigBlock: () => true,
    dig: async block => { set(block.position, 'air'); if (block.name === 'crafting_table') give('crafting_table', 1); },
    placeBlock: placeHeld, _placeBlockWithOptions: placeHeld,
    craft: async (recipe, count, table) => {
      clicked.push(table.position.clone());
      badAt ||= table.position.clone();
      if (never || table.position.equals(badAt)) return;
      take('oak_planks', 3); take('stick', 2); give('wooden_pickaxe', 1);
    } };
  give('oak_planks', 6); give('stick', 4);
  if (carriedTables) give('crafting_table', carriedTables);
  return { bot, clicked, blockAt, count: name => inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0) };
}
const task = { cancelled: false, label: 'test', check() {} };
const pickaxe = { action: 'craft', item: 'wooden_pickaxe', count: 1, needs_table: true,
  recipe: { shape: [['oak_planks', 'oak_planks', 'oak_planks'], [null, 'stick', null], [null, 'stick', null]], count: 1, id: 'wooden_pickaxe' },
  requires: { crafting_table: 1 }, consumes: { oak_planks: 3, stick: 2 }, produces: { wooden_pickaxe: 1 } };

test('its own table that made nothing twice is taken up, set down at another cell, and the craft made there', async () => {
  const { bot, clicked, blockAt, count } = yard(), goal = {};
  await craft(bot, task, { ...pickaxe }, goal);
  assert.equal(count('wooden_pickaxe'), 1, 'made at the second table');
  assert.equal(clicked.length, 3, 'twice at the first table, once at the second');
  assert.ok(clicked[0].equals(clicked[1]) && !clicked[2].equals(clicked[0]), 'the third click at another table');
  assert.notEqual(blockAt(clicked[0]).name, 'crafting_table', 'the first table taken back up');
  assert.equal(count('crafting_table'), 1, 'and the second taken back into the pack after the craft');
  const key = `${clicked[0].x},${clicked[0].y},${clicked[0].z}`;
  assert.ok(JSON.stringify(goal).includes(key), 'the first cell rests');
  // The cell that made nothing is passed over by the next table set down.
  const next = await workstation(bot, task, 'crafting_table', goal, { avoid: clicked[0] });
  assert.ok(!next.position.equals(clicked[0]));
});

test('a table its work keeps for the next craft is set down afresh too, and stays there for that craft', async () => {
  const { bot, clicked, blockAt, count } = yard(), goal = { holdWorkstation: true };
  await craft(bot, task, { ...pickaxe }, goal);
  assert.equal(count('wooden_pickaxe'), 1);
  assert.equal(clicked.length, 3);
  assert.notEqual(blockAt(clicked[0]).name, 'crafting_table', 'the first taken back up');
  assert.equal(blockAt(clicked[2]).name, 'crafting_table', 'the second stands for the next craft');
});

test('a table it did not set down is left standing; its own is set down beside', async () => {
  const theirs = new Vec3(2, 64, 0);
  const { bot, clicked, blockAt, count } = yard({ tables: [theirs] });
  await craft(bot, task, { ...pickaxe }, {});
  assert.ok(clicked[0].equals(theirs) && clicked[1].equals(theirs), 'first at the table near');
  assert.ok(!clicked[2].equals(theirs), 'then at its own');
  assert.equal(blockAt(theirs).name, 'crafting_table', 'the other table still stands');
  assert.equal(count('wooden_pickaxe'), 1);
});

test('no other table to be had: the craft fails as before, noted', async () => {
  const theirs = new Vec3(2, 64, 0);
  const { bot, clicked, blockAt } = yard({ tables: [theirs], carriedTables: 0 });
  await assert.rejects(craft(bot, task, { ...pickaxe }, {}), /after crafting at a table, twice/);
  assert.equal(clicked.length, 2);
  assert.equal(blockAt(theirs).name, 'crafting_table');
  assert.equal(bot._craftFailures?.length, 1, 'the failure noted once, for the craft to rest as before');
});

test('nothing at the second table either: the craft fails, noted once, and no third table is tried', async () => {
  const { bot, clicked, blockAt } = yard({ never: true });
  await assert.rejects(craft(bot, task, { ...pickaxe }, {}), /twice, and once more at another/);
  assert.equal(clicked.length, 3);
  assert.equal(bot._craftFailures?.length, 1);
  assert.equal(blockAt(clicked[2]).name, 'crafting_table', 'the second table left standing for the next try');
});

test('the trace says what the server answered to a craft that made nothing', () => {
  const client = new EventEmitter(), sent = [];
  client.write = (name, packet) => sent.push(name);
  const bot = new EventEmitter(); bot._client = client; bot.registry = registry;
  let t = 1000; const trace = startCraftTrace(bot, { now: () => t });
  t = 1040; client.emit('open_window', { windowId: 3, inventoryType: 12 });
  bot.emit('windowOpen', { id: 3, type: 'minecraft:crafting' });
  for (let i = 0; i < 9; i++) client.write('window_click', { windowId: 3, slot: i, mode: 0 });
  client.write('window_click', { windowId: 3, slot: -999, mode: 5 });
  t = 1090; client.emit('close_window', { windowId: 3 });
  t = 1200; client.emit('window_items', { windowId: 3, items: [{ itemCount: 0 }], carriedItem: { itemCount: 0 } });
  const says = trace.says();
  trace.stop();
  assert.match(says, /window 3 \(crafting\) opened at 40 ms, clicked 9 times, its output never set, closed by the server at 90 ms, not closed by the bot/);
  assert.match(says, /the server's last full view \(window 3, at 200 ms\): output empty/);
  assert.equal(sent.length, 10, 'every click still sent');
  assert.equal(client.listenerCount('set_slot'), 0, 'and nothing left listening after');
  const written = client.write; client.write('window_click', { windowId: 4, slot: 1, mode: 0 });
  assert.equal(client.write, written);
});

test('the trace of a craft that works: the output set, by a slot or a full resend', () => {
  const client = new EventEmitter(); client.write = () => {};
  const bot = new EventEmitter(); bot._client = client; bot.registry = registry;
  const made = Item.toNotch(new Item(registry.itemsByName.wooden_pickaxe.id, 1)), none = Item.toNotch(null);
  let t = 0; const trace = startCraftTrace(bot, { now: () => t });
  t = 30; client.emit('open_window', { windowId: 7 });
  for (let i = 0; i < 6; i++) client.write('window_click', { windowId: 7, slot: i + 1, mode: 0 });
  t = 55; client.emit('set_slot', { windowId: 7, slot: 0, item: made });
  client.write('window_click', { windowId: 7, slot: 0, mode: 0 }); client.write('close_window', { windowId: 7 });
  t = 80; client.emit('window_items', { windowId: 7, items: [none], carriedItem: none });
  trace.stop();
  assert.match(trace.says(), /window 7 \(type unread\) opened at 30 ms, clicked 7 times, its output set to 1 wooden pickaxe at 55 ms, closed by the bot at 55 ms/);
  const again = startCraftTrace(bot, { now: () => t });
  client.emit('open_window', { windowId: 8 }); client.emit('window_items', { windowId: 8, items: [made], carriedItem: none });
  again.stop();
  assert.match(again.says(), /window 8 .*its output set to 1 wooden pickaxe/);
});

test('a count of free slots is not full pockets', () => {
  const said = text => friendlyProblem(new Error(text));
  assert.equal(said('Timed out waiting for world/inventory update: wooden pickaxe after crafting at a table, twice (have 0 of 1, 34 free slots)'),
    "The wooden pickaxe didn't come out when I crafted it.");
  assert.equal(said('Crafting stone axe made nothing twice in the last 10 seconds (the last 1 seconds ago: no output: stone axe after crafting at a table, twice (have 0 of 1, 23 free slots)). It rests 5 minutes more.'),
    "The stone axe didn't come out when I crafted it.");
  assert.equal(said('Crafting oak planks made nothing twice in the last 2 minutes (the last 1 seconds ago: no output: oak planks after crafting, twice (have 0 of 4, 0 free slots)). It rests 5 minutes more.'),
    'My pockets are full. I need to make some room.');
  assert.equal(said('No free slot for the 1 wooden pickaxe; the inventory is full'), 'My pockets are full. I need to make some room.');
  assert.equal(said('the inventory is full'), 'My pockets are full. I need to make some room.');
  assert.equal(said('reached, not picked up (the entity at (1.0, 64.0, 2.0), 0.4 from the bot, in air, valid, free slots 0)'), 'My pockets are full. I need to make some room.');
  assert.notEqual(said('reached, not picked up (the entity at (1.0, 64.0, 2.0), 0.4 from the bot, in air, valid, free slots 12)'), 'My pockets are full. I need to make some room.');
});
