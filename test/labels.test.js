'use strict';
// What a player tells the bot a thing is (src/labels.js): "don't touch this", "you can use this chest", "this is my
// house", "forget that", read by the guide (src/guide.js) and found from where the player looked as they said it.
//
//   node test/labels.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const labels = require('../src/labels');
const { Labels, labelAt, keepsDig, refusesOpen, usedSince, openGuardPlugin, pointedNow, apply, statusNear } = labels;
const { theirsAt, PlacedLog } = require('../src/player-build');
const { leftAlone } = require('../src/built');
const { digGuardPlugin } = require('../src/skills');
const { lootableChests } = require('../src/looting');
const { createGuide, SYSTEM } = require('../src/guide');

function scene() {
  const world = new World().sync;
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }));
  const set = (x, y, z, name, props) => world.setBlockStateId(new Vec3(x, y, z), props ? Block.fromProperties(name, props, 0).stateId : registry.blocksByName[name].defaultState);
  const blockAt = p => { const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), b = Block.fromStateId(world.getBlockStateId(q), 0); b.position = q; return b; };
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) set(x, 63, z, 'stone');
  return { world, set, blockAt };
}
function botIn(world, blockAt, { entries = [] } = {}) {
  return { username: 'Jev', game: { dimension: 'overworld' }, registry, world, blockAt, labels: new Labels(null), players: {},
    buildRegistry: { all: () => entries, claimed: () => new Set() }, findBlocks: () => [] };
}
const look = (hit, standing = { x: 0, y: 64, z: 0 }) => ({ hit: hit && { position: hit, name: null }, standing, dimension: 'overworld' });

test('the store: the newest label on a block counts, any player takes one off, at most 64 each, kept on disk', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'labels-')), 'w-labels.json');
  const store = new Labels(file), label = (kind, by, cells, at = new Date().toISOString()) => ({ id: kind + by + cells.length, kind, scope: 'thing', thing: 'cobblestone',
    name: null, dimension: 'overworld', cells, center: cells[0], by, at });
  const keep = store.add(label('keep', 'Alex', [{ x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 1 }]));
  assert.equal(store.at('overworld', { x: 1.5, y: 64.2, z: 1.9 }), keep);
  assert.equal(store.at('the_nether', { x: 1, y: 64, z: 1 }), null);
  const use = store.add(label('use', 'Sam', [{ x: 1, y: 64, z: 1 }]));
  assert.equal(store.at('overworld', { x: 1, y: 64, z: 1 }), use, 'the newer one');
  assert.equal(store.at('overworld', { x: 2, y: 64, z: 1 }), keep, 'the older still counts where nothing newer is');
  // A label all of whose blocks a newer one covers counts nowhere, and goes.
  store.add(label('keep', 'Sam', [{ x: 2, y: 64, z: 1 }]));
  assert.ok(!store.labels.includes(keep));
  // Kept on disk and read back.
  const again = new Labels(file);
  assert.equal(again.size, store.size);
  assert.equal(again.at('overworld', { x: 1, y: 64, z: 1 }).kind, 'use');
  // At most 64 for each player: the oldest of theirs goes.
  for (let i = 0; i < 70; i++) store.add(label('keep', 'Robin', [{ x: 100 + i, y: 64, z: 0 }]));
  assert.equal(store.labels.filter(l => l.by === 'Robin').length, labels.PER_PLAYER);
  assert.equal(store.at('overworld', { x: 100, y: 64, z: 0 }), null);
  assert.ok(store.at('overworld', { x: 169, y: 64, z: 0 }));
  // Anything unreadable on disk is no labels, not no bot.
  fs.writeFileSync(file, '{"version":1,"labels":[{"kind":"keep"},null]}');
  assert.equal(new Labels(file).size, 0);
  assert.equal(labelAt({ labels: new Labels(null) }, { x: 0, y: 0, z: 0 }), null);
  assert.equal(labelAt({}, { x: 0, y: 0, z: 0 }), null);
});

test('this: a chest is both its halves, a door both its halves, a bed both its parts; a lone block is itself', () => {
  const { world, set, blockAt } = scene(), bot = botIn(world, blockAt);
  set(0, 64, 0, 'chest', { facing: 'north', type: 'left', waterlogged: false });
  set(1, 64, 0, 'chest', { facing: 'north', type: 'right', waterlogged: false });
  assert.match(apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'chest', name: null }, look({ x: 1, y: 64, z: 0 })), /won't open or break the chest at 1, 64, 0 \(both halves\)/);
  assert.equal(labelAt(bot, { x: 0, y: 64, z: 0 })?.kind, 'keep');
  set(4, 64, 0, 'oak_door', { facing: 'north', half: 'lower', hinge: 'left', open: false, powered: false });
  set(4, 65, 0, 'oak_door', { facing: 'north', half: 'upper', hinge: 'left', open: false, powered: false });
  apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'block', name: null }, look({ x: 4, y: 65, z: 0 }));
  assert.ok(labelAt(bot, { x: 4, y: 64, z: 0 }), 'the lower half with the upper');
  set(6, 64, 0, 'white_bed', { facing: 'north', part: 'foot', occupied: false });
  set(6, 64, -1, 'white_bed', { facing: 'north', part: 'head', occupied: false });
  apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'block', name: null }, look({ x: 6, y: 64, z: 0 }));
  assert.ok(labelAt(bot, { x: 6, y: 64, z: -1 }), 'the head with the foot');
  set(9, 64, 0, 'cobblestone');
  assert.match(apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'block', name: null }, look({ x: 9, y: 64, z: 0 })), /won't break or take the cobblestone at 9, 64, 0\.$/);
  assert.equal(labelAt(bot, { x: 9, y: 64, z: 0 }).cells.length, 1);
});

test('keep on a block of a building is the building, its blocks as they stand; use is never a whole building', () => {
  const { world, set, blockAt } = scene();
  const blocks = [];
  for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) if (x === 0 || x === 4 || z === 0 || z === 4) for (const y of [64, 65]) { set(x, y, z, 'oak_planks'); blocks.push({ x, y, z, material: 'oak_planks' }); }
  blocks.push({ x: 2, y: 66, z: 2, material: 'oak_planks' });   // planned, not built: not part of what is marked
  // The bot's own house, as the build registry keeps it (builds.js remember, as work.js calls it).
  const { BuildRegistry } = require('../src/builds');
  const registry = new BuildRegistry(null);
  // A house in the Nether, kept first, at the same place: no house here.
  registry.remember({ from: 'Alex', kind: 'house', buildName: 'Nether Hut', request: 'build a hut',
    blueprint: { origin: { x: 0, y: 64, z: 1 }, bounds: { min: { x: 0, y: 64, z: 0 }, max: { x: 4, y: 66, z: 4 } }, blocks } }, { dimension: 'the_nether' });
  registry.remember({ from: 'Alex', kind: 'house', buildName: 'Oak House', request: 'build a house',
    blueprint: { origin: { x: 0, y: 64, z: 0 }, bounds: { min: { x: 0, y: 64, z: 0 }, max: { x: 4, y: 66, z: 4 } }, blocks } }, { dimension: 'overworld' });
  const bot = botIn(world, blockAt);
  bot.buildRegistry = registry;
  const said = apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'building', name: 'my house' }, look({ x: 0, y: 65, z: 2 }));
  assert.match(said, /^Got it: your house, 32 blocks at /);
  assert.equal(labelAt(bot, { x: 4, y: 64, z: 4 })?.name, 'my house');
  assert.equal(labelAt(bot, { x: 2, y: 66, z: 2 }), null, 'a cell not built is not marked');
  assert.equal(labelAt(bot, { x: 2, y: 64, z: 2 }), null, 'nor the air inside');
  // "This is my house", said inside it looking at the sky: the one they stand in; taken off the same way.
  bot.labels = new Labels(null);
  assert.match(apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'building', name: 'my house' }, look(null, { x: 2, y: 64, z: 2 })), /^Got it: your house, 32 blocks/);
  assert.match(apply(bot, 'Sam', { do: 'forget', what: 'this', thing: 'building', name: null }, look(null, { x: 2, y: 64, z: 2 })), /^Done: the label on Alex's house is off \(Alex set it\)\.$/);
  assert.equal(bot.labels.size, 0);
  // "Here", said standing in it.
  assert.match(apply(bot, 'Sam', { do: 'keep', what: 'here', thing: 'building', name: null }, look(null, { x: 2, y: 64, z: 2 })), /^Got it: Oak House, 32 blocks/);
  // Use is for one thing.
  assert.match(apply(bot, 'Alex', { do: 'use', what: 'here', thing: 'building', name: null }, look(null, { x: 2, y: 64, z: 2 })), /whole building/);
  assert.match(apply(bot, 'Alex', { do: 'use', what: 'this', thing: 'building', name: null }, look({ x: 0, y: 65, z: 2 })), /whole building/);
  assert.match(apply(bot, 'Alex', { do: 'use', what: 'this', thing: 'block', name: null }, look({ x: 0, y: 65, z: 2 })), /^All right: I may break or take the oak planks at 0, 65, 2\.$/);
  assert.equal(labelAt(bot, { x: 0, y: 64, z: 2 })?.kind, 'keep', 'the block beside it still kept');
});

test('"this chest" said at a wall marks nothing; a block beside a building, not of it, is only itself', () => {
  const { world, set, blockAt } = scene();
  for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) if (x === 0 || x === 4 || z === 0 || z === 4) for (const y of [64, 65]) set(x, y, z, 'cobblestone');
  set(6, 64, 2, 'andesite');
  const bot = botIn(world, blockAt);
  assert.match(apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'chest', name: null }, look({ x: 0, y: 64, z: 2 })), /^I see cobblestone there, not a chest\./);
  assert.equal(bot.labels.size, 0);
  assert.match(apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'block', name: null }, look({ x: 6, y: 64, z: 2 })), /won't break or take the andesite at 6, 64, 2\.$/);
  assert.equal(labelAt(bot, { x: 4, y: 64, z: 2 }), null, 'the wall two blocks off is not marked with it');
  // Said of the building, the ground before it will do.
  set(5, 63, 2, 'grass_block');
  assert.match(apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'building', name: null }, look({ x: 5, y: 63, z: 2 })), /^Got it: that building, 32 blocks/);
});

test('a crafting table kept on its own is not used; one in a kept house is', async () => {
  const { craft } = require('../src/craft-clicks');
  const { world, set, blockAt } = scene();
  set(0, 64, 0, 'crafting_table');
  const blocks = [];
  for (let x = 4; x <= 8; x++) for (let z = 0; z <= 4; z++) if (x === 4 || x === 8 || z === 0 || z === 4) { set(x, 64, z, 'cobblestone'); blocks.push({ x, y: 64, z }); }
  set(6, 64, 2, 'crafting_table'); blocks.push({ x: 6, y: 64, z: 2 });
  const entry = { id: 'h', name: 'Hut', bounds: { min: { x: 4, y: 64, z: 0 }, max: { x: 8, y: 64, z: 4 } }, blueprint: { blocks } };
  const bot = botIn(world, blockAt, { entries: [entry] });
  const clicked = [];
  bot.activateBlock = async b => { clicked.push(b.position.x); throw Object.assign(new Error('stub: no window'), { name: 'Stub' }); };
  bot.once = () => {}; bot.removeListener = () => {};
  apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'block', name: null }, look({ x: 0, y: 64, z: 0 }));
  apply(bot, 'Alex', { do: 'keep', what: 'here', thing: 'building', name: null }, look(null, { x: 6, y: 64, z: 1 }));
  const recipe = { requiresTable: true, result: { id: 1, count: 1 } };
  await assert.rejects(craft(bot, recipe, 1, blockAt(new Vec3(0, 64, 0))), e => e.name === 'Blocked' && /won't open it/.test(e.message));
  await assert.rejects(craft(bot, recipe, 1, blockAt(new Vec3(6, 64, 2))), e => e.name === 'Stub');
  assert.deepEqual(clicked, [6]);
});

test('a building of more blocks than one label holds is not marked in part', () => {
  const { world, set, blockAt } = scene();
  const blocks = [];
  for (let x = 0; x < 10; x++) for (let y = 64; y < 74; y++) for (let z = 0; z < 10; z++) { set(x, y, z, 'stone_bricks'); blocks.push({ x, y, z }); }
  const entry = { id: 'big', name: 'Keep', bounds: { min: { x: 0, y: 64, z: 0 }, max: { x: 9, y: 73, z: 9 } }, blueprint: { blocks } };
  const bot = botIn(world, blockAt, { entries: [entry] });
  assert.match(apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'building', name: null }, look({ x: 0, y: 64, z: 0 })), /^That's more than I can mark in one go/);
  assert.equal(bot.labels.size, 0);
});

test("a player's start of walls is a building to mark too", () => {
  const { world, set, blockAt } = scene();
  for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) if (x === 0 || x === 4 || z === 0 || z === 4) for (const y of [64, 65]) set(x, y, z, 'cobblestone');
  const bot = botIn(world, blockAt);
  const said = apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'block', name: null }, look({ x: 0, y: 64, z: 2 }));
  assert.match(said, /^Got it: that building, 32 blocks at /);
  assert.ok(labelAt(bot, { x: 4, y: 65, z: 4 }));
});

test('no look, no label; said without the name, none either; any player takes one off', () => {
  const { world, set, blockAt } = scene(), bot = botIn(world, blockAt);
  set(0, 64, 0, 'barrel', { facing: 'up', open: false });
  assert.match(apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'chest', name: null }, null), /can't see you/);
  assert.match(apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'chest', name: null }, look(null)), /^Point at it/);
  assert.match(apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'chest', name: null }, look({ x: 0, y: 64, z: 0 }), { judged: true }), /say it again with my name/);
  assert.equal(bot.labels.size, 0);
  apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'chest', name: null }, look({ x: 0, y: 64, z: 0 }));
  assert.match(apply(bot, 'Sam', { do: 'forget', what: 'this', thing: 'chest', name: null }, look({ x: 0, y: 64, z: 0 })), /^Done: the label on the barrel at 0, 64, 0 is off \(Alex set it\)\.$/);
  assert.equal(bot.labels.size, 0);
  assert.equal(apply(bot, 'Sam', { do: 'forget', what: 'this', thing: 'chest', name: null }, look({ x: 0, y: 64, z: 0 })), 'Nothing is marked there.');
});

test('the look is taken as the line comes: where the eyes point then, and where the player stands', () => {
  const { world, set, blockAt } = scene(), bot = botIn(world, blockAt);
  set(0, 64, 3, 'chest', { facing: 'north', type: 'single', waterlogged: false });
  bot.players.Alex = { entity: { position: new Vec3(0.5, 64, 0.5), headYaw: Math.PI, pitch: -0.3, height: 1.8 } };
  bot.world = { raycast: () => ({ position: new Vec3(0, 64, 3), name: 'chest' }) };
  assert.deepEqual(pointedNow(bot, 'Alex'), { hit: { position: { x: 0, y: 64, z: 3 }, name: 'chest' }, standing: { x: 0, y: 64, z: 0 }, dimension: 'overworld' });
  bot.world = { raycast: () => null };
  assert.equal(pointedNow(bot, 'Alex').hit, null);
  assert.equal(pointedNow(bot, 'Nobody'), null);
});

test('keep: never dug, but a cell of the building a player asked for; use: a block of theirs it may break', async () => {
  const { world, set, blockAt } = scene(), bot = botIn(world, blockAt);
  for (const z of [0, 1]) set(2, 64, z, 'cobblestone');
  bot.entity = { position: new Vec3(0.5, 64, 0.5) };
  bot.health = 20;
  let dug = 0;
  bot.dig = async () => { dug++; };
  digGuardPlugin(bot);
  apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'block', name: null }, look({ x: 2, y: 64, z: 0 }));
  await assert.rejects(bot.dig(blockAt(new Vec3(2, 64, 0))), e => e.name === 'DigRefused' && /marked "don't touch"/.test(e.message));
  assert.equal(dug, 0);
  // The building a player asked for, planned to clear that cell: dug.
  bot._goal = { from: 'Alex', blueprint: { blocks: [], empty: [{ x: 2, y: 64, z: 0 }], preserved: [] } };
  await bot.dig(blockAt(new Vec3(2, 64, 0)));
  assert.equal(dug, 1);
  // One of theirs it keeps: not.
  bot._goal.blueprint.preserved = [{ x: 2, y: 64, z: 0 }];
  assert.ok(keepsDig(bot, { x: 2, y: 64, z: 0 }));
  bot._goal = null;
  // Not to be broken on a walk or to get free, nor taken: theirs.
  assert.equal(theirsAt(bot, new Vec3(2, 64, 0)), true);
  assert.equal(leftAlone(bot, { allowBuilt: true }, new Vec3(2, 64, 0)), true);
  // A block they let it break, though seen laid by them: theirs and left alone before, neither after.
  const mode = process.env.JEV_BUILT;
  process.env.JEV_BUILT = 'leave';
  try {
    bot.placedLog = new PlacedLog(null);
    bot.placedLog.note('overworld', '2,64,1', 'cobblestone');
    assert.equal(theirsAt(bot, new Vec3(2, 64, 1)), true);
    assert.equal(leftAlone(bot, {}, new Vec3(2, 64, 1)), true);
    apply(bot, 'Alex', { do: 'use', what: 'this', thing: 'block', name: null }, look({ x: 2, y: 64, z: 1 }));
    assert.equal(theirsAt(bot, new Vec3(2, 64, 1)), false);
    assert.equal(leftAlone(bot, {}, new Vec3(2, 64, 1)), false);
    await bot.dig(blockAt(new Vec3(2, 64, 1)));
    assert.equal(dug, 2);
    // A block laid in its place since is not let go with it.
    set(2, 64, 1, 'stone_bricks');
    bot.placedLog.note('overworld', '2,64,1', 'stone_bricks');
    bot._builtKept = null;
    assert.equal(theirsAt(bot, new Vec3(2, 64, 1)), true);
    assert.equal(leftAlone(bot, {}, new Vec3(2, 64, 1)), true);
  } finally { if (mode === undefined) delete process.env.JEV_BUILT; else process.env.JEV_BUILT = mode; }
});

test("a kept chest is not opened; a kept house's chests neither, its furnace yes; a furnace kept on its own, no", async () => {
  const { world, set, blockAt } = scene();
  const blocks = [];
  for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) if (x === 0 || x === 4 || z === 0 || z === 4) { set(x, 64, z, 'cobblestone'); blocks.push({ x, y: 64, z, material: 'cobblestone' }); }
  set(1, 64, 1, 'chest', { facing: 'north', type: 'single', waterlogged: false }); blocks.push({ x: 1, y: 64, z: 1, material: 'chest' });
  set(3, 64, 3, 'furnace', { facing: 'north', lit: false }); blocks.push({ x: 3, y: 64, z: 3, material: 'furnace' });
  set(8, 64, 0, 'furnace', { facing: 'north', lit: false });
  const entry = { id: 'h', name: 'Stone Hut', bounds: { min: { x: 0, y: 64, z: 0 }, max: { x: 4, y: 64, z: 4 } }, blueprint: { blocks } };
  const bot = botIn(world, blockAt, { entries: [entry] });
  const opened = [];
  bot.openBlock = async block => { opened.push(block.name); return { block }; };
  openGuardPlugin(bot);
  apply(bot, 'Alex', { do: 'keep', what: 'here', thing: 'building', name: 'our hut' }, look(null, { x: 2, y: 64, z: 2 }));
  await assert.rejects(bot.openBlock(blockAt(new Vec3(1, 64, 1))), e => e.name === 'Blocked' && /won't open it/.test(e.message));
  await bot.openBlock(blockAt(new Vec3(3, 64, 3)));
  assert.deepEqual(opened, ['furnace']);
  apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'block', name: null }, look({ x: 8, y: 64, z: 0 }));
  assert.ok(refusesOpen(bot, blockAt(new Vec3(8, 64, 0))));
  await assert.rejects(bot.openBlock(blockAt(new Vec3(8, 64, 0))));
  set(10, 64, 0, 'chest', { facing: 'north', type: 'single', waterlogged: false });
  await bot.openBlock(blockAt(new Vec3(10, 64, 0)));
  assert.deepEqual(opened, ['furnace', 'chest']);
});

test('the chest the bot would loot: never a kept one; one marked use since it was opened, again', () => {
  const { world, set, blockAt } = scene(), bot = botIn(world, blockAt);
  for (const x of [0, 3, 6]) set(x, 64, 0, 'chest', { facing: 'north', type: 'single', waterlogged: false });
  bot.entity = { position: new Vec3(0.5, 64, 2.5) };
  bot.findBlocks = () => [new Vec3(0, 64, 0), new Vec3(3, 64, 0), new Vec3(6, 64, 0)];
  const opened = Date.now() - 60000, goal = { looted: { '3,64,0': { at: opened }, '6,64,0': { at: opened } } };
  const key = p => `${p.x},${p.y},${p.z}`;
  assert.deepEqual(lootableChests(bot, goal).map(key), ['0,64,0']);
  apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'chest', name: null }, look({ x: 0, y: 64, z: 0 }));
  apply(bot, 'Alex', { do: 'use', what: 'this', thing: 'chest', name: null }, look({ x: 6, y: 64, z: 0 }));
  assert.ok(usedSince(bot, { x: 6, y: 64, z: 0 }, opened));
  assert.deepEqual(lootableChests(bot, goal).map(key), ['6,64,0']);
});

test('the guide hands on a label, cleaned; a label alone is an answer; the prompt asks for one', async () => {
  const reply = { say: null, requests: [], label: { do: 'KEEP', what: 'here', thing: 'building', name: '/my house is here and it is a very long name indeed ok' } };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }] }) });
  // A minute between lines: the guide asks the model for a player only so often.
  let t = 1000000;
  const guide = createGuide({ fetchImpl, apiKey: 'test-key', file: null, now: () => (t += 60000), reasoning: '', built: false, personality: '' });
  const out = await guide.consult({ from: 'Alex', text: 'this is my house', botName: 'Jev', status: {} });
  assert.deepEqual(out.label, { do: 'keep', what: 'here', thing: 'building', name: 'my house is here and it is a very long n' });
  // No section sign: the server kicks a client for sending one.
  reply.label = { do: 'keep', what: 'here', thing: 'building', name: '\xa7cmy  den' };
  assert.equal((await guide.consult({ from: 'Alex', text: 'this is my den', botName: 'Jev', status: {} })).label.name, 'cmy den');
  reply.label = { do: 'paint', what: 'this' };
  assert.equal(await guide.consult({ from: 'Alex', text: 'paint it', botName: 'Jev', status: {} }), null);
  reply.label = { do: 'use', what: 'somewhere', thing: 'lamp', name: null };
  assert.deepEqual((await guide.consult({ from: 'Alex', text: 'you can use this', botName: 'Jev', status: {} })).label, { do: 'use', what: 'this', thing: 'block', name: null });
  // A leave for a whole building is the leave for buildings when built things are left alone; without, a label.
  const leaving = createGuide({ fetchImpl, apiKey: 'test-key', file: null, now: () => (t += 60000), reasoning: '', built: true, personality: '' });
  reply.label = { do: 'use', what: 'this', thing: 'building', name: null };
  const leave = await leaving.consult({ from: 'Alex', text: 'you can use this house', botName: 'Jev', status: {} });
  assert.equal(leave.useBuildings, true);
  assert.equal(leave.label, undefined);
  assert.equal((await guide.consult({ from: 'Alex', text: 'you can use this house', botName: 'Jev', status: {} })).label.do, 'use');
  // A standing rule forgotten: the forget is the rule's.
  reply.label = null; reply.add_rule = 'get spruce when wood is asked for';
  await guide.consult({ from: 'Alex', text: 'always get spruce', botName: 'Jev', status: {} });
  reply.add_rule = null; reply.forget_rule = 1; reply.label = { do: 'forget', what: 'this', thing: 'block', name: null };
  const forgot = await guide.consult({ from: 'Alex', text: 'forget that', botName: 'Jev', status: {} });
  assert.equal(forgot.forgotRule, 'get spruce when wood is asked for');
  assert.equal(forgot.label, undefined);
  assert.match(SYSTEM('Jev', { built: true }), /is "use_buildings" \(8\), never a label/);
  assert.doesNotMatch(SYSTEM('Jev'), /never a label/);
  assert.match(SYSTEM('Jev'), /is "forget_rule", not a label/);
  const prompt = SYSTEM('Jev');
  assert.match(prompt, /"label": \{"do": "keep" \| "use" \| "forget"/);
  assert.match(prompt, /set "label", with "say" null and no requests/);
  assert.match(prompt, /answer it in "say" from status\.labels/);
});

test('what is marked near a player, for the guide: nearest first, within reach', () => {
  const { world, set, blockAt } = scene(), bot = botIn(world, blockAt);
  set(2, 64, 0, 'chest', { facing: 'north', type: 'single', waterlogged: false });
  set(9, 64, 9, 'cobblestone');
  apply(bot, 'Alex', { do: 'keep', what: 'this', thing: 'chest', name: null }, look({ x: 2, y: 64, z: 0 }));
  apply(bot, 'Sam', { do: 'use', what: 'this', thing: 'block', name: null }, look({ x: 9, y: 64, z: 9 }));
  const near = statusNear(bot, { x: 0, y: 64, z: 0 });
  assert.deepEqual(near.map(l => [l.label, l.what, l.setBy]), [["don't touch", 'chest', 'Alex'], ['may use', 'cobblestone', 'Sam']]);
  assert.deepEqual(statusNear(bot, { x: 0, y: 64, z: 0 }, { radius: 5 }).length, 1);
  assert.deepEqual(statusNear(botIn(world, blockAt), { x: 0, y: 64, z: 0 }), []);
});
