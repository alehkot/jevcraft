'use strict';
// Waiting with a player, the bot holds its ground (asked for 2026-11-22: "should a waiting Jev hold its ground near
// you?" "yes"): company.js holdsGround, and the waiting bot's ways against a mob in reach (reactive-wait.js mobWays).
// And alone on lit ground at night it waits as by day (company.js standing, litAbout).
//
//   node test/wait-ground.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const company = require('../src/company');
const { mobWays, said } = require('../src/reactive-wait');

const NOW = 1000000;
// The bot at the origin, waiting with Robin, who stands `off` blocks east and was seen `ago` ms back.
const waiting = (off, { health = 20, ago = 500, inView = true } = {}) => ({ username: 'Jev', health, entity: { position: new Vec3(0.5, 64, 0.5) },
  players: inView ? { Robin: { entity: { position: new Vec3(0.5 + off, 64, 0.5) } } } : {}, _company: { name: 'Robin', position: { x: 0.5 + off, y: 64, z: 0.5 }, at: NOW - ago } });
const mob = (name, distance, id = 7) => ({ entity: { id, name }, distance, visible: true });

test('within twelve blocks of its player the waiting bot may give ground; farther off it does not', () => {
  assert.equal(company.WAIT_TETHER, 12);
  assert.equal(company.holdsGround(waiting(5), [mob('zombie', 2)], NOW), null, 'five blocks off: the run is its to take');
  assert.equal(company.holdsGround(waiting(12), [mob('zombie', 2)], NOW), null, 'at twelve still');
  const held = company.holdsGround(waiting(14), [mob('zombie', 2)], NOW);
  assert.equal(held.player, 'Robin'); assert.equal(Math.round(held.distance), 14); assert.equal(held.why, 'Robin is 14 blocks off');
  assert.ok(company.holdsGround(waiting(30), [mob('zombie', 2), mob('spider', 4, 8)], NOW), 'a crowd of walkers too');
});

test('not with nobody to wait with, not hurt to eight, not from a creeper, not from a shooter out of reach', () => {
  const zombie = [mob('zombie', 2)];
  assert.equal(company.holdsGround({ ...waiting(14), _company: undefined }, zombie, NOW), null, 'nobody it waits with');
  assert.equal(company.holdsGround(waiting(14, { ago: 30001 }), zombie, NOW), null, 'the player last seen more than thirty seconds ago');
  assert.ok(company.holdsGround(waiting(14, { ago: 20000, inView: false }), zombie, NOW), 'out of view for a moment: where they were last seen');
  assert.equal(company.holdsGround(waiting(14, { health: 8 }), zombie, NOW), null, 'at eight health it saves itself');
  assert.ok(company.holdsGround(waiting(14, { health: 8.5 }), zombie, NOW));
  assert.equal(company.holdsGround(waiting(14), [mob('zombie', 2), mob('creeper', 5, 9)], NOW), null, 'a creeper among them');
  assert.equal(company.holdsGround(waiting(14), [mob('skeleton', 9)], NOW), null, 'a skeleton nine blocks off: swinging here lands nothing');
  assert.ok(company.holdsGround(waiting(14), [mob('skeleton', 2)], NOW), 'a skeleton at arm\'s length is fought');
});

test('alone in the dark on lit ground the night is waited out like the day: the routine is not begun', () => {
  const before = process.env.JEV_NIGHT; process.env.JEV_NIGHT = 'company';
  try {
    const asked = [];
    const alone = () => ({ username: 'Jev', entity: { position: new Vec3(0.5, 64, 0.5) }, players: {}, game: { dimension: 'overworld' } });
    const lit = (b, now) => { asked.push(now); return true; }, unlit = () => false;
    const onLit = company.standing(alone(), null, true, NOW, { lit });
    assert.deepEqual(onLit, { dark: false, sheltered: false, out: false });
    assert.equal(company.routine({ ...onLit, sinceSheltered: 60000 }), 'end', 'no routine is begun, and one running is ended');
    const inDark = company.standing(alone(), null, true, NOW, { lit: unlit });
    assert.deepEqual(inDark, { dark: true, sheltered: false, out: false }, 'not lit: the routine has the night');
    assert.equal(company.routine({ ...inDark, sinceSheltered: 60000 }), 'run');
    // By day, and by night with a player near, the light is not asked about.
    asked.length = 0;
    assert.deepEqual(company.standing(alone(), null, false, NOW, { lit }), { dark: false, sheltered: false, out: false });
    const kept = { ...alone(), players: { Robin: { entity: { position: new Vec3(10.5, 64, 0.5) } } } };
    assert.deepEqual(company.standing(kept, null, true, NOW, { lit }), { dark: false, sheltered: false, out: false });
    assert.deepEqual(asked, []);
    // With no reading given, the survey's own: a bot with no world to read is not on lit ground.
    assert.deepEqual(company.standing(alone(), null, true, NOW), { dark: true, sheltered: false, out: false });
  } finally { if (before === undefined) delete process.env.JEV_NIGHT; else process.env.JEV_NIGHT = before; }
});

test('the light about is asked for at most once in five seconds, and a reading that fails is not lit', () => {
  const bot = {}, reads = [];
  const read = (b, now) => { reads.push(now); return reads.length === 1; };
  assert.equal(company.litAbout(bot, NOW, read), true);
  assert.equal(company.litAbout(bot, NOW + 1000, read), true, 'kept');
  assert.equal(company.litAbout(bot, NOW + 4999, read), true, 'kept');
  assert.equal(company.litAbout(bot, NOW + 5000, read), false, 'asked again');
  assert.deepEqual(reads, [NOW, NOW + 5000]);
  assert.equal(company.litAbout({}, NOW, () => { throw new Error('no world'); }), false);
});

test("the waiting bot's ways: both within the tether, the fight alone past it, and that in the log", () => {
  const ran = [], survival = { runAway: () => ran.push('run'), swingFor: () => ran.push('swing') };
  const near = mobWays(waiting(5), survival, {}, {}, () => {}, [mob('zombie', 2)], NOW);
  assert.deepEqual(Object.keys(near.tree), ['retreat', 'fight']); assert.equal(near.held, null);
  const far = mobWays(waiting(14), survival, {}, {}, () => {}, [mob('zombie', 2)], NOW);
  assert.deepEqual(Object.keys(far.tree), ['fight']); assert.equal(far.held.player, 'Robin');
  far.tree.fight.run(); near.tree.retreat.run(); assert.deepEqual(ran, ['swing', 'run']);
  const lines = [], log = console.log; console.log = l => lines.push(l);
  try { said(waiting(14), mob('zombie', 2.14), 'fight', true, NOW, far.held); } finally { console.log = log; }
  assert.deepEqual(lines, ['[wait] the zombie 2.1 blocks off: fight, no run offered; Robin 14 blocks off']);
});
