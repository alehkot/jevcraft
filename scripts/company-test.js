'use strict';
// Called over by a player: the bot comes, and ends where the two can see each
// other (src/company.js). No server: a small world of real blocks held in
// memory, so a line of sight is the game's own ray against leaves, glass,
// stairs and grass, and survival.js's claim on the turn and its step asked
// at night, in the open and sealed in a pocket.
//
//   node scripts/company-test.js
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const registry = require('prismarine-registry')('26.1');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const company = require('../src/company');

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok  ${name}`); };

// A flat lawn at y 63 (feet at 64), 32 blocks each way from the middle.
function lawn() {
  const world = new World().sync;
  for (let cx = -2; cx <= 1; cx++) for (let cz = -2; cz <= 1; cz++) world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
  const set = (x, y, z, name) => world.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState);
  for (let x = -24; x <= 24; x++) for (let z = -24; z <= 24; z++) { set(x, 63, z, 'grass_block'); for (let y = 56; y < 63; y++) set(x, y, z, 'stone'); }
  return { world, set };
}
// The bot as far as this code knows one, and the player who called it.
function scene({ at = [6.5, 64, 0.5], player = [0.5, 64, 0.5], yaw } = {}) {
  const { world, set } = lawn(), looked = [];
  const caller = { position: new Vec3(...player), yaw, id: 2, type: 'player', height: 1.8, width: 0.6 };
  const bot = Object.assign(new EventEmitter(), { username: 'Jev', registry, world, blockAt: p => world.getBlock(p), entity: { position: new Vec3(...at), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8, width: 0.6, id: 1 },
    players: { Caller: { entity: caller } }, entities: {}, game: { dimension: 'overworld', difficulty: 'normal', gameMode: 'survival' }, time: { timeOfDay: 6000, age: 6000 },
    health: 20, food: 20, oxygenLevel: 20, inventory: { slots: [], items: () => [], count: () => 0 }, heldItem: null, findBlocks: () => [], findBlock: () => null,
    pathfinder: { setGoal() {}, goal: null, isMoving: () => false, stop() {} }, clearControlStates() {}, setControlState() {}, chat() {}, lookAt: async point => { looked.push(point); },
    dig: async () => {}, stopDigging() {}, deactivateItem() {}, equip: async () => {}, unequip: async () => {}, canDigBlock: () => true, digTime: () => 100 });
  // A walk that arrives: the bot is put on the cell asked for.
  const walks = [];
  const navigate = async (b, task, goal, options) => { walks.push({ goal, options }); b.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); };
  return { bot, caller, set, looked, walks, navigate };
}
const wall = (set, x, { from = -3, to = 3, of = 'stone', height = 3 } = {}) => { for (let z = from; z <= to; z++) for (let y = 64; y < 64 + height; y++) set(x, y, z, of); };
const task = { check() {} };
const call = (over = {}) => ({ kind: 'come', request: 'Jev come here', from: 'Caller', target: 'Caller', createdAt: new Date().toISOString(), ...over });

(async () => {
  // ---------------------------------------------------------------- 1. which call it is
  await check('a call holds while its player is in view and it is minutes old', async () => {
    const { bot } = scene();
    assert.equal(company.calledOver(call(), bot), true);
    assert.equal(company.calledOver(call({ kind: 'follow' }), bot), true, 'following its player in view holds as a call does (2026-11-22)');
    assert.equal(company.calledOver(call({ kind: 'follow', from: 'Other', target: 'Other' }), bot), false, 'a follow whose player is out of view is no call');
    assert.equal(company.calledOver(call({ kind: 'obtain' }), bot), false);
    assert.equal(company.calledOver(call({ from: 'Other', target: 'Other' }), bot), false, 'the player is not in view');
    assert.equal(company.calledOver(call({ createdAt: new Date(Date.now() - company.CALL_HOLDS_MS - 1000).toISOString() }), bot), false, 'a call of long ago');
    assert.equal(company.calledOver(call({ createdAt: undefined }), bot), true, 'no date on it: the player in view decides');
    assert.equal(company.calledOver(null, bot), false);
    assert.equal(company.calledOver(call(), null), false);
  });

  await check('a player out of the game is waited for twenty seconds, then has left', async () => {
    const { bot } = scene();
    const goal = call(), t0 = 1_000_000;
    assert.equal(company.callerState(bot, goal, t0), 'here');
    assert.equal(goal.callerGoneAt, undefined);
    bot.players = {};
    assert.equal(company.callerState(bot, goal, t0), 'wait');
    assert.equal(company.callerState(bot, goal, t0 + company.GONE_MS - 1), 'wait');
    assert.equal(company.callerState(bot, goal, t0 + company.GONE_MS), 'left');
    // back within the wait: the count starts again the next time
    bot.players = { caller: { entity: null } };
    assert.equal(company.callerState(bot, goal, t0 + 5000), 'here', 'in the game, out of view, whatever the case of the name');
    assert.equal(goal.callerGoneAt, undefined);
    // a follow is for a player as a come is
    bot.players = {};
    const follow = call({ kind: 'follow' });
    company.callerState(bot, follow, t0);
    assert.equal(company.callerState(bot, follow, t0 + company.GONE_MS), 'left');
  });

  await check('a call is not taken up at a start when its player is not in the game, or it is minutes old', async () => {
    const { bot } = scene();
    assert.equal(company.lapsed(call(), bot), false, 'said a moment ago, the player here: a reconnect carries on');
    assert.equal(company.lapsed(call({ from: 'Other', target: 'Other' }), bot), true, 'only another player is in the game');
    assert.equal(company.lapsed(call({ createdAt: new Date(Date.now() - 45 * 60000).toISOString() }), bot), true, 'said 45 minutes ago');
    assert.equal(company.lapsed(call({ kind: 'follow', from: 'Other', target: 'Other' }), bot), false, 'a follow ends by callerState, said aloud');
    assert.equal(company.lapsed(call({ kind: 'obtain', createdAt: new Date(Date.now() - 45 * 60000).toISOString() }), bot), false, 'work is carried on');
    assert.equal(company.lapsed(null, bot), false);
  });

  // ---------------------------------------------------------------- 2. a line between the eyes
  await check('open ground: in view; a wall, leaves or glass between: not; grass and flowers: in view', async () => {
    const open = scene();
    assert.equal(company.inView(open.bot, open.caller), true);
    for (const of of ['stone', 'oak_leaves', 'jungle_leaves', 'glass']) {
      const s = scene(); wall(s.set, 3, { of });
      assert.equal(company.inView(s.bot, s.caller), false, `a wall of ${of}`);
    }
    for (const of of ['short_grass', 'dandelion']) {
      const s = scene(); wall(s.set, 3, { of, height: 1 });
      assert.equal(company.inView(s.bot, s.caller), true, `${of} between`);
    }
  });

  await check('three blocks under the player\'s feet is near and not in view', async () => {
    const s = scene({ at: [0.5, 60, 0.5] });
    for (let y = 60; y <= 61; y++) s.set(0, y, 0, 'air');
    assert.ok(s.bot.entity.position.distanceTo(s.caller.position) <= 4);
    assert.equal(company.inView(s.bot, s.caller), false);
  });

  await check('a low wall is seen over; a stair is no wall where the ray passes its open half', async () => {
    const low = scene(); wall(low.set, 3, { height: 1 });
    assert.equal(company.inView(low.bot, low.caller), true, 'one block high, the eyes above it');
    const stair = scene(); wall(stair.set, 3, { of: 'oak_stairs', height: 1 });
    assert.equal(company.inView(stair.bot, stair.caller), true);
  });

  // ---------------------------------------------------------------- 3. where to stand
  await check('every spot offered can be stood in and has the line; none is on top of the player', async () => {
    const s = scene({ yaw: -Math.PI / 2 }); wall(s.set, 3); s.set(-2, 64, 1, 'water'); s.set(1, 64, -2, 'oak_leaves'); s.set(1, 65, -2, 'oak_leaves');
    const spots = company.spotsInView(s.bot, s.caller);
    assert.ok(spots.length > 8, `${spots.length} spots`);
    for (const cell of spots) {
      assert.ok(company.standable(s.bot, cell), `standable ${cell}`);
      assert.ok(company.inView(s.bot, s.caller, cell.offset(0.5, 0, 0.5)), `a line from ${cell}`);
      assert.ok(Math.hypot(cell.x + 0.5 - s.caller.position.x, cell.z + 0.5 - s.caller.position.z) >= 1.5, `not on the player: ${cell}`);
      assert.ok(cell.x < 3, `not behind the wall: ${cell}`);
      assert.notEqual(`${cell}`, '(-2, 64, 1)', 'not in the water');
    }
  });

  await check('the first spot is in front of the player, two or three blocks off, on their level', async () => {
    // facing +x (mineflayer's yaw: the way faced is -sin, -cos)
    for (const [yaw, ahead] of [[-Math.PI / 2, c => c.x > 0], [Math.PI / 2, c => c.x < 0], [Math.PI, c => c.z > 0], [0, c => c.z < 0]]) {
      const s = scene({ at: [0.5, 64, 9.5], yaw });
      const first = company.spotsInView(s.bot, s.caller)[0];
      assert.ok(ahead(first), `yaw ${yaw.toFixed(2)}: ${first}`);
      assert.equal(first.y, 64);
      const off = Math.hypot(first.x + 0.5 - 0.5, first.z + 0.5 - 0.5);
      assert.ok(off >= 1.5 && off <= 3.6, `off ${off}`);
    }
  });

  await check('the way faced not known: still a spot, the nearest good one', async () => {
    const s = scene({ at: [8.5, 64, 0.5] });
    const first = company.spotsInView(s.bot, s.caller)[0];
    assert.ok(first && first.x > 0, `${first}`);
  });

  await check('a player on a ledge: a spot up on the ledge with them, not at its foot', async () => {
    const s = scene({ at: [4.5, 64, 0.5], player: [0.5, 67, 0.5], yaw: -Math.PI / 2 });
    for (let x = -4; x <= 3; x++) for (let z = -4; z <= 4; z++) for (let y = 64; y <= 66; y++) s.set(x, y, z, 'stone');
    assert.equal(company.inView(s.bot, s.caller), false, 'from the foot of the ledge, against its face');
    const first = company.spotsInView(s.bot, s.caller)[0];
    assert.equal(first.y, 67, `${first}`);
  });

  // ---------------------------------------------------------------- 4. arriving
  await check('already in view: no walk, and it turns to face the player', async () => {
    const s = scene({ at: [2.5, 64, 0.5] });
    const view = await company.standInView(s.bot, task, s.caller, { navigate: s.navigate, goals });
    assert.deepEqual({ seen: view.seen, moved: view.moved }, { seen: true, moved: false });
    assert.equal(s.walks.length, 0);
    assert.equal(s.looked.length, 1);
    assert.ok(Math.abs(s.looked[0].y - (64 + company.EYE)) < 1e-9, 'at the player\'s eyes');
  });

  await check('behind a wall beside the player: one walk to a spot in view', async () => {
    const s = scene({ at: [2.5, 64, 0.5], yaw: Math.PI / 2 }); wall(s.set, 1);
    assert.equal(company.inView(s.bot, s.caller), false);
    const view = await company.standInView(s.bot, task, s.caller, { navigate: s.navigate, goals });
    assert.equal(s.walks.length, 1);
    assert.ok(s.walks[0].goal instanceof goals.GoalBlock);
    assert.ok(s.walks[0].options.timeoutMs <= 15000, 'the walk is capped');
    assert.deepEqual({ seen: view.seen, moved: view.moved }, { seen: true, moved: true });
    assert.ok(s.bot.entity.position.x < 1, 'on the player\'s side of the wall');
    assert.ok(s.looked.length >= 1);
  });

  await check('under the player\'s feet: up to their level', async () => {
    const s = scene({ at: [0.5, 60, 0.5], yaw: 0 });
    for (let y = 60; y <= 61; y++) s.set(0, y, 0, 'air');
    const view = await company.standInView(s.bot, task, s.caller, { navigate: s.navigate, goals });
    assert.equal(view.seen, true);
    assert.equal(s.bot.entity.position.y, 64);
  });

  await check('no spot in view (the player walled in): no walk, and it says it is not seen', async () => {
    const s = scene({ at: [3.5, 64, 0.5] });
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let y = 64; y <= 66; y++) if (dx || dz) s.set(dx, y, dz, 'stone');
    s.set(0, 66, 0, 'stone');
    const view = await company.standInView(s.bot, task, s.caller, { navigate: s.navigate, goals });
    assert.deepEqual({ seen: view.seen, moved: view.moved }, { seen: false, moved: false });
    assert.equal(s.walks.length, 0);
  });

  await check('the walk fails: the call still ends, not seen; a threat on the way is not swallowed', async () => {
    const s = scene({ at: [2.5, 64, 0.5], yaw: Math.PI / 2 }); wall(s.set, 1);
    const noRoute = async () => { const err = new Error('no route'); err.name = 'NoRoute'; throw err; };
    const view = await company.standInView(s.bot, task, s.caller, { navigate: noRoute, goals });
    assert.deepEqual({ seen: view.seen, moved: view.moved }, { seen: false, moved: true });
    const threat = async () => { const err = new Error('a zombie'); err.name = 'NeedsSafety'; throw err; };
    await assert.rejects(company.standInView(s.bot, task, s.caller, { navigate: threat, goals }), { name: 'NeedsSafety' });
  });

  await check('what it says on arriving', async () => {
    const { completion } = require('../src/speech');
    assert.equal(completion(call()), "I'm here with Caller!");
    assert.match(completion(call({ outOfView: true })), /can't get to where we can see each other/);
    assert.equal(completion(call({ callerLeft: true })), "Caller has left the game, so I've stopped coming over.");
    assert.equal(completion(call({ kind: 'follow', callerLeft: true })), "Caller has left the game, so I've stopped following.");
  });

  // ---------------------------------------------------------------- 5. the night's shelter and the call
  const survival = require('../src/survival');
  const claimAt = (timeOfDay, goal, { players, entities = {} } = {}) => {
    const s = scene({ at: [10.5, 64, 0.5] });
    s.bot.time.timeOfDay = timeOfDay; s.bot.entities = entities;
    if (players) s.bot.players = players;
    return survival.claim(s.bot, goal, null);
  };
  await check('at night the shelter claims the turn from other work, and not from a call', async () => {
    assert.equal(claimAt(16000, { kind: 'survive', request: 'Stay alive' })?.action, 'secure_shelter');
    assert.equal(claimAt(16000, call({ kind: 'obtain', request: 'Jev get me 8 planks' }))?.action, 'secure_shelter');
    assert.notEqual(claimAt(16000, call({ kind: 'follow', request: 'Jev follow me' }))?.action, 'secure_shelter', 'following its player in view: as a call (2026-11-22)');
    assert.equal(claimAt(16000, call({ kind: 'follow', request: 'Jev follow me' }), { players: { Caller: { entity: null } } })?.action, 'secure_shelter', 'following a player out of view: the shelter, as before');
    assert.equal(claimAt(16000, call()), null, 'a call in hand, its player in view');
  });
  await check('a call whose player is gone, or of long ago, does not keep the bot out in the dark', async () => {
    assert.equal(claimAt(16000, call(), { players: {} })?.action, 'secure_shelter');
    assert.equal(claimAt(16000, call({ createdAt: new Date(Date.now() - 6 * 60000).toISOString() }))?.action, 'secure_shelter');
  });
  await check('a mob at arm\'s length is answered first, call or no call', async () => {
    const zombie = { 7: { id: 7, name: 'zombie', type: 'hostile', kind: 'Hostile mobs', displayName: 'Zombie', position: new Vec3(12.5, 64, 0.5), velocity: new Vec3(0, 0, 0), height: 1.95, width: 0.6, isValid: true, metadata: [] } };
    assert.equal(claimAt(16000, call(), { entities: zombie })?.action, 'escape_threat');
  });
  await check('by day a call is the work\'s turn, as it was', async () => {
    assert.equal(claimAt(3000, call()), null);
  });

  // ---------------------------------------------------------------- 6. sealed in for the night, and called
  // The survival layer's own step, the bot two blocks under the lawn in a
  // pocket it has on record. What the step does next is read off it: the
  // leave (stood in for here), or its question put to the decision layer,
  // which nobody answers in this test.
  const { createSurvival } = require('../src/work');
  const inPocket = async (goal, { players, entities = {}, timeOfDay = 16000 } = {}) => {
    const s = scene({ at: [10.5, 60, 0.5] });
    s.set(10, 60, 0, 'air'); s.set(10, 61, 0, 'air');
    s.bot.time.timeOfDay = timeOfDay; s.bot.entities = entities;
    if (players) s.bot.players = players;
    const refuge = { origin: { x: 10, y: 60, z: 0 }, dimension: 'overworld', createdAt: new Date().toISOString(), emergency: true, shaft: true, top: { x: 10, y: 64, z: 0 }, verifiedAt: Date.now() };
    const survival = createSurvival(s.bot, { state: { shelters: [refuge] }, client: null });
    let did = null;
    survival.leave = async () => { did = 'leave'; return true; };
    survival.actions = { ...survival.actions, navigate: s.navigate };
    const log = console.log, err = console.error, said = [];
    console.log = console.error = (...a) => { said.push(a.join(' ')); };
    // The step is let go of as soon as it has shown its hand.
    const stepTask = { check() { if (!did && said.some(l => /pocket_next/.test(l))) did = 'asked'; if (did === 'asked') { const e = new Error('enough'); e.name = 'Cancelled'; throw e; } } };
    try { await Promise.race([survival.step(stepTask, goal, () => {}, () => {}).catch(e => { if (e.name !== 'Cancelled') throw e; }), new Promise(r => setTimeout(r, 8000))]); }
    finally { console.log = log; console.error = err; }
    return { claim: survival_claim(s.bot, goal, survival), did, said, survival, bot: s.bot, walks: s.walks };
  };
  const survival_claim = (bot, goal, survival) => require('../src/survival').claim(bot, goal, survival)?.action;
  await check('sealed in for the night and called: the pocket is opened, by rule', async () => {
    const out = await inPocket(call());
    assert.equal(out.did, 'leave', out.said.slice(0, 3).join(' / '));
    assert.ok(out.said.some(l => /\[company\]/.test(l)));
  });
  await check('with a mob about, a call whose player is gone, or other work: the pocket\'s question is asked as before', async () => {
    const zombie = { 7: { id: 7, name: 'zombie', type: 'hostile', kind: 'Hostile mobs', displayName: 'Zombie', position: new Vec3(14.5, 64, 0.5), velocity: new Vec3(0, 0, 0), height: 1.95, width: 0.6, isValid: true, metadata: [] } };
    assert.equal((await inPocket(call(), { entities: zombie })).did, 'asked', 'a zombie four blocks from the lid');
    assert.equal((await inPocket(call(), { players: {} })).did, 'asked', 'the player gone');
    assert.equal((await inPocket(call({ kind: 'obtain', request: 'Jev get me 8 planks' }))).did, 'asked', 'other work');
    assert.equal((await inPocket(call({ kind: 'follow', request: 'Jev follow me' }), { players: { Caller: { entity: null } } })).did, 'asked', 'following a player out of view');
  });
  await check('sealed in for the night, following a player in view: the pocket is opened as for a call (2026-11-22)', async () => {
    assert.equal((await inPocket(call({ kind: 'follow', request: 'Jev follow me' }))).did, 'leave');
  });

  await check('inside the pocket on record, and not when out of it or with none on record', async () => {
    const s = scene({ at: [10.5, 60, 0.5] });
    s.set(10, 60, 0, 'air'); s.set(10, 61, 0, 'air');
    const refuge = { origin: { x: 10, y: 60, z: 0 }, dimension: 'overworld', createdAt: new Date().toISOString(), emergency: true, shaft: true, top: { x: 10, y: 64, z: 0 }, verifiedAt: Date.now() };
    const survival = createSurvival(s.bot, { state: { shelters: [refuge] }, client: null });
    assert.equal(company.inShelter(s.bot, survival), true);
    // climbing out up its shaft is still inside, whatever the record says of keeping away
    for (let y = 61; y <= 63; y++) { s.set(10, y, 0, 'air'); s.set(10, y + 1, 0, 'air'); s.bot.entity.position = new Vec3(10.5, y, 0.5); assert.equal(company.inShelter(s.bot, survival), true, `in the shaft at ${y}`); }
    survival.state.shelters[0].avoidUntil = Date.now() + 60000;
    s.bot.entity.position = new Vec3(10.5, 62, 0.5);
    assert.equal(company.inShelter(s.bot, survival), true, 'marked to keep away from, and still in its shaft');
    s.bot.entity.position = new Vec3(10.5, 64, 0.5);
    assert.equal(company.inShelter(s.bot, survival), false, 'on the grass at the top of it');
    s.bot.entity.position = new Vec3(11.5, 64, 0.5);
    assert.equal(company.inShelter(s.bot, survival), false, 'beside it');
    s.bot.entity.position = new Vec3(10.5, 60, 0.5);
    assert.equal(company.inShelter(s.bot, createSurvival(s.bot, { state: { shelters: [] }, client: null })), false, 'no shelter on record');
    assert.equal(company.inShelter(s.bot, null), false);
    assert.equal(company.inShelter(s.bot, { state: { get shelters() { throw new Error('unreadable'); } } }), false);
    survival.state.shelters[0].kind = 'house';
    assert.equal(company.inShelter(s.bot, survival), false, 'a house is a place to wait in');
    delete survival.state.shelters[0].kind;
    assert.equal(company.inShelter(s.bot, survival), true);
    s.bot.game.dimension = 'the_nether';
    assert.equal(company.inShelter(s.bot, survival), false, 'another dimension');
  });

  await check('in a hole one block wide: in the pocket, up its shaft, one block deep; not on the grass, in a tunnel or where the world is not loaded', async () => {
    const s = scene({ at: [10.5, 60, 0.5] });
    for (let y = 60; y <= 63; y++) s.set(10, y, 0, 'air');
    for (const y of [60, 61, 62, 63]) { s.bot.entity.position = new Vec3(10.5, y, 0.5); assert.equal(company.holedUp(s.bot), true, `feet at ${y}`); }
    s.bot.entity.position = new Vec3(10.5, 64, 0.5);
    assert.equal(company.holedUp(s.bot), false, 'on the grass');
    // a tunnel leads off the bottom of it
    s.set(11, 60, 0, 'air'); s.set(11, 61, 0, 'air');
    s.bot.entity.position = new Vec3(10.5, 60, 0.5);
    assert.equal(company.holedUp(s.bot), false, 'a side is open');
    // glass and leaves are walls; grass in the next cell is not
    const t = scene({ at: [0.5, 64, 0.5] });
    for (const [dx, dz, of] of [[1, 0, 'glass'], [-1, 0, 'oak_leaves'], [0, 1, 'stone'], [0, -1, 'short_grass']]) t.set(dx, 64, dz, of);
    assert.equal(company.holedUp(t.bot), false, 'grass on one side');
    t.set(0, 64, -1, 'dirt');
    assert.equal(company.holedUp(t.bot), true);
    t.bot.entity.position = new Vec3(500.5, 64, 500.5);
    assert.equal(company.holedUp(t.bot), false, 'not loaded');
    assert.equal(company.holedUp(null), false);
  });

  await check('the bot\'s own routine while it waits: runs in the dark and in a shelter, finishes for three seconds once out, then ends', async () => {
    const r = company.routine;
    assert.equal(r({ dark: true, sheltered: false, sinceSheltered: 1e9 }), 'run', 'night in the open');
    assert.equal(r({ dark: false, sheltered: true, sinceSheltered: 0 }), 'run', 'sunrise in the pocket, or back by day in one');
    assert.equal(r({ dark: false, sheltered: false, sinceSheltered: 500 }), 'finish', 'climbing out, the record gone');
    assert.equal(r({ dark: false, sheltered: false, sinceSheltered: company.OUT_MS - 1 }), 'finish');
    assert.equal(r({ dark: false, sheltered: false, sinceSheltered: company.OUT_MS }), 'end', 'out: the waiting begins');
    assert.equal(r({ dark: false, sheltered: false, sinceSheltered: 1e12 }), 'end', 'never sheltered: sunrise after a night stayed up, as before');
    assert.ok(company.OUT_MS <= 5000, 'no time for the routine to start its own day');
  });

  // ---------------------------------------------------------------- 7. the night with a player (JEV_NIGHT=company)
  const withNight = async fn => { process.env.JEV_NIGHT = 'company'; try { return await fn(); } finally { delete process.env.JEV_NIGHT; } };
  const playerAt = (x, y = 64, z = 0.5) => ({ Caller: { entity: { position: new Vec3(x, y, z), id: 2, type: 'player' } } });

  await check('unset, a player near changes nothing; set, one within 32 blocks keeps the bot up, and for 20 seconds after', async () => {
    const { bot } = scene({ at: [10.5, 64, 0.5] });   // the player 10 blocks off
    assert.equal(company.nightMode(), false);
    assert.equal(company.staysUp(bot), false, 'not set');
    assert.equal(company.comesOut(bot), false, 'not set');
    await withNight(() => {
      const t0 = 5_000_000;
      assert.equal(company.staysUp(bot, t0), true);
      assert.equal(company.comesOut(bot), true, '10 blocks');
      bot.players = playerAt(10.5 + 24);
      assert.equal(company.staysUp(bot, t0), true, '24 blocks: up');
      assert.equal(company.comesOut(bot), false, '24 blocks: a pocket stays shut');
      bot.players = playerAt(10.5 + 40);
      assert.equal(company.staysUp(bot, t0 + company.ALONE_MS - 1), true, 'gone a moment');
      assert.equal(company.staysUp(bot, t0 + company.ALONE_MS), false, 'alone');
      bot.players = {};
      assert.equal(company.staysUp(bot, t0 + 10 * company.ALONE_MS), false, 'nobody in the game');
      bot.players = { Jev: { entity: { position: bot.entity.position.clone() } } };
      assert.equal(company.staysUp(bot, t0 + 10 * company.ALONE_MS), false, 'its own name is no company');
      assert.ok(company.COME_OUT < company.STAY_UP, 'the two distances are apart');
    });
  });

  await check('at night with a player near the shelter does not claim the turn, whatever is in hand; alone it does', async () => {
    await withNight(() => {
      for (const goal of [{ kind: 'survive', request: 'Stay alive' }, call({ kind: 'obtain', request: 'Jev get me 8 planks' }), call({ kind: 'follow', request: 'Jev follow me' })]) {
        assert.notEqual(claimAt(16000, goal)?.action, 'secure_shelter', `${goal.kind}, the player 10 blocks off`);
        // Far off, the bot looks after itself (2026-11-22: "if player is far away jev should take cover if it's not safe");
        // a player followed is kept with while in view, as a call is.
        if (goal.kind === 'follow') assert.notEqual(claimAt(16000, goal, { players: playerAt(10.5 + 40) })?.action, 'secure_shelter', 'follow, the player 40 blocks off in view');
        else assert.equal(claimAt(16000, goal, { players: playerAt(10.5 + 40) })?.action, 'secure_shelter', `${goal.kind}, the player 40 blocks off`);
        assert.equal(claimAt(16000, goal, { players: {} })?.action, 'secure_shelter', `${goal.kind}, nobody`);
      }
      const zombie = { 7: { id: 7, name: 'zombie', type: 'hostile', kind: 'Hostile mobs', displayName: 'Zombie', position: new Vec3(12.5, 64, 0.5), velocity: new Vec3(0, 0, 0), height: 1.95, width: 0.6, isValid: true, metadata: [] } };
      assert.equal(claimAt(16000, { kind: 'survive', request: 'Stay alive' }, { entities: zombie })?.action, 'escape_threat', 'a mob at arm\'s length is answered all the same');
    });
    assert.equal(claimAt(16000, { kind: 'survive', request: 'Stay alive' })?.action, 'secure_shelter', 'not set: as before');
  });

  await check('sealed in for the night, a player comes close: the pocket is opened, by rule; further off, or not set, it is asked as before', async () => {
    const idle = { kind: 'survive', request: 'Stay alive' };
    await withNight(async () => {
      const out = await inPocket(idle);
      assert.equal(out.did, 'leave', out.said.slice(0, 3).join(' / '));
      assert.ok(out.said.some(l => /a player close by/.test(l)));
      assert.equal((await inPocket(call({ kind: 'follow', request: 'Jev follow me' }))).did, 'leave', 'with work in hand too');
      assert.equal((await inPocket(idle, { players: playerAt(10.5 + 24) })).did, 'asked', 'the player 24 blocks off');
      const zombie = { 7: { id: 7, name: 'zombie', type: 'hostile', kind: 'Hostile mobs', displayName: 'Zombie', position: new Vec3(14.5, 64, 0.5), velocity: new Vec3(0, 0, 0), height: 1.95, width: 0.6, isValid: true, metadata: [] } };
      assert.equal((await inPocket(idle, { entities: zombie })).did, 'asked', 'a zombie four blocks from the lid');
    });
    assert.equal((await inPocket(idle)).did, 'asked', 'not set');
  });

  await check('what the waiting reads: the dark with a player near is waited out like the day; a pocket a player comes close to is left', async () => {
    const pocketed = () => { const s = scene({ at: [10.5, 60, 0.5] }); s.set(10, 60, 0, 'air'); s.set(10, 61, 0, 'air'); return s; };
    const open = scene({ at: [10.5, 64, 0.5] });
    assert.deepEqual(company.standing(open.bot, null, true), { dark: true, sheltered: false, out: false }, 'not set: the dark is the dark');
    assert.deepEqual(company.standing(pocketed().bot, null, true), { dark: true, sheltered: false, out: false }, 'not set: in the pocket at night the routine runs for the dark');
    assert.deepEqual(company.standing(pocketed().bot, null, false), { dark: false, sheltered: true, out: false }, 'by day, in a hole: out of it');
    await withNight(() => {
      assert.deepEqual(company.standing(open.bot, null, true), { dark: false, sheltered: false, out: false }, 'up beside the player: wait');
      assert.deepEqual(company.standing(pocketed().bot, null, true), { dark: false, sheltered: true, out: false }, 'in a hole, the player 10 blocks off: out of it');
      const far = pocketed(); far.bot.players = playerAt(10.5 + 24, 60);
      assert.deepEqual(company.standing(far.bot, null, true), { dark: false, sheltered: false, out: false }, 'in a hole, the player 24 blocks off: stays in, waits');
      const alone = pocketed(); alone.bot.players = {};
      assert.deepEqual(company.standing(alone.bot, null, true), { dark: true, sheltered: false, out: false }, 'alone: the routine has the night');
      assert.deepEqual(company.standing(open.bot, null, false), { dark: false, sheltered: false, out: false }, 'by day nothing changes');
    });
  });

  // ---------------------------------------------------------------- 8. out of the pocket, onto the ground
  // The pocket as the leave leaves it: three under the grass, its lid gone, its four sides open at the feet and the head.
  const opened = ({ at = [10.5, 60, 0.5], lid = false } = {}) => {
    const s = scene({ at });
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) { s.set(10 + dx, 60, dz, 'air'); s.set(10 + dx, 61, dz, 'air'); }
    if (!lid) { s.set(10, 62, 0, 'air'); s.set(10, 63, 0, 'air'); }
    return s;
  };
  const refuge = () => ({ origin: { x: 10, y: 60, z: 0 }, dimension: 'overworld' });
  const left = (over = {}) => ({ state: { leftPocket: { origin: { x: 10, y: 60, z: 0 }, rim: { x: 11, y: 64, z: 0 }, dimension: 'overworld', at: Date.now(), ...over } } });
  const waitingFor = async fn => { process.env.JEV_IDLE = 'wait'; try { return await fn(); } finally { delete process.env.JEV_IDLE; } };
  const idle = { kind: 'survive', request: 'Stay alive and prepare supplies between player requests' };

  await check('the ground a pocket was dug from: beside its open shaft, not the foot of it, not under its roof; none under rock', async () => {
    const s = opened();
    const rim = company.rimOf(s.bot, refuge().origin);
    assert.ok(rim, 'a rim');
    assert.equal(rim.y, 64, 'on the grass');
    assert.equal(Math.hypot(rim.x - 10, rim.z - 0), 1, 'beside the shaft');
    assert.equal(company.openGround(s.bot, new Vec3(10, 60, 0)), false, 'the foot of the open shaft has the sky and no side');
    assert.equal(company.openGround(s.bot, new Vec3(11, 60, 0)), false, 'an opened side is under the roof');
    assert.equal(company.openGround(s.bot, new Vec3(14, 64, 3)), true, 'the lawn');
    const shut = opened({ lid: true });
    assert.deepEqual({ ...company.rimOf(shut.bot, refuge().origin) }, { x: 10, y: 64, z: 0 }, 'with the lid still on: the grass over it');
    const roofed = opened();
    for (let x = -24; x <= 24; x++) for (let z = -24; z <= 24; z++) roofed.set(x, 70, z, 'stone');
    assert.equal(company.rimOf(roofed.bot, refuge().origin), null, 'under rock');
  });

  await check('standing in the pocket it has opened: at its foot, in a side, up its shaft; not on the grass, nor an hour on', async () => {
    const at = (x, y, z, state = left()) => { const s = opened({ at: [x, y, z] }); return company.inLeftPocket(s.bot, state); };
    assert.equal(at(10.5, 60, 0.5), true, 'the foot');
    assert.equal(at(11.5, 60, 0.5), true, 'a side');
    assert.equal(at(10.5, 62.2, 0.5), true, 'up the shaft');
    assert.equal(at(11.5, 64, 0.5), false, 'the rim');
    assert.equal(at(14.5, 64, 0.5), false, 'the lawn');
    assert.equal(at(10.5, 60, 0.5, left({ at: Date.now() - company.LEFT_MS - 1000 })), false, 'long ago');
    assert.equal(at(10.5, 60, 0.5, left({ dimension: 'the_nether' })), false, 'another dimension');
    assert.equal(at(10.5, 60, 0.5, { state: {} }), false, 'none left');
  });

  await check('the waiting does not take an opened pocket for the ground: the routine runs until the bot is up, and is ended as the climb says so', async () => {
    const foot = opened();
    assert.equal(company.holedUp(foot.bot), false, 'four sides open: no hole to the old test');
    assert.deepEqual(company.standing(foot.bot, { state: {} }, false), { dark: false, sheltered: false, out: false }, 'with nothing on record, as it was');
    const down = company.standing(foot.bot, left(), false);
    assert.deepEqual(down, { dark: false, sheltered: true, out: false }, 'by day, in the pocket it opened');
    assert.equal(company.routine({ ...down, sinceSheltered: 0 }), 'run');
    const up = opened({ at: [11.5, 64, 0.5] });
    assert.deepEqual(company.standing(up.bot, left(), false), { dark: false, sheltered: false, out: false });
    assert.equal(company.routine({ dark: false, sheltered: false, sinceSheltered: 500 }), 'finish', 'out some other way: its three seconds');
    up.bot._outAt = Date.now();
    const done = company.standing(up.bot, left(), false);
    assert.equal(done.out, true);
    assert.equal(company.routine({ ...done, sinceSheltered: 0 }), 'end', 'the climb is done: ended at once');
    up.bot._outAt = Date.now() - 60000;
    assert.equal(company.standing(up.bot, left(), false).out, false, 'a climb of a minute ago says nothing');
    // At night: alone the dark is its own again; with a player about, the opened pocket is still to be left.
    foot.bot.players = {};
    assert.deepEqual(company.standing(foot.bot, left(), true), { dark: true, sheltered: false, out: false }, 'alone at night');
    await withNight(() => {
      const kept = opened(); kept.bot.players = playerAt(10.5 + 24, 60);
      assert.deepEqual(company.standing(kept.bot, left(), true), { dark: false, sheltered: true, out: false }, 'a player 24 blocks off, the pocket already opened');
    });
  });

  await check('after the leave, the climb: up to the rim, the pocket kept on record as left, the player faced', async () => {
    await waitingFor(async () => {
      const s = opened(), survival = { bot: s.bot, state: {} };
      let saved = 0;
      const done = await company.afterLeave(survival, task, idle, () => { saved++; }, refuge(), { navigate: s.navigate, goals });
      assert.equal(done.up, true);
      assert.equal(s.walks.length, 1, 'one walk');
      assert.equal(s.bot.entity.position.y, 64, 'on the grass');
      assert.equal(survival.state.leftPocket.rim.y, 64);
      assert.equal(saved, 1);
      assert.equal(done.seen, true, 'the player ten blocks off across the lawn');
      assert.ok(s.looked.length, 'and looked at');
      assert.ok(Date.now() - s.bot._outAt < 3000, 'the climb says it is done');
      assert.equal(company.inLeftPocket(s.bot, survival), false);
      // Nobody about: up all the same.
      const lone = opened(); lone.bot.players = {};
      const alone = await company.afterLeave({ bot: lone.bot, state: {} }, task, idle, () => {}, refuge(), { navigate: lone.navigate, goals });
      assert.deepEqual(alone, { up: true });
      // The waiting ends the routine in the moment it is given.
      const cut = opened(); let checks = 0;
      const ending = { check() { if (cut.bot._outAt && ++checks > 2) { const e = new Error('ended'); e.name = 'Cancelled'; throw e; } } };
      await assert.rejects(company.afterLeave({ bot: cut.bot, state: {} }, ending, idle, () => {}, refuge(), { navigate: cut.navigate, goals }), { name: 'Cancelled' });
    });
  });

  await check('the climb is for the bot waiting and for a pocket opened for a player close by; a call walks itself, a routine at its own day goes on', async () => {
    const tried = async (goal, options, env = {}) => {
      const s = opened(), survival = { bot: s.bot, state: {} };
      Object.assign(process.env, env);
      try { return { done: await company.afterLeave(survival, task, goal, () => {}, refuge(), { navigate: s.navigate, goals, ...options }), walks: s.walks.length, left: !!survival.state.leftPocket }; }
      finally { for (const k of Object.keys(env)) delete process.env[k]; }
    };
    assert.deepEqual(await tried(idle, {}), { done: null, walks: 0, left: false }, 'the routine at its own day');
    assert.deepEqual(await tried(call(), { drawnOut: 'the call' }), { done: null, walks: 0, left: false }, 'a call');
    assert.deepEqual(await tried(call({ kind: 'obtain' }), {}, { JEV_IDLE: 'wait' }), { done: null, walks: 0, left: false }, 'work in hand while waiting is the mode');
    const drawn = await tried(call({ kind: 'follow' }), { drawnOut: 'a player close by' });
    assert.equal(drawn.done.up, true); assert.equal(drawn.left, true); assert.equal(drawn.walks, 1);
    // A house is not climbed out of, and under rock there is nowhere to climb to.
    const s = opened(); for (let x = -24; x <= 24; x++) for (let z = -24; z <= 24; z++) s.set(x, 70, z, 'stone');
    const under = { bot: s.bot, state: {} };
    assert.equal(await waitingFor(() => company.afterLeave(under, task, idle, () => {}, refuge(), { navigate: s.navigate, goals })), null);
    assert.equal(under.state.leftPocket, undefined);
    const house = opened();
    assert.equal(await waitingFor(() => company.afterLeave({ bot: house.bot, state: {} }, task, idle, () => {}, { ...refuge(), kind: 'house' }, { navigate: house.navigate, goals })), null);
  });

  await check('a climb that fails leaves the pocket on record, so the routine is not ended at the foot of it; a cancel is passed up', async () => {
    await waitingFor(async () => {
      const s = opened(), survival = { bot: s.bot, state: {} };
      const stuck = async () => { const e = new Error('no path'); e.name = 'NoRoute'; throw e; };
      const done = await company.afterLeave(survival, task, idle, () => {}, refuge(), { navigate: stuck, goals });
      assert.equal(done.up, false);
      assert.equal(s.bot._outAt, undefined);
      assert.equal(company.standing(s.bot, survival, false).sheltered, true, 'still to be got out of');
      const cancelled = async () => { const e = new Error('stop'); e.name = 'Cancelled'; throw e; };
      await assert.rejects(company.afterLeave({ bot: opened().bot, state: {} }, task, idle, () => {}, refuge(), { navigate: cancelled, goals }), { name: 'Cancelled' });
    });
  });

  await check('while the climb is in hand the routine is not ended, whatever the ground says; a pocket built on the grass is not walked back through', async () => {
    const s = scene({ at: [10.5, 64, 0.5] });
    assert.deepEqual(company.standing(s.bot, { state: {} }, false), { dark: false, sheltered: false, out: false });
    s.bot._climbing = Date.now();
    assert.equal(company.standing(s.bot, { state: {} }, false).sheltered, true, 'the climb in hand');
    assert.equal(company.routine({ ...company.standing(s.bot, { state: {} }, false), sinceSheltered: 60000 }), 'run');
    s.bot._climbing = Date.now() - company.CLIMB_MS - 1000;
    assert.equal(company.standing(s.bot, { state: {} }, false).sheltered, false, 'a climb of long ago is not believed');
    // A hut on the lawn, its doorway walked out of by the leave: the bot stands on the grass two blocks from where it sat.
    const hut = scene({ at: [12.5, 64, 0.5] });
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [64, 65]) if (dx !== 1) hut.set(10 + dx, y, dz, 'dirt');
    hut.set(10, 66, 0, 'dirt');
    let during = null;
    const walk = async (b, t, goal) => { during = company.standing(b, { state: {} }, true).sheltered; b.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); };
    hut.bot.players = { Caller: { entity: { position: new Vec3(30.5, 64, 0.5), id: 2, type: 'player' } } };   // not close: no walk into view either
    const done = await company.afterLeave({ bot: hut.bot, state: {} }, task, call({ kind: 'follow' }), () => {}, { origin: { x: 10, y: 64, z: 0 }, dimension: 'overworld' }, { drawnOut: 'a player close by', navigate: walk, goals });
    assert.equal(done.up, true);
    assert.equal(during, null, 'already on the grass: no walk back to a rim');
    assert.deepEqual({ ...hut.bot.entity.position }, { x: 12.5, y: 64, z: 0.5 });
    assert.equal(hut.bot._climbing, undefined, 'and the climb is over');
    // With the player close and out of view behind the hut, the walk into view is made with the climb in hand.
    const near = scene({ at: [12.5, 64, 0.5], player: [6.5, 64, 0.5] });
    for (const dz of [-1, 0, 1]) for (const y of [64, 65, 66]) near.set(10, y, dz, 'dirt');
    let held = null;
    const into = async (b, t, goal) => { held = company.standing(b, { state: {} }, false).sheltered; b.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); };
    const seen = await company.afterLeave({ bot: near.bot, state: {} }, task, call({ kind: 'follow' }), () => {}, { origin: { x: 10, y: 64, z: 0 }, dimension: 'overworld' }, { drawnOut: 'a player close by', navigate: into, goals });
    assert.equal(held, true, 'the routine is kept for the walk');
    assert.equal(seen.seen, true);
  });

  await check('in the step itself: a pocket opened for a player close by is climbed out of; one opened for a call is not', async () => {
    await withNight(async () => {
      const out = await inPocket(idle);
      assert.equal(out.did, 'leave');
      assert.ok(out.survival.state.leftPocket, 'kept on record as left');
      assert.equal(out.bot.entity.position.y, 64, 'up on the grass');
      assert.ok(out.said.some(l => /out of the pocket: up on the ground/.test(l)), out.said.join(' / ').slice(0, 300));
    });
    const called = await inPocket(call());
    assert.equal(called.did, 'leave');
    assert.equal(called.survival.state.leftPocket, undefined);
    assert.equal(called.walks.length, 0, 'the call walks itself');
  });

  // ---------------------------------------------------------------- 9. whose turn it is in a pocket that is to be left
  await check('what a pocket is opened for by rule: a call, a player come close at night, the day for the bot waiting', async () => {
    const at = (timeOfDay, players) => { const { bot } = scene({ at: [10.5, 64, 0.5] }); bot.time.timeOfDay = timeOfDay; if (players) bot.players = players; return bot; };
    assert.equal(company.drawnOut(at(16000), call()), 'the call');
    assert.equal(company.drawnOut(at(16000), idle), null, 'night, the switch not set');
    assert.equal(company.drawnOut(at(6000), idle), null, 'day, not waiting');
    await waitingFor(() => {
      assert.equal(company.drawnOut(at(6000), idle), 'the day');
      assert.equal(company.drawnOut(at(23600), idle), 'the day', 'after the dark has ended');
      assert.equal(company.drawnOut(at(16000), idle), null, 'night alone: the pocket is its shelter');
      assert.equal(company.drawnOut(at(6000), call({ kind: 'obtain' })), null, 'work in hand by day is not the waiting');
    });
    await withNight(() => {
      assert.equal(company.drawnOut(at(16000), idle), 'a player close by');
      assert.equal(company.drawnOut(at(10000), idle, true), 'a player close by', 'the survival layer\'s night begins at 9500');
      assert.equal(company.drawnOut(at(16000, playerAt(10.5 + 24)), idle), null, 'the player 24 blocks off');
      assert.equal(company.drawnOut(at(6000), idle), null, 'by day a player close by opens nothing');
    });
  });

  await check('the pocket\'s turn is not weighed against the waiting bot\'s own work, where the pocket is to be left; elsewhere the two are weighed as before', async () => {
    const claims = [{ layer: 'survival', action: 'pocket_next', urgency: 'routine' }, null, { layer: 'work', action: 'step', urgency: 'routine' }];
    const at = (timeOfDay, players) => { const { bot } = scene({ at: [10.5, 60, 0.5] }); bot.time.timeOfDay = timeOfDay; if (players) bot.players = players; return bot; };
    assert.equal(company.pocketFirst(at(6000), idle, claims), false, 'not waiting');
    await waitingFor(async () => {
      assert.equal(company.pocketFirst(at(6000), idle, claims), true, 'by day');
      assert.equal(company.pocketFirst(at(16000), idle, claims), false, 'at night alone');
      assert.equal(company.pocketFirst(at(6000), idle, [{ layer: 'survival', action: 'obtain_food' }, claims[2]]), false, 'not in a pocket');
      assert.equal(company.pocketFirst(at(6000), idle, [claims[2]]), false, 'no claim of the survival layer');
      assert.equal(company.pocketFirst(at(6000), call({ kind: 'obtain' }), claims), false, 'a request in hand');
      await withNight(() => {
        assert.equal(company.pocketFirst(at(16000), idle, claims), true, 'at night, a player close by');
        assert.equal(company.pocketFirst(at(16000, playerAt(10.5 + 24, 60)), idle, claims), false, 'the player 24 blocks off');
      });
    });
  });

  await check('sealed in at a start with a player close by: the survival layer claims the pocket\'s turn, and the work is not weighed against that claim', async () => {
    // A start on 2026-11-21 as its flight record has it: the claims were survival (pocket_next, a "stay" held from before the restart) and work, and the work was given the turn.
    await waitingFor(async () => { await withNight(async () => {
      const s = scene({ at: [10.5, 60, 0.5] });
      s.set(10, 60, 0, 'air'); s.set(10, 61, 0, 'air');
      s.bot.time.timeOfDay = 13498; s.bot.entities = {};
      const refuge = { origin: { x: 10, y: 60, z: 0 }, dimension: 'overworld', createdAt: new Date().toISOString(), emergency: true, shaft: true, top: { x: 10, y: 64, z: 0 }, verifiedAt: Date.now() };
      const survival = createSurvival(s.bot, { state: { shelters: [refuge] }, client: null });
      const claim = require('../src/survival').claim(s.bot, idle, survival);
      assert.equal(claim?.action, 'pocket_next', JSON.stringify(claim || null).slice(0, 200));
      const work = { layer: 'work', action: 'step', urgency: 'routine' };
      assert.equal(company.darkNow(s.bot), true);
      assert.equal(company.pocketFirst(s.bot, idle, [claim, null, null, work]), true);
      s.bot.players = playerAt(10.5 + 24, 60);
      assert.equal(company.pocketFirst(s.bot, idle, [claim, null, null, work]), false, 'the player 24 blocks off: weighed as before');
    }); });
  });

  await check('in the step itself, by day, the bot waiting: the pocket is opened by rule and climbed out of; with a mob about it is asked as before', async () => {
    await waitingFor(async () => {
      const out = await inPocket(idle, { timeOfDay: 6000 });
      assert.equal(out.did, 'leave', out.said.slice(0, 4).join(' / '));
      assert.ok(out.said.some(l => /opened for the day/.test(l)), out.said.join(' / ').slice(0, 300));
      assert.equal(out.bot.entity.position.y, 64, 'up on the grass');
      const zombie = { 7: { id: 7, name: 'zombie', type: 'hostile', kind: 'Hostile mobs', displayName: 'Zombie', position: new Vec3(14.5, 64, 0.5), velocity: new Vec3(0, 0, 0), height: 1.95, width: 0.6, isValid: true, metadata: [] } };
      assert.equal((await inPocket(idle, { timeOfDay: 6000, entities: zombie })).did, 'asked', 'a zombie four blocks from the lid');
    });
    // Not waiting: the routine at its own day goes its own way out, with no rule of the waiting and no climb.
    const own = await inPocket(idle, { timeOfDay: 6000 });
    assert.ok(!own.said.some(l => /\[company\]/.test(l)), own.said.filter(l => /company/.test(l)).join(' / '));
    assert.equal(own.survival.state.leftPocket, undefined);
  });

  // ---------------------------------------------------------------- back to its player after monsters
  const T0 = 1_000_000;
  await check('ground given while waiting with a player is a scare to come back from; alone, or with the company long past, it is nothing', async () => {
    const { bot } = scene({ at: [6.5, 64, 0.5] });
    assert.equal(company.gaveGround(bot, T0), null, 'nobody noted yet');
    assert.deepEqual(company.withPlayer(bot, T0), { name: 'Caller', position: { x: 0.5, y: 64, z: 0.5 }, at: T0 });
    const scare = company.gaveGround(bot, T0 + 1000);
    assert.equal(scare.with, 'Caller'); assert.equal(scare.tries, 0); assert.equal(scare.at, T0 + 1000);
    // more ground given: the same scare, its quiet counted from the last of it
    assert.equal(company.gaveGround(bot, T0 + 4000), scare); assert.equal(scare.at, T0 + 1000); assert.equal(scare.last, T0 + 4000);
    // the player's place is kept while they are in view
    bot.players.Caller.entity.position = new Vec3(2.5, 64, 3.5); company.withPlayer(bot, T0 + 4500);
    assert.deepEqual(scare.position, { x: 2.5, y: 64, z: 3.5 });
    // a scare long over is not carried on: the next ground given starts another, if a player is by
    const later = T0 + 1000 + company.BACK_HOLDS_MS + 1;
    assert.equal(company.gaveGround(bot, later), null, 'the company of a quarter of an hour ago is nobody');
    assert.equal(bot._scare, undefined);
    // no player within the distance that keeps it up at night: no company, no scare
    const far = scene({ at: [6.5, 64, 0.5], player: [6.5 + company.STAY_UP + 2, 64, 0.5] }).bot;
    assert.equal(company.withPlayer(far, T0), null); assert.equal(company.gaveGround(far, T0 + 100), null);
    // company seen half a minute ago and more is not company: the bot went off to work since
    const worked = scene({ at: [6.5, 64, 0.5] }).bot; company.withPlayer(worked, T0);
    assert.equal(company.gaveGround(worked, T0 + company.WITH_MS + 1), null);
    // a request or a stop ends it
    const asked = scene({ at: [6.5, 64, 0.5] }).bot; company.withPlayer(asked, T0); company.gaveGround(asked, T0 + 10);
    company.letGo(asked); assert.equal(asked._scare, undefined); assert.equal(asked._company, undefined);
  });

  await check('the walk back is due once the bot has given no ground for three seconds, is off from its player, and no monster is about them', async () => {
    const scared = (over = {}) => { const s = scene({ at: [26.5, 64, 0.5], ...over }); company.withPlayer(s.bot, T0); s.bot.entity.position = new Vec3(20.5, 64, 0.5); const scare = company.gaveGround(s.bot, T0); return { ...s, scare }; };
    const day = { dark: false }, quiet = T0 + company.BACK_QUIET_MS;
    let { bot, scare } = scared();
    assert.equal(company.backDue(bot, { ...day, now: quiet - 1 }), null, 'still giving ground a moment ago');
    assert.equal(company.backDue(bot, { ...day, now: quiet }), scare, '20 blocks off and quiet');
    assert.equal(company.backDue(bot, { ...day, now: quiet, hostileNear: (at, blocks) => blocks === company.NEAR_PLAYER && at.x === 0.5 }), null, 'a monster by the player: not yet');
    assert.equal(bot._scare, scare, 'and the scare is kept for when it is gone');
    // a walk made: not another for twenty seconds, and three in all
    scare.tries = 1; scare.triedAt = quiet;
    assert.equal(company.backDue(bot, { ...day, now: quiet + company.BACK_RETRY_MS - 1 }), null);
    assert.equal(company.backDue(bot, { ...day, now: quiet + company.BACK_RETRY_MS }), scare);
    scare.tries = company.BACK_TRIES;
    assert.equal(company.backDue(bot, { ...day, now: quiet + 60000 }), null); assert.equal(bot._scare, undefined, 'three walks failed: let go');
    // back with them already (it ran four blocks, or the player came over): nothing to walk, and the scare is over
    ({ bot, scare } = scared()); bot.entity.position = new Vec3(0.5 + company.BACK_OFF - 1, 64, 0.5);
    assert.equal(company.backDue(bot, { ...day, now: quiet }), null); assert.equal(bot._scare, undefined);
    // the player out of view: by day to where they were last seen, by night not at all (the shelter comes first)
    ({ bot, scare } = scared()); bot.players.Caller.entity = null;
    assert.equal(company.backDue(bot, { dark: false, now: quiet }), scare); assert.deepEqual(scare.position, { x: 0.5, y: 64, z: 0.5 });
    assert.equal(company.backDue(bot, { dark: true, now: quiet }), null); assert.equal(bot._scare, scare, 'kept for the morning');
    bot.players.Caller.entity = { position: new Vec3(0.5, 64, 0.5) };
    assert.equal(company.backDue(bot, { dark: true, now: quiet }), scare, 'in view, the night does not hold it');
    // the player gone from the game, or the scare a quarter of an hour old: let go
    bot.players = {}; assert.equal(company.backDue(bot, { ...day, now: quiet }), null); assert.equal(bot._scare, undefined);
    ({ bot, scare } = scared());
    assert.equal(company.backDue(bot, { ...day, now: T0 + company.BACK_HOLDS_MS + 1 }), null); assert.equal(bot._scare, undefined);
    assert.equal(company.backDue(scene().bot, { ...day, now: quiet }), null, 'no scare, no walk');
  });

  await check('the walk back is the bot\'s own errand: nobody is asked before another player\'s request replaces it, and it is not announced on arriving', async () => {
    const handoff = require('../src/handoff').createHandoff();
    const online = () => true;
    assert.equal(handoff.holder({ active: { goal: { kind: 'come', from: 'Ann' } }, from: 'Ben', online }), 'Ann', 'a call a player made is theirs');
    assert.equal(handoff.holder({ active: { goal: { kind: 'come', from: 'Ann', back: true } }, from: 'Ben', online }), null);
    const { completion } = require('../src/speech');
    assert.equal(completion({ kind: 'come', target: 'Ann', from: 'Ann', back: true }), '');
    assert.match(completion({ kind: 'come', target: 'Ann', from: 'Ann' }), /I'm here with Ann/);
    assert.match(completion({ kind: 'come', target: 'Ann', from: 'Ann', back: true, callerLeft: true }), /has left the game/);
  });

  // ---------------------------------------------------------------- to bed when the players go
  const bedtime = require('../src/bedtime');
  const Block = require('prismarine-block')(registry);
  const POSE = registry.entitiesByName.player.metadataKeys.indexOf('pose');
  const NIGHT = 14000;
  // A bed lying north to south: its foot at (x, 64, z), its pillow one block north of it.
  const bed = (world, x, z, { occupied = false } = {}) => {
    for (const [part, dz] of [['foot', 0], ['head', -1]]) world.setBlockStateId(new Vec3(x, 64, z + dz), Block.fromProperties(registry.blocksByName.red_bed.id, { facing: 'north', occupied, part }, 0).stateId);
    return { foot: new Vec3(x, 64, z), head: new Vec3(x, 64, z - 1) };
  };
  // The bot at night with its player in a bed, six blocks off.
  function bedroom({ at = [6.5, 64, 0.5], time = NIGHT } = {}) {
    const s = scene({ at, player: [0.5, 64.6875, -0.5] });
    const { bot, caller } = s, said = [], slept = [], during = [];
    bed(bot.world, 0, 0, { occupied: true });
    caller.metadata = []; caller.metadata[POSE] = 2;
    bot.time = { timeOfDay: time, day: 3 };
    bot.findBlocks = ({ matching, maxDistance, count }) => {
      const ids = new Set([].concat(matching)), c = bot.entity.position.floored(), r = Math.ceil(maxDistance), out = [];
      for (let x = c.x - r; x <= c.x + r; x++) for (let z = c.z - r; z <= c.z + r; z++) { const p = new Vec3(x, 64, z), b = bot.blockAt(p); if (b && ids.has(b.type) && p.distanceTo(bot.entity.position) <= maxDistance) out.push(p); }
      return out.slice(0, count);
    };
    bot.pathfinder.movements = { canDig: true, allow1by1towers: true, scafoldingBlocks: [1, 2] };
    bot.isSleeping = false; bot._survivalState = {};
    bot.sleep = async block => { slept.push(block.position.clone()); bot.isSleeping = true; };
    bot.wake = async () => { bot.isSleeping = false; };
    const navigate = async (b, t, goal, options) => { during.push({ ...b.pathfinder.movements, options }); b.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); };
    return { ...s, said, slept, during, navigate, opts: { navigate, goals, say: line => said.push(line), log: () => {} } };
  }

  await check('a player in bed is known by the pose the game sends, or by the bed they lie in', async () => {
    assert.ok(POSE >= 0, 'the registry names the pose');
    const { bot, caller } = bedroom();
    assert.equal(bedtime.asleep(bot, caller), true);
    caller.metadata[POSE] = 0; assert.equal(bedtime.asleep(bot, caller), true, 'no pose, but at the pillow of an occupied bed');
    bed(bot.world, 0, 0, { occupied: false }); assert.equal(bedtime.asleep(bot, caller), false, 'standing on a bed nobody lies in');
    caller.position = new Vec3(3.5, 64, 3.5); caller.metadata[POSE] = 2; assert.equal(bedtime.asleep(bot, caller), true, 'the pose alone');
    caller.metadata = undefined; assert.equal(bedtime.asleep(bot, caller), false);
    assert.equal(bedtime.asleep(bot, null), false);
  });

  await check('all asleep is every other player in the game, each one in view; nobody else in the game is nobody to go to bed with', async () => {
    const { bot } = bedroom();
    assert.equal(bedtime.allAsleep(bot), true);
    bot.players.Ben = { entity: { position: new Vec3(3.5, 64, 3.5), metadata: [] } };
    assert.equal(bedtime.allAsleep(bot), false, 'one of two is up');
    bot.players.Ben.entity.metadata[POSE] = 2; assert.equal(bedtime.allAsleep(bot), true);
    bot.players.Ben.entity = null; assert.equal(bedtime.allAsleep(bot), false, 'out of view is not known to be asleep');
    bot.players.Ben.gamemode = 3; assert.equal(bedtime.allAsleep(bot), true, 'one only looking on is not counted');
    bot.players = { Jev: { entity: bot.entity } }; assert.equal(bedtime.allAsleep(bot), false);
  });

  await check('the free beds within sixteen blocks, nearest first: whole, nobody in them, a cell to stand in beside the foot', async () => {
    const { bot, set } = bedroom();
    assert.deepEqual(bedtime.freeBeds(bot), [], 'the only bed is the player\'s');
    const near = bed(bot.world, 4, 3), further = bed(bot.world, -4, 6);
    bed(bot.world, 6.5 + bedtime.BED_REACH + 2, 0);
    const found = bedtime.freeBeds(bot);
    assert.deepEqual(found.map(b => [b.foot.x, b.foot.z]), [[4, 3], [-4, 6]]);
    assert.ok(found[0].head.equals(near.head)); assert.ok(!found[0].stand.equals(near.head) && found[0].stand.distanceTo(near.foot) === 1);
    // walled in on the three open sides of its foot: no cell to stand in, so it is not offered
    for (const [x, z] of [[-5, 6], [-3, 6], [-4, 7]]) { set(x, 64, z, 'stone'); set(x, 65, z, 'stone'); }
    assert.deepEqual(bedtime.freeBeds(bot).map(b => [b.foot.x, b.foot.z]), [[4, 3]]);
    assert.ok(further);
    // half a bed is no bed
    bot.world.setBlockStateId(near.head, registry.blocksByName.air.defaultState);
    assert.deepEqual(bedtime.freeBeds(bot), []);
    bot.game.dimension = 'the_nether'; bed(bot.world, 4, 3); assert.deepEqual(bedtime.freeBeds(bot), [], 'a bed is lain in only in the Overworld');
  });

  await check('bed is due at night with every player in one, and not by day, in bed already, or after two walks that failed', async () => {
    const { bot, caller } = bedroom();
    assert.equal(bedtime.due(bot, T0), true);
    bot.time.timeOfDay = 6000; assert.equal(bedtime.due(bot, T0), false, 'by day');
    bot.isRaining = true; bot.thunderState = 1; assert.equal(bedtime.due(bot, T0), true, 'a thunderstorm lets a bed be lain in');
    bot.isRaining = false; bot.time.timeOfDay = NIGHT;
    caller.metadata[POSE] = 0; bed(bot.world, 0, 0); assert.equal(bedtime.due(bot, T0), false, 'the player is up');
    caller.metadata[POSE] = 2;
    bot.isSleeping = true; assert.equal(bedtime.due(bot, T0), false); bot.isSleeping = false;
    const night = bedtime.nightOf(bot); night.at = T0; assert.equal(bedtime.due(bot, T0 + bedtime.RETRY_MS - 1), false, 'looked a moment ago');
    assert.equal(bedtime.due(bot, T0 + bedtime.RETRY_MS), true);
    night.tries = bedtime.TRIES; assert.equal(bedtime.due(bot, T0 + 60000), false);
    bot.time.day = 4; assert.equal(bedtime.due(bot, T0 + 60000), true, 'another night, another record');
  });

  await check('to bed: the walk digs, pillars and bridges nothing; the bot lies down, keeps the bed as its respawn, and is up when its player is', async () => {
    const { bot, caller, said, slept, during, opts } = bedroom();
    const spare = bed(bot.world, 4, 3);
    const run = bedtime.toBed(bot, task, opts);
    for (let i = 0; i < 50 && !bot.isSleeping; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(bot.isSleeping, true);
    assert.equal(during.length, 1);
    assert.deepEqual([during[0].canDig, during[0].allow1by1towers, during[0].scafoldingBlocks], [false, false, []]);
    assert.equal(during[0].options.stopWhen(), false); assert.equal(during[0].options.sprint, true);
    assert.deepEqual(bot.pathfinder.movements, { canDig: true, allow1by1towers: true, scafoldingBlocks: [1, 2] }, 'put back after the walk');
    assert.ok(slept[0].equals(spare.foot)); assert.ok(bot.entity.position.distanceTo(spare.foot.offset(0.5, 0, 0.5)) <= 1.5, 'beside the foot');
    assert.deepEqual({ ...bot._survivalState.spawnBed, at: undefined }, { name: 'red_bed', foot: { x: 4, y: 64, z: 3 }, head: { x: 4, y: 64, z: 2 }, at: undefined, guest: true });
    assert.deepEqual(said, ['Good night!']);
    // the player gets up: so does the bot
    caller.metadata[POSE] = 0; bed(bot.world, 0, 0, { occupied: false });
    const result = await run;
    assert.equal(result.outcome, 'slept'); assert.equal(bot.isSleeping, false);
    assert.equal(bedtime.nightOf(bot).tries, 0, 'a night in bed is not a walk that failed');
  });

  await check('to bed: morning or something coming for it ends the night in bed, and a cancel leaves the bot on its feet', async () => {
    for (const end of ['morning', 'trouble', 'cancel']) {
      const { bot, opts } = bedroom(); bed(bot.world, 4, 3);
      let threat = false; const own = { cancelled: false, check() { if (this.cancelled) throw Object.assign(new Error('cancelled'), { name: 'Cancelled' }); } };
      const run = bedtime.toBed(bot, own, { ...opts, trouble: () => threat }).catch(err => err);
      for (let i = 0; i < 50 && !bot.isSleeping; i++) await new Promise(r => setTimeout(r, 20));
      assert.equal(bot.isSleeping, true, end);
      if (end === 'morning') bot.time.timeOfDay = 100; else if (end === 'trouble') threat = true; else own.cancelled = true;
      const result = await run;
      assert.equal(bot.isSleeping, false, end);
      if (end === 'cancel') assert.equal(result.name, 'Cancelled'); else assert.equal(result.outcome, 'slept', end);
    }
    // trouble before it has set out: no walk
    const { bot, during, opts } = bedroom(); bed(bot.world, 4, 3);
    assert.equal((await bedtime.toBed(bot, task, { ...opts, trouble: () => true })).outcome, 'stopped'); assert.equal(during.length, 0);
  });

  await check('to bed with no free bed in reach: said once a night, and the bot stays up; a bed that will not have it is left after two walks', async () => {
    const { bot, said, during, opts } = bedroom();
    assert.equal((await bedtime.toBed(bot, task, opts)).outcome, 'no_bed');
    assert.equal((await bedtime.toBed(bot, task, opts)).outcome, 'no_bed');
    assert.deepEqual(said, ["There's no free bed near here, so I'll stay up and keep watch."]);
    assert.equal(during.length, 0); assert.equal(bedtime.nightOf(bot).tries, 0, 'looking is not a walk');
    assert.equal(bedtime.due(bot), false, 'not looked for again at once'); assert.equal(bedtime.due(bot, Date.now() + bedtime.RETRY_MS), true, 'a bed put down for it later is found');
    // the game refuses the bed
    const refused = bedroom(); bed(refused.bot.world, 4, 3);
    refused.bot.sleep = async () => { throw new Error('there are monsters nearby'); };
    const first = await bedtime.toBed(refused.bot, task, refused.opts);
    assert.equal(first.outcome, 'refused'); assert.match(first.reason, /monsters nearby/);
    assert.equal(refused.bot._survivalState.spawnBed, undefined, 'not lain in: no respawn recorded');
    await bedtime.toBed(refused.bot, task, refused.opts);
    assert.deepEqual(refused.said, ["I can't get into the free bed (there are monsters nearby), so I'll stay up."]);
    assert.equal(bedtime.nightOf(refused.bot).tries, 2); assert.equal(bedtime.due(refused.bot, Date.now() + 60000), false);
    // no way to it: the walk fails, nothing is dug
    const walled = bedroom(); bed(walled.bot.world, 4, 3);
    const none = await bedtime.toBed(walled.bot, task, { ...walled.opts, navigate: async () => { throw new Error('No path to the goal'); } });
    assert.equal(none.outcome, 'no_way'); assert.equal(walled.bot.isSleeping, false);
    assert.deepEqual(walled.bot.pathfinder.movements, { canDig: true, allow1by1towers: true, scafoldingBlocks: [1, 2] });
  });

  await check('the waiting bot\'s bedtime: begun when due, busy until it is on its feet again, and ended by a cancel', async () => {
    const { bot, navigate } = bedroom(); bed(bot.world, 4, 3);
    let busy = false;
    const manager = bedtime.createBedtime({ bot, navigate, goals, isBusy: () => busy });
    busy = true; assert.equal(manager.tick(), false, 'a request in hand'); busy = false;
    bot.time.timeOfDay = 6000; assert.equal(manager.tick(), false, 'by day'); bot.time.timeOfDay = NIGHT;
    bot.chat = () => {};
    assert.equal(manager.tick(), true); assert.equal(manager.busy(), true); assert.equal(manager.tick(), true, 'one at a time');
    for (let i = 0; i < 50 && !bot.isSleeping; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(bot.isSleeping, true);
    await manager.cancel();
    assert.equal(bot.isSleeping, false); assert.equal(manager.busy(), false);
    // a request arriving ends it too: busy says so, and the routine stops itself
    assert.equal(manager.tick(), false, 'looked a moment ago');
  });

  await check('getting out of bed is asked for by name where the game names its actions, and by the library\'s own number where it does not', async () => {
    const { fixWake } = require('../src/compatibility');
    const written = [], own = async () => {};
    const sleeper = { registry, isSleeping: true, entity: { id: 7 }, wake: own, _client: { write: (name, packet) => written.push([name, packet]) } };
    assert.equal(fixWake(sleeper), true, '26.1 names them');
    await sleeper.wake();
    assert.deepEqual(written, [['entity_action', { entityId: 7, actionId: 'leave_bed', jumpBoost: 0 }]]);
    sleeper.isSleeping = false; await assert.rejects(sleeper.wake(), /already awake/);
    // what goes over the wire: action 0 for the name, where the library's number 2 is "stop sprinting" now
    const serializer = require('minecraft-protocol').createSerializer({ state: 'play', isServer: false, version: '26.1', customPackets: {} });
    const bytes = actionId => serializer.createPacketBuffer({ name: 'entity_action', params: { entityId: 7, actionId, jumpBoost: 0 } }).toString('hex');
    assert.equal(bytes('leave_bed').slice(-4, -2), '00'); assert.equal(bytes(2), bytes('stop_sprinting'));
    // an older game numbers them: the library's wake is left as it is
    const old = { registry: require('prismarine-registry')('1.20.4'), isSleeping: true, entity: { id: 7 }, wake: own, _client: { write() {} } };
    assert.equal(fixWake(old), false); assert.equal(old.wake, own);
  });

  await check('the players\' spare bed the bot lay in is its respawn and nothing more: no chest goes by it, and it is not taken up for a portal camp', async () => {
    const { bedKitHome } = require('../src/bed-kit');
    const camp = require('../src/portal-camp');
    const { bot } = bedroom({ at: [6.5, 64, 0.5], time: 1000 });
    bed(bot.world, 4, 0);
    bot.game = { ...bot.game, gameMode: 'survival', dimension: 'overworld' };
    bot.entities = { [bot.entity.id ?? 1]: bot.entity };
    const record = guest => ({ name: 'red_bed', foot: { x: 4, y: 64, z: 0 }, head: { x: 4, y: 64, z: -1 }, at: new Date().toISOString(), ...(guest && { guest: true }) });
    const goal = { kind: 'win', survival: {}, portals: [{ dimension: 'overworld', x: 204, y: 64, z: 0 }] };
    // its own bed (a bed its own night was slept in): a home for a kit chest, and the bed a portal camp is made of
    bot._survivalState = { spawnBed: record(false) };
    assert.ok(bedKitHome(bot, goal), 'a bed of its own is a home');
    const own = camp.offer(bot, goal);
    assert.ok(own?.takeUp, 'a bed of its own is offered for the camp');
    assert.deepEqual(own.takeUp.foot, { x: 4, y: 64, z: 0 });
    // the same bed lain in as a guest: neither
    bot._survivalState = { spawnBed: record(true) };
    assert.equal(bedKitHome(bot, goal), null);
    assert.equal(camp.offer(bot, goal), null, 'with no bed carried and only a guest bed, no camp is offered');
  });

  await check('the walk back waits while a monster is still after the bot', async () => {
    const { bot } = scene({ at: [20.5, 64, 0.5], player: [0.5, 64, 0.5] });
    bot._scare = { with: 'Caller', position: { x: 0.5, y: 64, z: 0.5 }, at: T0, last: T0, tries: 0, triedAt: 0 };
    const at = T0 + company.BACK_QUIET_MS + 1;
    assert.equal(company.backDue(bot, { now: at, dark: false, chased: () => true }), null);
    assert.ok(bot._scare, 'the scare is kept for when the monster is gone');
    assert.equal(company.backDue(bot, { now: at, dark: false, chased: () => false, hostileNear: () => true }), null);
    assert.equal(company.backDue(bot, { now: at, dark: false, chased: () => false, hostileNear: () => false }), bot._scare);
  });

  // ---------------------------------------------------------------- 8. mirrored: no cover while a player near has none (2026-11-22)
  const mob = (id, name, x, y = 64, z = 0.5) => ({ [id]: { id, name, type: 'hostile', kind: 'Hostile mobs', displayName: name, position: new Vec3(x, y, z), velocity: new Vec3(0, 0, 0), height: 1.95, width: 0.6, isValid: true, metadata: [] } });
  await check('a roof over the player is cover; open sky or leaves overhead is not', async () => {
    const s = scene();
    assert.equal(company.underCover(s.bot, s.caller), false, 'the lawn');
    s.set(0, 67, 0, 'oak_leaves');
    assert.equal(company.underCover(s.bot, s.caller), false, 'under a tree');
    s.set(0, 70, 0, 'stone');
    assert.equal(company.underCover(s.bot, s.caller), true, 'a stone roof six blocks up');
    assert.equal(company.underCover(s.bot, null), false);
  });
  await check('at night the hiding ways are left off a fight while a player within 32 blocks is out in the open; under a roof, farther off, by day or at 8 health they are not', async () => {
    const goal = { kind: 'survive', request: 'Stay alive' };
    const night = (setup = () => {}) => { const s = scene({ at: [10.5, 64, 0.5] }); s.bot.time.timeOfDay = 16000; setup(s); return s; };
    assert.equal(company.keepsOut(night().bot, goal), null, 'JEV_NIGHT not set');
    await withNight(() => {
      const out = company.keepsOut(night().bot, goal);
      assert.equal(out?.player, 'Caller'); assert.match(out.why, /out in the open 10 blocks off/);
      assert.equal(company.keepsOut(night(s => s.set(0, 67, 0, 'stone')).bot, goal), null, 'the player under a roof: mirrored, the bot may take cover');
      assert.equal(company.keepsOut(night(s => { s.bot.players = playerAt(10.5 + 40); }).bot, goal), null, 'the player 40 blocks off: the bot looks after itself');
      assert.equal(company.keepsOut(night(s => { s.bot.time.timeOfDay = 6000; }).bot, goal), null, 'by day');
      assert.equal(company.keepsOut(night(s => { s.bot.health = 8; }).bot, goal), null, 'at 8 health it may save itself');
      assert.ok(company.keepsOut(night(s => { s.bot.health = 9; }).bot, goal), 'at 9 it fights on');
      // Two players near, one under a roof: the one out in the open is mirrored.
      const two = night(s => { s.set(0, 67, 0, 'stone'); s.bot.players.Robin = { entity: { position: new Vec3(14.5, 64, 0.5), id: 3, type: 'player' } }; });
      assert.equal(company.keepsOut(two.bot, goal)?.player, 'Robin');
    });
  });
  await check('the hiding ways are taken out of a fight while another way stays; with none left they all stay', async () => {
    const options = { fight: {}, retreat: {}, pillar: {}, seal: {}, nook: {}, dig_in: {} };
    assert.deepEqual(company.withhold(options, { why: 'x' }).sort(), ['dig_in', 'nook', 'pillar', 'seal']);
    assert.deepEqual(Object.keys(options).sort(), ['fight', 'retreat']);
    const hidesOnly = { pillar: {}, seal: {}, none_good: {} };
    assert.deepEqual(company.withhold(hidesOnly, { why: 'x' }), [], 'nothing else on offer: left as they were');
    assert.deepEqual(Object.keys(hidesOnly).sort(), ['none_good', 'pillar', 'seal']);
    assert.deepEqual(company.withhold({ pillar: {}, fight: {} }, null), [], 'not kept out');
  });
  await check('the night mine is not dug with a player near, nor while following one in view', async () => {
    await withNight(() => {
      const s = scene({ at: [10.5, 64, 0.5] }); s.bot.time.timeOfDay = 16000; s.bot.entities = {};
      s.bot.inventory = { slots: [], items: () => [{ name: 'iron_pickaxe', count: 1, type: 1, durabilityUsed: 0, maxDurability: 250, slot: 36 }], count: () => 0 };
      const survival = createSurvival(s.bot, { state: {}, client: null });
      assert.equal(survival.canNightMine({ kind: 'survive', request: 'Stay alive' }), false, 'the player 10 blocks off');
      assert.equal(survival.canNightMine(call({ kind: 'follow', request: 'Jev follow me' })), false, 'following');
      s.bot.players = playerAt(10.5 + 60);
      const company60 = company.staysUp(s.bot, Date.now() + 10 * company.ALONE_MS);
      assert.equal(company60, false, 'the player 60 blocks off is no company');
    });
  });
  await check('guarding: a monster at the player is the survival claim, the work not weighed against it; at 8 health, or not guarding, it is not', async () => {
    const guardGoal = call({ kind: 'follow', guard: true, request: 'Jev protect me' });
    const at = (goal, setup = () => {}) => { const s = scene({ at: [10.5, 64, 0.5] }); s.bot.time.timeOfDay = 6000; s.bot.entities = mob(7, 'zombie', 3.5); setup(s); return { s, claim: survival.claim(s.bot, goal, null) }; };
    const { s, claim } = at(guardGoal);
    assert.equal(claim?.action, 'guard', JSON.stringify(claim || null).slice(0, 200));
    assert.equal(claim.facts.player, 'Caller'); assert.equal(claim.facts.target, 'zombie'); assert.equal(claim.facts.toPlayer, 3);
    assert.equal(s.bot._guardTarget?.id, 7, 'the zombie is the guard\'s: no threat to run from');
    assert.equal(require('../src/danger').nightHunted(s.bot, s.bot.entities[7]), true);
    assert.equal(require('../src/guard').first(s.bot, guardGoal, [claim, { layer: 'work', action: 'step', urgency: 'routine' }]), true);
    assert.equal(require('../src/guard').first(s.bot, call({ kind: 'follow' }), [claim]), false, 'a plain follow');
    assert.notEqual(at(guardGoal, x => { x.bot.health = 8; }).claim?.action, 'guard', 'at 8 health');
    assert.notEqual(at(call({ kind: 'follow', request: 'Jev follow me' })).claim?.action, 'guard', 'following only');
    assert.notEqual(at(guardGoal, x => { x.bot.entities = mob(7, 'creeper', 3.5); }).claim?.action, 'guard', 'a creeper is not gone for');
    assert.equal(at(guardGoal, x => { x.bot.entities = mob(7, 'zombie', 0.5, 64, 12.5); }).claim?.action === 'guard', false, 'a zombie twelve blocks from the player');
    const says = require('../src/arbiter').claimSays(claim);
    assert.match(says, /Guard Caller: the zombie 3 blocks from them/);
  });

  console.log(`\n${passed} checks passed`);
  process.exit(0);   // the decision layer's unanswered questions keep their timers
})().catch(err => { console.error(err); process.exit(1); });
