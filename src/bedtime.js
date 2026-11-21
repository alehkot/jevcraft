'use strict';
// To bed when the players go (asked for by the server's owner, 2026-11-21: a companion that goes
// to sleep when all the players do, as another player would). A waiting bot, or one following a
// player, that sees every other player in the game lying in a bed walks to a free bed standing
// within sixteen blocks and lies down in it. It gets up when one of them does, at morning, or
// when something comes for it.
//
// By rule, with no question asked: the players' night is over about five seconds after the last
// of them lies down, and an answer takes longer than that.
//
// This is not survival.js sleepStep, which is the bot's own night: that one places the bed it
// carries, digs out what hangs over a standing bed, and writes the night off for ten minutes on
// a refusal. Here nothing is dug, placed or taken, because the beds stand in somebody's house:
// the walk is made with digging, pillaring and bridging off, and a bed that cannot be reached or
// lain in is left. With no free bed in reach the bot says so once a night and stays up.
const { isBed } = require('./home-base');
const { DAY } = require('./day');
const { Task } = require('./skills');

const BED_REACH = 16;       // blocks: a free bed this near is walked to
const SLEEPING = 2;         // the pose the game sends for a player in bed
const TRIES = 2;            // walks to a bed that fail, a night
const RETRY_MS = 10000;     // between two looks for a bed
const WALK_MS = 12000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const overworld = bot => /overworld/.test(String(bot?.game?.dimension || ''));
// The hours the game lets a bed be lain in: the night, and a thunderstorm at any hour.
function bedHours(bot) {
  if (!overworld(bot)) return false;
  const t = bot.time?.timeOfDay;
  return (Number.isFinite(t) && t >= DAY.SLEEP_FROM && t <= DAY.SLEEP_UNTIL) || (!!bot.isRaining && bot.thunderState > 0);
}

const occupied = block => { const p = block?.getProperties?.() || {}; return p.occupied === true || p.occupied === 'true'; };
// A player lying in a bed. Two signs, either taken: the pose the game sends for them, and the bed
// itself, which says it is occupied with the player at its pillow.
function asleep(bot, entity) {
  if (!entity?.position) return false;
  const keys = bot.registry?.entitiesByName?.player?.metadataKeys;
  const at = keys ? keys.indexOf('pose') : -1;
  if (at >= 0 && entity.metadata?.[at] === SLEEPING) return true;
  try {
    const block = bot.blockAt(entity.position.floored());
    return isBed(block) && occupied(block);
  } catch (_) { return false; }
}
// By which sign each other player is seen in bed, for the log: "pose", "bed", "pose+bed" or "up".
function signs(bot) {
  const keys = bot.registry?.entitiesByName?.player?.metadataKeys, at = keys ? keys.indexOf('pose') : -1;
  return Object.entries(bot?.players || {}).filter(([name]) => name !== bot.username).map(([, player]) => {
    const e = player?.entity; if (!e?.position) return 'out of view';
    let inBed = false; try { const b = bot.blockAt(e.position.floored()); inBed = isBed(b) && occupied(b); } catch (_) { inBed = false; }
    return [at >= 0 && e.metadata?.[at] === SLEEPING && 'pose', inBed && 'bed'].filter(Boolean).join('+') || 'up';
  }).join(', ');
}
// Every other player in the game is in view and in a bed. With nobody else in the game there is
// no one to go to bed with; a player out of view is not known to be asleep; one only looking on
// (spectator) is not counted, as the game does not count them.
function allAsleep(bot) {
  const others = Object.entries(bot?.players || {}).filter(([name, player]) => name !== bot.username && player?.gamemode !== 3);
  return others.length > 0 && others.every(([, player]) => asleep(bot, player?.entity));
}

// The free beds standing within reach, nearest first: the foot half of a whole bed nobody lies
// in, with a cell beside it to stand in. (survival.js observedBed finds one bed within 48 blocks
// for the bot's own night.)
const FACING = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
function freeBeds(bot, reach = BED_REACH) {
  if (!overworld(bot) || typeof bot.findBlocks !== 'function' || !bot.entity?.position) return [];
  const ids = (bot.registry?.blocksArray || []).filter(b => /_bed$/.test(b.name)).map(b => b.id);
  if (!ids.length) return [];
  const here = bot.entity.position;
  const standable = p => bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block' &&
    [0, 1].every(dy => { const b = bot.blockAt(p.offset(0, dy, 0)); return !!b && b.boundingBox === 'empty' && !/water|lava/.test(b.name); });
  const beds = [];
  for (const p of bot.findBlocks({ matching: ids, maxDistance: reach, count: 64 })) {
    const block = bot.blockAt(p);
    if (!isBed(block)) continue;
    const props = block.getProperties?.() || {};
    if (props.part === 'head' || occupied(block)) continue;
    const [dx, dz] = FACING[props.facing] || [0, 0];
    const head = p.offset(dx, 0, dz), pillow = bot.blockAt(head);
    if ((!dx && !dz) || !isBed(pillow) || occupied(pillow)) continue;
    const stand = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => p.offset(x, 0, z)).find(c => !c.equals(head) && standable(c));
    if (stand) beds.push({ foot: p, head, stand, name: block.name, distance: p.distanceTo(here) });
  }
  return beds.sort((a, b) => a.distance - b.distance);
}

// What this night has seen: its walks to a bed, and what was said. One record a night.
function nightOf(bot) {
  const key = Number.isFinite(bot.time?.day) ? bot.time.day : 0;
  if (bot._bedtime?.night !== key) bot._bedtime = { night: key, tries: 0, at: 0, said: {} };
  return bot._bedtime;
}
// Whether to head for bed now.
function due(bot, now = Date.now()) {
  if (!bot?.entity?.position || bot.isSleeping || bot.isAlive === false || !bedHours(bot) || !allAsleep(bot)) return false;
  const night = nightOf(bot);
  return night.tries < TRIES && now - night.at >= RETRY_MS;
}

// The walk to a free bed and the night in it. Ends with the bot on its feet: when a player is up
// (stay), at morning, on trouble, or when the task is cancelled.
//   -> { outcome: 'slept' | 'no_bed' | 'no_way' | 'refused' | 'stopped', bed?, reason? }
async function toBed(bot, task, { navigate = require('./skills').navigate, goals = require('mineflayer-pathfinder').goals,
  stay = () => allAsleep(bot), trouble = () => false, save = () => {}, say = line => bot.chat?.(line), log = console.log, walkMs = WALK_MS } = {}) {
  const night = nightOf(bot);
  const once = (key, line) => { if (!night.said[key]) { night.said[key] = true; say(line); } };
  const why = () => (!bedHours(bot) ? 'morning' : !stay() ? 'a player is up' : trouble() ? 'something came for it' : null);
  const over = () => !!why();
  const beds = freeBeds(bot);
  if (!beds.length) {
    night.at = Date.now();
    if (!night.said.no_bed) log(`[bedtime] every player is in bed and no free bed stands within ${BED_REACH} blocks: staying up`);
    once('no_bed', "There's no free bed near here, so I'll stay up and keep watch.");
    return { outcome: 'no_bed' };
  }
  log(`[bedtime] every player is in bed (seen by: ${signs(bot)}): to the free bed at (${beds[0].foot.x}, ${beds[0].foot.y}, ${beds[0].foot.z}), ${Math.round(beds[0].distance)} blocks off`);
  let result = { outcome: 'no_way', reason: 'no bed was reached' };
  try {
    for (const bed of beds.slice(0, 2)) {
      task.check();
      if (over()) return (result = { outcome: 'stopped' });
      // Nothing of the house is dug through, pillared on or bridged over on the way.
      const m = bot.pathfinder?.movements;
      const before = m && { canDig: m.canDig, allow1by1towers: m.allow1by1towers, scafoldingBlocks: m.scafoldingBlocks };
      if (m) Object.assign(m, { canDig: false, allow1by1towers: false, scafoldingBlocks: [] });
      try { await navigate(bot, task, new goals.GoalNear(bed.stand.x, bed.stand.y, bed.stand.z, 1), { timeoutMs: walkMs, stallMs: 4000, stopWhen: over, sprint: true }); }
      catch (err) {
        task.check();
        if (['Cancelled', 'NeedsAir', 'NeedsSafety'].includes(err?.name)) throw err;
        result = { outcome: 'no_way', bed, reason: String(err?.message || err).slice(0, 160) };
        continue;
      } finally { if (m) Object.assign(m, before); }
      task.check();
      if (over()) return (result = { outcome: 'stopped' });
      const foot = bot.blockAt(bed.foot);
      if (!isBed(foot) || occupied(foot)) { result = { outcome: 'refused', bed, reason: 'the bed is occupied' }; continue; }
      // The server answers the click a moment later: the bot lies down, or a line says why not.
      let refused = null;
      const onMessage = message => { const key = message?.json?.translate || message?.translate || String(message || ''); if (/bed\.(not_safe|too_far_away|obstructed|occupied|no_sleep)/.test(key)) refused = key; };
      bot.on?.('message', onMessage);
      try {
        // Mineflayer gives up after three seconds without its sleep event and throws "bot is not
        // sleeping"; its own checks (not night, monsters near, too far) are refusals (survival.js sleepStep).
        try { await bot.sleep(foot); }
        catch (err) {
          if (!/not sleeping/.test(err?.message || '')) { result = { outcome: 'refused', bed, reason: String(err?.message || err).slice(0, 160) }; continue; }
        }
        const clicked = Date.now();
        while (!bot.isSleeping && !refused && Date.now() - clicked < 2000) { task.check(); if (over()) break; await sleep(100); }
        if (!bot.isSleeping) {
          result = refused ? { outcome: 'refused', bed, reason: require('./survival').sleepRefusalSays(refused, bot) } : over() ? { outcome: 'stopped' } : { outcome: 'refused', bed, reason: 'the bed did not take me' };
          if (result.outcome === 'stopped') return result;
          continue;
        }
        // In bed. The game has moved the respawn to this bed, and the bot's record follows it
        // (survival.js sleepStep keeps the same record for every bed slept in), marked as a bed
        // lain in as a guest: not a home to put a chest by (bed-kit.js), not a bed to take up and
        // carry to a portal (portal-camp.js).
        if (bot._survivalState) {
          bot._survivalState.spawnBed = { name: foot.name || 'bed', foot: { x: bed.foot.x, y: bed.foot.y, z: bed.foot.z }, head: { x: bed.head.x, y: bed.head.y, z: bed.head.z }, at: new Date().toISOString(), guest: true };
          try { save(); } catch (_) { /* the record is saved with the next step */ }
        }
        log(`[bedtime] in the bed at (${bed.foot.x}, ${bed.foot.y}, ${bed.foot.z})`);
        once('night', 'Good night!');
        let ended = 'woken by the game';
        try { while (bot.isSleeping) { task.check(); if (over()) { ended = why() || ended; break; } await sleep(200); } }
        catch (err) { ended = 'called away'; throw err; }
        finally { log(`[bedtime] up again: ${task.cancelled ? 'called away' : ended}`); }
        return (result = { outcome: 'slept', bed });
      } finally {
        bot.removeListener?.('message', onMessage);
        // Up again whatever ended it, and on its feet before anything else is asked of it.
        if (bot.isSleeping) {
          try { await bot.wake(); } catch (_) { /* already up */ }
          const asked = Date.now();
          while (bot.isSleeping && Date.now() - asked < 1500) await sleep(50);
        }
      }
    }
    if (result.outcome !== 'slept' && result.outcome !== 'stopped') {
      log(`[bedtime] not in bed: ${result.reason}`);
      once('failed', `I can't get into the free bed (${result.reason}), so I'll stay up.`);
    }
    return result;
  } finally {
    // A walk that did not end in bed counts against the night; a night in bed, or one a player's rising ended, does not.
    night.at = Date.now(); if (['no_way', 'refused'].includes(result.outcome)) night.tries++;
  }
}

// The waiting bot's bedtime (JEV_IDLE=wait, session.js): started from the half-second timer when
// it is due, and running until the bot is on its feet again.
function createBedtime({ bot, isReady = () => true, isBusy = () => false, trouble = () => false, save = () => {}, navigate, goals } = {}) {
  let active = null;
  const allowed = () => isReady() && !isBusy() && bot.isAlive !== false;
  const stopMotion = () => { bot.pathfinder?.setGoal?.(null); bot.clearControlStates?.(); };
  return {
    busy: () => !!active,
    // True while the bot is on its way to a bed or in one, so that nothing else is begun.
    tick() {
      if (active) return true;
      if (!allowed() || !due(bot)) return false;
      const task = new Task('bedtime', 'Go to bed when the players do');
      const record = { task, promise: null }; active = record;
      record.promise = Promise.resolve().then(() => toBed(bot, task, { trouble: () => !allowed() || !!trouble(), save, ...(navigate && { navigate }), ...(goals && { goals }) }))
        .catch(err => { if (err?.name !== 'Cancelled' && !task.cancelled) console.error('[bedtime]', err); return null; })
        // Called away, the legs are whoever called's by now (cancel below stopped them at the call): the bed task
        // settles up to two seconds later, the bot out of its bed by then, and must not stop a walk begun since.
        .finally(() => { if (active === record) { active = null; if (!task.cancelled) stopMotion(); } });
      return true;
    },
    async cancel() {
      const record = active; if (!record) return;
      record.task.cancel(); stopMotion();
      if (bot.isSleeping) { try { await bot.wake(); } catch (_) { /* already up */ } }
      await record.promise.catch(() => {});
    },
  };
}

module.exports = { BED_REACH, TRIES, RETRY_MS, bedHours, asleep, signs, allAsleep, freeBeds, nightOf, due, toBed, createBedtime };
