'use strict';
const { goals } = require('mineflayer-pathfinder');

const DEFAULT_RADIUS = 12;
const distance = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
const preference = bot => bot?.companionMemory?.state?.stayClose;

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
  const seen = player(bot);
  return `I aim to stay within ${p.radius} blocks of ${p.player}. ${seen ? `We're ${Math.round(distance(bot.entity.position, seen.position))} blocks apart.` : "I'll pick that up when I can see them again."}`;
}

function applyControl(bot, from, input) {
  const memory = bot.companionMemory, previous = preference(bot);
  if (input.mode === 'status') return status(bot);
  if (input.mode === 'invalid') return 'Give me a positive whole number of blocks.';
  if (input.mode === 'off') delete memory.state.stayClose;
  else memory.state.stayClose = { player: from, radius: input.radius ?? (previous?.player === from ? previous.radius : DEFAULT_RADIUS) };
  delete bot._closeRegroup;
  memory.flush();
  return status(bot);
}

function player(bot) {
  const p = preference(bot), entity = p && bot.players?.[p.player]?.entity;
  return entity?.position && entity.isValid !== false && (!entity.dimension || entity.dimension === bot.game?.dimension) ? entity : null;
}

// Nothing inside the preferred distance costs extra. Outside it the slope
// increases smoothly and stays finite, so a unique distant source still wins.
function pull(distance, radius) {
  const over = Math.max(0, distance - radius);
  return 3 * over * (over / (radius + over));
}

function travelScore(bot, point, site) {
  const entity = player(bot), walk = distance(bot.entity.position, point);
  const local = entity ? pull(distance(entity.position, point), preference(bot).radius) : 0;
  return walk + local + (site ? pull(distance(site, point), 4) : 0);
}

function biasRoutes(bot, from, moves) {
  const entity = player(bot);
  if (!entity || ['vitals', 'survival', 'hunt'].includes(bot._turn?.holder)) return;
  const radius = preference(bot).radius;
  // A bounded total surcharge keeps a long, necessary route within the
  // pathfinder's normal search budget. Inward moves always retain their cost.
  const fromPlayer = distance(bot.entity.position, entity.position);
  const baseCost = pull(fromPlayer, radius);
  const potential = p => Math.min(baseCost + 20, pull(distance(p, entity.position), radius));
  const before = potential(from);
  for (const move of moves) move.cost += Math.max(0, potential(move) - before);
}

function due(bot, idle, now = Date.now()) {
  const entity = player(bot);
  if (!entity || !bot.entity?.position) return false;
  const radius = preference(bot).radius, d = distance(bot.entity.position, entity.position);
  const last = bot._closeRegroup;
  if (d <= radius) { bot._closeRegroup = { at: last?.at || 0, position: { ...entity.position } }; return false; }
  if (d < radius + (idle ? 1 : Math.max(3, radius / 3)) || (last?.at && now - last.at < (idle ? 4000 : 20000))) return false;
  // Working a fixed, distant site is legitimate. A player moving on can
  // call the work back; a stationary player does not cause a commute per block.
  return idle || !last || distance(last.position, entity.position) >= Math.max(3, radius / 2);
}

async function regroup(bot, task, navigate, idle) {
  if (!due(bot, idle)) return false;
  const cfg = preference(bot), entity = player(bot), range = Math.max(1, Math.floor(cfg.radius * .8));
  bot._closeRegroup = { at: Date.now(), position: { ...entity.position } };
  try {
    await navigate(bot, task, new goals.GoalFollow(entity, range), { timeoutMs: 10000, stallMs: 3500,
      stopWhen: () => preference(bot) !== cfg || player(bot) !== entity || distance(bot.entity.position, entity.position) <= range ||
        Boolean(require('./reactive-wait').emergency(bot)) });
  } catch (err) {
    task.check();
    if (['NeedsAir', 'NeedsSafety', 'Cancelled', 'Preempted', 'Stalled'].includes(err.name)) throw err;
    // A failed walk towards the player must leave the actual request runnable.
  }
  return true;
}

module.exports = { readControl, applyControl, status, preference, player, travelScore, biasRoutes, due, regroup };
