'use strict';
// The animals about a house (src/animals.js, a chore of src/chores.js): what makes it due, the herd's gathering point
// (kept off a garden and out of a house), those away from the herd led to it with wheat in hand, pairs of adults fed,
// none past eight of a kind and no baby, and the wheat put away from the hand whatever ended the run.
//
//   node test/animals.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { Vec3 } = require('vec3');
const animals = require('../src/animals');
const chores = require('../src/chores');
const garden = require('../src/garden');

const v = (x, y, z) => new Vec3(x, y, z);
const task = { check() {} };
const env = {};
const EMPTY = /^(air|cave_air|water|short_grass|tall_grass|wheat)$/;
const NAMES = ['red_bed', 'oak_door', 'crafting_table', 'short_grass', 'water', 'farmland', 'wheat', 'oak_planks', 'chest'];
const ITEMS = ['wheat', 'wheat_seeds', 'bread', 'stone_sword'];
const BABY = 15;                            // where the fake registry keeps 'baby' among an animal's metadata
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'animals-')), 'garden.json');
const counted = (list, name) => list.reduce((n, i) => n + (i.name === name ? i.count : 0), 0);
const quietly = fn => { const was = console.log, lines = []; console.log = (...a) => lines.push(a.join(' ')); try { return [fn(), lines]; } finally { console.log = was; } };
const quietlyAsync = async fn => { const was = console.log, lines = []; console.log = (...a) => lines.push(a.join(' ')); try { return [await fn(), lines]; } finally { console.log = was; } };

function world(cells = {}) {
  const m = new Map(Object.entries(cells));
  const entry = p => m.get(p.x + ',' + p.y + ',' + p.z) ?? (p.y < 63 ? 'dirt' : p.y === 63 ? 'grass_block' : 'air');
  const blockAt = p => {
    const q = v(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), e = entry(q), [name, props = {}] = Array.isArray(e) ? e : [e];
    return { name, type: name, position: q, boundingBox: EMPTY.test(name) ? 'empty' : 'block', getProperties: () => props };
  };
  const findBlocks = ({ point, matching, maxDistance, count }) => [...m.keys()].map(k => v(...k.split(',').map(Number)))
    .filter(p => matching.includes(blockAt(p).name) && p.distanceTo(point) <= maxDistance)
    .sort((a, b) => a.distanceTo(point) - b.distanceTo(point)).slice(0, count);
  return { blockAt, findBlocks, set: (p, name) => m.set(p.x + ',' + p.y + ',' + p.z, name) };
}
// A house of the bot's own registry, x and z -3 to 3, its door east; no water about, so no garden.
function homestead(extra = {}) {
  const cells = {}, blocks = [];
  const lay = (x, y, z, name, props) => { cells[x + ',' + y + ',' + z] = props ? [name, props] : name; blocks.push({ x, y, z, material: name }); };
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    lay(x, 67, z, 'oak_planks');
    if (Math.abs(x) === 3 || Math.abs(z) === 3) for (let y = 64; y <= 66; y++) lay(x, y, z, 'oak_planks');
  }
  lay(3, 64, 0, 'oak_door', { half: 'lower' }); lay(3, 65, 0, 'oak_door', { half: 'upper' });
  lay(0, 64, 0, 'red_bed', { part: 'foot' }); lay(-1, 64, 0, 'red_bed', { part: 'head' });
  Object.assign(cells, extra);
  const entry = { id: 'h1', name: 'Oak starter house', kind: 'build', status: 'unfinished', origin: { x: -3, y: 63, z: -3 }, entrance: { x: 4, y: 64, z: 0 },
    bounds: { min: { x: -3, y: 63, z: -3 }, max: { x: 3, y: 67, z: 3 } }, blueprint: { blocks } };
  const registry = { revision: 0, near: () => [entry], all: () => [entry], standing: () => 1, claimed: () => new Set(blocks.map(c => c.x + ',' + c.y + ',' + c.z)) };
  return { w: world(cells), registry };
}
function pockets(list = []) {
  const items = list.map(([name, count]) => ({ name, count, stackSize: 64 }));
  return {
    items: () => items.filter(i => i.count > 0),
    emptySlotCount: () => 36 - items.filter(i => i.count > 0).length,
    add(name, n = 1) { const i = items.find(x => x.name === name); if (i) i.count += n; else items.push({ name, count: n, stackSize: 64 }); },
    take(name, n = 1) { const i = items.find(x => x.name === name && x.count > 0); if (i) i.count -= Math.min(n, i.count); },
  };
}
let nid = 100;
// An animal: a baby eats the wheat to grow; one on its five minutes, or in love, takes none; one fenced never comes.
function animal(name, x, z, { baby = false, fenced = false, cooldown = false } = {}) {
  const id = ++nid, metadata = [];
  if (baby) metadata[BABY] = true;
  return { id, uuid: 'u' + id, name, type: 'animal', position: v(x + 0.5, 64, z + 0.5), isValid: true, metadata, height: baby ? 0.7 : 1.4, baby, fenced, cooldown };
}
function botIn(w, { at = v(0.5, 64, 12.5), items = [], registry = null, herd = [] } = {}) {
  const inv = pockets(items);
  const bot = {
    username: 'Jev', blockAt: w.blockAt, findBlocks: w.findBlocks, entity: { position: at, eyeHeight: 1.62 }, entities: {}, health: 20, food: 20,
    time: { timeOfDay: 1000 }, game: { gameMode: 'survival', dimension: 'overworld', hashedSeed: 'test' }, inventory: inv, held: null, fed: [],
    registry: { blocksArray: NAMES.map(name => ({ name, id: name })), itemsByName: Object.fromEntries(ITEMS.map(n => [n, { id: n }])),
      entitiesByName: Object.fromEntries(['cow', 'sheep', 'mooshroom', 'pig'].map(n => [n, { metadataKeys: Array.from({ length: 17 }, (_, i) => i === BABY ? 'baby' : 'k' + i) }])) },
    get heldItem() { return bot.held ? { name: bot.held } : null; },
    async equip(item) { bot.held = item.name; },
    setQuickBarSlot() { bot.held = null; },
    async lookAt() {},
    useOn(e) {
      if (bot.held !== 'wheat' || !['cow', 'sheep', 'mooshroom'].includes(e.name)) return;
      if (e.baby) { inv.take('wheat'); e.grew = (e.grew || 0) + 1; return; }
      if (e.cooldown || e.inLove) return;
      inv.take('wheat'); e.inLove = true; bot.fed.push(e.id);
    },
  };
  for (const e of herd) bot.entities[e.id] = e;
  if (registry) bot.buildRegistry = registry;
  bot._gardenFile = tmpFile();
  return bot;
}
// The pathfinder, and the game's pull of the wheat: walked to where the goal is, and every animal of these within ten
// blocks of a hand with wheat in it, not fenced, comes to two from it.
function helpers(bot) {
  const seen = { walks: 0 };
  const tempt = () => {
    if (bot.held !== 'wheat') return;
    const p = bot.entity.position;
    for (const e of Object.values(bot.entities)) {
      if (!['cow', 'sheep', 'mooshroom'].includes(e.name) || e.fenced) continue;
      const d = e.position.distanceTo(p);
      if (d > 10 || d <= 2) continue;
      const t = (d - 2) / d;
      e.position = v(e.position.x + (p.x - e.position.x) * t, 64, e.position.z + (p.z - e.position.z) * t);
    }
  };
  return {
    seen,
    navigate: async (b, t, goal) => {
      t.check();
      seen.walks++;
      const p = b.entity.position;
      if (goal.entity) {
        const e = goal.entity, d = e.position.distanceTo(p), r = Math.sqrt(goal.rangeSq || 4) - 0.5, k = d > r ? (d - r) / d : 0;
        b.entity.position = v(p.x + (e.position.x - p.x) * k, 64, p.z + (e.position.z - p.z) * k);
      } else b.entity.position = v(goal.x + 0.5, 64, goal.z + 0.5);
      tempt();
    },
  };
}
const across = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

test('by a house: one away from the herd led to it with wheat in hand, then two pairs fed, the hand emptied after', async () => {
  const { w, registry } = homestead();
  const herd = [animal('cow', -8, 8), animal('cow', -7, 10), animal('cow', -9, 9)], stray = animal('cow', -8, 22);
  const bot = botIn(w, { registry, items: [['wheat', 6], ['stone_sword', 1]], herd: [...herd, stray] });
  const d = animals.herdDue(bot, {});
  assert.equal(d?.chore, 'animals');
  assert.equal(d.kind, 'cow');
  assert.deepEqual(d.point, { x: -8, y: 64, z: 8 }, 'where three stand, the nearest the house of them');
  assert.equal(d.strays, 1); assert.equal(d.pairs, 2); assert.equal(d.herd, 4);
  assert.equal(chores.line(d), "I'll bring the cows together.");
  const goal = chores.goalFor(bot, d, { now: 0 });
  assert.equal(goal.kind, 'animals'); assert.equal(goal.herdKind, 'cow');
  const [, lines] = await quietlyAsync(() => animals.herdStep(bot, task, goal, null, helpers(bot)));
  assert.equal(goal.led, 1);
  assert.ok(across(stray.position, d.point) <= animals.SPREAD, 'with the herd now: ' + stray.position);
  assert.equal(goal.fed, 4); assert.equal(goal.pairs, 2);
  assert.equal(counted(bot.inventory.items(), 'wheat'), 2);
  assert.equal(bot.held, null, 'the wheat put away from the hand');
  assert.ok(lines.some(l => /^\[animals\] cows by \(-8, 64, 8\): 1 led, 2 pairs fed/.test(l)), lines.join(' | '));
  assert.equal(animals.herdDue(bot, {}), null, 'all fed, the one led let be');
});

test('not due: no house about, one adult, no wheat, eight of a kind about; a baby is never fed', async () => {
  const { w, registry } = homestead();
  const two = () => [animal('cow', -8, 8), animal('cow', -9, 12)];
  assert.equal(animals.herdDue(botIn(world({}), { items: [['wheat', 4]], herd: two() }), {}), null, 'no house');
  assert.equal(animals.herdDue(botIn(w, { registry, items: [['wheat', 4]], herd: [animal('cow', -8, 8), animal('cow', -9, 9, { baby: true })] }), {}), null, 'one adult');
  assert.equal(animals.herdDue(botIn(w, { registry, items: [['bread', 4]], herd: two() }), {}), null, 'no wheat');
  const full = [...two(), ...[0, 1, 2, 3, 4, 5].map(i => animal('cow', -10 + i % 3, 8 + Math.floor(i / 3), { baby: true }))];
  assert.equal(animals.herdDue(botIn(w, { registry, items: [['wheat', 4]], herd: full }), {}), null, 'eight about');
  const young = [animal('cow', -8, 8), animal('cow', -9, 10), animal('cow', -10, 8, { baby: true }), animal('cow', -8, 10, { baby: true })];
  const bot = botIn(w, { registry, items: [['wheat', 4]], herd: young });
  const d = animals.herdDue(bot, {});
  assert.equal(d?.pairs, 1, 'two adults: one pair');
  const goal = chores.goalFor(bot, d, { now: 0 });
  await quietlyAsync(() => animals.herdStep(bot, task, goal, null, helpers(bot)));
  assert.equal(goal.fed, 2);
  assert.ok(young.filter(e => e.baby).every(e => !e.grew), 'no baby fed');
  assert.equal(animals.herdDue(botIn(w, { registry, items: [['wheat', 4]], herd: two() }), { player: { name: 'Robin', position: v(0, 64, 80) } }), null, 'the player waited with far off');
});

test('one that does not come is let be half an hour; one that will not take the wheat is let be; a lone one is not fed', async () => {
  const { w, registry } = homestead();
  const slow = animal('cow', -9, 9, { cooldown: true }), fenced = animal('cow', -8, 22, { fenced: true });
  const herd = [animal('cow', -8, 8), animal('cow', -7, 10), slow, fenced];
  const bot = botIn(w, { registry, items: [['wheat', 4]], herd });
  const d = animals.herdDue(bot, {});
  assert.equal(d.strays, 1);
  const goal = chores.goalFor(bot, d, { now: 0 });
  await quietlyAsync(() => animals.herdStep(bot, task, goal, null, helpers(bot)));
  assert.equal(goal.led, 0); assert.equal(goal.stayed, 1);
  assert.equal(goal.fed, 2); assert.equal(goal.pairs, 1, 'the two that took it; the one fenced off alone never fed');
  assert.ok(!bot.fed.includes(fenced.id));
  assert.equal(counted(bot.inventory.items(), 'wheat'), 2);
  assert.equal(animals.herdDue(bot, {}), null, 'the fenced one let be, the slow one too');
});

test('the gathering point: off the garden, out of the house and away from its walls', () => {
  const houses = [{ min: { x: -3, y: 63, z: -3 }, max: { x: 3, y: 67, z: 3 } }];
  const plots = [{ middle: { x: 7, y: 63, z: 0 } }];
  const onPlot = [[6, 1], [7, -1], [8, 0], [7, 1]].map(([x, z]) => animal('cow', x, z));
  const inside = [[0, 1], [1, 1], [-1, -1]].map(([x, z]) => animal('cow', x, z));
  const out = [animal('cow', -12, 0), animal('cow', -13, 1)];
  assert.deepEqual(animals.pointFor([...onPlot, ...inside, ...out], houses, plots), { x: -12, y: 64, z: 0, n: 2 });
  assert.equal(animals.pointFor([...onPlot, ...inside, animal('cow', 4, 0)], houses, plots), null, 'against the wall');
});

test('the bread leaves the herd its wheat: two pairs\' worth under eight, one to lead with at eight, none with the chore off', () => {
  const { w } = homestead({ '-6,64,0': 'crafting_table' });
  const plot = { middle: { x: 7, y: 63, z: 0 } };
  const pair = () => [animal('cow', -8, 8), animal('cow', -9, 10)];
  const bot = botIn(w, { items: [['wheat', 7]], herd: pair() });
  assert.equal(animals.wheatWanted(bot), 4);
  assert.equal(garden.loavesFor(bot, plot), 1, 'seven wheat, four kept: one loaf');
  assert.equal(animals.wheatWanted(bot, { env: { JEV_CHORES: 'trees,garden' } }), 0);
  const alone = botIn(w, { items: [['wheat', 7]], herd: [animal('cow', -8, 8)] });
  assert.equal(animals.wheatWanted(alone), 0);
  assert.equal(garden.loavesFor(alone, plot), 2);
  const eight = botIn(w, { items: [['wheat', 20]], herd: [...pair(), ...[0, 1, 2, 3, 4, 5].map(i => animal('cow', -10 + i, 14))] });
  assert.equal(animals.wheatWanted(eight), 1);
  assert.deepEqual(garden.surplusOf(botIn(w, { items: [['wheat', 20]], herd: pair() })), { wheat: 14 }, 'twenty: two past a loaf and four for the herd kept');
});

test('a herd by the house, farther than twenty-four from where the bot waits, is about; its wheat kept ten minutes after it wanders off', async () => {
  const { w, registry } = homestead({ '-6,64,0': 'crafting_table' });
  // The bot waits by its player 22 west of the house; the cows stand by its east wall, 27 to 29 off.
  const herd = [animal('cow', 5, 1), animal('cow', 6, -1), animal('cow', 4, 2)];
  const bot = botIn(w, { registry, at: v(-21.5, 64, 0.5), items: [['wheat', 7]], herd });
  assert.ok(herd.every(e => e.position.distanceTo(bot.entity.position) > animals.FIND));
  const d = animals.herdDue(bot, {});
  assert.equal(d?.kind, 'cow', 'by the house');
  assert.equal(d.pairs, 1);
  const now = Date.now();
  assert.equal(animals.wheatWanted(bot, { now }), 4);
  for (const e of herd) delete bot.entities[e.id];
  assert.equal(animals.wheatWanted(bot, { now: now + 60000 }), 4, 'gone a minute: still kept');
  assert.equal(animals.wheatWanted(bot, { now: now + animals.SEEN_MS + 1000 }), 0, 'gone ten minutes');
  assert.equal(animals.wheatWanted(botIn(world({}), { items: [['wheat', 7]], herd: [animal('cow', 0, 0), animal('cow', 1, 1)] })), 0, 'no house about: none kept');
});

test('a run cut short: the wheat is put away from the hand all the same', async () => {
  const { w, registry } = homestead();
  const bot = botIn(w, { registry, items: [['wheat', 6]], herd: [animal('cow', -8, 8), animal('cow', -7, 10), animal('cow', -8, 22)] });
  const goal = chores.goalFor(bot, animals.herdDue(bot, {}), { now: 0 });
  const h = helpers(bot), walk = h.navigate;
  let calls = 0;
  h.navigate = async (...a) => { if (++calls === 2) { const err = new Error('stopped'); err.name = 'Cancelled'; throw err; } return walk(...a); };
  await assert.rejects(quietlyAsync(() => animals.herdStep(bot, task, goal, null, h)), { name: 'Cancelled' });
  assert.equal(bot.held, null);
});

test('a chore after the trees and the garden: JEV_CHORES names it, its line, its goal, its rest', () => {
  const { w, registry } = homestead();
  const bot = botIn(w, { registry, items: [['wheat', 4]], herd: [animal('sheep', -8, 8), animal('sheep', -7, 10)] });
  const [d] = quietly(() => chores.due(bot, { env }));
  assert.equal(d?.chore, 'animals');
  assert.equal(d.kind, 'sheep');
  assert.equal(chores.line(d), "I'll give the sheep some wheat.");
  assert.equal(quietly(() => chores.due(bot, { env: { JEV_CHORES: 'trees,garden' } }))[0], null);
  assert.equal(quietly(() => chores.due(bot, { env, resting: n => n === 'animals' }))[0], null);
  assert.ok(chores.ORDER.indexOf('animals') > chores.ORDER.indexOf('garden'));
  assert.ok(chores.REST_MS.animals >= animals.BRED_MS);
});
