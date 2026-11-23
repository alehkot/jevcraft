'use strict';
// Building around a player's blocks on the site (src/build-around.js, asked for 2026-11-22): what must be asked about
// (the doorway, a bed's place, the way in, a soft floor under a door or bed, the only walk to the beds), what is left
// where it stands, and what is taken into the building when nothing else is left to do.
//
//   node test/build-around.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const around = require('../src/build-around');

const key = p => `${p.x},${p.y},${p.z}`;
// A one-wide hall, x 1..3 and z 0..6: walls at x 1 and 3 and z 0 and 6, a floor at y 0, a roof at y 3; the door in
// the south wall at (2, 1, 0); the bed at the far end, foot (2, 1, 4) and head (2, 1, 5); a torch on the west wall.
function hall() {
  const blocks = [], empty = [];
  for (let x = 1; x <= 3; x++) for (let z = 0; z <= 6; z++) {
    blocks.push({ x, y: 0, z, material: 'oak_planks' }, { x, y: 3, z, material: 'oak_planks' });
    for (let y = 1; y <= 2; y++) {
      const wall = x !== 2 || z === 0 || z === 6;
      if (x === 2 && z === 0) blocks.push({ x, y, z, material: 'oak_door', properties: { half: y === 1 ? 'lower' : 'upper' } });
      else if (wall) blocks.push({ x, y, z, material: 'oak_planks' });
      else if (y === 1 && (z === 4 || z === 5)) blocks.push({ x, y, z, material: 'red_bed', properties: { part: z === 4 ? 'foot' : 'head' } });
      else empty.push({ x, y, z });
    }
  }
  blocks.push({ x: 2, y: 2, z: 2, material: 'wall_torch', properties: { facing: 'east' } });
  return { origin: { x: 1, y: 0, z: 0 }, entrance: { x: 2, y: 1, z: -1 }, blocks, empty: empty.filter(e => !(e.x === 2 && e.y === 2 && e.z === 2)),
    bounds: { min: { x: 1, y: 0, z: 0 }, max: { x: 3, y: 3, z: 6 } } };
}
const SOLID = new Set(['crafting_table', 'cobblestone', 'oak_planks', 'player_head']);
function site(placed = {}) {
  const world = new Map(Object.entries(placed));
  const bot = { blockAt: p => { const name = world.get(key(p)) || 'air'; return { name, position: p, boundingBox: SOLID.has(name) ? 'block' : 'empty', stateId: name }; } };
  return { bot, world, goal: { blueprint: hall(), buildOwned: {} } };
}
// Not the bot's to clear: anything but air (no initial blocks, nothing owned).
const canClear = (bp, owned, block) => !!block && (block.name === 'air' || owned?.[key(block.position)] === block.stateId);
const cell = (x, y, z) => ({ x, y, z });

test('what each needed spot is for: the doorway, the way in, a bed, the floor under them', () => {
  const { always, floor } = around.needs(hall());
  assert.equal(always.get('2,1,0'), 'the doorway'); assert.equal(always.get('2,2,0'), 'the doorway');
  assert.equal(always.get('2,1,1'), 'the way in'); assert.equal(always.get('2,2,1'), 'the way in');
  assert.equal(always.get('2,1,-1'), 'the way in'); assert.equal(always.get('2,2,-1'), 'the way in', 'head room outside the door');
  assert.equal(always.get('2,1,4'), "a bed's place");
  assert.equal(floor.get('2,0,4'), 'the floor under a bed'); assert.equal(floor.get('2,0,0'), 'the floor under the door');
  assert.equal(always.has('1,1,2'), false, 'a wall cell is not needed clear');
});

test('a crafting table in a wall, or a torch in the hall, is built around; in the doorway or the way in it is asked about', () => {
  const s = site({ '1,1,2': 'crafting_table', '2,1,2': 'torch' });
  assert.deepEqual(around.classify(s.bot, s.goal, [cell(1, 1, 2), cell(2, 1, 2), cell(1, 1, 2)]), { ask: null, defer: [cell(1, 1, 2), cell(2, 1, 2)] });
  const door = site({ '2,1,0': 'crafting_table' });
  assert.deepEqual(around.classify(door.bot, door.goal, [cell(2, 1, 0)]).ask, { ...cell(2, 1, 0), why: 'the doorway' });
  const inWay = site({ '2,2,1': 'torch' });
  assert.equal(around.classify(inWay.bot, inWay.goal, [cell(2, 2, 1)]).ask.why, 'the way in');
});

test('under a bed: a full block is floor enough; a torch or a head is not', () => {
  const stone = site({ '2,0,4': 'cobblestone' });
  assert.equal(around.classify(stone.bot, stone.goal, [cell(2, 0, 4)]).ask, null);
  for (const name of ['torch', 'player_head']) {
    const soft = site({ '2,0,4': name });
    assert.equal(around.classify(soft.bot, soft.goal, [cell(2, 0, 4)]).ask?.why, 'the floor under a bed', name);
  }
});

test('a solid block in the only walk from the door to the bed is asked about; a torch there is not', () => {
  const block = site({ '2,1,3': 'crafting_table' });
  assert.equal(around.classify(block.bot, block.goal, [cell(2, 1, 3)]).ask?.why, 'the only way to the beds');
  const torch = site({ '2,1,3': 'torch' });
  assert.equal(around.classify(torch.bot, torch.goal, [cell(2, 1, 3)]).ask, null);
  assert.ok(around.bedsReached(hall()).has('2,1,3'), 'the walk reaches the bed');
});

test('left for now, said once; taken into the building at the end with what would hang on it; one gone is built as planned', () => {
  const s = site({ '1,2,2': 'dandelion', '3,1,3': 'crafting_table', '3,2,5': 'player_head' });
  s.goal.buildOwned = { '1,2,2': 'oak_planks' };
  s.goal.buildBatch = { cells: [] };
  assert.deepEqual(around.note(s.goal, s.bot, [cell(1, 2, 2), cell(3, 1, 3), cell(3, 2, 5)]), ['dandelion', 'crafting_table', 'player_head']);
  assert.deepEqual(around.note(s.goal, s.bot, [cell(1, 2, 2)]), [], 'said once');
  s.world.delete('3,2,5');   // the grave looted
  assert.deepEqual([...around.deferredKeys(s.bot, s.goal, canClear)].sort(), ['1,2,2', '3,1,3']);
  const names = around.accept(s.bot, s.goal, canClear);
  assert.deepEqual(names.sort(), ['crafting_table', 'dandelion']);
  const bp = s.goal.blueprint, has = k => bp.blocks.some(c => key(c) === k);
  assert.equal(has('1,2,2'), false); assert.equal(has('3,1,3'), false);
  assert.equal(has('3,2,5'), true, 'the looted grave\'s cell is built as planned');
  assert.equal(has('2,2,2'), false, 'the torch that would hang on the flower is left out');
  assert.deepEqual(bp.preserved.map(key).sort(), ['1,2,2', '3,1,3']);
  assert.equal(s.goal.buildOwned['1,2,2'], undefined);
  assert.equal(s.goal.deferredCells, undefined); assert.equal(s.goal.buildBatch, undefined);
  assert.deepEqual(around.accept(s.bot, s.goal, canClear), [], 'nothing more');
  assert.equal(around.said(['crafting_table', 'player_head', 'player_head']), 'crafting table and 2 player heads');
  assert.equal(around.said(['oak_log']), 'oak log');
});
