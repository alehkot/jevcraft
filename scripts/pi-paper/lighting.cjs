const { root, lib } = require('./fixture.cjs'),
  fs = require('fs'),
  assert = require('assert/strict'),
  { once } = require('events');
const { Vec3 } = lib('vec3'),
  v = (x, y, z) => new Vec3(x, y, z),
  { Task, navigate } = lib('./src/skills'),
  { place, acquireStep } = lib('./src/work'),
  { lightArea } = lib('./src/companion-actions'),
  { darkCells, connectedGround } = lib('./src/torches');
if (process.cwd() !== root || process.env.MC_PORT !== '25575') throw Error('private copy required');
const cfg = { host: '127.0.0.1', port: 25575, version: '26.1', auth: 'offline' },
  mc = lib('mineflayer'),
  bot = mc.createBot({ ...cfg, username: 'EdgeLighter' }),
  eye = mc.createBot({ ...cfg, username: 'EdgeReader' });
bot.loadPlugin(lib('./src/compatibility').compatibilityPlugin);
bot.loadPlugin(lib('mineflayer-pathfinder').pathfinder);
const delay = (ms) => new Promise((r) => setTimeout(r, ms)),
  cmd = (...c) => fs.appendFileSync(root + '/newworld/console.in', c.join('\n') + '\n');
(async () => {
  await Promise.all([once(bot, 'spawn'), once(eye, 'spawn')]);
  cmd(
    'forceload add 128 16 159 47',
    'fill 132 189 25 153 194 44 stone',
    'fill 133 190 26 142 193 43 air',
    'fill 144 190 26 152 193 43 air',
    'gamemode spectator EdgeReader',
    'tp EdgeReader 149 191 35',
    'tp EdgeLighter 144.5 190 35.5',
    'gamemode survival EdgeLighter',
    'give EdgeLighter torch 8'
  );
  await delay(1200);
  await Promise.all([bot.waitForChunksToLoad(), eye.waitForChunksToLoad()]);
  lib('./src/movement').configureMovements(bot);
  const g = { requesterPosition: { x: 144, y: 190, z: 35 } },
    task = new Task('light'),
    actions = { acquireStep, place, navigate };
  let done = false;
  for (let i = 0; i < 5 && !done; i++) done = await lightArea(bot, task, g, () => {}, actions);
  assert(done);
  assert(g.torchesPlaced > 0 && g.torchesPlaced <= 3);
  const east = connectedGround(eye, v(144, 190, 35), 6);
  assert(east.every((p) => p.x >= 144));
  assert.equal(darkCells(eye, east).length, 0);
  assert.equal(darkCells(eye, [v(142, 190, 35)]).length, 1);
  assert(await lightArea(bot, task, g, () => {}, actions));
  console.log(
    'PASS',
    g.torchesPlaced,
    'torches,',
    east.length,
    'lit tiles in the requested room, neighbouring room still dark'
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    bot.quit();
    eye.quit();
    await delay(450);
    process.exit(process.exitCode || 0);
  });
