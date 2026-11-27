'use strict';
// The herd's pen by a house (src/pen.js, built and used by the animals chore, src/animals.js): its place, its wood, its
// building, the herd brought in through its gates and pairs fed over its fence, the pen the bot's own once it stands,
// and one taken down let go.
//
//   node test/pen.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { Vec3 } = require('vec3');
const pen = require('../src/pen');
const animals = require('../src/animals');
const chores = require('../src/chores');
const garden = require('../src/garden');
const homeBase = require('../src/home-base');

const v = (x, y, z) => new Vec3(x, y, z);
const task = { check() {} };
const EMPTY = /^(air|cave_air|water|short_grass|tall_grass)$/;
const NAMES = ['red_bed', 'oak_door', 'crafting_table', 'short_grass', 'water', 'oak_planks', 'oak_log', 'oak_leaves', 'oak_fence', 'oak_fence_gate', 'chest'];
const ITEMS = ['wheat', 'wheat_seeds', 'bread', 'oak_log', 'oak_planks', 'stick', 'oak_fence', 'oak_fence_gate', 'oak_sapling'];
const BABY = 15;
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pen-')), 'jev-garden.json');
const quietly = fn => { const was = console.log, lines = []; console.log = (...a) => lines.push(a.join(' ')); try { return [fn(), lines]; } finally { console.log = was; } };
const quietlyAsync = async fn => { const was = console.log, lines = []; console.log = (...a) => lines.push(a.join(' ')); try { return [await fn(), lines]; } finally { console.log = was; } };

function world(cells = {}) {
  const m = new Map(Object.entries(cells).map(([k, e]) => [k, Array.isArray(e) ? e : [e, {}]]));
  const entry = p => m.get(p.x + ',' + p.y + ',' + p.z) ?? [p.y < 63 ? 'dirt' : p.y === 63 ? 'grass_block' : 'air', {}];
  const blockAt = p => {
    const q = v(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), [name, props] = entry(q);
    return { name, type: name, position: q, boundingBox: EMPTY.test(name) ? 'empty' : 'block', getProperties: () => props };
  };
  const findBlocks = ({ point, matching, maxDistance, count }) => [...m.keys()].map(k => v(...k.split(',').map(Number)))
    .filter(p => matching.includes(blockAt(p).name) && p.distanceTo(point) <= maxDistance)
    .sort((a, b) => a.distanceTo(point) - b.distanceTo(point)).slice(0, count);
  return { blockAt, findBlocks, set: (p, name, props = {}) => m.set(p.x + ',' + p.y + ',' + p.z, [name, props]), cells: m };
}
// A house of the bot's own registry, x and z -3 to 3, its floor at 63, its door east.
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
  const entry = { id: 'h1', name: 'Oak starter house', kind: 'build', status: 'complete', origin: { x: -3, y: 63, z: -3 }, entrance: { x: 4, y: 64, z: 0 },
    bounds: { min: { x: -3, y: 63, z: -3 }, max: { x: 3, y: 67, z: 3 } }, blueprint: { blocks } };
  const registry = { revision: 0, near: () => [entry], all: () => [entry], standing: () => 1, claimed: () => new Set(blocks.map(c => c.x + ',' + c.y + ',' + c.z)) };
  return { w: world(cells), registry };
}
function pockets(list = []) {
  const items = list.map(([name, count]) => ({ name, count, stackSize: 64 }));
  return {
    slots: [],
    items: () => items.filter(i => i.count > 0),
    emptySlotCount: () => 36 - items.filter(i => i.count > 0).length,
    add(name, n = 1) { const i = items.find(x => x.name === name); if (i) i.count += n; else items.push({ name, count: n, stackSize: 64 }); },
    take(name, n = 1) { const i = items.find(x => x.name === name && x.count > 0); if (i) i.count -= Math.min(n, i.count); },
    has: (name, n) => items.filter(x => x.name === name).reduce((a, x) => a + x.count, 0) >= n,
  };
}
const carried = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
// The game's own recipes, as far as these go: what each makes, of what, and whether at a table.
const RECIPES = {
  oak_planks: { makes: 4, of: { oak_log: 1 }, table: false },
  stick: { makes: 4, of: { oak_planks: 2 }, table: false },
  oak_fence: { makes: 3, of: { oak_planks: 4, stick: 2 }, table: true },
  oak_fence_gate: { makes: 1, of: { oak_planks: 2, stick: 4 }, table: true },
};
let nid = 100;
function animal(name, x, z, { baby = false, fenced = false } = {}) {
  const id = ++nid, metadata = [];
  if (baby) metadata[BABY] = true;
  return { id, uuid: 'u' + id, name, type: 'animal', position: v(x + 0.5, 64, z + 0.5), isValid: true, metadata, height: baby ? 0.7 : 1.4, width: 0.9, baby, fenced };
}
function botIn(w, { at = v(0.5, 64, 12.5), items = [], registry = null, herd = [] } = {}) {
  const inv = pockets(items);
  const bot = {
    username: 'Jev', blockAt: w.blockAt, findBlocks: w.findBlocks, entity: { position: at, eyeHeight: 1.62 }, entities: {}, health: 20, food: 20,
    time: { timeOfDay: 1000 }, game: { gameMode: 'survival', dimension: 'overworld', hashedSeed: 'test' }, inventory: inv, held: null, fed: [], controls: {},
    registry: { blocksArray: NAMES.map(name => ({ name, id: name })), itemsByName: Object.fromEntries(ITEMS.map(n => [n, { id: n }])),
      entitiesByName: Object.fromEntries(['cow', 'sheep', 'mooshroom', 'pig'].map(n => [n, { metadataKeys: Array.from({ length: 17 }, (_, i) => i === BABY ? 'baby' : 'k' + i) }])) },
    get heldItem() { return bot.held ? { name: bot.held } : null; },
    async equip(item) { bot.held = item.name; },
    setQuickBarSlot() { bot.held = null; },
    async lookAt() {},
    setControlState(k, on) { bot.controls[k] = on; },
    async activateBlock(b) { const props = b.getProperties(); props.open = !(props.open === true); },
    async placeBlock(ref, face) {
      const p = ref.position.plus(face);
      if (!bot.held) throw new Error('nothing held');
      w.set(p, bot.held, /_fence_gate$/.test(bot.held) ? { open: false, facing: 'south' } : {});
      inv.take(bot.held);
      if (!carried(bot, bot.held)) bot.held = null;
    },
    recipesFor(id, meta, n, table) {
      const r = RECIPES[id];
      if (!r || (r.table && !table) || !Object.entries(r.of).every(([k, c]) => inv.has(k, c))) return [];
      return [{ id, ...r }];
    },
    async craft(recipe, n, table) {
      if (recipe.table && !table) throw new Error('needs a table');
      for (let i = 0; i < n; i++) {
        if (!Object.entries(recipe.of).every(([k, c]) => inv.has(k, c))) throw new Error('missing ingredients');
        for (const [k, c] of Object.entries(recipe.of)) inv.take(k, c);
        inv.add(recipe.id, recipe.makes);
      }
    },
    useOn(e) {
      if (bot.held !== 'wheat' || !['cow', 'sheep', 'mooshroom'].includes(e.name)) return;
      if (e.baby || e.inLove) return;
      inv.take('wheat'); e.inLove = true; bot.fed.push(e.id);
    },
  };
  for (const e of herd) bot.entities[e.id] = e;
  if (registry) bot.buildRegistry = registry;
  bot._gardenFile = tmpFile();
  return bot;
}
// The pathfinder and the game's pull of the wheat: walked to where the goal is, and every animal of these within ten
// blocks of a hand with wheat in it, not fenced, comes to two from it.
function helpers(bot) {
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
  const navigate = async (b, t, goal) => {
    t.check();
    const p = b.entity.position;
    if (goal.entity) {
      const e = goal.entity, d = e.position.distanceTo(p), r = Math.sqrt(goal.rangeSq || 4) - 0.5, k = d > r ? (d - r) / d : 0;
      b.entity.position = v(p.x + (e.position.x - p.x) * k, 64, p.z + (e.position.z - p.z) * k);
    } else b.entity.position = v(goal.x + 0.5, 64, goal.z + 0.5);
    tempt();
  };
  const walk = async (b, t, cells) => { for (const c of cells) { b.entity.position = v(c.x + 0.5, 64, c.z + 0.5); tempt(); } return true; };
  const place = async (b, t, p, name) => { if (!carried(b, name)) throw new Error('Need more ' + name); b.blockAt(p); bot.held = name; await b.placeBlock(b.blockAt(p.offset(0, -1, 0)), v(0, 1, 0)); };
  return { navigate, walk, place, tempt, openWindow: async (b, t, fn) => fn(), dig: async () => {}, collect: async () => false };
}
const houseOf = bot => garden.housesAbout(bot, bot.entity.position)[0];
// The pen put up whole where its place was found, its gates shut.
function standUp(w, bot, house) {
  const { site } = pen.searchSite(bot, house);
  const p = quietly(() => pen.begin(bot, house, site))[0], s = pen.shapeOf(p);
  for (const c of s.fences) w.set(c, 'oak_fence');
  for (const g of s.gates) w.set(g, 'oak_fence_gate', { open: false, facing: 'south' });
  p.builtAt = new Date().toISOString();
  return { p, s };
}

test('its place: level ground two to ten out from the house, clear of its door and the garden, its near gate toward the house', () => {
  const { w, registry } = homestead();
  const bot = botIn(w, { registry });
  const house = houseOf(bot);
  assert.ok(house, 'the house about');
  const { site } = pen.searchSite(bot, house);
  assert.ok(site, 'a place found');
  const s = pen.layout(site.corner, site.side);
  const cells = [...s.fences, ...s.gates, ...[0, 1, 2].flatMap(dx => [0, 1, 2].map(dz => ({ x: s.interior.min.x + dx, z: s.interior.min.z + dz })))];
  assert.equal(cells.length, 25);
  const gap = c => Math.max(-3 - c.x, c.x - 3, -3 - c.z, c.z - 3, 0);
  assert.ok(cells.every(c => gap(c) >= pen.PEN_FROM), 'off the walls');
  assert.ok(Math.min(...cells.map(gap)) <= pen.PEN_TO);
  assert.ok(cells.every(c => Math.max(Math.abs(c.x - 4), Math.abs(c.z)) >= 4 && Math.max(Math.abs(c.x - 3), Math.abs(c.z)) >= 4), 'clear of the door');
  assert.ok(gap(s.gates[0]) < gap(s.gates[1]), 'the near gate toward the house');
  assert.equal(s.stands[0].y, 64);
  // A garden there: kept four from its middle.
  const plotAt = { middle: { x: s.centre.x, y: 63, z: s.centre.z } };
  const { site: other } = pen.searchSite(bot, house, { plots: [plotAt] });
  const o = pen.layout(other.corner, other.side);
  assert.ok([...o.fences, ...o.gates].every(c => Math.max(Math.abs(c.x - plotAt.middle.x), Math.abs(c.z - plotAt.middle.z)) >= 4), 'off the garden');
});

test('its wood: fourteen fences and two gates want 34 planks, nine logs are enough; what is carried counts', () => {
  const { w } = homestead();
  const want = { missing: Array(14).fill({}), gatesMissing: 2 };
  const logs = botIn(w, { items: [['oak_log', 9]] });
  assert.deepEqual((({ fenceCrafts, gateCrafts, stickCrafts, planks, have, short }) => ({ fenceCrafts, gateCrafts, stickCrafts, planks, have, short }))(pen.woodFor(logs, want)),
    { fenceCrafts: 5, gateCrafts: 2, stickCrafts: 5, planks: 34, have: 36, short: 0 });
  const some = botIn(w, { items: [['oak_fence', 6], ['oak_fence_gate', 1], ['oak_log', 2]] });
  const p = pen.woodFor(some, want);
  assert.equal(p.planks, 3 * 4 + 2 + 3 * 2);
  assert.equal(p.short, 20 - 8);
});

test('made at the table by it: planks, sticks, then the fences and the gates', async () => {
  const { w, registry } = homestead({ '-1,64,9': 'crafting_table' });
  const bot = botIn(w, { registry, items: [['oak_log', 9]] });
  const house = houseOf(bot), { site } = pen.searchSite(bot, house);
  const p = quietly(() => pen.begin(bot, house, site))[0];
  const st = pen.status(bot, p);
  const [made, lines] = await quietlyAsync(() => pen.makeWood(bot, task, {}, null, p, { missing: st.missing, gatesMissing: st.gatesMissing }, { ...helpers(bot), house }));
  assert.ok(carried(bot, 'oak_fence') >= 14, carried(bot, 'oak_fence') + ' fences: ' + lines.join(' | '));
  assert.equal(carried(bot, 'oak_fence_gate'), 2);
  assert.ok(made >= 7);
});

test('built from outside, the gates last; then the bot\'s own: no walk digs it, nothing takes it', async () => {
  const { w, registry } = homestead();
  const bot = botIn(w, { registry, items: [['oak_fence', 15], ['oak_fence_gate', 2]] });
  const house = houseOf(bot), { site } = pen.searchSite(bot, house);
  const p = quietly(() => pen.begin(bot, house, site))[0];
  const goal = {};
  const [, lines] = await quietlyAsync(() => pen.build(bot, task, goal, null, p, helpers(bot)));
  const st = pen.status(bot, p);
  assert.equal(st.built, true, lines.join(' | '));
  const s = st.shape;
  assert.equal(homeBase.jevBuiltAt(bot, s.fences[3]), true, 'a fence of it');
  assert.equal(homeBase.jevBuilt(bot, bot.blockAt(v(s.gates[1].x, s.gates[1].y, s.gates[1].z))), true, 'a gate of it');
  w.set({ x: 30, y: 64, z: 30 }, 'oak_fence');
  assert.equal(homeBase.jevBuiltAt(bot, { x: 30, y: 64, z: 30 }), false, 'a fence of someone else\'s');
  // Kept across a restart, beside the garden's file.
  const again = botIn(w, { registry });
  again._gardenFile = bot._gardenFile;
  assert.equal(pen.pensHere(again).length, 1);
});

test('brought in: led to the near gate, in and across, the near gate shut behind it, out through the far one and shut', async () => {
  const { w, registry } = homestead();
  const bot = botIn(w, { registry, items: [['wheat', 6]] });
  const house = houseOf(bot), { p, s } = standUp(w, bot, house);
  const ix = Math.sign(s.gates[1].x - s.gates[0].x), iz = Math.sign(s.gates[1].z - s.gates[0].z);
  const cow = animal('cow', s.stands[0].x - 3 * ix + iz, s.stands[0].z - 3 * iz + ix);
  bot.entities[cow.id] = cow;
  const h = helpers(bot);
  const lead = async (b, t, g, sv, e, point) => { await h.navigate(b, t, { x: point.x, z: point.z }); h.tempt(); return e.position.distanceTo(v(point.x + 0.5, 64, point.z + 0.5)) <= 4; };
  bot.held = 'wheat';
  const [r, lines] = await quietlyAsync(() => pen.bringIn(bot, task, {}, null, p, cow, { lead, navigate: h.navigate, walk: h.walk }));
  assert.equal(r.came, true, lines.join(' | '));
  assert.equal(pen.within(s, cow.position), true, 'the cow in: ' + cow.position);
  assert.equal(r.in, 1);
  const st = pen.status(bot, p);
  assert.deepEqual(st.gates.map(g => g.open), [false, false], 'both gates shut');
  assert.equal(pen.within(s, bot.entity.position), false, 'the bot out');
  const feet = bot.entity.position.floored();
  assert.deepEqual([feet.x, feet.z], [s.stands[1].x, s.stands[1].z], 'out by the far gate');
  assert.equal(bot.held, null, 'the wheat put away');
});

test('one nearer the far gate comes in by it, and the bot goes out by the near one; no leg of the lead ends in the pen', async () => {
  const { w, registry } = homestead();
  const bot = botIn(w, { registry, items: [['wheat', 6]] });
  const house = houseOf(bot), { p, s } = standUp(w, bot, house);
  const ix = Math.sign(s.gates[1].x - s.gates[0].x), iz = Math.sign(s.gates[1].z - s.gates[0].z);
  // Off to the side of the pen by its far end: the straight way to the far gate's stand crosses the pen's corner.
  const side = { x: s.centre.x + 5 * iz + 1 * ix, z: s.centre.z + 5 * ix + 1 * iz };
  const cow = animal('cow', side.x + iz, side.z + ix);
  bot.entities[cow.id] = cow;
  bot.entity.position = v(side.x + 0.5, 64, side.z + 0.5);
  const h = helpers(bot), went = [];
  const navigate = async (b, t, goal) => { if (!goal.entity) went.push({ x: goal.x, z: goal.z }); return h.navigate(b, t, goal); };
  const [r, lines] = await quietlyAsync(() => pen.bringIn(bot, task, {}, null, p, cow, { lead: animals.lead, navigate, walk: h.walk }));
  assert.equal(r.came, true, lines.join(' | '));
  assert.equal(pen.within(s, cow.position), true, 'the cow in: ' + cow.position);
  const foot = (x, z) => x >= s.corner.x && x < s.corner.x + 5 && z >= s.corner.z && z < s.corner.z + 5;
  assert.ok(went.length && went.every(g => !foot(g.x, g.z)), 'legs: ' + JSON.stringify(went));
  const feet = bot.entity.position.floored();
  assert.deepEqual([feet.x, feet.z], [s.stands[0].x, s.stands[0].z], 'out by the other gate');
  assert.deepEqual(pen.status(bot, p).gates.map(g => g.open), [false, false]);
});

test('with the pen standing, a pair in it is fed over the fence and none is led out', async () => {
  const { w, registry } = homestead();
  const bot = botIn(w, { registry, items: [['wheat', 6]] });
  const house = houseOf(bot), { p, s } = standUp(w, bot, house);
  const a = animal('cow', s.line[0].x, s.line[0].z, { fenced: true }), b = animal('cow', s.line[1].x, s.line[1].z, { fenced: true });
  for (const e of [a, b]) bot.entities[e.id] = e;
  const d = quietly(() => animals.herdDue(bot, {}))[0];
  assert.equal(d?.pen, 'in', JSON.stringify(d));
  assert.equal(d.pairs, 1);
  assert.equal(d.strays, 0);
  const goal = chores.goalFor(bot, d, { now: 0 });
  await quietlyAsync(() => animals.herdStep(bot, task, goal, null, helpers(bot)));
  assert.equal(goal.pairs, 1);
  assert.deepEqual(bot.fed.sort(), [a.id, b.id].sort());
  assert.ok(pen.within(s, a.position) && pen.within(s, b.position));
  assert.equal(pen.within(s, bot.entity.position), false);
});

test('a gate left open with nobody in it is shut from its stand; one with a cow in it is not', async () => {
  const { w, registry } = homestead();
  const bot = botIn(w, { registry, items: [['wheat', 2]] });
  const house = houseOf(bot), { p, s } = standUp(w, bot, house);
  const a = animal('cow', s.line[0].x, s.line[0].z, { fenced: true }), b = animal('cow', s.line[2].x, s.line[2].z, { fenced: true });
  for (const e of [a, b]) bot.entities[e.id] = e;
  bot.blockAt(v(s.gates[1].x, s.gates[1].y, s.gates[1].z)).getProperties().open = true;
  const d = quietly(() => animals.herdDue(bot, {}))[0];
  assert.equal(d?.shut, 1, JSON.stringify(d));
  assert.match(d.why, /the pen's gate left open/);
  const shut = await quietlyAsync(() => pen.shutGates(bot, task, p, helpers(bot)));
  assert.equal(shut[0], 1);
  assert.deepEqual(pen.status(bot, p).gates.map(g => g.open), [false, false]);
  // A cow standing in the opening: left open.
  bot.blockAt(v(s.gates[0].x, s.gates[0].y, s.gates[0].z)).getProperties().open = true;
  const c = animal('cow', s.gates[0].x, s.gates[0].z, { fenced: true });
  bot.entities[c.id] = c;
  assert.equal(pen.gatesOpen(bot, p).length, 0);
  assert.equal(chores.line({ chore: 'animals', kind: 'cow', pen: 'in', shut: 1, strays: 0, pairs: 0 }), "I'll shut the gate of the pen.");
});

test('a pen built and then mostly taken down is let go, and none is built by that house for a day', () => {
  const { w, registry } = homestead({ '-1,64,9': 'crafting_table' });
  const bot = botIn(w, { registry, items: [['oak_log', 9], ['wheat', 4]] });
  const house = houseOf(bot), { p, s } = standUp(w, bot, house);
  for (const c of s.fences.slice(0, 6)) w.set(c, 'air');
  const cows = [animal('cow', 12, -8), animal('cow', 13, -9)];
  for (const e of cows) bot.entities[e.id] = e;
  const [due, lines] = quietly(() => pen.buildDue(bot, { houses: [house], herdAt: { x: 12, z: -8 } }));
  assert.equal(due, null);
  assert.ok(lines.some(l => /let go: 6 of its fences and gates gone; none built by .* for a day/.test(l)), lines.join(' | '));
  assert.equal(pen.pensHere(bot).length, 0);
  assert.equal(quietly(() => pen.buildDue(bot, { houses: [house], herdAt: { x: 12, z: -8 } }))[0], null, 'not again today');
  void p;
});

test('a herd about and wood carried: the chore builds a pen first, said so', () => {
  const { w, registry } = homestead({ '-1,64,9': 'crafting_table' });
  const cows = [animal('cow', 12, -8), animal('cow', 13, -9), animal('cow', 11, -10)];
  const bot = botIn(w, { registry, items: [['oak_log', 9], ['wheat', 4]], herd: cows });
  const d = quietly(() => animals.herdDue(bot, {}))[0];
  assert.equal(d?.pen, 'build', JSON.stringify(d));
  assert.match(d.why, /a pen to build: 16 fences and gates by .*; 34 planks wanted, 36 carried/);
  assert.equal(chores.line(d), "I'll build a pen for the cows by the house.");
  // No wheat and no garden: a pen is not built for a herd that would not be fed.
  const none = botIn(w, { registry, items: [['oak_log', 9]], herd: cows.map(e => ({ ...e })) });
  assert.equal(quietly(() => animals.herdDue(none, {}))[0], null);
});

test('the second gate chosen again when the pockets, read late, still show the first one put in', async () => {
  const { w, registry } = homestead();
  const bot = botIn(w, { registry, items: [['oak_fence', 14], ['acacia_fence_gate', 1], ['oak_fence_gate', 1]] });
  const house = houseOf(bot);
  const { site } = pen.searchSite(bot, house);
  const p = quietly(() => pen.begin(bot, house, site))[0];
  // The pockets read once late after a gate goes in: they still show it.
  const live = bot.inventory.items, place0 = bot.placeBlock;
  let stale = null;
  bot.placeBlock = async (ref, face) => {
    const before = live().map(i => ({ ...i }));
    await place0(ref, face);
    if (/_fence_gate$/.test(w.blockAt(ref.position.plus(face)).name)) stale = before;
  };
  bot.inventory.items = () => { if (stale) { const s = stale; stale = null; return s; } return live(); };
  const [put, lines] = await quietlyAsync(() => pen.build(bot, task, {}, null, p, helpers(bot)));
  assert.deepEqual(put, { fences: 14, gates: 2 }, lines.join(' | '));
  assert.equal(pen.status(bot, p).built, true);
});

test('a fence cell a cow stands in is tried again after the others, once it has stepped off', async () => {
  const { w, registry } = homestead();
  const bot = botIn(w, { registry, items: [['oak_fence', 14], ['oak_fence_gate', 2]] });
  const house = houseOf(bot);
  const { site } = pen.searchSite(bot, house);
  const p = quietly(() => pen.begin(bot, house, site))[0], s = pen.shapeOf(p);
  const cell = s.fences[0], cow = animal('cow', cell.x, cell.z);
  bot.entities[cow.id] = cow;
  // The game puts no block where a body is; the cow steps off a second in.
  const h = { ...helpers(bot) }, place0 = h.place;
  h.place = async (b, t, q, name) => {
    if (Object.values(b.entities).some(e => Math.floor(e.position.x) === q.x && Math.floor(e.position.z) === q.z)) throw new Error('Placement obstructed: a cow stands in the cell');
    return place0(b, t, q, name);
  };
  setTimeout(() => { cow.position = v(s.centre.x + 0.5, 64, s.centre.z + 0.5); }, 1000);
  const [put, lines] = await quietlyAsync(() => pen.build(bot, task, {}, null, p, h));
  assert.deepEqual(put, { fences: 14, gates: 2 }, lines.join(' | '));
});

// A tree of n logs, its trunk's foot at (x, 64, z), its own leaves over its top.
function oak(w, x, z, n) {
  for (let y = 64; y < 64 + n; y++) w.set(v(x, y, z), 'oak_log', { axis: 'y' });
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) w.set(v(x + dx, 64 + n, z + dz), 'oak_leaves', { persistent: false });
}

test('wood short: trees near the house to cover it, the nearest first; no pen begun on too few', () => {
  const { w, registry } = homestead({ '-1,64,9': 'crafting_table' });
  const cows = [animal('cow', 12, -8), animal('cow', 13, -9), animal('cow', 11, -10)];
  const bot = botIn(w, { registry, items: [['oak_log', 4], ['wheat', 4]], herd: cows });
  const house = houseOf(bot), herdAt = { x: 12, z: -8 };
  oak(w, -12, -12, 4);
  const [none, said] = quietly(() => pen.buildDue(bot, { houses: [house], herdAt }));
  assert.equal(none, null);
  assert.ok(said.some(l => /no pen by .* yet: 18 planks short, and the trees of its own near it hold 4 logs/.test(l)), said.join(' | '));
  assert.equal(pen.pensHere(bot).length, 0);
  oak(w, -14, -16, 5);
  const due = quietly(() => pen.buildDue(bot, { houses: [house], herdAt, now: Date.now() + 6 * 60000 }))[0];
  assert.ok(due, 'due with two trees');
  assert.equal(due.trees.length, 2);
  assert.match(due.why, /34 planks wanted, 16 carried, 2 trees to fell \(9 logs\), the nearest a oak tree at \(-12, 64, -12\)/);
  assert.deepEqual(pen.treesFor([{ logs: 4 }, { logs: 6 }, { logs: 6 }], 18), { trees: [{ logs: 4 }, { logs: 6 }], logs: 10, enough: true });
  assert.equal(pen.treesFor([{ logs: 3 }, { logs: 3 }, { logs: 3 }, { logs: 3 }], 60).trees.length, 3);
});

test('a pen begun goes on with the trees there are, and with none waits for wood, said', () => {
  const { w, registry } = homestead({ '-1,64,9': 'crafting_table' });
  const cows = [animal('cow', 12, -8), animal('cow', 13, -9)];
  const bot = botIn(w, { registry, items: [['wheat', 4]], herd: cows });
  const house = houseOf(bot), herdAt = { x: 12, z: -8 };
  const { site } = pen.searchSite(bot, house, { herdAt });
  const p = quietly(() => pen.begin(bot, house, site))[0];
  oak(w, -12, -12, 4);
  const due = quietly(() => pen.buildDue(bot, { houses: [house], herdAt }))[0];
  assert.ok(due, 'the one tree there is');
  assert.equal(due.pen, p);
  assert.equal(due.trees.length, 1);
  assert.match(due.why, /the pen to finish: 16 fences and gates .*; 34 planks wanted, 0 carried, a oak tree at \(-12, 64, -12\) to fell/);
  for (let y = 64; y < 68; y++) w.set(v(-12, y, -12), 'air');
  const [none, said] = quietly(() => pen.buildDue(bot, { houses: [house], herdAt }));
  assert.equal(none, null);
  assert.ok(said.some(l => /the pen by .* waits for wood: 34 planks short and no tree of its own near it to fell/.test(l)), said.join(' | '));
});
