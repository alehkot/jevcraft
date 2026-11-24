'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const World = require('prismarine-world')(registry), Chunk = require('prismarine-chunk')(registry);
const close = require('../src/stay-close'), site = require('../src/work-site');
const { CompanionMemory } = require('../src/memory');
const { resourceSources } = require('../src/decision-options');
const { reservedForConstruction } = require('../src/build-sites');
const { selectSchematicSite } = require('../src/designer');
const { designStarterHouse } = require('../src/starter-house');
const { dig, miningCandidates, upkeepStep, workstation } = require('../src/work');
const { friendlyProblem } = require('../src/speech');
const { statusMessage } = require('../src/status');
const { discoverStep } = require('../src/discovery');
const { headingSays } = require('../src/anchors');

function scene() {
  const world = new World().sync, points = new Map();
  for (let x = -1; x <= 2; x++) for (let z = -1; z <= 1; z++) world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }));
  const set = (p, name) => { world.setBlockStateId(p, registry.blocksByName[name].defaultState); points.set(p.toString(), p); };
  for (let x = -12; x < 44; x++) for (let z = -12; z < 18; z++) set(new Vec3(x, 63, z), 'grass_block');
  const player = { name: 'player', height: 1.8, position: new Vec3(.5, 64, .5), pitch: 0, yaw: 0 };
  const bot = { entity: { position: new Vec3(21.5,64,.5) }, players: { Alex: { entity: player } }, entities: { 1: player },
    world, registry, blockAt: p => world.getBlock(p), health: 20, oxygenLevel: 20, food: 20, game: { gameMode: 'survival', dimension: 'overworld' },
    inventory: { items: () => [], slots: [] }, pathfinder: { movements: {} }, companionMemory: { state: {}, flush() {} } };
  bot.findBlocks = ({ point = bot.entity.position, matching, count = 1, maxDistance, useExtraInfo }) => [...points.values()]
    .filter(p => p.distanceTo(point) <= maxDistance && [].concat(matching).includes(bot.blockAt(p).type) && (!useExtraInfo || useExtraInfo(bot.blockAt(p))))
    .sort((a,b) => a.distanceTo(point) - b.distanceTo(point)).slice(0,count);
  return { bot, player, set };
}
const task = { check() {} };

test('landmark placements survive a stop after the click and finish the requested count at the site', async () => {
  const { bot, set } = scene(), anchor = new Vec3(4, 64, 4);
  set(anchor, 'crafting_table');
  const { interpret } = require('../src/objectives');
  const workSite = { name: 'crafting_table', dimension: 'overworld', kind: 'block', position: { ...anchor } };
  const goal = await interpret(null, 'Jev put two torches', 'Alex', 'Jev', { registry, workSite, builds: [] });
  assert.equal(goal.kind, 'place_at_site');
  assert.equal(goal.count, 2);
  let supplied = 1, clicks = 0, saved;
  const save = () => { saved = structuredClone(goal); };
  bot.inventory.items = () => supplied ? [{ name: 'torch', count: supplied }] : [];
  const actions = {
    navigate: async () => { bot.entity.position = anchor.offset(1.5, 0, 1.5); },
    available: p => bot.blockAt(p)?.name === 'air' && bot.blockAt(p.offset(0,-1,0))?.name === 'grass_block',
    acquireStep: async () => { supplied++; },
    place: async (_bot, _task, cell, item) => {
      assert(cell.distanceTo(anchor) <= 4); assert(!cell.equals(anchor));
      set(cell, item); supplied--; clicks++;
      if (clicks === 1) throw new Error('interrupted after the server placed the torch');
    }
  };
  await assert.rejects(site.placeAtSite(bot, task, goal, save, actions), /interrupted/);
  const resumed = JSON.parse(JSON.stringify(saved));
  const read = bot.blockAt;
  const pending = new Vec3(resumed.pendingPlacement.x, resumed.pendingPlacement.y, resumed.pendingPlacement.z);
  bot.entity.position = anchor.offset(300, 0, 0);
  bot.blockAt = p => p.equals(pending) && bot.entity.position.distanceTo(anchor) > 10 ? null : read(p);
  await site.placeAtSite(bot, task, resumed, () => {}, actions);
  assert.equal(resumed.placedAtSite.length, 1);
  assert.equal(supplied, 0);
  for (let n = 0; n < 4 && !await site.placeAtSite(bot, task, resumed, () => {}, actions); n++) {}
  assert.equal(clicks, 2);
  assert.equal(resumed.placedAtSite.length, 2);
  assert.equal(bot.blockAt(anchor).name, 'crafting_table');
  assert.equal((await interpret(null, 'Jev put a chest', 'Alex', 'Jev', { registry, workSite })).kind, 'place_at_site');
  const namedHouse = await interpret(null, 'Jev add a chest to the house', 'Alex', 'Jev', { registry, workSite, builds: [] });
  assert.equal(namedHouse.kind, 'clarify');
});

test('chat enables, resizes, reports, disables and persists the preference independently of any job', t => {
  const { bot } = scene(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-range-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'memory.json');
  bot.companionMemory = new CompanionMemory(file);
  const job = { kind: 'build', step: 'lay floor' }; bot._goal = job;
  close.applyControl(bot, 'Alex', close.readControl('stay close to me'));
  assert.deepEqual(close.preference(bot), { player: 'Alex', radius: 12 });
  close.applyControl(bot, 'Alex', close.readControl('stay within 8 blocks of me'));
  bot.companionMemory = new CompanionMemory(file);
  assert.equal(close.preference(bot).radius, 8);
  assert.match(statusMessage(bot, null, null), /8 blocks of Alex/);
  assert.equal(close.readControl('stay close to me, max 9 blocks').radius, 9);
  assert.equal(close.readControl('how close are you staying?').mode, 'status');
  assert.equal(close.readControl('stay within 0 blocks of me').mode, 'invalid');
  assert.equal(close.readControl('why would you stay close to me?'), null);
  close.applyControl(bot, 'Alex', close.readControl('stop staying close'));
  assert.equal(new CompanionMemory(file).state.stayClose, undefined);
  assert.deepEqual(bot._goal, { kind: 'build', step: 'lay floor' });
});

test('the path cost grows for outward work, leaves inward and emergency moves alone, and permits distant destinations', () => {
  const { bot, player } = scene(); player.position = new Vec3(0,64,0);
  close.applyControl(bot, 'Alex', { mode: 'on', radius: 8 });
  function stepCost(x, direction) {
    const from = new Vec3(x,64,0); bot.entity.position = from;
    const move = Object.assign(from.offset(direction,0,0), { cost: 1 });
    close.biasRoutes(bot, from, [move]); return move.cost;
  }
  assert.equal(stepCost(2,1), 1);
  assert.ok(stepCost(11,1) > stepCost(8,1));
  assert.ok(stepCost(35,1) > stepCost(11,1));
  assert.ok(Number.isFinite(stepCost(1000,1)));
  assert.equal(stepCost(35,-1), 1);
  bot._turn = { holder: 'vitals' }; assert.equal(stepCost(35,1), 1);
  delete bot._turn;
  // Out of sight: kept to where the player was last seen (stay-close.js anchor), not given up.
  delete bot.players.Alex.entity; assert.ok(stepCost(35,1) > 1); assert.equal(close.due(bot, true), true);
  delete bot.players.Alex; assert.equal(stepCost(35,1), 1); assert.equal(close.due(bot, false), false, 'gone: nothing to keep to');
});

test('regroups with a moving player and leaves uninterrupted work time at a fixed distant job', async () => {
  const { bot, player } = scene();
  const work = { kind: 'craft', item: 'chest' }; bot._goal = work;
  close.applyControl(bot, 'Alex', { mode: 'on', radius: 8 });
  const paths = [];
  const navigate = async (b, t, g) => { paths.push(g); b.entity.position = player.position.offset(3,0,0); };
  assert.equal(await close.regroup(bot, task, navigate, false), true);
  assert.equal(paths[0].entity, player);
  bot.entity.position = player.position.offset(24,0,0);
  const now = Date.now() + 30000;
  assert.equal(close.due(bot, false, now), false);
  assert.equal(close.due(bot, true, now), true);
  player.position = player.position.offset(-12,0,0);
  assert.equal(close.due(bot, false, now), true);
  assert.equal(bot._goal, work);
  player.isValid = false; assert.equal(close.due(bot, false, now), false);
});

test('resources, exploration headings and ordinary work share the player preference', () => {
  const { bot, set } = scene(), inward = new Vec3(12,64,0), outward = new Vec3(25,64,0);
  set(inward, 'iron_ore'); set(outward, 'iron_ore');
  const sources = () => resourceSources(bot, [outward,inward]);
  assert.deepEqual(sources()[0].blocks[0],outward);
  close.applyControl(bot, 'Alex', { mode: 'on', radius: 8 });
  assert.deepEqual(sources()[0].blocks[0],inward);
  assert.match(headingSays(bot, {}, 0), /farther.*Alex/);
  assert.equal(resourceSources(bot, [outward])[0].blocks[0].x,25);
});

test('the closest block and real tree are chosen from the player, and later movement does not move the site', () => {
  const { bot, player, set } = scene();
  const near = new Vec3(3,64,0), far = new Vec3(22,64,0);
  set(near,'crafting_table'); set(far,'crafting_table');
  const read = text => site.resolveLocation(bot, 'Alex', site.splitLocation(text, registry));
  const table = read('craft a chest next to the closest crafting table to me.');
  assert.deepEqual(table.position, { ...near });
  assert.equal(site.splitLocation('craft two chests beside the nearest crafting table', registry).task, 'craft two chests');
  assert.equal(site.splitLocation('build a house next to the barn', registry), null);
  for (const x of [1,7]) for (let y = 0; y < 4; y++) set(new Vec3(x,64+y,5),'spruce_log');
  set(new Vec3(7,68,5),'spruce_leaves');
  const tree = read('build a house next to the closest tree to me');
  assert.deepEqual(tree.position, { x:7,y:64,z:5 });
  assert.equal(reservedForConstruction({ workSite:tree },new Vec3(7,67,5)),true);
  player.position = far.offset(0,0,2);
  assert.deepEqual(table.position, { ...near }); assert.deepEqual(tree.position, { x:7,y:64,z:5 });
  assert.throws(() => read('build a house next to the nearest beacon'), /cannot|can.t find/i);
  delete bot.players.Alex.entity;
  assert.throws(() => read('craft a chest beside the nearest furnace'), /in view/);
});

test('pointing uses the speaker’s ray, including level pitch and north yaw; an empty ray asks again', () => {
  const { bot, set } = scene(), mark = new Vec3(0,65,-4);
  const ref = site.splitLocation("build a house next to the block I'm pointing at",registry);
  assert.throws(() => site.resolveLocation(bot,'Alex',ref), /Point at/);
  set(mark,'stone');
  assert.deepEqual(site.resolveLocation(bot,'Alex',ref).position, { ...mark });
});

test('a requested house stays beside its landmark and the exact chosen workstation is used', async () => {
  const { bot, set } = scene(), table = new Vec3(4,64,0);
  set(table,'crafting_table'); set(new Vec3(20,64,0),'crafting_table');
  const ref = site.resolveLocation(bot,'Alex',site.splitLocation('build a house next to the closest crafting table',registry));
  const design = designStarterHouse(bot,{starterBeds:2,material:'spruce_planks'});
  const blueprint = selectSchematicSite(bot,design,{anchor:ref.position,landmark:ref,allowPreserved:false});
  assert.ok(blueprint);
  assert.ok(blueprint.blocks.every(p=>!site.protects(ref,p)));
  assert.ok(Math.min(...blueprint.blocks.map(p=>table.distanceTo(new Vec3(p.x,p.y,p.z)))) <= 5);
  assert.deepEqual(site.stations(bot,'crafting_table',ref),[table]);
  let walk;
  await site.approach(bot,task,ref,async (b,t,g) => { walk = g; bot.entity.position = table.offset(0,0,2); });
  assert.equal(walk.x,table.x);
  assert.ok((await workstation(bot,task,'crafting_table',{workSite:ref})).position.equals(table));
  set(table,'air');
  assert.throws(()=>site.stations(bot,'crafting_table',ref),/has gone/);
  bot.game.dimension = 'the_nether';
  await assert.rejects(site.approach(bot,task,ref,async ()=>{}),/another dimension/);
});


test('leading landmark phrases, exact site protection and direct mining use the chosen spot', async () => {
  const { bot, set } = scene(), table = new Vec3(3,64,0);
  set(table,'crafting_table');
  const ref = site.splitLocation('Next to the nearest crafting table to me, get gravel',registry);
  assert.equal(ref.task,'get gravel');
  const workSite = site.resolveLocation(bot,'Alex',ref), goal = { workSite, item:'gravel' };
  bot._activeWorkSite = workSite;
  await assert.rejects(dig(bot,task,table),/marks the spot/);
  assert.equal(bot.blockAt(table).name,'crafting_table');
  // A far gravel block is returned even by this faulty search implementation.
  // The work layer must still filter it before offering a source to the bot.
  const near=table.offset(2,0,0), far=table.offset(20,0,0);
  set(near,'gravel');set(far,'gravel');
  let options;
  bot.findBlocksAsync = async opts => { options=opts; return [far,near]; };
  const found=await miningCandidates(bot,task,{block:'gravel',drops:'gravel',sources:['gravel']},goal);
  assert.ok(options.point.equals(table));assert.equal(options.maxDistance,site.WORK_RADIUS);
  assert.deepEqual(found,[near]);
  assert.equal(await upkeepStep(bot,task,{...goal,kind:'obtain',count:2,step:{action:'mine',drops:'gravel'}},()=>{}),false);
  const message='I cannot reach any gravel beside the crafting table. Please choose another spot.';
  assert.equal(friendlyProblem(message),message);
  assert.equal(site.forOutput({...goal, siteOutputs:['chest','gravel']},'spruce_log'),null);
  assert.equal(site.forOutput({...goal, siteOutputs:['chest','gravel']},'gravel'),workSite);
});

test('a discovery beside a landmark finds a local target or asks for another spot', async () => {
  const { bot, set } = scene(), table=new Vec3(3,64,0);
  set(table,'crafting_table');set(table.offset(13,0,0),'furnace');
  const workSite=site.resolveLocation(bot,'Alex',site.splitLocation('find a furnace beside the closest crafting table',registry));
  bot.entity.position=table.offset(0,0,2);
  assert.deepEqual(site.discoveryAt('Please locate a sheep',registry),{kind:'entity',name:'sheep'});
  assert.equal(site.discoveryAt('can you craft a furnace',registry),null);
  assert.equal(site.discoveryAt('find a way to the Nether',registry),null);
  const goal={kind:'find', workSite, discoveryTarget:site.discoveryAt('find a furnace',registry)};
  const actions={explore:()=>assert.fail('searched outside chosen site')};
  await assert.rejects(discoverStep(bot,task,goal,()=>{},actions),e=>e.needsPlayer&&/another spot/.test(e.message));
  const local=table.offset(0,0,3);set(local,'furnace');
  assert.equal(await discoverStep(bot,task,goal,()=>{},actions),true);
  assert.deepEqual(goal.discovery.found.position,{...local});
});
