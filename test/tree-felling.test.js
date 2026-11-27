'use strict';
// Trees taken down whole (src/tree-felling.js), the low stands for a trunk (src/mining-access.js dryMiningPositions) and
// the saplings kept to plant (src/inventory-tidy.js). Seen in play: the tops of tree after tree left standing out of
// reach of every stand looked at, and no tree planted again, the saplings dropped as a kind no rung takes.
//
//   node test/tree-felling.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const felling = require('../src/tree-felling');
const { dryMiningPositions } = require('../src/mining-access');
const tidy = require('../src/inventory-tidy');

const v = (x, y, z) => new Vec3(x, y, z);
const task = { check() {} };
// A flat world: grass at y 63, dirt under it, air over it, and the cells given.
function world(cells = {}) {
  const m = new Map(Object.entries(cells));
  const nameAt = p => m.get(`${p.x},${p.y},${p.z}`) ?? (p.y < 63 ? 'dirt' : p.y === 63 ? 'grass_block' : 'air');
  return {
    blockAt: p => { const q = v(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), name = nameAt(q); return { name, type: name, position: q, boundingBox: /^(air|cave_air|water|short_grass|.*_sapling)$/.test(name) ? 'empty' : 'block' }; },
    set: (p, name) => m.set(`${p.x},${p.y},${p.z}`, name),
  };
}
const botIn = (w, { at = v(4.5, 64, 4.5), items = [] } = {}) => ({ blockAt: w.blockAt, entity: { position: at }, entities: {},
  game: { gameMode: 'survival', difficulty: 'peaceful', dimension: 'overworld' }, inventory: { items: () => items } });
// An oak: a trunk five high at (0, 64, 0), a branch log off its top at a slant, leaves about it, and a second tree.
function oak() {
  const cells = {};
  for (let y = 64; y <= 68; y++) cells[`0,${y},0`] = 'oak_log';
  cells['1,69,1'] = 'oak_log';
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (let y = 67; y <= 69; y++) cells[`${x},${y},${z}`] = 'oak_leaves';
  cells['6,64,6'] = 'oak_log'; cells['6,65,6'] = 'oak_log';
  return cells;
}

test('a tree is its logs joined side to side or at a slant: not the tree beside it, nor what a log left alone parts', () => {
  const bot = botIn(world(oak()));
  const logs = felling.treeLogs(bot, v(0, 66, 0));
  assert.equal(logs.length, 6);
  assert.deepEqual(logs[0], v(0, 64, 0), 'lowest first');
  assert.ok(logs.some(p => p.equals(v(1, 69, 1))), 'the branch at a slant');
  assert.ok(!logs.some(p => p.x === 6), 'not the next tree');
  assert.equal(felling.treeLogs(bot, v(0, 64, 0), { mine: p => p.y !== 66 }).length, 2);
  assert.deepEqual(felling.treeLogs(bot, v(3, 64, 3)), [], 'no log there');
  assert.deepEqual(felling.stumpOf(bot, logs, 'oak_log').cells, [v(0, 64, 0)]);
  assert.deepEqual(felling.stumpOf(bot, logs, 'oak_log').soil, [v(0, 63, 0)]);
  // The tree's top read after its trunk was cut: no stump in the air.
  const top = world({ '0,70,0': 'acacia_log', '1,71,0': 'acacia_log' });
  assert.equal(felling.stumpOf(botIn(top), felling.treeLogs(botIn(top), v(0, 70, 0)), 'acacia_log'), null);
});

test('a trunk is cut from the ground up to four over the feet', () => {
  const bot = botIn(world(oak()), { at: v(3.5, 64, 3.5) });
  const stands = dryMiningPositions(bot, v(0, 68, 0));
  assert.ok(stands.some(p => p.y === 64), 'a stand on the ground for the fifth log: ' + stands);
  // Not for stone: a block four over the feet is a climb's, as before.
  const rock = world({ '0,68,0': 'stone' }), rbot = botIn(rock, { at: v(3.5, 64, 3.5) });
  assert.deepEqual(dryMiningPositions(rbot, v(0, 68, 0)), []);
});

test('a log out of the ground\'s reach gets a stand: the fewest blocks, the head kept under the trunk', () => {
  // A spruce's trunk, its lower five cut: logs left from 69 to 74.
  const cells = {};
  for (let y = 69; y <= 74; y++) cells[`0,${y},0`] = 'spruce_log';
  const w = world(cells), bot = botIn(w);
  const tree = felling.treeLogs(bot, v(0, 69, 0));
  assert.equal(tree.length, 6);
  // The eye from the ground beside the trunk is 3.9 under the log's middle and 1 across: no block to lay.
  assert.equal(felling.standFor(bot, v(0, 69, 0), { tree }).height, 0);
  // 74: under the trunk the head may go no higher than 68, the eye 68.6, too low; beside it five blocks (eye 70.6).
  const high = felling.standFor(bot, v(0, 74, 0), { tree });
  assert.equal(high.height, 5);
  assert.ok(high.foot.x !== 0 || high.foot.z !== 0, 'beside the trunk');
  assert.equal(high.foot.y, 64);
  assert.ok(felling.withinArm(high.foot.offset(0, high.height, 0), v(0, 74, 0)));
  // A log over a stand of eight: none.
  assert.equal(felling.standFor(bot, v(0, 82, 0), { tree }), null);
  // The ground about it all a player's: none.
  assert.equal(felling.standFor(bot, v(0, 74, 0), { tree, forbidden: c => c.y === 63 }), null);
  // Water all round the trunk's foot: none.
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) w.set(v(x, 63, z), 'water');
  assert.equal(felling.standFor(bot, v(0, 74, 0), { tree }), null);
});

test('with no ground beside it the stand goes up in the trunk\'s own column, the head kept under the log', () => {
  // An acacia's top left over its cut trunk, in a pond: the stump's soil the only ground within two.
  const cells = { '0,70,0': 'acacia_log' };
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (x || z) cells[`${x},63,${z}`] = 'water';
  const bot = botIn(world(cells), { at: v(0.5, 64, 0.5) });
  const site = felling.standFor(bot, v(0, 70, 0), { tree: [v(0, 70, 0)] });
  // From the stump's cell the eye is 4.9 under the log's middle; one block makes it 3.9.
  assert.deepEqual(site.foot, v(0, 64, 0));
  assert.equal(site.height, 1);
  // A log right over the head of the highest stand that fits under it: the stand stops a block under the log.
  const low = felling.standFor(bot, v(0, 66, 0), { tree: [v(0, 66, 0)] });
  assert.equal(low.height, 0);
});

test('the sapling goes where the trunk stood, four in a square for a dark oak; one short is owed and planted later', async () => {
  const w = world(), bot = botIn(w, { items: [{ name: 'oak_sapling', count: 2 }] });
  const placed = [];
  const place = async (b, t, p, m) => { placed.push([p, m]); w.set(p, m); };
  const stump = { block: 'oak_log', cells: [v(0, 64, 0)], soil: [v(0, 63, 0)] };
  assert.deepEqual(felling.plantCells(bot, stump), [v(0, 64, 0)]);
  assert.equal(await felling.replant(bot, task, stump, { place }), 1);
  assert.deepEqual(placed, [[v(0, 64, 0), 'oak_sapling']]);
  assert.deepEqual(felling.plantCells(bot, stump), [], 'planted already');

  const items = [{ name: 'dark_oak_sapling', count: 3 }];
  const w2 = world(), bot2 = botIn(w2, { items });
  const dark = { block: 'dark_oak_log', cells: [v(4, 64, 4), v(5, 64, 4), v(4, 64, 5), v(5, 64, 5)] };
  assert.equal(felling.plantCells(bot2, dark).length, 4);
  assert.equal(await felling.replant(bot2, task, dark, { place: async (b, t, p, m) => w2.set(p, m) }), 0, 'three of four carried');
  assert.equal(bot2._replant.length, 1, 'owed');
  items[0].count = 4;
  assert.equal(await felling.replantOwed(bot2, task, { place: async (b, t, p, m) => w2.set(p, m) }), 4);
  assert.equal(bot2._replant.length, 0);
  // Stone under one of the four: a square of soil close by instead, clear of the stone.
  const w3 = world({ '5,63,5': 'stone' }), bot3 = botIn(w3, { items: [{ name: 'dark_oak_sapling', count: 8 }] });
  const sq = felling.plantCells(bot3, dark);
  assert.equal(sq.length, 4);
  assert.ok(!sq.some(c => c.x === 5 && c.z === 5), String(sq));
  assert.ok(sq.every(c => c.y === 64 && Math.abs(c.x - 4) <= 6 && Math.abs(c.z - 4) <= 6), String(sq));
  // A mangrove's is a propagule.
  assert.equal(felling.SAPLING.mangrove_log, 'mangrove_propagule');
});

test('where the trunk stood, preferably; else open soil close by; nothing where a sapling or the tree is back', async () => {
  const stump = { block: 'birch_log', cells: [v(0, 64, 0)] };
  // A block laid on the stump's cell: the nearest open soil, not beside a log or a sapling, nor a player's.
  const w = world({ '0,64,0': 'cobblestone', '1,64,0': 'birch_sapling', '-2,64,0': 'oak_log' }), bot = botIn(w, { items: [{ name: 'birch_sapling', count: 1 }] });
  const keep = c => c.x === 0 && c.z === 1;
  const [c] = felling.plantCells(bot, stump, { forbidden: keep });
  assert.ok(c && c.y === 64 && Math.max(Math.abs(c.x), Math.abs(c.z)) <= 5, String(c));
  assert.ok(Math.max(Math.abs(c.x - 1), Math.abs(c.z)) > 1 && Math.max(Math.abs(c.x + 2), Math.abs(c.z)) > 1, 'clear of the sapling and the log: ' + c);
  assert.ok(!keep(c));
  const placed = [];
  assert.equal(await felling.replant(bot, task, stump, { place: async (b, t, p, m) => { placed.push(p); w.set(p, m); }, forbidden: keep }), 1);
  assert.deepEqual(placed, [c]);
  // A sapling on the stump already (a player planted it): nothing to plant, nothing owed.
  const w2 = world({ '0,64,0': 'birch_sapling' }), bot2 = botIn(w2, { items: [{ name: 'birch_sapling', count: 3 }] });
  bot2._replant = [{ block: 'birch_log', cells: [{ x: 0, y: 64, z: 0 }], at: Date.now() }];
  assert.deepEqual(felling.plantCells(bot2, stump), []);
  assert.equal(await felling.replant(bot2, task, stump, { place: async () => assert.fail('planted twice') }), 0);
  assert.equal(bot2._replant.length, 0);
});

test('"replant the trees" plants the owed stumps; with none owed, the saplings carried about the player who asked', async () => {
  const w = world(), items = [{ name: 'oak_sapling', count: 3 }];
  const bot = botIn(w, { at: v(0.5, 64, 0.5), items });
  bot._replant = [{ block: 'oak_log', cells: [{ x: 3, y: 64, z: 3 }], at: Date.now() }];
  const place = async (b, t, p, m) => { w.set(p, m); const i = items.find(x => x.name === m); i.count--; };
  const goal = { kind: 'replant', from: 'Robin' };
  await felling.replantStep(bot, task, goal, null, { place, navigate: async () => {} });
  assert.equal(goal.planted, 1);
  assert.equal(w.blockAt(v(3, 64, 3)).name, 'oak_sapling');
  assert.equal(goal.replantLeft, 0);
  // None owed now: the two left planted near Robin, three or more apart.
  bot.players = { Robin: { entity: { position: v(10.5, 64, 10.5) } } };
  const goal2 = { kind: 'replant', from: 'Robin' };
  await felling.replantStep(bot, task, goal2, null, { place, navigate: async () => {} });
  assert.equal(goal2.replantNone, true);
  assert.equal(goal2.plantedHere, 2);
  assert.equal(items[0].count, 0);
});

test('a player asks it in the words players use', () => {
  const { companionAction } = require('../src/companion-actions');
  for (const t of ['replant the trees', 'replant', 'plant the saplings', 'plant trees where you cut them', 'put the trees back', 'can you replant the trees please'])
    assert.equal(companionAction(t)?.kind, 'replant', t);
  for (const t of ['cut the trees', 'plant wheat', 'replant the wheat', 'get me 64 logs']) assert.notEqual(companionAction(t)?.kind, 'replant', t);
});

test('saplings are kept, eight of a kind, no longer dropped as a kind no rung takes', () => {
  for (const n of ['oak_sapling', 'acacia_sapling', 'dark_oak_sapling', 'mangrove_propagule']) assert.equal(tidy.capFor(n, 'overworld'), 8, n);
});

test('what the bot laid itself about the trees it cut is taken down; not before the work, not far off, not the soil put back, not a kept cell', async () => {
  const w = world({ '2,64,0': 'dirt', '2,65,0': 'dirt', '-1,64,1': 'cobblestone', '9,64,9': 'dirt', '1,63,0': 'dirt', '0,64,2': 'dirt', '3,64,3': 'cobblestone' });
  const bot = botIn(w);
  const rec = (name, at) => ({ name, at });
  bot._laid = new Map([['2,64,0', rec('dirt', 200)], ['2,65,0', rec('dirt', 210)], ['-1,64,1', rec('cobblestone', 50)], ['9,64,9', rec('dirt', 300)],
    ['1,63,0', rec('dirt', 220)], ['0,64,2', rec('dirt', 230)]]);
  const dug = [];
  const dig = async (b, t, p) => { dug.push(`${p.x},${p.y},${p.z}`); w.set(p, 'air'); };
  const n = await felling.clearLaidAbout(bot, task, { dig, since: 100, trees: [v(0, 64, 0)], forbidden: c => c.x === 0 && c.z === 2 });
  assert.equal(n, 2);
  assert.deepEqual(dug, ['2,65,0', '2,64,0'], 'from the top: ' + dug.join(' | '));
  assert.equal(w.blockAt(v(-1, 64, 1)).name, 'cobblestone', 'laid before the work began');
  assert.equal(w.blockAt(v(9, 64, 9)).name, 'dirt', 'far from the tree');
  assert.equal(w.blockAt(v(1, 63, 0)).name, 'dirt', 'the soil put back in a hole');
  assert.equal(w.blockAt(v(0, 64, 2)).name, 'dirt', 'a cell kept');
  assert.equal(w.blockAt(v(3, 64, 3)).name, 'cobblestone', 'not laid by the bot');
});
