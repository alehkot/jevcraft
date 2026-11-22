'use strict';
const fs = require('fs'),
  assert = require('node:assert/strict'),
  path = require('path'),
  { root: S, run, lib } = require('./fixture.cjs');
const mc = lib('mineflayer'),
  { Vec3 } = lib('vec3'),
  { TypeSafe } = lib('./src/typesafe'),
  { createSession } = lib('./src/session');
const worker = 'HomeScout',
  player = 'HomeReader',
  cfg = { host: '127.0.0.1', port: 25575, auth: 'offline', version: '26.1' };
assert.equal(process.env.MC_PORT, '25575');
assert.equal(process.cwd(), S);
const root = path.join(run, 'locations-state'),
  delay = (ms) => new Promise((r) => setTimeout(r, ms)),
  v = (x, y, z) => new Vec3(x, y, z),
  lines = [];
function cmd(...lines) {
  fs.appendFileSync(path.join(S, 'newworld/console.in'), lines.join('\n') + '\n');
}
const log = (what, data = {}) => {
  const row = JSON.stringify({ at: new Date().toISOString(), what, ...data });
  console.log(row);
  fs.appendFileSync(path.join(run, 'locations.jsonl'), row + '\n');
};
async function until(label, f, secs = 15) {
  const t = Date.now() + secs * 1000;
  while (Date.now() < t) {
    if (f()) return;
    await delay(100);
  }
  throw Error('timeout ' + label);
}
const witness = mc.createBot({ ...cfg, username: player });
witness.on('messagestr', (m) => {
  lines.push(m);
  if (m.includes(worker)) log('chat', { m });
});
let session, bot;
const get = () => bot.homeLocation.context(player);
async function connect() {
  session = createSession({ ...cfg, username: worker }, new TypeSafe(), { stateDirectory: root });
  bot = session.bot;
  bot._client.on('custom_payload', (p) => {
    if (p.channel === 'jevcraft:locations') log('paper snapshot', { data: JSON.parse(p.data.toString()) });
  });
  await until('login', () => bot.entity?.position && bot.health > 0, 45);
  await delay(1000);
  await bot.homeLocation.refresh();
  await until('Paper report', () => get().respawn.confirmed);
}
async function ask(line, part) {
  const n = lines.length;
  witness.chat(worker + ' ' + line);
  await until(line, () => lines.slice(n).some((s) => s.includes('<' + worker + '>') && s.includes(part)), 20);
}
(async () => {
  await until('witness login', () => witness.entity?.position && witness.health > 0, 45);
  cmd(
    'forceload add 96 32',
    'fill 94 189 30 107 189 41 stone',
    'fill 94 190 30 107 195 41 air',
    'gamemode survival ' + player,
    'tp ' + player + ' 98.5 190 32.5'
  );
  await connect();
  cmd('gamemode survival ' + worker, 'tp ' + worker + ' 99.5 190 33.5');
  await until(
    'both players visible',
    () => bot.players[player]?.entity && bot.entity.position.distanceTo(v(99.5, 190, 33.5)) < 0.4
  );
  assert.equal(get().respawn.rule, 'server_spawn');
  log('server-set fallback', get());
  await ask('set our home here', '98, 190, 32');
  const home = get().home.position;
  assert.equal(home.x, 98);
  cmd('tp ' + player + ' 102.5 190 32.5');
  await until('personal marker site', () => Math.floor(bot.players[player]?.entity?.position.x) === 102);
  let n = lines.length;
  witness.chat(worker + ' set my home here');
  await until('personal home confirmation', () => lines.slice(n).some(s => s.includes('102, 190, 32')));
  assert.equal(get().home.position.x, 102);
  assert.equal(bot.homeLocation.home('AnotherPlayer').position.x, 98);
  n = lines.length;
  witness.chat(worker + ' forget my home');
  await until('personal marker forgotten', () => lines.slice(n).some(s => s.includes('forgot your saved home')));
  assert.equal(bot.homeLocation.home(player, 'personal'), null);
  assert.deepEqual(get().home.position, home);
  log('personal home isolated from shared home and forgotten', { shared: home });
  await ask('where is home and where will you respawn', 'server spawn');
  cmd('setblock 100 190 34 red_bed[facing=south,part=foot]', 'setblock 100 190 35 red_bed[facing=south,part=head]');
  await until('bed', () => bot.blockAt(v(100, 190, 34))?.name === 'red_bed');
  await bot.activateBlock(bot.blockAt(v(100, 190, 34)));
  await delay(700);
  await ask('where is your resurrection point', 'personal point');
  const intended = get().respawn.position;
  session.shutdown();
  await session.closed;
  await delay(700);
  await connect();
  assert.deepEqual(get().home.position, home);
  await ask('where is your respawn point', 'personal point');
  cmd('kill ' + worker);
  await session.closed;
  await delay(800);
  await connect();
  await delay(600);
  const after = bot.entity.position;
  assert(Math.hypot(after.x - intended.x, after.z - intended.z) < 17, 'actual landing near configured server spawn');
  assert(Math.hypot(after.x - 100, after.z - 34) > 17, 'actual landing distinct from bed');
  assert(get().lastRespawn);
  log('bed, home, relog and actual respawn', {
    home,
    expected: intended,
    observed: after,
    lastLanding: get().lastRespawn
  });
  cmd('setblock 100 190 34 air', 'setblock 100 190 35 air');
  await delay(700);
  await bot.homeLocation.refresh();
  const line = bot.homeLocation.describe(player, 'both');
  assert(!line.includes('personal point'));
  assert.deepEqual(get().home.position, home);
  log('removed bed while away', { line });
  log('PASS');
})()
  .catch((e) => {
    log('FAIL', { message: e.message, stack: e.stack });
    process.exitCode = 1;
  })
  .finally(async () => {
    session?.shutdown();
    witness.quit();
    await delay(500);
    process.exit(process.exitCode || 0);
  });
