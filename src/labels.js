'use strict';
// What a player tells the bot a thing is, in their own words ("don't touch this", "you can use this chest", "this is my
// house", "forget that"). The guide reads the words (guide.js "label"); the thing is the one the player looked at, or
// stood in, as the line came (pointedNow), not when the model answered seconds later. Asked for 2026-11-25.
//
// keep: never dug, whoever asks (skills.js digGuardPlugin), but a cell of the building a player asked for there; never
//   broken on a walk or to get free (player-build.js theirsAt); never taken, whatever the mode or the last resort
//   (built.js leftAlone); its chests, barrels and other storage never opened (openGuardPlugin, looting.js). A thing
//   marked on its own (a furnace, a crafting table) is not used either. A building marked keep is its blocks as they
//   stood then: its doors, beds, tables and furnaces stay usable, so the bot still goes in with a player, and no
//   doorway is cut through it: the player opens one, as with "don't cut my wall" (work.js).
// use: the one thing pointed at, never a whole building: a block of theirs the bot may break or take, a chest it may
//   open again though it opened it once (looting.js).
// Any player may set a label and any player may take one off. Kept per world beside the placed-blocks log, at most 64
// for each player; on a block the newest label counts.
const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');
const { dimension } = require('./game-progress');

const PER_PLAYER = 64, MOST_CELLS = 900;
const STORAGE = /(?:^|_)(?:chest|barrel|shulker_box|hopper|dispenser|dropper)$/;
const STATION = /(?:^|_)(?:furnace|smoker|crafting_table|anvil|enchanting_table|brewing_stand|loom|stonecutter|grindstone|smithing_table|cartography_table|fletching_table|lectern)$/;
const PAIRED = /(?:^|_)(?:chest|door|bed)$/;
const KINDS = ['keep', 'use'];
const ASKS = { do: ['keep', 'use', 'forget'], what: ['this', 'here'], thing: ['block', 'chest', 'building'] };

// One line of plain text: no control characters, and no section sign, which the server kicks a client for sending.
const clean = (value, most) => String(value ?? '').replace(/[\x00-\x1f\x7f\xa7\u{2028}\u{2029}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, most).trim();
const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const plain = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const dimOf = bot => dimension(bot) || 'overworld';
const nice = name => String(name || 'block').replace(/^minecraft:/, '').replaceAll('_', ' ');
const xyz = c => `${c.x}, ${c.y}, ${c.z}`;
const at = (bot, p) => { try { return bot.blockAt(new Vec3(p.x, p.y, p.z)); } catch (_) { return null; } };
const standing = b => !!b && !['air', 'cave_air', 'void_air', 'water', 'lava'].includes(b.name);
const valid = l => !!l && KINDS.includes(l.kind) && typeof l.dimension === 'string' && typeof l.by === 'string' && !!l.center &&
  Array.isArray(l.cells) && l.cells.length > 0 && l.cells.length <= MOST_CELLS && l.cells.every(c => [c?.x, c?.y, c?.z].every(Number.isInteger));

class Labels {
  constructor(file) { this.file = file || null; this.labels = []; this.byCell = new Map(); this.load(); }
  get size() { return this.labels.length; }
  load() {
    this.labels = [];
    if (this.file) {
      try { const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (saved?.version === 1 && Array.isArray(saved.labels)) this.labels = saved.labels.filter(valid); }
      catch (_) { /* none yet, or unreadable: no labels rather than no bot */ }
    }
    this.index();
  }
  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, labels: this.labels })}\n`);
      fs.renameSync(tmp, this.file);
    } catch (err) { console.log(`[labels] not saved: ${err.message}`); }
  }
  // Oldest first, so that on a block the newer label is the one found.
  index() {
    this.byCell = new Map();
    for (const label of this.labels) {
      let cells = this.byCell.get(label.dimension);
      if (!cells) this.byCell.set(label.dimension, cells = new Map());
      for (const c of label.cells) cells.set(keyOf(c), label);
    }
  }
  at(dim, p) { return this.labels.length && p ? this.byCell.get(dim)?.get(keyOf(p)) || null : null; }
  // Those that count somewhere in a dimension (a label every block of which a newer one covers counts nowhere).
  counting(dim) { return [...new Set(this.byCell.get(dim)?.values() || [])]; }
  add(label) {
    this.labels.push(label);
    const theirs = this.labels.filter(l => l.by === label.by);
    for (const old of theirs.slice(0, Math.max(0, theirs.length - PER_PLAYER))) this.labels.splice(this.labels.indexOf(old), 1);
    this.index();
    const counting = new Set();
    for (const cells of this.byCell.values()) for (const l of cells.values()) counting.add(l);
    this.labels = this.labels.filter(l => counting.has(l));
    this.save();
    return label;
  }
  remove(label) {
    const i = this.labels.indexOf(label);
    if (i < 0) return false;
    this.labels.splice(i, 1); this.index(); this.save();
    return true;
  }
}

// The label that counts at p, or null. Free with none set: it is read inside the pathfinder's and the searches' loops.
function labelAt(bot, p) {
  const store = bot?.labels;
  if (!store || !store.size || !p) return null;
  return store.at(dimOf(bot), p);
}
const keeps = (bot, p) => labelAt(bot, p)?.kind === 'keep';
// What a player said of p, read once in the hot loops (theirsAt, leftAlone): 'keep'; 'lets', a block the bot may break or
// take (use on a thing neither storage nor a station, and that block still there: one laid in its place since is not let
// go with it); else null.
function toldAt(bot, p) {
  const label = labelAt(bot, p);
  if (!label) return null;
  if (label.kind === 'keep') return 'keep';
  const thing = label.thing || '';
  return label.scope === 'thing' && !STORAGE.test(thing) && !STATION.test(thing) && at(bot, p)?.name === thing ? 'lets' : null;
}
const lets = (bot, p) => toldAt(bot, p) === 'lets';
// A dig a label forbids: a block marked keep, but a cell the building a player asked for plans (a block of it, or one it
// clears), never one of theirs that it keeps.
function keepsDig(bot, p) {
  const label = labelAt(bot, p);
  if (label?.kind !== 'keep') return null;
  const goal = bot?._goal, plan = goal?.blueprint, k = keyOf(p);
  const asked = !!goal?.from && goal.from !== bot.username;
  if (asked && plan && !(plan.preserved || []).some(c => keyOf(c) === k) && [...(plan.blocks || []), ...(plan.empty || [])].some(c => keyOf(c) === k)) return null;
  return label;
}
// An opening a label forbids: storage in anything marked keep; a thing marked keep on its own (a furnace, a table), any.
function refusesOpen(bot, block) {
  const label = block?.position ? labelAt(bot, block.position) : null;
  if (label?.kind !== 'keep') return null;
  return label.scope === 'building' && !STORAGE.test(block.name || '') ? null : label;
}
// A chest marked use after the bot last opened it: open to it again (looting.js keeps a chest it opened once shut).
function usedSince(bot, p, when) {
  const label = labelAt(bot, p);
  return label?.kind === 'use' && Date.parse(label.at) > (Number(when) || 0);
}

// What an opening a label forbids is refused with, or null.
function openRefused(bot, block) {
  const label = refusesOpen(bot, block);
  if (!label) return null;
  const c = block.position;
  console.log(`[labels] not opened: the ${block.name} at (${xyz(c)}), ${label.kind} by ${label.by}`);
  return Object.assign(new Error(`The ${nice(block.name)} at ${xyz(c)} is marked "don't touch", so I won't open it.`), { name: 'Blocked', needsPlayer: true });
}
// Every window on a block but the crafting table's opens through bot.openBlock (mineflayer's openContainer, openChest
// and openFurnace call it); craft-clicks.js opens the table itself and asks openRefused first.
function openGuardPlugin(bot) {
  const open = bot.openBlock;
  if (typeof open !== 'function' || open._labels) return;
  const guarded = function (block, ...rest) {
    const refused = openRefused(bot, block);
    if (refused) return Promise.reject(refused);
    return open.call(this ?? bot, block, ...rest);
  };
  guarded._labels = true;
  bot.openBlock = guarded;
}

// Where the player looks and stands as their line comes in: what "this" and "here" are. The guide answers seconds
// later, the head turned by then.
function pointedNow(bot, from) {
  const player = bot?.players?.[from]?.entity;
  if (!player?.position) return null;
  let hit = null;
  try { const seen = require('./work-site').resolveLocation(bot, from, { aimed: true }); hit = { position: plain(seen.position), name: seen.name }; }
  catch (_) { hit = null; }
  return { hit, standing: plain(player.position), dimension: dimOf(bot) };
}

// A chest's, a door's or a bed's other half.
function pairOf(bot, block) {
  if (!block?.position || !PAIRED.test(block.name || '')) return null;
  const props = (b => { try { return b?.getProperties?.() || {}; } catch (_) { return {}; } });
  const mine = props(block), p = block.position;
  const same = q => { const b = at(bot, q); return b && b.name === block.name ? b : null; };
  if (/_door$/.test(block.name)) return same(p.offset(0, mine.half === 'upper' ? -1 : 1, 0));
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => same(p.offset(dx, 0, dz))).filter(Boolean);
  if (/_bed$/.test(block.name)) return sides.find(b => { const o = props(b); return o.part && o.part !== mine.part && o.facing === mine.facing; }) || null;
  if (mine.type && mine.type !== 'single') return sides.find(b => { const o = props(b); return o.type && o.type !== 'single' && o.type !== mine.type && o.facing === mine.facing; }) || null;
  return null;
}
function thingAt(bot, p) {
  const block = at(bot, p);
  if (!standing(block)) return null;
  const pair = pairOf(bot, block);
  return { scope: 'thing', thing: block.name, cells: [plain(p), ...(pair ? [plain(pair.position)] : [])], center: plain(p) };
}
// The building p is part of, or stands in: the bot's own from its records, else the player's start round it
// (player-build.js startedAt), its blocks as they stand now.
function buildingAt(bot, p) {
  const q = plain(p);
  const entry = (bot.buildRegistry?.all?.(dimOf(bot)) || []).find(e => e.bounds && ['x', 'y', 'z'].every(k => q[k] >= e.bounds.min[k] && q[k] <= e.bounds.max[k]));
  let cells = [], name = null;
  if (entry) {
    const seen = new Map();
    for (const c of [...(entry.blueprint?.blocks || []), ...(entry.blueprint?.preserved || [])]) {
      const k = keyOf(c);
      if (!seen.has(k) && standing(at(bot, c))) seen.set(k, plain(c));
      if (seen.size > MOST_CELLS) return { tooBig: true };
    }
    cells = [...seen.values()]; name = entry.name || null;
  }
  if (!cells.length) {
    let start = null;
    try { start = require('./player-build').startedAt(bot, new Vec3(q.x, q.y, q.z)); } catch (_) { start = null; }
    if (start?.tooBig) return { tooBig: true };
    cells = (start?.cells || []).map(plain);
  }
  if (!cells.length) return null;
  const lo = k => Math.min(...cells.map(c => c[k])), hi = k => Math.max(...cells.map(c => c[k]));
  const center = { x: Math.round((lo('x') + hi('x')) / 2), y: lo('y'), z: Math.round((lo('z') + hi('z')) / 2) };
  return { scope: 'building', thing: 'building', cells, center, name };
}

const TOO_BIG = "That's more than I can mark in one go. Point at the part you mean and say it again.";
const POINT = 'Point at it and say it again, so I can see what you mean.';
const UNSEEN = "I can't see you from here. Come where I can see you and say it again.";
// What a label is for: the thing pointed at, its other half with it; for keep, the building a block of it is part of;
// "here", the building the player stood in. Use is for the one thing, never a building.
function targetOf(bot, ask, pointed) {
  if (!pointed) return { error: UNSEEN };
  if (ask.do === 'use' && (ask.what === 'here' || ask.thing === 'building'))
    return { error: "I'd rather not be let loose on a whole building. Point at the one thing I may use, a chest or a block, and say it again." };
  if (ask.what === 'here') {
    const b = buildingAt(bot, pointed.standing);
    return b?.tooBig ? { error: TOO_BIG } : b || { error: "I can't make out a building round you. Point at it and say it again." };
  }
  const hit = pointed.hit;
  // A building, said of with nothing looked at or nothing of one ("this is my house", said inside it looking up): the
  // one they stand in.
  const around = () => { const b = buildingAt(bot, pointed.standing); return b && !b.tooBig ? b : null; };
  if (!hit) return (ask.do === 'keep' && ask.thing === 'building' && around()) || { error: POINT };
  const name = at(bot, hit.position)?.name || hit.name || '';
  // "This chest", said looking at a wall: which chest is not known, and the wall is not it.
  if (ask.thing === 'chest' && !STORAGE.test(name) && !STATION.test(name)) return { error: `I see ${nice(name)} there, not a chest. Point at the chest and say it again.` };
  const single = STORAGE.test(name) || STATION.test(name) || PAIRED.test(name);
  if (ask.do === 'keep' && (ask.thing === 'building' || !single)) {
    const b = buildingAt(bot, hit.position);
    // A block of it, not the ground before it, unless a building is what they said.
    if (b && !b.tooBig && (ask.thing === 'building' || b.cells.some(c => keyOf(c) === keyOf(hit.position)))) return b;
    if (ask.thing === 'building') return (!b && around()) || { error: b?.tooBig ? TOO_BIG : "I can't make out which building you mean. Point at one of its walls and say it again." };
  }
  return thingAt(bot, hit.position) || { error: POINT };
}

// "my house", said back to the one who named it: "your house"; to another, theirs.
const named = (label, to) => /^my /i.test(label.name) ? `${label.by === to ? 'your' : `${label.by}'s`} ${label.name.slice(3)}` : label.name;
function said(label) {
  const where = xyz(label.center), halves = label.cells.length === 2 ? ' (both halves)' : '', thing = nice(label.thing);
  if (label.scope === 'building') return `Got it: ${label.name ? named(label, label.by) : 'that building'}, ${label.cells.length} blocks at ${where}. I won't break or take any of it or open its chests; I can still go in.`;
  if (label.kind === 'keep') return STORAGE.test(label.thing) ? `Got it: I won't open or break the ${thing} at ${where}${halves}.`
    : STATION.test(label.thing) ? `Got it: I won't use or break the ${thing} at ${where}.` : `Got it: I won't break or take the ${thing} at ${where}${halves}.`;
  return STORAGE.test(label.thing) ? `All right: I may open the ${thing} at ${where}${halves} and take what I need.`
    : STATION.test(label.thing) ? `All right: I may use the ${thing} at ${where}.` : `All right: I may break or take the ${thing} at ${where}${halves}.`;
}

function forget(bot, from, ask, pointed) {
  if (!pointed) return UNSEEN;
  const store = bot.labels, dim = pointed.dimension;
  let cells;
  if (ask.what === 'here' || (!pointed.hit && ask.thing === 'building')) cells = buildingAt(bot, pointed.standing)?.cells || [pointed.standing];
  else if (pointed.hit) cells = thingAt(bot, pointed.hit.position)?.cells || [pointed.hit.position];
  else return POINT;
  const gone = [...new Set(cells.map(c => store.at(dim, c)).filter(Boolean))];
  if (!gone.length) return ask.what === 'here' ? 'Nothing is marked here.' : 'Nothing is marked there.';
  for (const label of gone) store.remove(label);
  console.log(`[labels] ${from}: took off ${gone.map(l => `${l.kind} ${l.name || l.thing} at (${xyz(l.center)}) by ${l.by}`).join('; ')}`);
  const one = gone[0], what = one.scope === 'building' ? (one.name ? named(one, from) : 'that building') : `the ${nice(one.thing)} at ${xyz(one.center)}`;
  const others = [...new Set(gone.map(l => l.by).filter(by => by !== from))];
  return `Done: ${gone.length > 1 ? `${gone.length} labels there are` : `the label on ${what} is`} off${others.length ? ` (${others.join(' and ')} set ${gone.length > 1 ? 'them' : 'it'})` : ''}.`;
}

// The guide's label (guide.js), read with where the player looked as they said it: what is said back, or null.
function apply(bot, from, ask, pointed, { judged = false } = {}) {
  if (!bot?.labels || !ask || !ASKS.do.includes(ask.do)) return null;
  // Said without the name, the line may not have been for the bot, and the look it came with is long gone by the time
  // the judge has read it.
  if (judged) return `${from}, if that was for me, say it again with my name while you point at it.`;
  if (ask.do === 'forget') return forget(bot, from, ask, pointed);
  const target = targetOf(bot, ask, pointed);
  if (target.error) return target.error;
  const label = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: ask.do, scope: target.scope, thing: target.thing,
    name: target.scope === 'building' ? clean(String(ask.name ?? '').replace(/^[\s/]+/, ''), 40) || target.name || null : null,
    dimension: pointed.dimension, cells: target.cells, center: target.center, by: clean(from, 64), at: new Date().toISOString() };
  bot.labels.add(label);
  console.log(`[labels] ${from}: ${label.kind} ${label.scope} ${label.name || label.thing} at (${xyz(label.center)}), ${label.cells.length} block${label.cells.length === 1 ? '' : 's'}`);
  return said(label);
}

// The labels near a point, for the guide (session.js guideStatus): what "what's marked here?" is answered from.
function statusNear(bot, point, { radius = 48, most = 8 } = {}) {
  const store = bot?.labels;
  if (!store?.size || !point) return [];
  return store.counting(dimOf(bot)).map(l => ({ l, d: Math.hypot(l.center.x - point.x, l.center.y - point.y, l.center.z - point.z) }))
    .filter(e => e.d <= radius).sort((a, b) => a.d - b.d).slice(0, most)
    .map(({ l, d }) => ({ label: l.kind === 'keep' ? "don't touch" : 'may use', what: l.scope === 'building' ? l.name || 'a building' : nice(l.thing),
      at: l.center, blocks: l.cells.length, blocksAway: Math.round(d), setBy: l.by }));
}

module.exports = { Labels, labelAt, keeps, lets, toldAt, keepsDig, refusesOpen, openRefused, usedSince, openGuardPlugin, pointedNow, targetOf, apply, statusNear,
  ASKS, STORAGE, STATION, PER_PLAYER };
