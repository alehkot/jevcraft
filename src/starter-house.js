'use strict';
const { woodInView } = require('./built');
const { buildPalette, validateSchematic } = require('./designer');
const { Vec3 } = require('vec3');
const { isBed, buildFootprint, buildCellComplete } = require('./build-blocks');
const { woolCarried } = require('./home-base');

// The aisle through the living room leads to a separate shared bedroom.
function starterHouse(sleepers, material, wood, beds) {
  if (![2, 3].includes(sleepers) || beds.length !== sleepers) throw new Error('A starter house has two or three beds');
  const door = `${wood}_door`, stairs = `${wood}_stairs`;
  const regions = [];
  const fill = (from, to, block, properties) => regions.push({ from, to, block, ...(properties && { properties }) });
  fill([0, 0, 0], [6, 3, 7], material);
  fill([1, 1, 1], [5, 2, 2], 'air');
  fill([1, 1, 4], [5, 2, 6], 'air');
  for (const z of [0, 3]) {
    fill([3, 1, z], [3, 2, z], 'air');
    fill([3, 1, z], [3, 1, z], door, { facing: 'south', half: null });
  }
  for (const p of [[0, 2, 2], [6, 2, 5]]) fill(p, p, 'glass');
  for (const p of [[5, 1, 2], [2, 1, 4]]) fill(p, p, 'torch');
  fill([1, 1, 1], [2, 1, 1], stairs, { facing: 'north', half: 'bottom' });
  fill([5, 1, 1], [5, 1, 1], 'chest', { facing: 'south', half: null });
  for (const [index, x] of (sleepers === 2 ? [1, 5] : [1, 3, 5]).entries()) {
    fill([x, 1, 5], [x, 1, 5], beds[index], { facing: 'south', half: null });
  }
  return { name: `starter house for ${sleepers}`, description: 'A roofed living room with a sofa and chest, a separate bedroom, working doors, glass windows and torchlight.',
    size: [7, 4, 8], palette: [...new Set([material, door, stairs, 'glass', 'torch', 'chest', ...beds])], regions, entrance: [3, 1, 0] };
}

function designStarterHouse(bot, goal) {
  const stock = bot.inventory.items();
  const validWood = wood => wood && bot.registry.itemsByName[`${wood}_door`];
  const carriedWood = stock.filter(i => /_(planks|log|stem)$/.test(i.name))
    .sort((a, b) => b.count - a.count).map(i => i.name.replace(/^stripped_|_(planks|log|stem)$/g, '')).find(validWood);
  let wood = goal.material?.endsWith('_planks') ? goal.material.slice(0, -7) : carriedWood;
  const preferred = goal.memoryContext?.preferences?.find(p => p.category === 'wood_species')?.value;
  if (!goal.material?.endsWith('_planks')) {
    const local = woodInView(bot, goal).map(w => w.wood.replaceAll(' ', '_')).filter(validWood);
    if (validWood(preferred) && (local.includes(preferred) || stock.some(i => i.name === preferred+'_planks' || i.name === preferred+'_log'))) wood = preferred;
    if (!validWood(wood)) wood = local[0];
  }
  const here = goal.workSite?.position || goal.buildAnchor || bot.entity.position;
  const biome = require('./discovery').biomeAt(bot, new Vec3(here.x, here.y, here.z));
  const sandy = /desert|badlands|beach/.test(biome);
  if (!wood && !sandy) return null;
  wood ||= 'oak';
  const sand = sandy && bot.findBlocks?.({ point: new Vec3(here.x, here.y, here.z), matching: [bot.registry.blocksByName.sand.id, bot.registry.blocksByName.sandstone.id], maxDistance: 24, count: 1 }).length;
  const material = goal.material || (sand ? 'sandstone' : `${wood}_planks`);
  if (!buildPalette(bot.registry).includes(material) || /_(door|slab|stairs|bed)$/.test(material)) {
    throw Object.assign(new Error(`I need a full building block for the walls. You can ask for a ${wood.replaceAll('_', ' ')} plank house.`), { name: 'Blocked', needsPlayer: true });
  }
  // Bed colours are interchangeable for this request. Pick each one from
  // the supplies actually on hand when it is time to furnish the room.
  const design = starterHouse(goal.starterBeds, material, wood, Array(goal.starterBeds).fill('white_bed'));
  return { ...validateSchematic(design, bot.registry), backend: 'starter-house', createdAt: new Date().toISOString() };
}

function checkStarterDesign(design, { sleepers, material }) {
  const { source, blocks, materials } = design, [w, h, d] = source.size;
  const cell = (x, y, z) => blocks.find(p => p.x === x && p.y === y && p.z === z);
  const doors = blocks.filter(p => p.properties?.half === 'lower' && p.material.endsWith('_door'));
  const beds = blocks.filter(p => p.properties?.part === 'foot');
  const seats = blocks.filter(p => p.material.endsWith('_stairs') && p.properties?.half === 'bottom');
  const chest = blocks.find(p => p.material === 'chest' && !cell(p.x, p.y + 1, p.z));
  const entrance = source.entrance && cell(...source.entrance);
  const windows = blocks.filter(p => /^(?:\w+_stained_)?glass$/.test(p.material) && (p.x === 0 || p.z === 0 || p.x === w - 1 || p.z === d - 1));
  const covered = p => blocks.some(q => q.x === p.x && q.z === p.z && q.y > p.y + 1 && !q.companion && q.material !== 'torch');
  const sofa = seats.find(a => seats.some(b => a.material === b.material && a.properties.facing === b.properties.facing && a.y === b.y &&
    (['north', 'south'].includes(a.properties.facing) ? a.z === b.z && Math.abs(a.x - b.x) === 1 : a.x === b.x && Math.abs(a.z - b.z) === 1)));
  const innerDoor = doors.find(p => p.x > 0 && p.z > 0 && p.x < w - 1 && p.z < d - 1);
  // Check that the interior door actually divides the rooms. A door on a
  // freestanding block in one large room cannot make a separate bedroom.
  function room(start, openDoor) {
    const queue = start ? [start] : [], reached = new Set();
    for (let i=0; i<queue.length; i++) {
      const p=queue[i], key=p.x+','+p.z;
      if (p.x<1 || p.z<1 || p.x>=w-1 || p.z>=d-1 || reached.has(key)) continue;
      const c=cell(p.x,p.y,p.z);
      if (c && !(c===innerDoor && openDoor) && ![...beds,...seats,chest].includes(c) && c.material!=='torch' && !isBed(c.material)) continue;
      reached.add(key);
      for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) queue.push({x:p.x+dx,y:p.y,z:p.z+dz});
    }
    return reached;
  }
  const living=room(sofa,false), bedrooms=room(sofa,true);
  const separate = beds.every(p=>!living.has(p.x+','+p.z) && bedrooms.has(p.x+','+p.z));
  const lights=blocks.filter(p=>p.material==='torch');
  const litRooms=lights.some(p=>living.has(p.x+','+p.z)) && lights.some(p=>!living.has(p.x+','+p.z) && bedrooms.has(p.x+','+p.z));
  const roofed=[...bedrooms].every(key=>{const [x,z]=key.split(',').map(Number);return covered({x,y:sofa.y,z});});
  if (w > 11 || d > 12 || h > 7 || blocks.length > 380 || !doors.includes(entrance) || (entrance.x !== 0 && entrance.z !== 0 && entrance.x !== w-1 && entrance.z !== d-1) ||
      !innerDoor || !separate || !roofed || !litRooms ||
      windows.length < 2 || (materials.torch || 0) < 2 || beds.length !== sleepers || !chest || !sofa ||
      ![...beds, chest, sofa].every(covered) || (material && !(materials[material] >= Math.min(w, d) * 2))) {
    throw new Error('Keep the compact furnished house from the reference: a roofed bedroom and living room, an exterior and an interior door, two windows and floor torches, a usable chest, a two-stair sofa, the requested wall material and bed count.');
  }
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

module.exports = { starterHouse, designStarterHouse, checkStarterDesign, useAvailableBed, acceptPlacedBeds };
