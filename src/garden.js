'use strict';
// The waiting bot's garden (chores.js): a little plot by water beside a house, tilled with a hoe and sown with the
// seeds carried or found in the grass about it. Asked for 2026-11-27: "jev for example can use hoe to make dirt better
// for growing seeds and plant seeds, and others things, basically there should be gardener set of activities", and
// "obviously he can do it only if there is a house/shelter nearby".
//
// A house, within HOUSE_NEAR of the bot and of the player it waits with, is one of these:
//   the bot's own (its records, builds.js): a house, or a building whose plan has a bed, most of it still standing,
//     finished or not (a house left with three blocks to go is a house all the same);
//   a building a player named ("this is my house": labels.js, a building marked keep);
//   a bed or a door with walls about it (made blocks, or blocks a player was seen to lay: built.js, player-build.js) and
//     a block over it: a player's house nobody told the bot of. A village's houses are houses too.
// The plot is three by three on grass or dirt, its eight outer cells at the level of water within WET of each (farmland
// by water stays wet and grows faster), PLOT_FROM to PLOT_TO blocks out from the house, DOOR_CLEAR from its doors and
// its way in, within LEVEL of its floor, under open sky, with nothing built, laid by a player or marked in it or about
// it, nobody's farmland within two and no stump owed a sapling within two. The eight cells round the middle are farmed
// and the middle is left: every farmed cell then has open ground beside it to work it from, and the bot never stands on
// farmland (movement.js walks round it). It is kept once begun (bot._gardenFile, session.js), read again before each
// run, and forgotten once half of it is built on or dug. No water at the ground's level by the house: no garden.
//
// A run is one pass (work.js): a hoe made if none is carried and a cell wants tilling (planks and sticks from the wood
// carried, the hoe at a crafting table already standing within TABLE_NEAR), seeds picked up from the grass about the
// plot when too few are carried, then as many cells tilled as there are seeds for, and sown, from a stand beside the
// plot. Nothing is laid, no table is set down, nothing is fetched from farther off, nothing is picked up into full
// pockets. Wheat seeds first, then beetroot seeds, then a carrot or a potato past the one of each kept to eat. A run
// that came to nothing rests the garden five minutes, then ten, twenty, thirty.
// Not yet: the harvest, bread, torches about it at dusk. A cell trampled back to dirt is tilled and sown again.
const fs = require('fs');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');

const HOUSE_NEAR = 24;
const PLOT_FROM = 3, PLOT_TO = 10;          // the plot's cells this far out from the house, across
const DOOR_CLEAR = 4;
const WET = 4;                              // water this near across, at the farmland's level or one over, keeps it wet
const LEVEL = 3;                            // the plot's ground this near the house's floor, up or down
const SEED_REACH = 12;                      // grass broken for seeds this near the plot's middle
const GRASS_MOST = 40;                      // grass broken in one run (a seed in about one in eight)
const GRASS_FEW = 8;                        // no seeds carried and fewer grass than this about: nothing to sow with
const TABLE_NEAR = 16;
const WALLS = 4;                            // made or laid blocks about a bed or a door that make it a house's
const REACH = 4.3;                          // eye to a cell's top: under the arm's 4.5
const HOUSES_MS = 60000, SITE_MS = 5 * 60000, NONE_MS = 10 * 60000, STUCK_MS = 20 * 60000;
const MOST_PLOTS = 8;
const SOWN = Object.freeze(['wheat_seeds', 'beetroot_seeds', 'carrot', 'potato']);
const KEEP = Object.freeze({ carrot: 1, potato: 1 });
const RIPE = Object.freeze({ wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 });
const GROUND = /^(grass_block|dirt)$/;
const COVER = /^(short_grass|tall_grass|fern|large_fern)$/;
const AIR = /^(air|cave_air|void_air)$/;
const CROP = /^(wheat|carrots|potatoes|beetroots)$/;
const LOGS = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$|^(crimson|warped)_stem$/;
const STONE = /^(cobblestone|cobbled_deepslate|blackstone)$/;

const at = p => new Vec3(p.x, p.y, p.z);
const plain = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const keyOf = p => Math.floor(p.x) + ',' + Math.floor(p.y) + ',' + Math.floor(p.z);
const colOf = (x, z) => x + ',' + z;
const up = (p, n = 1) => ({ x: p.x, y: p.y + n, z: p.z });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fatal = err => ['Cancelled', 'NeedsAir', 'NeedsSafety', 'Blocked'].includes(err?.name);
const dimOf = bot => String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '');
const WORLD = bot => dimOf(bot) + ':' + (bot.game?.hashedSeed ?? '');
function blockOf(bot, p) { try { return bot.blockAt(at(p)) || null; } catch (_) { return null; } }
const nameOf = (bot, p) => blockOf(bot, p)?.name || null;
const solid = b => !!b && b.boundingBox === 'block';
const items = bot => (typeof bot?.inventory?.items === 'function' ? bot.inventory.items() : []);
const count = (bot, what) => items(bot).reduce((n, i) => n + ((typeof what === 'string' ? i.name === what : what.test(i.name)) ? i.count : 0), 0);
const hoeCarried = bot => items(bot).find(i => /_hoe$/.test(i.name)) || null;
const freeSlots = bot => (typeof bot.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 1);
const room = (bot, item) => require('./tree-felling').room(bot, item);
// Across, from a point to a box's x and z: none inside it.
const gapTo = (p, min, max) => Math.max(min.x - p.x, p.x - max.x, min.z - p.z, p.z - max.z, 0);
const across = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const eye = bot => bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
const inReach = (bot, c) => eye(bot).distanceTo(at(c).offset(0.5, 1, 0.5)) <= REACH;
const inReachOf = (bot, p) => eye(bot).distanceTo(at(p).offset(0.5, 0.5, 0.5)) <= REACH;
// A player's block (labels.js keep, one seen laid, one a building of the bot's keeps), something built, a label: on any
// error read as kept.
const theirs = (bot, p) => { try { return !!require('./player-build').theirsAt(bot, at(p), null); } catch (_) { return true; } };
const builtHere = (bot, p) => { try { return !!require('./built').builtAt(bot, at(p), null); } catch (_) { return true; } };
const marked = (bot, p) => { try { return !!require('./labels').labelAt(bot, at(p)); } catch (_) { return true; } };
const seenLaid = (bot, p) => { try { return !!require('./player-build').seenPlaced(bot, at(p)); } catch (_) { return false; } };
const ownLaid = (bot, p) => { try { return !!require('./own-blocks').laidAt(bot, at(p)); } catch (_) { return false; } };
const sowable = (bot, seed) => Math.max(0, count(bot, seed) - (KEEP[seed] || 0));
const seedsCarried = bot => SOWN.reduce((n, s) => n + sowable(bot, s), 0);
const seedFor = bot => SOWN.find(s => sowable(bot, s) > 0) || null;
const ageOf = b => { try { return Number(b?.getProperties?.().age ?? 0); } catch (_) { return 0; } };
const propsOf = b => { try { return b?.getProperties?.() || {}; } catch (_) { return {}; } };
async function waitFor(task, test, ms) {
  const end = Date.now() + ms;
  for (;;) { task.check(); if (test()) return true; if (Date.now() >= end) return false; await sleep(50); }
}

// The blocks of a kind about a point (findBlocks), by their ids.
function idsOf(bot, re) {
  const kept = bot._gardenIds ||= new Map();
  if (!kept.has(re.source)) kept.set(re.source, (bot.registry?.blocksArray || []).filter(b => re.test(b.name)).map(b => b.id));
  return kept.get(re.source);
}
function find(bot, point, re, maxDistance, most) {
  const matching = idsOf(bot, re);
  if (!matching.length || typeof bot.findBlocks !== 'function') return [];
  try { return (bot.findBlocks({ point: at(point), matching, maxDistance, count: most }) || []).map(plain); } catch (_) { return []; }
}

// ---- the houses about
function ownHouses(bot, me) {
  const registry = bot.buildRegistry;
  if (typeof registry?.near !== 'function') return [];
  let near = [];
  try { near = registry.near(me, dimOf(bot), HOUSE_NEAR + 48) || []; } catch (_) { near = []; }
  const out = [];
  for (const entry of near) {
    const cells = entry.blueprint?.blocks || [];
    if (!entry.bounds || !(entry.kind === 'house' || cells.some(c => /_bed$/.test(c.material || '')))) continue;
    let standing = 0;
    try { standing = registry.standing(bot, entry); } catch (_) { standing = 0; }
    if (standing < 0.6) continue;
    const doors = cells.filter(c => /_door$/.test(c.material || '')).map(plain);
    if (entry.entrance) doors.push(plain(entry.entrance));
    const beds = cells.filter(c => /_bed$/.test(c.material || ''));
    const floor = doors.length ? Math.min(...doors.map(d => d.y)) - 1 : beds.length ? Math.min(...beds.map(b => b.y)) - 1 : (entry.origin?.y ?? entry.bounds.min.y);
    out.push({ key: 'own:' + entry.id, kind: 'own', name: entry.name || 'the house', min: plain(entry.bounds.min), max: plain(entry.bounds.max), floor, doors });
  }
  return out;
}
function namedHouses(bot) {
  const store = bot.labels;
  if (typeof store?.counting !== 'function') return [];
  let labels = [];
  try { labels = store.counting(dimOf(bot)) || []; } catch (_) { labels = []; }
  return labels.filter(l => l?.scope === 'building' && l.kind === 'keep' && Array.isArray(l.cells) && l.cells.length).map(l => {
    const lo = k => Math.min(...l.cells.map(c => c[k])), hi = k => Math.max(...l.cells.map(c => c[k]));
    const doors = l.cells.filter(c => /_door$/.test(nameOf(bot, c) || '')).map(plain);
    return { key: 'named:' + l.id, kind: 'named', name: l.name || 'the house', min: { x: lo('x'), y: lo('y'), z: lo('z') }, max: { x: hi('x'), y: hi('y'), z: hi('z') },
      floor: doors.length ? Math.min(...doors.map(d => d.y)) - 1 : lo('y'), doors };
  });
}
// Walls about a bed or a door: made blocks (built.js), or solid blocks a player was seen to lay, in the cells about it.
function walled(bot, p) {
  const { structure } = require('./built');
  let n = 0;
  for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 3; dy++) for (let dz = -2; dz <= 2; dz++) {
    if (!dx && !dy && !dz) continue;
    const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz }, b = blockOf(bot, q);
    if (!b || AIR.test(b.name)) continue;
    if ((structure(b.name) || (solid(b) && seenLaid(bot, q))) && ++n >= WALLS) return true;
  }
  return false;
}
const roofed = (bot, p, from) => { for (let dy = from; dy <= from + 4; dy++) if (solid(blockOf(bot, up(p, dy)))) return true; return false; };
function foundHouses(bot, me) {
  const out = [];
  const found = find(bot, me, /_bed$|_door$/, HOUSE_NEAR + 8, 32);
  for (const p of found) {
    const b = blockOf(bot, p);
    if (!b) continue;
    const door = /_door$/.test(b.name), props = propsOf(b);
    if (door ? props.half === 'upper' : props.part === 'head') continue;
    if (out.some(h => gapTo(p, h.min, h.max) === 0) || ownLaid(bot, p) || !walled(bot, p) || !roofed(bot, p, door ? 2 : 1)) continue;
    out.push({ key: 'found:' + keyOf(p), kind: 'found', name: door ? 'the house by the door' : 'the house with the bed', anchor: p,
      min: { x: p.x - 3, y: p.y - 1, z: p.z - 3 }, max: { x: p.x + 3, y: p.y + 4, z: p.z + 3 }, floor: p.y - 1, doors: door ? [p] : [] });
  }
  // A bed's house: the doors found about it are its own.
  for (const h of out) if (!h.doors.length) h.doors = found.filter(q => across(q, h.anchor) <= 8 && /_door$/.test(nameOf(bot, q) || ''));
  return out;
}
function housesAbout(bot, me, now = Date.now()) {
  const kept = bot._gardenHouses, here = at(me);
  if (kept && now - kept.at < HOUSES_MS && kept.world === WORLD(bot) && kept.from.distanceTo(here) < 8) return kept.list;
  const list = [...ownHouses(bot, me), ...namedHouses(bot)];
  for (const h of foundHouses(bot, me)) if (!list.some(o => gapTo(h.anchor, o.min, o.max) <= 2)) list.push(h);
  bot._gardenHouses = { at: now, world: WORLD(bot), from: here, list };
  return list;
}

// ---- the gardens kept
const validPlot = p => !!p && typeof p.world === 'string' && Array.isArray(p.cells) && p.cells.length === 8 && !!p.middle && Array.isArray(p.stands) && p.stands.length > 0;
function loadPlots(bot) {
  if (bot._gardensLoaded) return;
  bot._gardensLoaded = true;
  if (!bot._gardenFile) return;
  try {
    const data = JSON.parse(fs.readFileSync(bot._gardenFile, 'utf8'));
    if (data?.version === 1 && Array.isArray(data.plots)) bot._gardens = [...data.plots.filter(validPlot), ...(bot._gardens || [])].slice(-MOST_PLOTS);
  } catch (_) { /* none kept yet */ }
}
function savePlots(bot) {
  if (!bot._gardenFile) return;
  try { const tmp = bot._gardenFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ version: 1, plots: bot._gardens || [] }) + '\n'); fs.renameSync(tmp, bot._gardenFile); }
  catch (err) { console.log('[garden] not saved: ' + err.message); }
}
function plotsHere(bot) { loadPlots(bot); bot._gardens ||= []; return bot._gardens.filter(p => p.world === WORLD(bot)); }
const plotBy = (bot, house) => plotsHere(bot).find(p => gapTo(p.middle, house.min, house.max) <= PLOT_TO + 2) || null;
const where = c => '(' + c.x + ', ' + c.y + ', ' + c.z + ')';
function begin(bot, house, site) {
  plotsHere(bot);
  const plot = { world: WORLD(bot), house: house.key, houseName: house.name, origin: site.origin, middle: site.middle, cells: site.cells, stands: site.stands,
    begunAt: new Date().toISOString(), stuck: {} };
  bot._gardens.push(plot);
  while (bot._gardens.length > MOST_PLOTS) bot._gardens.shift();
  savePlots(bot);
  console.log('[garden] begun by ' + house.name + ' at ' + where(site.middle) + ': eight cells round the middle, water within ' + WET);
  return plot;
}
function forget(bot, plot, why) {
  bot._gardens = (bot._gardens || []).filter(p => p !== plot);
  savePlots(bot);
  console.log('[garden] the garden at ' + where(plot.middle) + ' forgotten: ' + why);
}
// What its cells hold now: untilled ground the hoe may turn, bare farmland, crops growing or ripe, cells built on or
// dug (blocked), the hoe's misses resting (waiting), and out of the loaded world.
function plotStatus(bot, plot, now = Date.now()) {
  const s = { untilled: [], bare: [], growing: [], ripe: [], blocked: [], waiting: [], unloaded: [] };
  for (const c of plot.cells) {
    const ground = blockOf(bot, c), over = blockOf(bot, up(c));
    if (!ground || !over) { s.unloaded.push(c); continue; }
    if (ground.name === 'farmland') {
      if (CROP.test(over.name)) (ageOf(over) >= RIPE[over.name] ? s.ripe : s.growing).push(c);
      else if (AIR.test(over.name)) s.bare.push(c);
      else s.blocked.push(c);
    } else if (GROUND.test(ground.name) && (AIR.test(over.name) || COVER.test(over.name)) && !theirs(bot, c)) {
      ((plot.stuck?.[keyOf(c)] || 0) > now ? s.waiting : s.untilled).push(c);
    } else s.blocked.push(c);
  }
  return s;
}

// ---- where a garden goes, by a house
function searchSite(bot, house) {
  const span = PLOT_TO + 2 + WET, lo = { x: house.min.x - span, z: house.min.z - span }, hi = { x: house.max.x + span, z: house.max.z + span };
  // Each column's top within reach of the house's floor: its ground, or water.
  const top = new Map();
  for (let x = lo.x; x <= hi.x; x++) for (let z = lo.z; z <= hi.z; z++) {
    for (let y = house.floor + LEVEL + 1; y >= house.floor - LEVEL - 1; y--) {
      const b = blockOf(bot, { x, y, z });
      if (!b) break;
      if (b.name === 'water' || solid(b)) { top.set(colOf(x, z), { y, name: b.name }); break; }
    }
  }
  const water = [];
  for (const [k, t] of top) if (t.name === 'water') { const [x, z] = k.split(',').map(Number); water.push({ x, y: t.y, z }); }
  if (!water.length) return { why: 'no water at the level of the ground within ' + span + ' blocks of it' };
  // Wet: water within WET across, at the cell's level or one over it.
  const wet = new Set();
  for (const w of water) for (let dx = -WET; dx <= WET; dx++) for (let dz = -WET; dz <= WET; dz++) {
    const k = colOf(w.x + dx, w.z + dz), t = top.get(k);
    if (t && GROUND.test(t.name) && (w.y === t.y || w.y === t.y + 1)) wet.add(k);
  }
  if (!wet.size) return { why: 'no grass or dirt by the water at its level' };
  const { made } = require('./built');
  let claimed = new Set();
  try { claimed = bot.buildRegistry?.claimed?.(dimOf(bot)) || new Set(); } catch (_) { claimed = new Set(); }
  let owed = [];
  try { owed = require('./tree-felling').owedHere(bot).map(s => s.cells[0]).filter(Boolean); } catch (_) { owed = []; }
  // A cell fit to farm: grass or dirt, nothing over it but grass, open sky, nobody's, nothing built or marked.
  const fitKept = new Map();
  const fit = c => {
    const k = keyOf(c);
    if (fitKept.has(k)) return fitKept.get(k);
    let ok = GROUND.test(nameOf(bot, c) || '');
    if (ok) { const over = nameOf(bot, up(c)); ok = !!over && (AIR.test(over) || COVER.test(over)); }
    for (let dy = 2; ok && dy <= 10; dy++) { const b = blockOf(bot, up(c, dy)); if (b && (solid(b) || /^(water|lava)$/.test(b.name))) ok = false; }
    if (ok) ok = !claimed.has(k) && !marked(bot, c) && !theirs(bot, c) && !builtHere(bot, c);
    fitKept.set(k, ok);
    return ok;
  };
  // A column kept clear of: a path, or something made, laid by a player, marked or the bot's buildings', on its ground
  // or the three cells over it.
  const dirtyKept = new Map();
  const dirty = (x, z) => {
    const k = colOf(x, z);
    if (dirtyKept.has(k)) return dirtyKept.get(k);
    const t = top.get(k);
    let d = false;
    for (let y = t ? t.y : 0; t && y <= t.y + 3 && !d; y++) {
      const p = { x, y, z }, n = nameOf(bot, p);
      if (!n || AIR.test(n)) continue;
      d = n === 'dirt_path' || made(n) || seenLaid(bot, p) || marked(bot, p) || claimed.has(keyOf(p));
    }
    dirtyKept.set(k, d);
    return d;
  };
  const farmed = (x, z) => top.get(colOf(x, z))?.name === 'farmland';
  const square = (x0, z0, size, test) => { for (let x = x0; x < x0 + size; x++) for (let z = z0; z < z0 + size; z++) if (test(x, z)) return true; return false; };
  const standsOn = s => { const t = top.get(colOf(s.x, s.z)); if (!t || t.y !== s.y || t.name === 'water') return false;
    const g = blockOf(bot, s), a = blockOf(bot, up(s)), b = blockOf(bot, up(s, 2));
    return solid(g) && !!a && !!b && !solid(a) && !solid(b) && !/water|lava/.test(a.name + ' ' + b.name); };
  let best = null;
  for (let x0 = house.min.x - PLOT_TO - 2; x0 <= house.max.x + PLOT_TO; x0++) for (let z0 = house.min.z - PLOT_TO - 2; z0 <= house.max.z + PLOT_TO; z0++) {
    const cells = [];
    let gy = null, flat = true;
    for (let dx = 0; dx < 3 && flat; dx++) for (let dz = 0; dz < 3; dz++) {
      const t = top.get(colOf(x0 + dx, z0 + dz));
      if (!t || (gy !== null && t.y !== gy)) { flat = false; break; }
      gy = t.y; cells.push({ x: x0 + dx, y: t.y, z: z0 + dz });
    }
    if (!flat || cells.length !== 9 || Math.abs(gy - house.floor) > LEVEL) continue;
    const gap = Math.min(...cells.map(c => gapTo(c, house.min, house.max)));
    if (gap < PLOT_FROM || gap > PLOT_TO || (best && gap * 10 > best.score + 4)) continue;
    if (house.doors.some(d => cells.some(c => across(c, d) < DOOR_CLEAR))) continue;
    const middle = cells[4], outer = cells.filter((_, i) => i !== 4);
    if (!outer.every(c => wet.has(colOf(c.x, c.z)))) continue;
    if (square(x0 - 1, z0 - 1, 5, dirty) || square(x0 - 2, z0 - 2, 7, farmed)) continue;
    if (owed.some(o => o.x >= x0 - 2 && o.x <= x0 + 4 && o.z >= z0 - 2 && o.z <= z0 + 4)) continue;
    if (!cells.every(fit)) continue;
    const stands = [{ x: x0 + 1, z: z0 - 1 }, { x: x0 + 1, z: z0 + 3 }, { x: x0 - 1, z: z0 + 1 }, { x: x0 + 3, z: z0 + 1 }].map(s => ({ ...s, y: gy })).filter(standsOn);
    if (stands.length < 2) continue;
    const score = gap * 10 - stands.length;
    if (!best || score < best.score) best = { score, site: { origin: { x: x0, y: gy, z: z0 }, middle, cells: outer, stands } };
  }
  return best ? { site: best.site } : { why: 'no level grass by the water there, clear of the house, its door and anything built' };
}
function siteBy(bot, house, now = Date.now()) {
  const kept = bot._gardenSites ||= new Map(), hit = kept.get(house.key);
  if (hit && now - hit.at < (hit.site ? SITE_MS : NONE_MS)) return hit;
  let found;
  try { found = searchSite(bot, house); } catch (err) { found = { why: 'the look failed: ' + err.message }; }
  const entry = { at: now, ...found };
  kept.set(house.key, entry);
  // Said once a house and reason in the log, not each time it is looked at again.
  const said = bot._gardenSaid ||= new Set(), line = house.key + ' ' + found.why;
  if (!found.site && !said.has(line)) { said.add(line); console.log('[garden] no garden by ' + house.name + ': ' + found.why); }
  return entry;
}

// ---- what a run needs
function tableNear(bot, point, now = Date.now()) {
  const kept = bot._gardenTable, from = keyOf(point);
  let p = null;
  if (kept && now - kept.at < HOUSES_MS && kept.from === from) p = kept.p;
  else {
    const labels = require('./labels');
    p = find(bot, point, /^crafting_table$/, TABLE_NEAR, 8).filter(q => { const b = blockOf(bot, q); return b?.name === 'crafting_table' && !labels.refusesOpen(bot, b); })
      .sort((a, b) => at(a).distanceTo(at(point)) - at(b).distanceTo(at(point)))[0] || null;
    bot._gardenTable = { at: now, from, p };
  }
  const b = p && blockOf(bot, p);
  return b?.name === 'crafting_table' ? b : null;
}
// What a hoe is made of from the pockets: two planks and two sticks (sticks from two planks, planks from a log), or two
// cobblestone and two sticks. -> { hoe, planks, sticks } | null
function hoePlan(bot) {
  const sticks = count(bot, 'stick'), wood = count(bot, /_planks$/) + 4 * count(bot, LOGS), stone = count(bot, STONE), forSticks = sticks >= 2 ? 0 : 2;
  if (wood >= 2 + forSticks) return { hoe: 'wooden_hoe', planks: 2 + forSticks, sticks: forSticks > 0 };
  if (stone >= 2 && wood >= forSticks) return { hoe: 'stone_hoe', planks: forSticks, sticks: forSticks > 0 };
  return null;
}
const lowerHalf = (bot, p) => { const n = nameOf(bot, p); return !/^(tall_grass|large_fern)$/.test(n || '') || nameOf(bot, up(p, -1)) !== n; };
// Grass about the plot that may be broken for seeds: not in the house, not a player's, not marked.
function grassAbout(bot, plot, house) {
  return find(bot, plot.middle, COVER, SEED_REACH, 64)
    .filter(p => Math.abs(p.y - (plot.middle.y + 1)) <= LEVEL && gapTo(p, house.min, house.max) > 0 && lowerHalf(bot, p) && !theirs(bot, p) && !marked(bot, p));
}
function grassCount(bot, plot, house, now) {
  const kept = bot._gardenGrass, k = keyOf(plot.middle);
  if (kept && kept.k === k && now - kept.at < HOUSES_MS) return kept.n;
  const n = grassAbout(bot, plot, house).length;
  bot._gardenGrass = { k, at: now, n };
  return n;
}

// ---- the chore
// The garden due about the bot, or null: a house near the bot and the player, its garden kept or a spot for one, and
// cells there is the work for (bare farmland, or ground to till with a hoe carried or made here), with seeds carried
// or grass about to find them in.
function gardenDue(bot, { player = null, now = Date.now() } = {}) {
  const me = bot.entity?.position;
  if (!me || typeof bot.findBlocks !== 'function' || typeof bot.blockAt !== 'function') return null;
  const near = h => gapTo(me, h.min, h.max) <= HOUSE_NEAR && (!player?.position || gapTo(player.position, h.min, h.max) <= HOUSE_NEAR);
  const houses = housesAbout(bot, me, now).filter(near).sort((a, b) => gapTo(me, a.min, a.max) - gapTo(me, b.min, b.max)).slice(0, 3);
  for (const house of houses) {
    const d = dueBy(bot, house, now);
    if (d) return d;
  }
  return null;
}
function dueBy(bot, house, now) {
  let plot = plotBy(bot, house);
  if (plot) {
    const s = plotStatus(bot, plot, now);
    if (s.blocked.length >= 4) { forget(bot, plot, s.blocked.length + ' of its 8 cells built on or dug'); plot = null; }
    else if ((plot.restUntil || 0) > now) return null;
  }
  const site = plot ? null : siteBy(bot, house, now).site;
  if (!plot && !site) return null;
  const s = plot ? plotStatus(bot, plot, now) : { untilled: site.cells, bare: [] };
  const spot = plot || site;
  const canTill = !!hoeCarried(bot) || (!!hoePlan(bot) && freeSlots(bot) > 0 && !!tableNear(bot, spot.middle, now));
  const cells = s.bare.length + (canTill ? s.untilled.length : 0);
  if (!cells) return null;
  const seeds = seedsCarried(bot);
  const grass = seeds >= cells || !room(bot, 'wheat_seeds') ? 0 : grassCount(bot, spot, house, now);
  if (!seeds && grass < GRASS_FEW) return null;
  const why = (plot ? 'the garden by ' : 'a garden to begin by ') + house.name + ': ' + [s.bare.length && s.bare.length + ' bare', canTill && s.untilled.length && s.untilled.length + ' to till']
    .filter(Boolean).join(', ') + '; ' + seeds + ' seeds carried' + (grass ? ', ' + grass + ' grass about' : '') + (hoeCarried(bot) ? '' : ', a hoe to make');
  return { chore: 'garden', why, fresh: !plot, house: house.key, houseName: house.name, untilled: s.untilled.length, bare: s.bare.length, seeds, grass };
}

async function makeHoe(bot, task, goal, save, plot, { navigate, openWindow }) {
  const plan = hoePlan(bot), table = tableNear(bot, plot.middle);
  if (!plan || !table || freeSlots(bot) < 1) return false;
  const tp = table.position;
  goal.step = { action: 'garden_hoe', item: plan.hoe, table: plain(tp) }; save?.();
  if (eye(bot).distanceTo(at(tp).offset(0.5, 0.5, 0.5)) > REACH) {
    if (!navigate) return false;
    try { await navigate(bot, task, new goals.GoalNear(tp.x, tp.y, tp.z, 2), { timeoutMs: 30000, stallMs: 6000 }); }
    catch (err) { task.check(); if (fatal(err)) throw err; return false; }
  }
  // Planks from a log carried and sticks from planks, in the pockets' own grid.
  if (count(bot, /_planks$/) < plan.planks) {
    const log = items(bot).find(i => LOGS.test(i.name));
    if (!log || !await craftOne(bot, task, log.name.replace(/_(log|stem)$/, '_planks'), null)) return false;
  }
  if (plan.sticks && !await craftOne(bot, task, 'stick', null)) return false;
  const bench = blockOf(bot, tp);
  if (bench?.name !== 'crafting_table') return false;
  const made = await craftOne(bot, task, plan.hoe, bench, openWindow);
  if (made) console.log('[garden] a ' + plan.hoe.replace('_', ' ') + ' made at the crafting table at ' + where(tp));
  return made;
}
// One craft, tried once, counted by what reached the pockets: in the pockets' grid, or at a table through its window.
async function craftOne(bot, task, name, table, openWindow) {
  const id = bot.registry?.itemsByName?.[name]?.id;
  if (id === undefined || typeof bot.recipesFor !== 'function' || freeSlots(bot) < 1) return false;
  const recipe = bot.recipesFor(id, null, 1, table || null)?.[0];
  if (!recipe) return false;
  const before = count(bot, name);
  try {
    if (table && openWindow) await openWindow(bot, task, () => bot.craft(recipe, 1, table), { block: table, what: 'the crafting table', timeoutMs: 10000 });
    else await bot.craft(recipe, 1, table || null);
  } catch (err) { task.check(); if (fatal(err)) throw err; console.log('[garden] no ' + name.replaceAll('_', ' ') + ' made: ' + err.message); }
  return waitFor(task, () => count(bot, name) > before, 3000);
}

// Grass about the plot broken for its seeds, those on the plot first, the nearest next, until there are seeds for the
// cells or GRASS_MOST are broken; the seeds picked up where they fell, never into full pockets.
async function gatherSeeds(bot, task, goal, save, plot, house, want, { navigate, dig, collect }) {
  if (!dig) return 0;
  const tf = require('./tree-felling');
  const start = count(bot, 'wheat_seeds');
  const onPlot = p => Math.abs(p.x - plot.middle.x) <= 1 && Math.abs(p.z - plot.middle.z) <= 1 ? 1 : 0;
  const left = grassAbout(bot, plot, house);
  let broken = 0;
  while (left.length && broken < GRASS_MOST && seedsCarried(bot) < want && tf.room(bot, 'wheat_seeds')) {
    task.check();
    const here = bot.entity.position;
    left.sort((a, b) => onPlot(b) - onPlot(a) || at(a).distanceTo(here) - at(b).distanceTo(here));
    const p = left.shift();
    if (!COVER.test(nameOf(bot, p) || '')) continue;
    goal.step = { action: 'garden_seeds', position: p }; save?.();
    if (!inReachOf(bot, p)) {
      if (!navigate) continue;
      try { await navigate(bot, task, new goals.GoalNear(p.x, p.y, p.z, 2), { timeoutMs: 12000, stallMs: 4000 }); }
      catch (err) { task.check(); if (fatal(err)) throw err; continue; }
      if (!inReachOf(bot, p)) continue;
    }
    try { await dig(bot, task, at(p), { requireDrops: false }); }
    catch (err) { task.check(); if (fatal(err)) throw err; continue; }
    broken++;
    await sleep(300);
    if (collect && tf.room(bot, 'wheat_seeds') && tf.lyingLow(bot, 'wheat_seeds', at(p), 4)) {
      try { await collect(bot, task, 'wheat_seeds', { origin: at(p), radius: 5, timeoutMs: 4000, waitForSpawnMs: 0 }); }
      catch (err) { task.check(); if (fatal(err)) throw err; }
    }
  }
  goal.grassBroken += broken;
  goal.seedsFound += Math.max(0, count(bot, 'wheat_seeds') - start);
  return broken;
}

// Beside the plot, on a stand of its own: never on a cell of it.
function standable(bot, s) {
  const g = blockOf(bot, s), a = blockOf(bot, up(s)), b = blockOf(bot, up(s, 2));
  return solid(g) && g.name !== 'farmland' && !!a && !!b && !solid(a) && !solid(b) && !/water|lava/.test(a.name + ' ' + b.name);
}
const onStand = (bot, s) => { const p = bot.entity.position; return Math.floor(p.x) === s.x && Math.floor(p.z) === s.z && Math.abs(p.y - (s.y + 1)) < 1.2; };
async function toStand(bot, task, goal, save, plot, navigate) {
  const here = bot.entity.position;
  const stands = plot.stands.filter(s => standable(bot, s)).sort((a, b) => at(a).distanceTo(here) - at(b).distanceTo(here));
  for (const s of stands) {
    if (onStand(bot, s)) return s;
    if (!navigate) return null;
    goal.step = { action: 'garden_walk', position: up(s) }; save?.();
    try { await navigate(bot, task, new goals.GoalBlock(s.x, s.y + 1, s.z), { timeoutMs: 30000, stallMs: 6000 }); }
    catch (err) { task.check(); if (fatal(err)) throw err; continue; }
    if (onStand(bot, s)) return s;
  }
  return null;
}
const stuck = (plot, c) => { (plot.stuck ||= {})[keyOf(c)] = Date.now() + STUCK_MS; };
async function till(bot, task, goal, save, plot, cells, { dig }) {
  let n = 0;
  for (const c of cells) {
    task.check();
    if (!inReach(bot, c)) continue;
    goal.step = { action: 'garden_till', cell: c }; save?.();
    const over = blockOf(bot, up(c));
    if (over && COVER.test(over.name) && dig) {
      try { await dig(bot, task, at(up(c)), { requireDrops: false }); } catch (err) { task.check(); if (fatal(err)) throw err; }
    }
    const ground = blockOf(bot, c);
    if (!AIR.test(nameOf(bot, up(c)) || '') || !ground || !GROUND.test(ground.name)) { stuck(plot, c); continue; }
    const hoe = hoeCarried(bot);
    if (!hoe) break;
    await bot.equip(hoe, 'hand');
    await bot.lookAt(at(c).offset(0.5, 1, 0.5), true);
    try { await bot.activateBlock(ground, new Vec3(0, 1, 0)); } catch (err) { task.check(); if (fatal(err)) throw err; }
    if (await waitFor(task, () => nameOf(bot, c) === 'farmland', 2500)) n++;
    else stuck(plot, c);
  }
  return n;
}
async function sow(bot, task, goal, save, plot) {
  let n = 0;
  for (const c of plotStatus(bot, plot).bare) {
    task.check();
    const seed = seedFor(bot);
    if (!seed) break;
    if (!inReach(bot, c)) continue;
    goal.step = { action: 'garden_plant', cell: c, item: seed }; save?.();
    const item = items(bot).find(i => i.name === seed);
    if (!item) break;
    await bot.equip(item, 'hand');
    const farmland = blockOf(bot, c);
    if (farmland?.name !== 'farmland' || !AIR.test(nameOf(bot, up(c)) || '')) continue;
    await bot.lookAt(at(c).offset(0.5, 1, 0.5), true);
    try { await bot.placeBlock(farmland, new Vec3(0, 1, 0)); } catch (err) { task.check(); if (fatal(err)) throw err; }
    if (await waitFor(task, () => CROP.test(nameOf(bot, up(c)) || ''), 2500)) { n++; (goal.sown ||= {})[seed] = (goal.sown[seed] || 0) + 1; }
  }
  return n;
}

// One run (work.js, kind 'garden'): -> true, with goal.tilled, goal.planted, goal.seedsFound, goal.grassBroken and
// goal.hoeMade for the line in the log (session.js). Throws when there is no house or no garden to tend after all.
async function gardenStep(bot, task, goal, save, { navigate, dig, collect, openWindow } = {}) {
  goal.tilled ||= 0; goal.planted ||= 0; goal.seedsFound ||= 0; goal.grassBroken ||= 0;
  const me = bot.entity.position, houses = housesAbout(bot, me);
  const house = houses.find(h => h.key === goal.gardenHouse) || houses.filter(h => gapTo(me, h.min, h.max) <= HOUSE_NEAR).sort((a, b) => gapTo(me, a.min, a.max) - gapTo(me, b.min, b.max))[0];
  if (!house) throw new Error('No house about to make a garden by');
  let plot = plotBy(bot, house);
  if (plot && plotStatus(bot, plot).blocked.length >= 4) { forget(bot, plot, 'half of it built on or dug'); plot = null; }
  if (!plot) {
    const site = siteBy(bot, house).site;
    if (!site) throw new Error('No spot by ' + house.name + ' for a garden');
    plot = begin(bot, house, site);
    goal.gardenBegun = true;
  }
  let failed = null;
  try {
    if (plotStatus(bot, plot).untilled.length && !hoeCarried(bot) && hoePlan(bot)) goal.hoeMade = await makeHoe(bot, task, goal, save, plot, { navigate, openWindow });
    let s = plotStatus(bot, plot);
    const want = s.bare.length + (hoeCarried(bot) ? s.untilled.length : 0);
    if (want > seedsCarried(bot) && room(bot, 'wheat_seeds')) await gatherSeeds(bot, task, goal, save, plot, house, want, { navigate, dig, collect });
    if (seedsCarried(bot)) {
      if (!await toStand(bot, task, goal, save, plot, navigate)) throw new Error('No way to stand beside the garden');
      s = plotStatus(bot, plot);
      const tilling = hoeCarried(bot) ? Math.max(0, Math.min(s.untilled.length, seedsCarried(bot) - s.bare.length)) : 0;
      if (tilling) goal.tilled += await till(bot, task, goal, save, plot, s.untilled.slice(0, tilling), { dig });
      goal.planted += await sow(bot, task, goal, save, plot);
    }
  } catch (err) { failed = err; throw err; }
  finally {
    // A run that came to nothing rests the garden, longer each time; one a player ended is not counted.
    if (failed?.name !== 'Cancelled') {
      const did = goal.tilled + goal.planted + goal.seedsFound + (goal.hoeMade ? 1 : 0);
      plot.lastRunAt = new Date().toISOString();
      if (did) { plot.idle = 0; delete plot.restUntil; }
      else { plot.idle = (plot.idle || 0) + 1; plot.restUntil = Date.now() + Math.min(30, 5 * 2 ** (plot.idle - 1)) * 60000; }
    }
    if ((bot._gardens || []).includes(plot)) savePlots(bot);
  }
  save?.();
  return true;
}

module.exports = { gardenDue, gardenStep, housesAbout, searchSite, siteBy, plotStatus, plotsHere, hoePlan, seedsCarried, grassAbout,
  HOUSE_NEAR, PLOT_FROM, PLOT_TO, DOOR_CLEAR, WET, GRASS_MOST, GRASS_FEW, TABLE_NEAR, SOWN, KEEP };
