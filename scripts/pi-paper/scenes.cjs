'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { root, run, lib } = require('./fixture.cjs');
const { Vec3 } = lib('vec3'),
  mc = lib('mineflayer'),
  { Task, navigate } = lib('./src/skills');
const { createSession } = lib('./src/session'),
  { TypeSafe } = lib('./src/typesafe'),
  { houseBlueprint } = lib('./src/objectives');
const { place, acquireStep, designedBuildStep } = lib('./src/work'),
  { validateSchematic, selectSchematicSite } = lib('./src/designer');
const { buildCellComplete, matchesBuildBlock, regionProperties } = lib('./src/build-blocks'),
  { boatTravelStep } = lib('./src/boats');
const cfg = { host: '127.0.0.1', port: 25575, version: '26.1', auth: 'offline' };
assert.equal(process.cwd(), root);
assert.equal(process.env.MC_PORT, '25575');
const props = fs.readFileSync(path.join(root, 'newworld/server.properties'), 'utf8');
assert.match(props, /^server-ip=127\.0\.0\.1$/m);
assert.match(props, /^server-port=25575$/m);
const attempt = Date.now(),
  statepath = path.join(run, 'state'),
  worker = 'HouseJev',
  player = 'HouseTester';
const pos = (x, y, z) => new Vec3(x, y, z),
  v = (p) => pos(p.x, p.y, p.z),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (name, data = {}) => {
  const line = JSON.stringify({ attempt, at: new Date().toISOString(), name, ...data });
  console.log(line);
  fs.appendFileSync(path.join(run, 'scenes.jsonl'), line + '\n');
};
const cmd = (...lines) => fs.appendFileSync(path.join(root, 'newworld/console.in'), lines.join('\n') + '\n');
async function until(label, check, sec = 20) {
  const end = Date.now() + sec * 1000;
  while (Date.now() < end) {
    if (fs.existsSync(path.join(root, 'window.end'))) throw Error('window ended');
    if (check()) return;
    await sleep(90);
  }
  throw Error('timeout ' + label);
}
const witness = mc.createBot({ ...cfg, username: player });
let session, bot;
const block = (p) => witness.blockAt(p),
  at = (p, n) => block(p)?.name === n && bot?.blockAt(p)?.name === n;
const counts = (n) =>
  bot.inventory
    .items()
    .filter((i) => i.name === n)
    .reduce((a, i) => a + i.count, 0);
const state = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(statepath, '127_0_0_1-25575-HouseJev.json')));
  } catch {
    return {};
  }
};
const coord = (p) => [p.x, p.y, p.z].join(' ');
async function tp(name, p) {
  cmd('tp ' + name + ' ' + coord(p));
  const b = name === worker ? bot : witness;
  await until('teleport ' + name, () => b.entity?.position.distanceTo(p) < 0.3);
  await b.waitForTicks(2);
}
async function clearStock() {
  cmd('clear ' + worker);
  await until('empty inventory', () => bot.inventory.items().length === 0);
}
async function give(name, n) {
  let before = counts(name);
  cmd('give ' + worker + ' ' + name + ' ' + n);
  await until(name, () => counts(name) >= before + n);
}
async function ask(request, seconds = 80) {
  const previous = state().createdAt;
  const task = lib('./src/work-site').splitLocation(request, bot.registry)?.task || request;
  witness.chat(worker + ' ' + request);
  const timeout = Date.now() + seconds * 1000;
  while (Date.now() < timeout) {
    let g = state();
    if (g.createdAt !== previous && g.request?.includes(task)) {
      if (g.status === 'complete') return g;
      if (['blocked', 'failed'].includes(g.status))
        throw Error(JSON.stringify({ request: g.request, status: g.status, error: g.lastError, step: g.step }));
    }
    await sleep(150);
  }
  let g = state();
  throw Error(
    'chat timeout ' + JSON.stringify({ request: g.request, status: g.status, error: g.lastError, step: g.step })
  );
}
async function retrofit() {
  const blueprint = houseBlueprint(pos(34, 190, 8), 'oak_planks');
  cmd(
    ...blueprint.blocks.map((c) => 'setblock ' + coord(c) + ' ' + c.material),
    ...blueprint.empty.map((c) => 'setblock ' + coord(c) + ' air'),
    'setblock 34 191 8 diamond_block'
  );
  await until('old house', () => at(pos(34, 191, 8), 'diamond_block'));
  await tp(worker, pos(34.5, 190, 4.5));
  await tp(player, pos(35.5, 190, 3.5));
  const entry = bot.buildRegistry.remember(
    { kind: 'house', request: 'Build a small dark oak house', blueprint },
    { dimension: 'overworld', status: 'complete' }
  );
  await give('oak_door', 2);
  await give('glass', 3);
  await give('torch', 12);
  await give('iron_axe', 1);
  const door = await ask('you forgot door for house');
  const lower = pos(34, 190, 6),
    upper = lower.offset(0, 1, 0);
  assert.equal(block(lower).getProperties().half, 'lower');
  assert.equal(block(upper).getProperties().half, 'upper');
  assert.equal(door.buildId, entry.id);
  log('retrofit entrance door', { lower: block(lower).getProperties(), upper: block(upper).getProperties() });
  const g = await ask('add windows and torches to the house');
  const patch = g.blueprint.blocks;
  for (const [name, n] of [
    ['torch', 2],
    ['glass', 2]
  ])
    assert.equal(patch.filter((c) => c.material === name && block(v(c))?.name === name).length, n);
  assert.equal(block(pos(34, 191, 8)).name, 'diamond_block');
  const inventory = counts('torch');
  await ask('put torches in the house');
  assert.equal(counts('torch'), inventory);
  log('retrofit glass and torch positions', { patch, protected: true, idempotent: true });
}
async function ladders() {
  const x = 66,
    z = 7,
    y = 190;
  cmd('fill 64 190 5 69 199 10 air', 'fill 66 190 8 68 195 10 stone', 'fill 64 189 4 70 189 12 stone');
  await until('ladder support', () => at(pos(66, 195, 8), 'stone'));
  await tp(worker, pos(66.5, 190, 5.5));
  await tp(player, pos(65.5, 190, 4.5));
  await give('ladder', 6);
  for (let n = 0; n < 6; n++) {
    if (n === 3) {
      cmd('setblock 66 192 5 stone');
      await until('temporary platform', () => at(pos(66, 192, 5), 'stone'));
      await tp(worker, pos(66.5, 193, 5.5));
    }
    await place(bot, new Task('rung'), pos(x, y + n, z), 'ladder', {
      properties: regionProperties('ladder', { facing: 'north', half: null })
    });
    await until(
      'oriented rung ' + n,
      () => at(pos(x, y + n, z), 'ladder') && block(pos(x, y + n, z)).getProperties().facing === 'north'
    );
  }
  cmd('setblock 66 192 5 air');
  await tp(worker, pos(66.5, 190, 6.5));
  const g = await ask('climb up the ladder', 50);
  assert.equal(g.direction, 'up');
  assert.equal(bot.entity.position.floored().y, 196);
  log('six-rung ladder ascent', { end: bot.entity.position });
  const foot = g.ladder.foot;
  cmd('setblock ' + coord(foot) + ' stone');
  await until('changed bottom landing', () => at(v(foot), 'stone'));
  await assert.rejects(lib('./src/companion-actions').climbLadder(bot, new Task('resume descent'),
    { direction: 'down', ladder: g.ladder }, () => {}, navigate), /landing has changed/);
  assert.equal(bot.entity.position.floored().y, 196);
  cmd('setblock ' + coord(foot) + ' air');
  await until('restored landing', () => at(v(foot), 'air'));
  await tp(player, pos(67.5, 196, 9.5));
  await ask('climb down the ladder', 50);
  assert.equal(bot.entity.position.floored().y, 190);
  log('six-rung ladder descent', { end: bot.entity.position });
}
async function landmarks() {
  const table = pos(108, 190, 4), tree = pos(118, 190, 6);
  cmd('gamemode survival ' + player, 'forceload add 96 -8 127 23', 'fill 100 189 -2 125 189 15 stone', 'fill 100 190 -2 125 197 15 air',
    'setblock ' + coord(table) + ' crafting_table', 'fill 118 190 6 118 193 6 spruce_log',
    'fill 117 194 5 119 194 7 spruce_leaves[persistent=true]');
  await tp(worker, pos(107.5, 190, 6.5));
  await tp(player, pos(109.5, 190, 5.5));
  await until('speaker visible at landmark', () => bot.players[player]?.entity?.position.distanceTo(pos(109.5,190,5.5)) < 1);
  await until('table and tree', () => at(table, 'crafting_table') && at(tree, 'spruce_log'));
  for (const [message, item, anchor] of [
    ['put a torch beside the closest crafting table', 'torch', table],
    ['place a chest next to the closest spruce tree', 'chest', tree]
  ]) {
    const before = counts(item);
    await give(item, 1);
    const g = await ask(message);
    assert.equal(g.kind, 'place_at_site');
    assert.deepEqual(g.workSite.position, { ...anchor });
    assert.equal(g.placedAtSite.length, 1);
    const p = v(g.placedAtSite[0]);
    assert(p.distanceTo(anchor) > 0 && p.distanceTo(anchor) <= 4);
    assert.equal(block(p)?.name, item); assert.equal(counts(item), before);
    log('placed beside landmark', { item, anchor, position: p });
  }
  assert(at(table, 'crafting_table') && at(tree, 'spruce_log'));
  cmd('gamemode spectator ' + player);
}
async function light() {
  const c = pos(78, 190, 8);
  await tp(worker, pos(77.5, 190, 7.5));
  await tp(player, pos(78.5, 190, 8.5));
  cmd(
    'fill 70 190 0 86 196 16 air',
    'fill 70 189 0 86 189 16 stone',
    'fill 70 190 0 86 194 0 stone',
    'fill 70 190 16 86 194 16 stone',
    'fill 70 190 0 70 194 16 stone',
    'fill 86 190 0 86 194 16 stone',
    'fill 70 194 0 86 194 16 stone',
    'fill 70 190 0 86 193 0 stone',
    'setblock 78 190 -1 torch',
    'time set night'
  );
  await until('sealed wall', () => at(pos(78, 191, 0), 'stone'));
  await give('torch', 12);
  let before = counts('torch');
  const g = await ask('light up this room');
  assert(g.torchesPlaced >= 1 && g.torchesPlaced <= 4);
  assert.equal(before - counts('torch'), g.torchesPlaced);
  const surveyed = lib('./src/torches'),
    dark = surveyed.darkCells(witness, surveyed.connectedGround(witness, v(g.lightCentre), 6));
  assert.equal(dark.length, 0);
  before = counts('torch');
  const again = await ask('place torches around here');
  assert.equal(again.torchesPlaced || 0, 0);
  assert.equal(counts('torch'), before);
  log('smart room lighting', { count: g.torchesPlaced, remainingDark: dark.length, repeat: 0 });
  cmd('time set day');
}
async function furnished() {
  await tp(player, pos(54.5, 192, 6.5));
  await tp(worker, pos(50.5, 190, 5.5));
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'terra-snowy-taiga.json'))),
    design = { ...validateSchematic(source, bot.registry), model: 'gpt-6.1-terra', backend: 'guide' };
  const at = pos(48, 189, 8),
    blueprint = selectSchematicSite(bot, design, { at, allowPreserved: false });
  assert(blueprint, 'anchored Terra site');
  const g = { kind: 'build', request: 'build the designed spruce starter house', starterBeds: 2, design, blueprint };
  cmd('fill 47 190 7 56 196 17 air');
  const shell = blueprint.blocks.filter((p) => p.material === 'spruce_planks');
  cmd(
    ...shell.map((p) => 'setblock ' + coord(p) + ' spruce_planks'),
    ...blueprint.blocks.filter((p) => p.material !== 'spruce_planks').map((p) => 'setblock ' + coord(p) + ' air')
  );
  await until('shell', () => block(v(shell.at(-1)))?.name === 'spruce_planks');
  await give('spruce_door', 2);
  await give('glass', 2);
  await give('torch', 2);
  await give('spruce_stairs', 2);
  await give('chest', 1);
  await give('white_bed', 2);
  let goal = g,
    interrupted = false,
    done = false;
  const initial = JSON.stringify(goal.design.source);
  const checkpoint = () => fs.writeFileSync(path.join(statepath, 'terra-checkpoint.json'), JSON.stringify(goal));
  for (let n = 0; n < 70 && !done; n++) {
    try {
      done = await designedBuildStep(bot, new Task('terra house'), goal, checkpoint);
    } catch (err) {
      if (n > 24 || !/Timed out waiting for world|Server refused|Cannot place/.test(err.message)) throw err;
      const around = blueprint.blocks
        .filter((c) => c.material.endsWith('_door'))
        .map((c) => ({
          at: coord(c),
          want: c.properties,
          actual: bot.blockAt(v(c))?.getProperties(),
          name: bot.blockAt(v(c))?.name
        }));
      log('construction retry', { message: err.message, around, step: goal.step, feet: bot.entity.position });
      if (n > 24) throw err;
      await sleep(350);
    }
    if (!interrupted && (goal.placedCount >= 2 || n === 3)) {
      checkpoint();
      goal = JSON.parse(fs.readFileSync(path.join(statepath, 'terra-checkpoint.json')));
      interrupted = true;
    }
  }
  assert(done);
  assert(interrupted);
  assert.equal(JSON.stringify(goal.design.source), initial);
  for (const c of blueprint.blocks) assert(buildCellComplete(witness, c), c.material + ' at ' + coord(c));
  log('Terra furnished home resumed', {
    dimensions: source.size,
    materials: design.materials,
    interrupted,
    origin: blueprint.origin
  });
}
async function boat() {
  cmd(
    'forceload add 192 -16 287 16',
    'fill 200 77 -8 280 85 8 air',
    'fill 200 77 -8 280 80 8 stone',
    'fill 206 78 -6 270 80 6 water',
    'kill @e[type=minecraft:oak_boat,x=200,y=78,z=-8,dx=80,dy=8,dz=16]'
  );
  await tp(player, pos(236.5, 81, -7.5));
  await tp(worker, pos(203.5, 81, 0.5));
  await until('lake', () => at(pos(206, 80, 0), 'water'));
  await give('oak_boat', 1);
  const route = await lib('./src/objectives').interpret(null, worker + ' come to me by boat', player, worker, {
    registry: bot.registry
  });
  assert.equal(route.byBoat, true);
  let views = 0,
    maxX = 0;
  const watch = setInterval(() => {
    const riding = witness.players[worker]?.entity?.vehicle;
    if (riding) {
      views++;
      maxX = Math.max(maxX, riding.position.x);
    }
  }, 100);
  try {
    const goal = { ...route },
      dest = pos(276.5, 81, 0.5);
    for (let n = 0; n < 12 && !goal.boatTravel?.completed; n++)
      assert(await boatTravelStep(bot, new Task('boat crossing'), goal, () => {}, dest, { acquireStep }));
    assert(goal.boatTravel?.completed);
    await until('recovered boat', () => counts('oak_boat') === 1);
    assert.equal(bot.vehicle, null);
    assert(views > 20 && maxX > 265);
    assert(bot.entity.position.x >= 271);
    log('observed mounted crossing and boat recovery', {
      views,
      maxX,
      bank: bot.entity.position,
      boat: counts('oak_boat')
    });
  } finally {
    clearInterval(watch);
  }
}
async function craftDoor() {
  await tp(worker, pos(43.5, 190, 4.5));
  cmd('setblock 44 190 4 crafting_table');
  await until('crafting table', () => at(pos(44, 190, 4), 'crafting_table'));
  await give('dark_oak_planks', 6);
  const result = await ask('craft a door', 55);
  assert.equal(result.item, 'dark_oak_door');
  assert(counts('dark_oak_door') >= 1);
  log('crafted doors from planks', { doors: counts('dark_oak_door'), remaining: counts('dark_oak_planks') });
}
async function fresh() {
  await tp(worker, pos(43.5, 190, 1.5));
  await tp(player, pos(42.5, 190, 2.5));
  cmd('gamemode survival ' + player);
  await sleep(400);
  for (const [item, n] of [
    ['spruce_planks', 236],
    ['glass', 18],
    ['torch', 16],
    ['spruce_door', 4],
    ['chest', 2],
    ['white_bed', 2],
    ['spruce_stairs', 18],
    ['spruce_slab', 32],
    ['dirt', 64],
    ['bread', 12],
    ['iron_axe', 1]
  ])
    await give(item, n);
  cmd('fill 24 188 -8 86 189 24 dirt');
  await until('new build ground', () => at(pos(43, 189, 0), 'dirt'));
  const message = 'help me build a small spruce house for two';
  witness.chat(worker + ' ' + message);
  await until('requester and house site recorded', () => state().buildAnchor && state().request?.includes(message));
  cmd('gamemode spectator ' + player);
  await tp(player, pos(50.5, 198, 8.5));
  await until(
    'new planned house',
    () => state().blueprint?.blocks?.length > 75 && state().request?.includes(message),
    210
  );
  const original = state(),
    signature = JSON.stringify(original.design.source),
    origin = original.blueprint.origin;
  assert.ok(original.design.model, 'a separate designer must produce the drawing');
  await until(
    'first site work',
    () => original.blueprint.blocks.filter((c) => c.y > origin.y && buildCellComplete(witness, c)).length > 2,
    240
  );
  witness.chat(worker + ' stop');
  await until('checkpoint on stop', () => state().status === 'cancelled', 15);
  if (process.env.JEV_REVIEW_CHECKPOINT_ONLY === '1') {
    const placed = original.blueprint.blocks.filter(c => c.y > origin.y && matchesBuildBlock(block(v(c)), c));
    assert(placed.length > 0);
    const stock = Object.fromEntries(['spruce_planks', 'spruce_door', 'spruce_stairs', 'torch', 'glass', 'white_bed', 'chest'].map(item => [item, counts(item)]));
    fs.writeFileSync(path.join(run, 'fresh-checkpoint.json'), JSON.stringify({ placed, stock }));
    log('saved fresh house for a separate window', { origin, placed: placed.length, stock });
    return;
  }
  witness.chat(worker + ' resume');
  await until('resumed build complete', () => state().status === 'complete' && state().request?.includes(message), 520);
  const goal = state();
  assert.equal(JSON.stringify(goal.design.source), signature);
  assert.deepEqual(goal.blueprint.origin, origin);
  for (const c of goal.blueprint.blocks) assert(buildCellComplete(witness, c), c.material + ' ' + coord(c));
  log('ordinary chat to model-designed house, stopped and resumed', {
    model: goal.design.model,
    size: goal.design.source.size,
    materials: goal.design.materials,
    origin,
    checkedBlocks: goal.blueprint.blocks.length
  });
}
const scenes = { fittings: retrofit, ladder: ladders, landmarks, lighting: light, furnished, boat, craft: craftDoor, fresh },
  fail = [];
(async () => {
  await until('witness login', () => witness.entity?.position && witness.health > 0, 55);
  cmd(
    'gamemode spectator ' + player,
    'difficulty peaceful',
    'time set day',
    'gamerule advance_time false',
    'gamerule minecraft:spawn_mobs false',
    'forceload add 24 -16 88 48'
  );
  await tp(player, pos(50.5, 195, 7.5));
  await witness.waitForChunksToLoad();
  cmd('fill 24 189 -8 86 189 24 stone', 'fill 24 190 -8 86 199 24 air');
  session = createSession({ ...cfg, username: worker }, new TypeSafe(), { stateDirectory: statepath });
  bot = session.bot;
  bot.on('blockPlaced', (a, b) => {
    if (['cobblestone', 'dirt'].includes(b.name))
      log('own support', { position: coord(b.position), old: a.name, material: b.name });
  });
  witness.on('messagestr', (m) => {
    if (m.includes(worker)) log('chat', { m });
  });
  await until('worker login', () => bot.entity?.position && bot.health > 0, 40);
  await sleep(3400);
  cmd('gamemode survival ' + worker);
  await tp(worker, pos(40.5, 190, 6.5));
  await clearStock();
  for (const name of process.argv.length > 2 ? process.argv.slice(2) : Object.keys(scenes)) {
    try {
      await scenes[name]();
      log('pass', { scene: name });
    } catch (e) {
      fail.push(name);
      log('fail', {
        scene: name,
        error: e.message,
        stack: e.stack.split('\n').slice(0, 5),
        goal: state().status,
        step: state().step,
        position: bot.entity?.position
      });
      witness.chat(worker + ' stop');
      await sleep(800);
    }
  }
})()
  .catch((e) => {
    fail.push('setup');
    log('fail', { error: e.stack });
  })
  .finally(async () => {
    session?.shutdown();
    witness.quit();
    await sleep(500);
    log('finished', { fail });
    process.exit(fail.length ? 1 : 0);
  });
