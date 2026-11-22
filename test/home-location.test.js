'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { attachHomeLocation, locationRequest } = require('../src/home-location');
function setup(state = {}, entries = [], places = []) {
  const bot = Object.assign(new EventEmitter(), {
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(4, 65, 5) },
    _client: new EventEmitter(),
    blockAt: () => null,
    activateBlock: () => {}
  });
  const writes = [];
  bot._client.write = (name, data) => writes.push(data);
  const memory = {
    context: () => ({ places }),
    rememberPlace: (from, label, position, dimension) => places.push({ from, label, position, dimension })
  };
  const locations = attachHomeLocation(bot, { state }, memory, { all: () => entries }, () => {});
  const message = (data) =>
    bot._client.emit('custom_payload', {
      channel: 'jevcraft:locations',
      data: Buffer.from(JSON.stringify({ version: 1, ...data }))
    });
  return { bot, locations, writes, message };
}
const world = { x: 48, y: 106, z: 0, dimension: 'overworld' },
  bed = { x: 4, y: 65, z: 6, dimension: 'overworld' };
test('home is durable across jobs and reconnects and stays separate from bed and effective respawn', async () => {
  const state = {},
    houses = [
      {
        kind: 'house',
        name: 'house',
        dimension: 'overworld',
        status: 'complete',
        entrance: { x: -1, y: 109, z: 45 },
        createdAt: '2026-01-01'
      }
    ];
  const { bot, locations, message } = setup(state, houses);
  bot.emit('spawn');
  message({ worldSpawn: world, personal: bed, effective: world, rule: 'server_spawn' });
  assert.equal(locations.home('Alex').position.x, -1);
  assert.deepEqual(locations.respawn().position, world);
  assert.match(locations.describe('Alex', 'both'), /house entrance.*server spawn.*personal point/);
  const before = structuredClone(state);
  bot.emit('end');
  const second = setup(before, []);
  assert.equal(second.locations.home('Alex').position.x, -1);
  second.bot.emit('spawn');
  const pending = second.locations.refresh();
  second.message({ worldSpawn: world, effective: world, rule: 'server_spawn' });
  await pending;
  assert.deepEqual(second.locations.respawn().position, world);
  assert(!second.locations.describe('Alex', 'respawn').includes('personal point'));
  second.bot.emit('death');
  second.bot.emit('end');
  const third = setup(before);
  third.bot.emit('spawn');
  assert.deepEqual(third.locations.context('Alex').lastRespawn, { x: 4, y: 65, z: 5, dimension: 'overworld' });
  third.bot.emit('end');
});
test('server confirmations outrank older locations and unobserved spawns offer a temporary home', () => {
  const { bot, locations, message } = setup();
  assert.equal(locations.home('Alex'), null);
  bot._client.emit('spawn_position', { globalPos: { dimensionName: 'minecraft:overworld', location: world } });
  assert.match(locations.describe('Alex', 'home'), /temporary home.*48, 106, 0/);
  locations.setHome('Alex', new Vec3(-2.5, 70, 4.1), 'the_nether');
  assert.equal(locations.home('Alex').position.dimension, 'nether');
  message({ worldSpawn: world, personal: bed, rule: 'personal', effective: bed });
  assert.deepEqual(locations.respawn().position, bed);
  message({ worldSpawn: world, rule: 'server', landing: bed });
  assert.equal(locations.respawn().position, null);
  assert.match(locations.describe('Alex', 'respawn'), /last came back at 4, 65, 6/);
  bot.emit('end');
});
test('portable bed tracking needs a server confirmation and can observe a lost bed', () => {
  const { bot, locations } = setup();
  bot._client.emit('spawn_position', { globalPos: { location: world, dimensionName: 'minecraft:overworld' } });
  const b = { name: 'red_bed', position: new Vec3(4, 65, 5), getProperties: () => ({ part: 'foot', facing: 'south' }) };
  bot.activateBlock(b);
  assert.equal(locations.respawn().rule, 'world');
  bot.emit('message', { translate: 'block.minecraft.set_spawn' }, 'system');
  assert.deepEqual(locations.respawn().position, bed);
  bot.game.dimension = 'the_nether';
  bot.blockAt = () => ({ name: 'air' });
  assert.deepEqual(locations.respawn().position, bed);
  bot.game.dimension = 'overworld';
  assert.deepEqual(locations.respawn().position, world);
  bot.emit('end');
});
test('plain-language questions, movement and marking home are distinct', () => {
  for (const [text, expected] of [
    ['where is home and where will you respawn?', 'both'],
    ['where is the resurrection point', 'respawn'],
    ['where is your home', 'home'],
    ['set our home here', 'set'],
    ['go home', 'visit_home'],
    ['go to your respawn point', 'visit_respawn'],
    ['build a home', null]
  ])
    assert.equal(locationRequest(text), expected);
});

test('a server-confirmed scaffold belongs to the player who placed it, and unrelated payloads are ignored', () => {
  const {bot,message}=setup();
  bot.registry={blocksByName:{dirt:{defaultState:10}}};const received=[];
  bot.on('confirmedBuildScaffold',b=>received.push(b));
  message({scaffold:{x:2,y:64,z:3,dimension:'minecraft:overworld',material:'dirt'}});
  message({scaffold:{x:2,y:64,z:3,dimension:'minecraft:the_nether',material:'dirt'}});
  message({scaffold:{x:2,y:64,z:3,dimension:'minecraft:overworld',material:'chest'}});
  assert.equal(received.length,1);assert.equal(received[0].stateId,10);
  assert.deepEqual(received[0].position,new Vec3(2,64,3));
  assert.equal(locationRequest('where is the closest tree to my home?'),null);
  bot.emit('end');
});
