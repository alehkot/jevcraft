'use strict';
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { position } = require('./memory');
const point = p => new Vec3(p.x, p.y, p.z);
const blocked = message => Object.assign(new Error(message), { name: 'Blocked', needsPlayer: true });
const WORK_RADIUS = 6;
const aliases = { workbench: 'crafting_table', bench: 'crafting_table' };

// Detach the location before resolving what is being made. A crafting table
// in "make a chest beside the closest crafting table" is never a second output.
function splitLocation(text, registry) {
  const leading = /^(?:right\s+)?(?:next to|beside|alongside|near|at|by)\s+([^,]+),\s*(.+)$/i.exec(text.trim());
  const match = leading ? [null, leading[2], leading[1]] :
    /^(.+?)\s+(?:right\s+)?(?:next to|beside|alongside|near|at|by)\s+(.+?)\s*[.!?]*$/i.exec(text.trim());
  if (!match) return null;
  const raw = match[2].toLowerCase().replace(/[’‘]/g, "'").replace(/^(?:the|a|an) /, '');
  const aimed = /^(?:(?:block|spot|thing) (?:that )?i(?:'m| am) (?:pointing|looking|aiming) at|(?:what|where) i(?:'m| am) (?:pointing|looking)(?: at)?|this block)$/.test(raw);
  const named = raw.replace(/^(?:nearest|closest) /, '').replace(/ (?:nearest|closest) to me$| (?:to me|near me)$/, '').replaceAll(' ', '_');
  const name = aliases[named] || named;
  if (!aimed && !/\b(?:nearest|closest)\b/.test(raw) && !registry.blocksByName[name] && !/^(\w+_)?tree$/.test(name) && !registry.entitiesByName?.[name]) return null;
  return { task: match[1].trim(), name, aimed };
}

// A named landmark makes "find a furnace" a request to locate the block
// already there. The block registry can settle that without guessing a recipe.
function discoveryAt(text, registry) {
  const search = /^(?:please )?(?:find|locate|look for|search for) (?:an? |the |some )?(?:existing )?([a-z][a-z_ ]*?)[.!?]?$/i.exec(text.trim());
  if (!search) return null;
  const name = search[1].trim().toLowerCase().replaceAll(' ', '_');
  if (registry.blocksByName[name]) return { kind: 'block', name };
  if (registry.entitiesByName?.[name]) return { kind: 'entity', name };
  return null;
}

function treeBase(bot, block) {
  const p = block.position, type = block.name;
  if (bot.blockAt(p.offset(0, -1, 0))?.name === type || bot.blockAt(p.offset(0, 1, 0))?.name !== type ||
      require('./built').leftAlone(bot, {}, p)) return false;
  // A trunk has a crown. A bare log pillar is not a tree landmark.
  for (let y = 2; y <= 32; y++) {
    for (const [x, z] of [[0,0], [1,0], [-1,0], [0,1], [0,-1]]) {
      if (bot.blockAt(p.offset(x, y, z))?.name.endsWith('_leaves')) return true;
    }
    if (bot.blockAt(p.offset(0, y, 0))?.name !== type) break;
  }
  return false;
}

function resolveLocation(bot, from, ref) {
  const player = bot.players[from]?.entity;
  if (!player?.position) throw blocked(`I need ${from} in view to see which spot they mean.`);
  const origin = player.position, dimension = bot.game.dimension;
  let selected, name, tree = false, kind = 'block';
  if (ref.aimed) {
    const yaw = Number.isFinite(player.headYaw) ? player.headYaw : player.yaw, pitch = player.pitch;
    if (Number.isFinite(yaw) && Number.isFinite(pitch)) {
      const eye = origin.offset(0, player.eyeHeight || (player.height || 1.8) * .9, 0);
      const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      const hit = bot.world.raycast(eye, direction, 32);
      if (hit) { selected = hit.position; name = hit.name; }
    }
    if (!selected) throw blocked('Point at a visible block and ask me again so I can mark it.');
  } else {
    tree = ref.name === 'tree' || ref.name.endsWith('_tree');
    const species = tree && ref.name.replace(/_?tree$/, '');
    const blocks = tree ? bot.registry.blocksArray.filter(b => /_log$/.test(b.name) && !b.name.startsWith('stripped_') && (!species || b.name === `${species}_log`)) :
      [bot.registry.blocksByName[ref.name]].filter(Boolean);
    if (blocks.length) {
      const found = bot.findBlocks({ point: origin, matching: blocks.map(b => b.id), maxDistance: 64, count: 16,
        ...(tree && { useExtraInfo: b => treeBase(bot, b) }) });
      selected = found.sort((a, b) => a.offset(.5,.5,.5).distanceTo(origin) - b.offset(.5,.5,.5).distanceTo(origin))[0];
      if (selected) name = bot.blockAt(selected).name;
    } else if (bot.registry.entitiesByName?.[ref.name]) {
      const found = Object.values(bot.entities).filter(e => e.name === ref.name && e.isValid !== false && e.position?.distanceTo(origin) <= 64);
      selected = found.sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin))[0]?.position.floored();
      name = ref.name; kind = 'entity';
    }
    if (!selected) throw blocked(`I can't find a ${ref.name.replaceAll('_', ' ')} near you in the loaded world. You can point at a block instead.`);
  }
  return { dimension, position: position(selected), name: tree ? name.replace(/_log$/, '_tree') : name, kind, tree };
}

// Gather and hand-craft the requested outputs at the site. Ingredients for
// those outputs may come from farther away.
function forOutput(goal, item) {
  return item && goal?.workSite && (goal.siteOutputs ? goal.siteOutputs.includes(item) : item === goal.item) ? goal.workSite : null;
}

function within(site, p) {
  return !site || point(site.position).distanceTo(p) <= WORK_RADIUS;
}

function protects(site, p) {
  if (!site || site.kind !== 'block') return false;
  const at = site.position;
  return site.tree ? Math.abs(p.x - at.x) <= 1 && Math.abs(p.z - at.z) <= 1 && p.y >= at.y - 1 && p.y <= at.y + 32 :
    p.x === at.x && p.z === at.z && p.y === at.y;
}

async function approach(bot, task, site, navigate) {
  if (bot.game.dimension !== site.dimension) throw blocked('The spot you chose is in another dimension. Resume there to use it.');
  const at = point(site.position);
  if (bot.entity.position.distanceTo(at) > 3.8) await navigate(bot, task, new goals.GoalNear(at.x, at.y, at.z, 3));
  if (bot.entity.position.distanceTo(at) > 4.5) throw blocked(`I cannot reach the spot beside ${site.name.replaceAll('_', ' ')}.`);
}

function stations(bot, name, site) {
  const at = point(site.position);
  if (site.name === name && site.kind === 'block') {
    const block = bot.blockAt(at);
    if (block && block.name !== name) throw blocked(`The ${name.replaceAll('_', ' ')} you chose has gone. Please choose a new spot.`);
    return [at];
  }
  return bot.findBlocks({ point: at, matching: bot.registry.blocksByName[name].id, maxDistance: 4, count: 8 });
}

module.exports = { WORK_RADIUS, forOutput, within, splitLocation, discoveryAt, resolveLocation, protects, approach, stations };
