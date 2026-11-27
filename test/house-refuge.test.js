'use strict';
// A house of the bot's as the night's shelter (shelter.js rooms): its rooms are its plan's empty cells, it is entered
// and left on foot by its doors and doorways, and nothing of it is dug or filled. Every house drawn since the designer
// has its plan's origin at a corner, a block of its wall. Read as a pocket round that corner, the bot was in the house
// while it worked outside the corner, and left it by digging the corner's blocks (2026-11-25).
//
//   node test/house-refuge.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const shelter = require('../src/shelter');
const { Survival, pocketNow } = require('../src/survival');
const { Task } = require('../src/skills');

const key = p => `${p.x},${p.y},${p.z}`;
// A house of the bot's, seven by seven round (0, 64, 0), as the designer draws one: cobblestone walls two high, an oak
// roof, a front door in the north wall, and an inner wall along z 0 with a door of its own. Its plan's origin is its
// corner, (-3, 64, -3), a block of its wall.
function scene() {
  const world = new World().sync, biomeId = registry.biomesByName.plains.id;
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }));
  const set = (x, y, z, name, props) => world.setBlockStateId(new Vec3(x, y, z), props ? Block.fromProperties(name, props, biomeId).stateId : registry.blocksByName[name].defaultState);
  const blockAt = p => { const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), b = Block.fromStateId(world.getBlockStateId(q), biomeId); b.position = q; return b; };
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) set(x, 63, z, 'stone');
  const blocks = [], empty = [];
  const plan = (x, y, z, material, properties, state) => { set(x, y, z, material, state); blocks.push({ x, y, z, material, ...(properties ? { properties } : {}) }); };
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    const edge = Math.abs(x) === 3 || Math.abs(z) === 3, inner = z === 0 && !edge;
    for (const y of [64, 65]) {
      const half = y === 64 ? 'lower' : 'upper';
      if (x === 0 && (z === -3 || z === 0)) plan(x, y, z, 'oak_door', { facing: 'south', half }, { facing: 'south', half, hinge: 'left', open: 'false', powered: 'false' });
      else if (edge || inner) plan(x, y, z, 'cobblestone');
      else empty.push({ x, y, z });
    }
    plan(x, 66, z, 'oak_planks');
  }
  const blueprint = { origin: { x: -3, y: 64, z: -3 }, bounds: { min: { x: -3, y: 63, z: -3 }, max: { x: 3, y: 66, z: 3 } }, blocks, empty, entrance: { x: 0, y: 64, z: -4 } };
  const house = { kind: 'house', origin: { ...blueprint.origin }, blueprint, dimension: 'overworld', verifiedAt: new Date().toISOString() };
  return { world, set, blockAt, blueprint, house };
}
function botAt(s, x, y, z, { timeOfDay = 1000 } = {}) {
  return Object.assign(new EventEmitter(), { username: 'Jev', game: { dimension: 'overworld', difficulty: 'normal' }, time: { timeOfDay },
    entity: { position: new Vec3(x, y, z), height: 1.8, eyeHeight: 1.62, onGround: true, velocity: new Vec3(0, 0, 0) }, entities: {}, players: {},
    health: 20, food: 20, oxygenLevel: 20, inventory: { items: () => [] }, registry, world: s.world, blockAt: s.blockAt, pathfinder: { movements: {} } });
}
// The plan with no rooms drawn: a refuge read by the pocket's rules, as every house was before.
const roomless = s => ({ ...s.house, blueprint: { ...s.blueprint, empty: [] } });
// The survival routine's leave on its own (Survival.prototype.leave), with the walk and the dig written down.
function leaver(bot, house) {
  const dug = [], walks = [], waited = [];
  const actions = { dig: async (b, t, p) => { dug.push(key(p)); }, navigate: async (b, t, goal, opts) => { walks.push({ to: `${goal.x},${goal.y},${goal.z}`, onFoot: !!opts?.onFoot }); } };
  const survival = Object.assign(Object.create(Survival.prototype), { bot, actions, client: null, state: { shelters: [house] } });
  survival.wait = async (t, g, sv, why) => { waited.push(why); };
  return { survival, dug, walks, waited, leave: () => survival.leave(new Task('test', 'leave'), { request: 'leave', history: [] }, () => {}, house, 'Morning. Back to it.') };
}

test('a house is its rooms: the bot is in it in them, not beside its corner', () => {
  const s = scene();
  assert.equal(shelter.inside(botAt(s, 0.5, 64, -1.5), s.house), true);
  assert.equal(shelter.inside(botAt(s, 1.5, 64, 2.5), s.house), true, 'the back room too');
  // A block off the corner each way, outside the walls: the pocket's rule read this as in the house.
  assert.equal(shelter.inside(botAt(s, -3.5, 64, -3.5), s.house), false);
  assert.equal(shelter.inside(botAt(s, 0.5, 64, -4.5), s.house), false, 'before its door');
  assert.equal(shelter.inside(botAt(s, -3.5, 64, -3.5), roomless(s)), true, 'the pocket\'s rule, for a plan with no rooms');
  // Where it stands for the night: the floor cell nearest the middle of its rooms.
  assert.equal(key(shelter.spot(s.house)), '0,64,-1');
  assert.equal(key(shelter.spot(roomless(s))), '-3,64,-3');
});

test('its ways out are its front door and a doorway a player opened, never the door between its rooms', () => {
  const s = scene(), bot = botAt(s, 0.5, 64, 1.5);
  const ways = () => shelter.exits(bot, s.house).map(w => `${key(w.door)} > ${key(w.outside)}`).sort();
  assert.deepEqual(ways(), ['0,64,-3 > 0,64,-4']);
  s.set(3, 64, 1, 'air'); s.set(3, 65, 1, 'air');
  assert.deepEqual(ways(), ['0,64,-3 > 0,64,-4', '3,64,1 > 4,64,1']);
  // Its front door walled up and the doorway closed again: no way out, and no wall of it to dig.
  for (const [x, z] of [[0, -3], [3, 1]]) for (const y of [64, 65]) s.set(x, y, z, 'cobblestone');
  assert.deepEqual(ways(), []);
  assert.deepEqual(shelter.closures(bot, s.house), []);
});

test('nothing is put into a house to shut it, and no cell beyond its plan is its shell', () => {
  const s = scene(), bot = botAt(s, 0.5, 64, -1.5);
  // A chest of a player's in a room and its front door open: shut as it stands.
  s.set(2, 64, 2, 'chest');
  for (const half of ['lower', 'upper']) s.set(0, half === 'lower' ? 64 : 65, -3, 'oak_door', { facing: 'south', half, hinge: 'left', open: 'true', powered: 'false' });
  assert.deepEqual(shelter.missingShell(bot, s.house), []);
  assert.equal(shelter.sealed(bot, s.house), true);
  // A hole in its west wall: open, no shelter, and still nothing to put into it.
  s.set(-3, 64, 1, 'air');
  assert.equal(shelter.sealed(bot, s.house), false);
  assert.deepEqual(shelter.missingShell(bot, s.house), []);
  const planned = new Set(s.blueprint.blocks.map(key));
  assert.ok(shelter.enclosure(s.house).every(p => planned.has(key(p))));
  // The pocket's rule put two cells north of the corner, outside the walls, in its shell, to be filled for the night.
  assert.deepEqual(shelter.enclosure(roomless(s)).filter(p => !planned.has(key(p))).map(key), ['-3,64,-5', '-3,65,-5']);
});

test('by day the bot in its house is at home, not in a pocket; by night it is sheltered there', () => {
  const s = scene();
  assert.equal(pocketNow(botAt(s, 0.5, 64, -1.5, { timeOfDay: 1000 }), s.house), null);
  assert.deepEqual(pocketNow(botAt(s, 0.5, 64, -1.5, { timeOfDay: 15000 }), s.house), { sealed: true });
  assert.equal(pocketNow(botAt(s, -3.5, 64, -3.5, { timeOfDay: 15000 }), s.house), null, 'outside its corner at night');
});

test('at night a player near keeps the bot up in its house, and a house open or gone is no pocket', () => {
  const s = scene(), before = process.env.JEV_NIGHT;
  process.env.JEV_NIGHT = 'company';
  try {
    const bot = botAt(s, 0.5, 64, -1.5, { timeOfDay: 15000 });
    bot.players = { Alex: { entity: { position: new Vec3(1.5, 64, -1.5) } } };
    assert.equal(pocketNow(bot, s.house), null, 'a player beside it');
    const alone = botAt(s, 0.5, 64, -1.5, { timeOfDay: 15000 });
    assert.deepEqual(pocketNow(alone, s.house), { sealed: true }, 'alone');
    // A doorway opened through its back wall: open to the night.
    s.set(1, 64, 3, 'air'); s.set(1, 65, 3, 'air');
    assert.equal(pocketNow(botAt(s, 0.5, 64, -1.5, { timeOfDay: 15000 }), s.house), null);
  } finally { if (before === undefined) delete process.env.JEV_NIGHT; else process.env.JEV_NIGHT = before; }
  // Its walls gone: where it stood is open ground.
  const gone = scene();
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (const y of [64, 65, 66]) gone.set(x, y, z, 'air');
  assert.equal(shelter.sealed(botAt(gone, 0.5, 64, -1.5), gone.house), false);
  assert.equal(pocketNow(botAt(gone, 0.5, 64, -1.5, { timeOfDay: 15000 }), gone.house), null);
});

test('the leave of a house walks out of its door on foot and digs nothing', async () => {
  const s = scene(), l = leaver(botAt(s, 1.5, 64, 2.5), s.house);
  assert.equal(await l.leave(), true);
  assert.deepEqual(l.dug, []);
  assert.deepEqual(l.walks, [{ to: '0,64,-4', onFoot: true }]);
});

test('with no way out on foot the leave waits, and digs no wall', async () => {
  const s = scene();
  for (const y of [64, 65]) s.set(0, y, -3, 'cobblestone');
  const l = leaver(botAt(s, 1.5, 64, 2.5), s.house);
  assert.equal(await l.leave(), false);
  assert.deepEqual(l.dug, []);
  assert.deepEqual(l.walks, []);
  assert.deepEqual(l.waited, ['No door or doorway of the house opens onto ground to walk out by']);
});

test('a walk out that finds no way is a failed leave, said with the door, still digging nothing', async () => {
  const s = scene(), l = leaver(botAt(s, 1.5, 64, 2.5), s.house);
  l.survival.actions.navigate = async () => { throw Object.assign(new Error('No route from here'), { name: 'NoRoute' }); };
  await assert.rejects(l.leave(), /No way out of the house on foot by \(0, 64, -3\): No route from here/);
  assert.deepEqual(l.dug, []);
});

test('the walk back into a house at night is to the floor of its rooms, with no blocks put by and nothing of it dug', async () => {
  const s = scene(), bot = botAt(s, 0.5, 64, -6.5, { timeOfDay: 15000 }), l = leaver(bot, s.house);
  const approached = [], gathered = [];
  Object.assign(l.survival, {
    currentShelter: () => s.house,
    reachableRefuge: async (t, g, sv, refuge) => refuge,
    approachRefuge: async (t, g, refuge, dest) => { approached.push(`${dest.x},${dest.y},${dest.z}`); bot.entity.position = new Vec3(dest.x + 0.5, dest.y, dest.z + 0.5); },
  });
  l.survival.actions.acquireStep = async (b, t, item) => { gathered.push(item); };
  await l.survival.refugeStep(new Task('test', 'shelter'), { request: 'shelter', history: [] }, () => {}, { method: 'saved_shelter' });
  assert.deepEqual(approached, ['0,64,-1']);
  assert.deepEqual(gathered, []);
  assert.deepEqual(l.dug, []);
  assert.equal(shelter.inside(bot, s.house), true);
});

test('a room added on beside it, or a chest of its plan taken out, leaves it shut; a house not all in sight is not', () => {
  const s = scene();
  // A chest its plan put in the back room, taken out since.
  const blueprint = { ...s.blueprint, empty: s.blueprint.empty.filter(c => key(c) !== '2,64,2'), blocks: [...s.blueprint.blocks, { x: 2, y: 64, z: 2, material: 'chest' }] };
  const house = { ...s.house, blueprint }, bot = botAt(s, 0.5, 64, -1.5);
  assert.equal(shelter.sealed(bot, house), true, 'its chest taken out');
  // A doorway through its east wall: open, until a room is built on beyond it, walled and roofed.
  s.set(3, 64, 1, 'air'); s.set(3, 65, 1, 'air');
  assert.ok(['3,64,1', '3,65,1'].includes(key(shelter.opening(bot, house))), 'out by the doorway');
  for (let x = 4; x <= 6; x++) for (let z = -1; z <= 3; z++) {
    if (x === 6 || z === -1 || z === 3) for (const y of [64, 65]) s.set(x, y, z, 'cobblestone');
    s.set(x, 66, z, 'oak_planks');
  }
  assert.equal(shelter.opening(bot, house), null, 'the room added on');
  assert.equal(shelter.sealed(bot, house), true);
  // Its east wall out of sight: not read shut.
  const blind = Object.assign(botAt(s, 0.5, 64, -1.5), { blockAt: p => (p.x >= 3 ? null : s.blockAt(p)) });
  assert.equal(shelter.sealed(blind, house), false);
  // A hole in the added room's roof.
  s.set(5, 66, 1, 'air');
  assert.equal(shelter.sealed(bot, house), false);
});

test('a house open at night is no shelter: said where its air goes out, and nothing put into it', async () => {
  const s = scene();
  s.set(-3, 64, 1, 'air');
  const bot = botAt(s, 0.5, 64, -1.5, { timeOfDay: 15000 }), l = leaver(bot, s.house), reports = [], placed = [];
  Object.assign(l.survival, { currentShelter: () => s.house, reachableRefuge: async (t, g, sv, refuge) => refuge, report: (g, sv, a) => { reports.push(a); } });
  l.survival.actions.place = async (b, t, p) => { placed.push(key(p)); };
  assert.equal(await l.survival.refugeStep(new Task('test', 'shelter'), { request: 'shelter', history: [] }, () => {}, { method: 'saved_shelter' }), false);
  assert.equal(reports.find(a => a.action === 'seal_failed')?.error, 'the house with its corner at (-3, 64, -3) is open to the night by (-3, 64, 1) (air)');
  assert.deepEqual(placed, []);
  assert.deepEqual(l.dug, []);
});

test('a house seen open is no shelter to go to, nor one not all in sight left out', () => {
  const s = scene();
  const current = bot => Object.assign(Object.create(Survival.prototype), { bot, state: { shelters: [s.house] } }).currentShelter();
  assert.equal(current(botAt(s, 0.5, 64, -6.5, { timeOfDay: 15000 })), s.house, 'shut, from outside');
  assert.equal(current(botAt(s, 0.5, 64, -1.5, { timeOfDay: 15000 })), s.house, 'shut, in it');
  // Its east wall out of sight: kept, to be read as the bot comes to it.
  assert.equal(current(Object.assign(botAt(s, 0.5, 64, -6.5), { blockAt: p => (p.x >= 3 ? null : s.blockAt(p)) })), s.house);
  // A hole in its roof: no shelter, the bot in it or not.
  s.set(1, 66, 1, 'air');
  assert.equal(current(botAt(s, 0.5, 64, -6.5, { timeOfDay: 15000 })), undefined, 'open, from outside');
  assert.equal(current(botAt(s, 0.5, 64, -1.5, { timeOfDay: 15000 })), undefined, 'open, in it');
});
