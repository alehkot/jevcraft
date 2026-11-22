'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const { interpret } = require('../src/objectives');
const { companionAction, climbLadder, ladderColumn } = require('../src/companion-actions');
const { propagatedLight, darkCells, torchPlan } = require('../src/torches');
const { validateSchematic } = require('../src/designer');
const { orderBuildCells } = require('../src/build-batch');
const { regionProperties, placementFacing, buildCellComplete } = require('../src/build-blocks');
const { Task } = require('../src/skills');
const vec = (x, y, z) => new Vec3(x, y, z);
const air = { name: 'air', boundingBox: 'empty', transparent: true },
  stone = { name: 'stone', boundingBox: 'block', transparent: false };
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;

test('explicit boat, ladder and lighting requests get executable goals without consulting a model', async () => {
  for (const [ask, kind] of [
    ['come to me by boat', 'come'],
    ['follow me in a boat', 'follow'],
    ['climb down the nearest ladder', 'climb_ladder'],
    ['light up this area', 'light_area'],
    ['place torches around here', 'light_area']
  ]) {
    const g = await interpret(null, 'Jev ' + ask, 'Alex', 'Jev', { registry });
    assert.equal(g.kind, kind);
    if (kind === 'come' || kind === 'follow') {
      assert.equal(g.target, 'Alex');
      assert.equal(g.byBoat, true);
    }
    if (kind === 'climb_ladder') assert.equal(g.direction, 'down');
  }
  for (const negated of [
    'do not use a boat',
    'do not climb the ladder',
    'do not light this area',
    'are you able to climb down the ladder'
  ])
    assert.equal(companionAction(negated), null);
});

test('light reaches around a corner, stays outside a sealed room and ignores unloaded space', () => {
  const source = { position: vec(-2, 1, 0), emission: 14 },
    cells = [vec(2, 1, 0), vec(3, 1, 0)];
  let open = false;
  const bot = {
    blockAt: (p) =>
      Math.abs(p.x) > 9 || Math.abs(p.z) > 9
        ? null
        : (p.x === 0 && !(open && p.z === 2 && p.y === 1)) || p.y <= 0 || p.y >= 4
          ? stone
          : air
  };
  assert.equal(propagatedLight(bot, cells, [source]).has('2,1,0'), false);
  assert.equal(darkCells(bot, cells, [source]).length, 2);
  open = true;
  assert.equal(propagatedLight(bot, cells, [source]).get('2,1,0'), 6);
  assert.equal(darkCells(bot, cells, [source]).length, 0);
  open = false;
  assert.equal(torchPlan([source.position, ...cells], 3, bot).length, 2);
  assert.deepEqual(darkCells(bot, [vec(11, 1, 0)], []), []);
});

test('ladder schematics require a full backing wall and order its blocks before each rung', () => {
  const props = { facing: 'north', half: null };
  const source = {
    name: 'ladder',
    description: 'ladder wall',
    size: [1, 4, 2],
    palette: ['stone', 'ladder'],
    entrance: null,
    regions: [
      { from: [0, 0, 0], to: [0, 0, 1], block: 'stone' },
      { from: [0, 1, 1], to: [0, 3, 1], block: 'stone' },
      { from: [0, 1, 0], to: [0, 3, 0], block: 'ladder', properties: props }
    ]
  };
  const d = validateSchematic(source, registry);
  assert.equal(d.materials.ladder, 3);
  assert.deepEqual(regionProperties('ladder', props), { facing: 'north', waterlogged: false });
  assert.equal(placementFacing('ladder', 'north'), undefined);
  const bot = { blockAt: (p) => (p.y < 0 ? stone : air) };
  const ordered = orderBuildCells(bot, d.blocks);
  for (const c of d.blocks.filter((c) => c.material === 'ladder'))
    assert(ordered.findIndex((p) => same(p, { ...c, z: 1 })) < ordered.indexOf(c));
  assert.throws(
    () => validateSchematic({ ...source, regions: [source.regions[0], source.regions[2]] }, registry),
    /supporting wall/
  );
  assert.equal(
    buildCellComplete(
      { blockAt: () => stone },
      { x: 0, y: 1, z: 0, material: 'ladder', properties: regionProperties('ladder', props) }
    ),
    false
  );
});

test('a climb targets a contiguous column with safe landings and releases the controls on stop', async () => {
  const rung = { name: 'ladder', boundingBox: 'block', getProperties: () => ({ facing: 'north' }) };
  const bottom = vec(0, 1, 0);
  let safe = true,
    cleared = 0;
  const bot = {
    registry,
    entity: { position: vec(0.5, 1, -0.5), onGround: true },
    findBlocks: () => [bottom, bottom.offset(0, 1, 0)],
    blockAt: (p) =>
      p.y === 0 || (p.z === 1 && p.x === 0 && p.y >= 1 && p.y <= 3)
        ? stone
        : p.x === 0 && p.z === 0 && p.y >= 1 && p.y <= 3
          ? rung
          : !safe && p.y === 4 && p.z === 1
            ? stone
            : air,
    look: async () => {},
    setControlState() {},
    clearControlStates() {
      cleared++;
    }
  };
  const saved = JSON.parse(JSON.stringify(ladderColumn(bot, bottom, 'up')));
  assert.equal(saved.top.y, 3);
  safe = false;
  assert.equal(ladderColumn(bot, bottom, 'down'), undefined);
  await assert.rejects(climbLadder(bot, new Task('resume'), { direction: 'down', ladder: saved },
    () => {}, () => assert.fail('navigated toward an unsafe landing')), /landing has changed/);
  safe = true;
  const task = new Task('ladder');
  bot.waitForTicks = async () => task.cancel();
  await assert.rejects(
    climbLadder(
      bot,
      task,
      { direction: 'up' },
      () => {},
      async () => {}
    ),
    { name: 'Cancelled' }
  );
  assert.equal(cleared, 1);
});

test('a room lighting request near a wall stays on that side of it', () => {
  const { connectedGround } = require('../src/torches');
  const bot = { blockAt: p => p.y <= 0 || p.x === 0 && p.y <= 4 ? stone : air };
  const room = connectedGround(bot, vec(1, 1, 0), 4);
  assert.ok(room.length >= 15);
  assert.ok(room.every(p => p.x > 0 && p.y === 1));
});
