'use strict';
const { woodInView } = require('./built');
const { buildPalette, bedPaintStart, validateSchematic } = require('./designer');
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

function checkStarterDesign(design, { sleepers, material, around }) {
  const { source, blocks, materials } = design, [w, h, d] = source.size;
  const byPosition = new Map(blocks.map(p => [[p.x, p.y, p.z].join(','), p]));
  const cell = (x, y, z) => byPosition.get([x, y, z].join(','));
  const doors = blocks.filter(p => p.properties?.half === 'lower' && p.material.endsWith('_door'));
  const beds = blocks.filter(p => p.properties?.part === 'foot');
  const seats = blocks.filter(p => p.material.endsWith('_stairs') && p.properties?.half === 'bottom');
  const chest = blocks.find(p => p.material === 'chest' && !cell(p.x, p.y + 1, p.z));
  const entrance = source.entrance && cell(...source.entrance);
  const windows = blocks.filter(p => /^(?:\w+_stained_)?glass$/.test(p.material) && (p.x === 0 || p.z === 0 || p.x === w - 1 || p.z === d - 1));
  const covered = p => blocks.some(q => q.x === p.x && q.z === p.z && q.y > p.y + 1 && !q.companion && q.material !== 'torch');
  const sofa = seats.find(a => seats.some(b => a.material === b.material && a.properties.facing === b.properties.facing && a.y === b.y &&
    (['north', 'south'].includes(a.properties.facing) ? a.z === b.z && Math.abs(a.x - b.x) === 1 : a.x === b.x && Math.abs(a.z - b.z) === 1)));
  const sides = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const key = (x, z) => x + ',' + z;
  const passable = b => !b || b.material === 'torch' || b.material.endsWith('_door');
  const alongDoor = (b, dx, dz) => !b?.material.endsWith('_door') ||
    (['north', 'south'].includes(b.properties.facing) ? dx === 0 : dz === 0);
  // Both walks start outside the rooms. Furniture is usable from an adjacent
  // standing cell; a chest or a row of beds cannot serve as the only aisle.
  function walk(openDoors) {
    const reached = new Set(), queue = [];
    if (!doors.includes(entrance)) return reached;
    const y = entrance.y;
    queue.push(entrance);
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i], from = cell(p.x, y, p.z);
      for (const [dx, dz] of sides) {
        const x = p.x + dx, z = p.z + dz, k = key(x, z);
        if (x <= 0 || z <= 0 || x >= w - 1 || z >= d - 1 || reached.has(k)) continue;
        const feet = cell(x, y, z), floor = cell(x, y - 1, z);
        if (!floor || passable(floor) || isBed(floor.material) || !passable(feet) || !passable(cell(x, y + 1, z))) continue;
        if ((!openDoors && feet?.material.endsWith('_door')) || !alongDoor(from, dx, dz) || !alongDoor(feet, dx, dz)) continue;
        reached.add(k);
        queue.push({ x, z });
      }
    }
    return reached;
  }
  const living = walk(false), interior = walk(true);
  const usableFrom = (area, p) => p && p.y === entrance?.y &&
    buildFootprint(p).some(c => sides.some(([dx, dz]) => area.has(key(c.x + dx, c.z + dz))));
  // Round a player's start (player-build.js, around) one room may be all their walls allow: each thing usable from inside.
  const separate = around ? [sofa, chest, ...beds].every(p => usableFrom(interior, p)) : usableFrom(living, sofa) && usableFrom(interior, chest) &&
    beds.every(p => !usableFrom(living, p) && usableFrom(interior, p));
  const lights = blocks.filter(p => p.material === 'torch' && p.y === entrance?.y);
  const litRooms = around ? lights.some(p => interior.has(key(p.x, p.z))) : lights.some(p => living.has(key(p.x, p.z))) &&
    lights.some(p => interior.has(key(p.x, p.z)) && !living.has(key(p.x, p.z)));
  const roofed = [...interior].every(k => { const [x, z] = k.split(',').map(Number); return covered({ x, y: entrance.y, z }); });
  const [capW, capH, capD, capBlocks] = around ? [Math.max(11, around.size[0] + 4), Math.max(7, around.size[1] + 3), Math.max(12, around.size[2] + 4), 380 + around.blocks] : [11, 7, 12, 380];
  // What is wrong with this draft, each named where it is: the whole list alone, sent back three times in the test
  // window (2026-11-24), did not say what to change, and three drafts of the same mistakes used up the attempts.
  const at = p => `[${p.x},${p.y},${p.z}]`, wrong = [];
  if (w > capW || d > capD || h > capH) wrong.push(`it is ${w}x${h}x${d}, over ${capW}x${capH}x${capD}`);
  if (blocks.length > capBlocks) wrong.push(`it has ${blocks.length} blocks, over ${capBlocks}`);
  if (!doors.includes(entrance)) wrong.push(`the entrance ${JSON.stringify(source.entrance)} is not the lower half of a door`);
  else if (entrance.x !== 0 && entrance.z !== 0 && entrance.x !== w - 1 && entrance.z !== d - 1) wrong.push(`the entrance door at ${at(entrance)} is not in an outside wall`);
  if (beds.length !== sleepers) wrong.push(`${beds.length} bed${beds.length === 1 ? '' : 's'} for ${sleepers} sleepers`);
  if (!chest) wrong.push('no chest with nothing on top of it');
  if (!sofa) wrong.push('no sofa: two bottom-half stairs of one material side by side, facing the same way');
  if (doors.includes(entrance) && !separate) {
    if (around) {
      const unusable = [['the sofa', sofa], ['the chest', chest], ...beds.map((b, i) => [`bed ${i + 1}`, b])].filter(([, p]) => p && !usableFrom(interior, p));
      if (unusable.length) wrong.push(`no standing space reached from the door beside ${unusable.map(([n, p]) => `${n} at ${at(p)}`).join(', ')} (on the floor level of the entrance, y ${entrance.y})`);
    } else wrong.push('the rooms are not as in the reference: the sofa reached from the front door, the chest from inside, the beds only through the interior door');
  }
  if (doors.includes(entrance) && !roofed) {
    const open = [...interior].find(k => { const [x, z] = k.split(',').map(Number); return !covered({ x, y: entrance.y, z }); });
    wrong.push(`the inside is not all roofed: nothing two or more blocks above the floor at x ${open?.split(',')[0]}, z ${open?.split(',')[1]}`);
  }
  if (doors.includes(entrance) && !litRooms) wrong.push(around ? `no torch standing on the floor inside, at y ${entrance.y}` : 'the living room and the bedroom need a floor torch each');
  if (windows.length < 2) wrong.push(`${windows.length} glass in the outside walls, two windows needed`);
  if ((materials.torch || 0) < 2) wrong.push(`${materials.torch || 0} torches, two needed`);
  const bare = [['the sofa', sofa], ['the chest', chest], ...beds.map((b, i) => [`bed ${i + 1}`, b])].filter(([, p]) => p && !covered(p));
  if (bare.length) wrong.push(`not under the roof: ${bare.map(([n, p]) => `${n} at ${at(p)}`).join(', ')}`);
  if (material && !(materials[material] >= Math.min(w, d) * 2)) wrong.push(`${materials[material] || 0} ${material}, at least ${Math.min(w, d) * 2} wanted`);
  if (wrong.length) {
    throw new Error((around ? `Finish it as a furnished house round the player's blocks, within ${capW}x${capH}x${capD}: an entrance door in an outside wall, a roof over all of the inside, two glass windows in the outside walls, two floor torches inside, a usable chest, a two-stair sofa and one bed for each of the ${sleepers} sleepers, each with a standing space beside it reached from the door` : 'Keep the compact furnished house from the reference: a roofed bedroom and living room, an exterior and an interior door, two windows and floor torches, a usable chest, a two-stair sofa, the requested wall material and bed count') +
      `. Wrong in this draft (local [x,y,z]): ${wrong.join('; ')}.`);
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
  const at = [foot.x - origin.x, foot.y - origin.y, foot.z - origin.z];
  // Regions are applied in order. Only override this foot, including when
  // the model drew several beds with one cuboid or overlaid an earlier one.
  const region = source.regions.slice(bedPaintStart(source.regions)).findLast(r => at.every((n,i) => n === r.from[i]));
  if (region) region.block = material;
  else source.regions.push({ from: at, to: [...at], block: material, properties: { facing: foot.properties.facing, half: null } });
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
