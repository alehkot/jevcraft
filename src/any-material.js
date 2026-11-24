'use strict';
// A house or a shelter asked for with no material named is built of whatever
// blocks are quickest here (asked for on 2026-11-24): what is asked for is the
// layout and what is in it, the doors, the windows, the light, the beds and a
// roof over them, not the blocks of its floor, walls and roof. Dirt,
// cobblestone, planks or a mix of them all do, the first nights above all.
//
// The plan still names a real block in every cell: the gathering, the batch
// and the placing go by it. The plain cells of the shell are marked flexible
// (markShell), and those not built yet are painted again before each batch
// and at each step of its gathering (paint, repaintBatch): the blocks carried
// first, cheapest first, the rest one material gathered for the whole
// building (supplyFor): cobblestone where a stone pickaxe is carried and stone
// lies open nearby, else dirt, else the design's own. A flexible cell holding
// any sound full block is built (fills): a grass floor, a hillside wall, a
// wall a player put up there. The building's notes count it as the
// building's own (build-blocks.js matchesBuildBlock, home-base.js jevBuilt).
const { Vec3 } = require('vec3');

// The shell blocks of a design that any sound block may stand in for.
const SHELL = /_planks$|_terracotta$|_concrete$|^(?:cobblestone|mossy_cobblestone|cobbled_deepslate|stone|smooth_stone|stone_bricks|dirt|coarse_dirt|sandstone|red_sandstone|smooth_sandstone|bricks|mud_bricks|packed_mud|andesite|diorite|granite|tuff|deepslate|blackstone|netherrack|nether_bricks|end_stone|terracotta)$/;
// Full blocks that do not stand as a wall, a floor or a roof: what falls,
// melts, decays or hurts, what is a thing of its own (a table, a furnace, a
// chest), and an ore, worth more mined.
const UNSOUND = /_leaves$|_concrete_powder$|_ore$|^infested_|shulker_box$|_mushroom_block$|^(?:sand|red_sand|gravel|suspicious_sand|suspicious_gravel|ice|packed_ice|blue_ice|frosted_ice|magma_block|tnt|slime_block|honey_block|soul_sand|mud|farmland|dirt_path|powder_snow|cactus|spawner|trial_spawner|vault|bee_nest|beehive|budding_amethyst|ancient_debris|melon|pumpkin|carved_pumpkin|jack_o_lantern|hay_block|sponge|wet_sponge|bookshelf|chiseled_bookshelf|note_block|jukebox|dispenser|dropper|observer|crafter|target|lodestone|respawn_anchor|beacon|sculk|sculk_catalyst|sculk_shrieker|reinforced_deepslate|end_portal_frame|crafting_table|smithing_table|fletching_table|cartography_table|loom|barrel|furnace|blast_furnace|smoker|chest|trapped_chest|ender_chest|enchanting_table|piston|sticky_piston|mushroom_stem|command_block|chain_command_block|repeating_command_block|structure_block|jigsaw|barrier)$/;
// The blocks carried go into the shell in this order, cheapest first: what
// has no other use first. Planks come last, and only past PLANKS_KEPT less
// what the logs carried make: the doors, the sofa, the chest, the beds and
// the torches' sticks are planks (about 35 of them for a starter house).
const FILLER = ['dirt', 'coarse_dirt', 'rooted_dirt', 'netherrack', 'cobblestone', 'cobbled_deepslate', 'blackstone', 'andesite', 'diorite',
  'granite', 'tuff', 'calcite', 'stone', 'deepslate', 'basalt', 'smooth_basalt', 'end_stone', 'sandstone', 'red_sandstone', 'terracotta',
  'packed_mud', 'mud_bricks', 'mossy_cobblestone', 'stone_bricks', 'bricks', 'nether_bricks'];
const PLANKS_KEPT = 36;
// Open blocks of a source within REACH of the site before it is gathered
// from rather than another.
const REACH = 16, ENOUGH = 12;
const DIRT = ['grass_block', 'dirt', 'podzol', 'mycelium'];
const STONE_PICK = /^(?:stone|copper|iron|diamond|netherite)_pickaxe$/;
// What only a pickaxe gathers: chosen again if none is carried any more.
const PICKED = new Set(['cobblestone', 'sandstone']);
// Words that name what a house is to be made of. Used where a request is read
// for a house (house-details.js houseRequest, objectives.js interpret).
const MATERIAL_WORDS = /\b(?:wood(?:en)?|planks?|logs?|timber|lumber|stones?|cobble(?:stone)?|bricks?|dirt|mud|sand(?:stone)?|concrete|terracotta|clay|glass|deepslate|blackstone|quartz|wool|granite|diorite|andesite|tuff|copper|iron|gold(?:en)?|diamonds?|emeralds?|obsidian|netherrack|prismarine|purpur|snow|ice)\b/;
const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(-1, 0, 0), new Vec3(1, 0, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1)];
const air = b => !!b && ['air', 'cave_air', 'void_air'].includes(b.name);
const key = p => `${p.x},${p.y},${p.z}`;

function namesMaterial(text, registry) {
  const t = String(text || '').toLowerCase();
  if (MATERIAL_WORDS.test(t)) return true;
  const woods = registry ? Object.keys(registry.itemsByName).filter(n => n.endsWith('_planks')).map(n => n.slice(0, -7)) : [];
  return woods.some(w => new RegExp('\\b' + w.replaceAll('_', '[ _-]') + '\\b').test(t));
}

const fullCube = b => b?.boundingBox === 'block' && Array.isArray(b.shapes) &&
  b.shapes.some(([x, y, z, X, Y, Z]) => x === 0 && y === 0 && z === 0 && X === 1 && Y === 1 && Z === 1);
// A block that stands as a cell of the shell, whoever put it there.
function fills(block) {
  return !!block?.name && fullCube(block) && !UNSOUND.test(block.name);
}

const plainCell = c => !c.companion && !(c.properties && Object.keys(c.properties).length) && SHELL.test(c.material);
// Mark the shell of the goal's plan flexible, once: the count newly marked.
// The design's own shell block is kept as the last resort to gather.
function markShell(goal) {
  const cells = goal.blueprint?.blocks || [], counts = {};
  let marked = 0;
  for (const c of cells) {
    if (!c.flexible && !plainCell(c)) continue;
    if (!c.flexible) { c.flexible = true; marked++; }
    counts[c.material] = (counts[c.material] || 0) + 1;
  }
  if (!goal.shellNominal && Object.keys(counts).length) goal.shellNominal = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  return marked;
}

// The blocks carried that may go into the shell, in the order they go.
function carriedFiller(bot) {
  const held = new Map();
  for (const i of bot.inventory?.items?.() || []) held.set(i.name, (held.get(i.name) || 0) + i.count);
  const stock = new Map();
  for (const name of FILLER) if (held.get(name) > 0) stock.set(name, held.get(name));
  const logs = [...held].filter(([n]) => /_(?:log|wood|stem|hyphae)$/.test(n)).reduce((total, [, count]) => total + count, 0);
  let kept = Math.max(0, PLANKS_KEPT - 4 * logs);
  for (const [name, count] of [...held].filter(([n]) => n.endsWith('_planks')).sort((a, b) => b[1] - a[1])) {
    const keep = Math.min(kept, count);
    kept -= keep;
    if (count > keep) stock.set(name, count - keep);
  }
  return stock;
}

// Open blocks of these kinds near the site, those of the site itself left out.
function openNear(bot, goal, names, at) {
  const ids = names.map(n => bot.registry?.blocksByName?.[n]?.id).filter(id => id !== undefined);
  if (!ids.length || typeof bot.findBlocks !== 'function') return 0;
  const { reservedForConstruction } = require('./build-sites');
  try {
    return (bot.findBlocks({ point: at, matching: ids, maxDistance: REACH, count: 32,
      useExtraInfo: b => FACES.some(f => air(bot.blockAt(b.position.plus(f)))) && !reservedForConstruction(goal, b.position) }) || []).length;
  } catch (_) { return 0; }
}

// The one block gathered for what the pack does not cover, chosen once for the
// building and kept on the goal (goal.shellSupply), so the walls do not
// change from batch to batch with what happens to be in view.
function supplyFor(bot, goal) {
  const carried = (bot.inventory?.items?.() || []).map(i => i.name);
  const pick = carried.some(n => STONE_PICK.test(n)), shovel = carried.some(n => /_shovel$/.test(n));
  const kept = goal.shellSupply;
  if (kept && (!PICKED.has(kept) || pick)) return kept;
  const o = goal.blueprint?.origin, at = o ? new Vec3(o.x, o.y, o.z) : bot.entity?.position;
  const dirt = () => openNear(bot, goal, DIRT, at) >= ENOUGH;
  const stone = () => pick && openNear(bot, goal, ['stone'], at) >= ENOUGH;
  const sandstone = () => pick && openNear(bot, goal, ['sandstone'], at) >= ENOUGH;
  // What a player's own walls are made of, built round (player-build.js), when it is to be had here.
  const theirs = { cobblestone: stone, dirt, sandstone }[goal.shellPrefer];
  const choice = theirs?.() ? goal.shellPrefer : shovel && dirt() ? 'dirt' : stone() ? 'cobblestone' : dirt() ? 'dirt' : sandstone() ? 'sandstone' : goal.shellNominal || 'dirt';
  goal.shellSupply = choice;
  return choice;
}

// What a player's own walls are made of goes first when carried, so new walls round theirs match (player-build.js).
const preferred = (stock, name) => name && stock.get(name) > 0 ? new Map([[name, stock.get(name)], ...[...stock].filter(([n]) => n !== name)]) : stock;

// Paint the flexible cells among these for what is carried now, lowest first:
// a cell keeps a block it was painted with while the pack still holds one for
// it; the others take the cheapest block carried, else the supply. The count
// of cells changed.
function paint(bot, goal, cells) {
  const open = cells.filter(c => c.flexible && !c.companion).sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
  if (!open.length) return 0;
  const stock = preferred(carriedFiller(bot), goal.shellPrefer), left = [];
  for (const c of open) {
    if (c.painted && stock.get(c.material) > 0) stock.set(c.material, stock.get(c.material) - 1);
    else left.push(c);
  }
  let changed = 0, supply = null;
  for (const c of left) {
    let material = [...stock].find(([, count]) => count > 0)?.[0];
    if (material) stock.set(material, stock.get(material) - 1);
    else material = supply ||= supplyFor(bot, goal);
    if (c.material !== material) { c.material = material; changed++; }
    c.painted = true;
  }
  return changed;
}

// The batch's cells not built yet, painted again for what is carried now (a
// player's drop, what the gathering brought), and the plan's own cells with
// them: after a restart the batch holds copies.
function repaintBatch(bot, goal, batch) {
  const { remainingBuildBatch, materialCounts } = require('./build-batch');
  const left = remainingBuildBatch(bot, batch);
  const changed = paint(bot, goal, left);
  if (!changed) return 0;
  const planned = new Map((goal.blueprint?.blocks || []).map(c => [key(c), c]));
  for (const c of left) {
    const own = c.flexible && planned.get(key(c));
    if (own && own !== c) { own.material = c.material; own.painted = true; }
  }
  batch.outputs = materialCounts(left);
  return changed;
}

module.exports = { SHELL, FILLER, PLANKS_KEPT, namesMaterial, fills, markShell, carriedFiller, supplyFor, paint, repaintBatch };
