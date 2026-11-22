const fs = require('fs'),
  path = require('path'),
  { root: S, run, runs, lib } = require('./fixture.cjs'),
  assert = require('node:assert/strict');
const mc = lib('mineflayer'),
  { Vec3 } = lib('vec3'),
  { createSession } = lib('./src/session'),
  { TypeSafe } = lib('./src/typesafe'),
  { buildCellComplete } = lib('./src/build-blocks');
function mostRecentBuild() {
  const selected = process.env.JEV_REVIEW_FROM;
  const names = selected ? [selected] : fs.readdirSync(runs).sort().reverse();
  for (const name of names) {
    if (path.basename(name) !== name) throw new Error('JEV_REVIEW_FROM must name a run in the runs directory.');
    const dir = path.join(runs, name, 'state'),
      f = path.join(dir, '127_0_0_1-25575-HouseJev.json');
    if (fs.existsSync(f)) {
      const saved = JSON.parse(fs.readFileSync(f));
      if (
        saved.kind === 'build' &&
        saved.starterBeds &&
        saved.blueprint &&
        saved.design?.model &&
        saved.status !== 'complete'
      )
        return dir;
    }
  }
  throw new Error('No interrupted fresh house was found in the private runs directory.');
}
const cfg = { host: '127.0.0.1', port: 25575, version: '26.1', auth: 'offline' },
  dir = mostRecentBuild(),
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
