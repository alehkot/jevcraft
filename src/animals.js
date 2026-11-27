'use strict';
// The animals about a house (chores.js 'animals'): the cows, sheep and mooshrooms where the bot waits kept together
// and bred with the garden's wheat. Asked for with the garden, 2026-11-27: "actually cultivating animals should also
// be part of it i.e. by giving them wheat and nudging them to stay close to each other". As the garden, only with a
// house about (garden.js housesAbout), and only within the chore's reach of the player waited with.
//
// A run is one pass (work.js, kind 'animals'), for one kind:
//   - the herd's gathering point: where most of the kind already stand together (SPREAD across) within HOME_FROM of a
//     house's walls, never within PLOT_KEEP of a garden's plot (an animal jumping onto farmland tramples it) nor in or
//     against a house; kept while it stays so, and the herd led back to it, so that it stays by the house (on the copy,
//     2026-11-27, a point taken afresh each run went off with the herd's middle, and in ten minutes the cows were out
//     of the bot's sight and the bread took their wheat);
//   - those of the kind farther off, up to LEAD_FROM, led there with wheat in hand, a few blocks a leg, waiting at each
//     for it to come (an animal follows a player holding its food from about ten blocks off and stops two and a half
//     from it); one that does not come (a fence, a lead) is let be half an hour;
//   - then pairs of adults fed a wheat each, the second only once the first took it (the game uses the wheat only on
//     an animal that can breed: an adult not bred in five minutes and not in love already; a baby eats it to grow, so
//     none is fed), and none bred past HERD of the kind about.
// The wheat is put away from the hand at the end, whatever ended the run: an animal follows a hand with its food in it
// anywhere. The garden's bread leaves the herd's wheat (wheatWanted). Nothing is said. Not yet: chickens and pigs
// (seeds, carrots), a pen.
// And the herd is never hunted (spared, below; foraging.js preyFood asks it of every animal a hunt would take).
const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const KINDS = Object.freeze(['cow', 'sheep', 'mooshroom']);
const FOOD = 'wheat';
const FIND = 24;                            // animals this near the bot,
const HOME_NEAR = 16;                       // or this near a house's walls: the herd by the house, out of FIND of where
                                            // the bot waits by its player (on the copy 2026-11-27, three cows 23 to 25
                                            // off by the pond were never about, and the bread took their wheat)
const SEEN_MS = 10 * 60000;                 // a herd seen about keeps its wheat from the bread this long after
const HOME_FROM = 12;                       // the herd's place kept this near a house's walls
const UP = 6;                               // and this near its level
const SPREAD = 8;                           // this near the gathering point across: with the herd
const LEAD_FROM = 24;                       // led from no farther off than this
const HERD = 8;                             // of a kind about, babies too: none bred past it
const PLOT_KEEP = 5;                        // the gathering point this far across from a plot's middle at least
const BRED_MS = 5 * 60000;                  // fed, or would not take it: let be this long (the game's five minutes)
// One led may be led again as soon as the chore comes round again: on the copy, 2026-11-27, cows led back were
// grazing ten blocks off again within the quarter hour.
const LED_MS = 5 * 60000, STAYED_MS = 30 * 60000;
const MOST_LED = 3, MOST_PAIRS = 2;
const TAKE = 2.5;                           // this near an animal to hand it the food: the reach is three
const LEG = 3;                              // blocks a leg, leading
const WITHIN = 32;                          // chores.js WITHIN: the player waited with this near
const SAYS = Object.freeze({ cow: ['cow', 'cows'], sheep: ['sheep', 'sheep'], mooshroom: ['mooshroom', 'mooshrooms'] });

const plain = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const where = c => '(' + c.x + ', ' + c.y + ', ' + c.z + ')';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fatal = err => ['Cancelled', 'NeedsAir', 'NeedsSafety'].includes(err?.name);
const items = bot => (typeof bot?.inventory?.items === 'function' ? bot.inventory.items() : []);
const wheat = bot => items(bot).reduce((n, i) => n + (i.name === FOOD ? i.count : 0), 0);
const across = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const gapTo = (c, min, max) => Math.max(min.x - c.x, c.x - max.x, min.z - c.z, c.z - max.z, 0);
const idOf = e => String(e.uuid || e.id);
function baby(bot, e) {
  const keys = bot.registry?.entitiesByName?.[e.name]?.metadataKeys || [], i = keys.indexOf('baby');
  return i >= 0 && e.metadata?.[i] === true;
}
// Who was fed, would not take it, was led, or would not come, and when: five minutes to half an hour, kept in memory.
const memo = bot => (bot._herd ||= { fed: {}, untaken: {}, led: {}, stayed: {}, seen: {}, home: {} });
const since = (bot, list, e, now) => now - (memo(bot)[list][idOf(e)] || 0);
// ---- the herd spared (the user, 2026-11-27: "yes hunting should spare the herd")
// An animal a hunt would take for food (foraging.js preyFood: a cow, a mooshroom, a sheep, a pig, a chicken, a rabbit)
// is never hunted when it is someone's or the herd's:
//   - it bears a name (a name tag);
//   - it stands penned: the first thing in its way at its feet's level, each of the four ways within PENNED, is a made
//     block (a fence, a gate, a wall, planks: built.js structure), not the ground or a tree;
//   - it stands within HOME_NEAR of the walls of a house about (garden.js housesAbout: the bot's own, one a player
//     labelled theirs, a bed or a door inside walls under a roof), as the herd is counted here;
//   - it is of a kind herded within LEAD_FROM of the herd's place kept by a house.
// But for the home base's own cull, asked with cull (home-base.js takeSteak: a cow past its pen's breeding pair).
// Asked of every animal in view each time a hunt looks: kept SPARED_MS an animal.
const SPARE_KINDS = new Set(['cow', 'mooshroom', 'sheep', 'pig', 'chicken', 'rabbit']);
const SPARED_MS = 5000, PENNED = 8;
const blockAt = (bot, p) => { try { return bot.blockAt(new Vec3(p.x, p.y, p.z)) || null; } catch (_) { return null; } };
function named(bot, e) {
  const keys = bot.registry?.entitiesByName?.[e.name]?.metadataKeys || [], i = keys.indexOf('custom_name');
  const n = i >= 0 ? e.metadata?.[i] : undefined;
  return n != null && n !== '' && n !== false && !(typeof n === 'object' && (n.present === false || !Object.keys(n).length));
}
function penned(bot, position) {
  let structure; try { ({ structure } = require('./built')); } catch (_) { return false; }
  const f = plain(position);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let walled = false;
    for (let n = 1; n <= PENNED; n++) {
      const b = blockAt(bot, { x: f.x + dx * n, y: f.y, z: f.z + dz * n });
      if (!b) break;
      if (b.boundingBox !== 'block') continue;
      walled = !!structure(b.name);
      break;
    }
    if (!walled) return false;
  }
  return true;
}
function sparedNow(bot, e, now) {
  if (named(bot, e)) return 'named';
  if (penned(bot, e.position)) return 'penned';
  const me = bot.entity?.position, p = plain(e.position);
  let houses = [];
  try { houses = me ? require('./garden').housesAbout(bot, me, now) : []; } catch (_) { houses = []; }
  if (houses.some(h => gapTo(p, h.min, h.max) <= HOME_NEAR && Math.abs(p.y - (h.floor ?? h.min.y)) <= UP + 2)) return 'by the house';
  const home = memo(bot).home[e.name];
  if (home && across(e.position, home) <= LEAD_FROM) return 'the herd';
  return false;
}
// -> 'named' | 'penned' | 'by the house' | 'the herd' | false
function spared(bot, e, { now = Date.now(), cull = false } = {}) {
  if (!e?.position || !SPARE_KINDS.has(e.name) || cull || (bot?._cull && bot._cull === e)) return false;
  const kept = (bot._spared ||= new Map()), k = idOf(e), hit = kept.get(k);
  if (hit && now - hit.at < SPARED_MS) return hit.why;
  let why = false;
  try { why = sparedNow(bot, e, now); } catch (_) { why = false; }
  if (kept.size >= 512) kept.clear();
  kept.set(k, { at: now, why });
  return why;
}

async function waitFor(task, fn, ms, every = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { task.check(); if (fn()) return true; await sleep(every); }
  return !!fn();
}

// The kind about: near the bot, by a house about or within LEAD_FROM of the herd's place, near the bot's level, and
// near the player waited with.
function about(bot, kind, player, houses = [], home = null) {
  const me = bot.entity.position;
  return Object.values(bot.entities || {}).filter(e => e?.name === kind && e.isValid !== false && e.position && Math.abs(e.position.y - me.y) <= UP &&
    (!player?.position || across(player.position, e.position) <= WITHIN) &&
    (e.position.distanceTo(me) <= FIND || houses.some(h => gapTo(plain(e.position), h.min, h.max) <= HOME_NEAR) || (home && across(e.position, home) <= LEAD_FROM)));
}
// A herd seen: two adults of a kind about, and whether there are HERD of it. Kept for the bread's wheat (wheatWanted).
function noteSeen(bot, kind, herd, adults, now) { if (adults >= 2) memo(bot).seen[kind] = { at: now, full: herd >= HERD }; }
// Kept off a garden (PLOT_KEEP across of its middle), out of a house and off the ground against its walls.
function offLimits(p, houses, plots) {
  const c = plain(p);
  if (plots.some(pl => Math.max(Math.abs(c.x - pl.middle.x), Math.abs(c.z - pl.middle.z)) < PLOT_KEEP)) return true;
  return houses.some(h => gapTo(c, h.min, h.max) <= 1 && c.y >= h.min.y - 1 && c.y <= h.max.y + 1);
}
// Where most of the kind about stand together, off limits aside (and, with by, only within that of a house's walls); the
// nearer a house the better at a tie.
function pointFor(herd, houses, plots, { by = Infinity } = {}) {
  let best = null;
  for (const e of herd) {
    if (offLimits(e.position, houses, plots)) continue;
    if (by < Infinity && !houses.some(h => gapTo(plain(e.position), h.min, h.max) <= by)) continue;
    const n = herd.filter(o => across(o.position, e.position) <= SPREAD).length;
    const home = houses.length ? Math.min(...houses.map(h => gapTo(plain(e.position), h.min, h.max))) : 0;
    if (!best || n > best.n || (n === best.n && home < best.home)) best = { n, home, p: plain(e.position) };
  }
  return best ? { ...best.p, n: best.n } : null;
}
// The herd's place: the one kept while it is still off limits of nothing and by a house about; else where most of the
// kind stand by a house (kept from now on); else, with none of them by a house, where most stand (not kept).
function homeFor(bot, kind, herd, houses, plots) {
  const m = memo(bot), kept = m.home[kind];
  if (kept && !offLimits(kept, houses, plots) && houses.some(h => gapTo(kept, h.min, h.max) <= HOME_FROM)) return { point: kept, kept: true };
  const p = pointFor(herd, houses, plots, { by: HOME_FROM });
  if (p) { m.home[kind] = { x: p.x, y: p.y, z: p.z }; return { point: m.home[kind], kept: true }; }
  delete m.home[kind];
  const free = pointFor(herd, houses, plots);
  return free ? { point: { x: free.x, y: free.y, z: free.z }, kept: false } : null;
}
// What a run for a kind would do now: those to lead, the adults ready for the wheat, the pairs to feed.
function planFor(bot, kind, { player, houses, plots, now }) {
  const first = about(bot, kind, player, houses, memo(bot).home[kind] || null);
  const home = homeFor(bot, kind, first, houses, plots);
  const herd = home?.kept ? about(bot, kind, player, houses, home.point) : first, adults = herd.filter(e => !baby(bot, e));
  noteSeen(bot, kind, herd.length, adults.length, now);
  if (adults.length < 2 || !home) return null;
  const point = home.point;
  const strays = adults.filter(e => { const d = across(e.position, point); return d > SPREAD && d <= LEAD_FROM && since(bot, 'led', e, now) >= LED_MS && since(bot, 'stayed', e, now) >= STAYED_MS; })
    .sort((a, b) => across(a.position, point) - across(b.position, point)).slice(0, MOST_LED);
  const ready = adults.filter(e => across(e.position, point) <= LEAD_FROM && since(bot, 'fed', e, now) >= BRED_MS && since(bot, 'untaken', e, now) >= BRED_MS);
  // A pair is two within six of each other, those to be led counted at the point: one alone fed is wheat spent on nothing.
  const spot = e => strays.includes(e) ? point : e.position;
  const pairable = ready.filter(e => ready.some(o => o !== e && across(spot(o), spot(e)) <= 6));
  const pairs = Math.max(0, Math.min(MOST_PAIRS, Math.floor(pairable.length / 2), Math.floor(wheat(bot) / 2), HERD - herd.length));
  return { kind, point, kept: home.kept, herd, strays, ready, pairs };
}
function housesNear(bot, me) {
  const garden = require('./garden');
  return garden.housesAbout(bot, me).filter(h => gapTo(plain(me), h.min, h.max) <= garden.HOUSE_NEAR);
}

// Due: a house about, wheat carried, two adults of a kind about, and one of them away from the herd or a pair to feed.
// -> { chore, kind, why, point, strays, pairs, herd } | null
function herdDue(bot, { player = null, now = Date.now() } = {}) {
  const me = bot.entity?.position;
  if (!me || !wheat(bot)) return null;
  const houses = housesNear(bot, me);
  if (!houses.length) return null;
  const plots = require('./garden').plotsHere(bot);
  for (const kind of KINDS) {
    const plan = planFor(bot, kind, { player, houses, plots, now });
    if (!plan || (!plan.strays.length && !plan.pairs)) continue;
    const [one, many] = SAYS[kind], n = plan.strays.length;
    const why = [n && n + ' ' + (n === 1 ? one : many) + ' away from the herd', plan.pairs && plan.pairs + (plan.pairs === 1 ? ' pair' : ' pairs') + ' to feed']
      .filter(Boolean).join(', ') + '; ' + plan.herd.length + ' ' + (plan.herd.length === 1 ? one : many) + ' about, gathered at ' + where(plan.point) + ', ' + wheat(bot) + ' wheat carried';
    return { chore: 'animals', kind, why, point: plain(plan.point), strays: n, pairs: plan.pairs, herd: plan.herd.length };
  }
  return null;
}

async function hold(bot) {
  if (bot.heldItem?.name === FOOD) return true;
  const it = items(bot).find(i => i.name === FOOD);
  if (!it) return false;
  await bot.equip(it, 'hand');
  return true;
}
// One led to the point: walked to with the wheat in hand, then a leg at a time, waiting at each for it to come.
async function lead(bot, task, goal, save, e, point, navigate) {
  const gone = () => e.isValid === false || (bot.entities && !bot.entities[e.id]);
  const near = () => e.position.distanceTo(bot.entity.position);
  goal.step = { action: 'animals_lead', kind: e.name, from: plain(e.position), to: plain(point) }; save?.();
  if (!await hold(bot)) return false;
  if (near() > 4) {
    try { await navigate(bot, task, new goals.GoalFollow(e, 3), { timeoutMs: 15000, stallMs: 5000, stopWhen: () => gone() || near() <= 4 }); }
    catch (err) { task.check(); if (fatal(err)) throw err; }
  }
  let came = !gone() && await waitFor(task, () => gone() || near() <= 3.5, 5000) && !gone();
  for (let leg = 0; came && leg < 12 && across(e.position, point) > SPREAD / 2; leg++) {
    const here = bot.entity.position, left = across(here, { x: point.x + 0.5, z: point.z + 0.5 });
    const t = left <= LEG ? 1 : LEG / left;
    const x = Math.floor(here.x + (point.x + 0.5 - here.x) * t), z = Math.floor(here.z + (point.z + 0.5 - here.z) * t);
    try { await navigate(bot, task, new goals.GoalNearXZ(x, z, 1), { timeoutMs: 8000, stallMs: 4000 }); }
    catch (err) { task.check(); if (fatal(err)) throw err; break; }
    await hold(bot);
    came = await waitFor(task, () => gone() || near() <= 3.5, 5000) && !gone();
  }
  const done = !gone() && across(e.position, point) <= SPREAD;
  memo(bot)[done ? 'led' : 'stayed'][idOf(e)] = Date.now();
  return done;
}
// One fed: walked up to, the wheat handed it. -> whether it took it (the wheat carried went down).
async function feed(bot, task, goal, save, e, navigate) {
  const gone = () => e.isValid === false || (bot.entities && !bot.entities[e.id]);
  const near = () => e.position.distanceTo(bot.entity.position);
  goal.step = { action: 'animals_feed', kind: e.name, at: plain(e.position) }; save?.();
  if (!await hold(bot)) return false;
  if (near() > TAKE) {
    try { await navigate(bot, task, new goals.GoalFollow(e, 2), { timeoutMs: 10000, stallMs: 4000, stopWhen: () => gone() || near() <= TAKE }); }
    catch (err) { task.check(); if (fatal(err)) throw err; }
  }
  if (gone() || near() > TAKE + 0.5) return false;
  await hold(bot);
  const before = wheat(bot);
  await bot.lookAt(e.position.offset(0, (e.height || 1.3) * 0.6, 0), true);
  bot.useOn(e);
  const took = await waitFor(task, () => wheat(bot) < before, 1500);
  memo(bot)[took ? 'fed' : 'untaken'][idOf(e)] = Date.now();
  return took;
}

// One run (work.js, kind 'animals'): -> true, with goal.led, goal.stayed, goal.fed and goal.pairs for the line in the
// log (session.js). Throws when there is no house about after all.
async function herdStep(bot, task, goal, save, { navigate } = {}) {
  goal.led ||= 0; goal.stayed ||= 0; goal.fed ||= 0; goal.pairs ||= 0;
  const me = bot.entity.position, now = Date.now();
  const player = bot.players?.[goal.from]?.entity || (bot._company?.name === goal.from && bot._company.position ? { position: bot._company.position } : null);
  const houses = housesNear(bot, me);
  if (!houses.length) throw new Error('No house about to keep animals by');
  const plots = require('./garden').plotsHere(bot);
  let plan = null;
  for (const kind of [goal.herdKind, ...KINDS.filter(k => k !== goal.herdKind)].filter(Boolean)) {
    const p = planFor(bot, kind, { player, houses, plots, now });
    if (p && (p.strays.length || p.pairs)) { plan = p; break; }
  }
  if (!plan) return true;
  goal.herdKind = plan.kind; goal.herdPoint = plain(plan.point);
  try {
    for (const e of plan.strays) {
      task.check();
      if (await lead(bot, task, goal, save, e, plan.point, navigate)) goal.led++; else goal.stayed++;
    }
    // None would come (penned elsewhere, say): the place is let go, and taken afresh where most of them stand.
    if (plan.kept && plan.strays.length && !goal.led) { delete memo(bot).home[plan.kind]; console.log('[animals] none of the ' + SAYS[plan.kind][1] + ' would come to ' + where(plan.point) + ': the place let go'); }
    // The pairs: a first that takes the wheat, then the nearest of the kind to it that does.
    const fresh = () => { const t = Date.now(); return about(bot, plan.kind, player, houses, plan.kept ? plan.point : null).filter(e => !baby(bot, e) && across(e.position, plan.point) <= LEAD_FROM &&
      since(bot, 'fed', e, t) >= BRED_MS && since(bot, 'untaken', e, t) >= BRED_MS); };
    // Only one with another ready within six: a lone one fed is wheat spent on nothing.
    const pairable = list => list.filter(e => list.some(o => o !== e && across(o.position, e.position) <= 6));
    for (let tries = 0; goal.pairs < plan.pairs && tries < 3 * plan.pairs && wheat(bot) >= 2; tries++) {
      task.check();
      const here = bot.entity.position;
      const first = pairable(fresh()).sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0];
      if (!first) break;
      if (!await feed(bot, task, goal, save, first, navigate)) continue;
      goal.fed++;
      const mates = fresh().filter(o => o !== first && across(o.position, first.position) <= 6)
        .sort((a, b) => across(a.position, first.position) - across(b.position, first.position)).slice(0, 3);
      for (const mate of mates) {
        if (!wheat(bot)) break;
        if (await feed(bot, task, goal, save, mate, navigate)) { goal.fed++; goal.pairs++; break; }
      }
    }
  } finally {
    // An animal follows a hand with its food in it anywhere.
    if (bot.heldItem?.name === FOOD) { try { await require('./skills').emptyHand(bot); } catch (_) {} }
  }
  if (goal.led || goal.pairs) console.log('[animals] ' + SAYS[plan.kind][1] + ' by ' + where(plan.point) + ': ' + goal.led + ' led, ' + goal.pairs + (goal.pairs === 1 ? ' pair' : ' pairs') + ' fed');
  save?.();
  return true;
}

// The wheat the garden's bread leaves for the herd about (garden.js loavesFor, surplusOf): two pairs' worth while two
// adults of a kind are about under HERD, one to lead with while there are two at all, and for SEEN_MS after the herd
// was last about (it wanders off and back); none with no house about or the chore off.
function wheatWanted(bot, { env = process.env, now = Date.now() } = {}) {
  try { if (!require('./chores').enabled(env).has('animals')) return 0; } catch (_) { return 0; }
  const me = bot.entity?.position;
  if (!me) return 0;
  const houses = housesNear(bot, me);
  if (!houses.length) return 0;
  for (const kind of KINDS) { const herd = about(bot, kind, null, houses, memo(bot).home[kind] || null); noteSeen(bot, kind, herd.length, herd.filter(e => !baby(bot, e)).length, now); }
  let want = 0;
  for (const seen of Object.values(memo(bot).seen)) if (now - seen.at < SEEN_MS) want = Math.max(want, seen.full ? 1 : 2 * MOST_PAIRS);
  return want;
}

module.exports = { herdDue, herdStep, wheatWanted, pointFor, planFor, spared, SPARE_KINDS, KINDS, FIND, HOME_NEAR, HOME_FROM, SEEN_MS, SPREAD, LEAD_FROM, HERD, PLOT_KEEP, BRED_MS, MOST_PAIRS };
