'use strict';
// Keeping a sword (JEV_WEAPON, src/keep-armed.js; asked for 2026-11-23: "jev should always try to carry some weapons
// and for the very first night getting stone sword at least", with a set handed out by the server turned down).
//
//   node test/keep-armed.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const arms = require('../src/keep-armed');
const { setAside, isSetAside } = require('../src/progress');

const DURABILITY = { wooden_sword: 59, golden_sword: 32, stone_sword: 131, copper_sword: 190, iron_sword: 250, diamond_sword: 1561, stone_axe: 131, iron_axe: 250, wooden_pickaxe: 59 };
const registry = { itemsByName: Object.fromEntries(Object.entries(DURABILITY).map(([name, maxDurability]) => [name, { name, maxDurability }])) };
// A bot carrying [name, count, uses spent] each.
function botWith(pockets, { gameMode = 'survival', dimension = 'overworld' } = {}) {
  const inv = pockets.map(([name, count = 1, used = 0]) => ({ name, count, durabilityUsed: used }));
  return { registry, game: { gameMode, dimension }, inventory: { items: () => inv }, said: [], chat(line) { this.said.push(line); } };
}
const countOf = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
const task = { check() {} };
const POCKETS = { JEV_WEAPON: 'pockets' };

test('ready is a stone sword or better with ten uses left; an axe or a wooden sword is armed, not ready', () => {
  assert.equal(arms.ready(botWith([['stone_axe']])), false);
  assert.equal(arms.armed(botWith([['stone_axe']])), true, 'the stone axe made as a tool');
  assert.equal(arms.ready(botWith([['wooden_sword']])), false);
  assert.equal(arms.ready(botWith([['stone_sword', 1, 125]])), false, 'six uses left: about to break');
  assert.equal(arms.ready(botWith([['stone_sword', 1, 121]])), true, 'ten left');
  assert.equal(arms.ready(botWith([['iron_sword']])), true);
  assert.equal(arms.ready(botWith([['copper_sword']])), true);
  assert.equal(arms.bestSword(botWith([['wooden_sword'], ['iron_sword'], ['stone_sword']])).name, 'iron_sword');
  assert.equal(arms.armed(botWith([['wooden_pickaxe']])), false);
});

test('the sword the pockets make: the best of iron, copper and stone; a wooden one only with no weapon at all', () => {
  const makes = (...names) => item => names.includes(item);
  assert.equal(arms.pocketSword(botWith([]), makes('stone_sword', 'iron_sword', 'wooden_sword')), 'iron_sword');
  assert.equal(arms.pocketSword(botWith([]), makes('stone_sword', 'wooden_sword')), 'stone_sword');
  assert.equal(arms.pocketSword(botWith([]), makes('wooden_sword')), 'wooden_sword', 'nothing at all: wood will do');
  assert.equal(arms.pocketSword(botWith([['stone_axe']]), makes('wooden_sword')), null, 'an axe beats a wooden sword');
  assert.equal(arms.pocketSword(botWith([['wooden_sword']]), makes('stone_sword')), 'stone_sword', 'wood is made better');
  assert.equal(arms.pocketSword(botWith([['stone_sword']]), makes('iron_sword')), null, 'ready: nothing is made');
  assert.equal(arms.pocketSword(botWith([]), makes()), null);
});

test("the job's own items are never spent on a sword", () => {
  const all = () => true;
  assert.equal(arms.pocketSword(botWith([]), all, arms.spareFor({ kind: 'obtain', item: 'iron_ingot', deliver: true })), 'copper_sword', 'iron ingots asked for go to the player');
  assert.equal(arms.pocketSword(botWith([]), all, arms.spareFor({ kind: 'obtain', item: 'oak_log' })), null, 'logs asked for: no sword takes a stick from them');
  assert.equal(arms.pocketSword(botWith([]), all, arms.spareFor({ kind: 'obtain', item: 'cobblestone' })), 'iron_sword');
  assert.equal(arms.pocketSword(botWith([]), item => item === 'stone_sword', arms.spareFor({ kind: 'obtain', item: 'cobblestone' })), null);
  assert.equal(arms.pocketSword(botWith([]), all, arms.spareFor({ kind: 'craft', item: 'stone_pickaxe' })), 'iron_sword');
  assert.equal(arms.pocketSword(botWith([]), all, arms.spareFor({ kind: 'bundle', tasks: [{ item: 'stick' }] })), null);
});

test('JEV_WEAPON: pockets, anything else is off', () => {
  assert.equal(arms.mode({}), null);
  assert.equal(arms.mode({ JEV_WEAPON: 'pockets' }), 'pockets');
  assert.equal(arms.mode({ JEV_WEAPON: ' Pockets ' }), 'pockets');
  assert.equal(arms.mode({ JEV_WEAPON: 'yes' }), null);
});

test('at work, a sword the pockets make is made first, said once, and the step in hand kept', async () => {
  const bot = botWith([['cobblestone', 3], ['stick', 2]]);
  const goal = { kind: 'craft', item: 'stone_pickaxe', step: { action: 'mine', block: 'stone' } };
  const asked = [];
  const acquireStep = async (b, t, item, want) => { asked.push([item, want]); b.inventory.items().push({ name: item, count: 1, durabilityUsed: 0 }); goal.step = { action: 'craft', item }; return true; };
  const acted = await arms.workSword(bot, task, goal, () => {}, { acquireStep, craftable: item => item === 'stone_sword', countOf, setAside, isSetAside, env: POCKETS });
  assert.equal(acted, true);
  assert.deepEqual(asked, [['stone_sword', 1]]);
  assert.deepEqual(goal.step, { action: 'mine', block: 'stone' }, 'the job goes on from its own step');
  assert.deepEqual(bot.said, ['No sword on me, and my pockets make a stone sword: making it first.']);
  assert.equal(await arms.workSword(bot, task, goal, () => {}, { acquireStep, craftable: () => true, countOf, setAside, isSetAside, env: POCKETS }), false, 'ready now');
});

test('not when off, not on a come, a follow or a guard, not in creative or the Nether; a failure rests ten minutes', async () => {
  const bot = () => botWith([['cobblestone', 3], ['stick', 2]]);
  const opts = (extra = {}) => ({ acquireStep: async () => { throw new Error('acquireStep should not run'); }, craftable: () => true, countOf, setAside, isSetAside, env: POCKETS, ...extra });
  assert.equal(await arms.workSword(bot(), task, { kind: 'craft', item: 'stone_pickaxe' }, () => {}, opts({ env: {} })), false, 'JEV_WEAPON unset');
  for (const goal of [{ kind: 'come' }, { kind: 'follow' }, { kind: 'follow', guard: true }, { kind: 'win' }, { kind: 'survive' }])
    assert.equal(await arms.workSword(bot(), task, goal, () => {}, opts()), false, JSON.stringify(goal));
  assert.equal(await arms.workSword(botWith([['cobblestone', 3]], { gameMode: 'creative' }), task, { kind: 'craft', item: 'stone_pickaxe' }, () => {}, opts()), false);
  assert.equal(await arms.workSword(botWith([['cobblestone', 3]], { dimension: 'the_nether' }), task, { kind: 'craft', item: 'stone_pickaxe' }, () => {}, opts()), false);
  const goal = { kind: 'build', step: { action: 'place' } }, b = bot();
  const failing = opts({ acquireStep: async () => { throw new Error('no table in reach'); } });
  assert.equal(await arms.workSword(b, task, goal, () => {}, failing), true, 'tried: the loop plans again');
  assert.deepEqual(goal.step, { action: 'place' });
  assert.equal(await arms.workSword(b, task, goal, () => {}, failing), false, 'resting');
  const stopped = opts({ acquireStep: async () => { throw Object.assign(new Error('stop'), { name: 'Cancelled' }); } });
  await assert.rejects(arms.workSword(bot(), task, { kind: 'build' }, () => {}, stopped), { name: 'Cancelled' });
});
