'use strict';
// The first tools in a world new to the bot (JEV_START=tools: src/first-tools.js, launchArms and missionStepOver in
// src/session.js). Asked for 2026-11-23: "if the world just starts and jev just joined the new world it has by default
// mission to get wood axe and pickaxe and craft the crafting table and then get stone tools and sword as fast as
// possible".
//
//   node test/first-tools.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../src/first-tools');
const { setAside, isSetAside } = require('../src/progress');

const DURABILITY = { wooden_axe: 59, wooden_pickaxe: 59, golden_axe: 32, stone_axe: 131, stone_pickaxe: 131, stone_sword: 131, stone_shovel: 131, iron_pickaxe: 250, wooden_sword: 59 };
const registry = { itemsByName: Object.fromEntries(Object.entries(DURABILITY).map(([name, maxDurability]) => [name, { name, maxDurability }])) };
// A bot carrying [name, count, uses spent] each, by day in the Overworld.
function botWith(pockets, extra = {}) {
  const inv = pockets.map(([name, count = 1, used = 0]) => ({ name, count, durabilityUsed: used }));
  return { registry, game: { gameMode: 'survival', dimension: 'overworld' }, inventory: { items: () => inv }, health: 20, food: 20, entity: {},
    time: { timeOfDay: 1000, age: 1200 }, ...extra };
}
const ON = { JEV_START: 'tools' };
const begun = (failed = {}) => ({ state: { firstTools: { owedAt: 'then', begunAt: 'then', age: 1200, failed } } });
const ALL = [['wooden_axe'], ['wooden_pickaxe'], ['stone_pickaxe'], ['stone_sword'], ['stone_axe'], ['stone_shovel']];

test('owed only to a world new to the bot, and begun once its age is known and under three days', () => {
  assert.equal(tools.mode({}), null);
  assert.equal(tools.mode({ JEV_START: ' Tools ' }), 'tools');
  assert.equal(tools.mode({ JEV_START: 'yes' }), null);
  const fresh = {};
  assert.equal(tools.onConnect(fresh, { firstJoin: true, env: {} }), null, 'unset: nothing');
  assert.equal(fresh.firstTools, undefined);
  assert.ok(tools.onConnect(fresh, { firstJoin: true, env: ON }).owedAt);
  assert.equal(tools.onConnect(fresh, { firstJoin: true, env: ON }), null, 'decided once a world');
  const before = {};
  assert.match(tools.onConnect(before, { firstJoin: false, env: ON }).skipped, /been in this world before/);
  assert.equal(tools.begin(before, botWith([])), null, 'skipped stays skipped');
  assert.equal(tools.underway(before), false);
  assert.equal(tools.begin(fresh, botWith([], { time: { timeOfDay: 0 } })), null, 'the age not known yet');
  assert.equal(tools.begin(fresh, botWith([], { time: { age: 'soon' } })), null);
  assert.equal(tools.underway(fresh), false, 'owed is not begun');
  assert.equal(tools.begin(fresh, botWith([], { time: { age: 1200 } })), 'begun');
  assert.equal(tools.underway(fresh), true);
  assert.equal(fresh.firstTools.age, 1200);
  assert.equal(tools.begin(fresh, botWith([])), null, 'begun once');
  const old = { firstTools: { owedAt: 'then', failed: {} } };
  assert.equal(tools.begin(old, botWith([], { time: { age: 3 * 24000 } })), 'skipped');
  assert.match(old.firstTools.skipped, /past its third day/);
  assert.equal(tools.underway(old), false);
  const big = { firstTools: { owedAt: 'then', failed: {} } };
  assert.equal(tools.begin(big, botWith([], { time: { age: 5000n } })), 'begun', 'an age the protocol gives as a BigInt');
  assert.equal(tools.underway({ firstTools: { begunAt: 'then', done: 'later' } }), false);
});

test('the steps in order; one is carried with a tool of its kind and tier or better with ten uses left', () => {
  const next = pockets => tools.due(botWith(pockets), { survival: begun(), craftable: () => false, env: ON })?.item ?? null;
  assert.equal(next([]), 'wooden_axe');
  assert.equal(next([['wooden_axe']]), 'wooden_pickaxe');
  assert.equal(next([['golden_axe'], ['wooden_pickaxe']]), 'stone_pickaxe', 'any axe does for the wooden one');
  assert.equal(next([['wooden_axe'], ['wooden_pickaxe'], ['stone_pickaxe']]), 'stone_sword');
  assert.equal(next([['wooden_axe'], ['wooden_pickaxe'], ['stone_pickaxe'], ['stone_sword']]), 'stone_axe');
  assert.equal(next([['stone_axe'], ['stone_pickaxe'], ['stone_sword']]), 'stone_shovel', 'the stone ones do for the wooden ones');
  assert.equal(next([['iron_pickaxe']]), 'stone_sword', 'a stone pickaxe or better: no wooden ones, straight to the stone ones');
  assert.equal(next([['wooden_axe', 1, 50], ['wooden_pickaxe']]), 'wooden_axe', 'nine uses left: as good as none');
  assert.equal(next([['wooden_axe'], ['wooden_pickaxe'], ['stone_pickaxe'], ['stone_sword', 1, 125]]), 'stone_sword', 'a worn sword is not ready');
  assert.equal(next([['wooden_axe'], ['wooden_pickaxe'], ['stone_pickaxe'], ['wooden_sword']]), 'stone_sword', 'a wooden sword is not the stone one');
  assert.equal(next(ALL), null, 'all carried');
  assert.deepEqual(tools.left(botWith(ALL.slice(0, 3)), begun().state), ['stone_sword', 'stone_axe', 'stone_shovel']);
});

test('by day gathered for with three minutes of daylight ahead; in the dark only from the pockets; never while stopped, hurt or in danger', () => {
  const due = (bot, opts = {}) => tools.due(bot, { survival: begun(), craftable: () => false, env: ON, ...opts });
  assert.deepEqual(due(botWith([])), { item: 'wooden_axe', pockets: false, mission: true });
  assert.equal(due(botWith([], { time: { timeOfDay: 9000, age: 1200 } })), null, 'under three minutes of daylight');
  assert.deepEqual(due(botWith([], { time: { timeOfDay: 9000, age: 1200 } }), { craftable: item => item === 'wooden_axe' }), { item: 'wooden_axe', pockets: true, mission: true });
  assert.equal(due(botWith([]), { dark: true }), null);
  assert.deepEqual(due(botWith([]), { dark: true, craftable: () => true }), { item: 'wooden_axe', pockets: true, mission: true });
  assert.equal(due(botWith([]), { paused: true }), null, 'told to stop');
  assert.equal(due(botWith([]), { threatened: true }), null);
  assert.equal(due(botWith([], { health: 8 })), null);
  assert.equal(due(botWith([], { food: 4 })), null);
  assert.equal(due(botWith([], { entity: { isInWater: true } })), null);
  assert.equal(due(botWith([], { game: { gameMode: 'creative', dimension: 'overworld' } })), null);
  assert.equal(due(botWith([], { game: { gameMode: 'survival', dimension: 'minecraft:the_nether' } })), null);
  assert.equal(due(botWith([]), { env: {} }), null, 'unset');
  assert.equal(due(botWith([]), { survival: { state: { firstTools: { owedAt: 'then', failed: {} } } } }), null, 'owed, not begun');
  assert.equal(due(botWith([]), { survival: { state: { firstTools: { begunAt: 'then', done: 'later', failed: {} } } } }), null, 'done');
});

test('a step that came to nothing rests two minutes and is waited for; three times and it is left out', () => {
  const survival = begun(), bot = botWith([['wooden_axe']]);
  const at = now => tools.due(bot, { survival, craftable: () => false, env: ON, isSetAside: (h, a, t) => isSetAside(h, a, t, now) })?.item ?? null;
  assert.equal(at(Date.now()), 'wooden_pickaxe');
  setAside(survival, 'first_tools', 'wooden_pickaxe', 'no tree in reach', tools.STEP_REST_MS);
  assert.equal(at(Date.now()), null, 'resting: not passed for the next one');
  assert.equal(at(Date.now() + tools.STEP_REST_MS + 1000), 'wooden_pickaxe', 'then tried again');
  const gaveUp = begun({ wooden_pickaxe: tools.STEP_TRIES });
  assert.equal(tools.due(bot, { survival: gaveUp, craftable: () => false, env: ON }).item, 'stone_pickaxe');
  assert.deepEqual(tools.givenUp(bot, gaveUp.state), ['wooden_pickaxe']);
  assert.deepEqual(tools.givenUp(botWith([['wooden_axe'], ['stone_pickaxe']]), gaveUp.state), [], 'made after all: not left out');
  assert.equal(tools.due(bot, { survival: begun({ wooden_pickaxe: tools.STEP_TRIES - 1 }), craftable: () => false, env: ON }).item, 'wooden_pickaxe');
});

test('what it says: a line as it begins and one when all are made, and nothing for each step', () => {
  assert.equal(tools.startLine(tools.STEPS), "New world! I'm making my first tools: a wooden axe and pickaxe, then a stone pickaxe, sword, axe and shovel.");
  assert.equal(tools.startLine(['stone_sword', 'stone_shovel']), "New world! I'm making my first tools: a stone sword and shovel.");
  assert.equal(tools.startLine(['stone_shovel']), "New world! I'm making my first tools: a stone shovel.");
  assert.equal(tools.doneLine(botWith(ALL), begun().state), "I've made my first tools.");
  assert.equal(tools.doneLine(botWith(ALL.slice(0, 4)), begun({ stone_axe: 3, stone_shovel: 3 }).state), "I've made my first tools, all but the stone axe and the stone shovel.");
  const { completion } = require('../src/speech');
  assert.equal(completion({ kind: 'craft', item: 'stone_pickaxe', count: 1, deliver: false, weaponErrand: true, mission: true }), '', 'quiet between the steps');
  assert.equal(completion({ kind: 'craft', item: 'stone_sword', count: 1, deliver: false, weaponErrand: true }), "I've made a stone sword to carry.", 'the sword errand as before');
});
