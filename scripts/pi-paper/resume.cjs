const fs = require('fs'),
  path = require('path'),
  { root: S, run, interruptedBuild, lib } = require('./fixture.cjs'),
  assert = require('node:assert/strict');
const mc = lib('mineflayer'),
  { Vec3 } = lib('vec3'),
  { createSession } = lib('./src/session'),
  { TypeSafe } = lib('./src/typesafe'),
  { buildCellComplete, matchesBuildBlock } = lib('./src/build-blocks');
const cfg = { host: '127.0.0.1', port: 25575, version: '26.1', auth: 'offline' },
  dir = interruptedBuild(),
  file = path.join(dir, '127_0_0_1-25575-HouseJev.json'),
  state = () => JSON.parse(fs.readFileSync(file)),
  delay = (ms) => new Promise((r) => setTimeout(r, ms));
assert.equal(process.cwd(), S);
assert.equal(process.env.MC_PORT, '25575');
const start = state(),
  sig = JSON.stringify(start.design.source),
  at = start.blueprint.origin;
let captures = 0;
const cmd = (lines) => fs.appendFileSync(path.join(S, 'newworld/console.in'), lines + '\n');
const log = (n, obj) => {
  console.log(n, JSON.stringify(obj));
  fs.appendFileSync(path.join(run, 'resume.log'), n + ' ' + JSON.stringify(obj) + '\n');
};
const witness = mc.createBot({ ...cfg, username: 'HouseTester' }),
  session = createSession({ ...cfg, username: 'HouseJev' }, new TypeSafe(), { stateDirectory: dir }),
  bot = session.bot;
bot.on('confirmedBuildScaffold', (b) => {
  captures++;
  log('server confirmed own support', { at: b.position, name: b.name });
});
witness.on('messagestr', (m) => {
  if (m.includes('HouseJev')) log('chat', m);
});
(async () => {
  await new Promise((r) => bot.once('spawn', r));
  await delay(2600);
  // Bring the two private clients back to the saved site, as a returning
  // player would. Preserve the structure, inventory and drawing on disk.
  const entrance = start.blueprint.entrance;
  const min = start.blueprint.bounds.min,
    max = start.blueprint.bounds.max;
  const dx = entrance.x < min.x ? -1 : entrance.x > max.x ? 1 : 0;
  const dz = entrance.z < min.z ? -1 : entrance.z > max.z ? 1 : 0;
  const approach = [entrance.x + dx + 0.5, entrance.y, entrance.z + dz + 0.5].join(' ');
  cmd('gamemode spectator HouseTester');
  cmd('tp HouseTester ' + [entrance.x + 0.5, entrance.y + 3, entrance.z + 0.5].join(' '));
  cmd('tp HouseJev ' + approach);
  await delay(900);
  const evidence = path.join(path.dirname(dir), 'fresh-checkpoint.json');
  const receipt = path.join(path.dirname(dir), 'checkpoint-verified.json');
  if (fs.existsSync(evidence) && !fs.existsSync(receipt)) {
    await Promise.all([witness.waitForChunksToLoad(), bot.waitForChunksToLoad()]);
    const { placed, stock } = JSON.parse(fs.readFileSync(evidence));
    for (const c of placed) assert(matchesBuildBlock(witness.blockAt(new Vec3(c.x,c.y,c.z)), c), 'saved block ' + JSON.stringify(c));
    for (const [item, count] of Object.entries(stock)) {
      const carried = bot.inventory.items().filter(i => i.name === item).reduce((sum,i) => sum + i.count, 0);
      assert(carried >= count, 'saved supply ' + item + ' expected ' + count + ', found ' + carried);
    }
    log('verified saved blocks and inventory before resume', { placed: placed.length, stock });
    fs.writeFileSync(receipt, JSON.stringify({ verifiedIn: path.basename(run) }) + '\n');
  }
  witness.chat('HouseJev resume');
  const deadline = Date.now() + 610000;
  while (Date.now() < deadline) {
    const g = state();
    if (g.status === 'complete') {
      for (const c of g.blueprint.blocks) assert(buildCellComplete(witness, c), c.material + ' ' + JSON.stringify(c));
      assert.deepEqual(g.blueprint.origin, at);
      assert.equal(JSON.stringify(g.design.source), sig);
      log('PASS completed saved fresh house', {
        size: g.design.source.size,
        model: g.design.model,
        blocks: g.blueprint.blocks.length,
        origin: at,
        captures
      });
      return;
    }
    await delay(500);
  }
  throw Error('unfinished ' + JSON.stringify({ status: state().status, step: state().step, error: state().lastError }));
})()
  .catch((e) => {
    log('FAIL', e.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    session.shutdown();
    witness.quit();
    await delay(500);
    process.exit(process.exitCode || 0);
  });
