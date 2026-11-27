'use strict';
// The waiting bot's garden (src/garden.js, a chore of src/chores.js): the houses it is made by, where it goes beside
// one, what makes it due, and a run: a hoe made at a table standing near, seeds found in the grass, the cells tilled
// and sown from a stand beside the plot, never from on it.
//
//   node test/garden.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { Vec3 } = require('vec3');
const garden = require('../src/garden');
const chores = require('../src/chores');

const v = (x, y, z) => new Vec3(x, y, z);
const task = { check() {} };
const env = {};
const EMPTY = /^(air|cave_air|water|lava|short_grass|tall_grass|fern|large_fern|wheat|carrots|potatoes|beetroots|torch|dandelion|poppy|.*_sapling)$/;
const NAMES = ['red_bed', 'oak_door', 'crafting_table', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'water', 'farmland', 'wheat', 'oak_planks', 'cobblestone', 'poppy', 'torch'];
const ITEMS = ['wooden_hoe', 'stone_hoe', 'stick', 'oak_planks', 'oak_log', 'wheat_seeds', 'carrot', 'potato', 'beetroot_seeds', 'cobblestone'];
const RECIPES = {
  oak_planks: { needs: [['oak_log', 1]], makes: 4 },
  stick: { needs: [[/_planks$/, 2]], makes: 4 },
  wooden_hoe: { needs: [[/_planks$/, 2], ['stick', 2]], makes: 1, table: true },
  stone_hoe: { needs: [['cobblestone', 2], ['stick', 2]], makes: 1, table: true },
};
const CROP = { wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot_seeds: 'beetroots' };
const counted = (list, what) => list.reduce((n, i) => n + ((typeof what === 'string' ? i.name === what : what.test(i.name)) ? i.count : 0), 0);

// A flat world: grass at y 63, dirt under it, air over it, and the cells given ("x,y,z": a name, or [name, properties]).
function world(cells = {}) {
  const m = new Map(Object.entries(cells));
  const entry = p => m.get(p.x + ',' + p.y + ',' + p.z) ?? (p.y < 63 ? 'dirt' : p.y === 63 ? 'grass_block' : 'air');
  const blockAt = p => {
    const q = v(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), e = entry(q), [name, props = {}] = Array.isArray(e) ? e : [e];
    return { name, type: name, position: q, boundingBox: EMPTY.test(name) ? 'empty' : 'block', getProperties: () => props };
  };
  const set = (p, name) => m.set(p.x + ',' + p.y + ',' + p.z, name);
  // Only the cells set are found: the ground's own grass blocks and the air never are.
  const findBlocks = ({ point, matching, maxDistance, count }) => [...m.keys()].map(k => v(...k.split(',').map(Number)))
    .filter(p => matching.includes(blockAt(p).name) && p.distanceTo(point) <= maxDistance)
    .sort((a, b) => a.distanceTo(point) - b.distanceTo(point)).slice(0, count);
  return { blockAt, set, findBlocks, m };
}
// A house of planks, x and z from -3 to 3, walls 64 to 66 and a roof at 67, a door in the east wall at (3, 64, 0) and
// a bed inside; a pond east of it, x 9 to 12 and z -8 to 8, at the ground's level.
function homestead(extra = {}, { pond = true, door = true, bed = true } = {}) {
  const cells = {}, blocks = [];
  const lay = (x, y, z, name, props) => { cells[x + ',' + y + ',' + z] = props ? [name, props] : name; blocks.push({ x, y, z, material: name }); };
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    lay(x, 67, z, 'oak_planks');
    if (Math.abs(x) === 3 || Math.abs(z) === 3) for (let y = 64; y <= 66; y++) lay(x, y, z, 'oak_planks');
  }
  if (door) { lay(3, 64, 0, 'oak_door', { half: 'lower' }); lay(3, 65, 0, 'oak_door', { half: 'upper' }); }
  if (bed) { lay(0, 64, 0, 'red_bed', { part: 'foot' }); lay(-1, 64, 0, 'red_bed', { part: 'head' }); }
  if (pond) for (let x = 9; x <= 12; x++) for (let z = -8; z <= 8; z++) cells[x + ',63,' + z] = 'water';
  Object.assign(cells, extra);
  const entry = { id: 'h1', name: 'Oak starter house', kind: 'build', status: 'unfinished', origin: { x: -3, y: 63, z: -3 }, entrance: door ? { x: 4, y: 64, z: 0 } : null,
    bounds: { min: { x: -3, y: 63, z: -3 }, max: { x: 3, y: 67, z: 3 } }, blueprint: { blocks } };
  const registry = { revision: 0, near: () => [entry], all: () => [entry], standing: () => 1, claimed: () => new Set(blocks.map(c => c.x + ',' + c.y + ',' + c.z)) };
  return { w: world(cells), entry, registry };
}
function pockets(list = []) {
  const items = list.map(([name, count]) => ({ name, count, stackSize: 64 }));
  return {
    items: () => items.filter(i => i.count > 0),
    emptySlotCount: () => 36 - items.filter(i => i.count > 0).length,
    add(name, n = 1) { const i = items.find(x => x.name === name); if (i) i.count += n; else items.push({ name, count: n, stackSize: 64 }); },
    take(what, n = 1) { for (const i of items) { if (n <= 0) break; if (typeof what === 'string' ? i.name !== what : !what.test(i.name)) continue; const t = Math.min(i.count, n); i.count -= t; n -= t; } },
  };
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'garden-')), 'garden.json');
function botIn(w, { at = v(0.5, 64, 12.5), items = [], registry = null, labels = null, placed = null, file = tmpFile() } = {}) {
  const inv = pockets(items);
  const bot = {
    username: 'Jev', blockAt: w.blockAt, findBlocks: w.findBlocks, entity: { position: at, eyeHeight: 1.62 }, entities: {}, health: 20, food: 20,
    time: { timeOfDay: 1000 }, game: { gameMode: 'survival', dimension: 'overworld', hashedSeed: 'test' }, inventory: inv, held: null,
    registry: { blocksArray: NAMES.map(name => ({ name, id: name })), itemsByName: Object.fromEntries(ITEMS.map(n => [n, { id: n }])) },
    async equip(item) { bot.held = item.name; },
    async lookAt() {},
    async activateBlock(block) {
      if (/_hoe$/.test(bot.held || '') && /^(grass_block|dirt)$/.test(block.name) && w.blockAt(block.position.offset(0, 1, 0)).name === 'air') w.set(block.position, 'farmland');
    },
    async placeBlock(ref) {
      const crop = CROP[bot.held], p = ref.position.offset(0, 1, 0);
      if (crop && ref.name === 'farmland' && w.blockAt(p).name === 'air') { w.set(p, [crop, { age: 0 }]); inv.take(bot.held); }
    },
    recipesFor(id, meta, n, table) { const r = RECIPES[id]; return r && (!r.table || table) && r.needs.every(([what, k]) => counted(inv.items(), what) >= k) ? [{ id, ...r }] : []; },
    async craft(recipe) { for (const [what, k] of recipe.needs) inv.take(what, k); inv.add(recipe.id, recipe.makes); },
  };
  if (registry) bot.buildRegistry = registry;
  if (labels) bot.labels = labels;
  if (placed) bot.placedLog = placed;
  bot._gardenFile = file;
  return bot;
}
// The work loop's own helpers, as they would be handed over (work.js treeDeps), with what they did kept.
function helpers(bot, w, { seedEvery = 0 } = {}) {
  const seen = { walks: [], digs: [], dug: [], under: [], windows: [] };
  let broken = 0, id = 0;
  return {
    seen,
    navigate: async (b, t, goal) => {
      const off = goal.rangeSq ? 1 : 0;
      b.entity.position = v(goal.x + 0.5 + off, goal.y, goal.z + 0.5);
      seen.walks.push([goal.x, goal.y, goal.z]);
      seen.under.push(w.blockAt(v(Math.floor(b.entity.position.x), goal.y - 1, Math.floor(b.entity.position.z))).name);
    },
    dig: async (b, t, p) => {
      const name = w.blockAt(p).name;
      w.set(p, 'air'); seen.digs.push(name); seen.dug.push({ x: p.x, z: p.z });
      if (seedEvery && /short_grass|tall_grass|fern/.test(name) && ++broken % seedEvery === 0)
        b.entities[++id] = { name: 'item', isValid: true, position: v(p.x + 0.5, p.y + 0.2, p.z + 0.5), getDroppedItem: () => ({ name: 'wheat_seeds' }) };
    },
    collect: async (b, t, item, { origin, radius }) => {
      for (const [k, e] of Object.entries(b.entities)) if (e.getDroppedItem().name === item && e.position.distanceTo(origin) <= radius) { delete b.entities[k]; b.inventory.add(item); return true; }
      return false;
    },
    openWindow: async (b, t, open, { block }) => { seen.windows.push(block.name); return open(); },
  };
}
const quietly = fn => { const was = console.log, lines = []; console.log = (...a) => lines.push(a.join(' ')); try { return [fn(), lines]; } finally { console.log = was; } };
const quietlyAsync = async fn => { const was = console.log, lines = []; console.log = (...a) => lines.push(a.join(' ')); try { return [await fn(), lines]; } finally { console.log = was; } };
const wetCell = (w, c) => { for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (const dy of [0, 1]) if (w.blockAt(v(c.x + dx, c.y + dy, c.z + dz)).name === 'water') return true; return false; };

test('by the house, a plot by the water: eight cells round a middle, all wet, clear of the house and of its door', () => {
  const { w, registry, entry } = homestead();
  const bot = botIn(w, { registry, items: [['wooden_hoe', 1], ['wheat_seeds', 8]] });
  const houses = garden.housesAbout(bot, bot.entity.position);
  assert.equal(houses.length, 1, 'the house, its bed and door not counted again: ' + houses.map(h => h.key));
  assert.equal(houses[0].kind, 'own');
  const { site } = garden.siteBy(bot, houses[0]);
  assert.ok(site, 'a site');
  assert.equal(site.cells.length, 8);
  assert.ok(!site.cells.some(c => c.x === site.middle.x && c.z === site.middle.z), 'the middle left');
  for (const c of site.cells) {
    assert.equal(c.y, 63);
    assert.ok(wetCell(w, c), 'wet: ' + JSON.stringify(c));
    const gap = Math.max(entry.bounds.min.x - c.x, c.x - entry.bounds.max.x, entry.bounds.min.z - c.z, c.z - entry.bounds.max.z, 0);
    assert.ok(gap >= garden.PLOT_FROM, 'out from the house: ' + JSON.stringify(c));
    for (const d of [{ x: 3, z: 0 }, { x: 4, z: 0 }]) assert.ok(Math.max(Math.abs(c.x - d.x), Math.abs(c.z - d.z)) >= garden.DOOR_CLEAR, 'clear of the door: ' + JSON.stringify(c));
  }
  assert.ok(site.stands.length >= 2);
  const d = garden.gardenDue(bot, {});
  assert.equal(d?.chore, 'garden');
  assert.equal(d.fresh, true);
  assert.equal(d.untilled, 8);
});

test('no house about, a house too far, or no water at its level: no garden, said once in the log', () => {
  const lone = world({});
  assert.equal(garden.gardenDue(botIn(lone, { items: [['wooden_hoe', 1], ['wheat_seeds', 8]] }), {}), null, 'no house');
  const far = homestead();
  assert.equal(garden.gardenDue(botIn(far.w, { registry: far.registry, at: v(0.5, 64, 40.5), items: [['wooden_hoe', 1], ['wheat_seeds', 8]] }), {}), null, '37 blocks off');
  const near = homestead();
  assert.equal(garden.gardenDue(botIn(near.w, { registry: near.registry, items: [['wooden_hoe', 1], ['wheat_seeds', 8]] }), { player: { name: 'Robin', position: v(0, 64, 60) } }), null, 'the player 57 off');
  const dry = homestead({}, { pond: false });
  const bot = botIn(dry.w, { registry: dry.registry, items: [['wooden_hoe', 1], ['wheat_seeds', 8]] });
  const [d1, lines] = quietly(() => garden.gardenDue(bot, {}));
  assert.equal(d1, null);
  bot._gardenSites.clear();
  const [d2, again] = quietly(() => garden.gardenDue(bot, {}));
  assert.equal(d2, null);
  assert.equal(lines.filter(l => /no garden by/.test(l)).length, 1, lines.join(' | '));
  assert.equal(again.length, 0, 'not said again: ' + again.join(' | '));
  // Water one below the ground keeps nothing wet.
  const low = homestead();
  for (let x = 9; x <= 12; x++) for (let z = -8; z <= 8; z++) { low.w.set(v(x, 63, z), 'air'); low.w.set(v(x, 62, z), 'water'); }
  assert.equal(quietly(() => garden.gardenDue(botIn(low.w, { registry: low.registry, items: [['wooden_hoe', 1], ['wheat_seeds', 8]] }), {}))[0], null, 'the water a block down');
});

test('kept off what is a player\'s, marked, a path, flowers, someone\'s farmland and a stump owed a sapling', () => {
  const plain = homestead();
  const first = garden.siteBy(botIn(plain.w, { registry: plain.registry }), garden.housesAbout(botIn(plain.w, { registry: plain.registry }), v(0.5, 64, 12.5))[0]).site;
  const inSite = (s, x, z) => Math.abs(x - s.middle.x) <= 1 && Math.abs(z - s.middle.z) <= 1;
  const near = (s, x, z) => Math.abs(x - s.middle.x) <= 2 && Math.abs(z - s.middle.z) <= 2;
  const m = first.middle;
  const cases = [
    ['a block a player laid beside it', w => w.set(v(m.x + 2, 64, m.z), 'cobblestone'), bot => { bot.placedLog = { get: (dim, k) => k === (m.x + 2) + ',64,' + m.z ? ['cobblestone', 1] : null }; }],
    ['a torch beside it', w => w.set(v(m.x, 64, m.z + 2), 'torch')],
    ['a path through it', w => w.set(v(m.x, 63, m.z), 'dirt_path')],
    ['a flower in it', w => w.set(v(m.x + 1, 64, m.z + 1), 'poppy')],
    ['farmland of someone\'s beside it', w => w.set(v(m.x - 2, 63, m.z), 'farmland')],
    ['a label on it', () => {}, bot => { bot.labels = { size: 1, counting: () => [], at: (dim, p) => p.x === m.x && p.z === m.z && p.y === 63 ? { kind: 'use', scope: 'thing', thing: 'grass_block' } : null }; }],
  ];
  for (const [why, change, fit = () => {}] of cases) {
    const { w, registry } = homestead();
    change(w);
    const bot = botIn(w, { registry });
    fit(bot);
    const site = garden.siteBy(bot, garden.housesAbout(bot, bot.entity.position)[0]).site;
    assert.ok(site, why + ': another spot');
    assert.ok(!near(site, m.x, m.z) || !inSite(site, m.x, m.z), why + ': moved from ' + JSON.stringify(m) + ' to ' + JSON.stringify(site.middle));
  }
  // A stump owed a sapling: its ground is the tree's.
  const { w, registry } = homestead();
  const bot = botIn(w, { registry });
  require('../src/tree-felling').owe(bot, { block: 'oak_log', cells: [v(m.x, 64, m.z)], soil: [v(m.x, 63, m.z)] });
  const site = garden.siteBy(bot, garden.housesAbout(bot, bot.entity.position)[0]).site;
  assert.ok(site && !inSite(site, m.x, m.z), 'the stump\'s spot left to the tree');
});

test('a bed or a door inside walls with a roof is a house; one out in the open is not; nor one the bot laid itself', () => {
  const room = homestead({}, { pond: true });
  const bot = botIn(room.w);
  const found = garden.housesAbout(bot, bot.entity.position);
  assert.equal(found.length, 1, 'one house for its bed and its door: ' + found.map(h => h.key).join(', '));
  assert.equal(found[0].kind, 'found');
  assert.ok(garden.siteBy(bot, found[0]).site, 'a garden by it too');
  const open = world({ '0,64,0': ['red_bed', { part: 'foot' }], '-1,64,0': ['red_bed', { part: 'head' }], '5,64,5': ['oak_door', { half: 'lower' }], '5,65,5': ['oak_door', { half: 'upper' }] });
  assert.equal(garden.housesAbout(botIn(open), v(0.5, 64, 12.5)).length, 0, 'in the open');
  const own = homestead({}, { door: false });
  const mine = botIn(own.w);
  mine._laid = new Map([['0,64,0', { name: 'red_bed', at: 1 }]]);
  assert.equal(garden.housesAbout(mine, mine.entity.position).length, 0, 'the bot\'s own bed in its pocket');
});

test('a building a player named theirs is a house', () => {
  const { w } = homestead({}, { bed: false });
  const cells = [];
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 64; y <= 67; y++) if (w.blockAt(v(x, y, z)).name !== 'air') cells.push({ x, y, z });
  const label = { id: 'l1', kind: 'keep', scope: 'building', thing: 'building', name: 'my house', cells, center: { x: 0, y: 64, z: 0 }, by: 'Robin', dimension: 'overworld' };
  const keyed = new Set(cells.map(c => c.x + ',' + c.y + ',' + c.z));
  const bot = botIn(w, { labels: { size: 1, counting: () => [label], at: (dim, p) => keyed.has(Math.floor(p.x) + ',' + Math.floor(p.y) + ',' + Math.floor(p.z)) ? label : null } });
  bot.findBlocks = () => [];
  const houses = garden.housesAbout(bot, bot.entity.position);
  assert.equal(houses.length, 1);
  assert.equal(houses[0].kind, 'named');
  assert.equal(houses[0].floor, 63, 'by its door');
  assert.ok(garden.siteBy(bot, houses[0]).site);
});

test('due only with something to sow it with and a way to till it', () => {
  const { w, registry } = homestead();
  assert.equal(garden.gardenDue(botIn(w, { registry, items: [['wooden_hoe', 1]] }), {}), null, 'no seeds, no grass about');
  assert.equal(garden.gardenDue(botIn(w, { registry, items: [['wheat_seeds', 8]] }), {}), null, 'no hoe, nothing to make one of');
  assert.equal(garden.gardenDue(botIn(w, { registry, items: [['wheat_seeds', 8], ['oak_log', 1]] }), {}), null, 'wood for a hoe but no table standing');
  w.set(v(-6, 64, 0), 'crafting_table');
  assert.equal(garden.gardenDue(botIn(w, { registry, items: [['wheat_seeds', 8], ['oak_log', 1]] }), {})?.chore, 'garden', 'a hoe to make at the table');
  const full = botIn(w, { registry, items: [['wheat_seeds', 8], ['oak_log', 1]] });
  full.inventory.emptySlotCount = () => 0;
  assert.equal(garden.gardenDue(full, {}), null, 'no free slot for the craft');
  const grassy = homestead(), b0 = botIn(grassy.w, { registry: grassy.registry });
  const m = garden.siteBy(b0, garden.housesAbout(b0, b0.entity.position)[0]).site.middle;
  for (let x = m.x - 3; x <= m.x + 3; x++) for (let z = m.z - 3; z <= m.z + 3; z++) if (grassy.w.blockAt(v(x, 63, z)).name === 'grass_block') grassy.w.set(v(x, 64, z), 'short_grass');
  assert.equal(garden.gardenDue(botIn(grassy.w, { registry: grassy.registry, items: [['wooden_hoe', 1]] }), {})?.chore, 'garden', 'grass about the plot to find seeds in');
  for (let x = m.x - 3; x <= m.x + 3; x++) for (let z = m.z - 3; z <= m.z + 3; z++) if (Math.abs(x - m.x) > 1 || Math.abs(z - m.z) > 0) grassy.w.set(v(x, 64, z), 'air');
  assert.equal(garden.gardenDue(botIn(grassy.w, { registry: grassy.registry, items: [['wooden_hoe', 1]] }), {}), null, 'too little grass: three, across the middle of the plot');
  for (let x = m.x - 3; x <= m.x + 3; x++) for (let z = m.z - 3; z <= m.z + 3; z++) if (grassy.w.blockAt(v(x, 63, z)).name === 'grass_block') grassy.w.set(v(x, 64, z), 'short_grass');
  const d = garden.gardenDue(botIn(grassy.w, { registry: grassy.registry, items: [['wooden_hoe', 1]] }), {});
  assert.equal(d?.chore, 'garden', 'grass about to find seeds in');
  assert.ok(d.grass >= garden.GRASS_FEW);
  assert.equal(garden.seedsCarried(botIn(w, { items: [['carrot', 2], ['potato', 1], ['wheat_seeds', 3]] })), 4, 'a carrot and a potato kept to eat');
});

test('a run: tilled and sown from a stand beside the plot, never on it; the garden kept', async () => {
  const { w, registry } = homestead();
  const bot = botIn(w, { registry, items: [['wooden_hoe', 1], ['wheat_seeds', 8]] });
  const due = garden.gardenDue(bot, {});
  const goal = chores.goalFor(bot, due, { now: 0 });
  assert.equal(goal.kind, 'garden');
  const h = helpers(bot, w);
  const [done, lines] = await quietlyAsync(() => garden.gardenStep(bot, task, goal, null, h));
  assert.equal(done, true);
  assert.equal(goal.tilled, 8); assert.equal(goal.planted, 8); assert.equal(goal.gardenBegun, true);
  const plot = garden.plotsHere(bot)[0];
  assert.ok(plot, 'kept');
  for (const c of plot.cells) { assert.equal(w.blockAt(v(c.x, c.y, c.z)).name, 'farmland'); assert.equal(w.blockAt(v(c.x, c.y + 1, c.z)).name, 'wheat'); }
  assert.equal(w.blockAt(v(plot.middle.x, 63, plot.middle.z)).name, 'grass_block', 'the middle left');
  assert.ok(h.seen.under.every(n => n !== 'farmland'), 'never stood on the farmland: ' + h.seen.under);
  assert.ok(h.seen.walks.every(([x, , z]) => !(Math.abs(x - plot.middle.x) <= 1 && Math.abs(z - plot.middle.z) <= 1)), 'nor on a cell of it: ' + JSON.stringify(h.seen.walks));
  assert.ok(lines.some(l => /^\[garden\] begun by/.test(l)), lines.join(' | '));
  const saved = JSON.parse(fs.readFileSync(bot._gardenFile, 'utf8'));
  assert.equal(saved.plots.length, 1);
  assert.equal(chores.line(due), "I'll make a little garden by the house.");
  // Read again after a restart: the same garden, nothing left to do.
  const again = botIn(w, { registry, items: [['wooden_hoe', 1], ['wheat_seeds', 8]], file: bot._gardenFile });
  assert.equal(garden.plotsHere(again).length, 1);
  assert.equal(garden.gardenDue(again, {}), null, 'all sown');
  // A cell trampled back to dirt: due again, and its line.
  w.set(v(plot.cells[0].x, 63, plot.cells[0].z), 'dirt'); w.set(v(plot.cells[0].x, 64, plot.cells[0].z), 'air');
  const d = garden.gardenDue(again, {});
  assert.equal(d?.untilled, 1);
  assert.equal(chores.line(d), "I'll plant some seeds in the garden.");
});

test('no hoe: one made from a log carried, at the crafting table standing near, through its window', async () => {
  const { w, registry } = homestead({ '-6,64,0': 'crafting_table' });
  const bot = botIn(w, { registry, items: [['oak_log', 1], ['wheat_seeds', 8]] });
  const goal = chores.goalFor(bot, garden.gardenDue(bot, {}), { now: 0 });
  const h = helpers(bot, w);
  await quietlyAsync(() => garden.gardenStep(bot, task, goal, null, h));
  assert.equal(goal.hoeMade, true);
  assert.deepEqual(h.seen.windows, ['crafting_table']);
  assert.equal(counted(bot.inventory.items(), 'wooden_hoe'), 1);
  assert.equal(goal.tilled, 8); assert.equal(goal.planted, 8);
  assert.equal(w.blockAt(v(-6, 64, 0)).name, 'crafting_table', 'the table left where it stands');
});

test('no seeds: grass about broken, those on the plot first, and as many cells tilled as seeds were found', async () => {
  const { w, registry } = homestead();
  const bot0 = botIn(w, { registry });
  const site = garden.siteBy(bot0, garden.housesAbout(bot0, bot0.entity.position)[0]).site;
  for (let x = site.middle.x - 3; x <= site.middle.x + 3; x++) for (let z = site.middle.z - 3; z <= site.middle.z + 3; z++)
    if (w.blockAt(v(x, 63, z)).name === 'grass_block') w.set(v(x, 64, z), 'short_grass');
  const bot = botIn(w, { registry, items: [['wooden_hoe', 1]] });
  const goal = chores.goalFor(bot, garden.gardenDue(bot, {}), { now: 0 });
  const h = helpers(bot, w, { seedEvery: 3 });
  await quietlyAsync(() => garden.gardenStep(bot, task, goal, null, h));
  assert.ok(goal.seedsFound >= 1, JSON.stringify(goal));
  assert.equal(goal.planted, goal.seedsFound, 'each seed found sown');
  assert.equal(goal.tilled, goal.planted, 'no cell tilled with no seed for it');
  assert.ok(goal.grassBroken <= garden.GRASS_MOST);
  const onPlot = c => Math.abs(c.x - site.middle.x) <= 1 && Math.abs(c.z - site.middle.z) <= 1;
  const first = h.seen.dug.slice(0, 9);
  assert.equal(first.filter(onPlot).length, 9, 'the plot\'s own grass first: ' + JSON.stringify(first));
  assert.ok(h.seen.digs.every(n => /short_grass/.test(n)), 'only grass broken: ' + h.seen.digs);
});

test('nothing found to sow: the garden rests, longer each time; a carrot and a potato kept to eat', async () => {
  const { w, registry } = homestead();
  const bot0 = botIn(w, { registry });
  const site = garden.siteBy(bot0, garden.housesAbout(bot0, bot0.entity.position)[0]).site;
  for (let x = site.middle.x - 3; x <= site.middle.x + 3; x++) for (let z = site.middle.z - 3; z <= site.middle.z + 3; z++)
    if (w.blockAt(v(x, 63, z)).name === 'grass_block') w.set(v(x, 64, z), 'short_grass');
  const bot = botIn(w, { registry, items: [['wooden_hoe', 1]] });
  const goal = chores.goalFor(bot, garden.gardenDue(bot, {}), { now: 0 });
  await quietlyAsync(() => garden.gardenStep(bot, task, goal, null, helpers(bot, w, { seedEvery: 0 })));
  assert.equal(goal.planted, 0);
  const plot = garden.plotsHere(bot)[0];
  assert.ok(plot.restUntil > Date.now() + 4 * 60000, 'rested five minutes');
  assert.equal(garden.gardenDue(bot, {}), null, 'resting');
  const veg = homestead();
  const cook = botIn(veg.w, { registry: veg.registry, items: [['wooden_hoe', 1], ['carrot', 2], ['potato', 1]] });
  const g2 = chores.goalFor(cook, garden.gardenDue(cook, {}), { now: 0 });
  await quietlyAsync(() => garden.gardenStep(cook, task, g2, null, helpers(cook, veg.w)));
  assert.equal(g2.planted, 1);
  assert.equal(g2.tilled, 1, 'one cell for the one carrot to spare');
  assert.equal(counted(cook.inventory.items(), 'carrot'), 1);
  assert.equal(counted(cook.inventory.items(), 'potato'), 1);
});

test('read again before each run: a cell built on is left; half of it gone, the garden is forgotten', async () => {
  const { w, registry } = homestead();
  const bot = botIn(w, { registry, items: [['wooden_hoe', 1], ['wheat_seeds', 4]] });
  await quietlyAsync(() => garden.gardenStep(bot, task, chores.goalFor(bot, garden.gardenDue(bot, {}), { now: 0 }), null, helpers(bot, w)));
  const plot = garden.plotsHere(bot)[0];
  assert.equal(garden.plotStatus(bot, plot).bare.length + garden.plotStatus(bot, plot).growing.length, 4);
  w.set(v(plot.cells[7].x, 63, plot.cells[7].z), 'cobblestone');
  assert.equal(garden.plotStatus(bot, plot).blocked.length, 1);
  for (const c of plot.cells.slice(4, 7)) w.set(v(c.x, 63, c.z), 'cobblestone');
  bot.inventory.add('wheat_seeds', 4);
  const [d, lines] = quietly(() => garden.gardenDue(bot, {}));
  assert.ok(lines.some(l => /forgotten/.test(l)), lines.join(' | '));
  assert.equal(garden.plotsHere(bot).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(bot._gardenFile, 'utf8')).plots.length, 0);
  assert.ok(!d || d.fresh, 'a new spot at most');
});

test('a chore with the trees: the trees first, the garden after; JEV_CHORES names them; resting; the bot\'s own errand', () => {
  const { w, registry } = homestead();
  const bot = botIn(w, { registry, items: [['wooden_hoe', 1], ['wheat_seeds', 8], ['oak_sapling', 1]] });
  assert.equal(chores.due(bot, { env })?.chore, 'garden');
  require('../src/tree-felling').owe(bot, { block: 'oak_log', cells: [v(-8, 64, 8)], soil: [v(-8, 63, 8)] });
  assert.equal(chores.due(bot, { env })?.chore, 'trees', 'the trees first');
  assert.equal(chores.due(bot, { env: { JEV_CHORES: 'garden' } })?.chore, 'garden');
  assert.equal(chores.due(bot, { env: { JEV_CHORES: 'trees' }, resting: n => n === 'trees' }), null, 'the garden not named');
  assert.equal(chores.due(bot, { env, resting: n => n === 'trees' })?.chore, 'garden');
  assert.equal(chores.due(bot, { env, resting: () => true }), null);
  assert.equal(chores.due(bot, { env, dark: true }), null);
  const g = chores.goalFor(bot, chores.due(bot, { env, resting: n => n === 'trees' }), { player: { name: 'Robin' }, now: 5 });
  assert.equal(g.chore, 'garden'); assert.equal(g.from, 'Robin'); assert.equal(g.deliver, false); assert.equal(g.choreUntil, 5 + chores.CHORE_MS);
  assert.ok(g.gardenHouse);
  assert.equal(chores.REST_MS.garden > 0, true);
  const { createHandoff } = require('../src/handoff');
  assert.equal(createHandoff().holder({ active: { goal: { ...g, status: 'running' } }, from: 'Sam' }), null, 'nobody\'s work to ask about');
});
