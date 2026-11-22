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
