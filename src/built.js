'use strict';
// What someone built is left alone. On a live server (2026-11-21), asked
// for 16 oak logs 48 blocks from a village, the bot took the corner posts of
// two houses: the nearest oak in view, with free trees 8 to 13 blocks
// further off. The rule the player it happened to asked for: what is built
// is left alone, unless a player asks for it or there is no really good
// other way to the goal.
//
// Switched on with JEV_BUILT (unset or anything else: the bot takes what is
// nearest, as before):
//   leave   built things are not taken. The two ways round it: the player
//           says the buildings may be used (session.js, guide.js: the goal's
//           allowBuilt), or the search for a free source of one thing has
//           gone LAST_RESORT_LEGS steps over LAST_RESORT_MS or more with
//           none of it gained, or is about to be given up, and a built
//           source of it was seen (lastResort: that one kind of block is
//           then taken, and it is said in chat as it happens).
//   strict  the same without the last resort: only the player's word.
//
// What counts as built is read from the blocks alone, in the Overworld:
//   a made thing: planks, stairs, a slab, a fence, a door, glass, bricks, a
//     bed, a chest, a torch. None of it grows; where the bot did not lay it
//     itself (own-blocks.js) someone else did, a villager's house, a
//     player's, a mine's timbers.
//   a block of the ground's own kinds (a log, cobblestone, terracotta) with
//     NEAR or more made things of a wall, floor or roof in the 5x5x5 cells
//     round it: a house's corner post, its footing.
// Ore and what grows are never part of a building: a mine's timbers beside
// an iron vein do not close the vein, and a village's ripe wheat is taken
// and sown again as before (villages.js).
//
// The numbers are from the village the report came from (the blocks within
// 90 of the spawn read from the region files, scripts/built-test.js): of
// its 2,136 plain logs, 591 have no block of a wall, floor or roof within
// two cells and 42 have one; with NEAR at 3, 1,495 are part of something
// built and 641 are free.
const { Vec3 } = require('vec3');

const RADIUS = 2;
// Made blocks of a building within RADIUS that make a natural block part of it.
const NEAR = 3;
// The search steps and the time a search has gone with none of the thing
// gained, both needed before a built source of it is taken after all. The
// steps alone were not a search: on a copy of the live world (2026-11-21) 24
// of them took 170 seconds, and four planks came out of a house wall three
// minutes after the table they were for was asked, with birches 20 blocks
// off. BREAK_MS without a search step starts the count again (the bot was
// stopped, or did something else). GIVE_UP_LEGS: the search's own count on
// its last steps before it is given up as blocked (work.js explore, 128).
const LAST_RESORT_LEGS = 24, LAST_RESORT_MS = 10 * 60000, BREAK_MS = 5 * 60000, GIVE_UP_LEGS = 120;
const FRESH_MS = 15000, SEEN_MS = 45 * 60000;

const mode = () => { const v = String(process.env.JEV_BUILT || '').trim().toLowerCase(); return v === 'leave' || v === 'strict' ? v : 'take'; };
const on = () => mode() !== 'take';
const overworld = bot => /overworld/.test(String(bot?.game?.dimension || 'overworld'));
const words = name => String(name || '').replaceAll('_', ' ');

// A wall, a floor, a roof, a window: what a building is made of.
const STRUCTURE = /_planks$|_stairs$|_slab$|_fence$|_fence_gate$|_wall$|_door$|_trapdoor$|glass|brick|_tiles$|^stripped_|^polished_|^chiseled_|^cut_|^cracked_|^smooth_(?!basalt)|_pillar$|concrete|_wool$|(?<!moss)_carpet$|glazed_terracotta|^quartz_block$|^iron_bars$|^waxed_|^(exposed|weathered|oxidized)_/;
// What stands in or on one. A camp has these beside a tree (a table, a
// furnace, a chest, a torch, a bed), so they are someone's where they
// stand and do not make the tree a building.
const FURNITURE = /_bed$|torch$|lantern$|^chest$|^trapped_chest$|^barrel$|shulker_box$|^crafting_table$|furnace$|^smoker$|^loom$|^stonecutter$|^grindstone$|^smithing_table$|^fletching_table$|^cartography_table$|^lectern$|^composter$|cauldron$|^brewing_stand$|anvil$|^bell$|^enchanting_table$|^jukebox$|^note_block$|campfire$|^flower_pot$|^potted_|^ladder$|^scaffolding$|_sign$|_banner$|bookshelf$|^hay_block$|candle$|rail$|^hopper$|^dispenser$|^dropper$|^observer$|piston$|^lever$|_button$|_pressure_plate$|^redstone_(lamp|wire)$|^repeater$|^comparator$|^target$|^tnt$|^beacon$|^end_rod$|chain$|_head$|_skull$|^decorated_pot$|^lightning_rod$|^beehive$|^lodestone$|cake$|^tripwire/;
const FLOWERS = new Set((() => { try { return require('../data/vanilla-26.1.json').resourceTags?.flowers || []; } catch (_) { return []; } })());
const GROWS = /_ore$|^ancient_debris$|_leaves$|_sapling$|_stem$|_vines(_plant)?$|^(wheat|carrots|potatoes|beetroots|melon|pumpkin|sugar_cane|cactus|cactus_flower|bamboo|kelp|kelp_plant|seagrass|tall_seagrass|short_grass|tall_grass|short_dry_grass|tall_dry_grass|fern|large_fern|dead_bush|bush|firefly_bush|leaf_litter|vine|lily_pad|sweet_berry_bush|cocoa|nether_wart|cobweb|snow|brown_mushroom|red_mushroom|moss_carpet|pale_moss_carpet|glow_lichen|sea_pickle|wildflowers|pink_petals|hanging_roots|spore_blossom|azalea|flowering_azalea|big_dripleaf|small_dripleaf)$/;
const NOTHING = /^(air|cave_air|void_air|water|lava|bubble_column|fire|soul_fire)$/;
// A tree's stem is wood like a log; a melon's is a plant.
const structure = name => STRUCTURE.test(name);
const made = name => STRUCTURE.test(name) || FURNITURE.test(name);
const grows = name => (GROWS.test(name) && !/^(crimson|warped)_stem$|^stripped_|^potted_/.test(name)) || FLOWERS.has(name);

// The kind of block at a cell, by its state where the world gives one (no
// Block is built for each of the 124 cells read round a candidate).
function reader(bot) {
  const world = bot.world, byState = bot.registry?.blocksByStateId, at = new Vec3(0, 0, 0);
  if (world && typeof world.getBlockStateId === 'function' && byState) {
    return (x, y, z) => { at.x = x; at.y = y; at.z = z; try { return byState[world.getBlockStateId(at)]?.name; } catch (_) { return undefined; } };
  }
  return (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z))?.name; } catch (_) { return undefined; } };
}
const laidRecords = (bot, goal) => !!(bot._laid?.size || (goal?.laid && Object.keys(goal.laid).length));
function own(bot, p, goal) {
  if (!laidRecords(bot, goal)) return false;
  try { return !!require('./own-blocks').laidAt(bot, p, goal); } catch (_) { return false; }
}

// The made blocks of a building in the cells round p, the bot's own not
// counted, read no further than `enough`.
function structureRound(bot, p, { goal = null, read = reader(bot), enough = NEAR, radius = RADIUS } = {}) {
  const mine = laidRecords(bot, goal);
  let n = 0;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    if (!dx && !dy && !dz) continue;
    const name = read(p.x + dx, p.y + dy, p.z + dz);
    if (!name || !STRUCTURE.test(name)) continue;
    if (mine && own(bot, new Vec3(p.x + dx, p.y + dy, p.z + dz), goal)) continue;
    if (++n >= enough) return n;
  }
  return n;
}

// Is the block at p part of something built by someone else? Kept for
// FRESH_MS: a search asks it of every log in view, each time it looks.
function builtAt(bot, p, goal = bot?._goal) {
  if (!p || !bot || !overworld(bot)) return false;
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), k = `${x},${y},${z}`;
  const kept = bot._builtKept ||= new Map(), now = Date.now(), hit = kept.get(k);
  if (hit && now - hit.at < FRESH_MS) return hit.built;
  const read = reader(bot), name = read(x, y, z), cell = new Vec3(x, y, z);
  const built = !!name && !NOTHING.test(name) && !grows(name) && !own(bot, cell, goal) &&
    (made(name) || structureRound(bot, cell, { goal, read }) >= NEAR);
  if (kept.size >= 8192) kept.clear();
  kept.set(k, { at: now, built });
  return built;
}

// The player's word: this goal may use what is built.
const allowed = goal => !!(goal && goal.allowBuilt);
const family = name => /_log$|_stem$|_wood$|_hyphae$/.test(name || '') ? 'wood' : name;
// The last resort taken for this kind of block, and no other.
const opened = (goal, name) => !!(goal?.builtLastResort && name && goal.builtLastResort[family(name)]);
// The question every search and every chosen block is put to.
function leftAlone(bot, goal, p) {
  if (!on() || allowed(goal) || !builtAt(bot, p, goal)) return false;
  return !(goal?.builtLastResort && opened(goal, reader(bot)(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))));
}

// A source passed over because it is built, kept with the goal: what the
// line in chat and the last resort are about.
function noteSkipped(bot, goal, resource, cells) {
  if (!goal || typeof goal !== 'object' || !resource || !cells?.length) return;
  const read = reader(bot);
  (goal.builtSeen ||= {})[resource] = { at: Date.now(), cells: cells.slice(0, 8).map(p => ({ x: p.x, y: p.y, z: p.z, name: read(p.x, p.y, p.z) || resource })) };
}
function seenFor(goal, resource, now = Date.now()) {
  const seen = goal?.builtSeen;
  if (!seen || !resource) return null;
  const key = seen[resource] ? resource : Object.keys(seen).find(k => family(k) === family(resource));
  const entry = key && seen[key];
  return entry && now - entry.at < SEEN_MS ? entry : null;
}

// Said once a goal and resource, when what is in view is built and the
// search goes elsewhere: the player learns why, and how to say otherwise.
function hint(bot, goal, resource) {
  if (!on() || allowed(goal) || opened(goal, resource) || !seenFor(goal, resource)) return false;
  const said = goal.builtSaid ||= {};
  if (said[family(resource)]) return false;
  said[family(resource)] = Date.now();
  const what = family(resource) === 'wood' ? 'wood' : words(resource), many = /s$/.test(what);
  try { bot.chat?.(`All the ${what} I can see here ${many ? 'are' : 'is'} part of something built, so I'll leave ${many ? 'them' : 'it'} and look further. Say "${bot.username || 'Jev'} use the buildings" if I may take ${many ? 'them' : 'it'} from there.`); } catch (_) { /* not connected */ }
  return true;
}

// The built sources passed over, made known to the search again
// (resource-observation.js), which walks back to the nearest: the bot may
// have gone a long way looking for a free one.
function recall(bot, goal, resource = null) {
  const dimension = bot?.game?.dimension || 'overworld', memory = goal.resourceMemory ||= {};
  for (const [kind, entry] of Object.entries(goal.builtSeen || {})) for (const c of (!resource || family(kind) === family(resource) ? entry.cells || [] : [])) {
    memory[`${dimension}:${c.x},${c.y},${c.z}`] = { name: c.name, position: { x: c.x, y: c.y, z: c.z }, dimension, seenAt: Date.now() };
  }
}

// "Jev stop" is the answer the line below asks for. A goal stopped with the
// last resort open has it closed, and taken up again does not open it a
// second time: from there on only the player's word does. True when closed.
function refuse(goal) {
  if (!goal || typeof goal !== 'object' || !goal.builtLastResort) return false;
  delete goal.builtLastResort; delete goal.builtWait;
  goal.builtRefused = new Date().toISOString();
  return true;
}

// What the bot carries of a thing (for wood, any log), to see a search gain some.
function carriedOf(bot, resource, names = []) {
  const wanted = new Set([resource, ...names]), wood = family(resource) === 'wood';
  try { return (bot.inventory?.items() || []).filter(i => wood ? /_log$|_stem$/.test(i.name) : wanted.has(i.name)).reduce((n, i) => n + i.count, 0); } catch (_) { return null; }
}
// The count of one fruitless search, kept with the goal and apart from the
// search's own (work.js turnSearch sets that back to 0 at every stall):
// started again when some of the thing is gained and after BREAK_MS without
// a step.
function waited(goal, resource, carried, now) {
  const waits = goal.builtWait ||= {}, key = family(resource);
  let wait = waits[key];
  if (!wait || now - wait.last > BREAK_MS || (carried !== null && Number.isFinite(wait.carried) && carried > wait.carried)) wait = waits[key] = { since: now, legs: 0 };
  wait.legs++; wait.last = now; wait.carried = carried;
  return wait;
}

// Asked at every step of a search (work.js explore). The search for a free
// source of this has come to nothing, LAST_RESORT_LEGS steps over
// LAST_RESORT_MS or more, or is on its last steps before it is given up,
// and a built source of it was seen: that one kind is taken after all, and
// said. True when this call opened it.
function lastResort(bot, goal, resource, search, { names = [], now = Date.now() } = {}) {
  if (mode() !== 'leave' || !goal || typeof goal !== 'object' || !resource || allowed(goal) || goal.builtRefused || opened(goal, resource)) return false;
  const wait = waited(goal, resource, carriedOf(bot, resource, names), now);
  const seen = seenFor(goal, resource, now);
  if (!seen) return false;
  const searched = wait.legs >= LAST_RESORT_LEGS && now - wait.since >= LAST_RESORT_MS;
  if (!searched && !((search?.attempts || 0) >= GIVE_UP_LEGS)) return false;
  const minutes = Math.max(1, Math.round((now - wait.since) / 60000));
  const entry = { at: new Date(now).toISOString(), resource, legs: wait.legs, minutes };
  // Opened by the names of what was passed over: asked for cobblestone, it is a footing's stone that is taken.
  for (const name of new Set([resource, ...(seen.cells || []).map(c => c.name)])) (goal.builtLastResort ||= {})[family(name)] = entry;
  delete goal.builtWait[family(resource)];
  recall(bot, goal, resource);
  if (search) { search.attempts = 0; delete search.observedTarget; }
  // What is near to plan with is looked at again (work.js catalogPlan).
  if (bot) delete bot._catalogObservation;
  const what = family(resource) === 'wood' ? 'wood' : words(resource), many = /s$/.test(what);
  try { bot.chat?.(`I have looked for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} and found no free ${what}, so I'll take ${many ? 'them' : 'it'} from the buildings after all. Say "${bot.username || 'Jev'} stop" if you'd rather I didn't.`); } catch (_) { /* not connected */ }
  return true;
}

// The free wood round the bot, for the language layer (guide.js): each kind
// with the trees of it (a trunk of three logs or more, counted at its foot),
// the single logs (a bush's one log under its leaves, a stump) and how near.
// Kinds with trees first, nearest first. At the spawn the report came from,
// "get wood" was passed on as oak, of which the 48 blocks round it held 53
// bushes, no tree, and the houses; five birches stood within 48, the nearest
// 16 off.
function woodInView(bot, goal, { reach = 48 } = {}) {
  const here = bot?.entity?.position;
  if (!here || typeof bot.findBlocks !== 'function' || !bot.registry?.blocksArray) return [];
  const ids = bot.registry.blocksArray.filter(b => /_log$/.test(b.name) && !/^stripped_/.test(b.name)).map(b => b.id);
  let found = [];
  try { found = bot.findBlocks({ matching: ids, maxDistance: reach, count: 256, useExtraInfo: b => !leftAlone(bot, goal, b.position) }) || []; } catch (_) { return []; }
  const read = reader(bot), kinds = new Map();
  for (const p of found) {
    const name = read(p.x, p.y, p.z);
    if (!name || !/_log$/.test(name) || read(p.x, p.y - 1, p.z) === name) continue;
    let height = 1; while (height < 8 && read(p.x, p.y + height, p.z) === name) height++;
    const wood = words(name.replace(/_log$/, '')), off = Math.round(p.distanceTo(here));
    const kind = kinds.get(wood) || { wood, trees: 0, nearestTreeBlocks: null, singleLogs: 0, nearestLogBlocks: null };
    if (height >= 3) { kind.trees++; kind.nearestTreeBlocks = Math.min(kind.nearestTreeBlocks ?? Infinity, off); }
    else { kind.singleLogs++; kind.nearestLogBlocks = Math.min(kind.nearestLogBlocks ?? Infinity, off); }
    kinds.set(wood, kind);
  }
  const near = k => k.trees ? k.nearestTreeBlocks : 1000 + (k.nearestLogBlocks ?? 0);
  // Said short: what a kind has none of is left out, but for "trees": 0.
  return [...kinds.values()].sort((a, b) => near(a) - near(b)).slice(0, 5).map(k => ({ wood: k.wood, trees: k.trees,
    ...(k.trees && { nearestTreeBlocks: k.nearestTreeBlocks }), ...(k.singleLogs && { singleLogs: k.singleLogs, nearestLogBlocks: k.nearestLogBlocks }) }));
}

// The player said the buildings may be used for this goal.
function permit(bot, goal, by) {
  if (!goal || typeof goal !== 'object') return false;
  goal.allowBuilt = { by: by || null, at: new Date().toISOString() };
  recall(bot, goal);
  // What is near to plan with is looked at again (work.js catalogPlan).
  if (bot) delete bot._catalogObservation;
  return true;
}

module.exports = { mode, on, made, structure, grows, structureRound, builtAt, allowed, leftAlone, noteSkipped, seenFor, hint, lastResort, refuse, permit, recall, woodInView,
  RADIUS, NEAR, LAST_RESORT_LEGS, LAST_RESORT_MS, BREAK_MS, GIVE_UP_LEGS };
