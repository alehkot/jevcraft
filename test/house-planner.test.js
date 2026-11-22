'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('26.1');
const { designBuilding, validateSchematic } = require('../src/designer');
const { designStarterHouse, checkStarterDesign } = require('../src/starter-house');
const { drawingForEdit } = require('../src/house-details');
const { houseBlueprint, interpret } = require('../src/objectives');
const { designedBuildStep } = require('../src/work');
const { Task } = require('../src/skills');
const { starterHouse, useAvailableBed } = require('../src/starter-house');

function landscape(biome) {
  const sand = biome === 'desert';
  return Object.assign(new EventEmitter(), {
    registry,
    game: { gameMode: 'survival', dimension: 'overworld' },
    entity: { position: new Vec3(5, 65, 5) },
    inventory: { items: () => [{ name: 'spruce_planks', count: 20 }] },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    oxygenLevel: 20,
    chat() {},
    blockAt(p) {
      const surface = p.x < 0 ? 63 : 64;
      const name = p.y > surface ? (p.z > 15 && p.y === surface + 1 ? 'water' : 'air') : sand ? 'sand' : 'grass_block';
      return {
        name,
        biome: { name: biome },
        position: p.floored(),
        boundingBox: ['air', 'water'].includes(name) ? 'empty' : 'block'
      };
    },
    findBlocks({ matching }) {
      return sand && [].concat(matching).includes(registry.blocksByName.sand.id) ? [new Vec3(3, 64, 4)] : [];
    }
  });
}
const reply = (source) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(source) }, finish_reason: 'stop' }] })
});

test('the designer receives the actual requested site, biome, slopes, water and inventory', async () => {
  for (const [biome, material] of [
    ['snowy_taiga', 'spruce_planks'],
    ['desert', 'sandstone']
  ]) {
    const bot = landscape(biome),
      anchor = { x: 13, y: 65, z: 3 };
    const starter = { sleepers: 3, source: designStarterHouse(bot, { starterBeds: 3, buildAnchor: anchor }).source };
    assert.ok(starter.source.palette.includes(material));
    const draw = await designBuilding(bot, new Task('design'), 'Build a three-person house here', {
      planner: { provider: 'guide', model: 'gpt-6-luna', apiKey: 'fixture', url: 'https://fixture.invalid' },
      starter,
      anchor,
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://fixture.invalid');
        const body = JSON.parse(options.body),
          { world } = JSON.parse(body.messages.at(-1).content);
        assert.equal(body.model, 'gpt-6-luna');
        assert.equal(world.biome, biome);
        assert.deepEqual(world.position, anchor);
        assert.deepEqual(world.requestedAnchor, anchor);
        assert.deepEqual(world.observedFluids, ['water']);
        assert.ok(world.terrain.fluidSamples.some((p) => p.fluid === 'water' && Number.isFinite(p.dx)));
        assert.ok(new Set(world.terrain.heights.flat()).size > 1);
        assert.ok(JSON.stringify(world).includes('spruce_planks'));
        return reply(starter.source);
      }
    });
    assert.equal(draw.model, 'gpt-6-luna');
    assert.equal(draw.materials.white_bed, 3);
    assert.ok(draw.materials[material] > 100);
    checkStarterDesign(draw, starter);
    const explicit = designStarterHouse(bot, { starterBeds: 2, material: 'dark_oak_planks', buildAnchor: anchor });
    assert.ok(explicit.materials.dark_oak_planks > 100);
  }
});

test('the exterior door must lead through a standing aisle to each furnished room', () => {
  const source = () => starterHouse(2, 'oak_planks', 'oak', ['white_bed', 'white_bed']);
  const check = drawing => checkStarterDesign(validateSchematic(drawing, registry), { sleepers: 2 });
  check(source());
  for (const [from, to, block] of [
    [[3,1,1], [3,2,1], 'oak_planks'], [[3,2,1], [3,2,1], 'oak_planks'], [[3,0,1], [3,0,1], 'air']
  ]) {
    const drawing = source();
    drawing.regions.push({ from, to, block });
    assert.throws(() => check(drawing));
  }
});

test('a previously approved inaccessible house is repaired before its first block', async () => {
  const bot = landscape('snowy_taiga');
  const reference = designStarterHouse(bot, { starterBeds: 2 });
  const saved = structuredClone(reference.source);
  saved.regions.push({ from: [3,1,1], to: [3,2,1], block: 'spruce_planks' });
  const goal = { kind: 'build', starterBeds: 2, designAttempts: 4, starterReference: { sleepers: 2, source: reference.source },
    design: { ...validateSchematic(saved, registry), backend: 'guide' }, designReview: { accepted: true } };
  await designedBuildStep(bot, new Task('resume house'), goal, () => {});
  assert.equal(goal.blueprint, undefined);
  assert.equal(goal.design, undefined);
  assert.equal(goal.designReview.accepted, false);
  assert.deepEqual(goal.designDraft, saved);
  // Stop as soon as the replacement drawing is persisted, before construction.
  const stop = new Error('saved before work');
  await assert.rejects(designedBuildStep(bot, new Task('use furnished plan'), goal, () => {
    if (goal.design) throw stop;
  }), e => e === stop);
  assert.equal(goal.design.backend, 'starter-house');
  checkStarterDesign(goal.design, goal.starterReference);
});

test('a cuboid of beds accepts independent colors at a world offset across a saved goal', () => {
  const source = starterHouse(2, 'oak_planks', 'oak', ['white_bed', 'white_bed']);
  source.regions = source.regions.filter(r => r.block !== 'white_bed');
  source.regions.push({ from: [1,1,5], to: [2,1,5], block: 'white_bed', properties: { facing: 'south', half: null } });
  // A valid model drawing can already be at either wire-format limit.
  for (const color of ['red','green','blue','white','black','purple','brown','yellow','orange']) {
    const block = color + '_concrete';
    source.palette.push(block);
    source.regions.unshift({from:[0,0,0],to:[0,0,0],block});
  }
  while (source.regions.length < 256) source.regions.unshift({from:[0,0,0],to:[0,0,0],block:'oak_planks'});
  assert.equal(source.palette.length,16);
  validateSchematic(source, registry, {fromPlanner:true});
  const design = validateSchematic(source, registry), origin = { x: -10, y: 70, z: 3 };
  const blocks = design.blocks.map(p => ({ ...p, x: p.x + origin.x, y: p.y + origin.y, z: p.z + origin.z }));
  const feet = list => list.filter(p => p.properties?.part === 'foot').sort((a,b) => a.x - b.x);
  let goal = { design, blueprint: { origin, blocks } };
  for (const [i, color] of [[1, 'red_bed'], [0, 'blue_bed']]) {
    const bot = { registry, inventory: { items: () => [{ name: color, count: 1 }] } };
    assert(useAvailableBed(bot, goal, feet(goal.blueprint.blocks)[i]));
    goal = JSON.parse(JSON.stringify(goal));
    const expected = i === 1 ? ['white_bed', 'red_bed'] : ['blue_bed', 'red_bed'];
    assert.deepEqual(feet(goal.blueprint.blocks).map(p => p.material), expected);
    assert.deepEqual(feet(validateSchematic(goal.design.source, registry).blocks).map(p => p.material), expected);
    assert.throws(() => validateSchematic(goal.design.source, registry, {fromPlanner:true}), /palette|region count/);
  }
});

test('a distant unobserved worksite waits for a local survey before drawing', async () => {
  const bot = landscape('desert'), read = bot.blockAt;
  const anchor = { x: 500, y: 65, z: 400 }, goal = { kind: 'build', starterBeds: 2, buildAnchor: anchor };
  let loaded = false;
  bot.blockAt = p => Math.abs(p.x - anchor.x) <= 24 && !loaded ? null : read(p);
  const survey = () => require('../src/designer').surveyForDesign(bot, anchor);
  assert.throws(survey, /building site/);
  await designedBuildStep(bot, new Task('return to the site'), goal, () => {});
  assert.equal(goal.step.action, 'survey_build_site');
  assert.equal(goal.starterReference, undefined);
  assert.equal(goal.designAttempts, undefined);
  loaded = true;
  const world = survey();
  assert.deepEqual(world.position, anchor);
  assert.equal(world.biome, 'desert');
});

test('a stop during review persists the planner and drawing; resume reviews exactly that plan', async (t) => {
  const bot = landscape('snowy_taiga'),
    source = designStarterHouse(bot, { starterBeds: 2 }).source;
  const environment = ['BUILD_DESIGNER', 'JEV_GUIDE_API_KEY', 'JEV_BUILD_MODEL'];
  const before = environment.map((k) => process.env[k]),
    oldFetch = global.fetch;
  t.after(() => {
    environment.forEach((k, i) => {
      if (before[i] === undefined) delete process.env[k];
      else process.env[k] = before[i];
    });
    global.fetch = oldFetch;
  });
  Object.assign(process.env, {
    BUILD_DESIGNER: 'guide',
    JEV_GUIDE_API_KEY: 'fixture',
    JEV_BUILD_MODEL: 'separate-planner'
  });
  let draws = 0,
    saved;
  global.fetch = async () => {
    draws++;
    return reply(source);
  };
  const anchor = { x: 12, y: 65, z: 4 };
  let goal = { kind: 'build', request: 'a furnished house', starterBeds: 2, buildAnchor: anchor };
  const save = () => {
    saved = JSON.stringify(goal);
  };
  const first = new Task('build');
  await assert.rejects(
    designedBuildStep(bot, first, goal, save, {
      systemOne: async () => {
        first.cancel();
        first.check();
      }
    }),
    { name: 'Cancelled' }
  );
  goal = JSON.parse(saved);
  assert.equal(goal.design, undefined);
  assert.deepEqual(goal.designDraft, source);
  assert.equal(goal.designDraftInfo.model, 'separate-planner');
  bot.entity.position = new Vec3(90, 65, 90);
  await designedBuildStep(bot, new Task('resume'), goal, save, {
    systemOne: async () => ({ answers: { fits: { noul: 1 } } })
  });
  assert.equal(draws, 1);
  assert.deepEqual(goal.design.source, source);
  assert.deepEqual(goal.design.world.position, anchor);
  assert.equal(goal.designReview.accepted, true);
  assert.equal(goal.designDraft, undefined);
});

test('an earlier centred house supplies its real geometry and corner to a custom revision', () => {
  const blueprint = houseBlueprint(new Vec3(100, 64, 82), 'dark_oak_planks');
  const drawing = drawingForEdit({ blueprint, origin: blueprint.origin, name: 'house', request: 'our house' });
  assert.deepEqual(drawing.origin, blueprint.bounds.min);
  const model = validateSchematic(drawing.source, registry);
  const translated = model.blocks
    .map((p) => [p.x + drawing.origin.x, p.y + drawing.origin.y, p.z + drawing.origin.z, p.material].join(','))
    .sort();
  assert.deepEqual(translated, blueprint.blocks.map((p) => [p.x, p.y, p.z, p.material].join(',')).sort());
});

test('a request to craft a door uses carried wood; installing one picks the existing house', async () => {
  const ctx = {
    registry,
    inventory: { birch_planks: 8 },
    builds: [
      { id: 'near', kind: 'house', name: 'house', bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 4 } } }
    ]
  };
  const craft = await interpret(null, 'Jev make a door', 'Alex', 'Jev', ctx);
  assert.equal(craft.kind, 'craft');
  assert.equal(craft.item, 'birch_door');
  const fit = await interpret(null, 'Jev make a door for the house', 'Alex', 'Jev', ctx);
  assert.equal(fit.houseDetails.target, 'near');
});
