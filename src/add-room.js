'use strict';
// A room added to a house (asked for on 2026-11-24: "extend existing builds, e.g. add room"), drawn here and not by
// the designer, which needs a key the server may not have. Three by three inside and two high, against one wall of
// the house and reached from it through a door in that wall, with a window in its far wall and a torch on its floor,
// and a bed in a bedroom. Of whatever blocks are quickest (any-material.js) unless a material was named.
//
// The wall it shares stays the house's: kept as it stands, its gaps filled, a door put through it. In a house of the
// bot's own (its building notes, builds.js) the doorway is the bot's to cut, on a side other than the way in, where
// the wall is plain and the house open behind it. In a player's house, the one whose wall the player looks at, the
// doorway is cut through their wall (asked for on 2026-11-24: "jev may cut it unless i ask to not do it"), or, when
// they said not to (keepWalls), they are asked to open it (build-around.js, a door's place); nothing else of theirs
// is touched.
const { Vec3 } = require('vec3');
const { buildFootprint, blockOwnership, matchesBuildBlock } = require('./build-blocks');
const { SHELL, fills } = require('./any-material');

const key = p => `${p.x},${p.y},${p.z}`;
const v = p => new Vec3(p.x, p.y, p.z);
const air = b => !!b && ['air', 'cave_air', 'void_air'].includes(b.name);
const blocked = message => Object.assign(new Error(message), { name: 'Blocked', needsPlayer: true });
const NATURAL = /^(?:grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|stone|deepslate|granite|diorite|andesite|tuff|sand|red_sand|gravel|sandstone|red_sandstone|terracotta|clay|moss_block|snow_block)$|_leaves$|_log$|^(?:short_grass|tall_grass|fern|large_fern|leaf_litter|snow|vine|dead_bush|bush|firefly_bush|short_dry_grass|tall_dry_grass)$|_(?:flower|tulip|orchid|allium|bluet|daisy|poppy|dandelion|cornflower|lily_of_the_valley)$/;
const FACING = { x: { 1: 'east', '-1': 'west' }, z: { 1: 'south', '-1': 'north' } };
const ADJECTIVES = /\b(?:small|big|large|little|new|extra|second|third|spare|guest|cozy|simple|nice|another)\b/g;

// "add a room", "add a bedroom to the house", "build another room", "extend the house", "make the house bigger".
function roomRequest(text, registry) {
  const grow = /^(?:extend|expand|enlarge) (?:the |this |my |our |your )?(?:house|home|cabin|hut|cottage)$|^make (?:the |this |my |our |your )?(?:house|home|cabin|hut|cottage) bigger$/.test(text);
  // An article before it: "make room" alone is room in the pockets, not a room.
  const m = !grow && /^(?:add|build|make)(?: me| us)? (?:a |an |another |one more )(.*?)\b(bed)?room\b(?: (?:to|on|onto|for|in|at) (?:the |this |my |our |your )?(?:house|home|cabin|hut|cottage))?$/.exec(text);
  if (!grow && !m) return null;
  const words = (m?.[1] || '').replace(ADJECTIVES, '').trim();
  let material, wooden = false;
  if (words) {
    const wood = Object.keys(registry.itemsByName).filter(n => n.endsWith('_planks')).map(n => n.slice(0, -7))
      .find(w => words.replace(/[ _-]+/g, '_').replace(/_(?:plank|planks|wood|wooden)$/, '') === w);
    // "a wooden room": planks of the house's own wood (planRoom).
    if (/^(?:wood|wooden|plank|planks)$/.test(words)) wooden = true;
    else if (wood) material = wood + '_planks';
    else if (['cobblestone', 'stone', 'sandstone', 'bricks', 'dirt'].includes(words)) material = words;
    else return null;
  }
  return { addRoom: { bed: !!m?.[2], ...(wooden && { wooden }) }, ...(material ? { material } : !wooden && { anyMaterial: true }) };
}

// The cells of a room on the side of a wall: `axis` the wall's normal, `out` the way out of the house along it,
// `plane` the wall's own cells on that axis, `center` the doorway's column across it, `y0` the house's floor and
// `top` the room's roof.
function roomCells({ axis, out, plane, center, y0, top, wood, material, bed }) {
  const at = (a, c, y) => axis === 'x' ? { x: plane + out * a, y, z: center + c } : { x: center + c, y, z: plane + out * a };
  const blocks = new Map(), empty = [];
  const put = (p, m, properties) => { for (const cell of buildFootprint({ ...p, material: m, ...(properties && { properties }) })) blocks.set(key(cell), cell); };
  const facing = FACING[axis][out];
  for (let a = 1; a <= 4; a++) for (let c = -2; c <= 2; c++) put(at(a, c, y0), material);
  for (let y = y0 + 1; y < top; y++) for (let a = 0; a <= 4; a++) for (let c = -2; c <= 2; c++) {
    const wall = a === 0 || a === 4 || Math.abs(c) === 2;
    if (wall && !(a === 0 && c === 0 && y <= y0 + 2)) put(at(a, c, y), a === 4 && c === 0 && y === y0 + 2 ? 'glass' : material);
  }
  // The wall it shares is the house's as it stands, whatever it is made of: only its gaps are filled (planRoom).
  for (let y = y0 + 1; y < top; y++) for (let c = -2; c <= 2; c++) { const cell = blocks.get(key(at(0, c, y))); if (cell && cell.material === material) cell.shared = true; }
  for (let a = 1; a <= 4; a++) for (let c = -2; c <= 2; c++) put(at(a, c, top), material);
  put(at(0, 0, y0 + 1), `${wood}_door`, { facing, half: 'lower' });
  put(at(3, -1, y0 + 1), 'torch');
  // The foot with a free cell behind it to stand in and lay it from, the way in left open.
  if (bed) put(at(2, 1, y0 + 1), 'white_bed', { facing, part: 'foot' });
  for (let y = y0 + 1; y < top; y++) for (let a = 1; a <= 3; a++) for (let c = -1; c <= 1; c++) {
    const p = at(a, c, y);
    if (!blocks.has(key(p))) empty.push(p);
  }
  const all = [...blocks.values(), ...empty];
  const bounds = { min: { x: Math.min(...all.map(p => p.x)), y: Math.min(...all.map(p => p.y)), z: Math.min(...all.map(p => p.z)) },
    max: { x: Math.max(...all.map(p => p.x)), y: Math.max(...all.map(p => p.y)), z: Math.max(...all.map(p => p.z)) } };
  const doorway = at(0, 0, y0 + 1), inside = at(-1, 0, y0 + 1);
  return { blocks: [...blocks.values()], empty, bounds, origin: { ...bounds.min }, entrance: inside, doorway };
}

// What stands in the room's place now, the plan's to clear (canClearSchematicBlock): the ground and what grows on it.
// A player's block there is theirs, and asked about or built around as on any site.
function initialOf(bot, cells) {
  const initialBlocks = {}, initialNames = {};
  for (const p of cells) {
    const b = bot.blockAt(v(p));
    if (b && !air(b) && NATURAL.test(b.name)) { initialBlocks[key(p)] = b.stateId ?? b.name; initialNames[key(p)] = b.name; }
  }
  return { initialBlocks, initialNames };
}

// How much the ground has to be cut or filled for the room, or null where it cannot go: someone's block where the room
// is open or where a sound block would not do, another of the bot's buildings, an unloaded cell.
function siteCost(bot, room, claimed) {
  const solid = new Set(room.blocks.map(key));
  let cost = 0;
  for (const p of [...room.blocks, ...room.empty]) {
    const k = key(p);
    if (claimed?.has(k)) return null;
    const b = bot.blockAt(v(p));
    if (!b) return null;
    if (air(b)) { if (solid.has(k)) cost++; continue; }
    // The ground under the floor, the house's own wall: built already.
    if (solid.has(k) && fills(b)) continue;
    if (!NATURAL.test(b.name)) return null;
    cost++;
  }
  return cost;
}

const plain = c => c && !c.companion && !(c.properties && Object.keys(c.properties).length) && (c.flexible || SHELL.test(c.material));
const woodOf = cells => {
  const counts = {};
  for (const c of cells) { const w = /^(.+)_door$/.exec(c.material)?.[1]; if (w && w !== 'iron') counts[w] = (counts[w] || 0) + 1; }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
};
const shellOf = cells => Object.entries(cells.filter(plain).reduce((t, c) => ({ ...t, [c.material]: (t[c.material] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0]?.[0];

// A room on the bot's own house (a building-notes entry): the side and the doorway with the least earthwork.
function roomOnHouse(bot, entry, { bed, wooden, material, claimed, near }) {
  const house = entry.blueprint, { min, max } = house.bounds, entrance = house.entrance || entry.entrance;
  if (!entrance) throw blocked(`I cannot tell where the way into ${entry.name || 'the house'} is, so I don't know which wall to build against.`);
  const planned = new Map(house.blocks.map(c => [key(c), c])), open = new Set(house.empty.map(key));
  const y0 = entrance.y - 1, wood = woodOf(house.blocks) || 'oak', shell = material || (wooden ? wood + '_planks' : shellOf(house.blocks) || 'dirt');
  const sides = [['x', 1, max.x], ['x', -1, min.x], ['z', 1, max.z], ['z', -1, min.z]]
    .filter(([axis, out, plane]) => !(out > 0 ? entrance[axis] > plane : entrance[axis] < plane));
  let best = null;
  for (const [axis, out, plane] of sides) {
    const across = axis === 'x' ? 'z' : 'x';
    for (let center = min[across] + 2; center <= max[across] - 2; center++) {
      const at = (a, y) => axis === 'x' ? { x: plane + out * a, y, z: center } : { x: center, y, z: plane + out * a };
      const wallCells = [at(0, y0 + 1), at(0, y0 + 2)], behind = [at(-1, y0 + 1), at(-1, y0 + 2)];
      if (!wallCells.every(p => plain(planned.get(key(p))) && matchesBuildBlock(bot.blockAt(v(p)), planned.get(key(p))))) continue;
      if (!behind.every(p => open.has(key(p)) && air(bot.blockAt(v(p))))) continue;
      let top = y0 + 3;
      for (let y = y0 + 3; y <= Math.min(max.y, y0 + 5); y++) if (planned.has(key(at(-1, y)))) { top = y; break; }
      const room = roomCells({ axis, out, plane, center, y0, top, wood, material: shell, bed });
      const cost = siteCost(bot, room, claimed);
      if (cost === null) continue;
      const score = cost * 4 + (near ? v(room.doorway).distanceTo(v(near)) : 0);
      if (!best || score < best.score) best = { score, room, axis, out };
    }
  }
  if (!best) throw blocked(`I cannot find a wall of ${entry.name || 'the house'} with room beside it for another room. Clear a side of it or ask for something else.`);
  return best;
}

// A room on a player's house: the wall block they look at, the house on the side of it that has a roof over it.
function roomOnWall(bot, wall, { bed, wooden, material, claimed, wood }) {
  const w = v(wall), ceiling = p => { for (let dy = 1; dy <= 5; dy++) { const b = bot.blockAt(p.offset(0, dy, 0)); if (b && !air(b)) return p.y + dy; } return null; };
  for (const axis of ['x', 'z']) for (const out of [1, -1]) {
    const step = axis === 'x' ? new Vec3(out, 0, 0) : new Vec3(0, 0, out);
    const inside = w.minus(step);
    if (!air(bot.blockAt(inside)) || ceiling(inside) === null || ceiling(w.plus(step)) !== null) continue;
    let y0 = inside.y - 1;
    while (y0 > inside.y - 4 && air(bot.blockAt(new Vec3(inside.x, y0, inside.z)))) y0--;
    if (air(bot.blockAt(new Vec3(inside.x, y0, inside.z)))) continue;
    const top = Math.max(y0 + 3, Math.min(ceiling(new Vec3(inside.x, y0 + 1, inside.z)) ?? y0 + 3, y0 + 4));
    const center = axis === 'x' ? w.z : w.x, plane = w[axis];
    const near = [-2, -1, 0, 1, 2].map(c => bot.blockAt(axis === 'x' ? new Vec3(plane, y0 + 1, center + c) : new Vec3(center + c, y0 + 1, plane))).filter(fills);
    const shell = material || (wooden ? wood + '_planks' : near.map(b => b.name).find(n => SHELL.test(n)) || 'dirt');
    const room = roomCells({ axis, out, plane, center, y0, top, wood, material: shell, bed });
    if (siteCost(bot, room, claimed) === null) throw blocked('Something of yours is in the way of a room on that side. Clear it, or look at another wall and ask again.');
    return { room, axis, out };
  }
  throw blocked('Look at an outside wall of the house, from inside it or out, and ask me again so I know where the room goes.');
}

// The plan the builder works from: { blueprint, owned, said }.
function planRoom(bot, { entry = null, wall = null, room = {}, material = null, claimed = null, near = null, wood = null, keepWalls = false } = {}) {
  const chosen = entry ? roomOnHouse(bot, entry, { bed: room.bed, wooden: room.wooden, material, claimed, near })
    : roomOnWall(bot, wall, { bed: room.bed, wooden: room.wooden, material, claimed, wood: wood || 'oak' });
  const r = chosen.room, owned = {};
  // The shared wall's blocks stay the house's own cells: the room takes only its gaps, filled with any sound block.
  r.blocks = r.blocks.filter(c => !c.shared || air(bot.blockAt(v(c))));
  for (const c of r.blocks) if (c.shared) { delete c.shared; c.flexible = true; }
  const doorway = buildFootprint(r.blocks.find(c => key(c) === key(r.doorway)));
  for (const p of doorway) {
    const b = bot.blockAt(v(p));
    // The bot's own wall is its own to cut: owned. A player's is cut as the doorway too, unless they said not to.
    if (entry && b && !air(b)) owned[key(p)] = blockOwnership(b);
  }
  const blueprint = { origin: r.origin, entrance: r.entrance, bounds: r.bounds, blocks: r.blocks, empty: r.empty,
    ...initialOf(bot, [...r.blocks.filter(c => !doorway.some(d => key(d) === key(c))), ...r.empty]), room: true };
  const side = FACING[chosen.axis][chosen.out], at = `${r.doorway.x}, ${r.doorway.y}, ${r.doorway.z}`;
  // The player's own blocks where the door goes: cut as they stand now (blueprint.cut, initialBlocks), or, when they
  // said not to (keepWalls), theirs to break (build-around.js, a door's place).
  const theirs = entry ? [] : doorway.filter(p => !air(bot.blockAt(v(p))));
  // Cut only through plain full blocks, as round a start of theirs (player-build.js checkOnto): glass, a door, a bed
  // or a chest where the door goes is theirs to move.
  const cutting = !keepWalls && theirs.length > 0 && theirs.every(p => require('./player-build').kindOf(bot.blockAt(v(p))) === 'full');
  if (cutting) {
    blueprint.cut = theirs.map(p => ({ x: p.x, y: p.y, z: p.z }));
    for (const p of theirs) { const b = bot.blockAt(v(p)); (blueprint.initialBlocks ||= {})[key(p)] = b.stateId ?? b.name; (blueprint.initialNames ||= {})[key(p)] = b.name; }
  }
  const said = entry ? `I'll add a room on the ${side} side of ${entry.name || 'the house'}, with a door through to it at ${at}.`
    : `I'll add a room on the ${side} side of your house, with a door through to it at ${at}.${!theirs.length ? ''
      : !cutting ? ` That wall is yours, so I'll wait for you to break the block${theirs.length > 1 ? 's' : ''} there before I start.`
      : ' That wall is yours: I\'ll cut the doorway through it, unless you say "Jev, don\'t cut my wall".'}`;
  return { blueprint, owned, said, theirs };
}

module.exports = { roomRequest, roomCells, planRoom };
