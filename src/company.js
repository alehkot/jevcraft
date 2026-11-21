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
const { Vec3 } = require('vec3');

const EYE = 1.62;
const REACH = 4;            // blocks round the player a spot is looked for in
const RISE = 2;             // and above or below their feet
const WALK_MS = 12000;      // the one walk to it

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

module.exports = { calledOver, callerState, lapsed, here, inView, spotsInView, standInView, standable, EYE, REACH, RISE, CALL_HOLDS_MS, GONE_MS };
