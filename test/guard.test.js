'use strict';
// Guarding a player ("Jev protect me", src/guard.js, asked for 2026-11-22): the request it is read as, what
// the guard goes for and what it leaves be, who hurt the player from the server's damage events, the turn
// it claims, and no sword's sweep into a player beside the mob struck.
//
//   node test/guard.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const guard = require('../src/guard');

const mob = (id, name, x, y = 64, z = 0) => ({ id, name, type: name === 'player' ? 'player' : 'hostile', position: new Vec3(x, y, z), height: 1.95, width: 0.6, isValid: true, metadata: [] });
// The guarded player at the origin, the bot four blocks off, and the mobs given.
function scene(mobs = [], { health = 20, gameMode = 'survival' } = {}) {
  const robin = { id: 2, type: 'player', username: 'Robin', position: new Vec3(0.5, 64, 0.5), height: 1.8, width: 0.6, isValid: true };
  const me = { id: 1, type: 'player', position: new Vec3(4.5, 64, 0.5), height: 1.8, width: 0.6 };
  const entities = { 1: me, 2: robin };
  for (const m of mobs) entities[m.id] = m;
  return { username: 'Jev', entity: me, entities, players: { Jev: { username: 'Jev', entity: me }, Robin: { username: 'Robin', entity: robin } },
    health, game: { gameMode, dimension: 'overworld' }, time: { timeOfDay: 6000 }, _client: new EventEmitter() };
}
const goal = { kind: 'follow', guard: true, from: 'Robin', target: 'Robin', request: 'Jev protect me' };
const names = (bot, opts) => guard.targets(bot, goal, opts).map(t => t.entity.name);

test('"protect me" and its kin are a guard: a follow that fights; "follow me" is not', async () => {
  const { companionAction } = require('../src/companion-actions');
  for (const ask of ['protect me', 'Protect me!', 'please guard me', 'keep me safe', 'watch my back', 'defend me from the zombies',
    'protect me from monsters', 'be my bodyguard', 'look after me', 'kill the monsters around me', 'cover me'])
    assert.deepEqual(companionAction(ask), { kind: 'follow', guard: true }, ask);
  for (const ask of ['follow me', 'come here', 'protect the house', 'guard the door', 'protect me and build a house'])
    assert.notDeepEqual(companionAction(ask), { kind: 'follow', guard: true }, ask);
  const { interpret } = require('../src/objectives');
  const spec = await interpret(null, 'Jev protect me', 'Robin', 'Jev', {});
  assert.equal(spec.kind, 'follow'); assert.equal(spec.guard, true); assert.equal(spec.target, 'Robin');
  assert.equal(guard.guarded(spec), 'Robin');
  assert.equal(guard.guarded({ kind: 'follow', from: 'Robin' }), null, 'a plain follow guards nobody');
});

test('what is gone for: a hostile mob by the player and about their height; not a creeper, a flier, a calm enderman, nor a spider by day', () => {
  const bot = scene([mob(10, 'zombie', 3.5), mob(11, 'creeper', 2.5), mob(12, 'phantom', 1.5, 68), mob(13, 'enderman', 2.5, 64, 3),
    mob(14, 'spider', -3.5), mob(15, 'skeleton', 0.5, 64, 7), mob(16, 'zombie', 12.5), mob(17, 'zombie', 0.5, 57, 0.5), mob(18, 'cow', 1.5)]);
  assert.deepEqual(names(bot, { dark: false }), ['zombie', 'skeleton'], 'by day');
  assert.deepEqual(names(bot, { dark: true }), ['zombie', 'spider', 'skeleton'], 'at night the spider too');
});

test('what hurt the player is gone for first, wherever it stands within reach, an enderman too; not after six seconds', () => {
  const bot = scene([mob(10, 'zombie', 3.5), mob(13, 'enderman', 2.5, 64, 3), mob(15, 'skeleton', 0.5, 64, 18)]);
  guard.watch(bot);
  const now = Date.now();
  bot._client.emit('damage_event', { entityId: 2, sourceTypeId: 0, sourceCauseId: 15 + 1, sourceDirectId: 99 });
  bot._client.emit('damage_event', { entityId: 2, sourceTypeId: 0, sourceCauseId: 13 + 1, sourceDirectId: 14 });
  bot._client.emit('damage_event', { entityId: 1, sourceTypeId: 0, sourceCauseId: 10 + 1, sourceDirectId: 11 });
  bot._client.emit('damage_event', { entityId: 2, sourceTypeId: 0, sourceCauseId: 0, sourceDirectId: 0 });
  bot._client.emit('damage_event', null);
  assert.deepEqual(bot._playerHits.Robin.map(h => h.by), [15, 13], 'the shooter of the arrow and the enderman; the bot\'s own hurt is not the player\'s');
  assert.equal(bot._playerHits.Jev, undefined);
  const list = guard.targets(bot, goal, { now, dark: false });
  assert.deepEqual(list.map(t => [t.entity.name, t.hit]), [['enderman', true], ['skeleton', true], ['zombie', false]]);
  const last = Math.max(...bot._playerHits.Robin.map(h => h.at));
  assert.deepEqual(names(bot, { now: last + guard.HIT_MS + 1, dark: false }), ['zombie'], 'six seconds on, the far skeleton and the enderman are left');
  guard.watch(bot);
  assert.equal(bot._client.listenerCount('damage_event'), 1, 'watched once');
});

test('the claim: facts for the arbiter, the mob marked as the guard\'s; nothing at 8 health, in creative, or with the player out of view', () => {
  const bot = scene([mob(10, 'zombie', 3.5)]);
  const facts = guard.due(bot, goal);
  assert.deepEqual(facts, { player: 'Robin', target: 'zombie', toPlayer: 3, distance: 1 });
  assert.equal(bot._guardTarget.id, 10);
  assert.equal(require('../src/danger').nightHunted(bot, bot.entities[10]), true, 'no threat to run from while it is the guard\'s');
  assert.equal(guard.due(scene([mob(10, 'zombie', 3.5)], { health: 8 }), goal), null);
  assert.equal(guard.due(scene([mob(10, 'zombie', 3.5)], { gameMode: 'creative' }), goal), null);
  const gone = scene([mob(10, 'zombie', 3.5)]); gone.players.Robin.entity = null;
  assert.equal(guard.due(gone, goal), null);
  assert.equal(guard.due(scene([]), goal), null, 'nothing about');
});

test('the one gone for is kept while it is about, unless another hurt the player; one given up on is passed over', () => {
  const bot = scene([mob(10, 'zombie', 3.5), mob(11, 'husk', -2.5)]);
  bot._guard = { targetId: 11 };
  assert.equal(guard.pick(bot, goal).entity.id, 11, 'the husk already gone for, though the zombie is as near');
  bot._playerHits = { Robin: [{ by: 10, at: Date.now() }] };
  assert.equal(guard.pick(bot, goal).entity.id, 10, 'the zombie hurt the player');
  bot._playerHits = {};
  { const t = Date.now(), left = { at: t, until: t + guard.SKIP_MS }; bot._guard = { skip: { 10: left, 11: { ...left } } }; }
  assert.equal(guard.pick(bot, goal), null);
});

test('a mob given up on is gone for again after twenty seconds, and at once when it hurts the player after that', () => {
  const bot = scene([mob(10, 'zombie', 3.5)]), t = Date.now();
  const left = () => ({ skip: { 10: { at: t - 1000, until: t - 1000 + guard.SKIP_MS } } });
  bot._guard = left();
  assert.equal(guard.pick(bot, goal, t), null, 'left for now');
  bot._playerHits = { Robin: [{ by: 10, at: t - 3000 }] };
  assert.equal(guard.pick(bot, goal, t), null, 'a blow from before it was given up on does not bring it back');
  bot._playerHits = { Robin: [{ by: 10, at: t - 500 }] };
  assert.equal(guard.pick(bot, goal, t)?.entity.id, 10, 'it hurt the player since');
  assert.equal(bot._guard.skip[10], undefined, 'and is no longer left');
  bot._playerHits = {}; bot._guard = left();
  assert.equal(guard.pick(bot, goal, t - 1000 + guard.SKIP_MS)?.entity.id, 10, 'its time is up');
});

test('the tries counted are those in a row: a mob closed on between tries that failed is not given up on', async () => {
  // A skeleton that hurt the player, fourteen blocks from the bot: out of reach, gone for because of the blow.
  const bot = scene([mob(12, 'skeleton', 18.5)]);
  let move = 0;   // how far each walk takes the bot toward the mob
  const survival = { bot, report() {}, actions: { navigate: async () => { bot.entity.position.x += move; } } };
  const said = [], log = console.log;
  const walk = async by => {
    move = by; bot._playerHits = { Robin: [{ by: 12, at: Date.now() }] };
    console.log = line => said.push(String(line));
    try { await guard.step(survival, { check() {} }, goal, () => {}); } finally { console.log = log; }
  };
  await walk(0); await walk(0);
  assert.equal(bot._guard.misses, 2);
  await walk(2);
  assert.equal(bot._guard.misses, 0, 'closed on: the count starts over');
  await walk(0); await walk(0);
  assert.equal(guard.pick(bot, goal)?.entity.id, 12, 'two more that failed: still gone for');
  await walk(0);
  assert.equal(guard.pick(bot, goal), null, 'three in a row: left');
  assert.ok(bot._guard.skip[12].until > Date.now() && bot._guard.targetId === undefined);
  assert.ok(said.some(line => /\[guard\] the skeleton .* is left for 20 s/.test(line)), 'and said so in the log');
  bot._playerHits = { Robin: [{ by: 12, at: Date.now() + 1 }] };
  assert.equal(guard.pick(bot, goal, Date.now() + 1)?.entity.id, 12, 'it shoots the player again: gone for again');
});

test('the fight for the guarded player is not weighed against the follow: the work claim is withheld for a guard or a threat', () => {
  const bot = scene();
  const work = { layer: 'work', action: 'step', urgency: 'routine' };
  assert.equal(guard.first(bot, goal, [{ layer: 'survival', action: 'guard' }, work]), true);
  assert.equal(guard.first(bot, goal, [{ layer: 'survival', action: 'escape_threat' }, work]), true);
  assert.equal(guard.first(bot, goal, [{ layer: 'survival', action: 'obtain_food' }, work]), false);
  assert.equal(guard.first(bot, { kind: 'follow', from: 'Robin' }, [{ layer: 'survival', action: 'guard' }, work]), false);
});

test('a player beside the mob struck is a bystander: no sword sweep into them', () => {
  const { bystanders } = require('../src/combat');
  const bot = scene([mob(10, 'zombie', 1.5)]);
  assert.deepEqual(bystanders(bot, bot.entities[10]).map(e => e.username), ['Robin']);
  const far = scene([mob(10, 'zombie', 6.5)]);
  assert.deepEqual(bystanders(far, far.entities[10]), []);
});

test('the guard keeps the hiding ways off its fights while its health holds (company.js keepsOut)', () => {
  const company = require('../src/company');
  const bot = scene([mob(10, 'zombie', 3.5)]);
  bot.blockAt = () => null;
  const out = company.keepsOut(bot, goal);
  assert.deepEqual(out, { why: 'guarding Robin', player: 'Robin', guarding: true });
  // The stance's options while guarding (survival.js): the hides and the run away left off, the fight kept.
  const options = { fight: {}, retreat: {}, pillar: {}, seal: {}, charge_shooter: {}, none_good: {} };
  assert.deepEqual(company.withhold(options, out, [...company.HIDES, 'retreat']).sort(), ['pillar', 'retreat', 'seal']);
  assert.deepEqual(Object.keys(options).sort(), ['charge_shooter', 'fight', 'none_good']);
  // The night's answers: no sealed wait and no shelter while food is an answer; kept when nothing else is.
  const night = { obtain_food: {}, wait_for_day_sealed: {}, secure_shelter: {} };
  assert.deepEqual(company.withhold(night, out, ['wait_for_day_sealed', 'secure_shelter']), ['wait_for_day_sealed', 'secure_shelter']);
  const only = { wait_for_day_sealed: {}, none_good: {} };
  assert.deepEqual(company.withhold(only, out, ['wait_for_day_sealed', 'secure_shelter']), [], 'not left with nothing');
  bot.health = 8;
  assert.equal(company.keepsOut(bot, goal), null);
});

test('guarding, the runs from a fight are left off too, except from a creeper while the bot is by the player (company.js fightKeysOut)', () => {
  const company = require('../src/company');
  assert.deepEqual([...require('../src/survival').RUN_STANCES].sort(), [...company.RUNS].sort(), 'the runs are the stance\'s');
  const bot = scene([mob(10, 'zombie', 3.5), mob(11, 'creeper', 6.5)]);
  const out = { why: 'guarding Robin', player: 'Robin', guarding: true };
  assert.deepEqual(company.fightKeysOut(bot, out, [{ entity: bot.entities[10] }]), [...company.HIDES, ...company.RUNS], 'a zombie: no run');
  assert.deepEqual(company.fightKeysOut(bot, out, [{ entity: bot.entities[11] }]), company.HIDES, 'a creeper, the bot 4 blocks from the player: it may back away');
  bot.entity.position = new Vec3(20.5, 64, 0.5);
  assert.deepEqual(company.fightKeysOut(bot, out, [{ entity: bot.entities[11] }]), [...company.HIDES, ...company.RUNS], 'a creeper, the bot 20 blocks off: no farther');
  assert.deepEqual(company.fightKeysOut(bot, { why: 'Robin is out in the open 4 blocks off', player: 'Robin' }, [{ entity: bot.entities[10] }]), company.HIDES, 'not guarding: the hides only');
});

test('guarding, the ways to food that walk off are left off while hunger holds above six and another way is left (company.js guardFoodOut)', () => {
  const company = require('../src/company');
  const out = { why: 'guarding Robin', player: 'Robin', guarding: true };
  const tree = () => ({ secure_shelter: {}, obtain_food: { children: { eat_carried: {}, cook_beef: {}, hunt_29: {}, seen_food_4: {}, search_food: {}, go_home_for_food: {}, village_food: {}, none_good: {} } } });
  const t = tree();
  assert.deepEqual(company.guardFoodOut(t, out, 17).sort(), ['go_home_for_food', 'hunt_29', 'search_food', 'seen_food_4', 'village_food']);
  assert.deepEqual(Object.keys(t.obtain_food.children).sort(), ['cook_beef', 'eat_carried', 'none_good']);
  assert.deepEqual(company.guardFoodOut(tree(), out, 6), [], 'hunger at six: every way kept');
  assert.deepEqual(company.guardFoodOut({ obtain_food: { children: { hunt_29: {}, search_food: {}, none_good: {} } } }, out, 17), [], 'no other way: kept');
  assert.deepEqual(company.guardFoodOut(tree(), { why: 'Robin is out in the open', player: 'Robin' }, 17), [], 'not guarding: kept');
});

test('a sealed wait held from before is not taken up while the bot guards a player in view (survival.js claim)', () => {
  const registry = require('prismarine-registry')('26.1');
  const Chunk = require('prismarine-chunk')(registry), World = require('prismarine-world')(registry);
  const world = new World().sync;
  for (let cx = -2; cx <= 1; cx++) for (let cz = -2; cz <= 1; cz++) world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) { world.setBlockStateId(new Vec3(x, 63, z), registry.blocksByName.grass_block.defaultState); world.setBlockStateId(new Vec3(x, 62, z), registry.blocksByName.stone.defaultState); }
  const make = guardedPlayer => {
    const me = { id: 1, type: 'player', username: 'Jev', position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, width: 0.6 };
    const robin = { id: 2, type: 'player', username: 'Robin', position: new Vec3(3.5, 64, 0.5), height: 1.8, width: 0.6, isValid: true };
    return Object.assign(new EventEmitter(), { username: 'Jev', registry, world, blockAt: p => world.getBlock(p), entity: me,
      entities: guardedPlayer ? { 1: me, 2: robin } : { 1: me }, players: { Jev: { username: 'Jev', entity: me }, ...(guardedPlayer ? { Robin: { username: 'Robin', entity: robin } } : {}) },
      game: { dimension: 'overworld', difficulty: 'normal', gameMode: 'survival' }, time: { timeOfDay: 6000, age: 6000 },
      health: 20, food: 15, oxygenLevel: 20, inventory: { slots: [], items: () => [], count: () => 0 }, heldItem: null, findBlock: () => null, findBlocks: () => [],
      pathfinder: { setGoal() {}, goal: null, isMoving: () => false, stop() {} }, clearControlStates() {}, setControlState() {}, chat() {} });
  };
  const survival = require('../src/survival');
  const held = () => ({ state: { sealedWait: { until: Date.now() + 120000, minutes: 2 } } });
  const quiet = fn => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };
  assert.equal(quiet(() => survival.claim(make(false), { kind: 'follow', from: 'Robin', target: 'Robin' }, held()))?.action, 'wait_for_day_sealed', 'its player not about: the wait goes on');
  assert.notEqual(quiet(() => survival.claim(make(true), goal, held()))?.action, 'wait_for_day_sealed', 'guarding a player in view: not taken up');
});
