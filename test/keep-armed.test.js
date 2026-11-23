'use strict';
// Keeping a sword (JEV_WEAPON, src/keep-armed.js, and the waiting bot's errand for one in src/session.js; asked for 2026-11-23: "jev should always try to carry some weapons
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

test('JEV_WEAPON: pockets or keep, anything else is off', () => {
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

test('JEV_WEAPON=keep: the waiting bot goes for a stone sword by day, by night only from its pockets', () => {
  assert.equal(arms.mode({ JEV_WEAPON: ' KEEP ' }), 'keep');
  const KEEP = { JEV_WEAPON: 'keep' };
  const none = () => false, makes = (...names) => item => names.includes(item);
  const waiting = (pockets = [], extra = {}) => Object.assign(botWith(pockets), { health: 20, food: 20, entity: {} }, extra);
  const due = (bot, opts = {}) => arms.errandDue(bot, { craftable: none, env: KEEP, ...opts });
  assert.deepEqual(due(waiting()), { item: 'stone_sword', pockets: false }, 'by day with empty pockets: gathered for');
  assert.deepEqual(due(waiting(), { craftable: makes('iron_sword', 'stone_sword') }), { item: 'iron_sword', pockets: true });
  assert.deepEqual(due(waiting(), { craftable: makes('wooden_sword') }), { item: 'stone_sword', pockets: false }, 'by day not wood');
  assert.equal(due(waiting(), { dark: true }), null, 'in the dark nothing is gathered for');
  assert.deepEqual(due(waiting(), { dark: true, craftable: makes('wooden_sword') }), { item: 'wooden_sword', pockets: true }, 'but wood from the pockets beats fists');
  assert.deepEqual(due(waiting([['stone_axe']]), { dark: true, craftable: makes('stone_sword') }), { item: 'stone_sword', pockets: true });
  assert.equal(due(waiting([['stone_sword']])), null, 'ready');
  assert.deepEqual(due(waiting([['stone_sword', 1, 125]])), { item: 'stone_sword', pockets: false }, 'about to break');
  assert.equal(due(waiting(), { env: POCKETS }), null, 'pockets only: no errand');
  assert.equal(due(waiting(), { env: {} }), null);
  assert.equal(due(waiting(), { paused: true }), null, 'told to stop');
  assert.equal(due(waiting(), { threatened: true }), null, 'a monster in sight');
  assert.equal(due(waiting([], { health: 11 })), null, 'hurt');
  assert.equal(due(waiting([], { food: 5 })), null, 'hungry');
  assert.equal(due(waiting([], { entity: { isInWater: true } })), null, 'swimming');
  assert.equal(due(Object.assign(botWith([], { gameMode: 'creative' }), { entity: {} })), null);
  assert.equal(due(Object.assign(botWith([], { dimension: 'the_nether' }), { entity: {} })), null);
  const survival = {};
  setAside(survival, 'weapon_errand', 'sword', 'no stone in reach', arms.ERRAND_REST_MS);
  assert.equal(due(waiting(), { survival, isSetAside }), null, 'resting after an errand');
  assert.deepEqual(due(waiting(), { survival: {}, isSetAside }), { item: 'stone_sword', pockets: false });
  assert.equal(arms.errandRequest('stone_sword'), 'craft a stone sword');
});

test("the errand is the bot's own: no one is asked before a request replaces it, and no \"continue\" is offered after it", () => {
  const { createHandoff } = require('../src/handoff');
  const handoff = createHandoff();
  const holder = goal => handoff.holder({ active: { goal }, from: 'Sky', online: () => true });
  assert.equal(holder({ kind: 'craft', item: 'stone_sword', from: 'Robin', weaponErrand: true }), null);
  assert.equal(holder({ kind: 'craft', item: 'stone_sword', from: 'Robin' }), 'Robin', "a player's own craft is still asked about");
  const { reminder } = require('../src/agenda');
  const under = [{ kind: 'build', status: 'interrupted', request: 'Jev build a starter house', from: 'Robin', item: undefined }];
  assert.equal(reminder({ kind: 'craft', item: 'stone_sword', status: 'complete', weaponErrand: true, suspendedTasks: under }), null);
});

test('after the errand the bot owes the player it waited with a walk back, by the rules after monsters', () => {
  const company = require('../src/company');
  const { Vec3 } = require('vec3');
  const bot = { username: 'Jev', entity: { position: new Vec3(30.5, 64, 0.5) }, players: { Robin: { username: 'Robin', entity: { position: new Vec3(0.5, 64, 0.5) } } }, game: { dimension: 'overworld' }, time: { timeOfDay: 6000 } };
  const t = 1000000;
  const scare = company.oweBack(bot, { name: 'Robin', position: { x: 0.5, y: 64, z: 0.5 } }, t);
  assert.equal(scare.with, 'Robin'); assert.equal(scare.errand, true);
  assert.equal(company.backDue(bot, { now: t + 1000 }), null, 'a moment first');
  assert.equal(company.backDue(bot, { now: t + 4000 }), scare, 'then back');
  bot.entity.position = new Vec3(3.5, 64, 0.5);
  assert.equal(company.backDue(bot, { now: t + 5000 }), null, 'already with them');
  assert.equal(company.oweBack(bot, null, t), null);
});

test('the errand: gathered for only with three minutes of daylight ahead; three that come to nothing and no more', () => {
  const KEEP = { JEV_WEAPON: 'keep' };
  const at = (timeOfDay, pockets = []) => Object.assign(botWith(pockets), { health: 20, food: 20, entity: {}, time: { timeOfDay } });
  const due = (bot, opts = {}) => arms.errandDue(bot, { craftable: () => false, env: KEEP, ...opts });
  assert.deepEqual(due(at(1000)), { item: 'stone_sword', pockets: false }, 'morning');
  assert.deepEqual(due(at(8000)), { item: 'stone_sword', pockets: false }, 'afternoon: 4300 ticks of day left');
  assert.equal(due(at(9000)), null, 'under three minutes of daylight: nothing gathered for');
  assert.deepEqual(due(at(9000), { craftable: item => item === 'stone_sword' }), { item: 'stone_sword', pockets: true }, 'but from the pockets');
  assert.deepEqual(due(at(23600)), { item: 'stone_sword', pockets: false }, 'dawn');
  assert.equal(arms.dayLeft(at(13000)), 0);
  assert.equal(arms.dayLeft(at(23600)), 400 + 12300);
  assert.equal(due(at(1000), { failures: arms.ERRAND_TRIES }), null, 'three that came to nothing');
  assert.deepEqual(due(at(1000), { failures: arms.ERRAND_TRIES - 1 }), { item: 'stone_sword', pockets: false });
});

test('the errand wants one sword more than is carried, and says what it has', () => {
  const robin = { name: 'Robin', position: { x: 0, y: 64, z: 0 } };
  assert.equal(arms.carried(botWith([['stone_sword', 1, 125], ['oak_log', 3]]), 'stone_sword'), 1, 'a worn one is still carried');
  assert.equal(arms.errandLine(botWith([]), 'stone_sword', { returnTo: robin }), "I have no sword, so I'm making a stone sword. Back soon, Robin.");
  assert.equal(arms.errandLine(botWith([]), 'stone_sword', { returnTo: robin, pockets: true }), "I have no sword, so I'm making a stone sword.");
  assert.equal(arms.errandLine(botWith([['wooden_sword']]), 'stone_sword'), "I only have a wooden sword, so I'm making a stone sword.");
  assert.equal(arms.errandLine(botWith([['stone_sword', 1, 125]]), 'stone_sword'), "My stone sword is nearly broken, so I'm making a new one.");
  assert.equal(arms.errandLine(botWith([['stone_sword', 1, 125]]), 'iron_sword'), "My stone sword is nearly broken, so I'm making an iron sword.");
  assert.equal(arms.errandRequest('iron_sword'), 'craft an iron sword');
  assert.equal(require('../src/speech').completion({ kind: 'craft', item: 'iron_sword', count: 1, deliver: false, weaponErrand: true }), "I've made an iron sword to carry.");
  const { completion } = require('../src/speech');
  assert.equal(completion({ kind: 'craft', item: 'stone_sword', count: 2, deliver: false, weaponErrand: true }), "I've made a stone sword to carry.");
  assert.equal(completion({ kind: 'craft', item: 'stone_sword', count: 1, deliver: false, weaponErrand: true, errandPockets: true }), '');
});

test('a running errand ends after eight minutes, or, gathering, with a minute of daylight left; not when already ended', () => {
  const at = timeOfDay => ({ time: { timeOfDay } });
  const goal = (extra = {}) => ({ weaponErrand: true, errandUntil: 1000000, ...extra });
  assert.equal(arms.errandOver(goal(), at(6000), 999999), null);
  assert.equal(arms.errandOver(goal(), at(6000), 1000001), 'it took too long');
  assert.equal(arms.errandOver(goal(), at(12300 - arms.ERRAND_END_LEFT + 1), 0), 'night is near');
  assert.equal(arms.errandOver(goal(), at(12300 - arms.ERRAND_END_LEFT), 0), null);
  assert.equal(arms.errandOver(goal({ errandPockets: true }), at(13000), 0), null, 'from the pockets: no walk away to end');
  assert.equal(arms.errandOver(goal({ errandEnded: 'it took too long' }), at(6000), 1000001), null);
  assert.equal(arms.errandOver(goal({ errandStopped: 'cancelled' }), at(6000), 1000001), null);
  assert.equal(arms.errandOver({ kind: 'craft' }, at(13000), 1000001), null, "a player's own craft");
});

test('pocketsMake with the real recipes (minecraft-data 26.1): a stone sword needs a table or the wood for one; nothing from empty pockets', () => {
  const real = require('minecraft-data')('26.1');
  const carrying = list => ({ registry: real, game: { gameMode: 'survival', dimension: 'overworld' }, inventory: { items: () => list.map(([name, count]) => ({ name, count, durabilityUsed: 0 })) } });
  assert.equal(arms.pocketsMake(carrying([['cobblestone', 4], ['stick', 2]]), 'stone_sword'), false, 'no table and no wood for one');
  assert.equal(arms.pocketsMake(carrying([['cobblestone', 4], ['stick', 2], ['crafting_table', 1]]), 'stone_sword'), true);
  assert.equal(arms.pocketsMake(carrying([['cobblestone', 4], ['oak_planks', 8]]), 'stone_sword'), true, 'table and sticks from the planks');
  assert.equal(arms.pocketsMake(carrying([['cobblestone', 4], ['oak_log', 3]]), 'stone_sword'), true);
  assert.equal(arms.pocketsMake(carrying([['oak_planks', 8]]), 'stone_sword'), false, 'the stone has to be mined');
  assert.equal(arms.pocketsMake(carrying([['oak_planks', 8]]), 'wooden_sword'), true);
  assert.equal(arms.pocketsMake(carrying([]), 'wooden_sword'), false);
});
