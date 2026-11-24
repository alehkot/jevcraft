'use strict';
// JEV_WEAPON: Jev keeps a sword about it. Asked for 2026-11-23, when a set handed out by the server was turned down:
// "jev should always try to carry some weapons and for the very first night getting stone sword at least".
//   pockets  at work on a request, a sword the pockets make with crafts alone is made before the next step (workSword)
//   keep     that, and between requests a waiting bot (JEV_IDLE=wait) with no stone sword or better goes and makes one:
//            by day gathering for it as a request would (with three minutes of daylight ahead, and ended while the
//            daylight left covers a minute and the walk back), by night only from what its pockets make there and then; then back to the player it
//            waited with, whatever came of it, unless a player stopped it or asked for something else. Three that
//            come to nothing and it stops trying until it next connects (errandDue here, launchArms in session.js)
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
const ERRAND_MS = 8 * 60000;        // an errand still at it after this is ended
const ERRAND_REST_MS = 10 * 60000;  // after an errand that failed, was ended, or left the bot with no sword ready
const ERRAND_HEALTH = 12, ERRAND_FOOD = 6;
const ERRAND_TRIES = 3;             // errands that came to nothing in one connection, then none until the next
// Gathered for only with three minutes of daylight ahead (company.js darkNow: dark from 12300 to 23500).
const DUSK = 12300, DAWN = 23500, ERRAND_DAY_LEFT = 3600;
// A gathering errand is ended while the daylight left still covers a minute and the walk back to the player it waited
// with: the walk back does not look for a player out of sight in the dark (company.js backDue), and a bot cut off at
// nightfall spends the night alone and unarmed. On the private copy on 2026-11-23 an errand begun at noon, the trees
// about felled, was ended with a minute left 122 blocks from the player; the night came on the way and the bot
// sheltered out there. The walk is reckoned at a block and a half a second as the crow flies: the one walk back timed
// that day was 54 blocks in 25 seconds, over open savanna.
const ERRAND_END_LEFT = 1200, WALK_BLOCKS_PER_SECOND = 1.5;
const walkTicks = blocks => Math.ceil(blocks / WALK_BLOCKS_PER_SECOND * 20);
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
  return value === 'keep' || value === 'pockets' ? value : null;
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
// "a stone sword", "an iron sword".
const a = s => (/^[aeiou]/i.test(words(s)) ? 'an ' : 'a ') + words(s);
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

// Whether crafts alone make the item from what is carried (work.js craftableFromPack, for the waiting bot).
function pocketsMake(bot, item) {
  if (!bot?.registry?.itemsByName?.[item]) return false;
  const stock = {};
  for (const i of items(bot)) stock[i.name] = (stock[i.name] || 0) + i.count;
  let plan; try { plan = require('./knowledge').planCatalog(bot.registry, item, 1, stock); } catch (_) { return false; }
  const steps = Array.isArray(plan) ? plan : plan?.steps;
  return Array.isArray(steps) && steps.length > 0 && steps.every(st => st.action === 'craft');
}

const carried = (bot, item) => items(bot).reduce((n, i) => n + (i.name === item ? i.count : 0), 0);
// Daylight ahead, in ticks: none in the dark.
function dayLeft(bot) {
  const t = bot?.time?.timeOfDay;
  if (typeof t !== 'number') return Infinity;
  return t < DUSK ? DUSK - t : t >= DAWN ? 24000 - t + DUSK : 0;
}

// The waiting bot's errand for a sword, or null: { item, pockets }. By day a stone sword, or the iron or copper one
// the pockets make, gathered for as the request would be; in the dark, or with under three minutes of daylight
// ahead, only one the pockets make there and then. Never while stopped, hurt, hungry, in the water, with a monster
// in sight, resting after an errand, or after three that came to nothing (failures, in this connection).
function errandDue(bot, { survival, dark = false, paused = false, threatened = false, failures = 0, craftable = item => pocketsMake(bot, item), isSetAside = () => false, env = process.env } = {}) {
  if (mode(env) !== 'keep' || paused || threatened || failures >= ERRAND_TRIES) return null;
  if (bot?.game?.gameMode !== 'survival' || !overworld(bot) || bot?.entity?.isInWater) return null;
  if ((bot.health ?? 20) < ERRAND_HEALTH || (bot.food ?? 20) < ERRAND_FOOD) return null;
  if (ready(bot) || (survival && isSetAside(survival, 'weapon_errand', 'sword'))) return null;
  const pocket = pocketSword(bot, craftable);
  if (dark || dayLeft(bot) < ERRAND_DAY_LEFT) return pocket ? { item: pocket, pockets: true } : null;
  return pocket && pocket !== 'wooden_sword' ? { item: pocket, pockets: true } : { item: 'stone_sword', pockets: false };
}
const errandRequest = item => 'craft ' + a(item);
// How far the bot is from the player it would walk back to: from where they are when in sight, else from where they
// were when the errand began (the walk back goes there: company.js backDue); null with nobody to go back to.
function backBlocks(goal, bot) {
  const to = goal?.returnTo, me = bot?.entity?.position;
  if (!to?.name || !me) return null;
  const at = bot?.players?.[to.name]?.entity?.position || to.position;
  return at ? Math.hypot(me.x - at.x, me.y - at.y, me.z - at.z) : null;
}
// Why a running errand ends now, or null: after its eight minutes, or, gathering, once the daylight left is under a
// minute and the walk back.
function errandOver(goal, bot, now = Date.now()) {
  if (!goal?.weaponErrand || goal.errandEnded || goal.errandStopped) return null;
  if (now > (goal.errandUntil || Infinity)) return 'it took too long';
  if (goal.errandPockets) return null;
  return dayLeft(bot) < ERRAND_END_LEFT + walkTicks(backBlocks(goal, bot) || 0) ? 'night is near' : null;
}
// What the bot says as it sets out: what it has, what it makes, and whether it walks off.
function errandLine(bot, item, { pockets = false, returnTo = null } = {}) {
  const have = bestSword(bot), worn = !have && items(bot).find(i => /_sword$/.test(i.name));
  const why = have ? 'I only have a ' + words(have.name) : worn ? 'My ' + words(worn.name) + ' is nearly broken' : 'I have no sword';
  return why + ", so I'm making " + (worn?.name === item ? 'a new one' : a(item)) + (returnTo && !pockets ? '. Back soon, ' + returnTo.name : '') + '.';
}

module.exports = { mode, bestSword, ready, armed, spareFor, pocketSword, workSword, pocketsMake, carried, dayLeft, errandDue, errandRequest, errandLine, errandOver, backBlocks, walkTicks, a, READY, MIN_USES, REST_MS, ERRAND_MS, ERRAND_REST_MS, ERRAND_TRIES, ERRAND_DAY_LEFT, ERRAND_END_LEFT, WALK_BLOCKS_PER_SECOND };
