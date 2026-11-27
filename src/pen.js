'use strict';
// A pen for the herd by a house, the animals chore's (animals.js). Asked for 2026-11-27 ("fence is also great idea"),
// after the herd's place kept by the house still saw the cows graze off between runs on a test copy. Five by five of
// fences round three by three of ground, a gate in the middle of the side nearest the house and another in the side
// across from it:
//   - its place: level natural ground PEN_FROM to PEN_TO out from the house's walls, at its floor's level, clear of its
//     doors, of a garden's plot and the ground about it, of anything built, laid by a player, marked or owed a
//     sapling, two free blocks over every cell, both gates' stands outside on the same level; nearest the herd and with
//     the fewest plants on its fences' line;
//   - its wood: the fences and gates carried, else made at a crafting table standing by it from the planks and logs
//     carried (four planks and two sticks make three fences; two planks and four sticks a gate), else one tree felled
//     whole near the house a run (one with its own leaves about its top, not a player's; tree-felling.js, a sapling
//     planted where it stood). No table set down, nothing fetched;
//   - built from outside: the fences first, from wherever the arm reaches each (work.js place), the gates last, each
//     from its stand, so that it opens along the way through;
//   - the herd brought in (bringIn): one led to the near gate's stand with wheat in hand, the gate opened, the bot walks
//     across to the far gate, opens it and stands in its opening, and the animals following come in after it (an
//     animal follows its food to two and a half blocks off); the near gate is shut behind them from there, the wheat
//     put away, the bot steps out and shuts the far gate: it never walks back past the animals it led in;
//   - kept: a fence or a gate gone is put back, up to REPAIR_MOST of them; more gone than that once it stood, and it was
//     taken down by someone: let go, and none built again by that house for a day.
// The bot's own while it stands: no walk digs through it and nothing takes it for wood (home-base.js jevBuilt asks
// ownAt). Pairs in it are fed over the fence (animals.js). Kept in the bot's state folder beside the garden's.
const fs = require('fs');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');

const SIZE = 5;                             // fences along a side, round SIZE - 2 of ground
const PEN_FROM = 2, PEN_TO = 10;            // its cells this far out from the house's walls, across
const LEVEL = 3;                            // its ground this near the house's floor, up or down
const DOOR_CLEAR = 4;                       // none of its cells this near a door, across
const PLOT_CLEAR = 4;                       // nor this near a garden's middle: its cells, the ground about them, a lane
const HOLDS = 6;                            // animals in it: none led in nor bred past
const REPAIR_MOST = 4;                      // fences and gates gone that are put back; more, and it was taken down
const REFUSED_MS = 24 * 3600000;
const REST_MS = [10, 20, 30].map(m => m * 60000);   // a build run that came to nothing: rested this long, then longer
const TREE_FROM = 6, TREE_TO = 24;          // a tree felled for its wood this far out from the house's walls
const TREE_LEAVES = 6;                      // its own leaves (not a player's, which keep) about its top, at least
const FELL_MOST = 3;                        // trees felled for one pen's wood, at most
const SITE_MS = 5 * 60000, NONE_MS = 10 * 60000;
const TABLE_NEAR = 16;                      // a crafting table this near the pen or the house's middle makes its wood
const MOST_PENS = 8;
const FENCE_WOODS = 'oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped';
const FENCE = new RegExp('^(' + FENCE_WOODS + ')_fence$'), GATE = new RegExp('^(' + FENCE_WOODS + ')_fence_gate$');
const PLANKS = new RegExp('^(' + FENCE_WOODS + ')_planks$');
const LOGS = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$|^(crimson|warped)_stem$/;
const TREE_LOG = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/;
const SOIL = /^(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|moss_block|pale_moss_block|mud)$/;
const GROUND = /^(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|mycelium|moss_block|pale_moss_block|mud|sand|red_sand|gravel|snow_block|clay|stone|andesite|diorite|granite|tuff|calcite)$/;
const AIR = /^(air|cave_air|void_air)$/;
// Plants a fence takes the place of, or that come out at a touch (work.js place); none that hurts an animal.
const SOFT = /^(short_grass|tall_grass|fern|large_fern|dandelion|poppy|blue_orchid|allium|azure_bluet|\w+_tulip|oxeye_daisy|cornflower|lily_of_the_valley|leaf_litter|snow|short_dry_grass|tall_dry_grass|bush|firefly_bush|wildflowers|pink_petals|dead_bush)$/;
const ANIMALS = new Set(['cow', 'mooshroom', 'sheep', 'pig', 'chicken', 'rabbit']);
const SIDES = Object.freeze({ north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] });
const OPPOSITE = Object.freeze({ north: 'south', south: 'north', west: 'east', east: 'west' });

const at = p => new Vec3(p.x, p.y, p.z);
const plain = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const keyOf = p => Math.floor(p.x) + ',' + Math.floor(p.y) + ',' + Math.floor(p.z);
const where = c => '(' + c.x + ', ' + c.y + ', ' + c.z + ')';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fatal = err => ['Cancelled', 'NeedsAir', 'NeedsSafety'].includes(err?.name);
const dimOf = bot => String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '');
const WORLD = bot => dimOf(bot) + ':' + (bot.game?.hashedSeed ?? '');
function blockOf(bot, p) { try { return bot.blockAt(at(p)) || null; } catch (_) { return null; } }
const nameOf = (bot, p) => blockOf(bot, p)?.name || null;
const solid = b => !!b && b.boundingBox === 'block';
const propsOf = b => { try { return b?.getProperties?.() || {}; } catch (_) { return {}; } };
const isOpen = b => { const o = propsOf(b).open; return o === true || o === 'true'; };
const items = bot => (typeof bot?.inventory?.items === 'function' ? bot.inventory.items() : []);
const count = (bot, what) => items(bot).reduce((n, i) => n + ((typeof what === 'string' ? i.name === what : what.test(i.name)) ? i.count : 0), 0);
const gapTo = (p, min, max) => Math.max(min.x - p.x, p.x - max.x, min.z - p.z, p.z - max.z, 0);
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const across = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const eye = bot => bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
const marked = (bot, p) => { try { return !!require('./labels').labelAt(bot, at(p)); } catch (_) { return true; } };
const theirs = (bot, p) => { try { return !!require('./player-build').theirsAt(bot, at(p), null); } catch (_) { return true; } };
const seenLaid = (bot, p) => { try { return !!require('./player-build').seenPlaced(bot, at(p)); } catch (_) { return false; } };
const made = name => { try { return !!require('./built').made(name); } catch (_) { return false; } };
const onCell = (bot, c) => { const p = bot.entity.position; return Math.floor(p.x) === c.x && Math.floor(p.z) === c.z && Math.abs(p.y - c.y) < 1; };
async function waitFor(task, fn, ms, every = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { task?.check?.(); if (fn()) return true; await sleep(every); }
  return !!fn();
}

// ---- its shape: from its corner (the least x and z of its fences, at the fences' level) and its near gate's side
function layout(corner, side) {
  const { x: x0, y, z: z0 } = corner, n = SIZE - 1, mid = n / 2;
  const ring = [];
  for (let dx = 0; dx <= n; dx++) for (let dz = 0; dz <= n; dz++) if (dx === 0 || dz === 0 || dx === n || dz === n) ring.push({ x: x0 + dx, y, z: z0 + dz });
  const gateOn = s => s === 'north' ? { x: x0 + mid, y, z: z0 } : s === 'south' ? { x: x0 + mid, y, z: z0 + n } : s === 'west' ? { x: x0, y, z: z0 + mid } : { x: x0 + n, y, z: z0 + mid };
  const far = OPPOSITE[side], [ix, iz] = SIDES[far];
  const gates = [gateOn(side), gateOn(far)];
  const stands = [{ x: gates[0].x - ix, y, z: gates[0].z - iz }, { x: gates[1].x + ix, y, z: gates[1].z + iz }];
  // The way across from the near gate to the far one: the ground inside, in a line.
  const line = Array.from({ length: n - 1 }, (_, i) => ({ x: gates[0].x + ix * (i + 1), y, z: gates[0].z + iz * (i + 1) }));
  const fences = ring.filter(c => !gates.some(g => g.x === c.x && g.z === c.z));
  return { corner: { x: x0, y, z: z0 }, side, fences, gates, stands, line, centre: { x: x0 + mid, y, z: z0 + mid },
    interior: { min: { x: x0 + 1, y, z: z0 + 1 }, max: { x: x0 + n - 1, y, z: z0 + n - 1 } } };
}
const shapeOf = pen => layout(pen.corner, pen.side);
// Within the ground it holds (a position, the feet's).
const within = (s, p) => !!p && p.x >= s.interior.min.x && p.x < s.interior.max.x + 1 && p.z >= s.interior.min.z && p.z < s.interior.max.z + 1 && Math.abs(p.y - s.interior.min.y) <= 1.5;
// The side of a pen at a corner nearest the house: its near gate's.
function nearSide(corner, house) {
  let best = null;
  for (const side of Object.keys(SIDES)) {
    const g = layout(corner, side).gates[0], d = gapTo(g, house.min, house.max);
    if (!best || d < best.d) best = { side, d };
  }
  return best.side;
}

// ---- the pens kept
const fileOf = bot => bot._penFile !== undefined ? bot._penFile
  : (typeof bot._gardenFile === 'string' && /-garden\.json$/.test(bot._gardenFile) ? bot._gardenFile.replace(/-garden\.json$/, '-pens.json') : null);
const valid = p => !!p && typeof p.world === 'string' && typeof p.house === 'string' && !!p.corner && !!SIDES[p.side];
function load(bot) {
  if (bot._pensLoaded) return;
  bot._pensLoaded = true;
  const f = fileOf(bot);
  if (!f) return;
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (data?.version === 1 && Array.isArray(data.pens)) bot._pens = [...data.pens.filter(valid), ...(bot._pens || [])].slice(-MOST_PENS);
    if (data?.refused && typeof data.refused === 'object') bot._pensRefused = { ...data.refused, ...(bot._pensRefused || {}) };
  } catch (_) { /* none kept yet */ }
}
function saveAll(bot) {
  bot._penCells = null;
  const f = fileOf(bot);
  if (!f) return;
  try { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ version: 1, pens: bot._pens || [], refused: bot._pensRefused || {} }) + '\n'); fs.renameSync(tmp, f); }
  catch (err) { console.log('[pen] not saved: ' + err.message); }
}
function pensHere(bot) { load(bot); bot._pens ||= []; return bot._pens.filter(p => p.world === WORLD(bot)); }
function penBy(bot, house) {
  const here = pensHere(bot);
  return here.find(p => p.house === house.key) || here.find(p => gapTo(shapeOf(p).centre, house.min, house.max) <= PEN_TO + SIZE) || null;
}
const refusedAt = (bot, house) => { load(bot); return (bot._pensRefused || {})[WORLD(bot) + ' ' + house.key] || 0; };
function begin(bot, house, site, kind = null) {
  pensHere(bot);
  const pen = { world: WORLD(bot), house: house.key, houseName: house.name, ...(kind ? { kind } : {}), corner: site.corner, side: site.side, begunAt: new Date().toISOString() };
  bot._pens.push(pen);
  while (bot._pens.length > MOST_PENS) bot._pens.shift();
  saveAll(bot);
  console.log('[pen] begun by ' + house.name + ' at ' + where(shapeOf(pen).centre) + ': its near gate on the ' + site.side + ' side');
  return pen;
}
function letGo(bot, pen, house, why, now = Date.now()) {
  bot._pens = (bot._pens || []).filter(p => p !== pen);
  if (house) (bot._pensRefused ||= {})[WORLD(bot) + ' ' + house.key] = now;
  saveAll(bot);
  console.log('[pen] the pen at ' + where(shapeOf(pen).centre) + ' let go: ' + why + (house ? '; none built by ' + house.name + ' for a day' : ''));
}

// The cells of the pens kept here, by "x,y,z" (asked by every walk's dig).
function cellsOf(bot) {
  const w = WORLD(bot);
  if (bot._penCells?.world === w) return bot._penCells.set;
  const set = new Set();
  for (const pen of pensHere(bot)) { const s = shapeOf(pen); for (const c of [...s.fences, ...s.gates]) set.add(keyOf(c)); }
  bot._penCells = { world: w, set };
  return set;
}
// A fence or a gate of a pen of the bot's own, as it stands there (home-base.js jevBuilt).
function ownAt(bot, p) {
  if (!p || !bot) return false;
  let set;
  try { set = cellsOf(bot); } catch (_) { return false; }
  if (!set.size || !set.has(keyOf(p))) return false;
  const n = nameOf(bot, plain(p)) || '';
  return FENCE.test(n) || GATE.test(n);
}

// What it holds now: fences and gates missing, the gates open or shut, the animals inside, out of the loaded world.
function status(bot, pen) {
  const s = shapeOf(pen), all = [...s.fences, ...s.gates];
  const unloaded = all.some(c => !blockOf(bot, c));
  const missing = s.fences.filter(c => !FENCE.test(nameOf(bot, c) || ''));
  const gates = s.gates.map(c => { const b = blockOf(bot, c); return { cell: c, there: GATE.test(b?.name || ''), open: isOpen(b) }; });
  const inside = Object.values(bot.entities || {}).filter(e => e?.position && e.isValid !== false && ANIMALS.has(e.name) && within(s, e.position));
  return { shape: s, unloaded, missing, gates, gatesMissing: gates.filter(g => !g.there).length, inside,
    built: !unloaded && !missing.length && gates.every(g => g.there) };
}

// ---- its place
function searchSite(bot, house, { plots = [], herdAt = null } = {}) {
  const span = PEN_TO + SIZE + 1, lo = { x: house.min.x - span, z: house.min.z - span }, hi = { x: house.max.x + span, z: house.max.z + span };
  // Each column's ground near the house's floor: its top solid block, two free (air or a plant) over it.
  const kept = new Map();
  const col = (x, z) => {
    const k = x + ',' + z;
    if (kept.has(k)) return kept.get(k);
    let out = null;
    for (let y = house.floor + LEVEL + 1; y >= house.floor - LEVEL - 1; y--) {
      const b = blockOf(bot, { x, y, z });
      if (!b || /^(water|lava)$/.test(b.name)) break;
      if (!solid(b)) continue;
      const a = blockOf(bot, { x, y: y + 1, z }), a2 = blockOf(bot, { x, y: y + 2, z });
      const free = c => !!c && !solid(c) && (AIR.test(c.name) || SOFT.test(c.name));
      if (free(a) && free(a2)) out = { y, ground: b.name, soft: !AIR.test(a.name) };
      break;
    }
    kept.set(k, out);
    return out;
  };
  let claimed = new Set();
  try { claimed = bot.buildRegistry?.claimed?.(dimOf(bot)) || new Set(); } catch (_) { claimed = new Set(); }
  let owed = [];
  try { owed = require('./tree-felling').owedHere(bot).map(s => s.cells[0]).filter(Boolean); } catch (_) { owed = []; }
  const doors = house.doors || [];
  // A column fit for the pen: natural ground, nobody's, nothing made, laid or marked there; its ground's level.
  const fitKept = new Map();
  const fitY = (x, z) => {
    const k = x + ',' + z;
    if (fitKept.has(k)) return fitKept.get(k);
    const c = col(x, z), g = c && { x, y: c.y, z };
    const ok = !!c && GROUND.test(c.ground) && !made(c.ground) && !claimed.has(keyOf(g)) && !claimed.has(keyOf({ x, y: c.y + 1, z })) &&
      !marked(bot, g) && !theirs(bot, g) && !seenLaid(bot, g);
    fitKept.set(k, ok ? c.y : null);
    return ok ? c.y : null;
  };
  let best = null;
  for (let x0 = lo.x; x0 <= hi.x - SIZE + 1; x0++) for (let z0 = lo.z; z0 <= hi.z - SIZE + 1; z0++) {
    const gy = fitY(x0, z0);
    if (gy === null || Math.abs(gy - house.floor) > LEVEL) continue;
    let ok = true, soft = 0, gapMin = Infinity;
    for (let dx = 0; dx < SIZE && ok; dx++) for (let dz = 0; dz < SIZE; dz++) {
      const c = { x: x0 + dx, z: z0 + dz }, g = gapTo(c, house.min, house.max);
      if (fitY(c.x, c.z) !== gy || g < PEN_FROM || doors.some(d => cheb(c, d) < DOOR_CLEAR) || plots.some(p => cheb(c, p.middle) < PLOT_CLEAR) || owed.some(o => cheb(c, o) <= 1)) { ok = false; break; }
      gapMin = Math.min(gapMin, g);
      if ((dx === 0 || dz === 0 || dx === SIZE - 1 || dz === SIZE - 1) && col(c.x, c.z).soft) soft++;
    }
    if (!ok || gapMin > PEN_TO) continue;
    const corner = { x: x0, y: gy + 1, z: z0 }, side = nearSide(corner, house), s = layout(corner, side);
    // Both gates' stands outside: ground at the pen's level, nobody's, not against the house nor on the garden.
    if (!s.stands.every(st => { const c = col(st.x, st.z); return !!c && c.y === gy && gapTo(st, house.min, house.max) >= 1 && !plots.some(p => cheb(st, p.middle) < PLOT_CLEAR - 1) && !theirs(bot, { x: st.x, y: gy, z: st.z }); })) continue;
    const score = Math.abs(gapMin - 4) * 3 + soft + (herdAt ? across(s.centre, herdAt) / 4 : 0);
    if (!best || score < best.score) best = { score, corner, side };
  }
  return best ? { site: { corner: best.corner, side: best.side } }
    : { why: 'no level ground ' + PEN_FROM + ' to ' + PEN_TO + ' out from it, clear of its doors, the garden and anything built' };
}
function siteBy(bot, house, opts = {}, now = Date.now()) {
  const kept = bot._penSites ||= new Map(), hit = kept.get(house.key);
  if (hit && now - hit.at < (hit.site ? SITE_MS : NONE_MS)) return hit;
  let found;
  try { found = searchSite(bot, house, opts); } catch (err) { found = { why: 'the look failed: ' + err.message }; }
  const entry = { at: now, ...found };
  kept.set(house.key, entry);
  const said = bot._penSaid ||= new Set(), line = house.key + ' ' + found.why;
  if (!found.site && !said.has(line)) { said.add(line); console.log('[pen] no pen by ' + house.name + ': ' + found.why); }
  return entry;
}

// ---- its wood
// A crafting table standing near the pen, else near the house's middle (one inside it), that no label keeps shut.
function tableBy(bot, house, centre, now = Date.now()) {
  const kept = bot._penTables ||= new Map(), k = (house?.key || '') + ' ' + keyOf(centre), hit = kept.get(k);
  let p = hit && now - hit.at < SITE_MS ? hit.p : undefined;
  if (p === undefined) {
    p = null;
    const ids = (bot.registry?.blocksArray || []).filter(b => b.name === 'crafting_table').map(b => b.id);
    let labels = null;
    try { labels = require('./labels'); } catch (_) { labels = null; }
    const mid = house && { x: Math.floor((house.min.x + house.max.x) / 2), y: house.floor + 1, z: Math.floor((house.min.z + house.max.z) / 2) };
    for (const from of [centre, mid].filter(Boolean)) {
      let found = [];
      try { found = ids.length && typeof bot.findBlocks === 'function' ? bot.findBlocks({ point: at(from), matching: ids, maxDistance: TABLE_NEAR, count: 8 }) || [] : []; } catch (_) { found = []; }
      const ok = found.map(plain).filter(q => { const b = blockOf(bot, q); try { return b?.name === 'crafting_table' && !labels?.refusesOpen?.(bot, b); } catch (_) { return false; } })
        .sort((a, b) => across(a, centre) - across(b, centre));
      if (ok.length) { p = ok[0]; break; }
    }
    if (kept.size > 32) kept.clear();
    kept.set(k, { at: now, p });
  }
  const b = p && blockOf(bot, p);
  return b?.name === 'crafting_table' ? b : null;
}
// What making the fences and gates still missing wants, against what is carried. -> { fenceCrafts, gateCrafts,
// stickCrafts, planks, have, short, crafts }: planks wanted all told, and short of them counting a log as four.
function woodFor(bot, want) {
  const fences = Math.max(0, want.missing.length - count(bot, FENCE)), gates = Math.max(0, want.gatesMissing - count(bot, GATE));
  const fenceCrafts = Math.ceil(fences / 3), gateCrafts = gates;
  // Sticks made a making at a time (makeWood): two for a fence's making (a stick making of two planks gives four), four
  // for a gate's, less those carried.
  let spare = count(bot, 'stick'), stickCrafts = 0;
  for (const need of [...Array(fenceCrafts).fill(2), ...Array(gateCrafts).fill(4)]) {
    while (spare < need) { stickCrafts++; spare += 4; }
    spare -= need;
  }
  const planks = fenceCrafts * 4 + gateCrafts * 2 + stickCrafts * 2, have = count(bot, PLANKS) + 4 * count(bot, LOGS);
  return { fenceCrafts, gateCrafts, stickCrafts, planks, have, short: Math.max(0, planks - have), crafts: fenceCrafts + gateCrafts };
}
// The kind of planks carried most, with at least n of them.
function planksKind(bot, n) {
  const by = {};
  for (const i of items(bot)) if (PLANKS.test(i.name)) by[i.name] = (by[i.name] || 0) + i.count;
  const best = Object.entries(by).filter(([, c]) => c >= n).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0].replace(/_planks$/, '') : null;
}
// One recipe made n times, in the pockets' grid or at a table through its window; counted by what reached the pockets.
async function craftTimes(bot, task, name, n, table, openWindow) {
  const id = bot.registry?.itemsByName?.[name]?.id;
  if (!n || id === undefined || typeof bot.recipesFor !== 'function') return 0;
  const recipe = bot.recipesFor(id, null, 1, table || null)?.[0];
  if (!recipe) return 0;
  const before = count(bot, name);
  try {
    if (table && openWindow) await openWindow(bot, task, () => bot.craft(recipe, n, table), { block: table, what: 'the crafting table', timeoutMs: 15000 });
    else await bot.craft(recipe, n, table || null);
  } catch (err) { task.check(); if (fatal(err)) throw err; console.log('[pen] no ' + name.replaceAll('_', ' ') + ' made: ' + String(err.message).slice(0, 120)); }
  await waitFor(task, () => count(bot, name) > before, 3000);
  return Math.max(0, count(bot, name) - before);
}
// The fences and the gates missing made at the table by the pen, from the planks and the logs carried. -> made
async function makeWood(bot, task, goal, save, pen, want, { navigate, openWindow, house = null, now = Date.now() } = {}) {
  let plan = woodFor(bot, want);
  if (!plan.crafts) return 0;
  const s = shapeOf(pen), table = tableBy(bot, house, s.centre, now);
  if (!table) return 0;
  const tp = table.position;
  goal.step = { action: 'animals_pen', making: { fences: plan.fenceCrafts * 3, gates: plan.gateCrafts }, table: plain(tp) }; save?.();
  if (eye(bot).distanceTo(at(tp).offset(0.5, 0.5, 0.5)) > 4.3) {
    try { await navigate(bot, task, new goals.GoalNear(tp.x, tp.y, tp.z, 2), { timeoutMs: 30000, stallMs: 6000 }); }
    catch (err) { task.check(); if (fatal(err)) throw err; return 0; }
  }
  // Planks from the logs carried, as many as the making wants, in the pockets' grid.
  for (let round = 0; round < 12 && count(bot, PLANKS) < plan.planks; round++) {
    const log = items(bot).find(i => LOGS.test(i.name));
    if (!log || !await craftTimes(bot, task, log.name.replace(/_(log|stem)$/, '_planks'), Math.min(log.count, Math.ceil((plan.planks - count(bot, PLANKS)) / 4)), null)) break;
  }
  // The fences, then the gates, at the table: one making at a time, its sticks made just before it from two planks, so
  // that wood short of the whole pen goes as far as it will.
  let madeN = 0;
  for (let round = 0; round < 10; round++) {
    task.check();
    const bench = blockOf(bot, tp);
    if (bench?.name !== 'crafting_table') break;
    plan = woodFor(bot, want);
    if (!plan.crafts) break;
    const gate = !plan.fenceCrafts, sticks = gate ? 4 : 2, planks = gate ? 2 : 4;
    if (count(bot, 'stick') < sticks && planksKind(bot, 2)) await craftTimes(bot, task, 'stick', 1, null);
    const kind = planksKind(bot, planks);
    if (!kind || count(bot, 'stick') < sticks) break;
    const got = await craftTimes(bot, task, kind + (gate ? '_fence_gate' : '_fence'), 1, bench, openWindow);
    if (!got) break;
    madeN += got;
  }
  if (madeN) console.log('[pen] ' + madeN + ' fences and gates made at the crafting table at ' + where(tp));
  return madeN;
}

// The trees to fell for the pen's wood: a trunk's foot on soil near the house, TREE_FROM to TREE_TO out from its walls,
// within the reach of the player waited with, with its own leaves about its top (a player's leaves keep), not marked,
// a player's or built. The nearest the pen first. -> [{ log, block, logs, d }]
function treesAbout(bot, house, centre, { player = null, goal = null } = {}) {
  const ids = (bot.registry?.blocksArray || []).filter(b => TREE_LOG.test(b.name)).map(b => b.id);
  if (!ids.length || typeof bot.findBlocks !== 'function') return [];
  let found = [];
  try { found = bot.findBlocks({ point: at(centre), matching: ids, maxDistance: TREE_TO + 12, count: 160 }) || []; } catch (_) { return []; }
  let felling, built;
  try { felling = require('./tree-felling'); built = require('./built'); } catch (_) { return []; }
  const seen = new Set(), out = [];
  for (const p0 of found) {
    const p = plain(p0), b = blockOf(bot, p);
    if (!b || !TREE_LOG.test(b.name) || seen.has(keyOf(p)) || !SOIL.test(nameOf(bot, { x: p.x, y: p.y - 1, z: p.z }) || '')) continue;
    const g = gapTo(p, house.min, house.max);
    if (g < TREE_FROM || g > TREE_TO || Math.abs(p.y - (house.floor + 1)) > 4) continue;
    if (player?.position && across(player.position, p) > 28) continue;
    if (marked(bot, p) || theirs(bot, p) || seenLaid(bot, p)) continue;
    try { if (built.leftAlone(bot, goal, at(p))) continue; } catch (_) { continue; }
    const logs = felling.treeLogs(bot, at(p), { block: b.name, most: 40 });
    for (const l of logs) seen.add(keyOf(l));
    if (logs.length < 3 || logs.length > 30) continue;
    const top = logs[logs.length - 1];
    let leaves = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
      const l = blockOf(bot, { x: top.x + dx, y: top.y + dy, z: top.z + dz });
      if (l && /_leaves$/.test(l.name)) { const k = propsOf(l).persistent; if (!(k === true || k === 'true')) leaves++; }
    }
    if (leaves < TREE_LEAVES) continue;
    out.push({ log: p, block: b.name, logs: logs.length, d: across(p, centre) });
  }
  return out.sort((a, b) => a.d - b.d);
}
const treeFor = (bot, house, centre, opts) => treesAbout(bot, house, centre, opts)[0] || null;
// Enough of them for the planks short, the nearest first (four planks a log), FELL_MOST at most. A pen begun on one tree
// too few stood as a ring of fences with no gates by the house: a four-log oak felled for eighteen planks short.
// -> { trees, logs, enough }
function treesFor(trees, short) {
  const want = Math.ceil(short / 4), out = [];
  let logs = 0;
  for (const t of trees) { if (logs >= want || out.length >= FELL_MOST) break; out.push(t); logs += t.logs; }
  return { trees: out, logs, enough: logs >= want };
}
// The tree felled whole (tree-felling.js: from the ground, and stands for what the arm does not reach, taken back
// after), its logs picked up and a sapling planted where it stood, or owed. -> the logs gained
async function fell(bot, task, goal, save, tree, deps) {
  const felling = require('./tree-felling');
  goal.step = { action: 'animals_pen', felling: tree.log, kind: tree.block }; save?.();
  const logs = felling.treeLogs(bot, at(tree.log), { block: tree.block });
  const stump = felling.stumpOf(bot, logs, tree.block), before = count(bot, LOGS);
  if (eye(bot).distanceTo(at(tree.log).offset(0.5, 0.5, 0.5)) > 4) {
    try { await deps.navigate(bot, task, new goals.GoalNear(tree.log.x, tree.log.y, tree.log.z, 2), { timeoutMs: 20000, stallMs: 5000 }); }
    catch (err) { task.check(); if (fatal(err)) throw err; }
  }
  try { await felling.fellFromStands(bot, task, goal, save, at(tree.log), { ...deps, tree: logs }); }
  catch (err) { task.check(); if (fatal(err)) throw err; console.log('[pen] the ' + tree.block.replaceAll('_', ' ') + ' at ' + where(tree.log) + ': ' + String(err.message).slice(0, 120)); }
  if (stump) {
    felling.noteFelled(bot, tree.block, stump.cells[0]);
    if (!stump.cells.some(c => nameOf(bot, c) === tree.block)) {
      try { await felling.replant(bot, task, stump, deps); } catch (err) { task.check(); if (fatal(err)) throw err; felling.owe(bot, stump); }
    }
  }
  const got = Math.max(0, count(bot, LOGS) - before);
  console.log('[pen] a ' + tree.block.replace(/_log$/, '').replaceAll('_', ' ') + ' tree felled at ' + where(tree.log) + ' for the pen: ' + got + ' logs');
  return got;
}

// ---- built
// The fences missing, the nearest first, each from wherever the arm reaches it; the gates last, each from its stand.
// -> { fences, gates }
async function build(bot, task, goal, save, pen, { place, navigate }) {
  const st = status(bot, pen), s = st.shape;
  goal.step = { action: 'animals_pen', building: s.centre, fences: st.missing.length, gates: st.gatesMissing }; save?.();
  const out = { fences: 0, gates: 0 };
  // An animal standing in a fence's cell (the pen goes up by the herd): the cell tried again after the others, twice,
  // a few seconds apart, for it to have stepped off.
  let todo = st.missing.slice();
  for (let pass = 0; pass < 3 && todo.length; pass++) {
    if (pass) await sleep(3000);
    const later = [];
    while (todo.length) {
      task.check();
      const here = bot.entity.position;
      todo.sort((a, b) => here.distanceTo(at(a).offset(0.5, 0, 0.5)) - here.distanceTo(at(b).offset(0.5, 0, 0.5)));
      const c = todo.shift(), name = items(bot).find(i => FENCE.test(i.name))?.name;
      if (!name) { todo = []; later.length = 0; break; }
      if (FENCE.test(nameOf(bot, c) || '')) continue;
      if (someoneIn(bot, c) && pass < 2) { later.push(c); continue; }
      try { await place(bot, task, at(c), name); } catch (err) {
        task.check(); if (fatal(err)) throw err;
        if (/obstructed/i.test(err.message) && pass < 2) later.push(c);
        else console.log('[pen] no fence put at ' + where(c) + ': ' + String(err.message).slice(0, 120));
      }
      if (FENCE.test(nameOf(bot, c) || '')) out.fences++;
    }
    todo = later;
  }
  for (const [i, g] of st.gates.entries()) {
    if (g.there) continue;
    task.check();
    // The gate chosen again after a miss for want of it: the pockets read just after the other gate went in can still
    // show that one (an acacia gate and an oak one carried, the acacia one put in first: "Need acacia fence gate").
    for (let tries = 0; tries < 2; tries++) {
      const name = items(bot).find(it => GATE.test(it.name))?.name;
      if (!name) break;
      try { await require('./home-base').placeOriented(bot, task, { navigate }, s.stands[i], g.cell, name, () => GATE.test(nameOf(bot, g.cell) || '')); out.gates++; break; }
      catch (err) {
        task.check(); if (fatal(err)) throw err;
        if (!tries && /^Need /.test(err.message)) { await sleep(500); continue; }
        console.log('[pen] no gate put at ' + where(g.cell) + ': ' + String(err.message).slice(0, 120));
        break;
      }
    }
  }
  return out;
}

// Due to be built or put back by a house about: a herd about (the caller's), no pen there standing whole, none let go
// there in a day, a place for it, and its wood: carried, or a tree to fell; with a table by it to make what is not
// carried made. -> { house, pen, site, wood, tree, shape, why } | null
function buildDue(bot, { houses = [], plots = [], player = null, herdAt = null, goal = null, now = Date.now(), onlyBegun = false } = {}) {
  for (const house of houses) {
    if (now - refusedAt(bot, house) < REFUSED_MS) continue;
    const pen = penBy(bot, house), st = pen ? status(bot, pen) : null;
    if (!pen && onlyBegun) continue;
    if (st && (st.unloaded || st.built)) continue;
    if (pen && (pen.restUntil || 0) > now) continue;
    if (pen?.builtAt && st.missing.length + st.gatesMissing > REPAIR_MOST) {
      letGo(bot, pen, house, (st.missing.length + st.gatesMissing) + ' of its fences and gates gone', now);
      continue;
    }
    let site = null;
    if (!pen) { const found = siteBy(bot, house, { plots, herdAt }, now); if (!found.site) continue; site = found.site; }
    const shape = pen ? shapeOf(pen) : layout(site.corner, site.side);
    const want = st || { missing: shape.fences, gatesMissing: shape.gates.length };
    const wood = woodFor(bot, want);
    let table = null;
    try { table = wood.crafts ? tableBy(bot, house, shape.centre, now) : null; } catch (_) { table = null; }
    if (wood.crafts && !table) { noteOnce(bot, house.key + ' table', '[pen] no pen by ' + house.name + ' yet: no crafting table standing by it to make the fences at'); continue; }
    // Wood short: trees of its own near it to cover it. A pen is not begun on wood that does not come to it; one begun
    // takes what trees there are, and waits for the rest (carried, or a tree grown) with none.
    const fell = wood.short ? treesFor(treesKept(bot, house, shape.centre, { player, goal }, now), wood.short) : null, tree = fell?.trees[0] || null;
    if (fell && !tree) { noteOnce(bot, house.key + ' wood', '[pen] ' + (pen ? 'the pen by ' + house.name + ' waits for wood: ' : 'no pen by ' + house.name + ' yet: ') + wood.short + ' planks short and no tree of its own near it to fell'); continue; }
    if (fell && !fell.enough && !pen) { noteOnce(bot, house.key + ' trees', '[pen] no pen by ' + house.name + ' yet: ' + wood.short + ' planks short, and the trees of its own near it hold ' + fell.logs + ' logs'); continue; }
    const n = want.missing.length + want.gatesMissing;
    const why = (pen?.builtAt ? n + ' of the pen\'s fences and gates to put back' : pen ? 'the pen to finish: ' + n + ' fences and gates' : 'a pen to build: ' + n + ' fences and gates') +
      ' by ' + house.name + ' at ' + where(shape.centre) + (wood.crafts ? '; ' + wood.planks + ' planks wanted, ' + wood.have + ' carried' + (tree ? (fell.trees.length > 1 ? ', ' + fell.trees.length + ' trees to fell (' + fell.logs + ' logs), the nearest a ' : ', a ') + tree.block.replace(/_log$/, '').replaceAll('_', ' ') + ' tree at ' + where(tree.log) + (fell.trees.length > 1 ? '' : ' to fell') : '') : '; the fences carried');
    return { house, pen, site, shape, wood, tree, trees: fell?.trees || [], why };
  }
  return null;
}
// treesAbout, looked again every few minutes (asked by every idle look), and the trees kept while they stand.
function treesKept(bot, house, centre, opts, now = Date.now()) {
  const kept = bot._penTrees ||= new Map(), hit = kept.get(house.key);
  if (hit && now - hit.at < SITE_MS && hit.trees.every(t => nameOf(bot, t.log) === t.block)) return hit.trees;
  const trees = treesAbout(bot, house, centre, opts);
  kept.set(house.key, { at: now, trees });
  return trees;
}
function noteOnce(bot, key, line) { const said = bot._penSaid ||= new Set(); if (!said.has(key)) { said.add(key); console.log(line); } }

// A build run: the pen begun (when it was not), its wood (a tree felled when short), made, and put up. -> whether it
// came to anything; goal.penFences, penGates, felled for the log.
async function buildStep(bot, task, goal, save, due, deps, now = Date.now()) {
  let pen = due.pen;
  if (!pen) { pen = begin(bot, due.house, due.site, due.kind); goal.penBegun = true; }
  let st = status(bot, pen), want = { missing: st.missing, gatesMissing: st.gatesMissing };
  let wood = woodFor(bot, want), did = 0;
  if (wood.short) {
    // The trees in turn, the nearest first, till the wood is no longer short (logs cut from a stand can lie on the
    // leaves till they fall: the trees chore picks them up, and the next run has them).
    const trees = due.trees?.length ? due.trees : treesFor(treesAbout(bot, due.house, shapeOf(pen).centre, { goal }), wood.short).trees;
    for (const tree of trees) {
      if (!woodFor(bot, want).short) break;
      if (nameOf(bot, tree.log) !== tree.block) continue;
      const got = await fell(bot, task, goal, save, tree, deps);
      if (got) { goal.felled = (goal.felled || 0) + 1; did += got; }
    }
    wood = woodFor(bot, want);
  }
  if (wood.crafts) did += await makeWood(bot, task, goal, save, pen, want, { ...deps, house: due.house });
  const put = await build(bot, task, goal, save, pen, deps);
  goal.penFences = (goal.penFences || 0) + put.fences; goal.penGates = (goal.penGates || 0) + put.gates;
  did += put.fences + put.gates;
  st = status(bot, pen);
  if (st.built && !pen.builtAt) {
    pen.builtAt = new Date().toISOString(); delete pen.restUntil; delete pen.rests;
    console.log('[pen] built by ' + (pen.houseName || 'the house') + ' at ' + where(st.shape.centre) + ': ' + st.shape.fences.length + ' fences, ' + st.shape.gates.length + ' gates');
  } else if (!did) {
    pen.rests = Math.min((pen.rests || 0) + 1, REST_MS.length);
    pen.restUntil = now + REST_MS[pen.rests - 1];
    console.log('[pen] the pen at ' + where(st.shape.centre) + ' came to nothing this run: rested ' + Math.round(REST_MS[pen.rests - 1] / 60000) + ' minutes');
    if (pen.rests >= REST_MS.length && st.missing.length === st.shape.fences.length && st.gatesMissing === st.shape.gates.length) {
      letGo(bot, pen, due.house, 'nothing of it went up in ' + REST_MS.length + ' runs', now);
      return false;
    }
  } else delete pen.rests;
  saveAll(bot);
  return did > 0;
}

// ---- the gates
// A gate opened or shut (activateBlock toggles it), seen so. -> whether it is so
async function setGate(bot, task, cell, open) {
  const b = blockOf(bot, cell);
  if (!b || !GATE.test(b.name)) return false;
  if (isOpen(b) === open) return true;
  try { await bot.lookAt(at(cell).offset(0.5, 0.5, 0.5), true); await bot.activateBlock(b); }
  catch (err) { task?.check?.(); if (fatal(err)) throw err; }
  return waitFor(task, () => isOpen(blockOf(bot, cell)) === open, 1500, 50);
}
// Walked cell to cell in a line (through an open gate the pathfinder takes for a block), looking at each cell's middle.
// -> whether the bot ends in the last cell
async function walkLine(bot, task, cells, { msEach = 1500 } = {}) {
  try { bot.pathfinder?.setGoal?.(null); } catch (_) { /* none */ }
  try {
    for (const c of cells) {
      const end = Date.now() + msEach;
      while (Date.now() < end) {
        task?.check?.();
        const p = bot.entity.position;
        if (Math.hypot(c.x + 0.5 - p.x, c.z + 0.5 - p.z) <= 0.3) break;
        await bot.lookAt(new Vec3(c.x + 0.5, p.y + (bot.entity.eyeHeight || 1.62), c.z + 0.5), true);
        bot.setControlState('forward', true);
        await sleep(50);
      }
    }
  } finally { bot.setControlState('forward', false); bot.setControlState('sprint', false); }
  await sleep(150);
  return onCell(bot, cells.at(-1));
}
// An animal or a player (not the bot) in a cell: no gate is shut on them.
const someoneIn = (bot, cell) => Object.values(bot.entities || {}).some(e => e?.position && e !== bot.entity && e.isValid !== false && (ANIMALS.has(e.name) || e.type === 'player') &&
  Math.abs(e.position.x - (cell.x + 0.5)) < 0.5 + (e.width || 0.6) / 2 && Math.abs(e.position.z - (cell.z + 0.5)) < 0.5 + (e.width || 0.6) / 2 && Math.abs(e.position.y - cell.y) < 1.5);
// The gates of a pen standing open with nobody in them: left so by a walk cut short, or by a player.
const gatesOpen = (bot, pen) => shapeOf(pen).gates.filter(g => { const b = blockOf(bot, g); return GATE.test(b?.name || '') && isOpen(b) && !someoneIn(bot, g); });
// Those gates shut, each from its stand outside. -> how many
async function shutGates(bot, task, pen, { navigate }) {
  const s = shapeOf(pen);
  let n = 0;
  for (const g of gatesOpen(bot, pen)) {
    task.check();
    const stand = s.stands[s.gates.findIndex(c => c.x === g.x && c.z === g.z)];
    if (eye(bot).distanceTo(at(g).offset(0.5, 0.5, 0.5)) > 4) {
      try { await navigate(bot, task, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeoutMs: 20000, stallMs: 5000 }); }
      catch (err) { task.check(); if (fatal(err)) throw err; continue; }
    }
    if (await setGate(bot, task, g, false)) n++;
  }
  if (n) console.log('[pen] ' + n + (n === 1 ? ' gate' : ' gates') + ' of the pen at ' + where(s.centre) + ' found open, shut');
  return n;
}
const light = { check() {} };
// Out through the far gate and shut after, the near one shut too when open: whatever ended a bringing in, with nothing
// to stop it. -> whether the bot is out
async function leave(bot, pen, walk = walkLine) {
  const s = shapeOf(pen);
  try {
    const on = s.gates.findIndex(g => onCell(bot, g));
    if (on >= 0) await walk(bot, light, [s.stands[on]]);
    else if (within(s, bot.entity.position)) {
      const here = bot.entity.position, d = g => across(here, { x: g.x + 0.5, z: g.z + 0.5 });
      const order = d(s.gates[0]) <= d(s.gates[1]) ? [0, 1] : [1, 0];
      for (const k of order) {
        if (!await setGate(bot, light, s.gates[k], true)) continue;
        if (await walk(bot, light, [k === 0 ? s.line[0] : s.line.at(-1), s.gates[k], s.stands[k]])) break;
      }
      if (within(s, bot.entity.position)) console.log('[pen] still in the pen at ' + where(shapeOf(pen).centre) + ': neither gate let the bot out');
    }
    for (const g of s.gates) if (isOpen(blockOf(bot, g)) && eye(bot).distanceTo(at(g).offset(0.5, 0.5, 0.5)) <= 5 && !someoneIn(bot, g)) await setGate(bot, light, g, false);
  } catch (err) { console.log('[pen] on the way out of the pen: ' + String(err.message).slice(0, 120)); }
  return !within(s, bot.entity.position);
}
// One led in with the wheat (lead: animals.js lead, to the near gate's stand). -> { came, in }: whether it came to the
// gate, and how many more animals the pen holds after.
// The stillness rule (stillness.js) held meanwhile: the lead about the pen and the waits at its gates are over ground
// the bot has stood on, and on the copy (2026-11-27) it was called "45 seconds on animals lead without getting
// anywhere" in the middle of one, the bot taken off it with the far gate open.
const BRING_MS = 150000;
const IN_MS = 12000;                        // the one led waited for this long to come in after the bot
async function bringIn(bot, task, goal, save, pen, e, deps) {
  let release = () => {};
  try { release = require('./stillness').holdWait(bot, 'the herd brought into the pen', BRING_MS); } catch (_) { /* no rule to hold */ }
  try { return await bringInHeld(bot, task, goal, save, pen, e, deps); } finally { release(); }
}
async function bringInHeld(bot, task, goal, save, pen, e, { lead, navigate, walk = walkLine, inMs = IN_MS }) {
  const s = shapeOf(pen);
  // In by the gate nearer the animal, out by the other: "near" and "far" here are the animal's.
  const i = across(e.position, { x: s.stands[0].x + 0.5, z: s.stands[0].z + 0.5 }) <= across(e.position, { x: s.stands[1].x + 0.5, z: s.stands[1].z + 0.5 }) ? 0 : 1;
  const standA = s.stands[i], gateA = s.gates[i], gateB = s.gates[1 - i], line = i === 0 ? s.line : s.line.slice().reverse();
  const foot = s.corner, avoid = (x, z) => x >= foot.x && x < foot.x + SIZE && z >= foot.z && z < foot.z + SIZE;
  const was = status(bot, pen).inside.map(x => x.id), before = was.length;
  goal.step = { action: 'animals_pen_in', kind: e.name, pen: s.centre }; save?.();
  if (!await lead(bot, task, goal, save, e, standA, navigate, { within: 4, avoid })) return { came: false, in: 0 };
  if (!onCell(bot, standA)) {
    try { await navigate(bot, task, new goals.GoalBlock(standA.x, standA.y, standA.z), { timeoutMs: 10000, stallMs: 4000 }); }
    catch (err) { task.check(); if (fatal(err)) throw err; }
  }
  if (!onCell(bot, standA)) { console.log('[pen] the near gate\'s stand at ' + where(standA) + ' not reached'); return { came: true, in: 0 }; }
  const gone = () => e.isValid === false || (bot.entities && !bot.entities[e.id]);
  goal.step = { action: 'animals_pen_in', kind: e.name, pen: s.centre }; save?.();
  let failed = null;
  try {
    if (!await setGate(bot, task, gateA, true)) { console.log('[pen] the gate at ' + where(gateA) + ' would not open'); return { came: true, in: 0 }; }
    // In and across, the far gate opened and stood in, the animals following in after.
    if (!await walk(bot, task, [gateA, ...line])) console.log('[pen] the walk in stopped short at ' + where(plain(bot.entity.position)));
    if (await setGate(bot, task, gateB, true)) await walk(bot, task, [gateB]);
    await waitFor(task, () => gone() || within(s, e.position), inMs);
    await waitFor(task, () => !someoneIn(bot, gateA), 4000);
    await setGate(bot, task, gateA, false);
  } catch (err) { failed = err; throw err; } finally {
    try { if (bot.heldItem) await require('./skills').emptyHand(bot); } catch (_) { /* kept */ }
    await leave(bot, pen, walk);
    // Every gate left open shut from its stand, whatever cut the walk short, but danger: that is the bot's own to
    // answer first.
    if (!['NeedsAir', 'NeedsSafety'].includes(failed?.name)) {
      try { await shutGates(bot, light, pen, { navigate }); } catch (err) { console.log('[pen] the gates not shut after: ' + String(err.message).slice(0, 120)); }
    }
  }
  // One in it before that is out now (the gate stood open for the one led): said; the animals chore leads it back.
  const nowIn = status(bot, pen).inside, after = nowIn.length;
  const out = was.filter(id => bot.entities?.[id] && !nowIn.some(x => x.id === id)).length;
  if (out) console.log('[pen] ' + out + (out === 1 ? ' animal' : ' animals') + ' got out of the pen at ' + where(s.centre) + ' while a ' + e.name + ' was brought in');
  return { came: true, in: Math.max(0, after - before), inside: !gone() && within(s, e.position) };
}

module.exports = { layout, shapeOf, within, searchSite, siteBy, penBy, pensHere, status, ownAt, woodFor, treeFor, treesAbout, treesFor, fell, makeWood, build, buildDue, buildStep,
  setGate, walkLine, leave, bringIn, letGo, begin, tableBy, gatesOpen, shutGates, SIZE, PEN_FROM, PEN_TO, HOLDS, REPAIR_MOST, REFUSED_MS, FENCE, GATE };
