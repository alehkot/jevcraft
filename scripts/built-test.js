'use strict';
// What someone built is left alone (src/built.js). No server: the detector
// on a world of names, then the real searches (work.js miningCandidates,
// logInView, mineAtSource; decision-options.js committedSource; the walking
// rules of movement.js) on a prismarine world with a house, trees and a camp
// set into it.
//
//   node scripts/built-test.js
//   node scripts/built-test.js <dump.json> [x y z ...]
//
// With a dump ({ "blocks": { "x,y,z": "name" } }, a part of a real world
// read from its region files) the same searches are run in it from each
// position given, and what they would take is listed and timed.
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');

process.env.JEV_BUILT = 'leave';
const built = require('../src/built');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`ok  ${name}`); };

// ---------------------------------------------------------------- 1. the detector, on names
function namedWorld(dimension = 'overworld') {
  const cells = new Map(), said = [];
  const bot = { username: 'Jev', game: { dimension }, chat: line => said.push(line), _laid: new Map(),
    blockAt: p => ({ name: cells.get(`${p.x},${p.y},${p.z}`) || 'air', position: p }) };
  const set = (x, y, z, name) => cells.set(`${x},${y},${z}`, name);
  return { bot, set, said, cells };
}
// A tree: a trunk of `height` on grass under a cap of leaves.
function tree(set, x, y, z, { log = 'oak_log', leaves = 'oak_leaves', height = 5 } = {}) {
  set(x, y - 1, z, 'dirt');
  for (let i = 0; i < height; i++) set(x, y + i, z, log);
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = height - 2; dy <= height; dy++) {
    if ((dx || dz || dy === height) && Math.abs(dx) + Math.abs(dz) < 4) set(x + dx, y + dy, z + dz, leaves);
  }
}
// A village house, 5 by 5: cobblestone footing, oak posts at the corners,
// plank walls with a door and a window, a roof of stairs and slabs, a bed
// and a chest inside.
function house(set, x, y, z) {
  for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 5; dz++) {
    set(x + dx, y - 1, z + dz, 'cobblestone');
    const edge = dx === 0 || dx === 4 || dz === 0 || dz === 4, corner = (dx === 0 || dx === 4) && (dz === 0 || dz === 4);
    for (let dy = 0; dy < 3; dy++) if (edge) set(x + dx, y + dy, z + dz, corner ? 'oak_log' : 'oak_planks');
    set(x + dx, y + 3, z + dz, edge ? 'oak_stairs' : 'oak_slab');
  }
  set(x + 2, y, z, 'oak_door'); set(x + 2, y + 1, z, 'oak_door'); set(x, y + 1, z + 2, 'glass_pane');
  set(x + 1, y, z + 3, 'red_bed'); set(x + 3, y, z + 3, 'chest');
}

check('a tree is free; a house post, a plank, a bed and a hay bale are not', () => {
  const { bot, set } = namedWorld();
  tree(set, 0, 64, 0); house(set, 20, 64, 20); set(40, 64, 40, 'hay_block');
  for (let y = 64; y < 69; y++) assert.equal(built.builtAt(bot, new Vec3(0, y, 0)), false, `trunk at y ${y}`);
  for (const [dx, dz] of [[0, 0], [4, 0], [0, 4], [4, 4]]) for (let dy = 0; dy < 3; dy++) assert.equal(built.builtAt(bot, new Vec3(20 + dx, 64 + dy, 20 + dz)), true, `post ${dx},${dy},${dz}`);
  assert.equal(built.builtAt(bot, new Vec3(21, 64, 20)), true, 'a plank of the wall');
  assert.equal(built.builtAt(bot, new Vec3(21, 63, 21)), true, 'the cobblestone under the floor');
  assert.equal(built.builtAt(bot, new Vec3(21, 64, 23)), true, 'the bed');
  assert.equal(built.builtAt(bot, new Vec3(40, 64, 40)), true, 'a hay bale on its own');
  assert.equal(built.leftAlone(bot, {}, new Vec3(20, 64, 20)), true);
});

check('a camp at the foot of a tree does not make the tree a building; a wall does', () => {
  const { bot, set } = namedWorld();
  tree(set, 0, 64, 0);
  set(1, 64, 0, 'crafting_table'); set(-1, 64, 0, 'furnace'); set(0, 64, 1, 'chest'); set(0, 64, -1, 'red_bed'); set(1, 65, 0, 'torch'); set(1, 64, 1, 'campfire');
  assert.equal(built.builtAt(bot, new Vec3(0, 64, 0)), false, 'tree in a camp');
  assert.equal(built.builtAt(bot, new Vec3(1, 64, 0)), true, 'the table is someone\'s all the same');
  // A lamp post two cells off: a fence and a slab, fewer than NEAR.
  set(2, 64, 2, 'oak_fence'); set(2, 65, 2, 'stone_slab');
  bot._builtKept.clear();
  assert.equal(built.structureRound(bot, new Vec3(0, 64, 0), { enough: 99 }), 2);
  assert.equal(built.builtAt(bot, new Vec3(0, 64, 0)), false, 'two made blocks near');
  set(-2, 64, 1, 'cobblestone_wall');
  bot._builtKept.clear();
  assert.equal(built.builtAt(bot, new Vec3(0, 64, 0)), true, `${built.NEAR} made blocks near`);
});

check('ore beside a mine\'s timbers and wheat in a farm are free', () => {
  const { bot, set } = namedWorld();
  for (const [x, y] of [[0, 20], [0, 21], [2, 20], [2, 21]]) set(x, y, 0, 'oak_fence');
  for (const x of [0, 1, 2]) set(x, 22, 0, 'oak_planks');
  set(1, 20, 1, 'iron_ore'); set(1, 21, 1, 'stone'); set(9, 20, 9, 'stone');
  assert.equal(built.builtAt(bot, new Vec3(1, 20, 1)), false, 'iron ore beside the timbers');
  assert.equal(built.builtAt(bot, new Vec3(1, 22, 0)), true, 'the timber itself');
  assert.equal(built.builtAt(bot, new Vec3(1, 21, 1)), true, 'stone hard against the timbers');
  assert.equal(built.builtAt(bot, new Vec3(9, 20, 9)), false, 'stone eight blocks off');
  set(30, 64, 30, 'farmland'); set(30, 65, 30, 'wheat'); set(31, 65, 30, 'composter'); set(31, 65, 31, 'oak_trapdoor'); set(30, 65, 31, 'oak_trapdoor'); set(29, 65, 31, 'oak_trapdoor');
  assert.equal(built.builtAt(bot, new Vec3(30, 65, 30)), false, 'ripe wheat');
  for (const name of ['oak_leaves', 'poppy', 'short_grass', 'coal_ore', 'deepslate_diamond_ore', 'melon_stem', 'pumpkin', 'cobweb']) assert.equal(built.grows(name), true, name);
  for (const name of ['oak_log', 'crimson_stem', 'stripped_oak_log', 'cobblestone', 'white_terracotta', 'potted_poppy', 'hay_block', 'smooth_basalt']) assert.equal(built.grows(name), false, name);
  for (const name of ['oak_planks', 'spruce_stairs', 'stone_bricks', 'glass_pane', 'stripped_oak_log', 'smooth_stone', 'white_wool', 'red_carpet', 'cobblestone_wall', 'spruce_trapdoor']) assert.equal(built.structure(name), true, name);
  for (const name of ['oak_log', 'cobblestone', 'smooth_basalt', 'moss_carpet', 'terracotta', 'white_terracotta', 'stone', 'crafting_table', 'torch']) assert.equal(built.structure(name), false, name);
});

check('the bot\'s own blocks are its own; the Nether is not judged; switched off, nothing is', () => {
  const { bot, set } = namedWorld();
  for (let dx = 0; dx < 3; dx++) for (let dy = 0; dy < 2; dy++) { set(dx, 64 + dy, 0, 'oak_planks'); bot._laid.set(`${dx},${64 + dy},0`, { name: 'oak_planks', at: 1 }); }
  set(1, 64, 1, 'oak_log');
  assert.equal(built.builtAt(bot, new Vec3(1, 64, 0)), false, 'a plank it laid');
  assert.equal(built.builtAt(bot, new Vec3(1, 64, 1)), false, 'a log behind its own wall');
  bot._laid.clear(); bot._builtKept.clear();
  assert.equal(built.builtAt(bot, new Vec3(1, 64, 0)), true, 'the same wall, laid by someone else');
  const nether = namedWorld('the_nether'); house(nether.set, 0, 64, 0);
  assert.equal(built.builtAt(nether.bot, new Vec3(0, 64, 0)), false);
  const { bot: other, set: put } = namedWorld(); house(put, 0, 64, 0);
  process.env.JEV_BUILT = '';
  assert.equal(built.on(), false); assert.equal(built.leftAlone(other, {}, new Vec3(0, 64, 0)), false);
  process.env.JEV_BUILT = 'leave';
  assert.equal(built.leftAlone(other, {}, new Vec3(0, 64, 0)), true);
  assert.equal(built.leftAlone(other, { allowBuilt: { by: 'Sky' } }, new Vec3(0, 64, 0)), false, 'the player said so');
});

check('passed over, said once, and taken only when a real search has come to nothing', () => {
  const { bot, set, said } = namedWorld(); house(set, 0, 64, 0);
  const goal = {}, post = new Vec3(0, 64, 0), plank = new Vec3(1, 64, 0), search = { attempts: 0 };
  let carried = 0; bot.inventory = { items: () => (carried ? [{ name: 'oak_log', count: carried }] : []) };
  assert.equal(built.hint(bot, goal, 'oak_log'), false, 'nothing passed over yet');
  built.noteSkipped(bot, goal, 'oak_log', [post]);
  assert.deepEqual(goal.builtSeen.oak_log.cells, [{ x: 0, y: 64, z: 0, name: 'oak_log' }]);
  assert.ok(built.seenFor(goal, 'birch_log'), 'any wood is wood');
  assert.equal(built.seenFor(goal, 'cobblestone'), null);
  assert.equal(built.hint(bot, goal, 'oak_log'), true); assert.equal(built.hint(bot, goal, 'birch_log'), false, 'once');
  assert.match(said[0], /All the wood I can see here is part of something built, so I'll leave it/); assert.match(said[0], /Jev use the buildings/);
  // A search step every six seconds, as on the copy of the live world.
  let at = Date.now();
  const run = (n, ms = 6000) => { let last = false; for (let i = 0; i < n; i++) last = built.lastResort(bot, goal, 'oak_log', search, { now: at += ms }); return last; };
  assert.equal(run(30), false, 'thirty steps in three minutes are not a search');
  assert.equal(run(70), false, 'ten minutes less a step');
  carried = 1;
  assert.equal(run(1), false, 'a log gained: the count starts again');
  assert.equal(goal.builtWait.wood.legs, 1);
  assert.equal(run(99), false);
  at += built.BREAK_MS + 1000;
  assert.equal(run(1), false, 'a break in the search: again');
  assert.equal(goal.builtWait.wood.legs, 1);
  assert.equal(run(99), false);
  process.env.JEV_BUILT = 'strict';
  assert.equal(run(5), false, 'strict: only the player\'s word');
  process.env.JEV_BUILT = 'leave';
  assert.equal(built.lastResort(bot, goal, 'cobblestone', search, { now: at }), false, 'no built source of that seen');
  search.attempts = 7;
  assert.equal(run(1), true, 'ten minutes and a hundred steps with nothing gained');
  assert.equal(goal.builtLastResort.wood.resource, 'oak_log'); assert.equal(search.attempts, 0);
  assert.equal(goal.resourceMemory['overworld:0,64,0'].name, 'oak_log', 'known to the search again');
  assert.equal(built.leftAlone(bot, goal, post), false, 'the post may be taken');
  assert.equal(built.leftAlone(bot, goal, plank), true, 'the wood, and nothing else of the house');
  assert.match(said[1], /I have looked for 11 minutes and found no free wood, so I'll take it from the buildings after all/);
  assert.equal(built.lastResort(bot, goal, 'oak_log', { attempts: 99 }, { now: at + 3600000 }), false, 'opened once');
  assert.equal(said.length, 2);
  // "Jev stop" in answer: closed, and not opened again for this goal but by the player's word.
  assert.equal(built.refuse({}), false, 'nothing to close');
  assert.equal(built.refuse(goal), true);
  assert.equal(built.leftAlone(bot, goal, post), true, 'left alone again');
  assert.equal(built.lastResort(bot, goal, 'oak_log', { attempts: built.GIVE_UP_LEGS }, { now: at + 7200000 }), false, 'refused once, not taken again');
  assert.equal(built.permit(bot, goal, 'Sky'), true); assert.equal(built.leftAlone(bot, goal, post), false, 'the player\'s word still opens it');

  // Rather than give the search up as blocked (work.js explore, 128 steps).
  const late = {}; built.noteSkipped(bot, late, 'oak_log', [post]);
  assert.equal(built.lastResort(bot, late, 'oak_log', { attempts: built.GIVE_UP_LEGS - 1 }), false);
  assert.equal(built.lastResort(bot, late, 'oak_log', { attempts: built.GIVE_UP_LEGS }), true);
  // Opened by the names of what was passed over: cobblestone asked, a footing's stone seen.
  set(2, 63, 2, 'stone');
  const stone = new Vec3(2, 63, 2), footing = {};
  assert.equal(built.leftAlone(bot, footing, stone), true);
  built.noteSkipped(bot, footing, 'cobblestone', [stone]);
  assert.equal(built.hint(bot, footing, 'oak_planks'), false, 'no planks passed over');
  assert.equal(built.lastResort(bot, footing, 'cobblestone', { attempts: built.GIVE_UP_LEGS }), true);
  assert.equal(built.leftAlone(bot, footing, stone), false); assert.equal(built.leftAlone(bot, footing, post), true, 'not the posts');
  const planks = {}; built.noteSkipped(bot, planks, 'oak_planks', [plank]);
  assert.equal(built.hint(bot, planks, 'oak_planks'), true);
  assert.match(said.at(-1), /All the oak planks I can see here are part of something built, so I'll leave them/);

  const asked = {}; built.noteSkipped(bot, asked, 'oak_log', [post]);
  assert.equal(built.permit(bot, asked, 'Sky'), true);
  assert.equal(asked.allowBuilt.by, 'Sky'); assert.ok(asked.resourceMemory['overworld:0,64,0']);
  assert.equal(built.leftAlone(bot, asked, plank), false, 'the player\'s word covers the whole building');
});

check('a remembered post is neither planned with nor walked to while it is left alone', () => {
  const { bot, set } = namedWorld(); house(set, 0, 64, 0); tree(set, 20, 64, 0);
  bot.entity = { position: new Vec3(10, 64, 0) };
  const { rememberResources, knownResourceLocations, knownResourceNames } = require('../src/resource-observation');
  const goal = {}, at = ps => ps.map(p => `${p.x},${p.y},${p.z}`);
  rememberResources(bot, goal, [new Vec3(0, 64, 0), new Vec3(1, 64, 0), new Vec3(20, 64, 0)]);
  assert.deepEqual(at(knownResourceLocations(bot, goal, ['oak_log', 'oak_planks'])), ['20,64,0'], 'the tree only');
  assert.deepEqual(knownResourceNames(bot, goal), ['oak_log'], 'no planks near to plan with');
  built.permit(bot, goal, 'Sky');
  assert.equal(knownResourceLocations(bot, goal, ['oak_log', 'oak_planks']).length, 3);
  assert.deepEqual(knownResourceNames(bot, goal).sort(), ['oak_log', 'oak_planks']);
});

// ---------------------------------------------------------------- 2. the real searches, on a prismarine world
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')('26.1');
const MIN_Y = -64, HEIGHT = 384;
function realWorld(at = new Vec3(0.5, 64, 0.5)) {
  const world = new World(null).sync, columns = new Map(), said = [];
  const column = (x, z) => {
    const cx = x >> 4, cz = z >> 4, k = `${cx},${cz}`;
    if (!columns.has(k)) { const c = new Chunk({ minY: MIN_Y, worldHeight: HEIGHT }); columns.set(k, c); world.setColumn(cx, cz, c, false); }
    return columns.get(k);
  };
  const unknown = new Set();
  const set = (x, y, z, name) => {
    const b = registry.blocksByName[name];
    if (!b) { unknown.add(name); return; }
    column(x, z).setBlockStateId(new Vec3(x & 15, y, z & 15), b.defaultState);
  };
  const bot = { username: 'Jev', registry, world, version: '26.1', said, unknown,
    game: { dimension: 'overworld', minY: MIN_Y, height: HEIGHT, gameMode: 'survival' },
    entity: { position: at.clone(), velocity: new Vec3(0, 0, 0), height: 1.8, onGround: true, effects: {} }, entities: {}, players: {},
    health: 20, food: 20, oxygenLevel: 20, time: { timeOfDay: 6000 },
    inventory: { items: () => [], slots: [], emptySlotCount: () => 36 },
    chat: line => said.push(line),
    blockAt: p => { try { return world.getBlock(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))); } catch (_) { return null; } },
    pathfinder: { movements: null, setMovements(m) { this.movements = m; }, bestHarvestTool: () => null },
    on() {}, once() {}, removeListener() {} };
  require('../src/block-search').installBlockSearch(bot);
  require('../src/movement').configureMovements(bot);
  return { bot, set, said, column };
}
const ground = (set, x1, z1, x2, z2, y = 63) => { for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) { set(x, y, z, 'grass_block'); set(x, y - 1, z, 'dirt'); } };
const task = { check() {}, cancelled: false };
const logStep = { action: 'mine', block: 'oak_log', drops: 'oak_log', sources: ['oak_log'], count: 16 };
const names = (bot, list) => list.map(p => `${p}`).sort();

async function searches() {
  const work = require('../src/work');
  const { committedSource } = require('../src/decision-options');
  // The bot between a house (posts 3 to 7 blocks off) and a tree 14 off.
  const { bot, set } = realWorld(new Vec3(0.5, 64, 0.5));
  ground(set, -24, -24, 40, 24);
  house(set, 3, 64, -2); tree(set, -14, 64, 0); tree(set, 30, 64, 10, { log: 'birch_log', leaves: 'birch_leaves' });
  assert.equal(bot.unknown.size, 0, `names the game does not have: ${[...bot.unknown]}`);
  const posts = [[3, -2], [7, -2], [3, 2], [7, 2]].flatMap(([x, z]) => [64, 65, 66].map(y => new Vec3(x, y, z)));
  const trunk = [64, 65, 66, 67, 68].map(y => new Vec3(-14, y, 0));

  await checkAsync('the state reader and the name reader agree', async () => {
    for (const p of [...posts, ...trunk, new Vec3(4, 64, -2), new Vec3(4, 63, -1), new Vec3(0, 63, 0)]) {
      const byState = built.builtAt(bot, p);
      const plain = { ...bot, world: null, _builtKept: new Map() };
      assert.equal(byState, built.builtAt(plain, p), `${p}`);
    }
    for (const p of posts) assert.equal(built.builtAt(bot, p), true, `post ${p}`);
    for (const p of trunk) assert.equal(built.builtAt(bot, p), false, `trunk ${p}`);
  });

  await checkAsync('the mining search takes the tree and passes over the nearer posts', async () => {
    const goal = {};
    const found = await work.miningCandidates(bot, task, logStep, goal);
    assert.ok(found.length > 0, 'the tree is found');
    for (const p of found) assert.equal(built.builtAt(bot, p), false, `${p} is built`);
    assert.ok(found.every(p => p.x === -14 && p.z === 0), `only the trunk: ${names(bot, found)}`);
    assert.ok(goal.builtSeen?.oak_log?.cells.length > 0, 'the posts passed over are kept with the goal');
    process.env.JEV_BUILT = '';
    const before = await work.miningCandidates(bot, task, logStep, {});
    process.env.JEV_BUILT = 'leave';
    assert.ok(before.some(p => posts.some(q => q.equals(p))), 'switched off, the posts are candidates as they were');
    const allowed = await work.miningCandidates(bot, task, logStep, { allowBuilt: { by: 'Sky' } });
    assert.ok(allowed.some(p => posts.some(q => q.equals(p))), 'with the player\'s leave the posts are candidates');
  });

  await checkAsync('with no tree in reach the search finds nothing and the posts are kept for the line in chat', async () => {
    const lone = realWorld(new Vec3(0.5, 64, 0.5));
    ground(lone.set, -24, -24, 24, 24); house(lone.set, 3, 64, -2);
    const goal = {};
    assert.deepEqual(await work.miningCandidates(lone.bot, task, logStep, goal), []);
    assert.equal(built.hint(lone.bot, goal, 'oak_log'), true);
    assert.match(lone.said[0], /All the wood I can see here is part of something built/);
  });

  await checkAsync('the wood in view is the tree\'s, not the house\'s', async () => {
    // Asked for birch with a house of oak beside it: the step stays birch.
    bot._logKind = null;
    assert.equal(work.logInView(bot, { ...logStep, block: 'birch_log', drops: 'birch_log', sources: ['birch_log'] }, {}).block, 'birch_log');
    // Asked for spruce, none about: the nearest free wood, never the posts' oak for being nearer.
    const far = realWorld(new Vec3(0.5, 64, 0.5));
    ground(far.set, -24, -24, 40, 24); house(far.set, 3, 64, -2); tree(far.set, 20, 64, 10, { log: 'birch_log', leaves: 'birch_leaves' });
    const step = work.logInView(far.bot, { action: 'mine', block: 'spruce_log', drops: 'spruce_log', sources: ['spruce_log'], count: 4 }, {});
    assert.equal(step.block, 'birch_log');
  });

  await checkAsync('a post handed to the mining step is refused and set aside; a saved source of posts is dropped', async () => {
    const goal = {};
    await assert.rejects(() => work.mineAtSource(bot, task, logStep, goal, () => {}, posts[0]), /part of something built: left alone/);
    assert.ok(require('../src/progress').isSetAside(goal, 'reach', posts[0]), 'set aside');
    const saved = { workingSource: { key: 'source_oak_log_3_64_-2', block: 'oak_log', drops: 'oak_log', blocks: posts.slice(0, 3).map(p => ({ x: p.x, y: p.y, z: p.z })) } };
    assert.equal(committedSource(bot, saved, logStep), null);
    assert.equal(saved.workingSource, undefined);
    const tree = { workingSource: { key: 'source_oak_log_-14_64_0', block: 'oak_log', drops: 'oak_log', blocks: trunk.map(p => ({ x: p.x, y: p.y, z: p.z })) } };
    assert.equal(committedSource(bot, tree, logStep)?.blocks.length, 5);
    const leave = { allowBuilt: { by: 'Sky' }, workingSource: saved.workingSource || { key: 'k', block: 'oak_log', drops: 'oak_log', blocks: posts.slice(0, 3).map(p => ({ x: p.x, y: p.y, z: p.z })) } };
    assert.equal(committedSource(bot, leave, logStep)?.blocks.length, 3, 'kept with the player\'s leave');
  });

  await checkAsync('a walk may cut a tree\'s log and not a house\'s post', async () => {
    const m = bot.pathfinder.movements;
    assert.ok(m.exclusionAreasBreak.includes(bot._builtProtection));
    const post = bot.blockAt(posts[0]), log = bot.blockAt(trunk[0]), plank = bot.blockAt(new Vec3(4, 64, -2));
    assert.equal(bot._builtProtection(post), 100); assert.equal(bot._builtProtection(log), 0); assert.equal(bot._builtProtection(plank), 0, 'planks are refused by kind already');
    assert.equal(m.safeToBreak(log), true, 'a trunk in the way is still cut');
    assert.equal(m.safeToBreak(post), false, 'a post is not');
    assert.equal(m.safeToBreak(plank), false);
    bot._goal = { allowBuilt: { by: 'Sky' } };
    assert.equal(m.safeToBreak(post), true, 'with the player\'s leave it is a log again');
    bot._goal = null;
  });
}

// ---------------------------------------------------------------- 3. a part of a real world
async function dumped(file, origins) {
  const work = require('../src/work');
  const cells = require(require('node:path').resolve(file)).blocks;
  const { bot, set } = realWorld();
  let t = Date.now(), n = 0;
  for (const [k, name] of Object.entries(cells)) { const [x, y, z] = k.split(',').map(Number); set(x, y, z, name); n++; }
  console.log(`\n${n} blocks of the dump set in ${Date.now() - t} ms${bot.unknown.size ? `; names the game data lacks: ${[...bot.unknown].join(' ')}` : ''}`);
  const logs = Object.entries(cells).filter(([, name]) => /_log$/.test(name) && !/^stripped_/.test(name)).map(([k]) => new Vec3(...k.split(',').map(Number)));
  t = Date.now();
  const kept = logs.filter(p => built.builtAt(bot, p));
  console.log(`${logs.length} plain logs: ${kept.length} part of something built, ${logs.length - kept.length} free (${Date.now() - t} ms for all of them)`);
  for (const at of origins) {
    bot.entity.position = at.offset(0.5, 0, 0.5); bot._builtKept.clear();
    const goal = {};
    t = Date.now();
    const found = await work.miningCandidates(bot, task, logStep, goal);
    const ms = Date.now() - t;
    process.env.JEV_BUILT = '';
    const before = await work.miningCandidates(bot, task, logStep, {});
    process.env.JEV_BUILT = 'leave';
    const wrong = found.filter(p => built.builtAt(bot, p));
    const d = list => list.length ? `${list.length}, nearest ${list.slice(0, 3).map(p => `${p} ${Math.round(p.distanceTo(bot.entity.position))} off`).join('; ')}` : 'none';
    console.log(`from ${at}: ${ms} ms\n   as it was: ${d(before)} (${before.filter(p => kept.some(q => q.equals(p))).length} of them built)\n   now:       ${d(found)}; passed over ${goal.builtSeen?.oak_log?.cells.length || 0}${wrong.length ? `; BUILT AMONG THEM: ${wrong.join(' ')}` : ''}`);
    assert.equal(wrong.length, 0);
  }
}

(async () => {
  await searches();
  const [file, ...rest] = process.argv.slice(2);
  if (file) {
    const origins = [];
    for (let i = 0; i + 2 < rest.length; i += 3) origins.push(new Vec3(Number(rest[i]), Number(rest[i + 1]), Number(rest[i + 2])));
    await dumped(file, origins);
  }
  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
