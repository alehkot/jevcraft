'use strict';
// Guarding a player ("Jev protect me"; asked for on 2026-11-22). Before it, a player could be killed again and
// again by endermen and skeletons while Jev answered "I can't protect you from attacks, but I can stay close to
// you" and, at night, pillared and dug in a few blocks from them.
//
// A guard is a follow with `guard: true` (companion-actions.js): the bot keeps by the player as a follow does,
// and goes for the monsters that come at them. What it goes for, best first:
// - what hurt the player in the last HIT_MS: the server's damage event names the attacker (the skeleton for
//   its arrow), so a shooter outside any radius counts, and so does an enderman that turned on them;
// - a hostile mob within NEAR blocks of the player and about their height.
// Not a creeper (struck beside the player it blows up there; the stance answers one that comes at the bot),
// not what flies or the Warden, and not a calm enderman or another neutral that has not hurt the player:
// looked at or struck, an enderman turns on both of them.
//
// The fight is the survival layer's, on the night hunt's pattern (survival.js huntStep): the mob is closed on
// over level ground, with no digging or towering, and struck. While it is the target it is no threat to the
// checks (danger.js nightHunted), so they do not run from it; any other mob is answered by the stance as
// ever. While the bot guards, the stance's ways that hide it (a pillar, a seal, a nook) are left out above
// company.HIDE_HEALTH (company.js keepsOut). Below that the bot may save itself as ever, and it does not go
// for anything.
const { goals } = require('mineflayer-pathfinder');

const NEAR = 8;          // a monster this near the guarded player is gone for
const RISE = 4;          // and within this many blocks of their height (not one in a cave below them)
const REACH = 24;        // nothing farther than this from the bot
const HIT_MS = 6000;     // what hurt the player this lately is gone for first, wherever it stands
const SAY_MS = 60000;    // a line about the fight at most this often
const SKIP_MS = 20000;   // a mob given up on is gone for again after this, or at once when it hurts the player
const NEVER = new Set(['creeper', 'phantom', 'ghast', 'warden', 'ender_dragon', 'wither', 'blaze', 'vex', 'shulker', 'guardian',
  'elder_guardian', 'breeze', 'end_crystal']);
const UNLESS_HIT = new Set(['enderman', 'zombified_piglin', 'piglin', 'wolf', 'bee', 'iron_golem', 'polar_bear', 'llama',
  'trader_llama', 'panda', 'goat', 'dolphin']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = n => Math.round(n * 10) / 10;
const named = name => String(name || '').replaceAll('_', ' ');

// The player a goal guards, or null.
const guarded = goal => goal?.kind === 'follow' && goal.guard ? (goal.target || goal.from || null) : null;

function keyOf(map, name) {
  return Object.keys(map || {}).find(k => k.toLowerCase() === String(name || '').toLowerCase());
}
function entityOf(bot, name) {
  const key = keyOf(bot?.players, name), e = key && bot.players[key]?.entity;
  return e?.position && e.isValid !== false ? e : null;
}

// What hurt a player, from the server's damage events (the attacker's entity id; the shooter for an arrow).
// Installed once a session (session.js); a packet it cannot read is passed over.
function watch(bot) {
  if (!bot?._client?.on || bot._guardWatching) return;
  bot._guardWatching = true;
  bot._client.on('damage_event', packet => {
    try {
      const by = Number(packet?.sourceCauseId) - 1;
      if (!(by >= 0) || by === bot.entity?.id) return;
      const victim = Object.values(bot.players || {}).find(p => p?.entity && p.entity.id === packet.entityId);
      if (!victim || victim.username === bot.username) return;
      const hits = ((bot._playerHits ||= {})[victim.username] ||= []);
      hits.push({ by, at: Date.now() });
      if (hits.length > 6) hits.splice(0, hits.length - 6);
    } catch (_) { /* not read */ }
  });
}

// What to go for, best first: [{ entity, hit, toPlayer, toBot }]. `dark` is the night (company.js darkNow):
// a spider by day is left alone unless it hurt the player, as the game's own spiders leave players be.
function targets(bot, goal, { now = Date.now(), dark = null } = {}) {
  const name = guarded(goal), player = name && entityOf(bot, name), me = bot?.entity?.position;
  if (!player || !me) return [];
  const night = dark ?? require('./company').darkNow(bot);
  const hostile = require('./danger').hostileNames;
  // Who hurt the player lately, and when last: the attacker's id -> the time.
  const hits = new Map();
  for (const h of bot._playerHits?.[keyOf(bot._playerHits, name)] || []) if (now - h.at <= HIT_MS) hits.set(h.by, Math.max(hits.get(h.by) || 0, h.at));
  const out = [];
  for (const e of Object.values(bot.entities || {})) {
    if (!e?.position || e === bot.entity || e === player || e.isValid === false || e.type === 'player' || NEVER.has(e.name)) continue;
    const toBot = e.position.distanceTo(me);
    if (toBot > REACH) continue;
    const toPlayer = e.position.distanceTo(player.position), hit = hits.has(e.id);
    if (!hit) {
      if (!hostile?.has(e.name) || UNLESS_HIT.has(e.name)) continue;
      if (/spider$/.test(e.name || '') && !night) continue;
      if (toPlayer > NEAR || Math.abs(e.position.y - player.position.y) > RISE) continue;
    }
    out.push({ entity: e, hit, hitAt: hits.get(e.id) || 0, toPlayer, toBot });
  }
  return out.sort((a, b) => (Number(b.hit) - Number(a.hit)) || a.toPlayer - b.toPlayer);
}

// A mob given up on (step: three tries in a row that came no nearer) is left for SKIP_MS, and gone for again at
// once when it hurts the player after that. It was left for the whole connection, hurt them or not.
function givenUp(g, t, now) {
  const s = g.skip?.[t.entity.id];
  if (!s) return false;
  if (now < s.until && !(t.hitAt > s.at)) return true;
  delete g.skip[t.entity.id];
  return false;
}
// The one gone for: the one already gone for while it is still about, unless another has hurt the player
// and it has not; else the best. A mob given up on is passed over while that lasts (givenUp).
// The guard's own memory is the bot's (entity ids are this connection's, not to be saved).
function pick(bot, goal, now = Date.now()) {
  const g = bot?._guard || {};
  const list = targets(bot, goal, { now }).filter(t => !givenUp(g, t, now));
  const held = list.find(t => t.entity.id === g.targetId);
  return held && (held.hit || !list[0].hit) ? held : list[0] || null;
}

// The survival layer's claim (survival.js claim): the facts for the arbiter, or null. Not at
// company.HIDE_HEALTH or below, and not in creative. The mob picked is the guard's for three seconds:
// no threat to run from (danger.js nightHunted), so the claim and the step see it as the guard's.
// What the guard saw, in the log when it changes (at most every four seconds the same line).
// Said again when what it is about changes (the mob gone for, or nothing), else at most every fifteen seconds
// (a minute for nothing to go for).
function saw(bot, line, now = Date.now(), key = line) {
  if (bot._guardSaw === key && now - (bot._guardSawAt || 0) < (String(key).startsWith('none') ? 60000 : 15000)) return;
  bot._guardSaw = key; bot._guardSawAt = now; console.log(`[guard] ${line}`);
}
function due(bot, goal, now = Date.now()) {
  if (!guarded(goal) || bot?.game?.gameMode === 'creative') return null;
  if ((bot?.health ?? 20) <= require('./company').HIDE_HEALTH) { saw(bot, `health ${bot.health}: saving itself, not guarding`, now, 'low'); return null; }
  const t = pick(bot, goal, now);
  if (!t) {
    const p = entityOf(bot, guarded(goal)), me = bot.entity?.position;
    const about = me ? Object.values(bot.entities || {}).filter(e => e?.position && e.type !== 'player' && e !== bot.entity && e.position.distanceTo(me) <= REACH)
      .map(e => `${e.name}(${e.type}) ${p ? round(e.position.distanceTo(p.position)) : '?'} from them`).slice(0, 6) : [];
    saw(bot, `nothing to go for: ${guarded(goal)} ${p ? 'in view' : 'not in view'}; within ${REACH} of the bot: ${about.join(', ') || 'nothing'}`, now, `none:${!!p}`);
    return null;
  }
  saw(bot, `going for the ${t.entity.name} ${round(t.toPlayer)} from ${guarded(goal)}${t.hit ? ' (it hurt them)' : ''}, ${round(t.toBot)} from the bot`, now, `t:${t.entity.id}:${t.hit}`);
  bot._guardTarget = { id: t.entity.id, name: t.entity.name, until: now + 3000 };
  return { player: guarded(goal), target: t.entity.name, toPlayer: Math.round(t.toPlayer), distance: Math.round(t.toBot), ...(t.hit ? { hurtThem: true } : {}) };
}
// The fight for the guarded player is not weighed against the follow it is part of (work.js liveTurn).
const first = (bot, goal, claims = []) => !!guarded(goal) && (claims || []).some(c => c?.layer === 'survival' && ['guard', 'escape_threat'].includes(c.action));

// One blow at the target, with the weapon carried and the swing's own cooldown (combat.js defendNearby's
// timing; a struck mob is unhurt for half a second, so a blow sooner is wasted).
async function swing(bot, task, target) {
  const { defenseWeapon, strike, canStrike } = require('./combat');
  const { SWING_MS } = require('./combat-estimate');
  // A player beside the mob: no sword's sweep into them (combat.js bystanders). An axe or a pickaxe is taken up for
  // the blow before it, not swapped to at the swing as strike() would: a weapon taken up starts its swing over, and
  // a blow struck at once lands a fifth of its damage.
  const items = bot.inventory?.items?.() || [];
  const beside = Object.values(bot.players || {}).some(p => p?.entity && p.username !== bot.username && p.entity.position?.distanceTo?.(target.position) <= 2.5);
  let weapon = defenseWeapon(bot);
  if (beside && /_sword$/.test(weapon?.name || '')) weapon = items.find(i => /_axe$/.test(i.name)) || items.find(i => /_pickaxe$/.test(i.name)) || weapon;
  if (weapon && bot.heldItem?.name !== weapon.name) { await bot.equip(weapon, 'hand'); bot._guardEquipAt = Date.now(); task.check(); }
  const kind = weapon ? weapon.name.split('_').at(-1) : 'fist';
  const wait = (SWING_MS[kind] || SWING_MS.fist) - (Date.now() - Math.max(bot._defenseAttackAt || 0, bot._guardEquipAt || 0));
  if (wait > 0) { await sleep(Math.min(wait, 100)); task.check(); return 'cooldown'; }
  bot.pathfinder?.setGoal?.(null); bot.clearControlStates?.();
  await bot.lookAt(target.position.offset(0, (target.height || 1.8) / 2, 0), true);
  task.check();
  if (bot.entities?.[target.id] !== target || target.isValid === false || !canStrike(bot, target)) return 'gone';
  // A neutral struck is angry with the bot from here (danger.js provoked).
  if (UNLESS_HIT.has(target.name)) { bot._provokedMobs ||= new Map(); bot._provokedMobs.set(target.id, target); }
  const swung = await strike(bot, task, target);
  bot._defenseAttackAt = bot._threatResponseAt = Date.now();
  bot._struck = { id: target.id, at: bot._defenseAttackAt };
  return swung;
}

// One step of the guard (survival.js step, while nothing else is on the bot): the target closed on and
// struck. -> true when it did something, false when there is nothing to go for.
async function step(survival, task, goal, save) {
  const bot = survival.bot;
  const { canStrike } = require('./combat');
  const g = (bot._guard ||= {});
  const chosen = (bot.health ?? 20) > require('./company').HIDE_HEALTH ? pick(bot, goal) : null;
  if (!chosen) {
    if (g.targetId != null) survival.report?.(goal, save, { action: 'guard_over', why: (bot.health ?? 20) <= require('./company').HIDE_HEALTH ? `health down to ${bot.health}` : 'nothing coming at the player', player: guarded(goal) });
    delete g.targetId; delete bot._guardTarget; return false;
  }
  const target = chosen.entity, player = guarded(goal);
  if (g.targetId !== target.id) { g.targetId = target.id; g.misses = 0; g.since = Date.now(); }
  bot._guardTarget = { id: target.id, name: target.name, until: Date.now() + 3000 };
  if (!(Date.now() - (g.saidAt || 0) < SAY_MS)) {
    g.saidAt = Date.now();
    bot.chat?.(chosen.hit ? `Got your back, ${player}! Going for the ${named(target.name)}.` : `A ${named(target.name)} by you, ${player}. I've got it.`);
  }
  survival.report?.(goal, save, { action: 'guard', target: target.name, player, toPlayer: round(chosen.toPlayer), distance: round(chosen.toBot), hurtThem: chosen.hit, health: bot.health });
  if (canStrike(bot, target)) { g.misses = 0; await swing(bot, task, target); return true; }
  // Closed on without digging or towering. After three tries in a row that came no nearer the mob is left for
  // SKIP_MS (givenUp). The tries counted are those in a row: a blow in reach or a walk that closed on it starts the
  // count over. It was three in all, never started over, so a skeleton backing off and closed on again was given
  // up on for the tries before, and for good (found reading the code after the trial of 2026-11-22).
  const movements = bot.pathfinder?.movements;
  const kept = movements && { canDig: movements.canDig, allow1by1towers: movements.allow1by1towers };
  if (movements) Object.assign(movements, { canDig: false, allow1by1towers: false });
  const from = bot.entity.position.clone(), before = target.position.distanceTo(from);
  try {
    await survival.actions.navigate(bot, task, new goals.GoalFollow(target, 1.5),
      { timeoutMs: 3000, stallMs: 1500, stopWhen: () => canStrike(bot, target) || target.isValid === false });
  } catch (err) { task.check(); if (['NeedsAir', 'Cancelled'].includes(err?.name)) throw err; }
  finally { if (movements) Object.assign(movements, kept); }
  const stood = bot.entity.position.distanceTo(from) < 0.5;
  if (target.isValid !== false && !canStrike(bot, target) && (stood || target.position.distanceTo(bot.entity.position) >= before - 0.5)) {
    if (stood) await sleep(250);
    g.misses = (g.misses || 0) + 1;
    if (g.misses >= 3) {
      const now = Date.now();
      g.skip = { ...Object.fromEntries(Object.entries(g.skip || {}).filter(([, s]) => now < s.until)), [target.id]: { at: now, until: now + SKIP_MS } };
      console.log(`[guard] the ${target.name} ${round(target.position.distanceTo(bot.entity.position))} blocks off is left for ${SKIP_MS / 1000} s: three tries in a row came no nearer`);
      delete g.targetId; delete bot._guardTarget; g.misses = 0;
    }
  } else g.misses = 0;
  return true;
}

module.exports = { guarded, watch, targets, pick, due, first, step, swing, NEAR, RISE, REACH, HIT_MS, SKIP_MS, NEVER, UNLESS_HIT };
