'use strict';
// Building onto what a player has started. Asked for on 2026-11-24: "should be able to leverage things player
// build or extend existing builds", and then, of a new house where the player's own blocks already stand, "try
// to address [it] in some way maybe you can do multiple iterations using llms".
//
// A house asked for from inside a start of one (walls, a floor, a doorway left in them), or "finish my house", is
// drawn by the building model around what stands there. Their blocks go to it in their own local coordinates
// (designer.js, incorporate). Every draft is checked against them cell by cell (checkOnto): one that would leave
// a cell of theirs empty, put a door, a bed or furniture into their wall, or leave part of what they built outside
// it, goes back to the model with those cells named, as a draft that fails validation does (work.js
// DesignRepair), until one keeps them all or three drafts have not. The house is then sited exactly over them
// (designer.js selectSchematicSite keep): their cells leave the plan, so nothing of theirs is dug, replaced or
// noted as the bot's own, and only what is missing is built. Walls with no way in at all get one door through
// them, cut by the bot, or, when the player said not to, left for them to open (build-around.js, a door's place),
// as for a room on their house (add-room.js).
//
// Whose a block is, is read from the block (built.js made(): planks, glass, doors, furniture; cobblestone, which
// open ground does not have) and from what the bot saw a player lay (PlacedLog): dirt, logs and stone look like
// the ground they came from, and a first night's hut is dirt.
const fs = require('fs');
const { Vec3 } = require('vec3');
const { isDoor } = require('./doors');
const { isBed } = require('./build-blocks');

const keyOf = p => `${p.x},${p.y},${p.z}`;
const xyz = k => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; };
const words = name => String(name || 'block').replaceAll('_', ' ');
const dimensionOf = bot => require('./game-progress').dimension(bot) || 'overworld';
const built = () => require('./built');
const at = (bot, p) => { try { return bot.blockAt(p); } catch (_) { return null; } };

// What a block is laid into: nothing, or what it pushes aside.
const OPEN = /^(?:air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|dead_bush|bush|short_dry_grass|tall_dry_grass|leaf_litter|snow|vine|glow_lichen|seagrass|tall_seagrass|fire|soul_fire|bubble_column)$/;
// What the world lays by itself: what grows, falls, forms, freezes or spreads.
const UNLAID = /^(?:ice|frosted_ice|sand|red_sand|gravel|suspicious_sand|suspicious_gravel|pointed_dripstone|moving_piston|piston_head|nether_portal|end_portal|end_gateway|bee_nest|moss_carpet|sculk|sculk_vein|frogspawn|turtle_egg|sniffer_egg|brown_mushroom_block|red_mushroom_block|mushroom_stem|brown_mushroom|red_mushroom|cobweb|powder_snow|nether_wart_block|warped_wart_block|shroomlight)$|_concrete_powder$|anvil$|_(?:bud|cluster)$|_leaves$/;
// Lava meeting water.
const FORMED = /^(?:cobblestone|stone|basalt|obsidian)$/;
// No block open ground has: a player's, wherever it stands.
const COBBLE = /^(?:cobblestone|mossy_cobblestone|cobbled_deepslate)(?:_stairs|_slab|_wall)?$/;
const LOG = /_(?:log|wood)$/;
// A player's reach from where they stand, with room for lag; and how far from the bot a block may be laid by someone
// it cannot see (the server shows players only within about 48 blocks).
const REACH = 7, UNSEEN = 32;
const MOST = 20000, SAVE_MS = 15000;

// The blocks the bot saw players lay, per dimension, kept across restarts: "x,y,z" -> [name, when].
class PlacedLog {
  constructor(file) {
    this.file = file;
    this.dims = new Map();
    this.timer = null;
    if (!file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved?.version === 1) for (const [dim, cells] of Object.entries(saved.dims || {})) this.dims.set(dim, new Map(Object.entries(cells)));
    } catch (_) { /* nothing kept yet */ }
  }
  get(dim, k) { return this.dims.get(dim)?.get(k) || null; }
  note(dim, k, name, when = Date.now()) {
    let cells = this.dims.get(dim);
    if (!cells) this.dims.set(dim, cells = new Map());
    cells.delete(k); cells.set(k, [name, when]);
    while (cells.size > MOST) cells.delete(cells.keys().next().value);
    this.dirty();
  }
  drop(dim, k) { if (this.dims.get(dim)?.delete(k)) this.dirty(); }
  dirty() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.save(); }, SAVE_MS);
    this.timer.unref?.();
  }
  save() {
    if (!this.file) return;
    const body = JSON.stringify({ version: 1, dims: Object.fromEntries([...this.dims].map(([dim, cells]) => [dim, Object.fromEntries(cells)])) });
    try { fs.writeFileSync(`${this.file}.tmp`, body); fs.renameSync(`${this.file}.tmp`, this.file); } catch (_) { /* kept in memory */ }
  }
}

const near = (a, b, r) => Math.abs(a.x - b.x) <= r && Math.abs(a.y - b.y) <= r && Math.abs(a.z - b.z) <= r;
// A tree grown from a sapling lays its logs with its leaves, which no player lays unasked as they grow.
function treeGrew(bot, now, when) {
  if (!/_leaves$/.test(now?.name || '')) return;
  const persistent = now.getProperties?.()?.persistent;
  if (persistent === true || persistent === 'true') return;
  bot._treeGrew = { p: now.position, when };
  const recent = (bot._placedLogs || []).filter(l => when - l.when < 3000);
  for (const l of recent) if (near(l.p, now.position, 6)) bot.placedLog?.drop(dimensionOf(bot), l.k);
  bot._placedLogs = recent;
}
const grewNear = (bot, p, when) => !!bot._treeGrew && when - bot._treeGrew.when < 3000 && near(bot._treeGrew.p, p, 6);

// Laid by a player: one stands within reach of it, or it is too far from the bot for whoever laid it to be seen. Not
// with an enderman beside it: they carry blocks about.
function byPlayer(bot, p) {
  const cx = p.x + 0.5, cy = p.y + 0.5, cz = p.z + 0.5;
  const reach = q => Math.hypot(q.x - cx, q.y + 1.62 - cy, q.z - cz);
  if (Object.values(bot.entities || {}).some(e => e?.name === 'enderman' && e.position && reach(e.position) <= 5)) return false;
  for (const [name, player] of Object.entries(bot.players || {})) {
    const q = player?.entity?.position;
    if (name !== bot.username && q && reach(q) <= REACH) return true;
  }
  const me = bot.entity?.position;
  return !!me && reach(me) > UNSEEN;
}

function notePlaced(bot, was, now, when = Date.now()) {
  const log = bot.placedLog, p = now?.position || was?.position;
  if (!log || !p) return;
  const dim = dimensionOf(bot), k = keyOf(p), name = now?.name;
  // Broken, burnt or flowed over: no longer anyone's.
  if (!name || OPEN.test(name)) { log.drop(dim, k); return; }
  const held = log.get(dim, k);
  // Theirs still as it changes: grass over their dirt, a door opened, a stair turning a corner.
  if (held) { if (held[0] !== name) log.note(dim, k, name, held[1]); return; }
  if (!was || !OPEN.test(was.name) || UNLAID.test(name) || built().grows(name)) { treeGrew(bot, now, when); return; }
  if (/^(?:water|lava)$/.test(was.name) && FORMED.test(name)) return;
  // The bot's own: noted as laid, the other half of a door or bed it has just put down, or the server correcting the
  // bot's view of a cell (server-truth.js), which lays nothing.
  if (require('./own-blocks').laidAt(bot, p) || ownHalf(bot, k, name, when) || (bot._viewFixes?.keys.has(k) && when < bot._viewFixes.until)) return;
  if (LOG.test(name) && grewNear(bot, p, when)) return;
  if (!byPlayer(bot, p)) return;
  log.note(dim, k, name, when);
  if (LOG.test(name)) {
    bot._placedLogs = (bot._placedLogs || []).filter(l => when - l.when < 5000);
    bot._placedLogs.push({ k, p: { x: p.x, y: p.y, z: p.z }, when });
  }
}

// The other half of a door, a bed or a tall flower at block: the cells the game fills with it.
function halvesOf(block) {
  const p = block.position, props = block.getProperties?.() || {}, at = (dx, dy, dz) => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
  if (/_door$|^(?:sunflower|lilac|rose_bush|peony|pitcher_plant|tall_grass|large_fern|tall_seagrass)$/.test(block.name)) return [at(0, props.half === 'upper' ? -1 : 1, 0)];
  const d = /_bed$/.test(block.name) && { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[props.facing];
  if (!d) return [];
  const s = props.part === 'head' ? -1 : 1;
  return [at(s * d[0], 0, s * d[1])];
}
const ownHalf = (bot, k, name, when) => (bot._justPlaced || []).some(j => when - j.when < 2000 && j.name === name && j.halves.includes(k));

// The bot's own placement, as the game answered it (mineflayer's blockPlaced) or as the bot noted it (own-blocks.js
// noteLaid): never a player's, nor is the other half of it (a door's top, a bed's head), whichever change came first.
function dropPlaced(bot, block) {
  const log = bot?.placedLog, p = block?.position;
  if (!log || !p) return;
  const dim = dimensionOf(bot), when = Date.now();
  log.drop(dim, keyOf(p));
  const halves = halvesOf(block).map(keyOf);
  for (const k of halves) if (log.get(dim, k)?.[0] === block.name) log.drop(dim, k);
  bot._justPlaced = [...(bot._justPlaced || []).filter(j => when - j.when < 2000), { halves, name: block.name, when }];
}

function placedPlugin(bot) {
  if (bot._placedWatched) return;
  bot._placedWatched = true;
  bot.on?.('blockUpdate', (was, now) => { try { notePlaced(bot, was, now); } catch (_) { /* a change missed */ } });
  // The bot's own, as the game answered its placement: never a player's.
  bot.on?.('blockPlaced', (_was, now) => { try { dropPlaced(bot, now); } catch (_) { /* as above */ } });
}

// The bot saw a player lay the block at p: [name, when], or null.
function seenPlaced(bot, p) {
  const log = bot?.placedLog;
  if (!log || !p) return null;
  return log.get(dimensionOf(bot), keyOf({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }));
}

// Where a start is looked for, round where the player stood, and how much of it there may be.
const BOX = { radius: 10, below: 2, above: 10 };
const MOST_CELLS = 900, SPAN = [20, 12, 20], FEWEST = 6, WALLS = 8;
// The ground's own kinds a start may be built of too: taken in only beside what is plainly theirs, above where
// the player stood and open on a side, as a wall is.
const GROUNDLIKE = /^(?:dirt|coarse_dirt|rooted_dirt|mud|packed_mud|stone|deepslate|granite|diorite|andesite|tuff|calcite|sandstone|red_sandstone|terracotta|clay|moss_block|snow_block)$|_terracotta$|_(?:log|wood)$/;
// Small things a cell can be walked through with: the drawing may leave such a cell of theirs empty.
const SOFT = /(?:^|_)(?:torch|carpet|button|lever|sign|pressure_plate|lantern|candle|flower_pot|rail|banner|tripwire_hook|ladder|tulip|petals|sapling)$|^(?:redstone_wire|tripwire|string|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|sunflower|lilac|rose_bush|peony|pitcher_plant|open_eyeblossom|closed_eyeblossom|wildflowers|cactus_flower|sweet_berry_bush|azalea|flowering_azalea)$/;
const THING = /^(?:chest|trapped_chest|barrel|crafting_table|furnace|smoker|blast_furnace|loom|stonecutter|grindstone|smithing_table|fletching_table|cartography_table|lectern|composter|cauldron|enchanting_table|brewing_stand|bookshelf|chiseled_bookshelf|jukebox|note_block|bell|beehive|decorated_pot|ender_chest|crafter)$|shulker_box$/;
const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function kindOf(block) {
  const n = block.name;
  if (/_door$/.test(n)) return 'door';
  if (/_bed$/.test(n)) return 'bed';
  if (/glass|_pane$|^iron_bars$/.test(n)) return 'glass';
  if (SOFT.test(n)) return 'soft';
  if (THING.test(n)) return 'thing';
  return require('./any-material').fills(block) ? 'full' : 'other';
}
// The cell as the designer's schematic gives it; a door's top and a bed's head are the region of their other half.
function shapeOf(block) {
  const p = block.getProperties?.() || {}, n = block.name;
  if (/_door$/.test(n)) return { properties: { facing: p.facing, half: null }, upper: p.half === 'upper' };
  if (/_bed$/.test(n)) return { properties: { facing: p.facing, half: null }, upper: p.part === 'head' };
  if (/_stairs$/.test(n)) return { properties: { facing: p.facing, half: p.half } };
  if (/_slab$/.test(n)) return { properties: { facing: null, half: p.type === 'top' ? 'top' : 'bottom' } };
  if (p.facing && /^(?:chest|trapped_chest|barrel|furnace|smoker|blast_furnace|loom|stonecutter)$/.test(n)) return { properties: { facing: p.facing, half: null } };
  return { properties: null };
}

// A player's block at p, not the ground's and not the bot's own: the block, or null.
function theirs(bot, p, claimed) {
  const b = at(bot, p);
  if (!b || OPEN.test(b.name) || /_leaves$/.test(b.name) || built().grows(b.name)) return null;
  if (claimed.has(keyOf(p)) || require('./own-blocks').laidAt(bot, p)) return null;
  return seenPlaced(bot, p) || built().made(b.name) || COBBLE.test(b.name) ? b : null;
}
const leavesNear = (bot, p) => {
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
    if (/_leaves$/.test(at(bot, p.offset(dx, dy, dz))?.name || '')) return true;
  }
  return false;
};
function bounds(cells) {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const c of cells) for (const a of ['x', 'y', 'z']) { if (c[a] < min[a]) min[a] = c[a]; if (c[a] > max[a]) max[a] = c[a]; }
  return { min, max };
}

// No way out from where the player stood: their walls all round, no gap two high to walk out through.
function shut(bot, a, min, max) {
  const open = p => { const b = at(bot, p); return !!b && (b.boundingBox === 'empty' || /_door$|_fence_gate$|_trapdoor$/.test(b.name)); };
  const stand = p => open(p) && open(p.offset(0, 1, 0)) && !open(p.offset(0, -1, 0));
  const start = [a, a.offset(0, 1, 0), a.offset(0, -1, 0)].find(stand);
  if (!start) return false;
  const seen = new Set([keyOf(start)]), queue = [start];
  for (let i = 0; i < queue.length; i++) {
    if (queue.length > 4000) return false;
    const p = queue[i];
    if (p.x <= min.x - 1 || p.x >= max.x + 1 || p.z <= min.z - 1 || p.z >= max.z + 1) return false;
    for (const [dx, dz] of SIDES) for (const dy of [0, 1, -1]) {
      const q = p.offset(dx, dy, dz), k = keyOf(q);
      if (seen.has(k) || q.y < min.y - 2 || q.y > max.y + 2 || !stand(q) || (dy === 1 && !open(p.offset(0, 2, 0)))) continue;
      seen.add(k); queue.push(q);
    }
  }
  return true;
}

// "46 cobblestone", "24 cobblestone, 6 oak planks and 1 oak door".
function said(cells) {
  const counts = new Map();
  for (const c of cells) if (!c.upper) counts.set(c.name, (counts.get(c.name) || 0) + 1);
  const parts = [...counts].sort((p, q) => q[1] - p[1]).map(([n, c]) => `${c} ${words(n)}`);
  const shown = parts.slice(0, 3), rest = parts.length - shown.length;
  if (rest) shown.push(`${rest} more kind${rest === 1 ? '' : 's'}`);
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

// Their blocks as the designer reads a schematic, in their own local coordinates.
function drawingOf(start, cells) {
  const { origin, size } = start, regions = [];
  for (const c of cells.filter(c => !c.upper).sort((p, q) => p.y - q.y || p.z - q.z || p.x - q.x)) {
    const local = [c.x - origin.x, c.y - origin.y, c.z - origin.z], prior = regions.at(-1);
    if (prior && prior.block === c.name && prior.to[0] === local[0] - 1 && prior.to[1] === local[1] && prior.to[2] === local[2] &&
      JSON.stringify(prior.properties) === JSON.stringify(c.properties)) prior.to[0] = local[0];
    else regions.push({ from: local, to: [...local], block: c.name, properties: c.properties || null });
  }
  return { name: 'what a player has begun here', description: `${start.said}, laid by a player; every block of it stays as it is`,
    size: [...size], palette: [...new Set(regions.map(r => r.block))], regions, entrance: null, ...(start.closed && { noWayIn: true }),
    ...(Number.isFinite(start.groundY) && { groundY: start.groundY }) };
}

// The top of the ground just outside their blocks, in their coordinates (-1: their lowest blocks stand on it): the
// commonest of the columns round them, for the drawing to lay its floor level with it (designer.js, incorporate.groundY).
// Terra's first drawing round a ring of walls on grass, on 2026-11-24, put the walls' foot at its floor's level: the
// floor a block above the ground, and the door a step too high to walk in.
function groundOf(bot, found, min, max) {
  const tally = new Map();
  for (let x = min.x - 1; x <= max.x + 1; x++) for (let z = min.z - 1; z <= max.z + 1; z++) {
    if (x >= min.x && x <= max.x && z >= min.z && z <= max.z) continue;
    for (let y = max.y + 1; y >= min.y - 4; y--) {
      const p = new Vec3(x, y, z), b = at(bot, p);
      if (!b || found.has(keyOf(p)) || b.boundingBox !== 'block') continue;
      if (OPEN.test(at(bot, p.offset(0, 1, 0))?.name || '-')) tally.set(y - min.y, (tally.get(y - min.y) || 0) + 1);
      break;
    }
  }
  return [...tally].sort((p, q) => q[1] - p[1])[0]?.[0];
}

// The start of a building a player stands at, from their blocks round where they stood (anchor):
// { origin, size, cells: [{ x, y, z, name, kind, upper? }], said, unfinished, inside, closed, walls, farm, source }
// in world coordinates; { tooBig } when there is more of it than a house is planned round; null for none.
function startedAt(bot, anchor) {
  if (!anchor || typeof bot?.blockAt !== 'function') return null;
  const a = new Vec3(Math.floor(anchor.x), Math.floor(anchor.y), Math.floor(anchor.z));
  const claimed = bot.buildRegistry?.claimed?.(dimensionOf(bot)) || new Set();
  const inBox = p => Math.abs(p.x - a.x) <= BOX.radius && Math.abs(p.z - a.z) <= BOX.radius && p.y >= a.y - BOX.below && p.y <= a.y + BOX.above;
  const found = new Map(), queue = [];
  const take = p => {
    const k = keyOf(p);
    if (found.has(k) || !inBox(p)) return;
    const b = theirs(bot, p, claimed);
    if (b) { found.set(k, b); queue.push(p); }
  };
  // Begun beside the player: theirs within three of where they stood, and all of it that joins that.
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 3; dy++) take(a.offset(dx, dy, dz));
  if (!queue.length) return null;
  for (let i = 0; i < queue.length && found.size <= MOST_CELLS; i++) {
    const p = queue[i];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) take(p.offset(dx, dy, dz));
  }
  // Their dirt or logs not seen laid, joined to what is plainly theirs and within its bounds: kept, whoever laid them.
  // The ground's own beside it (a hillside, a rise outside their walls) is not theirs.
  const box = bounds([...found.keys()].map(xyz));
  for (let round = 0; round < 4 && found.size <= MOST_CELLS; round++) {
    let more = 0;
    for (const k of [...found.keys()]) {
      const p = xyz(k);
      for (const [dx, dy, dz] of SIX) {
        const q = new Vec3(p.x + dx, p.y + dy, p.z + dz), qk = keyOf(q);
        if (found.has(qk) || !inBox(q) || q.y < a.y || q.y > box.max.y || q.x < box.min.x || q.x > box.max.x || q.z < box.min.z || q.z > box.max.z) continue;
        const b = at(bot, q);
        if (!b || !GROUNDLIKE.test(b.name) || claimed.has(qk) || require('./own-blocks').laidAt(bot, q)) continue;
        if (!SIDES.some(([sx, sz]) => OPEN.test(at(bot, q.offset(sx, 0, sz))?.name || '-'))) continue;
        if (LOG.test(b.name) && leavesNear(bot, q)) continue;
        found.set(qk, b); more++;
      }
    }
    if (!more) break;
  }
  if (found.size > MOST_CELLS) return { tooBig: true };
  const cells = [...found].map(([k, b]) => ({ ...xyz(k), name: b.name, kind: kindOf(b), ...shapeOf(b) }));
  const { min, max } = bounds(cells), size = [max.x - min.x + 1, max.y - min.y + 1, max.z - min.z + 1];
  if (size.some((n, i) => n > SPAN[i])) return { tooBig: true, size };
  if (cells.filter(c => !c.upper).length < FEWEST) return null;
  // Unfinished: no roof over most of what it stands round.
  const over = new Set(cells.filter(c => c.y >= min.y + 2).map(c => c.x + ',' + c.z));
  let inner = 0, roofed = 0, farm = false;
  for (let x = min.x + 1; x < max.x; x++) for (let z = min.z + 1; z < max.z; z++) {
    inner++;
    if (over.has(x + ',' + z)) roofed++;
    for (let y = min.y - 1; y <= min.y + 1 && !farm; y++) farm = at(bot, new Vec3(x, y, z))?.name === 'farmland';
  }
  const inside = a.x > min.x && a.x < max.x && a.z > min.z && a.z < max.z;
  // What their walls are mostly made of, for new walls of any blocks to match (any-material.js).
  const kinds = new Map();
  for (const c of cells) if (c.kind === 'full') kinds.set(c.name, (kinds.get(c.name) || 0) + 1);
  const main = [...kinds].sort((p, q) => q[1] - p[1])[0]?.[0] || null;
  const start = { origin: { ...min }, size, said: said(cells), main, unfinished: !inner || roofed / inner < 0.5, inside, farm, groundY: groundOf(bot, found, min, max),
    walls: cells.filter(c => c.kind === 'full' && c.y >= a.y).length, closed: inside && shut(bot, a, min, max),
    cells: cells.map(({ x, y, z, name, kind, upper }) => ({ x, y, z, name, kind, ...(upper && { upper }) })) };
  start.source = drawingOf(start, cells);
  return start;
}

// Asked for outright, or only to be read so: a house asked for from inside an unfinished start of walls.
const meant = (start, asked) => !!start && !start.tooBig && (asked || (start.inside && start.unfinished && !start.farm && start.walls >= WALLS));

// A block of the design's that stands as a plain wall, floor or roof.
const UNPLAIN = /glass|_pane$|torch|lantern|ladder|_door$|_bed$|chest|barrel|furnace|smoker|_table$|loom|stonecutter|lectern|carpet/;
const plain = c => !!c && !c.companion && !(c.properties && Object.keys(c.properties).length) && !UNPLAIN.test(c.material);
const usable = c => isDoor(c.material) || isBed(c.material) || SOFT.test(c.material) || THING.test(c.material);
function fits(kind, name, mine) {
  if (kind === 'full') return plain(mine);
  if (kind === 'door') return !!mine && isDoor(mine.material);
  if (kind === 'bed') return !!mine && isBed(mine.material);
  if (kind === 'soft') return !mine || mine.material === name || SOFT.test(mine.material);
  if (kind === 'thing') return !!mine && !isDoor(mine.material) && !isBed(mine.material) && !SOFT.test(mine.material);
  // Glass, stairs, a slab, a fence: anything standing there.
  return !!mine && (mine.material === name || !usable(mine));
}

// Whether a validated design keeps the player's start (startedAt): -> { kept, doorway } (doorway: the cells of
// theirs the one door through walls with no way in goes in, theirs to open), or throws what to change, for the
// designer to read.
function checkOnto(design, start) {
  const offset = design.existingOffset;
  if (!offset) throw new Error('existingOffset is null: set it to where the [0,0,0] of incorporate sits in your drawing, because the building goes around the blocks a player already has there');
  const [w, h, d] = design.source.size, mine = new Map(design.blocks.map(c => [keyOf(c), c]));
  const wrong = [], cut = [];
  for (const c of start.cells) {
    const q = { x: c.x - start.origin.x + offset[0], y: c.y - start.origin.y + offset[1], z: c.z - start.origin.z + offset[2] };
    if (q.x < 0 || q.y < 0 || q.z < 0 || q.x >= w || q.y >= h || q.z >= d) { wrong.push({ c, q, outside: true }); continue; }
    const cell = mine.get(keyOf(q));
    if (fits(c.kind, c.name, cell)) continue;
    if (start.closed && c.kind === 'full' && cell && isDoor(cell.material)) { cut.push({ c, q, cell }); continue; }
    wrong.push({ c, q, cell });
  }
  const doors = cut.filter(({ cell }) => !cell.companion).length;
  if (doors > 1) wrong.push(...cut.splice(0));
  if (!wrong.length) return { kept: start.cells.length - cut.length, doorway: cut.map(({ c }) => ({ x: c.x, y: c.y, z: c.z })) };
  const shown = wrong.slice(0, 8).map(({ c, q, cell, outside }) => `[${q.x},${q.y},${q.z}] is their ${words(c.name)}${outside ? ', outside your size'
    : `, and your drawing ${cell ? `puts ${cell.companion ? 'the top of ' : ''}${words(cell.material)} there` : 'leaves it empty'}`}`);
  const more = wrong.length > shown.length ? `; and ${wrong.length - shown.length} more` : '';
  throw new Error(`it does not keep what the player has built: with existingOffset [${offset.join(',')}], ${wrong.length} of their ${start.cells.length} blocks ${wrong.length === 1 ? 'is' : 'are'} not kept (${shown.join('; ')}${more}). ` +
    'Their blocks stay exactly where they are: in your drawing give each of their cells a full block where theirs is a full block, the same door, bed or glass where theirs is one, and any block where theirs is stairs, a slab, a fence or furniture; ' +
    `put your new doors, windows, beds, torches and furniture only in cells they left empty${start.closed ? ', apart from exactly one door through their wall, as there is no way in' : ''}; and keep all of what they built inside your size`);
}

// For the starter house's own check (starter-house.js checkStarterDesign): the start it is drawn round.
const around = start => ({ size: start.size, blocks: start.cells.length });
// Their cells, to be kept as they stand, less the doorway through them (cut by the bot, or opened by the player).
function keepOf(start, doorway = []) {
  const opened = new Set(doorway.map(keyOf));
  return new Set(start.cells.map(keyOf).filter(k => !opened.has(k)));
}

// "finish my house", "help me finish the hut we started", "build a house on my walls", "use my walls",
// "put a roof on my hut": a start of the speaker's to build onto. -> an intent, or null.
const HOUSES = 'house|home|hut|cabin|cottage|shelter|base';
const ADJECTIVES = /\b(?:small|big|little|new|nice|cozy|simple|whole)\b/g;
function materialOf(what, registry) {
  const w = String(what || '').replace(ADJECTIVES, '').trim();
  if (!w) return { anyMaterial: true };
  if (/^(?:wood|wooden|plank|planks)$/.test(w)) return {};
  const wood = Object.keys(registry.itemsByName).filter(n => n.endsWith('_planks')).map(n => n.slice(0, -7))
    .find(x => w.replace(/[ _-]+/g, '_').replace(/_(?:plank|planks|wood|wooden)$/, '') === x);
  if (wood) return { material: wood + '_planks' };
  if (['cobblestone', 'stone', 'sandstone', 'bricks', 'dirt'].includes(w)) return { material: w };
  return null;
}
function ontoRequest(text, registry) {
  const help = '^(?:help (?:me|us) (?:to )?)?', what = '(?:(\\w+(?: \\w+)?) )?';
  const finish = new RegExp(`${help}(?:finish|complete)(?: building)? (?:my|our) ${what}(?:${HOUSES})$`).exec(text) ||
    new RegExp(`${help}(?:finish|complete)(?: building)? (?:the|this|that) ${what}(?:${HOUSES}) (?:i|we) (?:started|began|built|made)$`).exec(text) ||
    new RegExp(`${help}(?:build|make) (?:me |us )?(?:a |an )?${what}(?:${HOUSES}) (?:on|onto|with|around|using|from|out of|over) (?:my|our|these|those) (?:walls?|blocks?|floor|foundation|platform|start)(?: (?:i|we) (?:built|started|made|placed|put up))?$`).exec(text) ||
    /^(?:finish|complete) what (?:i|we) (?:started|began|built)()$/.exec(text) ||
    new RegExp(`^use (?:my|our|these|those) walls?()(?: (?:for|to build|to make) (?:a |an |the )?(?:${HOUSES}))?$`).exec(text);
  const roof = !finish && new RegExp(`^(?:add|put|build|make) (?:a |the )?${what}roof (?:on|onto|to|over|for) (?:my|our) (?:\\w+ )?(?:${HOUSES}|walls?)$`).exec(text);
  const hit = finish || roof;
  if (!hit) return null;
  const made = materialOf(hit[1], registry);
  if (!made) return null;
  return roof ? { onto: 'asked', ontoWhat: 'roof', ...made } : { starterBeds: 2, onto: 'asked', ...made };
}

// "...but don't cut my walls", "I'll make the door myself", "Jev, don't cut my wall": a doorway through the player's
// wall is theirs to open. Otherwise the bot cuts it (asked for on 2026-11-24: "jev may cut it unless i ask to not do
// it"), here and for a room on their house (add-room.js).
const THEIR_WALLS = '(?:my|our|the|their|these|those) walls?';
const LEAVE = "(?:(?:don['’]?t|do not) (?:cut|break|dig|knock|open|damage|touch|make a hole in)(?: through| down| into)? " + THEIR_WALLS +
  '|without (?:cutting|breaking|digging|knocking|opening|damaging|touching)(?: through| down| into)? ' + THEIR_WALLS +
  '|leave ' + THEIR_WALLS + "(?: alone| be| as they are)?|(?:i['’]?ll|i will|let me) (?:make|open|cut|break|do|dig) (?:the |a )?(?:door(?:way)?|way in|hole|opening)(?: myself)?)";
const LEAVE_WALLS_CLAUSE = new RegExp(',? (?:but |and )?(?:please )?' + LEAVE);
const LEAVE_WALLS = new RegExp('^(?:(?:please|no|ok|okay|wait|hey|actually)[, ]+)*' + LEAVE + '(?:,? please)?[.!]*$');
const keepWallsRequest = text => LEAVE_WALLS.test(String(text || '').toLowerCase().trim());

// "Jev, don't cut my wall" with the work in hand -> what to say. Before the site is chosen the word is kept for it;
// after, the doorway's cells (blueprint.cut) are no longer the plan's to clear, and the player is asked to open them
// (build-around.js, a door's place), as when it was said with the request.
function leaveDoorway(bot, goal) {
  const inHand = !!goal && goal.kind === 'build' && !['complete', 'failed', 'cancelled'].includes(goal.status);
  if (!inHand) return "There's no doorway of yours I'm about to cut. Say it with the request, like \"finish my house but don't cut my walls\", and I'll leave it to you.";
  const bp = goal.blueprint;
  if (!bp) { goal.keepWalls = true; return "All right, I won't cut through your walls for this one. If it needs a doorway, I'll leave it to you."; }
  if (!bp.cut?.length) return "There's no doorway of yours I'm about to cut.";
  goal.keepWalls = true;
  // No longer the plan's to clear, whatever is seen of it now; and a doorway out of sight (not loaded) is taken as standing.
  for (const p of bp.cut) { delete bp.initialBlocks?.[keyOf(p)]; delete bp.initialNames?.[keyOf(p)]; }
  const standing = bp.cut.filter(p => { const b = at(bot, new Vec3(p.x, p.y, p.z)); return !b || (!OPEN.test(b.name) && !isDoor(b.name)); });
  if (!standing.length) return "I've already cut the doorway, sorry. The rest of your walls stay as they are.";
  const low = standing.reduce((a, b) => (a.y <= b.y ? a : b));
  return "All right, I won't cut your wall. Break the block" + (standing.length > 1 ? 's' : '') + ' at ' + low.x + ', ' + low.y + ', ' + low.z + " when you're ready, and I'll put the door in.";
}

module.exports = { keepWallsRequest, leaveDoorway, LEAVE_WALLS_CLAUSE, PlacedLog, placedPlugin, notePlaced, dropPlaced, seenPlaced, startedAt, meant, checkOnto, around, keepOf, ontoRequest, kindOf };
