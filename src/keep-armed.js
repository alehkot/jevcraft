'use strict';
// JEV_WEAPON: Jev keeps a sword about it. Asked for 2026-11-23, when a set handed out by the server was turned down:
// "jev should always try to carry some weapons and for the very first night getting stone sword at least".
//   pockets  at work on a request, a sword the pockets make with crafts alone is made before the next step (workSword)
// Unset: the bot fights with what it happens to carry, as before.
//
// Ready is a stone sword or better (stone, copper, iron, diamond, netherite) with ten uses or more left. An axe does
// not count: the bot makes one as a tool (a stone axe, early in a new world), and the ask was a stone
// sword at least. A wooden or golden sword is a weapon but not ready: one is made only when the pockets make nothing
// better, and only with no sword or axe carried at all.
const TIERS = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite'];
const READY = new Set(['stone', 'copper', 'iron', 'diamond', 'netherite']);
const MIN_USES = 10;
const REST_MS = 10 * 60000;
// Not made at: a come or a follow is the player's to wait on (a guard makes its own first, work.js), and the idle
// loop and the dream's ladder keep their own.
const NOT_AT = new Set(['come', 'follow', 'visit', 'climb_ladder', 'survive', 'win']);
// A sword's makings, so that the job's own item is never spent on one: iron ingots asked for go to the player, and
// the sticks, planks and logs a job asked for are counted out for it.
const WOOD = '[a-z_]+_(?:planks|log|wood|stem|hyphae)|stick|bamboo';
const MAKINGS = {
  iron_sword: new RegExp('^(?:iron_ingot|' + WOOD + ')$'),
  copper_sword: new RegExp('^(?:copper_ingot|' + WOOD + ')$'),
  stone_sword: new RegExp('^(?:cobblestone|cobbled_deepslate|blackstone|' + WOOD + ')$'),
  wooden_sword: new RegExp('^(?:' + WOOD + ')$'),
};

function mode(env = process.env) {
  const value = String(env?.JEV_WEAPON || '').trim().toLowerCase();
  return value === 'pockets' ? value : null;
}
const items = bot => (typeof bot?.inventory?.items === 'function' ? bot.inventory.items() : []);
function usable(bot, item) {
  const max = bot?.registry?.itemsByName?.[item.name]?.maxDurability;
  return !max || max - (item.durabilityUsed || 0) >= MIN_USES;
}
// The best usable sword carried: { name, tier, rank }, or null.
function bestSword(bot) {
  let best = null;
  for (const item of items(bot)) {
    const tier = /^([a-z]+)_sword$/.exec(item.name)?.[1], rank = TIERS.indexOf(tier);
    if (rank < 0 || !usable(bot, item)) continue;
    if (!best || rank > best.rank) best = { name: item.name, tier, rank };
  }
  return best;
}
const ready = bot => READY.has(bestSword(bot)?.tier);
const armed = bot => items(bot).some(item => /_(?:sword|axe)$/.test(item.name) && usable(bot, item));
// Which swords the goal's own items leave free to make: sword => true.
function spareFor(goal) {
  const own = [goal?.item, ...((goal?.tasks || []).map(t => t?.item))].filter(Boolean);
  return sword => !own.some(item => MAKINGS[sword]?.test(item));
}
// The sword to make now from the pockets, or null. craftable(item): crafts alone make it from what is carried.
function pocketSword(bot, craftable, spare = () => true) {
  if (ready(bot)) return null;
  for (const item of ['iron_sword', 'copper_sword', 'stone_sword'])
    if (bot?.registry?.itemsByName?.[item] && spare(item) && craftable(item)) return item;
  return !armed(bot) && bot?.registry?.itemsByName?.wooden_sword && spare('wooden_sword') && craftable('wooden_sword') ? 'wooden_sword' : null;
}
const words = s => String(s || '').replaceAll('_', ' ');
const overworld = bot => /overworld$/.test(String(bot?.game?.dimension || 'overworld'));

// At work on a request: a sword the pockets make is made before the next step, the step in hand kept. One that
// fails rests ten minutes. -> true when it acted (the loop plans again), false when there was nothing to do.
async function workSword(bot, task, goal, save, { acquireStep, craftable, countOf, setAside, isSetAside, env = process.env } = {}) {
  if (!mode(env) || !goal || bot?.game?.gameMode !== 'survival' || !overworld(bot)) return false;
  if (NOT_AT.has(goal.kind) || goal.guard || goal.weaponErrand) return false;
  if (ready(bot) || isSetAside(goal, 'work_sword', 'sword')) return false;
  const item = pocketSword(bot, craftable, spareFor(goal));
  if (!item) return false;
  const have = bestSword(bot), want = countOf(bot, item) + 1, step = goal.step;
  bot.chat?.((have ? 'Only a ' + words(have.name) + ' on me' : 'No sword on me') + ', and my pockets make a ' + words(item) + ': making it first.');
  try {
    for (let n = 0; n < 8 && countOf(bot, item) < want; n++) { task?.check?.(); await acquireStep(bot, task, item, want, goal, save); }
  } catch (err) {
    task?.check?.();
    if (['NeedsAir', 'NeedsSafety', 'Cancelled', 'Stalled'].includes(err?.name)) throw err;
    console.log('[weapon] the ' + words(item) + ' was not made: ' + String(err?.message || err).slice(0, 160));
    setAside(goal, 'work_sword', 'sword', String(err?.message || err).slice(0, 160), REST_MS);
    return true;
  } finally { if (step) goal.step = step; save?.(); }
  if (countOf(bot, item) < want) { setAside(goal, 'work_sword', 'sword', 'the sword was not made', REST_MS); save?.(); }
  return true;
}

module.exports = { mode, bestSword, ready, armed, spareFor, pocketSword, workSword, READY, MIN_USES, REST_MS };
