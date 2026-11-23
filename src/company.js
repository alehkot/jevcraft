'use strict';
// Called over by a player: "come here".
//
// Two things the call asks that "within three blocks of the player" did not
// give (2026-11-21, a player's first minutes with the bot):
//
// - It comes. The night's shelter is not put ahead of the call (calledOver,
//   read in survival.js): told "come here" while it took the hour for night,
//   the bot answered "Coming" and dug itself a pocket where it stood, 21
//   blocks from the player, and sat in it with the call waiting. Only while
//   the player is in view and the call is minutes old; threats, air and food
//   are answered as ever.
// - It ends where the two can see each other (standInView, work.js
//   movementStep). Three blocks off is also three blocks under the player's
//   feet, or behind a wall, or in the leaves of a tree. Arrived, the bot
//   looks for a clear line from its eyes to the player's; without one it
//   walks once to a spot that has it, in front of the player for choice, and
//   turns to face them. If there is no such spot or the walk fails, the call
//   still ends, and the bot says it cannot be seen.
//
// And a third, of a request that is for a player (a come, a follow):
//
// - It ends with the player. A player once left with the call
//   in hand: 26 times in 70 seconds the walk failed on "Cannot see ...", said
//   aloud seven times, and the call was taken up again ("I'm back! I'll carry
//   on where I left off") at each start after, 45 minutes on, with only the
//   other player in the game. A player gone from the game twenty seconds has
//   left (callerState, work.js movementStep), and the request ends saying so;
//   a call is not taken up at a start when its player is not in the game or
//   it is minutes old (lapsed, session.js).
//
// And one of the waiting between requests, where a player looks for the bot:
//
// - By day it is out of the night's shelter and out of the ground (inShelter,
//   holedUp, routine, session.js).
//
// And one of the night, switched by JEV_NIGHT=company (asked for 2026-11-21:
// called over at night the bot came, and dug in again beside the player; a
// player joining at night found it gone to ground within seconds):
//
// - With a player it stays up. The night's shelter is not sought while a
//   player is within STAY_UP blocks, nor for ALONE_MS after (staysUp, read in
//   survival.js beside the call, and by the waiting). A pocket sealed for the
//   night alone is opened when a player comes within COME_OUT blocks and no
//   mob is within sixteen (comesOut). The two distances are apart so that a
//   player walking the edge of one does not have the bot in and out of the
//   ground. Alone it shelters as ever, and with a player or without, threats,
//   air and food are answered as ever: it runs or fights, and may die of it.
//   Nothing is followed that was not asked to be.
const { Vec3 } = require('vec3');

const EYE = 1.62;
const REACH = 4;            // blocks round the player a spot is looked for in
const RISE = 2;             // and above or below their feet
const WALK_MS = 12000;      // the one walk to it

const STAY_UP = 32;                // a player this near keeps the bot up at night
const COME_OUT = 16;               // and this near brings it out of a pocket sealed for the night
const ALONE_MS = 20000;            // out of STAY_UP this long, it is alone

const nightMode = () => String(process.env.JEV_NIGHT || '').trim().toLowerCase() === 'company';
// Blocks to the nearest player in view, the bot's own name aside; Infinity with none.
function nearestPlayer(bot) {
  const me = bot?.entity?.position;
  if (!me) return Infinity;
  let best = Infinity;
  for (const [name, player] of Object.entries(bot.players || {})) {
    const at = player?.entity?.position;
    if (!at || name === bot.username) continue;
    best = Math.min(best, at.distanceTo(me));
  }
  return best;
}
// JEV_NIGHT=company: a player is near, or was a moment ago.
function staysUp(bot, now = Date.now()) {
  if (!nightMode() || !bot) return false;
  if (nearestPlayer(bot) <= STAY_UP) { bot._playerNearAt = now; return true; }
  return now - (bot._playerNearAt || 0) < ALONE_MS;
}
// JEV_NIGHT=company: a player is close enough to come out of the ground for.
const comesOut = bot => nightMode() && nearestPlayer(bot) <= COME_OUT;

const CALL_HOLDS_MS = 5 * 60000;   // how long a call keeps the night's shelter waiting, and is taken up again at a start
const GONE_MS = 20000;             // out of the game this long, the player has left

// In the game (the player list), in view or not.
const here = (bot, name) => !!name && Object.keys(bot?.players || {}).some(p => p.toLowerCase() === String(name).toLowerCase());

// The player a come or a follow is for: 'here', or out of the game and waited
// for ('wait': a dropped connection comes back), or 'left'.
function callerState(bot, goal, now = Date.now()) {
  if (here(bot, goal.target || goal.from)) { delete goal.callerGoneAt; return 'here'; }
  goal.callerGoneAt ||= now;
  return now - goal.callerGoneAt >= GONE_MS ? 'left' : 'wait';
}

// Inside a pocket it has on record. Read by the waiting between requests
// (session.js, JEV_IDLE=wait), so the day is not waited out sealed in the
// night's pocket.
// Climbing out counts as inside: a shaft pocket is left up its own shaft,
// and the first test of this (2026-11-21) ended the climb one block up, out
// of the pocket's cell and three under the grass, to wait there. Read off
// every shelter on record, since one being left may be marked to keep away
// from and is then no longer the current one.
function inShelter(bot, survival) {
  try {
    if (!bot?.entity?.position) return false;
    const feet = require('./terrain').feetCell(bot), dimension = bot.game?.dimension;
    return (survival?.state?.shelters || []).some(refuge => {
      // A house is a place to wait in: the routine is not run for as long as the bot stands in one.
      if (!refuge?.origin || refuge.dimension !== dimension || refuge.kind === 'house') return false;
      const o = refuge.origin, top = refuge.top;
      if (refuge.shaft && top && feet.x === o.x && feet.z === o.z && feet.y >= o.y && feet.y < top.y) return true;
      return require('./shelter').inside(bot, refuge);
    });
  } catch (_) { return false; }
}

// Standing in a hole one block wide: a block on each of the four sides of
// its feet. What is left of a pocket once its record is gone (the leave drops
// it as it starts), and the shaft on the way up: the second test of the
// waiting (2026-11-21) found the bot one block up its shaft, three under the
// grass, no shelter on record, and left it there. On the surface, in a
// tunnel, a cave or a house, a side is open.
function holedUp(bot) {
  try {
    if (!bot?.entity?.position || typeof bot.blockAt !== 'function') return false;
    const feet = require('./terrain').feetCell(bot);
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => bot.blockAt(feet.offset(dx, 0, dz))?.boundingBox === 'block');
  } catch (_) { return false; }
}

const OUT_MS = 3000;    // the routine's time to finish getting out, once the bot is out of its shelter and of any hole

// The waiting between requests, each half second: what is done with the
// bot's own routine (the idle loop). In the dark it runs, as it does in a
// shelter or a hole by day, where it is the one that gets the bot out. Out
// of both, one that is running is let finish for three seconds and then
// ended; none is started. Three seconds and no more: whatever time is given
// after the hole is the routine's own day begun, the hunt the waiting is
// there to prevent. Ended at once when the climb out says it is done (`out`,
// from climbOut below): the three seconds are for a hole left some other way.
// -> 'run' | 'finish' | 'end'
function routine({ dark, sheltered, sinceSheltered, out = false }) {
  if (dark || sheltered) return 'run';
  return out || sinceSheltered >= OUT_MS ? 'end' : 'finish';
}

// What the waiting reads each half second (session.js), for routine():
// whether the dark is the bot's to shelter from alone (not on lit ground: litAbout below), and whether it stands
// in the ground where it is not to wait. By day that is any shelter or hole;
// at night, with JEV_NIGHT=company, one a player has come close to.
// A pocket the bot has opened it is to be out of, unless the dark is its own
// again (inLeftPocket); `out` is the climb saying it has finished (climbOut).
// Alone in the dark on ground lit about it (night-light.js) the routine has no shelter to make, and run there it went
// on to its own work: on the private copy (2026-11-22, scene litnight) the waiting bot, alone at midnight on lit
// ground, went to a chest and opened it ("Opened the chest's chest; nothing in it I can use"), the gathering the
// waiting is there to prevent. Such a night is waited out like the day, the bot answering what would hurt it where it
// stands; off the lit ground the dark is its own again. Asked at most once in five seconds here: the survey is kept
// a minute where the bot stands and worked out anew eight blocks on, which a walk covers every two seconds.
const LIT_ASKED_MS = 5000;
function litAbout(bot, now = Date.now(), read = (b, t) => require('./night-light').wellLit(b, t)) {
  const kept = bot?._litAsked;
  if (kept && now >= kept.at && now - kept.at < LIT_ASKED_MS) return kept.lit;
  let lit = false;
  try { lit = !!read(bot, now); } catch (_) { lit = false; }
  if (bot) bot._litAsked = { at: now, lit };
  return lit;
}
function standing(bot, survival, dark, now = Date.now(), { lit = litAbout } = {}) {
  const kept = dark && staysUp(bot, now), drawn = dark && comesOut(bot), alone = dark && !kept;
  // The climb in hand is the routine's to finish (afterLeave): the second run
  // with a player (2026-11-21) had a pocket built on the grass opened, its
  // record gone, and the walk into the player's view stopped three seconds on.
  const climbing = !!bot?._climbing && now - bot._climbing < CLIMB_MS;
  const sheltered = ((!dark || drawn) && (holedUp(bot) || inShelter(bot, survival))) || (!alone && inLeftPocket(bot, survival, now)) || climbing;
  return { dark: alone && !lit(bot, now), sheltered, out: !sheltered && !!bot?._outAt && now - bot._outAt < 5000 };
}

// ---- Whose turn it is in a pocket that is to be left --------------------------
// The dark of the waiting, read in one place: session.js's timer decides by it
// whether the routine runs, and the rules below whether a pocket is left for
// the day. Two readings that disagreed would open a pocket at night.
const darkNow = bot => bot?.game?.dimension === 'overworld' && Number.isFinite(bot?.time?.timeOfDay) && bot.time.timeOfDay >= 12300 && bot.time.timeOfDay < 23500;
// The bot's own routine, run while it waits between requests.
const waitingIdle = goal => process.env.JEV_IDLE === 'wait' && goal?.kind === 'survive';
// What a pocket sealed for the night alone is opened for, by rule (the
// pocket's turn in survival.js; `night` is the survival layer's own, from
// 9500): a call, a player come close at night, the day for the bot waiting.
function drawnOut(bot, goal, night = darkNow(bot)) {
  if (calledOver(goal, bot)) return 'the call';
  if ((night || darkNow(bot)) && comesOut(bot)) return 'a player close by';
  return !darkNow(bot) && waitingIdle(goal) ? 'the day' : null;
}
// The pocket's turn comes before the waiting bot's own work (work.js
// liveTurn): its routine has a claim on the turn like any request's ("stay
// alive and prepare supplies"), the two are weighed by the decision layer, and
// with a player beside the pocket at a start it gave the turn to the work,
// which has nothing to do in a pocket. The bot sat sealed in, a player five
// blocks off, for 45 seconds, until the stillness rule dug it free (the
// fourth run with a player, 2026-11-21). Where the pocket is to be left for
// the day or for a player close by, the work is not weighed against it.
function pocketFirst(bot, goal, claims = []) {
  if (!waitingIdle(goal) || !claims.some(c => c?.layer === 'survival' && c.action === 'pocket_next')) return false;
  const why = drawnOut(bot, goal);
  return why === 'the day' || why === 'a player close by';
}

// ---- Out of a pocket, onto the ground ---------------------------------------
// The survival layer's leave opens a pocket and, where the way is not straight
// up, stops there: its doors are the four sides at the feet and the head, and
// the walk out is left to whatever the bot does next. Waiting for a player
// there is nothing next. Seen with a second player on the server (2026-11-21):
// the pocket three under the grass was opened for the player come close, eight
// blocks dug in nine seconds, its record dropped; the bot stood at the bottom
// of a hole open on four sides, which is no hole to holedUp; the routine's
// next walk (to a chicken, forty blocks off) was stopped a second in; and the
// bot stayed down there, in nobody's view, until it was called.
//
// So the leave is followed by the climb (afterLeave, called from the pocket's
// turn in survival.js): up to the ground the pocket was dug from (rimOf), and,
// with a player close, to where the two can see each other. The pocket is
// kept on record as left (state.leftPocket) for as long as the bot stands in
// it, so the waiting does not take an opened pocket for the ground.
const LEFT_MS = 5 * 60000;    // a pocket left is remembered this long: the time the routine has to get out of one the climb failed in
const RIM_UP = 8, RIM_OUT = 3;
const CLIMB_MS = 45000;       // the longest a climb is believed to be in hand
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Nothing but leaves over the bot's head there, eighteen blocks up.
function skyOpen(bot, cell) {
  for (let k = 2; k <= 18; k++) {
    const b = bot.blockAt(cell.offset(0, k, 0));
    if (b && b.boundingBox === 'block' && !/leaves/.test(b.name || '')) return false;
  }
  return true;
}
// Ground: a cell to stand in under open sky, two of its sides open under it
// too. The foot of an open shaft has the sky and no side; a pocket's opened
// sides have no sky.
function openGround(bot, cell) {
  if (!standable(bot, cell) || !skyOpen(bot, cell)) return false;
  let sides = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const c = cell.offset(dx, 0, dz);
    if (passable(bot.blockAt(c)) && passable(bot.blockAt(c.offset(0, 1, 0))) && skyOpen(bot, c)) sides++;
  }
  return sides >= 2;
}
// The ground a pocket was dug from: the lowest such cell within three blocks
// of the pocket's column, the nearest of them, no more than eight blocks up
// (or as far as the record says the shaft was dug from). None under rock.
function rimOf(bot, origin, { top = null } = {}) {
  try {
    const o = new Vec3(origin.x, origin.y, origin.z), rise = Math.max(RIM_UP, Number.isFinite(top?.y) ? top.y - origin.y + 2 : 0);
    for (let dy = 0; dy <= rise; dy++) {
      let best = null;
      for (let dx = -RIM_OUT; dx <= RIM_OUT; dx++) for (let dz = -RIM_OUT; dz <= RIM_OUT; dz++) {
        const c = o.offset(dx, dy, dz), d = Math.hypot(dx, dz);
        if ((!best || d < best.d) && openGround(bot, c)) best = { c, d };
      }
      if (best) return best.c;
    }
  } catch (_) {}
  return null;
}
// Standing in the pocket it has opened: within a block of its column, under
// the ground it was dug from.
function inLeftPocket(bot, survival, now = Date.now()) {
  try {
    const left = survival?.state?.leftPocket;
    if (!left?.origin || !left.rim || !bot?.entity?.position || left.dimension !== bot.game?.dimension || now - left.at > LEFT_MS) return false;
    const feet = require('./terrain').feetCell(bot), o = left.origin;
    return Math.abs(feet.x - o.x) <= 1 && Math.abs(feet.z - o.z) <= 1 && feet.y >= o.y && feet.y < left.rim.y;
  } catch (_) { return false; }
}
function nearestPlayerEntity(bot, within = Infinity) {
  const me = bot?.entity?.position;
  let best = null;
  for (const [name, player] of Object.entries(bot?.players || {})) {
    const at = player?.entity?.position;
    if (!me || !at || name === bot.username) continue;
    const d = at.distanceTo(me);
    if (d <= within && (!best || d < best.d)) best = { entity: player.entity, d };
  }
  return best?.entity || null;
}
// Up to the rim, then, with a player close, to where the two see each other.
// A walk that fails is not the end of the bot's turn; air, safety and a
// cancel are passed up as everywhere.
async function climbOut(bot, task, { navigate, goals, rim, walkMs = 15000 } = {}) {
  // Not from the ground: a pocket built on the grass is walked out of by its
  // doorway, and the leave has done that.
  const onGround = () => { try { return openGround(bot, require('./terrain').feetCell(bot)); } catch (_) { return false; } };
  // Twice, the second to anywhere beside the rim: the leave's own climb ends a
  // block short as often as not, and a walk asked for where one has just
  // ended short is refused once (third run with a player, 2026-11-21: the
  // bot stood a block under the grass, in view, for forty seconds).
  if (rim && typeof navigate === 'function') {
    for (const goal of [new goals.GoalBlock(rim.x, rim.y, rim.z), new goals.GoalNear(rim.x, rim.y, rim.z, 1)]) {
      if (onGround()) break;
      try { await navigate(bot, task, goal, { timeoutMs: walkMs, stallMs: 4000 }); }
      catch (err) {
        task?.check?.();
        if (['NeedsAir', 'NeedsSafety', 'Cancelled'].includes(err?.name)) throw err;
        console.log(`[company] the walk up to the rim did not get there: ${err?.name || 'Error'}: ${String(err?.message || err).slice(0, 160)}`);
        for (let i = 0; i < 6; i++) { task?.check?.(); await pause(100); }
      }
    }
  }
  const player = nearestPlayerEntity(bot, COME_OUT);
  const view = player ? await standInView(bot, task, player, { navigate, goals }) : null;
  const up = !rim || onGround() || require('./terrain').feetCell(bot).y >= rim.y;
  if (up) bot._outAt = Date.now();
  return { up, ...(view ? { seen: view.seen } : {}) };
}
// After the survival layer's leave of a pocket (survival.js). For the bot
// waiting between requests (JEV_IDLE=wait), whose routine runs only to get it
// out, and for a pocket opened for a player come close (JEV_NIGHT=company).
// Not for a call, which walks to its player itself, nor for the routine left
// to its own day, nor under rock, where there is no ground to climb to.
async function afterLeave(survival, task, goal, save, refuge, { drawnOut = null, navigate, goals } = {}) {
  const bot = survival?.bot;
  const waiting = process.env.JEV_IDLE === 'wait' && goal?.kind === 'survive';
  if (!bot || !refuge?.origin || refuge.kind === 'house' || !(waiting || drawnOut === 'a player close by')) return null;
  const rim = rimOf(bot, refuge.origin, { top: refuge.top });
  if (!rim) return null;
  survival.state.leftPocket = { origin: { x: refuge.origin.x, y: refuge.origin.y, z: refuge.origin.z }, rim: { x: rim.x, y: rim.y, z: rim.z }, dimension: bot.game?.dimension, at: Date.now() };
  save?.();
  bot._climbing = Date.now();
  let done;
  try { done = await climbOut(bot, task, { navigate, goals, rim }); }
  finally { delete bot._climbing; }
  console.log(`[company] out of the pocket: ${done.up ? 'up on the ground' : 'not up yet'}${done.seen === undefined ? '' : done.seen ? ', in view of the player' : ', the player not in view'}`);
  // The waiting ends the routine here (session.js); it is given the moment to.
  if (done.up && waiting) for (let i = 0; i < 12; i++) { task?.check?.(); await pause(100); }
  return done;
}

// At a start: a "come here" does not outlive its moment.
function lapsed(goal, bot, now = Date.now()) {
  if (goal?.kind !== 'come') return false;
  const at = Date.parse(goal.createdAt || '');
  return !here(bot, goal.target || goal.from) || (Number.isFinite(at) && now - at > CALL_HOLDS_MS);
}

// A player's "come here" in hand, with that player in view. A call whose
// player has left or gone out of sight, or one of long ago taken up again
// after a restart, does not keep the bot out in the dark.
function calledOver(goal, bot, now = Date.now()) {
  // Following a player in view, guarding one included, keeps the bot with them as a call does (2026-11-22:
  // asked to follow, the bot cooked, mined for the night and walled itself in a cave 95 blocks behind its
  // player, all of it with the player in its view). Out of view, a follow is no call, as a come is not.
  if (goal?.kind === 'follow') return !!bot?.players?.[goal.target || goal.from]?.entity;
  if (goal?.kind !== 'come') return false;
  const at = Date.parse(goal.createdAt || '');
  if (Number.isFinite(at) && now - at > CALL_HOLDS_MS) return false;
  return !!bot?.players?.[goal.target || goal.from]?.entity;
}

const eyesAt = feet => new Vec3(feet.x, feet.y + EYE, feet.z);
// A clear line between two pairs of eyes: nothing a ray stops on. Leaves and
// glass stop it as a wall does; grass, flowers and water do not.
function clearLine(bot, from, to) {
  try { return require('./danger').lineClear(bot, from, to); } catch (_) { return false; }
}
const inView = (bot, target, feet = bot.entity.position) => !!target?.position && clearLine(bot, eyesAt(feet), eyesAt(target.position));

const passable = b => !!b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name || '');
const solid = b => !!b && b.boundingBox === 'block' && !/magma|campfire|cactus/.test(b.name || '');
const standable = (bot, c) => passable(bot.blockAt(c)) && passable(bot.blockAt(c.offset(0, 1, 0))) && solid(bot.blockAt(c.offset(0, -1, 0)));

// The way the player faces, level, as a unit vector; null when it is not known.
function facing(target) {
  const yaw = Number.isFinite(target?.headYaw) ? target.headYaw : target?.yaw;
  return Number.isFinite(yaw) ? { x: -Math.sin(yaw), z: -Math.cos(yaw) } : null;
}

// Cells near the player the bot can stand in with a clear line to the
// player's eyes, best first: in front of them, near their level, two or
// three blocks off, and not far to walk.
function spotsInView(bot, target, { reach = REACH, rise = RISE } = {}) {
  if (!target?.position || typeof bot.blockAt !== 'function') return [];
  const at = target.position, base = at.floored(), look = facing(target), me = bot.entity.position, eyes = eyesAt(at);
  const out = [];
  for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) for (let dy = rise; dy >= -rise; dy--) {
    const cell = base.offset(dx, dy, dz), feet = cell.offset(0.5, 0, 0.5);
    const off = Math.hypot(feet.x - at.x, feet.z - at.z);
    if (off < 1.5 || off > reach + 0.5 || !standable(bot, cell) || !clearLine(bot, eyesAt(feet), eyes)) continue;
    // 0 straight ahead of the player, 1 straight behind.
    const behind = look ? Math.acos(Math.max(-1, Math.min(1, ((feet.x - at.x) * look.x + (feet.z - at.z) * look.z) / off))) / Math.PI : 0.5;
    out.push({ cell, score: 2 * behind + 0.5 * Math.abs(feet.y - at.y) + 0.3 * Math.abs(off - 2.5) + 0.15 * feet.distanceTo(me) });
  }
  return out.sort((a, b) => a.score - b.score).map(spot => spot.cell);
}

// Arrived by the player: seen from where it stands, or one walk to a spot
// that is. -> { seen, moved, cell? }
async function standInView(bot, task, target, { navigate, goals, walkMs = WALK_MS } = {}) {
  const face = async () => { try { await bot.lookAt(eyesAt(target.position), true); } catch (_) { /* a turn of the head only */ } };
  if (inView(bot, target)) { await face(); return { seen: true, moved: false }; }
  const cell = spotsInView(bot, target)[0];
  if (!cell || typeof navigate !== 'function') { await face(); return { seen: false, moved: false }; }
  try { await navigate(bot, task, new goals.GoalBlock(cell.x, cell.y, cell.z), { timeoutMs: walkMs, stallMs: 4000 }); }
  catch (err) { task?.check?.(); if (['NeedsAir', 'NeedsSafety', 'Cancelled'].includes(err?.name)) throw err; }
  await face();
  return { seen: inView(bot, target), moved: true, cell };
}

// Back to its player after monsters (asked for by the server's owner, 2026-11-21: a companion
// that tries to be near its player again once the monsters are gone). A waiting bot answers a
// mob in reach by giving ground (reactive-wait.js, survival.js runAway), and stood wherever the
// run ended, twenty or eighty blocks off, until it was called. Now it walks back by itself: a
// "come" to the player it was waiting with, begun once it has given no ground for a few seconds
// and no monster is about the player.
//
// Only that. It is no rule to stay near a player: a bot that did not run stays where it was
// left, one at work on a request goes on with the request, and the walk back is given up when a
// player asks for something else, says stop, or leaves the game. By night it is made only to a
// player in view, like any call (calledOver); out of view the night's shelter comes first, and
// the walk is made in the morning if the scare is no older than a quarter of an hour.
const WITH_MS = 30000;              // a player seen within STAY_UP blocks this lately is the one the bot waits with
const BACK_QUIET_MS = 3000;         // no ground given for this long before it turns back
const BACK_OFF = 6;                 // blocks from the player within which it is back with them
const NEAR_PLAYER = 8;              // a monster this near the player: not yet
const BACK_HOLDS_MS = 15 * 60000;   // a scare older than this is let go
const BACK_TRIES = 3;               // walks back a scare
const BACK_RETRY_MS = 20000;        // between two of them
const spot = p => ({ x: p.x, y: p.y, z: p.z });

// Each half second of the waiting (session.js): the nearest player within STAY_UP blocks is the
// one the bot waits with, and where the player of a scare was last seen is kept for the walk.
function withPlayer(bot, now = Date.now()) {
  const me = bot?.entity?.position;
  if (!me) return null;
  let best = null;
  for (const [name, player] of Object.entries(bot.players || {})) {
    const at = player?.entity?.position;
    if (!at || name === bot.username) continue;
    const d = at.distanceTo(me);
    if (d <= STAY_UP && (!best || d < best.d)) best = { name, at, d };
  }
  if (best) bot._company = { name: best.name, position: spot(best.at), at: now };
  const seen = bot._scare && bot.players?.[bot._scare.with]?.entity?.position;
  if (seen) bot._scare.position = spot(seen);
  return bot._company || null;
}
// The bot gave ground to monsters (survival.js runAway). Waiting with a player, that is a scare
// to come back from; more ground given within it is the same scare. At work on a request, or
// with nobody near, it is nothing.
function gaveGround(bot, now = Date.now()) {
  if (!bot) return null;
  const scare = bot._scare;
  if (scare && now - scare.at <= BACK_HOLDS_MS) { scare.last = now; return scare; }
  delete bot._scare;
  const with_ = bot._company;
  if (!with_ || now - with_.at > WITH_MS) return null;
  return (bot._scare = { with: with_.name, position: { ...with_.position }, at: now, last: now, tries: 0, triedAt: 0 });
}
// A request, a stop: the scare is over, and so is the company kept for the next one.
function letGo(bot) { if (bot) { delete bot._scare; delete bot._company; } }
// After the bot's own errand (keep-armed.js: the sword it went to make), back to the player it waited with, by the
// same rules as after monsters (backDue): said once, three tries, not with a monster after it or about them.
function oweBack(bot, to, now = Date.now()) {
  if (!bot || !to?.name || !to.position) return null;
  return (bot._scare = { with: to.name, position: { ...to.position }, at: now, last: now, tries: 0, triedAt: 0, errand: true });
}
// Whether to walk back now: the scare, or null. chased() says whether a monster is still after
// the bot; hostileNear(position, blocks) whether one is that near a place; dark is the night
// (darkNow).
function backDue(bot, { now = Date.now(), dark = darkNow(bot), chased = () => false, hostileNear = () => false } = {}) {
  const scare = bot?._scare, me = bot?.entity?.position;
  if (!scare || !me) return null;
  if (now - scare.at > BACK_HOLDS_MS || scare.tries >= BACK_TRIES || !here(bot, scare.with)) { delete bot._scare; return null; }
  if (now - scare.last < BACK_QUIET_MS) return null;
  const at = bot.players?.[scare.with]?.entity?.position;
  // Back with them already: its own feet brought it, or the player came over.
  if (at && at.distanceTo(me) <= BACK_OFF) { delete bot._scare; return null; }
  if (!at && (dark || !scare.position)) return null;
  if (now - scare.triedAt < BACK_RETRY_MS) return null;
  // Not with a monster still after it (a husk left alive ran a waiting bot 76 blocks in 45 seconds, and the walk back
  // was begun at 56 with the husk three blocks behind: 2026-11-21), and not to a player with one about them.
  if (chased() || (at && hostileNear(at, NEAR_PLAYER))) return null;
  return scare;
}

// ---- The night with a player out (asked for 2026-11-22) ---------------------
// "at night if i'm not covering jev shouldn't covering", "but if player is far away jev should take cover if
// it's not safe". A player once stood in the open thirteen blocks off while the bot, on a stillness detour,
// dug a mine for the night and boxed itself in against a skeleton, and the player was shot there. So, with a
// player within STAY_UP blocks:
// - the night's shelter and the night's mine are not sought (staysUp, as since 2026-11-21, now also for the
//   mine's stillness detour, survival.js canNightMine);
// - in a fight, the ways that hide the bot (a pillar, a seal, a nook, a box, a hole) are left off the
//   stance while that player is out in the open (keepsOut), unless the bot's health is down to HIDE_HEALTH:
//   then it may save itself as ever. Fighting, running and the rest stay on offer. A player under cover
//   is mirrored too: then the bot may take cover in a fight.
// Farther off, the bot looks after itself: it takes cover where it is not safe, as before. Followed or
// guarded, the player is kept with (calledOver, guard.js), not sheltered from.
//
// Under cover is a roof: a block that is not leaves within eighteen over the player's head (a house, a cave,
// a mine). Under a tree a player is in the open, as monsters spawn there.
const HIDE_HEALTH = 8;
const HIDES = ['pillar', 'pillar_higher', 'bunker', 'out_of_sight', 'nook', 'seal', 'cap_fight', 'dig_down', 'low_ceiling', 'take_cover',
  'box_here', 'box_at_spawner', 'dig_in', 'dig_in_and_fight', 'dig_in_at_spawner', 'build_hole_at_spawner'];
function underCover(bot, entity) {
  try {
    if (!entity?.position || typeof bot?.blockAt !== 'function') return false;
    return !skyOpen(bot, entity.position.floored());
  } catch (_) { return false; }
}
// A player in the game by name, case aside: { name, entity } (entity null out of view), or null.
function playerNamed(bot, name) {
  const key = Object.keys(bot?.players || {}).find(p => p.toLowerCase() === String(name || '').toLowerCase());
  return key ? { name: key, entity: bot.players[key]?.entity || null } : null;
}
// The other players in view within `within` blocks, nearest first: [{ name, entity, d }].
function playersNear(bot, within = STAY_UP) {
  const me = bot?.entity?.position, out = [];
  for (const [name, player] of Object.entries(bot?.players || {})) {
    const at = player?.entity?.position;
    if (!me || !at || name === bot.username) continue;
    const d = at.distanceTo(me);
    if (d <= within) out.push({ name, entity: player.entity, d });
  }
  return out.sort((a, b) => a.d - b.d);
}
// Why the hiding ways are left off the fight now, or null: { why, player }.
// The stance's ways to run from a fight (survival.js RUN_STANCES): left off too while the bot guards a player, except
// from a creeper while the bot is within GUARD_TETHER blocks of the player. Live trial 2026-11-22: retreats and runs
// took the guard 35 and then 95 blocks from the player it guarded. -> the keys for withhold.
const RUNS = ['retreat', 'leave_reach', 'run_from'];
const GUARD_TETHER = 12;
function fightKeysOut(bot, out, danger = [], runs = RUNS) {
  if (!out?.guarding) return HIDES;
  const at = playerNamed(bot, out.player)?.entity?.position, me = bot?.entity?.position;
  const fromCreeper = !!(at && me && at.distanceTo(me) <= GUARD_TETHER && (danger || []).some(t => t?.entity?.name === 'creeper'));
  return fromCreeper ? HIDES : [...HIDES, ...runs];
}
// Waiting with a player, the bot holds its ground (asked for 2026-11-22: "should a waiting Jev hold its ground near
// you?" "yes"). The waiting bot's run from a mob in reach (reactive-wait.js) took it 109 blocks from the player beside
// it in under a minute that day, and by night a bot more than STAY_UP blocks from every player is alone and digs in.
// So, waiting with a player (withPlayer): within WAIT_TETHER blocks of them it may still give ground; farther off the
// run is left off and it fights where it stands, while its health holds above HIDE_HEALTH. The run is kept from a
// creeper, and from a shooter out of the sword's reach (swinging where it stands lands nothing on one).
// -> { player, distance, why } when the run is to be left off, or null.
const WAIT_TETHER = 12, SWORD_REACH = 3.5;
function holdsGround(bot, threats = [], now = Date.now()) {
  const with_ = bot?._company, me = bot?.entity?.position;
  if (!with_ || !me || now - with_.at > WITH_MS || (bot.health ?? 20) <= HIDE_HEALTH) return null;
  const { shooter } = require('./mob-policy');
  if ((threats || []).some(t => t?.entity?.name === 'creeper' || (shooter(t?.entity) && !(t.distance <= SWORD_REACH)))) return null;
  const at = bot.players?.[with_.name]?.entity?.position || with_.position;
  if (!at) return null;
  const distance = Math.hypot(at.x - me.x, at.y - me.y, at.z - me.z);
  return distance > WAIT_TETHER ? { player: with_.name, distance, why: `${with_.name} is ${Math.round(distance)} blocks off` } : null;
}
// The ways to food that walk off (food-plan.js's walks, the hunts and the far errands): left off while the bot guards
// a player and hunger holds above six, where another way to food is left (that trial: a food plan at hunger 18 sent
// the guard hunting). -> the keys taken out of the survival_priority tree's obtain_food.
const FOOD_WALKS = /^(hunt_\w+|seen_food_\d+|search_food|go_home_for_food|village_food|return_for_food|hoglin_food|raid_bastion)$/;
function guardFoodOut(tree, out, food) {
  const kids = out?.guarding && (food ?? 20) > 6 ? tree?.obtain_food?.children : null;
  if (!kids) return [];
  const walks = Object.keys(kids).filter(k => FOOD_WALKS.test(k));
  if (!walks.length || !Object.keys(kids).some(k => !walks.includes(k) && k !== 'none_good')) return [];
  for (const k of walks) delete kids[k];
  return walks;
}
function keepsOut(bot, goal) {
  if (!bot?.entity?.position || (bot.health ?? 20) <= HIDE_HEALTH) return null;
  const guarding = require('./guard').guarded(goal), g = guarding && playerNamed(bot, guarding);
  if (g?.entity) return { why: `guarding ${g.name}`, player: g.name, guarding: true };
  if (!nightMode() || !darkNow(bot)) return null;
  const out = playersNear(bot, STAY_UP).find(p => !underCover(bot, p.entity));
  return out ? { why: `${out.name} is out in the open ${Math.round(out.d)} blocks off`, player: out.name } : null;
}
// Takes the hiding ways out of a fight's options while another way stays: -> the keys taken out.
function withhold(options, out, keys = HIDES) {
  if (!out || !options) return [];
  const gone = keys.filter(k => options[k]);
  const left = Object.keys(options).filter(k => !gone.includes(k) && k !== 'none_good');
  if (!gone.length || !left.length) return [];
  for (const k of gone) delete options[k];
  return gone;
}

module.exports = { oweBack, HIDE_HEALTH, HIDES, RUNS, GUARD_TETHER, WAIT_TETHER, holdsGround, litAbout, LIT_ASKED_MS, FOOD_WALKS, fightKeysOut, guardFoodOut, underCover, playerNamed, playersNear, keepsOut, withhold, calledOver, callerState, lapsed, here, inShelter, holedUp, routine, standing, darkNow, drawnOut, pocketFirst, CLIMB_MS, rimOf, openGround, inLeftPocket, climbOut, afterLeave, LEFT_MS, nightMode, staysUp, comesOut, nearestPlayer, STAY_UP, COME_OUT, ALONE_MS, OUT_MS, inView, spotsInView, standInView, standable, EYE, REACH, RISE, CALL_HOLDS_MS, GONE_MS,
  withPlayer, gaveGround, letGo, backDue, WITH_MS, BACK_QUIET_MS, BACK_OFF, NEAR_PLAYER, BACK_HOLDS_MS, BACK_TRIES, BACK_RETRY_MS };
