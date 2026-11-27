'use strict';
// Trees taken down whole, a stand laid for the logs out of reach and taken back after, and a sapling put back where
// the trunk stood (asked for in play). A log more than an arm's reach over the ground was left where it stood: the stand
// search looks beside a log, from one under it to three over, and under a tall tree's top there is no such stand. On a
// savanna's acacias the bot cut the lower logs of tree after tree, gave each top up ('No reachable dry standing
// position', some twenty times in eight minutes) and walked on to the next tree. The player watching asked for each
// tree to come down whole, so that its leaves fall, with blocks laid to stand on for the high logs and taken back after,
// and for the tree to be planted again.
const fs = require('fs');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');

const LOG = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/;
const SAPLING = Object.freeze({ oak_log: 'oak_sapling', spruce_log: 'spruce_sapling', birch_log: 'birch_sapling', jungle_log: 'jungle_sapling',
  acacia_log: 'acacia_sapling', dark_oak_log: 'dark_oak_sapling', cherry_log: 'cherry_sapling', pale_oak_log: 'pale_oak_sapling', mangrove_log: 'mangrove_propagule' });
// These grow only from four in a square.
const FOUR = new Set(['dark_oak_sapling', 'pale_oak_sapling']);
// Not farmland: a player's field is not a place for a tree.
const SOIL = /^(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|moss_block|pale_moss_block|mud|muddy_mangrove_roots)$/;
const LEAVES = /_leaves$/;
const AIR = /^(air|cave_air|void_air)$/;
// Plants a block laid there takes the place of, as the game has it.
const COVER = /^(short_grass|tall_grass|fern|large_fern|dead_bush|short_dry_grass|tall_dry_grass|leaf_litter|bush|firefly_bush|snow)$/;
const LIQUID = /water|lava|bubble_column/;
// The blocks a stand is laid of: those the climb lays (pillar-recovery.js), dirt and stone first, as a player would.
const STAND = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'sandstone', 'red_sandstone', 'blackstone', 'basalt'];
const REACH = 4.2;           // eye to a log's middle: under the arm's 4.5 (mining-access.js miningReach) for the body's jitter
const MAX_STAND = 8;         // blocks laid under one stand
const MAX_STANDS = 4;        // stands for one tree
const key = p => `${p.x},${p.y},${p.z}`;
const at = p => new Vec3(p.x, p.y, p.z);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const middle = p => p.offset(0.5, 0.5, 0.5);
const clear = b => !!b && (AIR.test(b.name) || COVER.test(b.name));
const passable = b => clear(b) || (!!b && LEAVES.test(b.name));
const solidGround = b => !!b && b.boundingBox === 'block' && !LEAVES.test(b.name) && !LOG.test(b.name) && !LIQUID.test(b.name) && !/^(magma_block|cactus|powder_snow)$/.test(b.name);
const standCarried = bot => bot.inventory.items().filter(i => STAND.includes(i.name)).reduce((n, i) => n + i.count, 0);
const carried = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
const fatal = err => ['Cancelled', 'NeedsAir', 'NeedsSafety', 'Blocked'].includes(err?.name);

// Every drop of a kind lying about a spot, taken up: the collector (drop-collection.js) ends at the first one gained,
// and a felled tree leaves its logs all round its foot. -> how many were taken
async function gatherAll(bot, task, collect, item, origin, { radius = 10, rounds = 24, timeoutMs = 5000, waitForSpawnMs = 800, most = Infinity } = {}) {
  if (!collect) return 0;
  const start = carried(bot, item);
  for (let i = 0; i < rounds && carried(bot, item) - start < most; i++) {
    // Only what lies near the ground: a log up on the leaves sent the walk climbing to it on a block laid from the
    // pockets (drop-collection.js), and the block was left standing. Those come down with the leaves.
    if (i && !lyingLow(bot, item, at(origin), radius)) break;
    const before = carried(bot, item);
    let ok = false;
    try { ok = await collect(bot, task, item, { before, origin, radius, timeoutMs, waitForSpawnMs: i ? 0 : waitForSpawnMs }); }
    catch (err) { task.check(); if (fatal(err)) throw err; }
    if (!ok || carried(bot, item) <= before) break;
  }
  return carried(bot, item) - start;
}

// The logs of one tree: the start and every log of its kind joined to it, side to side or corner to corner (an
// acacia's branches go off at a slant), within eight blocks across, sixteen down and thirty-two up, at most `most`.
// `mine`: false for a log that is not the tree's to cut (one a player laid, built.js leftAlone). -> Vec3[], lowest first
function treeLogs(bot, start, { block = bot.blockAt(start)?.name, mine = () => true, most = 96 } = {}) {
  if (!LOG.test(block || '')) return [];
  const origin = at(start), seen = new Set([key(origin)]), out = [], queue = [origin];
  while (queue.length && out.length < most) {
    const p = queue.shift();
    if (bot.blockAt(p)?.name !== block || !mine(p)) continue;
    out.push(p);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dy && !dz) continue;
      const q = p.offset(dx, dy, dz), k = key(q);
      if (seen.has(k) || Math.abs(q.x - origin.x) > 8 || Math.abs(q.z - origin.z) > 8 || q.y < origin.y - 16 || q.y > origin.y + 32) continue;
      seen.add(k); queue.push(q);
    }
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
}

// Where a trunk stood: its lowest logs, with the ground under them. None for a tree's top read after its trunk was cut
// (its lowest log over air or over the trunk's own log): a sapling was put two blocks off an acacia's foot for the top
// piece's 'stump' in the air. -> { block, cells: Vec3[], soil: Vec3[] } or null
function stumpOf(bot, logs, block) {
  if (!logs.length) return null;
  const low = logs[0].y, cells = logs.filter(p => p.y === low);
  if (!cells.some(p => solidGround(bot.blockAt(p.offset(0, -1, 0))))) return null;
  return { block, cells, soil: cells.map(p => p.offset(0, -1, 0)) };
}

// From a stand's feet, is the log's middle within the arm? (Only the distance: the line is the world's, looked at there.)
const withinArm = (feet, log, reach = REACH) => at(feet).offset(0.5, 1.62, 0.5).distanceTo(middle(at(log))) <= reach;

// Where to stand for a log no ground stand reaches: the foot of a column beside it or under it, on solid ground, the
// cells up to the stand's head air or leaves (no log, no liquid), and the stand's eye within reach of the log. Under the
// log, the head stays under it. `forbidden(cell)`: a cell the stand may not be laid in or stood on (a player's build,
// the spot the player chose). -> { foot: Vec3, height, eye } with the fewest blocks to lay, then the nearest, or null.
function standFor(bot, log, { tree = [], maxHeight = MAX_STAND, forbidden = () => false, reach = REACH } = {}) {
  const inTree = new Set(tree.map(key)), here = bot.entity?.position;
  const found = [];
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const x = log.x + dx, z = log.z + dz;
    // The ground: the first solid block down from over the log with room to stand on it (a log, leaves or a liquid
    // passed on the way down is above the stand: the climb below checks the body's cells against them).
    let ground = null;
    for (let y = log.y + 1; y >= log.y - maxHeight - 6; y--) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (!b) break;
      if (solidGround(b) && clear(bot.blockAt(new Vec3(x, y + 1, z)))) { ground = y; break; }
    }
    if (ground == null) continue;
    const foot = new Vec3(x, ground + 1, z);
    if (!clear(bot.blockAt(foot)) || !passable(bot.blockAt(foot.offset(0, 1, 0))) || forbidden(foot) || forbidden(foot.offset(0, -1, 0))) continue;
    for (let h = 0; h <= maxHeight; h++) {
      const feet = foot.offset(0, h, 0), head = feet.offset(0, 1, 0);
      if (!dx && !dz && head.y >= log.y) break;
      // The body's cells at this height and the one over the head clear enough to climb into.
      const cells = [feet, head];
      if (cells.some(c => { const b = bot.blockAt(c); return !b || inTree.has(key(c)) || LOG.test(b.name) || LIQUID.test(b.name) || !passable(b); })) break;
      if (h > 0 && forbidden(feet.offset(0, -1, 0))) break;
      if (withinArm(feet, log, reach)) { found.push({ foot, height: h, eye: feet.offset(0.5, 1.62, 0.5).distanceTo(middle(at(log))), walk: here ? foot.offset(0.5, 0, 0.5).distanceTo(here) : 0 }); break; }
    }
  }
  found.sort((a, b) => a.height - b.height || a.walk - b.walk || a.eye - b.eye);
  return found[0] ? { foot: found[0].foot, height: found[0].height, eye: Math.round(found[0].eye * 10) / 10 } : null;
}

// Leaves between the eye and the log, dug, three at most. -> whether the log is in reach now.
async function clearLineTo(bot, task, p, { most = 3 } = {}) {
  const { miningReach } = require('./mining-access'), { supportCell } = require('./terrain');
  for (let n = 0; n < most && !miningReach(bot, bot.entity.position, p); n++) {
    task.check();
    const eye = bot.entity.position.offset(0, 1.62, 0), direction = middle(p).minus(eye);
    if (direction.norm() > 4.5) return false;
    const hit = bot.world?.raycast?.(eye, direction.unit(), direction.norm()), leaf = hit?.position && bot.blockAt(hit.position);
    if (!leaf || !LEAVES.test(leaf.name) || leaf.position.equals(supportCell(bot.entity.position)) || !bot.canDigBlock(leaf)) return false;
    await digHere(bot, task, leaf.position);
  }
  return miningReach(bot, bot.entity.position, p);
}

// A dig from where the body is, with no walk (the stand is a column one wide).
async function digHere(bot, task, p) {
  const { equipBestTool } = require('./skills'), { digWithAirGuard } = require('./vitals');
  const block = bot.blockAt(p);
  if (!block || AIR.test(block.name)) return true;
  await equipBestTool(bot, block);
  task.check();
  await digWithAirGuard(bot, task, block);
  for (let i = 0; i < 20 && bot.blockAt(p)?.type === block.type; i++) await sleep(50);
  return bot.blockAt(p)?.type !== block.type;
}

// Every log of the tree the arm reaches from where the body is, the nearest first, with the leaves in their way.
async function cutInReach(bot, task, tree, block) {
  const { miningReach } = require('./mining-access');
  let cut = 0;
  for (let round = 0; round < 4; round++) {
    const eye = bot.entity.position.offset(0, 1.62, 0);
    const near = tree.filter(p => bot.blockAt(p)?.name === block && eye.distanceTo(middle(p)) <= 4.5).sort((a, b) => eye.distanceTo(middle(a)) - eye.distanceTo(middle(b)));
    let any = false;
    for (const p of near) {
      task.check();
      if (bot.blockAt(p)?.name !== block) continue;
      if (!miningReach(bot, bot.entity.position, p) && !await clearLineTo(bot, task, p)) continue;
      if (await digHere(bot, task, p)) { cut++; any = true; }
    }
    if (!any) break;
  }
  return cut;
}

// The block under the feet dug and the body landed on the one below, the server's word on the block waited for as
// pillar-recovery.js descendPillar waits for it: the library makes the cell air before the server answers, and a dig
// the server refused puts the block back under a body already counted down. -> whether it came down a block
async function digUnder(bot, task, p) {
  let confirmed = !bot._client;
  const changed = packet => { if (packet.location?.x === p.x && packet.location.y === p.y && packet.location.z === p.z) confirmed = packet.type === 0; };
  const changedMany = packet => {
    const packed = bot.supportFeature?.('usesMultiblockSingleLong');
    const section = bot.supportFeature?.('usesMultiblock3DChunkCoords') ? packet.chunkCoordinates : { x: packet.chunkX, y: 0, z: packet.chunkZ };
    for (const record of packet.records || []) {
      const x = section.x * 16 + (packed ? (record >> 8) & 15 : record.horizontalPos >> 4);
      const y = section.y * 16 + (packed ? record & 15 : record.y);
      const z = section.z * 16 + (packed ? (record >> 4) & 15 : record.horizontalPos & 15);
      if (x === p.x && y === p.y && z === p.z) confirmed = (packed ? Math.floor(record / 4096) : record.blockId) === 0;
    }
  };
  bot._client?.on('block_change', changed); bot._client?.on('multi_block_change', changedMany);
  try {
    if (!await digHere(bot, task, p)) return false;
    let landedSince = 0;
    for (const deadline = Date.now() + 4000; Date.now() < deadline;) {
      task.check();
      const now = bot.entity.position;
      if (confirmed && AIR.test(bot.blockAt(p)?.name || '') && Math.abs(now.y - p.y) < 0.08 && bot.entity.onGround !== false) {
        landedSince ||= Date.now();
        if (Date.now() - landedSince >= 250) return true;
      } else landedSince = 0;
      await sleep(50);
    }
    return false;
  } finally { bot._client?.removeListener('block_change', changed); bot._client?.removeListener('multi_block_change', changedMany); }
}

// Down a stand of its own, a block at a time: the block under the feet dug and the body let down onto the next, the
// blocks picked up as it passes them. A block left over (the body stepped off, a dig refused) is dug from beside.
async function lowerStand(bot, task, cells, { dig } = {}) {
  const { supportCell } = require('./terrain');
  const own = new Set(cells.map(key));
  delete bot._pillarUp;
  for (let i = 0; i < cells.length + 2; i++) {
    task.check();
    const under = supportCell(bot.entity.position);
    if (!own.has(key(under)) || bot.blockAt(under)?.boundingBox !== 'block') break;
    if (!await digUnder(bot, task, under)) { console.log(`[tree] the stand's block at ${under} under the feet did not come away: ${bot.blockAt(under)?.name} there`); break; }
    own.delete(key(under));
  }
  for (const c of cells) {
    if (!own.has(key(c)) || !STAND.includes(bot.blockAt(c)?.name)) continue;
    try { if (dig) await dig(bot, task, c, { requireDrops: false }); own.delete(key(c)); } catch (err) { task.check(); if (fatal(err)) throw err; }
  }
  return [...own].map(k => { const [x, y, z] = k.split(',').map(Number); return new Vec3(x, y, z); }).filter(c => STAND.includes(bot.blockAt(c)?.name));
}

// Stands left standing (the work was cut off up there): kept to be taken down when the bot is back on the ground near
// them. -> how many were taken down.
async function clearLeftStands(bot, task, { dig, within = 24 } = {}) {
  const left = bot._treeStands || [];
  if (!left.length || !dig) return 0;
  const here = bot.entity.position;
  let done = 0;
  for (const stand of left.slice()) {
    const cells = stand.cells.map(at).filter(c => STAND.includes(bot.blockAt(c)?.name));
    if (!cells.length) { left.splice(left.indexOf(stand), 1); continue; }
    if (cells[0].distanceTo(here) > within) continue;
    for (const c of cells.sort((a, b) => b.y - a.y)) { try { await dig(bot, task, c, { requireDrops: false }); } catch (err) { task.check(); if (fatal(err)) throw err; } }
    if (!stand.cells.some(c => STAND.includes(bot.blockAt(at(c))?.name))) { left.splice(left.indexOf(stand), 1); done++; }
  }
  return done;
}

// Blocks of the stand kinds the bot laid itself about the trees it cut since the work began, a stand's or not: the
// pathfinder's own climb and a walk's tower up to a drop leave one standing too (on the copy, 2026-11-27: two of them
// after six acacias, in no stand laid). About a tree is within four of its trunk's column, from its stump's height to
// sixteen over it, so the soil put back in a hole dug for a stand is left. Never one a building keeps or a player's
// (forbidden). Taken down from the top. -> how many
async function clearLaidAbout(bot, task, { dig, since = 0, trees = [], forbidden = () => false } = {}) {
  if (!dig || !bot._laid?.size || !trees.length) return 0;
  const own = require('./own-blocks'), cells = [];
  for (const [k, rec] of bot._laid) {
    if ((rec?.at || 0) < since || !STAND.includes(rec?.name)) continue;
    const [x, y, z] = k.split(',').map(Number), c = new Vec3(x, y, z);
    if (!trees.some(t => Math.abs(t.x - x) <= 4 && Math.abs(t.z - z) <= 4 && y >= t.y && y <= t.y + 16)) continue;
    if (forbidden(c) || !own.laidAt(bot, c)) continue;
    cells.push(c);
  }
  let done = 0;
  for (const c of cells.sort((a, b) => b.y - a.y)) {
    task.check();
    try { await dig(bot, task, c, { requireDrops: false }); } catch (err) { task.check(); if (fatal(err)) throw err; }
    if (!STAND.includes(bot.blockAt(c)?.name)) done++;
  }
  if (cells.length) console.log(`[tree] ${done} of the ${cells.length} blocks the bot laid itself about the trees cut taken down (a walk's climb, a tower)`);
  return done;
}

// Soil dug for a stand when too few blocks are carried: next to the foot, never the foot's own ground or the stump's,
// each hole kept to be filled again after. -> the holes dug.
async function digStandBlocks(bot, task, foot, need, { dig, collect, forbidden = () => false, stump = null, tree = [] } = {}) {
  const holes = [], skip = new Set([key(foot.offset(0, -1, 0)), ...(stump?.soil || []).map(key)]);
  // Not the stump's soil nor beside it (where a sapling goes, or four), nor under the tree's own columns.
  const nearStump = c => (stump?.cells || []).some(s => Math.abs(s.x - c.x) <= 1 && Math.abs(s.z - c.z) <= 1 && Math.abs(s.y - 1 - c.y) <= 1);
  const columns = new Set(tree.map(p => `${p.x},${p.z}`));
  const spots = [];
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    const c = foot.offset(dx, -1, dz);
    if ((!dx && !dz) || skip.has(key(c)) || nearStump(c) || columns.has(`${c.x},${c.z}`) || forbidden(c)) continue;
    const b = bot.blockAt(c), over = bot.blockAt(c.offset(0, 1, 0));
    if (!b || !/^(grass_block|dirt)$/.test(b.name) || !clear(over) || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => LIQUID.test(bot.blockAt(c.offset(x, 0, z))?.name || ''))) continue;
    if (bot.blockAt(c.offset(0, -1, 0))?.boundingBox !== 'block') continue;
    spots.push(c);
  }
  spots.sort((a, b) => a.distanceTo(foot) - b.distanceTo(foot));
  for (const c of spots) {
    if (standCarried(bot) >= need) break;
    task.check();
    const before = carried(bot, 'dirt');
    try { await dig(bot, task, c); } catch (err) { task.check(); if (fatal(err)) throw err; continue; }
    holes.push(c);
    if (collect) { try { await collect(bot, task, 'dirt', { before, origin: c, radius: 4, waitForSpawnMs: 600 }); } catch (err) { task.check(); if (fatal(err)) throw err; } }
  }
  return holes;
}

// The holes dug for a stand filled again with the dirt carried, best effort.
async function fillHoles(bot, task, holes, { place } = {}) {
  let filled = 0;
  for (const c of holes) {
    if (!place || !carried(bot, 'dirt') || !clear(bot.blockAt(c))) continue;
    try { await place(bot, task, c, 'dirt'); if (bot.blockAt(c)?.name === 'dirt') filled++; } catch (err) { task.check(); if (fatal(err)) throw err; }
  }
  return filled;
}

// The logs of a tree that no ground stand reaches, taken from stands laid for them: for the lowest such log a column
// is chosen (standFor), walked to, climbed (pillar-recovery.js pillarUp) and the tree's logs in reach of its top cut;
// then the column is taken down again. Up to four columns a tree. The logs cut fall to the ground and are picked up
// after (`collect`). -> the logs cut
async function fellFromStands(bot, task, goal, save, log, { navigate, dig, place, collect, forbidden = () => false, tree: given } = {}) {
  const block = bot.blockAt(log)?.name;
  if (!LOG.test(block || '') || bot.game?.gameMode === 'creative') return 0;
  const built = require('./built');
  const tree = given?.length ? given : treeLogs(bot, log, { block, mine: p => !built.leftAlone(bot, goal, p) });
  const left = () => tree.filter(p => bot.blockAt(p)?.name === block);
  // The trunk's foot as the work on the tree first read it (work.js workSource): the logs left now are its top.
  const given2 = bot._fellingStump;
  const stump = given2?.block === block && given2.cells?.length && at(given2.cells[0]).distanceTo(at(log)) <= 24 ? { ...given2, cells: given2.cells.map(at), soil: given2.cells.map(c => at(c).offset(0, -1, 0)) } : stumpOf(bot, tree, block);
  let cut = 0;
  // Standing on the tree's own log (an acacia's foot, its trunk leaning off it): cut from where the feet are, the body
  // let down a block onto the ground under it, as a player does. A walk off it to a stand beside found 'No route from
  // here' and the tree was left with its foot and three logs over it.
  {
    const { supportCell } = require('./terrain'), under = supportCell(bot.entity.position);
    if (tree.some(p => p.equals(under)) && bot.blockAt(under)?.name === block && solidGround(bot.blockAt(under.offset(0, -1, 0)))) {
      const before = carried(bot, block);
      if (await digUnder(bot, task, under)) { cut++; console.log(`[tree] the ${block.replaceAll('_', ' ')} under the feet at ${under} cut, down onto the ground`); }
      if (collect && carried(bot, block) <= before) await gatherAll(bot, task, collect, block, under, { radius: 4, rounds: 1, timeoutMs: 2500, waitForSpawnMs: 500 });
    }
  }
  for (let stands = 0; stands < MAX_STANDS && left().length; stands++) {
    task.check();
    // The asked-for log first, then the lowest left that a stand reaches.
    const order = [...(stands === 0 && bot.blockAt(log)?.name === block ? [at(log)] : []), ...left()];
    let target = null, site = null;
    for (const t of order.slice(0, 12)) { site = standFor(bot, t, { tree: left(), forbidden }); if (site) { target = t; break; } }
    if (!site) { console.log(`[tree] no stand reaches the ${block.replaceAll('_', ' ')}s left at ${order[0]}: ${left().length} logs of the tree left`); break; }
    const holes = site.height > standCarried(bot) ? await digStandBlocks(bot, task, site.foot, site.height, { dig, collect, forbidden, stump, tree }) : [];
    if (site.height > standCarried(bot)) { console.log(`[tree] ${site.height} blocks wanted for a stand at ${site.foot}, ${standCarried(bot)} carried`); await fillHoles(bot, task, holes, { place }); break; }
    // To the foot with the dry mining walk (no digging on the way).
    const { miningMovement } = require('./mining-access'), policy = miningMovement(bot);
    try { await navigate(bot, task, new goals.GoalBlock(site.foot.x, site.foot.y, site.foot.z), { timeoutMs: 20000, stallMs: 4000 }); }
    catch (err) { task.check(); if (fatal(err)) throw err; }
    finally { policy.restore(); }
    const feet = bot.entity.position.floored();
    if (feet.x !== site.foot.x || feet.z !== site.foot.z || feet.y !== site.foot.y) { console.log(`[tree] the foot of the stand at ${site.foot} was not reached (at ${feet})`); await fillHoles(bot, task, holes, { place }); break; }
    const cells = [];
    let n = 0;
    try {
      if (site.height) {
        const { pillarUp } = require('./pillar-recovery');
        n = await pillarUp(bot, task, site.foot.y + site.height, { dig, maxBlocks: site.height, blocks: STAND });
        // The bot's own column while it stands on it (pillar-recovery.js descendPillar leaves such a column be).
        bot._pillarUp = { x: site.foot.x, z: site.foot.z, base: site.foot.y, until: Date.now() + 120000, tree: true };
        for (let i = 0; i < site.height + 1; i++) { const c = site.foot.offset(0, i, 0); if (STAND.includes(bot.blockAt(c)?.name)) cells.push(c); }
        if (cells.length) (bot._treeStands ||= []).push({ cells: cells.map(c => ({ x: c.x, y: c.y, z: c.z })), at: Date.now() });
      }
      const got = await cutInReach(bot, task, tree, block);
      cut += got;
      console.log(`[tree] ${site.height ? `a stand ${n} of ${site.height} blocks high at ${site.foot}` : `a ground stand at ${site.foot}`}: ${got} ${block.replaceAll('_', ' ')}s cut from it, ${left().length} of the tree's ${tree.length} left`);
      if (!got) break;
    } finally {
      if (cells.length) {
        const rest = await lowerStand(bot, task, cells, { dig });
        const mine = bot._treeStands?.findIndex(s => s.cells.length === cells.length && s.cells.every((c, i) => c.x === cells[i].x && c.y === cells[i].y && c.z === cells[i].z));
        if (!rest.length && mine >= 0) bot._treeStands.splice(mine, 1);
      }
      await fillHoles(bot, task, holes, { place });
    }
  }
  if (cut && collect) {
    const origin = stump?.cells[0] || at(log), got = await gatherAll(bot, task, collect, block, origin, { radius: 10 });
    console.log(`[tree] ${got} of the ${cut} ${block.replaceAll('_', ' ')}s cut from stands picked up${got < cut ? ' (the rest lie on the leaves till they fall)' : ''}`);
  }
  return cut;
}

// Saplings owed where a tree was cut and none was carried to plant (bot._replant), planted when one is. Kept in the
// bot's state folder (bot._replantFile, session.js) across restarts, for this world (its seed) and dimension, a week.
const WORLD = bot => `${String(bot.game?.dimension || 'overworld').replace('minecraft:', '')}:${bot.game?.hashedSeed ?? ''}`;
const OWED_MS = 7 * 24 * 3600000;
function loadOwed(bot) {
  if (bot._replantLoaded) return;
  bot._replantLoaded = true;
  if (!bot._replantFile) return;
  try {
    const data = JSON.parse(fs.readFileSync(bot._replantFile, 'utf8'));
    if (Array.isArray(data?.owed)) bot._replant = [...data.owed, ...(bot._replant || [])].filter(s => Array.isArray(s?.cells) && s.cells.length && SAPLING[s.block]).slice(-32);
  } catch (_) { /* none kept yet */ }
}
function saveOwed(bot) {
  if (!bot._replantFile) return;
  try { const tmp = `${bot._replantFile}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, owed: bot._replant || [] })}\n`); fs.renameSync(tmp, bot._replantFile); }
  catch (err) { console.log(`[tree] the saplings owed were not saved: ${err.message}`); }
}
const sameCells = (a, b) => a.cells.some(c => b.cells.some(d => c.x === d.x && c.y === d.y && c.z === d.z));
// The owed of this world and dimension, the stale ones dropped.
function owedHere(bot) {
  loadOwed(bot);
  const now = Date.now(), world = WORLD(bot);
  bot._replant = (bot._replant || []).filter(s => now - (s.at || 0) < OWED_MS);
  return bot._replant.filter(s => (s.world ?? world) === world);
}
function owe(bot, stump) {
  if (!stump) return;
  loadOwed(bot);
  const list = bot._replant ||= [];
  if (!list.some(s => sameCells(s, stump)))
    list.push({ block: stump.block, cells: stump.cells.map(c => ({ x: c.x, y: c.y, z: c.z })), at: Date.now(), world: WORLD(bot) });
  while (list.length > 32) list.shift();
  saveOwed(bot);
}
function forget(bot, stump) {
  loadOwed(bot);
  const before = (bot._replant || []).length;
  bot._replant = (bot._replant || []).filter(s => !sameCells(s, stump));
  if (bot._replant.length !== before) saveOwed(bot);
}
const toStump = s => ({ block: s.block, cells: s.cells.map(at), soil: s.cells.map(c => at(c).offset(0, -1, 0)) });

// Open soil to plant on about a spot: soil under, the cell and two over it clear (room for the tree to come up), no
// liquid beside, no log or sapling within one, not a cell a player keeps; the nearest first, `count` of them at least
// `apart` from each other and from `taken`, or for the kinds that grow four together a square of four. -> Vec3[]
function spotsNear(bot, origin, { sapling, within = 5, count = 1, apart = 3, forbidden = () => false, taken = [] } = {}) {
  const o = at(origin), found = [];
  const ok = c => {
    const under = bot.blockAt(c.offset(0, -1, 0));
    if (!under || !SOIL.test(under.name) || !clear(bot.blockAt(c)) || forbidden(c) || forbidden(c.offset(0, -1, 0))) return false;
    if (![1, 2].every(h => passable(bot.blockAt(c.offset(0, h, 0))))) return false;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const b = bot.blockAt(c.offset(dx, 0, dz));
      if (b && (LOG.test(b.name) || /_sapling$|^mangrove_propagule$/.test(b.name) || ((dx === 0) !== (dz === 0) && LIQUID.test(b.name)))) return false;
    }
    return true;
  };
  const cells = [];
  for (let dx = -within; dx <= within; dx++) for (let dz = -within; dz <= within; dz++) {
    // The ground in this column near the spot's height.
    for (let dy = 2; dy >= -3; dy--) { const c = o.offset(dx, dy, dz); if (ok(c)) { cells.push(c); break; } }
  }
  cells.sort((a, b) => a.distanceTo(o) - b.distanceTo(o));
  const far = (c, list) => list.every(q => Math.max(Math.abs(q.x - c.x), Math.abs(q.z - c.z)) >= apart);
  if (FOUR.has(sapling)) {
    const has = (x, y, z) => cells.find(c => c.x === x && c.y === y && c.z === z);
    for (const c of cells) {
      const sq = [c, has(c.x + 1, c.y, c.z), has(c.x, c.y, c.z + 1), has(c.x + 1, c.y, c.z + 1)];
      if (sq.every(Boolean) && sq.every(q => far(q, taken))) return sq;
    }
    return [];
  }
  for (const c of cells) { if (found.length >= count) break; if (far(c, [...taken, ...found])) found.push(c); }
  return found;
}

// A sapling there already, or the tree grown back: nothing is owed for the stump.
const stumpTaken = (bot, stump) => stump.cells.some(c => { const n = bot.blockAt(at(c))?.name || ''; return n === SAPLING[stump.block] || n === stump.block; });

// Where a sapling of the tree goes now: where the trunk stood, preferably (asked for: 'not just where the tree was cut
// but preferably there'), its cells with soil under them and nothing in them, four in a square for the kinds that grow
// so; else open soil close by (spotsNear, within five). -> Vec3[] (none when the stump has its sapling already)
function plantCells(bot, stump, { forbidden = () => false } = {}) {
  const sapling = SAPLING[stump.block];
  if (stumpTaken(bot, stump)) return [];
  const ok = stump.cells.map(at).filter(c => clear(bot.blockAt(c)) && SOIL.test(bot.blockAt(c.offset(0, -1, 0))?.name || ''));
  if (!FOUR.has(sapling) && ok.length) return ok.slice(0, 1);
  if (FOUR.has(sapling)) {
    const has = (x, z) => ok.find(c => c.x === x && c.z === z);
    for (const c of ok) { const sq = [has(c.x, c.z), has(c.x + 1, c.z), has(c.x, c.z + 1), has(c.x + 1, c.z + 1)]; if (sq.every(Boolean)) return sq; }
  }
  return spotsNear(bot, stump.cells[0], { sapling, forbidden });
}

// A sapling put on the soil where the trunk stood, when one of its kind is carried; else picked up from the drops
// about the stump first (the leaves, cut or fallen, drop them), and otherwise owed. -> the saplings planted
async function replant(bot, task, stump, { place, collect, forbidden, wait = 0 } = {}) {
  if (!stump || bot.game?.gameMode === 'creative') return 0;
  const sapling = SAPLING[stump.block];
  if (!sapling) return 0;
  if (stumpTaken(bot, stump)) { forget(bot, stump); return 0; }
  const cells = plantCells(bot, stump, { forbidden });
  if (!cells.length) { console.log(`[tree] no soil to plant a ${sapling.replaceAll('_', ' ')} on where the trunk stood at ${stump.cells[0]} nor within five`); return 0; }
  const there = cells.some(c => stump.cells.some(d => at(d).equals(c)));
  if (carried(bot, sapling) < cells.length) await gatherAll(bot, task, collect, sapling, cells[0], { radius: 10, waitForSpawnMs: wait, most: cells.length - carried(bot, sapling) });
  if (carried(bot, sapling) < cells.length || !place) { owe(bot, stump); console.log(`[tree] ${cells.length} ${sapling.replaceAll('_', ' ')} wanted for the stump at ${cells[0]}, ${carried(bot, sapling)} carried: owed`); return 0; }
  let planted = 0;
  for (const c of cells) {
    try { await place(bot, task, c, sapling); if (bot.blockAt(c)?.name === sapling) planted++; } catch (err) { task.check(); if (fatal(err)) throw err; }
  }
  if (planted === cells.length) forget(bot, stump);
  else owe(bot, stump);
  console.log(`[tree] ${planted} ${sapling.replaceAll('_', ' ')} planted ${there ? 'where the trunk stood' : `beside where the trunk stood at ${stump.cells[0]}, at`} ${cells[0]}`);
  return planted;
}

// The saplings owed within `within` blocks, planted with those carried or lying about each stump. -> planted
async function replantOwed(bot, task, { place, collect, forbidden, navigate, within = 24, most = 3, budgetMs = 15000 } = {}) {
  const here = bot.entity.position, owed = owedHere(bot).filter(s => at(s.cells[0]).distanceTo(here) <= within)
    .sort((a, b) => at(a.cells[0]).distanceTo(here) - at(b.cells[0]).distanceTo(here)).slice(0, most);
  const deadline = Date.now() + budgetMs;
  let planted = 0;
  for (const s of owed) {
    task.check();
    if (Date.now() >= deadline) break;
    const stump = toStump(s);
    // A sapling there now (a player planted it) or the tree grown back: nothing owed.
    if (stumpTaken(bot, stump)) { forget(bot, stump); continue; }
    // The tree's logs that lay on its leaves have fallen with them by now; those lying low are taken on the way.
    if (lyingLow(bot, s.block, stump.cells[0])) await gatherAll(bot, task, collect, s.block, stump.cells[0], { radius: 10, waitForSpawnMs: 0, timeoutMs: 3000, rounds: 8 });
    if (!carried(bot, SAPLING[s.block]) && !lyingLow(bot, SAPLING[s.block], stump.cells[0])) continue;
    // To the stump first: the pickup reaches only so far from where the bot stands (drop-collection.js bounds it by
    // the radius from the bot), and a sapling 12 blocks off was 'out of bounds' at the next tree.
    if (navigate && stump.cells[0].distanceTo(bot.entity.position) > 5) {
      try { await navigate(bot, task, new goals.GoalNear(stump.cells[0].x, stump.cells[0].y, stump.cells[0].z, 2), { timeoutMs: Math.max(3000, Math.min(15000, deadline - Date.now())), stallMs: 4000 }); }
      catch (err) { task.check(); if (fatal(err)) throw err; continue; }
    }
    planted += await replant(bot, task, stump, { place, collect, forbidden });
  }
  return planted;
}

// Drops of a kind lying near the ground about a spot (not up on leaves, where no walk reaches them).
function lyingLow(bot, item, origin, radius = 10) {
  return Object.values(bot.entities || {}).some(e => e?.name === 'item' && e.isValid !== false && e.position && e.getDroppedItem?.()?.name === item &&
    e.position.distanceTo(origin) <= radius && e.position.y <= origin.y + 1.5);
}

// Room in the pockets for one more of an item: a slot to spare, or a stack of it not full. The bot's own chore picks up
// nothing into full pockets: the tidy that makes room drops gear and says so (on the copy, 2026-11-27).
function room(bot, item) {
  const free = typeof bot.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 2;
  if (free > 1) return true;
  return (typeof bot.inventory?.items === 'function' ? bot.inventory.items() : []).some(i => i.name === item && i.count < (i.stackSize || 64));
}

// The trees cut lately, kept a while (an item lies five minutes): about each, the logs that lay on its leaves come down
// with them, and the saplings with them (chores.js). At most sixteen; read for this dimension.
const FELLED_MS = 5 * 60000;
function noteFelled(bot, block, cell, now = Date.now()) {
  if (!cell || !SAPLING[block]) return;
  const list = bot._felled ||= [], dimension = bot.game?.dimension;
  const same = list.find(f => f.x === cell.x && f.y === cell.y && f.z === cell.z && f.dimension === dimension);
  if (same) same.until = now + FELLED_MS;
  else list.push({ block, x: cell.x, y: cell.y, z: cell.z, dimension, until: now + FELLED_MS });
  while (list.length > 16) list.shift();
}
function felledHere(bot, now = Date.now()) {
  bot._felled = (bot._felled || []).filter(f => f.until > now);
  return bot._felled.filter(f => f.dimension === bot.game?.dimension);
}

// A player's "replant the trees" (companion-actions.js), or the bot's own chore about here (chores.js): the saplings
// owed where the bot cut trees within 64 blocks planted, each stump walked to and the saplings and logs lying about it
// picked up there first. The chore walks only to the stumps it has a sapling for (carried, or lying about the stump),
// takes a stand left up a trunk down first, picks up what lies about the trees cut lately, and plants nowhere else.
// -> true (done), with goal.planted, goal.replantLeft and goal.replantNone for the line said at the end (speech.js),
// and for a chore goal.picked and goal.standsDown.
async function replantStep(bot, task, goal, save, { navigate, place, collect, forbidden, dig } = {}) {
  const chore = !!goal.chore;
  const near = () => owedHere(bot).filter(s => at(s.cells[0]).distanceTo(bot.entity.position) <= 64);
  const ready = s => { const sapling = SAPLING[s.block]; return carried(bot, sapling) >= (FOUR.has(sapling) ? 4 : 1) || ((!chore || room(bot, sapling)) && lyingLow(bot, sapling, at(s.cells[0]))); };
  const nearest = list => list.sort((a, b) => at(a.cells?.[0] || a).distanceTo(bot.entity.position) - at(b.cells?.[0] || b).distanceTo(bot.entity.position));
  const walkTo = async c => {
    if (c.distanceTo(bot.entity.position) <= 4 || !navigate) return true;
    try { await navigate(bot, task, new goals.GoalNear(c.x, c.y, c.z, 2), { timeoutMs: 30000, stallMs: 5000 }); return true; }
    catch (err) { task.check(); if (fatal(err)) throw err; return false; }
  };
  const visited = [];
  const plantOwed = async list => {
    for (const s of list.slice(0, 8)) {
      task.check();
      const stump = toStump(s), sapling = SAPLING[s.block];
      if (stumpTaken(bot, stump)) { forget(bot, stump); continue; }
      goal.step = { action: 'replant', item: sapling, position: { x: stump.cells[0].x, y: stump.cells[0].y, z: stump.cells[0].z } }; save?.();
      if (!await walkTo(stump.cells[0])) continue;
      visited.push(stump.cells[0]);
      if ((!chore || room(bot, s.block)) && lyingLow(bot, s.block, stump.cells[0])) goal.picked += await gatherAll(bot, task, collect, s.block, stump.cells[0], { radius: 10, waitForSpawnMs: 0, timeoutMs: 3000, rounds: 8 });
      goal.planted += await replant(bot, task, stump, { place, collect, forbidden });
    }
  };
  goal.planted ||= 0; goal.picked ||= 0;
  // What it laid itself about the trees it walks to since they were cut (FELLED_MS ago at most), not before.
  const since = Date.now() - FELLED_MS - 60000, about = [];
  if (chore && dig) goal.standsDown = await clearLeftStands(bot, task, { dig, within: 40 });
  const owed = nearest(near().filter(s => !chore || ready(s)));
  goal.replantNone = !owed.length;
  await plantOwed(owed);
  if (chore) {
    // What lies about the trees cut lately: the logs come down with the leaves, and the saplings.
    for (const f of nearest(felledHere(bot).filter(f => at(f).distanceTo(bot.entity.position) <= 40)).slice(0, 6)) {
      task.check();
      const o = at(f), kinds = [f.block, SAPLING[f.block]].filter(k => room(bot, k) && lyingLow(bot, k, o));
      if (!kinds.length) continue;
      goal.step = { action: 'pick_up', item: kinds[0], position: { x: o.x, y: o.y, z: o.z } }; save?.();
      if (!await walkTo(o)) continue;
      about.push(o);
      for (const k of kinds) if (room(bot, k)) goal.picked += await gatherAll(bot, task, collect, k, o, { radius: 10, waitForSpawnMs: 0, timeoutMs: 3000, rounds: 8 });
    }
    // The stumps the saplings picked up there are for.
    await plantOwed(nearest(near().filter(s => ready(s) && !visited.some(c => c.equals(at(s.cells[0]))))));
    // And what it laid itself on the way about them (a walk's climb, a tower to a drop).
    if (dig) goal.laidDown = await clearLaidAbout(bot, task, { dig, since, trees: [...visited, ...about], forbidden });
  }
  goal.replantLeft = near().length;
  // Nothing owed about here and saplings carried: planted about the player who asked, on open soil a few apart.
  if (!owed.length && !chore) {
    const who = (goal.from && bot.players?.[goal.from]?.entity?.position) || bot.entity.position;
    const taken = [];
    goal.plantedHere = 0;
    for (const sapling of [...new Set(Object.values(SAPLING))]) {
      while (goal.plantedHere < 4 && carried(bot, sapling) >= (FOUR.has(sapling) ? 4 : 1)) {
        task.check();
        const cells = spotsNear(bot, who.floored(), { sapling, within: 8, forbidden, taken });
        if (!cells.length) break;
        taken.push(...cells);
        goal.step = { action: 'replant', item: sapling, position: { x: cells[0].x, y: cells[0].y, z: cells[0].z } }; save?.();
        let n = 0;
        for (const c of cells) { try { await place(bot, task, c, sapling); if (bot.blockAt(c)?.name === sapling) n++; } catch (err) { task.check(); if (fatal(err)) throw err; } }
        if (!n) break;
        goal.plantedHere += FOUR.has(sapling) ? 1 : n;
        console.log(`[tree] ${n} ${sapling.replaceAll('_', ' ')} planted near ${goal.from || 'the bot'} at ${cells[0]}: no tree cut about here to plant again`);
      }
    }
  }
  save?.();
  return true;
}

module.exports = { LOG, SAPLING, STAND, gatherAll, treeLogs, stumpOf, standFor, withinArm, cutInReach, digUnder, lowerStand, clearLeftStands, fellFromStands,
  plantCells, spotsNear, stumpTaken, replant, replantOwed, replantStep, owe, forget, owedHere, loadOwed, saveOwed, lyingLow, noteFelled, felledHere, toStump, FOUR, FELLED_MS, room, clearLaidAbout };
