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
    const log = console.log, err = console.error, said = [];
    console.log = console.error = (...a) => { said.push(a.join(' ')); };
    // The step is let go of as soon as it has shown its hand.
    const stepTask = { check() { if (!did && said.some(l => /pocket_next/.test(l))) did = 'asked'; if (did === 'asked') { const e = new Error('enough'); e.name = 'Cancelled'; throw e; } } };
    try { await Promise.race([survival.step(stepTask, goal, () => {}, () => {}).catch(e => { if (e.name !== 'Cancelled') throw e; }), new Promise(r => setTimeout(r, 8000))]); }
    finally { console.log = log; console.error = err; }
    return { claim: survival_claim(s.bot, goal, survival), did, said };
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

  console.log(`\n${passed} checks passed`);
  process.exit(0);   // the decision layer's unanswered questions keep their timers
})().catch(err => { console.error(err); process.exit(1); });
