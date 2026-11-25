'use strict';
// Building onto what a player has started (player-build.js): whose blocks they are, what asks for it, the drafts
// checked against their blocks and sent back, and the house built round them with none of theirs touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const pb = require('../src/player-build');
const { validateSchematic, selectSchematicSite } = require('../src/designer');
const { designStarterHouse } = require('../src/starter-house');
const { buildCellComplete, buildFootprint, isBed } = require('../src/build-blocks');
const { ConstructionGoal } = require('../src/construction-access');
const { isDoor } = require('../src/doors');
const { verifyHouse } = require('../src/objectives');
const { designedBuildStep } = require('../src/work');
const houses = require('../src/house-details');
const point = p => new Vec3(p.x, p.y, p.z);
const cellKey = p => `${p.x},${p.y},${p.z}`;
const xyz = k => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; };
const task = { check() {} };
const noop = () => {};

function scene({ updates = false } = {}) {
  const world = new World().sync;
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }));
  function set(p, name, properties) {
    const type = registry.blocksByName[name];
    world.setBlockStateId(p, properties ? Block.fromProperties(type.id, properties, 0).stateId : type.defaultState);
  }
  for (let x = -14; x <= 18; x++) for (let z = -14; z <= 18; z++) { set(new Vec3(x, 62, z), 'dirt'); set(new Vec3(x, 63, z), 'grass_block'); }
  const tree = new Vec3(10, 64, 8);
  for (let y = 0; y < 4; y++) set(tree.offset(0, y, 0), 'spruce_log');
  const stock = {}, chat = [];
  const bot = Object.assign(new EventEmitter(), { registry, world, username: 'Jev', entities: {}, players: {},
    entity: { position: new Vec3(1.5, 64, 0.5), height: 1.8, onGround: true },
    health: 20, food: 20, oxygenLevel: 20, game: { gameMode: 'survival', dimension: 'overworld' },
    time: { timeOfDay: 6000 }, pathfinder: { movements: {} }, _client: new EventEmitter(),
    inventory: { slots: [], items: () => Object.entries(stock).filter(([, n]) => n > 0).map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })) },
    blockAt: p => world.getBlock(p), findBlocks: ({ matching }) => [].concat(matching).includes(registry.blocksByName.spruce_log.id) ? [tree] : [],
    findBlock: () => null, equip: async item => { bot.heldItem = item; }, chat: line => chat.push(line),
    look: async yaw => { bot.entity.yaw = yaw; }, waitForTicks: noop, setControlState: noop,
    canDigBlock: () => true, stopDigging: noop, dig: async block => {
      const was = bot.blockAt(block.position);
      set(block.position, 'air');
      bot._client.emit('block_change', { location: block.position, type: 0 });
      if (updates) bot.emit('blockUpdate', was, bot.blockAt(block.position));
    } });
  bot._placeBlockWithOptions = async (ref, normal) => {
    const foot = ref.position.plus(normal), material = bot.heldItem.name;
    const facing = { 0: 'north', 1: 'west', 2: 'south', 3: 'east' }[(Math.round(bot.entity.yaw / (Math.PI / 2)) + 4) % 4];
    const old = bot.blockAt(foot);
    const properties = isBed(material) ? { facing, part: 'foot' } : isDoor(material) ? { facing, half: 'lower' } :
      material === 'chest' ? { facing: { north: 'south', south: 'north', east: 'west', west: 'east' }[facing], type: 'single', waterlogged: false } :
      material.endsWith('_stairs') ? { facing, half: 'bottom', waterlogged: false } : undefined;
    const parts = buildFootprint({ ...foot, material, properties }), before = parts.map(part => bot.blockAt(point(part)));
    for (const part of parts) set(point(part), material, part.properties);
    stock[material]--;
    // As the game answers a placement: the cell's own change, the placement, then the change of its other half.
    const own = parts.findIndex(part => point(part).equals(foot));
    if (updates && own >= 0) bot.emit('blockUpdate', before[own], bot.blockAt(foot));
    bot.emit('blockPlaced', old, bot.blockAt(foot));
    if (updates) parts.forEach((part, i) => { if (i !== own) bot.emit('blockUpdate', before[i], bot.blockAt(point(part))); });
  };
  return { bot, set, stock, chat };
}

// The player's start: walls of cobblestone two high round a 5 by 5 floor of grass, a doorway left on the north side.
function ring(set, { gap = true } = {}) {
  const theirs = new Map();
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    if (Math.abs(x) !== 3 && Math.abs(z) !== 3) continue;
    for (const y of [64, 65]) {
      if (gap && x === 0 && z === -3) continue;
      set(new Vec3(x, y, z), 'cobblestone');
      theirs.set(cellKey({ x, y, z }), 'cobblestone');
    }
  }
  return theirs;
}

// A furnished house round that start, as the model might draw it: their walls at y 1 and 2, its roof on them.
function ringHouse({ door = [3, 1, 0], facing = 'south', existingOffset = [0, 1, 0], second } = {}) {
  const regions = [];
  const fill = (from, to, block, properties = null) => regions.push({ from, to, block, properties });
  fill([0, 0, 0], [6, 3, 6], 'cobblestone');
  fill([1, 1, 1], [5, 2, 5], 'air');
  for (const [d, f] of [[door, facing], ...(second ? [[second, 'west']] : [])]) {
    fill([d[0], 1, d[2]], [d[0], 2, d[2]], 'air');
    fill(d, d, 'spruce_door', { facing: f, half: null });
  }
  fill([0, 3, 3], [0, 3, 3], 'glass'); fill([6, 3, 3], [6, 3, 3], 'glass');
  fill([1, 1, 1], [2, 1, 1], 'spruce_stairs', { facing: 'north', half: 'bottom' });
  fill([5, 1, 1], [5, 1, 1], 'chest', { facing: 'south', half: null });
  fill([4, 1, 1], [4, 1, 1], 'torch'); fill([3, 1, 4], [3, 1, 4], 'torch');
  fill([1, 1, 4], [1, 1, 4], 'white_bed', { facing: 'south', half: null });
  fill([5, 1, 4], [5, 1, 4], 'white_bed', { facing: 'south', half: null });
  return { name: 'cobblestone cottage', description: 'Their walls roofed and furnished.', size: [7, 4, 7],
    palette: [...new Set(regions.map(r => r.block).filter(b => b !== 'air'))], regions, entrance: door, existingOffset, site: null };
}

// The designer answering with the drafts given, in turn, and no network: on OpenRouter, or on the guide's provider
// (guide). A draft { httpStatus, error } is a refusal.
const DESIGNER_ENV = ['OPENROUTER_API_KEY', 'BUILD_DESIGNER', 'JEV_GUIDE_API_KEY', 'JEV_GUIDE_URL', 'JEV_GUIDE_MODEL', 'JEV_GUIDE_REASONING', 'JEV_BUILD_MODEL', 'JEV_BUILD_REASONING'];
function stubDesigner(drafts, { guide = false } = {}) {
  const calls = [], urls = [], saved = { fetch: globalThis.fetch, env: Object.fromEntries(DESIGNER_ENV.map(n => [n, process.env[n]])) };
  for (const n of DESIGNER_ENV) delete process.env[n];
  if (guide) Object.assign(process.env, { BUILD_DESIGNER: 'guide', JEV_GUIDE_API_KEY: 'test-only' });
  else process.env.OPENROUTER_API_KEY = 'test-only';
  globalThis.fetch = async (url, init) => {
    urls.push(url); calls.push(JSON.parse(init.body));
    const draft = drafts.shift();
    if (!draft) throw new Error('no draft left');
    if (draft.httpStatus) return { ok: false, status: draft.httpStatus, headers: { get: () => 'application/json' }, json: async () => ({ error: draft.error }) };
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: JSON.stringify(draft) }, finish_reason: 'stop' }] }) };
  };
  return { calls, urls, restore() {
    globalThis.fetch = saved.fetch;
    for (const [n, v] of Object.entries(saved.env)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
  } };
}

function standForWork(bot, cell) {
  const operation = bot.blockAt(point(cell)).name === 'air' ? 'place' : 'dig';
  const target = new ConstructionGoal(bot, cell, operation, cell);
  for (const y of [0, 1, -1, 2]) for (const z of [-1, 1, -2, 2, 0]) for (const x of [0, -1, 1, -2, 2]) {
    const feet = point(cell).offset(x + .5, y, z + .5);
    if (bot.blockAt(feet)?.boundingBox !== 'empty' || bot.blockAt(feet.offset(0, 1, 0))?.boundingBox !== 'empty' ||
      bot.blockAt(feet.offset(0, -1, 0))?.boundingBox !== 'block') continue;
    if (target.reachable(feet) && !point(cell).equals(feet.floored().offset(0, -1, 0))) { bot.entity.position = feet; return true; }
  }
  return false;
}
async function buildAll(bot, stock, goal) {
  const batchReady = new Error('new batch');
  let lastBatch, finished = false;
  for (let turn = 0; turn < 500 && !finished; turn++) {
    const remaining = goal.buildBatch?.cells.filter(cell => !buildCellComplete(bot, cell)).sort((a, b) => a.y - b.y);
    if (remaining?.length) assert.ok(remaining.some(cell => standForWork(bot, cell)), 'a reachable work face for ' + remaining.map(p => p.material + '@' + point(p)).join(', '));
    try {
      finished = await designedBuildStep(bot, task, goal, () => { if (goal.buildBatch && goal.buildBatch !== lastBatch) { lastBatch = goal.buildBatch; throw batchReady; } });
    } catch (err) {
      if (err !== batchReady) throw err;
      for (const { item, count } of goal.buildBatch.outputs) stock[item] = Math.max(stock[item] || 0, count);
    }
  }
  return finished;
}
// Every step up to an accepted design, the drafts sent back collected; a plan of the bot's own, built from at
// once, stops where it is sited.
async function drawUntilAccepted(bot, goal) {
  const sent = [], sited = new Error('sited');
  for (let i = 0; i < 6 && !goal.design; i++) {
    try { await designedBuildStep(bot, task, goal, () => { if (goal.blueprint) throw sited; }); }
    catch (err) { if (err === sited) break; assert.equal(err.name, 'DesignRepair', String(err)); sent.push(err.message); }
  }
  return sent;
}

test('what a player lays is noted as theirs; what grows, falls or forms, and what the bot lays, is not', () => {
  const bot = Object.assign(new EventEmitter(), { username: 'Jev', game: { dimension: 'overworld' }, entity: { position: new Vec3(0, 64, 0) },
    players: { Jev: { entity: { position: new Vec3(0, 64, 0) } }, P: { entity: { position: new Vec3(20, 64, 0) } } } });
  bot.placedLog = new pb.PlacedLog();
  pb.placedPlugin(bot);
  const b = (name, p, props) => ({ name, position: new Vec3(...p), getProperties: () => props || {} });
  const seen = p => pb.seenPlaced(bot, { x: p[0], y: p[1], z: p[2] });
  bot.emit('blockUpdate', b('air', [21, 64, 0]), b('dirt', [21, 64, 0]));
  assert.deepEqual(seen([21, 64, 0])?.[0], 'dirt');
  // Grass over their dirt is still theirs; broken, it is no one's.
  bot.emit('blockUpdate', b('dirt', [21, 64, 0]), b('grass_block', [21, 64, 0]));
  assert.equal(seen([21, 64, 0])[0], 'grass_block');
  bot.emit('blockUpdate', b('grass_block', [21, 64, 0]), b('air', [21, 64, 0]));
  assert.equal(seen([21, 64, 0]), null);
  // Within the bot's own reach with nobody else by: not a player's. Out of its reach, nobody seen: someone's.
  bot.emit('blockUpdate', b('air', [2, 64, 0]), b('cobblestone', [2, 64, 0]));
  assert.equal(seen([2, 64, 0]), null);
  bot.emit('blockUpdate', b('air', [-40, 64, 0]), b('oak_planks', [-40, 64, 0]));
  assert.ok(seen([-40, 64, 0]));
  // The bot's own, laid beside the player: dropped as the game answers its placement.
  bot.emit('blockUpdate', b('air', [20, 65, 1]), b('dirt', [20, 65, 1]));
  bot.emit('blockPlaced', b('air', [20, 65, 1]), b('dirt', [20, 65, 1]));
  assert.equal(seen([20, 65, 1]), null);
  // What the world lays: sand falling, lava meeting water, a sapling grown into a tree.
  bot.emit('blockUpdate', b('air', [22, 64, 0]), b('sand', [22, 64, 0]));
  bot.emit('blockUpdate', b('lava', [22, 64, 1]), b('cobblestone', [22, 64, 1]));
  bot.emit('blockUpdate', b('air', [21, 65, 2]), b('oak_log', [21, 65, 2]));
  bot.emit('blockUpdate', b('air', [21, 68, 2]), b('oak_leaves', [21, 68, 2], { persistent: false }));
  bot.emit('blockUpdate', b('air', [21, 66, 2]), b('oak_log', [21, 66, 2]));
  for (const p of [[22, 64, 0], [22, 64, 1], [21, 65, 2], [21, 66, 2]]) assert.equal(seen(p), null, String(p));
  // A log laid with no tree growing is theirs.
  bot._treeGrew = null;
  bot.emit('blockUpdate', b('air', [19, 64, 3]), b('spruce_log', [19, 64, 3]));
  assert.ok(seen([19, 64, 3]));
});

test('the blocks seen laid are kept across a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-placed-'));
  try {
    const file = path.join(dir, 'placed.json'), log = new pb.PlacedLog(file);
    log.note('overworld', '1,2,3', 'dirt', 5);
    clearTimeout(log.timer); log.timer = null;
    log.save();
    assert.deepEqual(new pb.PlacedLog(file).get('overworld', '1,2,3'), ['dirt', 5]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a player's dirt the bot saw laid is built, and no ground to put a house on", () => {
  const { bot, set } = scene();
  bot.placedLog = new pb.PlacedLog();
  const built = require('../src/built');
  set(new Vec3(5, 64, 5), 'dirt');
  assert.equal(built.builtAt(bot, new Vec3(5, 64, 5)), false);
  bot._builtKept?.clear();
  bot.placedLog.note('overworld', '5,64,5', 'dirt');
  assert.equal(built.builtAt(bot, new Vec3(5, 64, 5)), true);
  // A house sited where that dirt stands goes on the ground beside it, not on top of it.
  const goal = { kind: 'build', starterBeds: 2 };
  const design = designStarterHouse(bot, goal);
  const site = selectSchematicSite(bot, design, { anchor: { x: 5, y: 64, z: 5 }, allowPreserved: false, nearbyRadius: 24 });
  assert.ok(site);
  const columns = new Set([...site.blocks, ...site.empty].map(c => c.x + ',' + c.z));
  assert.ok(!columns.has('5,5'));
});

test("finishing a start of the speaker's own is asked for in so many words", () => {
  for (const text of ['finish my house', 'help me finish my house', 'complete our hut', 'help us finish building our cabin', 'finish the house i started',
    'build a house on my walls', 'build a house on my platform', 'make a house with these walls', 'use my walls', 'finish what i started'])
    assert.deepEqual(houses.houseRequest(text, registry), { starterBeds: 2, onto: 'asked', anyMaterial: true }, text);
  assert.deepEqual(houses.houseRequest('finish my spruce house', registry), { starterBeds: 2, onto: 'asked', material: 'spruce_planks' });
  assert.deepEqual(houses.houseRequest('Put a roof on my hut!', registry), { onto: 'asked', ontoWhat: 'roof', anyMaterial: true });
  // "Here" is where the speaker stands, as for any house.
  assert.deepEqual(houses.houseRequest('build a house here', registry), { starterBeds: 2, anyMaterial: true });
  for (const text of ['finish the house', 'finish my homework', 'build a house', 'add a roof to the house', 'finish my purple house'])
    assert.ok(!houses.houseRequest(text, registry)?.onto, text);
  const spec = houses.houseSpec(houses.houseRequest('put a roof on my hut', registry), 'put a roof on my hut', 'P',
    { registry, speakerPosition: { x: 1, y: 64, z: 2 }, builds: [] });
  assert.deepEqual([spec.kind, spec.onto, spec.ontoWhat, spec.starterBeds, spec.buildAnchor], ['build', 'asked', 'roof', undefined, { x: 1, y: 64, z: 2 }]);
});

test("a player's start is found from inside it: their walls, not the ground, a tree or the bot's own blocks", () => {
  const { bot, set } = scene();
  const theirs = ring(set);
  set(new Vec3(-2, 64, 2), 'torch');
  // A block the bot laid itself against their wall is not theirs.
  set(new Vec3(4, 64, 0), 'cobblestone');
  bot._laid = new Map([['4,64,0', { name: 'cobblestone', at: Date.now() }]]);
  const found = pb.startedAt(bot, { x: 0.5, y: 64, z: 0.5 });
  assert.deepEqual(found.origin, { x: -3, y: 64, z: -3 });
  assert.deepEqual(found.size, [7, 2, 7]);
  // They stand on the ground: its top is a block below their lowest, for the drawing to lay its floor level with it.
  assert.equal(found.groundY, -1);
  assert.equal(found.source.groundY, -1);
  assert.equal(found.cells.length, theirs.size + 1);
  assert.equal(found.said, '46 cobblestone and 1 torch');
  assert.deepEqual([found.unfinished, found.inside, found.closed, found.farm], [true, true, false, false]);
  assert.ok(pb.meant(found, false));
  // From outside it, only when asked for.
  const outside = pb.startedAt(bot, { x: 0.5, y: 64, z: -5.5 });
  assert.equal(outside.inside, false);
  assert.ok(!pb.meant(outside, false) && pb.meant(outside, true));
  // Walls all round: no way in.
  set(new Vec3(0, 64, -3), 'cobblestone'); set(new Vec3(0, 65, -3), 'cobblestone');
  assert.equal(pb.startedAt(bot, { x: 0.5, y: 64, z: 0.5 }).closed, true);
  // Roofed, it is a house already: built onto only when asked.
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) set(new Vec3(x, 66, z), 'oak_planks');
  const roofed = pb.startedAt(bot, { x: 0.5, y: 64, z: 0.5 });
  assert.equal(roofed.unfinished, false);
  assert.ok(!pb.meant(roofed, false) && pb.meant(roofed, true));
});

test('a draft is checked against their blocks cell by cell, and sent back with the cells named', () => {
  const { bot, set } = scene();
  ring(set);
  const start = pb.startedAt(bot, { x: 0.5, y: 64, z: 0.5 });
  const draft = source => validateSchematic(source, registry, { fromPlanner: true });
  assert.deepEqual(pb.checkOnto(draft(ringHouse()), start), { kept: 46, doorway: [] });
  assert.throws(() => pb.checkOnto(draft(ringHouse({ existingOffset: null })), start), /existingOffset is null/);
  const door = (() => { try { pb.checkOnto(draft(ringHouse({ door: [6, 1, 3], facing: 'west' })), start); } catch (err) { return err.message; } })();
  assert.match(door, /2 of their 46 blocks are not kept/);
  assert.match(door, /\[6,1,3\] is their cobblestone, and your drawing puts spruce door there/);
  assert.match(door, /\[6,2,3\] is their cobblestone, and your drawing puts the top of spruce door there/);
  // A cell higher, their walls stand where its windows are.
  assert.throws(() => pb.checkOnto(draft(ringHouse({ existingOffset: [0, 2, 0] })), start), /glass there/);
  // No way in: one door through their wall is theirs to open; two are not.
  set(new Vec3(0, 64, -3), 'cobblestone'); set(new Vec3(0, 65, -3), 'cobblestone');
  const shut = pb.startedAt(bot, { x: 0.5, y: 64, z: 0.5 });
  const opened = pb.checkOnto(draft(ringHouse()), shut);
  assert.equal(opened.kept, 46);
  assert.deepEqual(opened.doorway.sort((a, b) => a.y - b.y), [{ x: 0, y: 64, z: -3 }, { x: 0, y: 65, z: -3 }]);
  assert.throws(() => pb.checkOnto(draft(ringHouse({ second: [6, 1, 3] })), shut), /not kept/);
});

test('a house asked for from inside their walls is drawn round them, sent back until it keeps them, and built with none of theirs touched', async () => {
  const { bot, set, stock, chat } = scene();
  bot.buildRegistry = new (require('../src/builds').BuildRegistry)();
  const theirs = ring(set);
  const stub = stubDesigner([ringHouse({ existingOffset: null }), ringHouse({ door: [6, 1, 3], facing: 'west' }), ringHouse()]);
  try {
    const text = 'build a house here';
    const goal = structuredClone(houses.houseSpec(houses.houseRequest(text, registry), text, 'P', { registry, speakerPosition: { x: 0.5, y: 64, z: 0.5 }, builds: [] }));
    const sent = await drawUntilAccepted(bot, goal);
    assert.ok(goal.design, 'a design accepted');
    assert.equal(goal.shellPrefer, 'cobblestone');
    assert.equal(sent.length, 2);
    assert.match(sent[0], /existingOffset is null/);
    assert.match(sent[1], /2 of their 46 blocks are not kept/);
    assert.ok(chat.some(l => l.startsWith("I'll make the house of what you've started here (46 cobblestone), keeping every block of yours.")), chat.join(' | '));
    // The model is shown their blocks, then told what was wrong with each draft.
    assert.equal(stub.calls.length, 3);
    assert.deepEqual(JSON.parse(stub.calls[0].messages[2].content).incorporate.size, [7, 2, 7]);
    assert.match(stub.calls[1].messages[4].content, /existingOffset is null/);
    assert.match(stub.calls[2].messages[4].content, /\[6,1,3\] is their cobblestone/);
    const dug = [], dig = bot.dig;
    bot.dig = async block => { dug.push(cellKey(block.position)); return dig(block); };
    Object.assign(stock, { dirt: 80, cobblestone: 40 });
    assert.equal(await buildAll(bot, stock, goal), true);
    // Sited exactly over their walls, which stayed out of the plan, untouched.
    assert.deepEqual(goal.blueprint.origin, { x: -3, y: 63, z: -3 });
    assert.ok(chat.some(l => /^Building cobblestone cottage onto what you built, at \(-3, 63, -3\)/.test(l)), chat.join(' | '));
    assert.ok(goal.blueprint.blocks.every(c => !theirs.has(cellKey(c))));
    assert.deepEqual(dug.filter(k => theirs.has(k)), []);
    for (const [k, name] of theirs) assert.equal(bot.blockAt(point(xyz(k))).name, name, k);
    assert.deepEqual(verifyHouse(bot, goal.blueprint), { ok: true, missing: 0, obstructed: 0 });
    assert.equal(goal.blueprint.blocks.filter(c => isBed(c.material) && isBed(bot.blockAt(point(c)).name)).length, 4);
    assert.ok(isDoor(bot.blockAt(new Vec3(0, 64, -3)).name));
    // In the bot's notes the house is its own parts only.
    const [entry] = bot.buildRegistry.all('overworld');
    assert.ok(entry.blueprint.blocks.every(c => !theirs.has(cellKey(c))));
  } finally { stub.restore(); }
});

// Asked from inside a closed ring of theirs: the house drawn round it, sited, and the goal. The text says what else.
async function closedRing(text) {
  const { bot, set, stock, chat } = scene();
  bot.buildRegistry = new (require('../src/builds').BuildRegistry)();
  const theirs = ring(set, { gap: false });
  const stub = stubDesigner([ringHouse()]);
  const goal = structuredClone(houses.houseSpec(houses.houseRequest(text, registry), text, 'P', { registry, speakerPosition: { x: 0.5, y: 64, z: 0.5 }, builds: [] }));
  assert.equal(goal.onto, 'asked');
  try { assert.deepEqual(await drawUntilAccepted(bot, goal), []); } finally { stub.restore(); }
  const designerRead = stub.calls.map(c => JSON.parse(c.messages.at(-1).content).request);
  const dug = [], dig = bot.dig;
  bot.dig = async block => { dug.push(cellKey(block.position)); return dig(block); };
  Object.assign(stock, { dirt: 80, cobblestone: 40 });
  return { bot, set, stock, chat, theirs, goal, dug, designerRead };
}
const DOORWAY = ['0,64,-3', '0,65,-3'];
function onlyDoorwayChanged(bot, theirs, goal) {
  for (const [k, name] of theirs) if (!DOORWAY.includes(k)) assert.equal(bot.blockAt(point(xyz(k))).name, name, k);
  assert.ok(isDoor(bot.blockAt(new Vec3(0, 64, -3)).name));
  assert.deepEqual(verifyHouse(bot, goal.blueprint), { ok: true, missing: 0, obstructed: 0 });
}

test('walls with no way in get one doorway cut through them by the bot, and nothing else of theirs is touched', async () => {
  const { bot, stock, chat, theirs, goal, dug } = await closedRing('finish my house');
  assert.ok(!goal.keepWalls);
  assert.ok(chat.some(l => l.includes("keeping every block of yours but one doorway: there's no way in yet, so I'll cut one through your wall.")), chat.join(' | '));
  // Cobblestone is cut with a pickaxe.
  stock.stone_pickaxe = 1;
  assert.equal(await buildAll(bot, stock, goal), true);
  assert.deepEqual(goal.blueprint.cut.map(cellKey).sort(), DOORWAY);
  assert.ok(chat.some(l => l === "There's no way into your walls, so I'll cut the doorway at 0, 64, -3. Say \"Jev, don't cut my wall\" if you'd rather open it yourself."), chat.join(' | '));
  assert.deepEqual([...new Set(dug.filter(k => theirs.has(k)))].sort(), DOORWAY);
  onlyDoorwayChanged(bot, theirs, goal);
  // Said once it is cut, there is nothing left to take back.
  assert.equal(pb.leaveDoorway(bot, goal), "I've already cut the doorway, sorry. The rest of your walls stay as they are.");
});

test("told not to cut their wall, with the request or once the site is chosen, Jev asks the player to open the doorway", async () => {
  for (const when of ['with the request', 'after']) {
    const { bot, set, stock, chat, theirs, goal, dug, designerRead } = await closedRing(when === 'after' ? 'finish my house' : "finish my house but don't cut my walls");
    if (when === 'after') {
      // Sited, the door's batch drawn up, nothing dug yet: then the player says it.
      const batched = new Error('batched');
      await designedBuildStep(bot, task, goal, () => { if (goal.buildBatch) throw batched; }).catch(e => { if (e !== batched) throw e; });
      assert.deepEqual(goal.blueprint.cut.map(cellKey).sort(), DOORWAY);
      assert.ok(chat.some(l => l.startsWith("There's no way into your walls, so I'll cut the doorway at 0, 64, -3.")), chat.join(' | '));
      assert.deepEqual(dug, []);
      assert.equal(pb.leaveDoorway(bot, goal), "All right, I won't cut your wall. Break the blocks at 0, 64, -3 when you're ready, and I'll put the door in.");
      assert.equal(goal.keepWalls, true);
      for (const k of DOORWAY) assert.equal(goal.blueprint.initialBlocks[k], undefined, k);
    } else {
      assert.equal(goal.keepWalls, true);
      // Said to Jev, not to the designer: it still puts the one door through their wall, for the player to open.
      assert.deepEqual([...new Set(designerRead)], ['finish my house']);
      assert.equal(pb.withoutLeaveWalls("Jev, finish my house, but please don't cut my walls"), 'Jev, finish my house');
      assert.ok(chat.some(l => l.includes("There's no way in yet, so I'll ask you to open a doorway.")), chat.join(' | '));
    }
    const asked = await designedBuildStep(bot, task, goal, noop).then(() => null, e => e);
    assert.ok(asked?.waitOn, when + ': ' + String(asked));
    assert.match(require('../src/speech').friendlyProblem(asked), /cobblestone at 0, 6[45], -3 in the doorway/);
    if (when !== 'after') {
      assert.equal(goal.blueprint.cut, undefined);
      assert.ok(chat.some(l => l.startsWith("There's no way into your walls yet, so the door goes through them at 0, 64, -3.")), chat.join(' | '));
    }
    set(new Vec3(0, 64, -3), 'air'); set(new Vec3(0, 65, -3), 'air');
    assert.equal(await buildAll(bot, stock, goal), true);
    assert.deepEqual(dug.filter(k => theirs.has(k)), [], when);
    onlyDoorwayChanged(bot, theirs, goal);
  }
});

test('"don\'t cut my wall" is read alone or with a request, and only means the doorway', () => {
  for (const line of ["don't cut my wall", 'don’t cut my wall', "no, don't break the wall please", 'leave my walls alone', "i'll make the door myself", 'do not cut through my walls!'])
    assert.ok(pb.keepWallsRequest(line), line);
  for (const line of ['cut my wall', 'build a house', "don't cut the tree", 'leave me alone']) assert.ok(!pb.keepWallsRequest(line), line);
  assert.deepEqual(houses.houseRequest("finish my house but don't cut my walls", registry), { starterBeds: 2, onto: 'asked', anyMaterial: true, keepWalls: true });
  assert.deepEqual(houses.houseRequest('add a room to my house but don’t cut my wall', registry), { addRoom: { bed: false }, anyMaterial: true, keepWalls: true });
  assert.deepEqual(houses.houseRequest('put a roof on my hut, leave my walls alone', registry), { onto: 'asked', ontoWhat: 'roof', anyMaterial: true, keepWalls: true });
  assert.equal(houses.houseRequest("don't cut my wall", registry), null);
  // With nothing in hand, or before the site is chosen.
  const bot = { blockAt: () => null };
  assert.match(pb.leaveDoorway(bot, null), /^There's no doorway of yours I'm about to cut\./);
  const goal = { kind: 'build', status: 'running', onto: 'asked' };
  assert.equal(pb.leaveDoorway(bot, goal), "All right, I won't cut through your walls for this one. If it needs a doorway, I'll leave it to you.");
  assert.equal(goal.keepWalls, true);
  assert.equal(require('../src/memory').intentOf({ ...goal, request: 'finish my house' }).keepWalls, true);
  // Out of sight (not loaded), the doorway is taken as standing, and no longer the plan's to clear either way.
  const far = { kind: 'build', status: 'running', blueprint: { cut: [{ x: 0, y: 64, z: -3 }, { x: 0, y: 65, z: -3 }],
    initialBlocks: { '0,64,-3': 1, '0,65,-3': 1 }, initialNames: { '0,64,-3': 'cobblestone', '0,65,-3': 'cobblestone' } } };
  assert.equal(pb.leaveDoorway(bot, far), "All right, I won't cut your wall. Break the blocks at 0, 64, -3 when you're ready, and I'll put the door in.");
  assert.deepEqual([far.blueprint.initialBlocks, far.blueprint.initialNames, far.keepWalls], [{}, {}, true]);
});

test('someone standing where part of the house goes is asked to step aside, and it is sited once they have', async () => {
  const { bot, set, chat } = scene();
  bot.buildRegistry = new (require('../src/builds').BuildRegistry)();
  ring(set);
  // On the sofa's place, inside their walls.
  const player = { id: 7, type: 'player', name: 'player', username: 'P', position: new Vec3(-1.5, 64, -1.5), height: 1.8 };
  bot.entities = { 7: player };
  const stub = stubDesigner([ringHouse()]);
  try {
    const text = 'build a house';
    const goal = structuredClone(houses.houseSpec(houses.houseRequest(text, registry), text, 'P', { registry, speakerPosition: { x: 0.5, y: 64, z: 0.5 }, builds: [] }));
    assert.deepEqual(await drawUntilAccepted(bot, goal), []);
    assert.equal(await designedBuildStep(bot, task, goal, noop), false);
    assert.ok(!goal.blueprint);
    assert.ok(goal.design, 'the plan kept');
    assert.ok(chat.includes("Could you step aside? You're standing where part of the house goes."), chat.join(' | '));
    // Not waited for for ever.
    goal.asideSince = Date.now() - 91000;
    const stuck = await designedBuildStep(bot, task, goal, noop).then(() => null, e => e);
    assert.match(String(stuck?.message), /^A player is standing where part of the house goes, at \(-2, 64, -2\)\. When it's out of the way, say Jev resume\.$/);
    player.position = new Vec3(0.5, 64, 0.5);
    const sited = new Error('sited');
    await assert.rejects(designedBuildStep(bot, task, goal, () => { if (goal.blueprint) throw sited; }), e => e === sited);
    assert.deepEqual(goal.blueprint.origin, { x: -3, y: 63, z: -3 });
    assert.equal(goal.asideSince, undefined);
  } finally { stub.restore(); }
});

test('three drafts that do not keep their blocks: the house is built next to them instead', async () => {
  const { bot, set, chat } = scene();
  bot.buildRegistry = new (require('../src/builds').BuildRegistry)();
  const theirs = ring(set);
  const stub = stubDesigner([0, 1, 2].map(() => ringHouse({ existingOffset: null })));
  try {
    const text = 'build a house';
    const goal = structuredClone(houses.houseSpec(houses.houseRequest(text, registry), text, 'P', { registry, speakerPosition: { x: 0.5, y: 64, z: 0.5 }, builds: [] }));
    const sent = await drawUntilAccepted(bot, goal);
    assert.equal(sent.length, 3);
    assert.equal(stub.calls.length, 3);
    assert.equal(goal.playerBuild, undefined);
    assert.ok(chat.some(l => l === "I couldn't work out a house plan that keeps all of your blocks, so I'll build my own next to them instead."), chat.join(' | '));
    assert.equal(goal.design.backend, 'starter-house');
    assert.ok(goal.blueprint, 'sited');
    assert.ok([...goal.blueprint.blocks, ...(goal.blueprint.empty || [])].every(c => !theirs.has(cellKey(c))));
  } finally { stub.restore(); }
});

test("on the guide's provider the plan is asked for as the guide asks, and asked again without the reasoning effort a model refuses", async () => {
  const { bot, set } = scene();
  bot.buildRegistry = new (require('../src/builds').BuildRegistry)();
  ring(set);
  const refused = { httpStatus: 400, error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", param: 'reasoning_effort', code: 'unsupported_parameter' } };
  const stub = stubDesigner([refused, ringHouse()], { guide: true });
  try {
    const text = 'build a house';
    const goal = structuredClone(houses.houseSpec(houses.houseRequest(text, registry), text, 'P', { registry, speakerPosition: { x: 0.5, y: 64, z: 0.5 }, builds: [] }));
    assert.deepEqual(await drawUntilAccepted(bot, goal), []);
    assert.ok(goal.design, 'a design accepted');
    assert.equal(stub.calls.length, 2);
    const [first, second] = stub.calls;
    assert.equal(stub.urls[0], 'https://api.openai.com/v1/chat/completions');
    assert.deepEqual([first.model, first.reasoning_effort, first.max_completion_tokens, first.response_format], ['gpt-6.1-terra', 'low', 16000, { type: 'json_object' }]);
    assert.equal(first.stream, undefined);
    const asked = JSON.parse(first.messages.find(m => m.role === 'user').content);
    assert.ok(asked.format, 'the schematic format in the message');
    assert.deepEqual(asked.incorporate.size, [7, 2, 7]);
    assert.equal('reasoning_effort' in second, false);
    assert.deepEqual(second.messages, first.messages);
  } finally { stub.restore(); }
});

test("what Jev lays while a player stands by is never noted as the player's, and theirs stays theirs", async () => {
  const { bot, set, stock } = scene({ updates: true });
  bot.buildRegistry = new (require('../src/builds').BuildRegistry)();
  bot.placedLog = new pb.PlacedLog();
  pb.placedPlugin(bot);
  const player = { id: 7, type: 'player', name: 'player', username: 'P', position: new Vec3(0.5, 64, 0.5), height: 1.8 };
  bot.players = { P: { username: 'P', entity: player } };
  bot.entities = { 7: player };
  // The player lays their walls from inside them, then watches from just outside.
  const theirs = ring((p, name, props) => { const was = bot.blockAt(p); set(p, name, props); bot.emit('blockUpdate', was, bot.blockAt(p)); });
  for (const k of theirs.keys()) assert.ok(pb.seenPlaced(bot, xyz(k)), k);
  player.position = new Vec3(0.5, 64, 5.5);
  const stub = stubDesigner([ringHouse()]);
  try {
    const text = 'build a house';
    const goal = structuredClone(houses.houseSpec(houses.houseRequest(text, registry), text, 'P', { registry, speakerPosition: { x: 0.5, y: 64, z: 0.5 }, builds: [] }));
    assert.deepEqual(await drawUntilAccepted(bot, goal), []);
    Object.assign(stock, { dirt: 80, cobblestone: 40 });
    assert.equal(await buildAll(bot, stock, goal), true);
    const mine = goal.blueprint.blocks.filter(c => bot.blockAt(point(c)).name !== 'air');
    assert.ok(mine.length > 100, String(mine.length));
    // Doors and beds included: their other halves came after the placement was answered.
    assert.ok(mine.some(c => isDoor(c.material)) && mine.filter(c => isBed(c.material)).length === 4);
    assert.deepEqual(mine.filter(c => pb.seenPlaced(bot, c)).map(cellKey), []);
    for (const k of theirs.keys()) assert.ok(pb.seenPlaced(bot, xyz(k)), k);
    assert.deepEqual(verifyHouse(bot, goal.blueprint), { ok: true, missing: 0, obstructed: 0 });
  } finally { stub.restore(); }
});

test("the ground's own rise inside their walls is levelled for the house, and the ground beside them is no part of theirs", async () => {
  const { bot, set, stock } = scene();
  bot.buildRegistry = new (require('../src/builds').BuildRegistry)();
  const theirs = ring(set);
  // A rise of the ground across the room, under where a torch goes, and a step of it outside their wall.
  const rise = [[-1, 64, 0], [0, 64, 0], [1, 64, 0], [0, 64, 1]];
  for (const [x, y, z] of rise) set(new Vec3(x, y, z), 'dirt');
  set(new Vec3(4, 64, 0), 'dirt');
  const found = pb.startedAt(bot, { x: 0.5, y: 64, z: -1.5 });
  assert.equal(found.cells.length, theirs.size);
  assert.deepEqual(found.size, [7, 2, 7]);
  const stub = stubDesigner([ringHouse()]);
  try {
    const text = 'build a house';
    const goal = structuredClone(houses.houseSpec(houses.houseRequest(text, registry), text, 'P', { registry, speakerPosition: { x: 0.5, y: 64, z: -1.5 }, builds: [] }));
    assert.deepEqual(await drawUntilAccepted(bot, goal), []);
    Object.assign(stock, { dirt: 80, cobblestone: 40 });
    assert.equal(await buildAll(bot, stock, goal), true);
    assert.deepEqual(goal.blueprint.origin, { x: -3, y: 63, z: -3 });
    assert.ok(goal.blueprint.preserved.every(p => theirs.has(cellKey(p))));
    for (const [x, y, z] of rise.slice(0, 3)) assert.equal(bot.blockAt(new Vec3(x, y, z)).name, 'air');
    assert.equal(bot.blockAt(new Vec3(0, 64, 1)).name, 'torch');
    assert.equal(bot.blockAt(new Vec3(4, 64, 0)).name, 'dirt');
    for (const [k, name] of theirs) assert.equal(bot.blockAt(point(xyz(k))).name, name, k);
    assert.deepEqual(verifyHouse(bot, goal.blueprint), { ok: true, missing: 0, obstructed: 0 });
  } finally { stub.restore(); }
});

test('a plan that cannot stand over their blocks is drawn again, told which of its cells are in the way', async () => {
  const { bot, set, chat } = scene();
  bot.buildRegistry = new (require('../src/builds').BuildRegistry)();
  ring(set);
  // Ore showing through the floor of their room, where a bed of the plan goes: no ground to level, and not theirs.
  set(new Vec3(2, 64, 1), 'iron_ore');
  const stub = stubDesigner([ringHouse(), ringHouse()]);
  try {
    const text = 'build a house';
    const goal = structuredClone(houses.houseSpec(houses.houseRequest(text, registry), text, 'P', { registry, speakerPosition: { x: 0.5, y: 64, z: 0.5 }, builds: [] }));
    assert.deepEqual(await drawUntilAccepted(bot, goal), []);
    assert.equal(goal.playerBuild.cells.length, 46, 'the ore is not theirs');
    assert.equal(await designedBuildStep(bot, task, goal, noop), false);
    assert.ok(!goal.blueprint && !goal.design);
    assert.match(goal.designError, /a bed at \[5,1,4\] stands in or on something that stays there/);
    assert.ok(chat.includes("That plan doesn't fit the ground round your blocks. I'll draw it again."), chat.join(' | '));
    await drawUntilAccepted(bot, goal);
    assert.equal(stub.calls.length, 2);
    assert.match(stub.calls[1].messages.at(-1).content, /a bed at \[5,1,4\]/);
  } finally { stub.restore(); }
});


test('a plan whose floor is a block above the ground round their walls is drawn again, told where the ground is', async () => {
  const { bot, set, chat } = scene();
  bot.buildRegistry = new (require('../src/builds').BuildRegistry)();
  ring(set);
  // As Terra's first drawing round such a ring was (2026-11-24): their walls' foot at its floor's level, the door a step
  // above the grass outside.
  const stub = stubDesigner([ringHouse({ existingOffset: [0, 0, 0] }), ringHouse()]);
  try {
    const text = 'build a house';
    const goal = structuredClone(houses.houseSpec(houses.houseRequest(text, registry), text, 'P', { registry, speakerPosition: { x: 0.5, y: 64, z: 0.5 }, builds: [] }));
    assert.deepEqual(await drawUntilAccepted(bot, goal), []);
    assert.equal(JSON.parse(stub.calls[0].messages.at(-1).content).incorporate.groundY, -1);
    assert.match(stub.calls[0].messages[0].content, /incorporate\.groundY gives that top in their coordinates/);
    assert.equal(await designedBuildStep(bot, task, goal, noop), false);
    assert.ok(!goal.blueprint && !goal.design);
    assert.match(goal.designError, /outside your entrance, at \[3,1,-1\], there is nothing to step onto: your doorway's floor is above the ground there\. Your y 0 is laid level with the top of the ground, which is at their y -1, so the y of existingOffset should be 1, not 0/);
    assert.ok(chat.includes("That plan doesn't fit the ground round your blocks. I'll draw it again."), chat.join(' | '));
    const sited = new Error('sited');
    for (let i = 0; i < 4 && !goal.blueprint; i++)
      await designedBuildStep(bot, task, goal, () => { if (goal.blueprint) throw sited; }).catch(e => { if (e !== sited) throw e; });
    assert.equal(stub.calls.length, 2);
    assert.match(stub.calls[1].messages.at(-1).content, /the y of existingOffset should be 1/);
    assert.ok(goal.blueprint, 'the second drawing is sited');
    assert.equal(goal.blueprint.origin.y, 63);
  } finally { stub.restore(); }
});
test('a house of any blocks round their walls is walled first with what theirs are made of, when it is carried', () => {
  const am = require('../src/any-material');
  const bot = { inventory: { items: () => [{ name: 'dirt', count: 10 }, { name: 'cobblestone', count: 3 }] } };
  const cells = () => [0, 1, 2, 3, 4].map(x => ({ x, y: 64, z: 0, material: 'oak_planks', flexible: true }));
  const theirs = cells(), plain = cells();
  am.paint(bot, { shellPrefer: 'cobblestone' }, theirs);
  assert.deepEqual(theirs.map(c => c.material), ['cobblestone', 'cobblestone', 'cobblestone', 'dirt', 'dirt']);
  am.paint(bot, {}, plain);
  assert.deepEqual(plain.map(c => c.material), ['dirt', 'dirt', 'dirt', 'dirt', 'dirt']);
});

test('when no plan keeps their blocks, the player is told so, and what else to ask for', () => {
  const err = Object.assign(new Error("I couldn't work out a plan that keeps every block of yours where it is. You can ask me for a house next to it instead."), { name: 'Blocked', needsPlayer: true });
  assert.equal(require('../src/speech').friendlyProblem(err), err.message);
});

test('"finish my house" said at their own walls is their house, unless building work of the bot is near', () => {
  const agenda = require('../src/agenda');
  const { bot, set } = scene();
  bot.buildRegistry = new (require('../src/builds').BuildRegistry)();
  ring(set, { gap: false });
  const at = { x: 0.5, y: 64, z: 0.5 }, from = 'P', registry = bot.buildRegistry;
  assert.deepEqual(require('../src/companion-actions').companionAction('finish my house'), { kind: 'continue_work', what: 'build' });
  assert.equal(agenda.theirStartFirst(bot, 'finish my house', { at, registry, from }), true);
  // A house of theirs set aside here (the doorway theirs to open): "finish my house" takes it up again.
  const here = { kind: 'build', status: 'blocked', request: 'finish my house', buildAnchor: { x: 0, y: 64, z: 0 } };
  assert.equal(agenda.theirStartFirst(bot, 'finish my house', { at, saved: here, registry, from }), false);
  assert.equal(agenda.theirStartFirst(bot, 'finish my house', { at, saved: { ...here, buildAnchor: { x: 90, y: 64, z: 0 } }, registry, from }), true);
  // A house of the bot's left unfinished a short walk off, as at a base, is another house; one touching their walls is this one.
  const unfinished = bounds => ({ all: () => [{ id: 'u', name: 'Small House', status: 'unfinished', origin: bounds.min, bounds }] });
  assert.equal(agenda.theirStartFirst(bot, 'finish my house', { at, registry: unfinished({ min: { x: 15, y: 64, z: -3 }, max: { x: 21, y: 68, z: 3 } }) }), true);
  assert.equal(agenda.theirStartFirst(bot, 'finish my house', { at, registry: unfinished({ min: { x: 3, y: 64, z: -3 }, max: { x: 9, y: 68, z: 3 } }) }), false);
  // A stopped house at their walls is taken up again too.
  assert.equal(agenda.theirStartFirst(bot, 'finish my house', { at, saved: { ...here, status: 'cancelled' }, registry, from }), false);
  // Not asked as a house, or nowhere near their walls: a continuation as before.
  assert.equal(agenda.theirStartFirst(bot, 'continue building', { at, registry, from }), false);
  assert.equal(agenda.theirStartFirst(bot, 'finish my house', { at: { x: 40.5, y: 64, z: 40.5 }, registry, from }), false);
});

test('told the house comes first, the interpreter reads "finish my house" as the house and not as work to continue', async () => {
  const { interpret } = require('../src/objectives');
  const context = { registry, speakerPosition: { x: 0.5, y: 64, z: 0.5 }, builds: [] };
  assert.equal((await interpret(null, 'Jev finish my house', 'P', 'Jev', context)).kind, 'continue_work');
  const spec = await interpret(null, 'Jev finish my house', 'P', 'Jev', { ...context, houseFirst: true });
  assert.equal(spec.kind, 'build');
  assert.equal(spec.onto, 'asked');
});
