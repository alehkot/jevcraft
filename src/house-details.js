'use strict';
const { Vec3 } = require('vec3');
const { buildFootprint, matchesBuildBlock, blockOwnership, bedFloor } = require('./build-blocks');
const { isDoor, doorPairMatches } = require('./doors');

const asVec = (p) => new Vec3(p.x, p.y, p.z);
const key = (p) => `${p.x},${p.y},${p.z}`;
const air = (b) => b && ['air', 'cave_air', 'void_air'].includes(b.name);
const glass = (name) => /^(?:(?:\w+_stained_)?glass)(?:_pane)?$/.test(name);
const house = /\b(?:house|home|cabin|hut|cottage)\b/i;
const blocked = (message) => Object.assign(new Error(message), { name: 'Blocked', needsPlayer: true });
const numbers = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 };

function woodName(text, registry) {
  const woods = Object.keys(registry.itemsByName)
    .filter((n) => n.endsWith('_planks'))
    .map((n) => n.slice(0, -7))
    .sort((a, b) => b.length - a.length);
  return woods.find((w) => new RegExp('\\b' + w.replaceAll('_', '[ _-]') + '\\b').test(text));
}

function houseRequest(raw, registry) {
  const text = raw
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/^(?:(?:please|can you|could you|would you)[, ]+)+/, '');
  const create =
    /^(?:help (?:me|us) (?:to )?)?(?:build|make|construct) (?:me |us )?(?:a |an )?(.*?)\b(house|home|cabin|hut|cottage)\b(?: (?:for (?:the )?|with )(.+))?$/.exec(
      text
    );
  if (create && !/\b(?:for|in|to)\b/.test(create[1])) {
    const wood = woodName(create[1], registry);
    let primary = create[1]
      .trim()
      .replace(/\b(?:small|starter|simple|basic|super|little|cozy|wooden|furnished)\b/g, '')
      .trim();
    let material;
    if (wood && primary.replace(/[ _-]+/g, '_').replace(/_plank(s)?$/, '') === wood) material = wood + '_planks';
    else if (primary && ['cobblestone', 'stone', 'sandstone', 'bricks'].includes(primary)) material = primary;
    else if (primary) return null;
    const capacity =
      create[3] && /^(?:(?:two|2) or )?(two|three|2|3)(?: (?:people|players|beds|of us))?$/.exec(create[3]);
    if (create[3] && !capacity) return null;
    return { starterBeds: capacity && ['3', 'three'].includes(capacity[1]) ? 3 : 2, ...(material && { material }) };
  }
  const craft = /^(?:craft|make) (?:(a|one|two|three|\d+) )?(?:(\w+(?:[ _-]\w+)*) )?doors?$/.exec(text);
  if (craft) {
    const wood = craft[2] && woodName(craft[2], registry);
    const count = numbers[craft[1]] || Number(craft[1] || 1);
    if ((!craft[2] || wood || craft[2] === 'wooden') && count >= 1 && count <= 1024)
      return { craftDoor: true, wood, count };
  }
  if (/\b(?:don't|do not|without|instead|unless|if|remove|break|destroy|open|close)\b/.test(text)) return null;
  const correction =
    /^(?:(?:you|we) (?:forgot|missed)|(?:the |this |my |our )?(?:house|home|cabin|hut|cottage) (?:needs|is missing|has no|doesn't have)|(?:there is|there's|there are) no)\b/.test(
      text
    );
  if (!correction && !/^(?:install|fit|add|put|place|light up|furnish|finish furnishing|make)\b/.test(text))
    return null;
  if (!correction && /^make\b/.test(text) && !house.test(text) && !/windows?\b/.test(text)) return null;
  const all = /^(?:furnish|finish furnishing) (?:the |this |my |our )?(?:house|home|cabin|hut|cottage)$/.test(text);
  const parts = {};
  for (const [name, token, usual] of [
    ['door', 'doors?', 1],
    ['window', 'windows?', 2],
    ['torch', 'torches|torch|lights?|lighting', 2],
    ['chest', 'chests?', 1],
    ['sofa', 'sofas?|couch(?:es)?', 1]
  ]) {
    const match = new RegExp('(?:\\b(a|an|one|two|three|four|\\d+) )?\\b(' + token + ')\\b').exec(text);
    if (match) parts[name] = match[1] ? numbers[match[1]] || Number(match[1]) : usual;
    else if (all || (name === 'torch' && /^light up\b/.test(text))) parts[name] = usual;
  }
  if (!Object.keys(parts).length) return null;
  // Let the general interpreter handle compound work, other structures and named placements.
  const remainder = text
    .replace(/\b(?:dark oak|pale oak)\b/g, 'oak')
    .replace(
      /\b(?:you|we|forgot|missed|the|this|my|our|your|it|its|a|an|one|two|three|four|\d+|please|to|add|install|fit|put|place|make|in|into|on|for|of|inside|some|and|also|up|light|lights|lighting|house|home|hut|cottage|cabin|needs|is|there|are|no|missing|door|doors|torch|torches|window|windows|glass|wooden|sofa|sofas|couch|couches|chest|chests|furnish|finish|furnishing|oak|spruce|birch|acacia|cherry|jungle|mangrove|bamboo|crimson|warped|has|doesn't|have)\b/g,
      ''
    )
    .replace(/[\s,'-]/g, '');
  if (remainder) return null;
  return { parts, ...(parts.door && { wood: woodName(text, registry) }) };
}

function houseSpec(intent, request, from, context) {
  if (intent.craftDoor) {
    const planks = Object.entries(context.inventory || {})
      .filter(([n]) => /_(planks|log|stem)$/.test(n))
      .sort((a, b) => b[1] - a[1]);
    const wood =
      intent.wood ||
      planks
        .map(([n]) => n.replace(/^stripped_|_(planks|log|stem)$/g, ''))
        .find((w) => context.registry.itemsByName[w + '_door']) ||
      'oak';
    return { kind: 'craft', request, from, item: wood + '_door', count: intent.count };
  }
  if (intent.starterBeds)
    return {
      kind: 'build',
      request,
      from,
      ...intent,
      ...(context.speakerPosition && { buildAnchor: { ...context.speakerPosition } })
    };
  const homes = (context.builds || []).filter((b) => b.kind === 'house' || house.test(b.name) || house.test(b.request));
  const site = context.workSite?.position;
  if (site && !house.test(request) && !/\b(?:forgot|missed|missing)\b/i.test(request))
    return { kind: 'build', request, from, workSite: context.workSite, buildAnchor: { ...site } };
  const target = site
    ? homes.find(
        (b) =>
          b.bounds && ['x', 'y', 'z'].every((k) => site[k] >= b.bounds.min[k] - 1 && site[k] <= b.bounds.max[k] + 1)
      )
    : homes[0];
  if (!target)
    return {
      kind: 'clarify',
      request,
      from,
      message: 'Stand beside the house I built and ask me again so I can find it in my building notes.'
    };
  return {
    kind: 'build',
    request,
    from,
    houseDetails: { target: target.id, parts: intent.parts, wood: intent.wood },
    buildContinuation: { mode: 'edit', target: target.id, name: target.name }
  };
}

function planFittings(bot, entry, { parts, wood }) {
  const original = entry.blueprint,
    { min, max } = original.bounds,
    outside = asVec(original.entrance || entry.entrance);
  const inward =
    outside.z < min.z
      ? [0, 1, 'south']
      : outside.z > max.z
        ? [0, -1, 'north']
        : outside.x < min.x
          ? [1, 0, 'east']
          : outside.x > max.x
            ? [-1, 0, 'west']
            : null;
  if (!inward) throw blocked("I cannot identify the entrance in this house's saved plan.");
  const [dx, dz, facing] = inward,
    entryCell = outside.offset(dx, 0, dz),
    y = entryCell.y;
  const planned = new Map(original.blocks.map((p) => [key(p), p])),
    clear = new Set(original.empty.map(key));
  const cells = new Map(),
    owned = {};
  const observed = (p) => bot.blockAt(asVec(p));
  const structural = (p) =>
    p &&
    !p.properties &&
    /(?:_planks|_bricks|_terracotta|_concrete|_logs?)$|^(?:stone|cobblestone|sandstone|bricks|terracotta|dirt)$/.test(
      p.material
    );
  const usable = (p) => {
    const k = key(p),
      before = planned.get(k),
      b = observed(p);
    return (
      !cells.has(k) &&
      b &&
      (((clear.has(k) || before) && air(b)) || (structural(before) && matchesBuildBlock(b, before)))
    );
  };
  const floor = (p) => bedFloor(observed(asVec(p).offset(0, -1, 0)));
  const add = (p, material, properties) => {
    for (const cell of buildFootprint({ ...p, material, ...(properties && { properties }) })) {
      const k = key(cell),
        b = observed(cell),
        before = planned.get(k);
      if (!b || (!air(b) && !matchesBuildBlock(b, cell) && !(before && matchesBuildBlock(b, before))))
        throw blocked('Something is in the way of the fittings. Please clear that spot.');
      if (before && matchesBuildBlock(b, before)) owned[k] = blockOwnership(b);
      cells.set(k, cell);
    }
  };
  const woods = new Map();
  for (const c of original.blocks)
    if (c.material.endsWith('_planks'))
      woods.set(c.material.slice(0, -7), (woods.get(c.material.slice(0, -7)) || 0) + 1);
  const localWood = [...woods].sort((a, b) => b[1] - a[1])[0]?.[0] || 'oak';
  const room = [],
    sides = [];
  if (max.x - min.x > 48 || max.z - min.z > 48) throw blocked('I cannot fit these furnishings inside the saved walls.');
  for (let x = min.x + 1; x < max.x; x++) for (let z = min.z + 1; z < max.z; z++) room.push(new Vec3(x, y, z));
  if (!room.length) throw blocked('I cannot fit these furnishings inside the saved walls.');
  // Alternate opposite sides so two windows light different sides of the room.
  const centred = (lo, hi) =>
    Array.from({ length: hi - lo - 1 }, (_, i) => lo + i + 1).sort(
      (a, b) => Math.abs(2 * a - lo - hi) - Math.abs(2 * b - lo - hi)
    );
  for (const z of centred(min.z, max.z)) sides.push(new Vec3(min.x, y + 1, z), new Vec3(max.x, y + 1, z));
  for (const x of centred(min.x, max.x)) sides.push(new Vec3(x, y + 1, min.z), new Vec3(x, y + 1, max.z));
  const need = (name, found) => {
    if (found < parts[name])
      throw blocked(
        `I can fit ${found} of the requested ${name} fittings in this house. Please clear a spot or ask for fewer.`
      );
  };
  if (parts.door) {
    need('door', 1);
    const foot = observed(entryCell),
      head = observed(entryCell.offset(0, 1, 0));
    if (!floor(entryCell)) throw blocked('The entrance needs a solid floor before I can install its door.');
    if (isDoor(foot?.name) && doorPairMatches(foot, head) && (!wood || foot.name === wood + '_door'))
      add(entryCell, foot.name, { facing: foot.getProperties().facing, half: 'lower' });
    else {
      if (!usable(entryCell) || !usable(entryCell.offset(0, 1, 0)))
        throw blocked('Please clear both spaces in the doorway so I can fit the door.');
      add(entryCell, (wood || localWood) + '_door', { facing, half: 'lower' });
    }
  }
  if (parts.window) {
    const options = sides.filter(
      (p) => !p.equals(entryCell.offset(0, 1, 0)) && !cells.has(key(p)) && (glass(observed(p)?.name) || usable(p))
    );
    const existing = options.filter((p) => glass(observed(p)?.name));
    const choices = [...existing, ...options.filter((p) => !existing.includes(p))].slice(0, parts.window);
    need('window', choices.length);
    for (const p of choices) add(p, glass(observed(p)?.name) ? observed(p).name : 'glass');
  }
  // Reserve large pieces before choosing individual light positions. Keep the entrance aisle free.
  const open = (p) =>
    clear.has(key(p)) && !cells.has(key(p)) && air(observed(p)) && floor(p) && !p.equals(entryCell.offset(dx, 0, dz));
  if (parts.sofa) {
    need('sofa', 1);
    const chair = localWood + '_stairs',
      pairs = [];
    for (const p of room)
      for (const [sx, sz, dir] of [
        [1, 0, 'north'],
        [0, 1, 'west']
      ]) {
        const q = p.offset(sx, 0, sz);
        if (q.x >= max.x || q.z >= max.z) continue;
        const a = observed(p),
          b = observed(q);
        const same =
          a?.name === chair &&
          b?.name === chair &&
          a.getProperties().half === 'bottom' &&
          b.getProperties().half === 'bottom' &&
          a.getProperties().facing === b.getProperties().facing &&
          (sx ? ['north', 'south'] : ['east', 'west']).includes(a.getProperties().facing);
        if (same || (open(p) && open(q))) pairs.push({ p, q, dir: same ? a.getProperties().facing : dir, same });
      }
    const pair = pairs.find((c) => c.same) || pairs[0];
    need('sofa', pair ? 1 : 0);
    for (const p of [pair.p, pair.q]) add(p, chair, { facing: pair.dir, half: 'bottom', waterlogged: false });
  }
  const chestFacing = (p) => {
    for (const [sx, sz, dir] of [
      [0, -1, 'north'],
      [0, 1, 'south'],
      [-1, 0, 'west'],
      [1, 0, 'east']
    ]) {
      const q = p.offset(sx, 0, sz);
      if (clear.has(key(q)) && air(observed(q)) && air(observed(q.offset(0, 1, 0))) && !cells.has(key(q))) return dir;
    }
    return null;
  };
  for (const [name, material] of [
    ['chest', 'chest'],
    ['torch', 'torch']
  ])
    if (parts[name]) {
      const existing = room.filter(
        (p) =>
          observed(p)?.name === material &&
          !cells.has(key(p)) &&
          (name !== 'chest' || observed(p).getProperties().type === 'single')
      );
      const options = [...existing, ...room.filter((p) => open(p) && !existing.includes(p))].filter(
        (p) => name !== 'chest' || (air(observed(p.offset(0, 1, 0))) && (existing.includes(p) || chestFacing(p)))
      );
      const chosen = [];
      while (chosen.length < parts[name] && options.length) {
        // Reuse installed fittings first, then distribute light across the room.
        const score = (p) =>
          (existing.includes(p) ? 1000 : 0) +
          (name === 'torch' && chosen.length ? Math.min(...chosen.map((q) => p.distanceTo(q))) : 0);
        options.sort((a, b) => score(b) - score(a));
        chosen.push(options.shift());
      }
      need(name, chosen.length);
      for (const p of chosen)
        add(
          p,
          material,
          name === 'chest'
            ? {
                facing: existing.includes(p) ? observed(p).getProperties().facing : chestFacing(p),
                type: 'single',
                waterlogged: false
              }
            : null
        );
    }
  return {
    blueprint: {
      origin: original.origin,
      entrance: original.entrance,
      bounds: original.bounds,
      blocks: [...cells.values()],
      empty: []
    },
    owned
  };
}

// Older houses stored absolute block coordinates and a centre origin. Rebuild
// the designer's local coordinates from the actual extents of their blocks.
function drawingForEdit(entry) {
  if (entry?.design?.source) return { source: entry.design.source, origin: entry.origin };
  if (!entry?.blueprint?.blocks.length) return null;
  const { blocks, entrance } = entry.blueprint;
  const low = {},
    high = {};
  for (const axis of ['x', 'y', 'z']) {
    low[axis] = Math.min(...blocks.map((p) => p[axis]));
    high[axis] = Math.max(...blocks.map((p) => p[axis]));
  }
  const local = (p) => [p.x - low.x, p.y - low.y, p.z - low.z];
  const regions = [];
  for (const c of blocks.filter((p) => !p.companion).sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)) {
    const at = local(c);
    const properties = c.properties
      ? {
          facing: c.properties.facing || null,
          half:
            c.properties.type === 'top' || c.material.endsWith('_slab')
              ? c.properties.type
              : c.material.endsWith('_stairs')
                ? c.properties.half
                : null
        }
      : null;
    const prior = regions.at(-1);
    if (
      prior &&
      prior.block === c.material &&
      prior.to[0] === at[0] - 1 &&
      prior.to[1] === at[1] &&
      prior.to[2] === at[2] &&
      JSON.stringify(prior.properties) === JSON.stringify(properties)
    )
      prior.to[0] = at[0];
    else regions.push({ from: at, to: [...at], block: c.material, properties });
  }
  const size = ['x', 'y', 'z'].map((k) => high[k] - low[k] + 1);
  const entryCell = entrance && local(entrance).map((n, i) => Math.max(0, Math.min(size[i] - 1, n)));
  return {
    origin: low,
    source: {
      name: entry.name,
      description: entry.request || entry.name,
      size,
      entrance: entryCell || null,
      palette: [...new Set(regions.map((r) => r.block))],
      regions
    }
  };
}

function rememberFittings(bot, goal) {
  const entry = bot.buildRegistry.find(goal.houseDetails.target);
  if (!entry) throw blocked('I cannot find the original house in my building notes.');
  const changes = new Map(goal.blueprint.blocks.map((p) => [key(p), p]));
  const old = entry.blueprint;
  const blueprint = {
    ...old,
    blocks: [...old.blocks.filter((p) => !changes.has(key(p))), ...changes.values()],
    empty: old.empty.filter((p) => !changes.has(key(p)))
  };
  let design = entry.design;
  if (design?.source) {
    const source = structuredClone(design.source);
    for (const c of changes.values()) {
      if (c.companion) continue;
      const loc = [c.x - old.origin.x, c.y - old.origin.y, c.z - old.origin.z];
      const region = {
        from: loc,
        to: loc,
        block: c.material,
        properties: c.properties
          ? { facing: c.properties.facing || null, half: c.material.endsWith('_stairs') ? c.properties.half : null }
          : null
      };
      const previous = old.blocks.find((p) => key(p) === key(c));
      if (
        previous &&
        previous.material === c.material &&
        JSON.stringify(previous.properties) === JSON.stringify(c.properties)
      )
        continue;
      if (isDoor(c.material)) {
        const top = [loc[0], loc[1] + 1, loc[2]];
        source.regions.push({ from: top, to: top, block: 'air', properties: null });
      }
      source.regions.push(region);
      if (!source.palette.includes(c.material)) source.palette.push(c.material);
    }
    design = { ...design, source };
  }
  bot.buildRegistry.remember(
    { ...entry, buildId: entry.id, blueprint, design },
    { dimension: entry.dimension, status: entry.status }
  );
}
module.exports = { drawingForEdit, houseRequest, houseSpec, planFittings, rememberFittings };
