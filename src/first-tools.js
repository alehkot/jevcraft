'use strict';
// JEV_START=tools: in a world new to it, the bot makes its first tools as soon as it can, as its own errand between
// requests. Asked for 2026-11-23: "if the world just starts and jev just joined the new world it has by default
// mission to get wood axe and pickaxe and craft the crafting table and then get stone tools and sword as fast as
// possible".
//
//   The steps, in order: a wooden axe, a wooden pickaxe (the crafting table is made for the first and picked back up,
//   work.js), a stone pickaxe, a stone sword, a stone axe, a stone shovel. One at a time, each made as the waiting
//   bot's errand for a sword is (JEV_IDLE=wait; session.js launchArms): read as the request "craft a wooden axe"
//   would be, ended by "stop" or by any request and taken up again once the bot is waiting again; by day gathered for
//   with three minutes of daylight ahead and ended while the daylight left covers a minute and the walk back
//   (keep-armed.js errandOver), in the dark only what the pockets make. A line as it begins, one when all are made and
//   nothing between the steps; then back to the player it was with. A step that comes to nothing rests two minutes;
//   three times, and it is left out.
//
// Begun only in a world new to the bot: no saved state for this world when it connects (its MC_WORLD_ID's survival
// file; mc-reset-world gives each new world a new id) and the world under three in-game days old. A world the bot
// has been in before is left alone (the one live on 2026-11-23). Once begun it goes on over later connections. While
// it is under way the JEV_WEAPON=keep errand waits: the stone sword is one of the steps.
//
// A step is carried with a tool of its kind, of its tier or better, with ten uses left: any of the kind for a wooden
// step, and a stone pickaxe or better does for both wooden steps (the stone ones can be made straight away); stone or
// better for a stone one; the sword step is keep-armed.js ready.
// Unset: nothing of the kind, as before.
const arms = require('./keep-armed');

const STEPS = ['wooden_axe', 'wooden_pickaxe', 'stone_pickaxe', 'stone_sword', 'stone_axe', 'stone_shovel'];
const STONE_UP = new Set(['stone', 'copper', 'iron', 'diamond', 'netherite']);
const ANY = new Set(['wooden', 'golden', ...STONE_UP]);
const START_AGE = 3 * 24000;        // begun only in a world younger than three in-game days
const STEP_TRIES = 3;
const STEP_REST_MS = 2 * 60000;

function mode(env = process.env) {
  return String(env?.JEV_START || '').trim().toLowerCase() === 'tools' ? 'tools' : null;
}
const items = bot => (typeof bot?.inventory?.items === 'function' ? bot.inventory.items() : []);
const words = s => String(s || '').replaceAll('_', ' ');
function carries(bot, kind, tiers) {
  return items(bot).some(item => {
    const m = /^([a-z]+)_([a-z]+)$/.exec(item.name);
    return Boolean(m) && m[2] === kind && tiers.has(m[1]) && arms.usable(bot, item);
  });
}
function covered(bot, step) {
  const [tier, kind] = step.split('_');
  if (tier !== 'wooden') return kind === 'sword' ? arms.ready(bot) : carries(bot, kind, STONE_UP);
  return carries(bot, kind, ANY) || carries(bot, 'pickaxe', STONE_UP);
}

// At connect: the first tools owed to a world new to the bot, or skipped in one it has been in. Decided once a world.
function onConnect(state, { firstJoin = false, env = process.env, now = Date.now() } = {}) {
  if (!mode(env) || !state || state.firstTools) return null;
  return (state.firstTools = firstJoin ? { owedAt: new Date(now).toISOString(), failed: {} } : { skipped: 'I have been in this world before' });
}
// Begun once the world's age is known, if under three days: 'begun' or 'skipped'; null while unknown, or decided.
function begin(state, bot, now = Date.now()) {
  const ft = state?.firstTools;
  if (!ft || ft.begunAt || ft.skipped || ft.done) return null;
  const age = Number(bot?.time?.age);
  if (!Number.isFinite(age) || age < 0) return null;
  if (age >= START_AGE) { ft.skipped = 'the world is past its third day (' + age + ' ticks old)'; return 'skipped'; }
  ft.begunAt = new Date(now).toISOString(); ft.age = age;
  return 'begun';
}
const underway = state => Boolean(state?.firstTools?.begunAt && !state.firstTools.done && !state.firstTools.skipped);
const tries = (state, step) => state?.firstTools?.failed?.[step] || 0;
// The steps not yet carried, less those that came to nothing three times; and those.
const left = (bot, state) => STEPS.filter(step => !covered(bot, step) && tries(state, step) < STEP_TRIES);
const givenUp = (bot, state) => STEPS.filter(step => !covered(bot, step) && tries(state, step) >= STEP_TRIES);

// The next step to make, or null: { item, pockets, mission }. In order, one at a time: a step resting after one that
// came to nothing is waited for, not passed. Never while stopped, hurt, hungry, in the water or with a monster in
// sight; in the dark or with under three minutes of daylight ahead, only what the pockets make there and then.
function due(bot, { survival, dark = false, paused = false, threatened = false, craftable = item => arms.pocketsMake(bot, item), isSetAside = () => false, env = process.env } = {}) {
  const state = survival?.state;
  if (!mode(env) || !underway(state) || paused || threatened) return null;
  if (bot?.game?.gameMode !== 'survival' || !arms.overworld(bot) || bot?.entity?.isInWater) return null;
  if ((bot.health ?? 20) < arms.ERRAND_HEALTH || (bot.food ?? 20) < arms.ERRAND_FOOD) return null;
  const step = left(bot, state)[0];
  if (!step || isSetAside(survival, 'first_tools', step)) return null;
  const pockets = Boolean(craftable(step));
  if (!pockets && (dark || arms.dayLeft(bot) < arms.ERRAND_DAY_LEFT)) return null;
  return { item: step, pockets, mission: true };
}

const and = list => (list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list.at(-1));
// "a wooden axe and pickaxe, then a stone pickaxe, sword, axe and shovel"
function listOf(steps) {
  const groups = [];
  for (const step of steps) {
    const [tier, kind] = step.split('_'), last = groups.at(-1);
    if (last?.tier === tier) last.kinds.push(kind); else groups.push({ tier, kinds: [kind] });
  }
  return groups.map(g => 'a ' + g.tier + ' ' + and(g.kinds)).join(', then ');
}
const startLine = steps => "New world! I'm making my first tools: " + listOf(steps) + '.';
function doneLine(bot, state) {
  const short = givenUp(bot, state);
  return short.length ? "I've made my first tools, all but " + and(short.map(s => 'the ' + words(s))) + '.' : "I've made my first tools.";
}

module.exports = { mode, covered, onConnect, begin, underway, left, givenUp, due, listOf, startLine, doneLine, STEPS, START_AGE, STEP_TRIES, STEP_REST_MS };
