'use strict';
// A house asked for with no material named (any-material.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const Block = require('prismarine-block')(registry);
const any = require('../src/any-material');
const { matchesBuildBlock } = require('../src/build-blocks');
const { houseRequest } = require('../src/house-details');
const { interpret } = require('../src/objectives');

const block = name => Block.fromStateId(registry.blocksByName[name].defaultState, 0);
const carrying = (list, open = []) => ({
  registry, entity: { position: new Vec3(0, 64, 0) }, blockAt: () => null,
  inventory: { items: () => Object.entries(list).map(([name, count]) => ({ name, count })) },
  // Twenty open blocks of each kind named in `open`, none of the others.
  findBlocks: ({ matching }) => [].concat(matching).some(id => open.includes(registry.blocks[id].name)) ? Array.from({ length: 20 }, (_, i) => new Vec3(i, 60, 0)) : [],
});
const shellOf = n => Array.from({ length: n }, (_, i) => ({ x: i % 5, y: 64 + Math.floor(i / 5), z: 0, material: 'oak_planks', flexible: true }));
const tally = cells => cells.reduce((t, c) => ({ ...t, [c.material]: (t[c.material] || 0) + 1 }), {});

test('a house said with no material is built of any blocks, one said with a material is not', () => {
  for (const text of ['build a house', 'build a starter house for two people', 'build a small house', 'build us a cottage', 'build a cozy hut for three']) {
    assert.equal(houseRequest(text, registry)?.anyMaterial, true, text);
  }
  for (const [text, material] of [['build a wooden house', undefined], ['build a small cobblestone house', 'cobblestone'],
    ['build a spruce house', 'spruce_planks'], ['build a small oak plank house', 'oak_planks']]) {
    const spec = houseRequest(text, registry);
    assert.equal(spec.anyMaterial, undefined, text);
    assert.equal(spec.material, material, text);
  }
});

test("the model's local wood is any blocks only where the words name no material", async () => {
  const client = material => ({ systemOne: async () => ({ usage: null, answers: { objective: { choice: 'build', confidence: 0.99 },
    interaction: { choice: 'request', confidence: 0.99 }, material: { choice: material }, starter_house: { choice: 'two' } } }) });
  const context = { players: ['Alex'], speakerPosition: { x: 0, y: 64, z: 0 } };
  const plain = await interpret(client('local_wood'), 'Jev build us a shelter for the night', 'Alex', 'Jev', context);
  assert.equal(plain.kind, 'build');
  assert.equal(plain.starterBeds, 2);
  assert.equal(plain.anyMaterial, true);
  assert.equal(plain.material, undefined);
  const wooden = await interpret(client('local_wood'), 'Jev build us a wooden shelter', 'Alex', 'Jev', context);
  assert.equal(wooden.anyMaterial, undefined);
  const stone = await interpret(client('cobblestone'), 'Jev build us a stone shelter', 'Alex', 'Jev', context);
  assert.equal(stone.material, 'cobblestone');
  assert.equal(stone.anyMaterial, undefined);
});

test('a shell cell takes any sound full block, and nothing that falls, decays or is a thing of its own', () => {
  const cell = { x: 0, y: 64, z: 0, material: 'oak_planks', flexible: true };
  for (const name of ['dirt', 'grass_block', 'cobblestone', 'stone', 'oak_planks', 'spruce_log', 'stone_bricks', 'glass', 'white_wool', 'terracotta']) {
    assert.equal(matchesBuildBlock(block(name), cell), true, name);
  }
  for (const name of ['sand', 'gravel', 'oak_leaves', 'torch', 'oak_slab', 'oak_stairs', 'crafting_table', 'furnace', 'chest', 'water', 'air',
    'iron_ore', 'short_grass', 'magma_block', 'ice']) {
    assert.equal(matchesBuildBlock(block(name), cell), false, name);
  }
  assert.equal(matchesBuildBlock(null, cell), false);
  assert.equal(matchesBuildBlock(block('dirt'), { ...cell, flexible: undefined }), false);
});

test('only the plain shell is marked, once, and the design keeps its own block as the last resort', () => {
  const p = (material, more = {}) => ({ x: 0, y: 64, z: 0, material, ...more });
  const goal = { blueprint: { blocks: [p('oak_planks'), p('oak_planks'), p('cobblestone'), p('oak_planks', { properties: {} }), p('glass'), p('torch'),
    p('oak_door', { properties: { facing: 'south', half: 'lower' } }), p('oak_stairs', { properties: { facing: 'north', half: 'bottom' } }),
    p('white_bed', { properties: { facing: 'south', part: 'foot' } }), p('chest', { properties: { facing: 'south' } }), p('oak_planks', { companion: true })] } };
  assert.equal(any.markShell(goal), 4);
  assert.deepEqual(goal.blueprint.blocks.map(c => !!c.flexible), [true, true, true, true, false, false, false, false, false, false, false]);
  assert.equal(goal.shellNominal, 'oak_planks');
  assert.equal(any.markShell(goal), 0);
});

test('the pack goes into the shell cheapest first, the planks only past what the furniture needs', () => {
  assert.deepEqual([...any.carriedFiller(carrying({ oak_planks: 40, cobblestone: 5, dirt: 3, glass: 4, white_wool: 9 }))],
    [['dirt', 3], ['cobblestone', 5], ['oak_planks', 40 - any.PLANKS_KEPT]]);
  // Logs carried make the furniture's planks: fewer planks are kept.
  assert.deepEqual([...any.carriedFiller(carrying({ oak_planks: 40, oak_log: 6 }))], [['oak_planks', 40 - (any.PLANKS_KEPT - 24)]]);
  assert.deepEqual([...any.carriedFiller(carrying({ oak_planks: 20 }))], []);
  const cells = shellOf(20), goal = { blueprint: { origin: { x: 0, y: 64, z: 0 }, blocks: cells }, shellNominal: 'oak_planks' };
  const pack = { oak_planks: 40, cobblestone: 5, dirt: 3 };
  assert.equal(any.paint(carrying(pack), goal, cells), 8);
  // Lowest first: the floor gets the dirt, then the cobblestone, then the planks spared, then what is gathered.
  assert.deepEqual(cells.map(c => c.material), [...Array(3).fill('dirt'), ...Array(5).fill('cobblestone'), ...Array(12).fill('oak_planks')]);
  assert.equal(goal.shellSupply, 'oak_planks');
  assert.equal(any.paint(carrying(pack), goal, cells), 0);
  // A player drops cobblestone: it takes the cells still to be gathered for, and the rest stay as they were.
  assert.equal(any.paint(carrying({ ...pack, cobblestone: 25 }), goal, cells), 8);
  assert.deepEqual(tally(cells), { dirt: 3, cobblestone: 13, oak_planks: 4 });
});

test('what is gathered is chosen once for the building: cobblestone with a stone pickaxe and open stone, else dirt', () => {
  const fresh = () => ({ blueprint: { origin: { x: 0, y: 64, z: 0 }, blocks: [] }, shellNominal: 'spruce_planks' });
  let goal = fresh();
  assert.equal(any.supplyFor(carrying({ stone_pickaxe: 1 }, ['stone', 'grass_block']), goal), 'cobblestone');
  assert.equal(any.supplyFor(carrying({ stone_pickaxe: 1 }, ['grass_block']), goal), 'cobblestone', 'kept for the building');
  assert.equal(any.supplyFor(carrying({}, ['stone', 'grass_block']), goal), 'dirt', 'chosen again with no pickaxe carried');
  assert.equal(any.supplyFor(carrying({ wooden_pickaxe: 1 }, ['stone', 'grass_block']), fresh()), 'dirt');
  assert.equal(any.supplyFor(carrying({ stone_pickaxe: 1, wooden_shovel: 1 }, ['stone', 'grass_block']), fresh()), 'dirt');
  assert.equal(any.supplyFor(carrying({ stone_pickaxe: 1 }, ['sandstone']), fresh()), 'sandstone');
  assert.equal(any.supplyFor(carrying({}, []), fresh()), 'spruce_planks', 'the design\'s own where nothing else is in reach');
});

test('a batch painted again after a restart paints the plan\'s own cells with it', () => {
  const goal = { blueprint: { origin: { x: 0, y: 64, z: 0 }, blocks: shellOf(16) }, shellNominal: 'oak_planks' };
  any.paint(carrying({}), goal, goal.blueprint.blocks);
  goal.buildBatch = { cells: goal.blueprint.blocks.slice(0, 8), phase: 'gather' };
  const saved = JSON.parse(JSON.stringify(goal));
  assert.equal(any.repaintBatch(carrying({ dirt: 8 }), saved, saved.buildBatch), 8);
  assert.deepEqual(saved.buildBatch.cells.map(c => c.material), Array(8).fill('dirt'));
  assert.deepEqual(saved.blueprint.blocks.slice(0, 8).map(c => c.material), Array(8).fill('dirt'));
  assert.deepEqual(saved.blueprint.blocks.slice(8).map(c => c.material), Array(8).fill('oak_planks'));
  assert.deepEqual(saved.buildBatch.outputs, [{ item: 'dirt', count: 8 }]);
  assert.equal(any.repaintBatch(carrying({ dirt: 8 }), saved, saved.buildBatch), 0);
});
