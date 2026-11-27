'use strict';
const { goals } = require('mineflayer-pathfinder');

const DEFAULT_RADIUS = 12;
const distance = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
// JEV_STAY_CLOSE=<blocks>: with no stay-close of a player's own, the bot keeps within that many blocks of the player it
// is with (company.js withPlayer), or else the nearest one in sight. Asked for 2026-11-23: "it also by default tries to
// stay not further than 75 blocks from player". A player's "stay within N blocks" replaces it, and "stop staying
// close" turns it off until one is asked for again. Unset: no default, as before.
const defaultRadius = (env = process.env) => { const n = Number(String(env?.JEV_STAY_CLOSE ?? '').trim()); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const stored = bot => bot?.companionMemory?.state?.stayClose;
function defaultPlayer(bot) {
  const online = name => name && name !== bot?.username && bot?.players?.[name];
  if (online(bot?._company?.name)) return bot._company.name;
  const me = bot?.entity?.position;
  let best = null, nearest = Infinity;
  for (const [name, p] of Object.entries(bot?.players || {})) {
    const at = p?.entity?.position;
    if (name === bot?.username || !at || !me) continue;
    const d = distance(at, me);
    if (d < nearest) { best = name; nearest = d; }
  }
  // Nobody in sight: the default's player while they are online, not none (out of sight is not gone).
  return best || (online(bot?._stayDefault?.player) ? bot._stayDefault.player : null);
}
// The stay-close in force: a player's own, else the default, else none. The default is the same object while its
// player and radius hold: a regroup ends when the preference changes.
function preference(bot) {
  const own = stored(bot);
  if (own?.player) return own;
  if (own?.off) return null;
  const radius = defaultRadius();
  if (!radius) return own;
  const name = defaultPlayer(bot);
  if (!name) return null;
  const last = bot._stayDefault;
  return last?.player === name && last.radius === radius ? last : (bot._stayDefault = { player: name, radius, byDefault: true });
}
// Goals no regroup interrupts: a come or a follow is itself a walk to the player; under the default (not a player's
// own stay-close) neither is a walk the player sent the bot on: to a place, to find something, down a ladder.
const SENT = new Set(['visit', 'find', 'climb_ladder']);
const exempt = (bot, goal) => ['come', 'follow'].includes(goal?.kind) || (SENT.has(goal?.kind) && Boolean(preference(bot)?.byDefault));

function readControl(text) {
  const s = text.toLowerCase().trim().replace(/^(?:please |can you |could you )/,'').replace(/[.!?]+$/, '').trim();
  if (/^(?:stop (?:staying|keeping) close(?: to me)?|(?:don't|do not) stay close(?: to me)?|(?:turn off|disable) stay[ -]close(?: mode)?|(?:you can )?roam freely)$/.test(s)) return { mode: 'off' };
  if (/^(?:stay[ -]close status|how close are you staying(?: to me)?)$/.test(s)) return { mode: 'status' };
  const match = /^(?:(?:stay|keep|stick) (?:close|near|nearby)(?: (?:to |with |by )?me)?|stay[ -]close mode)(?:[, ]+(?:within |max(?:imum)? |about )?(\d+) blocks?(?: (?:of|from) me)?)?$/.exec(s) ||
    // A distance with no "close" in it: "stay within 50 blocks", "stay max 50 blocks away", "keep no more than 50
    // blocks from me" (2026-11-23: "stay max 50 bloxks away" went to the language layer and was refused there).
    /^(?:stay|keep|be) (?:within|around|about|at most|max(?:imum)?|up to|no (?:more|farther|further) than|not more than) (\d+) blocks?(?: away)?(?: (?:of|from) me)?$/.exec(s);
  if (!match) return null;
  const radius = match[1] === undefined ? undefined : Number(match[1]);
  return radius !== undefined && !(Number.isSafeInteger(radius) && radius > 0) ? { mode: 'invalid' } : { mode: 'on', radius };
}

function status(bot) {
  const p = preference(bot);
  if (!p) return 'Stay-close mode is off.';
  const at = anchor(bot), apart = at && Math.round(distance(bot.entity.position, at.position));
  return `I aim to stay within ${p.radius} blocks of ${p.player}${p.byDefault ? ' (my default)' : ''}. ${at?.seen ? `We're ${apart} blocks apart.` : at ? `They're out of sight; I last saw them ${apart} blocks from here.` : "I'll pick that up when I can see them again."}`;
}

function applyControl(bot, from, input) {
  // The player's own setting before, not the default: "stay close to me" is 12 blocks whatever the default is.
  const memory = bot.companionMemory, previous = stored(bot);
  if (input.mode === 'status') return status(bot);
  if (input.mode === 'invalid') return 'Give me a positive whole number of blocks.';
  // Off is kept as off while there is a default, or the default would come straight back.
  if (input.mode === 'off') { if (defaultRadius()) memory.state.stayClose = { off: true }; else delete memory.state.stayClose; }
  else memory.state.stayClose = { player: from, radius: input.radius ?? (previous?.player === from ? previous.radius : DEFAULT_RADIUS) };
  delete bot._closeRegroup;
  memory.flush();
  return status(bot);
}

function player(bot) {
  const p = preference(bot), entity = p && bot.players?.[p.player]?.entity;
  return entity?.position && entity.isValid !== false && (!entity.dimension || entity.dimension === bot.game?.dimension) ? entity : null;
}

// Where the player kept to is: in sight, or where they were last seen in the last LAST_SEEN_MS while they are online and
// the bot is in that dimension. The server stops sending a player past its tracking range (96 blocks at a view distance
// of 6), and the stay-close went blind there: in the test window of 2026-11-23 the first tools took the bot 156 blocks
// off with the 75-block default, its status "I'll pick that up when I can see them again".
const LAST_SEEN_MS = 10 * 60000;
// JEV_STAY_CLOSE_OUT=<seconds>: how long the bot's own work (an errand, the first tools) may keep it outside the radius at
// a stretch before it comes back; asked for 2026-11-23: "jev should be able to go temporarily outside of the radius but
// for short time only". 90 when unset; 0 for not at all. A trip may end past the radius by as much as a walk out and back
// in that time at PACE, and by no more than half the radius.
const outMs = (env = process.env) => { const s = String(env?.JEV_STAY_CLOSE_OUT ?? '').trim(), n = Number(s); return s !== '' && Number.isFinite(n) && n >= 0 ? n * 1000 : 90000; };
const PACE = 1.5; // blocks a second, as keep-armed.js reckons a walk back
const excursion = (radius, env = process.env) => Math.min(radius / 2, outMs(env) / 1000 * PACE / 2);
function anchor(bot, now = Date.now()) {
  const p = preference(bot);
  if (!p) { delete bot._stayOut; return null; }
  const entity = player(bot), last = bot._stayLastSeen;
  let at = null;
  if (entity) {
    if (!last || last.player !== p.player || now - last.at > 500)
      bot._stayLastSeen = { player: p.player, position: { x: entity.position.x, y: entity.position.y, z: entity.position.z }, dimension: bot.game?.dimension, at: now };
    at = { position: entity.position, entity, seen: true };
  } else if (last && last.player === p.player && now - last.at <= LAST_SEEN_MS && bot.players?.[p.player] && !(last.dimension && last.dimension !== bot.game?.dimension)) {
    at = { position: last.position, entity: null, seen: false };
  }
  // Since when the bot has been outside the radius at a stretch (due).
  if (!at || !bot.entity?.position || distance(bot.entity.position, at.position) <= p.radius) delete bot._stayOut;
  else bot._stayOut ||= { since: now };
  return at;
}

// Nothing inside the preferred distance costs extra. Outside it the slope
// increases smoothly and stays finite, so a unique distant source still wins.
function pull(distance, radius) {
  const over = Math.max(0, distance - radius);
  return 3 * over * (over / (radius + over));
}

function travelScore(bot, point, site) {
  const at = anchor(bot), walk = distance(bot.entity.position, point);
  const local = at ? pull(distance(at.position, point), preference(bot).radius) : 0;
  return walk + local + (site ? pull(distance(site, point), 4) : 0);
}

function biasRoutes(bot, from, moves) {
  if (['vitals', 'survival', 'hunt'].includes(bot._turn?.holder)) return;
  const at = anchor(bot);
  if (!at) return;
  const radius = preference(bot).radius;
  // A bounded total surcharge keeps a long, necessary route within the
  // pathfinder's normal search budget. Inward moves always retain their cost.
  const fromPlayer = distance(bot.entity.position, at.position);
  const baseCost = pull(fromPlayer, radius);
  const potential = p => Math.min(baseCost + 20, pull(distance(p, at.position), radius));
  const before = potential(from);
  for (const move of moves) move.cost += Math.max(0, potential(move) - before);
}

// -> 'out' when the bot's own work has been outside the radius longer than JEV_STAY_CLOSE_OUT, true for any other
// regroup due, false for none.
function due(bot, idle, now = Date.now(), goal = null) {
  const at = bot.entity?.position && anchor(bot, now);
  if (!at) return false;
  const radius = preference(bot).radius, d = distance(bot.entity.position, at.position);
  const last = bot._closeRegroup;
  if (d <= radius) { bot._closeRegroup = { at: last?.at || 0, position: { x: at.position.x, y: at.position.y, z: at.position.z } }; return false; }
  if (!idle && (goal?.weaponErrand || goal?.chore) && bot._stayOut && now - bot._stayOut.since >= outMs() && !(last?.at && now - last.at < 20000)) return 'out';
  if (d < radius + (idle ? 1 : Math.max(3, radius / 3)) || (last?.at && now - last.at < (idle ? 4000 : 20000))) return false;
  // Working a fixed, distant site is legitimate. A player moving on can
  // call the work back; a stationary player does not cause a commute per block.
  return idle || !last || distance(last.position, at.position) >= Math.max(3, radius / 2);
}

async function regroup(bot, task, navigate, idle, goal = null) {
  const why = due(bot, idle, Date.now(), goal);
  if (!why) return false;
  const cfg = preference(bot), outFor = bot._stayOut ? Date.now() - bot._stayOut.since : 0, at = anchor(bot), entity = at.entity, spot = at.position;
  const range = Math.max(1, Math.floor(cfg.radius * .8)), far = distance(bot.entity.position, spot);
  bot._closeRegroup = { at: Date.now(), position: { x: spot.x, y: spot.y, z: spot.z } };
  // Out too long: the walk is all the way back, not ten seconds of it.
  if (why === 'out') console.log(`[stay] back within ${cfg.radius} blocks of ${cfg.player}: ${Math.round(outFor / 1000)} s outside, ${Math.round(far)} blocks off${at.seen ? '' : ' (where last seen)'}`);
  const timeoutMs = why === 'out' ? Math.max(10000, Math.ceil(far / PACE) * 1000) : 10000;
  // In sight: followed. Out of sight: to where they were last seen, until they are in sight again.
  const toward = entity ? new goals.GoalFollow(entity, range) : new goals.GoalNear(spot.x, spot.y, spot.z, range);
  try {
    await navigate(bot, task, toward, { timeoutMs, stallMs: 3500,
      stopWhen: () => preference(bot) !== cfg || (entity ? player(bot) !== entity : Boolean(player(bot))) || distance(bot.entity.position, entity ? entity.position : spot) <= range ||
        Boolean(require('./reactive-wait').emergency(bot)) });
  } catch (err) {
    task.check();
    if (['NeedsAir', 'NeedsSafety', 'Cancelled', 'Preempted', 'Stalled'].includes(err.name)) throw err;
    // A failed walk towards the player must leave the actual request runnable.
  }
  return true;
}

// Trips kept near the radius round where the player is or was last seen (work.js idleOptions, sideTrips): the walks to
// another biome, to explore, to a village or a ruin, to loot or trade and the like. In the same window the first tools
// and the errand for a sword, a step of each resting, took such trips while they waited: 156 and 158 blocks off with the
// 75-block default. A trip may end past the radius by the excursion (above), no further: the trips taken while work
// waits (filler), for any work but a come, a follow or a walk the player sent it on (exempt); and the trips for the work
// itself while the work is the bot's own (an errand, the first tools). A trip whose end is not known is kept when the
// walk itself stays within that.
const FAR_KEYS = /^(?:travel_|explore$|loot$|trade$|visit_|deep_dark$|trial_chambers$|fetch_cache$|take_home_bed$)/;
const flat = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
function boundOffers(bot, goal, options, { filler = false, now = Date.now() } = {}) {
  const p = options && preference(bot);
  if (!p || exempt(bot, goal) || (!filler && !goal?.weaponErrand && !goal?.chore)) return options;
  const at = anchor(bot, now), me = bot.entity?.position;
  if (!at || !me) return options;
  const dropped = [], reach = p.radius + excursion(p.radius);
  for (const [key, option] of Object.entries(options)) {
    if (!option || !FAR_KEYS.test(key)) continue;
    const inside = option.to ? flat(option.to, at.position) <= reach
      : Number.isFinite(option.walkBlocks) && flat(me, at.position) + option.walkBlocks <= reach;
    if (!inside) { dropped.push(key); delete options[key]; }
  }
  const said = dropped.join(', '), last = bot._stayDropped;
  if (said && (last?.said !== said || now - last.at > 60000)) {
    bot._stayDropped = { said, at: now };
    console.log(`[stay] not offered, past ${Math.round(reach)} blocks of ${p.player}${at.seen ? '' : ' (where last seen)'}: ${said}`);
  }
  return options;
}

module.exports = { readControl, applyControl, status, preference, player, anchor, travelScore, biasRoutes, due, regroup, defaultRadius, defaultPlayer, exempt, boundOffers, outMs, excursion, LAST_SEEN_MS };
