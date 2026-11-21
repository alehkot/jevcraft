'use strict';
const { woodInView } = require('./built');
const { buildPalette, validateSchematic } = require('./designer');
const { Vec3 } = require('vec3');
const { isBed, buildFootprint, buildCellComplete } = require('./build-blocks');
const { woolCarried } = require('./home-base');

// One room, an aisle from the door to every bed, and a closed roof. The
// one-block windows need no glass, so the shell can be built with hand-cut wood.
function starterHouse(sleepers, material, wood, beds) {
  if (![2, 3].includes(sleepers) || beds.length !== sleepers) throw new Error('A starter house has two or three beds');
  const width = sleepers + 3, door = `${wood}_door`;
  const regions = [];
  const fill = (from, to, block, properties) => regions.push({ from, to, block, ...(properties && { properties }) });
  fill([0, 0, 0], [width - 1, 3, 4], material);
  fill([1, 1, 1], [width - 2, 2, 3], 'air');
  fill([0, 2, 2], [0, 2, 2], 'air');
  fill([width - 1, 2, 2], [width - 1, 2, 2], 'air');
  fill([2, 1, 0], [2, 2, 0], 'air');
  fill([2, 1, 0], [2, 1, 0], door, { facing: 'south', half: null });
  for (const [index, x] of (sleepers === 2 ? [1, 3] : [1, 3, 4]).entries()) {
    fill([x, 1, 2], [x, 1, 2], beds[index], { facing: 'south', half: null });
  }
  return { name: `starter house for ${sleepers}`, description: 'A single room with a wooden door, two windows and a bed for each player.',
    size: [width, 4, 5], palette: [...new Set([material, door, ...beds])], regions, entrance: [2, 1, 0] };
}

function designStarterHouse(bot, goal) {
  const stock = bot.inventory.items();
  const validWood = wood => wood && bot.registry.itemsByName[`${wood}_door`];
  const carriedWood = stock.filter(i => /_(planks|log|stem)$/.test(i.name))
    .sort((a, b) => b.count - a.count).map(i => i.name.replace(/^stripped_|_(planks|log|stem)$/g, '')).find(validWood);
  let wood = goal.material?.endsWith('_planks') ? goal.material.slice(0, -7) : carriedWood;
  if (!validWood(wood)) wood = woodInView(bot, goal).map(w => w.wood.replaceAll(' ', '_')).find(validWood);
  if (!wood) return null;
  const material = goal.material || `${wood}_planks`;
  if (!buildPalette(bot.registry).includes(material) || /_(door|slab|stairs|bed)$/.test(material)) {
    throw Object.assign(new Error(`I need a full building block for the walls. You can ask for a ${wood.replaceAll('_', ' ')} plank house.`), { name: 'Blocked', needsPlayer: true });
  }
  // Bed colours are interchangeable for this request. Pick each one from
  // the supplies actually on hand when it is time to furnish the room.
  const design = starterHouse(goal.starterBeds, material, wood, Array(goal.starterBeds).fill('white_bed'));
  return { ...validateSchematic(design, bot.registry), backend: 'starter-house', createdAt: new Date().toISOString() };
}

function useAvailableBed(bot, goal, foot) {
  const carried = bot.inventory.items().filter(i => isBed(i.name));
  const wool = woolCarried(bot);
  const material = (carried.find(i => i.name === foot.material) || carried[0])?.name ||
    (wool.count >= 3 ? `${wool.colour}_bed` : 'white_bed');
  return setBedMaterial(bot, goal, foot, material);
}

// A player can furnish their own spot, too. Accept a complete bed in the
// planned orientation without adding either half to Jev's block ownership.
function acceptPlacedBeds(bot, goal) {
  let changed = false;
  for (const foot of goal.blueprint.blocks.filter(p => p.properties?.part === 'foot')) {
    const material = bot.blockAt(new Vec3(foot.x, foot.y, foot.z))?.name;
    if (isBed(material) && material !== foot.material && buildCellComplete(bot, { ...foot, material })) {
      setBedMaterial(bot, goal, foot, material);
      changed = true;
    }
  }
  return changed;
}

function setBedMaterial(bot, goal, foot, material) {
  if (material === foot.material) return false;
  const { origin, blocks } = goal.blueprint;
  const source = structuredClone(goal.design.source);
  const region = source.regions.find(r => isBed(r.block) && r.from[0] + origin.x === foot.x &&
    r.from[1] + origin.y === foot.y && r.from[2] + origin.z === foot.z);
  region.block = material;
  source.palette = [...new Set(source.regions.map(r => r.block).filter(name => name !== 'air'))];
  Object.assign(goal.design, validateSchematic(source, bot.registry));
  for (const part of buildFootprint(foot)) {
    blocks.find(p => p.x === part.x && p.y === part.y && p.z === part.z).material = material;
  }
  delete goal.buildBatch;
  bot.buildRegistry?.remember(goal, { dimension: bot.game.dimension });
  return true;
}

module.exports = { starterHouse, designStarterHouse, useAvailableBed, acceptPlacedBeds };
