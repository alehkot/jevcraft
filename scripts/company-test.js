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
    assert.equal(company.calledOver(call({ kind: 'follow' }), bot), false, 'following is not a call');
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
    assert.equal(claimAt(16000, call({ kind: 'follow', request: 'Jev follow me' }))?.action, 'secure_shelter', 'following is as it was');
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
  const inPocket = async (goal, { players, entities = {} } = {}) => {
    const s = scene({ at: [10.5, 60, 0.5] });
    s.set(10, 60, 0, 'air'); s.set(10, 61, 0, 'air');
    s.bot.time.timeOfDay = 16000; s.bot.entities = entities;
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
    assert.equal((await inPocket(call({ kind: 'follow', request: 'Jev follow me' }))).did, 'asked', 'following is as it was');
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
        assert.equal(claimAt(16000, goal, { players: playerAt(10.5 + 40) })?.action, 'secure_shelter', `${goal.kind}, the player 40 blocks off`);
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

  console.log(`\n${passed} checks passed`);
  process.exit(0);   // the decision layer's unanswered questions keep their timers
})().catch(err => { console.error(err); process.exit(1); });
