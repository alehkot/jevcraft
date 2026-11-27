'use strict';
// The waiting bot's own chores (JEV_IDLE=wait, session.js): small jobs about where it waits with a player, picked by
// what is about it rather than asked for. Short tree jobs left their stumps bare until a player said "replant the
// trees", and the logs that had lain on the leaves where they came down (2026-11-27); the user: "let's actually
// introduce some idle hook and add some contextual chores there". Looked at every ten seconds while nothing else is
// due, by day. Each is the bot's own errand, as the sword's is (keep-armed.js): any request or "stop" ends it, a bot
// told to stop starts none until it is asked for something, it is never kept for a resume, nothing is said when it
// comes to nothing, and it rests a while after, whatever came of it.
//
//   trees    about the trees the bot cut here: a stand left up a trunk taken down, the logs that lay on the leaves and
//            have come down with them picked up, and saplings planted where the trunks stood (the stump first, else
//            close by) when one is carried or has fallen there (tree-felling.js replantStep)
//
// More come as their work can be done quietly where the bot waits (2026-11-27 on the copy: torches made from the pockets
// as a request would be took three minutes, said each plank and stick, and dropped tools for room; left out).
//
// JEV_CHORES=off: none. JEV_CHORES=trees (a list): only those named.
const { Vec3 } = require('vec3');

const LOOK_MS = 10000;
const CHORE_MS = 4 * 60000;                 // a chore still at it after this is ended
const REST_MS = Object.freeze({ trees: 90000 });       // the leaves come down over minutes: looked again soon
const SAID_MS = 10 * 60000;                 // a chore's line said once in this long
const ORDER = Object.freeze(['trees']);
const WITHIN = 32;                          // the chore's place this near the bot, and the player waited with
const HEALTH = 12, FOOD = 6;
const DAY_LEFT = 1800;                      // ticks of daylight a chore is begun with at least (a minute and a half)
const END_LEFT = 600;                       // and the half minute it is ended with

const at = p => new Vec3(p.x, p.y, p.z);
const items = bot => (typeof bot?.inventory?.items === 'function' ? bot.inventory.items() : []);
const carried = (bot, name) => items(bot).reduce((n, i) => n + (i.name === name ? i.count : 0), 0);
const overworld = bot => /overworld$/.test(String(bot?.game?.dimension || 'overworld'));
const dayLeft = bot => require('./keep-armed').dayLeft(bot);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function enabled(env = process.env) {
  const v = String(env.JEV_CHORES ?? '').trim().toLowerCase();
  if (['off', 'none', 'no', '0', 'false'].includes(v)) return new Set();
  if (!v || ['on', 'all', 'yes', '1', 'true'].includes(v)) return new Set(ORDER);
  return new Set(v.split(/[\s,]+/).filter(n => ORDER.includes(n)));
}

// About the trees cut here: stands left, saplings to plant, drops come down. -> { chore, why, stands, owed, felled } | null
function treesDue(bot, { player = null, now = Date.now() } = {}) {
  const me = bot.entity?.position;
  if (!me) return null;
  const tf = require('./tree-felling');
  const near = p => p.distanceTo(me) <= WITHIN && (!player?.position || at(player.position).distanceTo(p) <= WITHIN);
  const stands = (bot._treeStands || []).filter(s => s?.cells?.length && near(at(s.cells[0])) &&
    s.cells.some(c => tf.STAND.includes(bot.blockAt(at(c))?.name)));
  const owed = tf.owedHere(bot).filter(s => {
    const cell = at(s.cells[0]), sapling = tf.SAPLING[s.block];
    if (!near(cell) || tf.stumpTaken(bot, tf.toStump(s))) return false;
    return carried(bot, sapling) >= (tf.FOUR.has(sapling) ? 4 : 1) || (tf.room(bot, sapling) && tf.lyingLow(bot, sapling, cell));
  });
  // Nothing picked up into full pockets (tree-felling.js room).
  const felled = tf.felledHere(bot, now).filter(f => near(at(f)) && [f.block, tf.SAPLING[f.block]].some(k => tf.room(bot, k) && tf.lyingLow(bot, k, at(f))));
  if (!stands.length && !owed.length && !felled.length) return null;
  const why = [stands.length && `${plural(stands.length, 'stand')} left up a trunk`, owed.length && `saplings for ${plural(owed.length, 'stump')}`,
    felled.length && `drops lying about ${plural(felled.length, 'tree')} cut`].filter(Boolean).join(', ');
  return { chore: 'trees', why, stands: stands.length, owed: owed.length, felled: felled.length };
}

// The chore due now, or null. Not while stopped, hurt, hungry, with a monster in sight, in the dark or with under a
// minute and a half of daylight ahead, outside the Overworld, nor a chore resting.
function due(bot, { now = Date.now(), dark = false, paused = false, threatened = false, resting = () => false, player = null, env = process.env } = {}) {
  const on = enabled(env);
  if (!on.size || paused || threatened || dark || !overworld(bot)) return null;
  if ((bot.health ?? 20) < HEALTH || (bot.food ?? 20) < FOOD || dayLeft(bot) < DAY_LEFT) return null;
  for (const name of ORDER) {
    if (!on.has(name) || resting(name)) continue;
    const d = name === 'trees' ? treesDue(bot, { player, now }) : null;
    if (d) return d;
  }
  return null;
}

// The goal a chore runs as (work.js): kind and all, marked as the bot's own.
function goalFor(bot, chore, { player = null, now = Date.now() } = {}) {
  const base = { chore: chore.chore, deliver: false, from: player?.name || bot.username, choreUntil: now + CHORE_MS };
  if (chore.chore === 'trees') return { ...base, kind: 'replant', request: 'tidy up where I cut trees' };
  throw new Error(`No chore named ${chore.chore}`);
}

// Why a chore at it should end now, or null.
function over(goal, bot, now = Date.now()) {
  if (!goal?.chore) return null;
  if (now >= (goal.choreUntil ?? Infinity)) return 'at it too long';
  return dayLeft(bot) < END_LEFT ? 'night is near' : null;
}

// Said as it sets out, when it walks off: nothing for what it does where it stands.
function line(chore) {
  if (chore.chore !== 'trees') return '';
  if (chore.owed) return "I'll plant saplings where I cut trees.";
  if (chore.felled) return "I'll pick up what came down from the trees I cut.";
  return "I'll take down the blocks I left up a tree.";
}

module.exports = { due, treesDue, goalFor, over, line, enabled, LOOK_MS, CHORE_MS, REST_MS, SAID_MS, ORDER, WITHIN, DAY_LEFT, END_LEFT };
