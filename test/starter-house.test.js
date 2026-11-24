'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const { designStarterHouse, checkStarterDesign } = require('../src/starter-house');
const { selectSchematicSite } = require('../src/designer');
const { buildCellComplete, buildFootprint, isBed, matchesOwnership } = require('../src/build-blocks');
const { ConstructionGoal } = require('../src/construction-access');
const { isDoor } = require('../src/doors');
const { verifyHouse } = require('../src/objectives');
const { designedBuildStep, catalogPlan, place } = require('../src/work');
const point = p => new Vec3(p.x, p.y, p.z);
const task = { check() {} };
const noop = () => {};

function scene() {
  const world = new World().sync;
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }));
  }
  function set(p, name, properties) {
    const type = registry.blocksByName[name];
    const state = properties ? Block.fromProperties(type.id, properties, 0).stateId : type.defaultState;
    world.setBlockStateId(p, state);
  }
  for (let x = -14; x <= 18; x++) for (let z = -14; z <= 18; z++) {
    set(new Vec3(x, 62, z), 'dirt');
    set(new Vec3(x, 63, z), 'grass_block');
  }
  const tree = new Vec3(10, 64, 8);
  for (let y = 0; y < 4; y++) set(tree.offset(0, y, 0), 'spruce_log');
  const stock = {}, chat = [], clicks = [];
  const bot = Object.assign(new EventEmitter(), { registry, world, username: 'Jev', entities: {}, players: {},
    entity: { position: new Vec3(1.5, 64, 0.5), height: 1.8, onGround: true },
    health: 20, food: 20, oxygenLevel: 20, game: { gameMode: 'survival', dimension: 'overworld' },
    time: { timeOfDay: 6000 }, pathfinder: { movements: {} }, _client: new EventEmitter(),
    inventory: { slots: [], items: () => Object.entries(stock).filter(([, n]) => n > 0)
      .map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })) },
    blockAt: p => world.getBlock(p), findBlocks: ({ matching }) => [].concat(matching).includes(registry.blocksByName.spruce_log.id) ? [tree] : [],
    findBlock: () => null, equip: async item => { bot.heldItem = item; }, chat: line => chat.push(line),
    look: async yaw => { bot.entity.yaw = yaw; }, waitForTicks: noop, setControlState: noop,
    canDigBlock: () => true, stopDigging: noop, dig: async block => {
      set(block.position, 'air');
      bot._client.emit('block_change', { location: block.position, type: 0 });
    } });
  bot._placeBlockWithOptions = async (ref, normal) => {
    const foot = ref.position.plus(normal), material = bot.heldItem.name;
    if (isBed(material) || isDoor(material) || material === 'torch') assert.ok(normal.equals(new Vec3(0, 1, 0)));
    const facing = { 0: 'north', 1: 'west', 2: 'south', 3: 'east' }[(Math.round(bot.entity.yaw / (Math.PI / 2)) + 4) % 4];
    const old = bot.blockAt(foot);
    const properties = isBed(material) ? { facing, part: 'foot' } : isDoor(material) ? { facing, half: 'lower' } :
      material === 'chest' ? { facing: {north:'south', south:'north', east:'west', west:'east'}[facing], type:'single', waterlogged:false } :
      material.endsWith('_stairs') ? { facing, half:'bottom', waterlogged:false } : undefined;
    for (const part of buildFootprint({ ...foot, material, properties })) {
      set(point(part), material, part.properties);
    }
    stock[material]--;
    clicks.push({ foot, material, facing });
    bot.emit('blockPlaced', old, bot.blockAt(foot));
  };
  return { bot, set, stock, chat, clicks };
}

// Model the walk between work faces. The builder still has to find a legal
// click against real block shapes, dig the ground, place, and verify each cell.
function standForWork(bot, cell) {
  const operation = bot.blockAt(point(cell)).name === 'air' ? 'place' : 'dig';
  const target = new ConstructionGoal(bot, cell, operation, cell);
  for (const y of [0, 1, -1, 2]) for (const z of [-1, 1, -2, 2, 0]) for (const x of [0, -1, 1, -2, 2]) {
    const feet = point(cell).offset(x + .5, y, z + .5);
    if (bot.blockAt(feet)?.boundingBox !== 'empty' || bot.blockAt(feet.offset(0, 1, 0))?.boundingBox !== 'empty' ||
      bot.blockAt(feet.offset(0, -1, 0))?.boundingBox !== 'block') continue;
    if (target.reachable(feet) && !point(cell).equals(feet.floored().offset(0, -1, 0))) {
      bot.entity.position = feet;
      return true;
    }
  }
  return false;
}

function siteWithShell(bot, set, sleepers) {
  const goal = { kind: 'build', starterBeds: sleepers };
  goal.design = designStarterHouse(bot, goal);
  goal.blueprint = selectSchematicSite(bot, goal.design, { at: { x: 0, y: 63, z: 0 }, allowPreserved: false });
  for (const cell of goal.blueprint.blocks.filter(p => !isBed(p.material))) set(point(cell), cell.material, cell.properties);
  return goal;
}

for (const sleepers of [2, 3]) {
  test(`a fresh ${sleepers}-person house starts near its player using local trees and a small first wood batch`, async () => {
    const { bot, chat } = scene();
    const anchor = { x: 0, y: 64, z: 0 };
    const goal = { kind: 'build', starterBeds: sleepers, buildAnchor: anchor };
    // Stop at the first persisted acquisition batch before any walking or mining.
    const stop = new Error('first batch persisted');
    await assert.rejects(designedBuildStep(bot, task, goal, () => { if (goal.buildBatch) throw stop; }), e => e === stop);
    assert.ok(point(goal.blueprint.origin).distanceTo(point(anchor)) < 12);
    assert.deepEqual(goal.design.source.size, [7, 4, 8]);
    assert.equal(goal.design.materials.spruce_door, 2);
    checkStarterDesign(goal.design, { sleepers, material:'spruce_planks' });
    assert.equal(goal.design.materials.white_bed, sleepers);
    assert.ok(goal.design.materials.spruce_planks > 0);
    assert.ok(chat.some(line => line.includes('drop logs or wool')));
    const { cells, outputs } = goal.buildBatch;
    assert.equal(cells.length, 16);
    assert.deepEqual(outputs, [{ item: 'spruce_planks', count: 16 }]);
    const plan = catalogPlan(bot, outputs, undefined, {}, goal);
    assert.equal(plan[0].action, 'mine');
    assert.equal(plan[0].drops, 'spruce_log');
    assert.equal(plan[0].count, 4);
    assert.equal(plan.at(-1).item, 'spruce_planks');
    const cell = (x, y, z) => goal.design.blocks.find(p => p.x === x && p.y === y && p.z === z);
    for (const z of [0, 3]) {
      assert.equal(cell(3, 1, z).properties.half, 'lower');
      assert.equal(cell(3, 2, z).properties.half, 'upper');
    }
    for (let x = 0; x < 7; x++) for (let z = 0; z < 8; z++) assert.equal(cell(x, 3, z).material, 'spruce_planks');
    assert.equal(cell(0, 2, 2).material, 'glass');
    assert.equal(cell(6, 2, 5).material, 'glass');
    for (const z of [1,2,4]) assert.equal(cell(3, 1, z), undefined);
  });
  test(`places all ${sleepers} beds from donated supplies and verifies the finished house across a resume`, async () => {
    const { bot, set, stock, clicks } = scene();
    let goal = siteWithShell(bot, set, sleepers);
    assert.equal(verifyHouse(bot, goal.blueprint).ok, false);
    const beds = ['red_bed', 'blue_bed', 'black_bed'].slice(0, sleepers);
    for (const [i, name] of beds.entries()) {
      // A donated bed arriving after construction started; stand in the aisle
      // where the real pathfinder can see its supporting block.
      stock[name] = 1;
      const foot = goal.blueprint.blocks.find(p => p.properties?.part === 'foot' && bot.blockAt(point(p)).name === 'air');
      bot.entity.position = point(foot).offset(.5, 0, -.5);
      assert.equal(await designedBuildStep(bot, task, goal, noop), i === sleepers - 1);
      assert.equal(stock[name], 0);
      assert.deepEqual(clicks[i], { foot: point(foot), material: name, facing: 'south' });
      for (const part of buildFootprint(foot)) {
        assert.ok(matchesOwnership(bot.blockAt(point(part)), goal.buildOwned[[part.x, part.y, part.z].join(',')]));
      }
      goal = JSON.parse(JSON.stringify(goal));
    }
    assert.deepEqual(verifyHouse(bot, goal.blueprint), { ok: true, missing: 0, obstructed: 0 });
    assert.equal(clicks.length, sleepers);
  });
}

test('the first unfurnished bed uses nearby sheep, and newly collected coloured wool goes into its recipe', async () => {
  const { bot, set, stock } = scene();
  const goal = siteWithShell(bot, set, 2);
  Object.assign(stock, { spruce_planks: 3, crafting_table: 1 });
  const sheep = { name: 'sheep', id: 17, position: new Vec3(9, 64, -2), metadata: [] };
  bot.entities[sheep.id] = sheep;
  const stop = new Error('wool source selected');
  await assert.rejects(designedBuildStep(bot, task, goal, () => { if (goal.step?.action === 'gather_wool') throw stop; }), e => e === stop);
  assert.deepEqual(goal.step.target, { ...sheep.position });
  delete goal.step;
  stock.blue_wool = 3;
  const planned = new Error('bed recipe selected');
  await assert.rejects(designedBuildStep(bot, task, goal, () => { if (goal.buildBatch?.outputs[0].item === 'blue_bed') throw planned; }), e => e === planned);
  const steps = catalogPlan(bot, goal.buildBatch.outputs, undefined, stock, goal);
  assert.ok(steps.every(step => step.action === 'craft'));
  assert.equal(steps.at(-1).item, 'blue_bed');
  assert.equal(steps.at(-1).consumes.blue_wool, 3);
});

test('a bed requires full support at both ends and space clear of players before it is used', async () => {
  const { bot, set, stock, clicks } = scene();
  const foot = new Vec3(0, 64, 0);
  const properties = { facing: 'east', part: 'foot' };
  stock.white_bed = 1;
  set(foot.offset(1, -1, 0), 'oak_slab', { type: 'bottom' });
  await assert.rejects(place(bot, task, foot, 'white_bed', { properties }), /support below both/);
  set(foot.offset(1, -1, 0), 'spruce_planks');
  bot.entities[3] = { name: 'player', type: 'player', username: 'Guest', position: foot.offset(1.5, 0, .5) };
  await assert.rejects(place(bot, task, foot, 'white_bed', { properties }), /Guest stands/);
  assert.equal(stock.white_bed, 1);
  assert.equal(clicks.length, 0);
});

test('counts correctly placed player beds of any colour without claiming them', async () => {
  const { bot, set, clicks } = scene();
  const goal = siteWithShell(bot, set, 2);
  for (const part of goal.blueprint.blocks.filter(p => isBed(p.material))) set(point(part), 'green_bed', part.properties);
  assert.equal(await designedBuildStep(bot, task, goal, noop), true);
  assert.equal(goal.design.materials.green_bed, 2);
  assert.equal(goal.buildOwned, undefined);
  assert.equal(clicks.length, 0);
});

test('a player can supply the shell in batches and the builder finishes the entire starter house', async () => {
  const { bot, stock, clicks } = scene();
  const goal = { kind: 'build', starterBeds: 3, buildAnchor: { x: 0, y: 64, z: 0 } };
  const batchReady = new Error('new batch');
  let lastBatch, finished = false, firstBedAt;
  for (let turn = 0; turn < 350 && !finished; turn++) {
    const remaining = goal.buildBatch?.cells.filter(cell => !buildCellComplete(bot, cell));
    if (remaining?.length) assert.ok(remaining.some(cell => standForWork(bot, cell)), 'a reachable work face for ' + remaining.map(p=>p.material + '@' + point(p)).join(', '));
    try {
      finished = await designedBuildStep(bot, task, goal, () => {
        if (goal.buildBatch && goal.buildBatch !== lastBatch) { lastBatch = goal.buildBatch; throw batchReady; }
      });
    } catch (err) {
      if (err !== batchReady) throw err;
      for (const { item, count } of goal.buildBatch.outputs) stock[item] = count;
      if (isBed(goal.buildBatch.outputs[0].item) && firstBedAt === undefined) firstBedAt = clicks.length;
    }
  }
  assert.equal(finished, true);
  assert.deepEqual(verifyHouse(bot, goal.blueprint), { ok: true, missing: 0, obstructed: 0 });
  assert.equal(clicks.filter(c => isDoor(c.material)).length, 2);
  for (const [material, count] of [['glass',2], ['torch',2], ['chest',1], ['spruce_stairs',2]]) {
    assert.equal(clicks.filter(c => c.material === material).length, count);
  }
  assert.equal(clicks.filter(c => isBed(c.material)).length, 3);
  assert.equal(firstBedAt, clicks.length - 3);
});

test('the saved plank-only house can be fitted out in place and resumed', async () => {
  const { bot, set, stock, clicks } = scene();
  const { BuildRegistry } = require('../src/builds');
  const { houseBlueprint, interpret } = require('../src/objectives');
  const { rememberFittings } = require('../src/house-details');
  const original = houseBlueprint(new Vec3(0,64,0), 'oak_planks');
  assert.deepEqual([...new Set(original.blocks.map(p=>p.material))], ['oak_planks']);
  bot.buildRegistry = new BuildRegistry();
  for (const c of original.blocks) set(point(c), c.material);
  const entry = bot.buildRegistry.remember({kind:'house',request:'build a small dark oak house',blueprint:original}, {dimension:'overworld',status:'complete'});
  const keepsake = new Vec3(0,65,0);
  set(keepsake,'diamond_block');
  const context = {registry,builds:bot.buildRegistry.describe(bot, bot.entity.position, 'overworld')};
  let goal = await interpret(null, 'Jev you forgot door for house', 'Alex', 'Jev', context);
  assert.equal(goal.houseDetails.target,entry.id);
  assert.deepEqual(goal.houseDetails.parts,{door:1});
  const all = await interpret(null, 'Jev furnish the house', 'Alex','Jev',context);
  const run = async current => {
    let g=current;
    Object.assign(stock,{oak_door:4,glass:8,torch:8,oak_stairs:4,chest:2});
    for(let i=0;i<65;i++){
      const missing=g.blueprint?.blocks.filter(c=>!c.companion&&!buildCellComplete(bot,c));
      if (missing?.length) {
        const layer = Math.min(...missing.map(c => c.y));
        assert.ok(missing.filter(c => c.y === layer).some(c => standForWork(bot, c)), 'no work face for ' + missing.map(c=>c.material+'@'+point(c)).join(', '));
      }
      if(await designedBuildStep(bot,task,g,noop)){rememberFittings(bot,g);return g;}
      g=JSON.parse(JSON.stringify(g));
    }
    assert.fail('the retrofit did not finish');
  };
  goal=await run(goal);
  assert.equal(goal.blueprint.blocks.length,2);
  const completed=await run(all);
  assert.equal(verifyHouse(bot,completed.blueprint).ok,true);
  const after=bot.buildRegistry.find(entry.id);
  assert.equal(after.name,'house');
  assert.deepEqual(after.bounds,entry.bounds);
  assert.equal(bot.buildRegistry.all().length,1);
  assert.equal(bot.blockAt(keepsake).name,'diamond_block');
  assert.equal(after.blueprint.blocks.filter(c=>c.material==='glass').length,2);
  assert.equal(after.blueprint.blocks.filter(c=>c.material==='torch').length,2);
  const count=clicks.length;
  await run({...all,blueprint:undefined,buildBatch:undefined,buildOwned:undefined});
  assert.equal(clicks.length,count,'asking again reuses the installed fittings');
});

test('a wall replacement by a player is kept and a blocked entrance is explained', () => {
  const {bot,set}=scene();
  const {houseBlueprint}=require('../src/objectives');
  const {planFittings}=require('../src/house-details');
  const blueprint=houseBlueprint(new Vec3(0,64,0),'oak_planks');
  for(const c of blueprint.blocks)set(point(c),c.material);
  const wall=new Vec3(-2,65,0), door=new Vec3(0,64,-2);
  set(wall,'chest');set(door,'diamond_block');
  const entry={blueprint,entrance:blueprint.entrance};
  const windows=planFittings(bot,entry,{parts:{window:2}});
  assert.ok(!windows.blueprint.blocks.some(p=>point(p).equals(wall)));
  assert.throws(()=>planFittings(bot,entry,{parts:{door:1}}),e=>e.needsPlayer&&/doorway/.test(e.message));
});

test('a saved house can clear its own blocked doorway before furnishing the bedroom', async () => {
  const {bot,set,stock}=scene(), goal=siteWithShell(bot,set,2);
  const entrance=point(goal.blueprint.entrance), upper=entrance.offset(0,1,0);
  const {entrancePassage,recordBuildPlacement}=require('../src/construction-access');
  assert.ok(entrancePassage(goal.blueprint).has([upper.x,upper.y,upper.z].join(',')));
  for(const p of [entrance,upper]) { set(p,'dirt');assert.ok(recordBuildPlacement(goal,bot.blockAt(p))); }
  stock.white_bed=2;
  assert.ok(standForWork(bot,{...upper,material:'dirt'}));
  const cleared=new Error('dug the obstruction');
  await assert.rejects(designedBuildStep(bot,task,goal,()=>{if ([entrance,upper].some(p=>bot.blockAt(p).name==='air'))throw cleared;}),e=>e===cleared);
});

test('a house asked for with no material is built of what is carried and the ground it stands on, a player\'s wall kept in it', async () => {
  const { bot, stock, chat, clicks, set } = scene();
  bot.buildRegistry = new (require('../src/builds').BuildRegistry)();
  let goal = { kind: 'build', starterBeds: 2, anyMaterial: true, buildAnchor: { x: 0, y: 64, z: 0 } };
  Object.assign(stock, { dirt: 40, cobblestone: 30 });
  const batchReady = new Error('new batch');
  let lastBatch, finished = false, theirs = [];
  for (let turn = 0; turn < 400 && !finished; turn++) {
    // A player lays three blocks of a wall the builder has not reached yet.
    if (goal.blueprint && !theirs.length) {
      theirs = goal.blueprint.blocks.filter(c => c.flexible && c.y === goal.blueprint.origin.y + 2 && bot.blockAt(point(c)).name === 'air').slice(0, 3);
      for (const c of theirs) set(point(c), 'stone_bricks');
    }
    const remaining = goal.buildBatch?.cells.filter(cell => !buildCellComplete(bot, cell));
    if (remaining?.length) assert.ok(remaining.some(cell => standForWork(bot, cell)), 'a reachable work face for ' + remaining.map(p => p.material + '@' + point(p)).join(', '));
    try {
      finished = await designedBuildStep(bot, task, goal, () => {
        if (goal.buildBatch && goal.buildBatch !== lastBatch) { lastBatch = goal.buildBatch; throw batchReady; }
      });
    } catch (err) {
      if (err !== batchReady) throw err;
      // The player drops what the batch lacks.
      for (const { item, count } of goal.buildBatch.outputs) stock[item] = Math.max(stock[item] || 0, count);
    }
    // A restart now and then: the batch comes back as copies of the plan's cells.
    if (turn % 7 === 6) { goal = JSON.parse(JSON.stringify(goal)); lastBatch = goal.buildBatch; }
  }
  assert.equal(finished, true);
  assert.deepEqual(verifyHouse(bot, goal.blueprint), { ok: true, missing: 0, obstructed: 0 });
  assert.ok(chat.some(line => line.includes('whatever blocks are quickest here')));
  const shell = goal.blueprint.blocks.filter(c => c.flexible), held = {};
  for (const c of shell) { const name = bot.blockAt(point(c)).name; held[name] = (held[name] || 0) + 1; }
  const floor = shell.filter(c => c.y === goal.blueprint.origin.y);
  assert.equal(floor.length, 56);
  // The grass floor is the floor: nothing dug or laid there.
  assert.ok(floor.every(c => bot.blockAt(point(c)).name === 'grass_block'));
  assert.ok(!clicks.some(c => floor.some(f => point(f).equals(c.foot))));
  // Every block carried went into the walls and the roof; the rest is the design's own, gathered.
  assert.equal(held.dirt, 40);
  assert.equal(held.cobblestone, 30);
  assert.equal(theirs.length, 3);
  assert.ok(theirs.every(c => bot.blockAt(point(c)).name === 'stone_bricks' && !clicks.some(k => point(c).equals(k.foot))));
  assert.deepEqual(Object.keys(held).sort(), ['cobblestone', 'dirt', 'grass_block', goal.shellNominal, 'stone_bricks'].sort());
  // The house as it stands is the builder's own building: no walk digs through its grass floor or the player's bricks.
  const { jevBuilt } = require('../src/home-base');
  assert.ok(jevBuilt(bot, bot.blockAt(point(floor[0]))));
  assert.ok(jevBuilt(bot, bot.blockAt(point(theirs[0]))));
  assert.ok(!jevBuilt(bot, bot.blockAt(new Vec3(12, 63, 12))));
  // Nor is it the next request's dirt: a search leaves its walls alone, as it does a village's.
  const built = require('../src/built'), wall = shell.find(c => bot.blockAt(point(c)).name === 'dirt');
  assert.ok(built.leftAlone(bot, { kind: 'obtain', item: 'dirt' }, point(wall)));
  assert.ok(built.leftAlone(bot, { kind: 'obtain', item: 'dirt' }, point(floor[0])));
  assert.ok(!built.leftAlone(bot, { kind: 'obtain', item: 'dirt' }, new Vec3(12, 63, 12)));
});

test('with nothing carried the shell is gathered as dirt from the open ground near the site', async () => {
  const { bot } = scene();
  const grass = registry.blocksByName.grass_block.id, dirt = registry.blocksByName.dirt.id, spruce = registry.blocksByName.spruce_log.id;
  const open = Array.from({ length: 20 }, (_, i) => new Vec3(10 + (i % 5), 63, -12 + Math.floor(i / 5)));
  bot.findBlocks = ({ matching }) => { const ids = [].concat(matching); return ids.includes(spruce) ? [new Vec3(10, 64, 8)] : ids.some(id => id === grass || id === dirt) ? open : []; };
  const goal = { kind: 'build', starterBeds: 2, anyMaterial: true, buildAnchor: { x: 0, y: 64, z: 0 } };
  const stop = new Error('first batch persisted');
  await assert.rejects(designedBuildStep(bot, task, goal, () => { if (goal.buildBatch) throw stop; }), e => e === stop);
  assert.equal(goal.shellSupply, 'dirt');
  const outputs = goal.buildBatch.outputs, items = outputs.map(o => o.item);
  // Dirt beside what is made of wood (the sofa's stairs): one plan gathers both.
  assert.ok(items.includes('dirt') && items.some(item => /_(?:door|stairs)$/.test(item)), JSON.stringify(outputs));
  const plan = catalogPlan(bot, outputs, undefined, {}, goal);
  assert.ok(plan.some(s => s.action === 'mine' && s.drops === 'dirt'), JSON.stringify(plan.map(s => [s.action, s.drops || s.item])));
});

// Every step of a build to its end, the player dropping what each batch lacks; the bot stands at a face of the
// lowest cell left first (a bed is laid from the cell behind its foot).
async function buildAll(bot, stock, goal) {
  const batchReady = new Error('new batch');
  let lastBatch, finished = false;
  for (let turn = 0; turn < 500 && !finished; turn++) {
    const remaining = goal.buildBatch?.cells.filter(cell => !buildCellComplete(bot, cell)).sort((a, b) => a.y - b.y);
    if (remaining?.length) assert.ok(remaining.some(cell => standForWork(bot, cell)), 'a reachable work face for ' + remaining.map(p => p.material + '@' + point(p)).join(', '));
    try {
      finished = await designedBuildStep(bot, task, goal, () => {
        if (goal.buildBatch && goal.buildBatch !== lastBatch) { lastBatch = goal.buildBatch; throw batchReady; }
      });
    } catch (err) {
      if (err !== batchReady) throw err;
      for (const { item, count } of goal.buildBatch.outputs) stock[item] = Math.max(stock[item] || 0, count);
    }
  }
  return finished;
}
const cellKey = p => `${p.x},${p.y},${p.z}`;

test('a room asked for by the house is added to it: a door through its wall, the room of whatever blocks, its notes grown by it', async () => {
  const { bot, stock, chat } = scene();
  bot.buildRegistry = new (require('../src/builds').BuildRegistry)();
  const house = { kind: 'build', starterBeds: 2, anyMaterial: true, buildAnchor: { x: 0, y: 64, z: 0 }, request: 'build a house', from: 'P' };
  Object.assign(stock, { dirt: 40, cobblestone: 30 });
  assert.equal(await buildAll(bot, stock, house), true);
  bot.buildRegistry.remember(house, { dimension: 'overworld', status: 'complete' });
  const [entry] = bot.buildRegistry.all('overworld');
  // Asked standing by the house: a room for that house, of no material named.
  const houses = require('../src/house-details'), text = 'add a bedroom to the house', speakerPosition = { x: 0, y: 64, z: -6 };
  const spec = houses.houseSpec(houses.houseRequest(text, registry), text, 'P',
    { registry, speakerPosition, builds: bot.buildRegistry.describe(bot, speakerPosition, 'overworld') });
  assert.deepEqual(spec.houseDetails, { target: entry.id, room: { bed: true } });
  assert.equal(spec.anyMaterial, true);
  assert.equal(spec.buildContinuation.mode, 'edit');
  const houseCells = new Set(house.blueprint.blocks.map(cellKey)), dug = [];
  const dig = bot.dig; bot.dig = async block => { dug.push(cellKey(block.position)); return dig(block); };
  Object.assign(stock, { dirt: 60, stone_pickaxe: 1 });
  const room = structuredClone(spec);
  // Planned, the room is the house's at once: its grass floor is no dirt for the taking while it is built.
  assert.equal(await designedBuildStep(bot, task, room, noop), false);
  const floor = room.blueprint.blocks.find(c => c.y === room.blueprint.bounds.min.y && c.flexible);
  assert.equal(bot.blockAt(point(floor)).name, 'grass_block');
  assert.ok(require('../src/home-base').jevBuilt(bot, bot.blockAt(point(floor))));
  assert.equal(bot.buildRegistry.all('overworld').length, 1);
  assert.equal(await buildAll(bot, stock, room), true);
  assert.ok(chat.some(line => /^I'll add a room on the \w+ side of starter house for 2, with a door through to it at /.test(line)), chat.join(' | '));
  // The door goes where two blocks of its wall were: those two came out, and nothing else of the house.
  const door = room.blueprint.blocks.filter(c => /_door$/.test(c.material));
  assert.equal(door.length, 2);
  assert.ok(door.every(c => houseCells.has(cellKey(c)) && isDoor(bot.blockAt(point(c)).name)));
  assert.deepEqual(dug.filter(d => houseCells.has(d)).sort(), door.map(cellKey).sort());
  const doorway = new Set(door.map(cellKey));
  assert.ok(house.blueprint.blocks.filter(c => !doorway.has(cellKey(c))).every(c => buildCellComplete(bot, c)));
  assert.ok(room.blueprint.blocks.some(c => isBed(c.material) && isBed(bot.blockAt(point(c)).name)));
  assert.deepEqual(verifyHouse(bot, room.blueprint), { ok: true, missing: 0, obstructed: 0 });
  // The house's notes take the room in: one building, grown by it, its old drawing dropped.
  houses.rememberFittings(bot, room);
  const all = bot.buildRegistry.all('overworld'), merged = all[0];
  assert.equal(all.length, 1);
  assert.equal(merged.id, entry.id);
  assert.equal(merged.design, undefined);
  for (const axis of ['x', 'z']) assert.ok(merged.bounds.min[axis] <= room.blueprint.bounds.min[axis] && merged.bounds.max[axis] >= room.blueprint.bounds.max[axis]);
  assert.deepEqual(verifyHouse(bot, merged.blueprint), { ok: true, missing: 0, obstructed: 0 });
  // Its dirt roof is the house's own: no lid for a bot inside it to dig through to go for logs.
  const { lidExit } = require('../src/surface'), top = room.blueprint.bounds.max.y;
  const spot = room.blueprint.empty.find(c => c.y === top - 2 && bot.blockAt(new Vec3(c.x, top, c.z)).name === 'dirt');
  bot.entity.position = point(spot).offset(.5, 0, .5);
  assert.deepEqual(lidExit(bot), []);
  const notes = bot.buildRegistry; bot.buildRegistry = null;
  assert.deepEqual(lidExit(bot).map(String), [String(new Vec3(spot.x, top, spot.z))]);
  bot.buildRegistry = notes;
});

// A player's house: cobblestone walls, a plank roof, its way in on the north side; the player inside it, looking at
// its east wall.
function theirHouse() {
  const { bot, stock, chat, set } = scene();
  bot.buildRegistry = new (require('../src/builds').BuildRegistry)();
  const theirs = new Map();
  const lay = (p, name) => { set(p, name); theirs.set(cellKey(p), name); };
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    if (Math.abs(x) === 3 || Math.abs(z) === 3) for (const y of [64, 65]) if (x || z !== -3) lay(new Vec3(x, y, z), 'cobblestone');
    lay(new Vec3(x, 66, z), 'oak_planks');
  }
  bot.entity.position = new Vec3(0.5, 64, 0.5);
  bot.players.P = { entity: { position: new Vec3(0.5, 64, 0.5), yaw: -Math.PI / 2, pitch: 0, height: 1.8, eyeHeight: 1.62 } };
  bot.world.raycast = () => ({ position: new Vec3(3, 65, 0), name: 'cobblestone' });
  return { bot, stock, chat, set, theirs };
}
// The room asked for, and planned on the wall they look at.
async function roomPlanned(bot, text) {
  const houses = require('../src/house-details');
  const spec = houses.houseSpec(houses.houseRequest(text, registry), text, 'P', { registry, speakerPosition: { x: 0, y: 64, z: 0 }, builds: [] });
  assert.deepEqual(spec.addRoom, { bed: false });
  assert.equal(spec.anyMaterial, true);
  const goal = structuredClone(spec);
  assert.equal(await designedBuildStep(bot, task, goal, noop), false);
  assert.deepEqual(goal.roomWall, { x: 3, y: 65, z: 0 });
  // In the notes from the start, unfinished, and by its own name.
  assert.deepEqual(bot.buildRegistry.all('overworld').map(e => [e.name, e.status]), [['room', 'unfinished']]);
  assert.deepEqual(goal.addRoom, { bed: false });
  // The wall is read once and kept: the world's own sight lines from here on.
  delete bot.world.raycast;
  return goal;
}
const ROOM_DOOR = ['3,64,0', '3,65,0'];
function roomBuilt(bot, theirs, goal) {
  for (const [k, name] of theirs) if (!ROOM_DOOR.includes(k)) assert.equal(bot.blockAt(new Vec3(...k.split(',').map(Number))).name, name, k);
  assert.ok(isDoor(bot.blockAt(new Vec3(3, 64, 0)).name));
  assert.deepEqual(verifyHouse(bot, goal.blueprint), { ok: true, missing: 0, obstructed: 0 });
  // The room is the bot's own building, kept in its notes without the player's wall: of what was theirs, only the
  // doorway, where its door stands now.
  bot.buildRegistry.remember(goal, { dimension: 'overworld', status: 'complete' });
  const entries = bot.buildRegistry.all('overworld');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'room');
  assert.deepEqual(entries[0].blueprint.blocks.filter(c => theirs.has(cellKey(c))).map(cellKey).sort(), ROOM_DOOR);
}

test("a room for a player's house goes on the wall they look at, its doorway cut through their wall, and the rest of their house left alone", async () => {
  const { bot, stock, chat, theirs } = theirHouse();
  // A roof the bot did not lay is no lid to dig through.
  const { lidExit } = require('../src/surface');
  assert.deepEqual(lidExit(bot), []);
  bot._laid = new Map([['0,66,0', { name: 'oak_planks' }]]);
  assert.deepEqual(lidExit(bot).map(String), [String(new Vec3(0, 66, 0))]);
  delete bot._laid;
  const goal = await roomPlanned(bot, 'add a room to my house');
  assert.ok(!goal.keepWalls);
  assert.ok(chat.some(line => line.includes('on the east side of your house') && line.includes('That wall is yours: I\'ll cut the doorway through it, unless you say "Jev, don\'t cut my wall".')), chat.join(' | '));
  assert.deepEqual(goal.blueprint.cut.map(cellKey).sort(), ROOM_DOOR);
  const dug = [], dig = bot.dig;
  bot.dig = async block => { dug.push(cellKey(block.position)); return dig(block); };
  // Cobblestone is cut with a pickaxe.
  Object.assign(stock, { dirt: 60, stone_pickaxe: 1 });
  assert.equal(await buildAll(bot, stock, goal), true);
  assert.deepEqual([...new Set(dug.filter(d => theirs.has(d)))].sort(), ROOM_DOOR);
  roomBuilt(bot, theirs, goal);
});

test("glass where a room's door goes through a player's wall is theirs to move: Jev asks, and cuts nothing", async () => {
  const { bot, chat, set } = theirHouse();
  set(new Vec3(3, 65, 0), 'glass');
  const goal = await roomPlanned(bot, 'add a room to my house');
  assert.equal(goal.blueprint.cut, undefined);
  assert.ok(chat.some(line => line.includes('on the east side of your house') && line.includes("I'll wait for you to break the blocks there")), chat.join(' | '));
  const asked = await designedBuildStep(bot, task, goal, noop).then(() => null, e => e);
  assert.ok(asked?.waitOn, String(asked));
  assert.match(require('../src/speech').friendlyProblem(asked), /(cobblestone|glass) at 3, 6[45], 0 in the doorway/);
});

test("told not to cut their wall, with the request or after, Jev waits for the player to open the room's doorway", async () => {
  for (const when of ['with the request', 'after']) {
    const { bot, stock, chat, set, theirs } = theirHouse();
    const goal = await roomPlanned(bot, when === 'after' ? 'add a room to my house' : "add a room to my house but don't cut my wall");
    if (when === 'after') assert.equal(require('../src/player-build').leaveDoorway(bot, goal), "All right, I won't cut your wall. Break the blocks at 3, 64, 0 when you're ready, and I'll put the door in.");
    else assert.ok(chat.some(line => line.includes('on the east side of your house') && line.includes("I'll wait for you to break the blocks there")), chat.join(' | '));
    assert.equal(goal.keepWalls, true);
    // Their blocks where the door goes: they are asked to break them, and nothing is built before.
    const asked = await designedBuildStep(bot, task, goal, noop).then(() => null, e => e);
    assert.ok(asked?.waitOn, when + ': ' + String(asked));
    assert.deepEqual([asked.waitOn.x, asked.waitOn.z], [3, 0]);
    assert.match(require('../src/speech').friendlyProblem(asked), /cobblestone at 3, 6[45], 0 in the doorway/);
    assert.ok(goal.blueprint.blocks.every(c => c.companion || !buildCellComplete(bot, c) || c.y === 63));
    set(new Vec3(3, 64, 0), 'air'); set(new Vec3(3, 65, 0), 'air');
    const dug = [], dig = bot.dig;
    bot.dig = async block => { dug.push(cellKey(block.position)); return dig(block); };
    Object.assign(stock, { dirt: 60 });
    assert.equal(await buildAll(bot, stock, goal), true);
    assert.deepEqual(dug.filter(d => theirs.has(d)), [], when);
    roomBuilt(bot, theirs, goal);
  }
});
