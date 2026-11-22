'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { attachHomeLocation, locationRequest } = require('../src/home-location');
const { CompanionMemory } = require('../src/memory');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
test('personal markers remain per player across dimensions, forgetting and legacy migration', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-home-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const file = path.join(dir, 'memory.json'), alice = new Vec3(12, 68, -3), shared = new Vec3(4, 65, 8);
  const survival = { state: { locations: { home: { ...alice, dimension: 'overworld' } } } };
  new CompanionMemory(file).rememberPlace('Alice', 'home', alice, 'overworld');
  const connect = () => attachHomeLocation(Object.assign(new EventEmitter(), { _client: new EventEmitter(), game: {} }),
    survival, new CompanionMemory(file), { all: () => [] }, () => {});
  const loc = connect();
  assert.equal(loc.home('Bob'), null);
  assert.equal(loc.home('Alice').position.x, 12);
  loc.setHome('Bob', shared, 'overworld', locationRequest('set our home here'));
  loc.setHome('Alice', new Vec3(21, 64, 0), 'nether', locationRequest('remember this as my home'));
  assert.equal(loc.home('Alice', 'personal').position.x, 21);
  assert.equal(loc.home('Alice', 'shared').position.x, 4);
  assert.equal(connect().home('Bob').position.x, 4);
  assert.match(loc.forgetHome('Alice', 'personal'), /forgot/i);
  assert.equal(connect().home('Alice', 'personal'), null);
  assert.equal(connect().home('Alice').position.x, 4);
});
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
test('private home replies address only the requesting player on Paper and other servers', () => {
  const { bot } = setup();
  const player = { username: '.BedrockUser', uuid: 'ee7204cb-aa75-4e5d-a836-b36eb22d2cb1' };
  const commands = [];
  bot.players = { [player.username]: player };
  bot.chat = text => commands.push(text);
  const access = require('../src/commands').createCommandAccess(bot);
  access.whisper(player.uuid, 'Your home is here.');
  bot.game.serverBrand = 'Paper';
  access.whisper(player.uuid, 'Your home is here. Your spawn is there.');
  access.whisper('everyone', 'These coordinates are private.');
  access.whisper(player.uuid, 'Two\nlines.');
  assert.throws(() => bot.chat('/tell someone hello'), /explicit player request/);
  player.username = 'Two Words';
  access.whisper(player.uuid, 'One recipient.');
  assert.deepEqual(commands, ['/tell .BedrockUser Your home is here.', '/minecraft:msg .BedrockUser Your home is here.',
    '/minecraft:msg .BedrockUser Your spawn is there.', '/minecraft:msg "Two Words" One recipient.']);
});
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
