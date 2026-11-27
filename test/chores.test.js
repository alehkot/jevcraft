'use strict';
// The waiting bot's own chores (src/chores.js): what is due about it and in what order, what keeps one from starting,
// and the tree chore's walk (src/tree-felling.js replantStep): only to the stumps it has a sapling for, the drops come
// down about the trees cut lately picked up, nothing planted anywhere else.
//
//   node test/chores.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const chores = require('../src/chores');
const felling = require('../src/tree-felling');

const v = (x, y, z) => new Vec3(x, y, z);
const task = { check() {} };
const env = {};
function world(cells = {}) {
  const m = new Map(Object.entries(cells));
  const nameAt = p => m.get(`${p.x},${p.y},${p.z}`) ?? (p.y < 63 ? 'dirt' : p.y === 63 ? 'grass_block' : 'air');
  return {
    blockAt: p => { const q = v(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), name = nameAt(q); return { name, type: name, position: q, boundingBox: /^(air|cave_air|water|short_grass|.*_sapling)$/.test(name) ? 'empty' : 'block' }; },
    set: (p, name) => m.set(`${p.x},${p.y},${p.z}`, name),
  };
}
const drop = (name, p) => ({ name: 'item', isValid: true, position: p, getDroppedItem: () => ({ name }) });
function botIn(w, { at = v(4.5, 64, 4.5), items = [], entities = {}, time = 1000 } = {}) {
  return { username: 'Jev', blockAt: w.blockAt, entity: { position: at }, entities, health: 20, food: 20, time: { timeOfDay: time },
    game: { gameMode: 'survival', dimension: 'overworld' }, inventory: { items: () => items } };
}
const oakStump = (x, z) => ({ block: 'oak_log', cells: [v(x, 64, z)], soil: [v(x, 63, z)] });

test('nothing about: no chore; an owed stump with a sapling carried: the trees, said as it sets out', () => {
  const w = world(), bot = botIn(w);
  assert.equal(chores.due(bot, { env }), null);
  felling.owe(bot, oakStump(10, 10));
  assert.equal(chores.due(bot, { env }), null, 'no sapling carried nor lying about the stump');
  bot.inventory.items = () => [{ name: 'oak_sapling', count: 1 }];
  const d = chores.due(bot, { env });
  assert.equal(d?.chore, 'trees');
  assert.equal(d.owed, 1);
  assert.equal(chores.line(d), "I'll plant saplings where I cut trees.");
  const g = chores.goalFor(bot, d, { player: { name: 'Robin' }, now: 1000 });
  assert.equal(g.kind, 'replant'); assert.equal(g.chore, 'trees'); assert.equal(g.from, 'Robin'); assert.equal(g.deliver, false);
  assert.equal(g.choreUntil, 1000 + chores.CHORE_MS);
});

test('a sapling fallen about the stump makes it due; one up on the leaves does not', () => {
  const w = world(), bot = botIn(w);
  felling.owe(bot, oakStump(10, 10));
  bot.entities = { 1: drop('oak_sapling', v(11.5, 69, 10.5)) };
  assert.equal(chores.due(bot, { env }), null, 'still on the leaves');
  bot.entities = { 1: drop('oak_sapling', v(11.5, 64, 10.5)) };
  assert.equal(chores.due(bot, { env })?.owed, 1);
});

test('only near the bot and the player it waits with', () => {
  const w = world(), bot = botIn(w, { items: [{ name: 'oak_sapling', count: 3 }] });
  felling.owe(bot, oakStump(30, 4));
  assert.equal(chores.due(bot, { env })?.chore, 'trees', 'twenty-six blocks off');
  assert.equal(chores.due(bot, { env, player: { name: 'Robin', position: v(-20, 64, 4) } }), null, 'fifty from the player');
  const far = botIn(world(), { items: [{ name: 'oak_sapling', count: 3 }] });
  felling.owe(far, oakStump(60, 4));
  assert.equal(chores.due(far, { env }), null, 'fifty-six from the bot');
});

test('the drops come down about a tree cut lately: due for five minutes; a stand left up a trunk: due', () => {
  const w = world(), bot = botIn(w);
  felling.noteFelled(bot, 'acacia_log', v(8, 64, 8), 0);
  assert.equal(chores.due(bot, { env, now: 1000 }), null, 'nothing lying about it');
  bot.entities = { 1: drop('acacia_log', v(9.5, 64, 7.5)) };
  const d = chores.treesDue(bot, { now: 1000 });
  assert.equal(d?.felled, 1);
  assert.equal(chores.line(d), "I'll pick up what came down from the trees I cut.");
  assert.equal(chores.treesDue(bot, { now: felling.FELLED_MS + 1 }), null, 'gone by now');
  w.set(v(2, 64, 2), 'dirt'); w.set(v(2, 65, 2), 'dirt');
  bot._treeStands = [{ cells: [{ x: 2, y: 64, z: 2 }, { x: 2, y: 65, z: 2 }] }];
  const s = chores.treesDue(bot, { now: felling.FELLED_MS + 1 });
  assert.equal(s?.stands, 1);
  assert.equal(chores.line(s), "I'll take down the blocks I left up a tree.");
});

test('none while stopped, threatened, hurt, hungry, by night or near dusk, resting, off, or outside the Overworld', () => {
  const mk = () => { const b = botIn(world(), { items: [{ name: 'oak_sapling', count: 1 }] }); felling.owe(b, oakStump(10, 10)); return b; };
  assert.ok(chores.due(mk(), { env }));
  assert.equal(chores.due(mk(), { env, paused: true }), null);
  assert.equal(chores.due(mk(), { env, threatened: true }), null);
  assert.equal(chores.due(mk(), { env, dark: true }), null);
  assert.equal(chores.due(Object.assign(mk(), { health: 8 }), { env }), null);
  assert.equal(chores.due(Object.assign(mk(), { food: 4 }), { env }), null);
  assert.equal(chores.due(Object.assign(mk(), { time: { timeOfDay: 11000 } }), { env }), null, 'a minute of daylight left');
  assert.equal(chores.due(mk(), { env, resting: n => n === 'trees' }), null);
  assert.equal(chores.due(mk(), { env: { JEV_CHORES: 'off' } }), null);
  assert.equal(chores.due(mk(), { env: { JEV_CHORES: 'sweeping' } }), null, 'none named that is a chore');
  assert.ok(chores.due(mk(), { env: { JEV_CHORES: 'trees' } }));
  assert.deepEqual([...chores.enabled({})], ['trees', 'garden', 'animals'], 'all on unless named');
  assert.deepEqual([...chores.enabled({ JEV_CHORES: 'trees' })], ['trees'], 'the garden left out');
  const nether = mk(); nether.game.dimension = 'the_nether';
  assert.equal(chores.due(nether, { env }), null);
});

test('a chore at it is ended after its minutes or near dusk', () => {
  const bot = botIn(world());
  const g = { chore: 'trees', choreUntil: 5000 };
  assert.equal(chores.over(g, bot, 4000), null);
  assert.equal(chores.over(g, bot, 5000), 'at it too long');
  bot.time.timeOfDay = 12000;
  assert.equal(chores.over(g, bot, 4000), 'night is near');
  assert.equal(chores.over({ kind: 'replant' }, bot, 9e9), null, 'a player\'s request is not a chore');
});

test('the tree chore: only the stumps with a sapling, what came down picked up, nothing planted elsewhere', async () => {
  const w = world(), items = [{ name: 'oak_sapling', count: 1 }];
  const bot = botIn(w, { items });
  felling.owe(bot, oakStump(3, 3));
  felling.owe(bot, { block: 'birch_log', cells: [v(12, 64, 3)], soil: [v(12, 63, 3)] });
  felling.noteFelled(bot, 'oak_log', v(-6, 64, 4));
  bot.entities = { 7: drop('oak_log', v(-5.5, 64, 4.5)) };
  const walks = [];
  const navigate = async (b, t, goal) => { walks.push([goal.x, goal.z]); b.entity.position = v(goal.x + 0.5, 64, goal.z + 0.5); };
  const place = async (b, t, p, m) => { w.set(p, m); const i = items.find(x => x.name === m); i.count--; };
  const collect = async (b, t, item) => { for (const [id, e] of Object.entries(b.entities)) if (e.getDroppedItem().name === item) { delete b.entities[id]; items.push({ name: item, count: 1 }); return true; } return false; };
  const goal = { kind: 'replant', chore: 'trees' };
  await felling.replantStep(bot, task, goal, null, { navigate, place, collect, dig: async () => {} });
  assert.equal(goal.planted, 1);
  assert.equal(w.blockAt(v(3, 64, 3)).name, 'oak_sapling');
  assert.equal(goal.picked, 1, 'the log come down about the tree cut');
  assert.ok(!walks.some(([x]) => x === 12), 'not to the birch stump, with no birch sapling: ' + JSON.stringify(walks));
  assert.equal(goal.replantLeft, 1, 'the birch still owed');
  assert.equal(goal.plantedHere, undefined, 'nothing planted about the player');
});

test('a chore is nobody\'s work: no "may I switch" for it, no reminder after, never what a resume takes up', () => {
  const { createHandoff } = require('../src/handoff');
  const h = createHandoff();
  const chore = { kind: 'replant', chore: 'trees', from: 'Robin', status: 'running' };
  assert.equal(h.holder({ active: { goal: chore }, from: 'Sam' }), null, 'another player asks');
  assert.equal(h.holder({ active: { goal: chore }, from: 'Robin' }), null, 'the player it waits with asks');
  assert.equal(h.holder({ active: { goal: { kind: 'obtain', from: 'Robin' } }, from: 'Sam' }), 'Robin', 'a player\'s work is asked about');
  assert.equal(require('../src/agenda').reminder({ ...chore, status: 'complete' }, { username: 'Jev' }), null);
  const { resumeSaved, suspendPrevious } = require('../src/suspended-tasks');
  const build = { kind: 'build', request: 'build a house', from: 'Robin', status: 'cancelled' };
  const ran = { ...chore, status: 'complete', suspendedTasks: suspendPrevious(build) };
  assert.equal(resumeSaved(ran).request, 'build a house', 'the stopped build under it, not the chore');
  assert.equal(suspendPrevious(ran).some(t => t.chore), false, 'a chore over is not kept under the next request');
});

test('nothing picked up into full pockets: not due for what lies about, not walked for', async () => {
  const w = world(), items = [];
  const bot = botIn(w, { items });
  bot.inventory.emptySlotCount = () => 0;
  felling.noteFelled(bot, 'oak_log', v(-6, 64, 4));
  bot.entities = { 7: drop('oak_log', v(-5.5, 64, 4.5)) };
  assert.equal(chores.treesDue(bot), null, 'full: the log lying is not a chore');
  items.push({ name: 'oak_log', count: 12, stackSize: 64 });
  assert.equal(chores.treesDue(bot)?.felled, 1, 'a stack of it with room');
  items.length = 0;
  felling.owe(bot, oakStump(3, 3));
  bot.entities = { 8: drop('oak_sapling', v(3.5, 64, 4.5)) };
  assert.equal(chores.treesDue(bot), null, 'full: the sapling lying is not taken');
  const walks = [];
  const goal = { kind: 'replant', chore: 'trees' };
  await felling.replantStep(bot, task, goal, null, { navigate: async (b, t, g) => walks.push(g), place: async () => {}, collect: async () => true });
  assert.equal(walks.length, 0);
  assert.equal(goal.picked, 0);
});
