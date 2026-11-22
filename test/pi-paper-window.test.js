'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const fixture = path.resolve(__dirname, '../scripts/pi-paper/fixture.cjs');
const wrapper = path.resolve(__dirname, '../scripts/pi-paper/window.sh');

function temp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-paper-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function template(base) {
  const world = path.join(base, 'newworld/world');
  fs.mkdirSync(world, { recursive: true });
  fs.writeFileSync(path.join(base, '.jevcraft-private-review'), '');
  fs.writeFileSync(path.join(base, 'newworld/paper.jar'), '');
  fs.writeFileSync(path.join(base, 'newworld/server.properties'), 'level-name=world\nserver-ip=127.0.0.1\nserver-port=25575\n');
  for (const key of ['blocks', 'inventory']) fs.writeFileSync(path.join(world, key), 'original');
}
test('fresh worlds preserve placed blocks and player inventory across unrelated scenarios and fresh runs', t => {
  const base = temp(t);
  template(base);
  function prepare(mode, run, selected) {
    const env = { ...process.env, TESTCOPY: base, JEV_REVIEW_BASE: base, JEV_REVIEW_RUN: path.join(base, 'runs', run),
      JEV_REVIEW_PREPARE: mode, JEV_REVIEW_FROM: selected || '', JEV_REVIEW_VALIDATE_ONLY: '0' };
    const result = spawnSync(process.execPath, [fixture], {env, encoding:'utf8'});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function unfinished(run) {
    const state = path.join(base, 'runs', run, 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, '127_0_0_1-25575-HouseJev.json'), JSON.stringify({
      kind: 'build', status: 'cancelled', starterBeds: 2, blueprint: {}, design: {model:'test'}
    }));
  }
  const first = prepare('fresh', 'first'), regular = prepare('regular', 'second');
  unfinished('first'); unfinished('second');
  const next = prepare('fresh', 'third');
  assert.deepEqual([first, regular, next], [
    path.join(base, 'runs/first/paper'), path.join(base, 'fixtures/regular'), path.join(base, 'runs/third/paper')
  ]);
  for (const key of ['blocks', 'inventory']) {
    for (const [dir, value] of [[first,'checkpoint'], [regular,'reset'], [next,'new house']])
      fs.writeFileSync(path.join(dir, 'newworld/world', key), value);
    const resumed = prepare('resume', 'again');
    assert.equal(resumed, first);
    assert.equal(fs.readFileSync(path.join(resumed, 'newworld/world', key), 'utf8'), 'checkpoint');
    assert.equal(fs.readFileSync(path.join(base, 'newworld/world', key), 'utf8'), 'original');
  }
  unfinished('legacy');
  assert.equal(prepare('resume', 'legacy-review', 'legacy'), base);
  fs.renameSync(first, first + '-missing');
  assert.throws(() => prepare('resume', 'missing-review', 'first'), /world.*missing/);
});

test('two private directories contend for the same live service before player checks', {skip: process.platform !== 'linux'}, async t => {
  const dir = temp(t), guard = path.join(dir, 'paper/tools/testcopy'), shim = path.join(dir, 'node');
  fs.mkdirSync(guard, { recursive: true });
  for (const f of ['window.sh','nw.sh','doorknock.py']) fs.writeFileSync(path.join(guard, f), '');
  const signal = path.join(dir, 'entered'), release = path.join(dir, 'release');
  fs.writeFileSync(shim, `#!/bin/sh
if [ "$1" = "-e" ]; then
  touch "$ENTERED"
  for i in $(seq 1 100); do [ -f "$RELEASE" ] && break; sleep .05; done
  exit 87
fi
exec "$REAL_NODE" "$@"
`, { mode: 0o755 });
  const env = base => ({...process.env, JEV_REVIEW_DIR:base, JEV_LIVE_PAPER:path.join(dir,'paper'), JEV_NODE:shim,
    JEV_REVIEW_ENV:shim, ENTERED:signal, RELEASE:release, REAL_NODE:process.execPath});
  const a = path.join(dir,'a'), b = path.join(dir,'b');
  template(a); template(b);
  const first = spawn('bash', [wrapper, 'craft'], {env:env(a), stdio:['ignore','ignore','pipe']});
  let diagnostic = '';
  first.stderr.setEncoding('utf8').on('data', chunk => { diagnostic += chunk; });
  const done = new Promise((resolve,reject) => { first.on('close',resolve); first.on('error',reject); });
  try {
    for (let i=0; i<100 && first.exitCode === null && !fs.existsSync(signal); i++) await new Promise(r => setTimeout(r,30));
    if (first.exitCode === 2 && diagnostic.includes('Another private window is active')) return t.skip('A real private Paper window holds the service lock');
    assert(fs.existsSync(signal), diagnostic);
    const other = spawnSync('bash', [wrapper, 'craft'], {env:env(b), encoding:'utf8'});
    assert.equal(other.status, 2);
    assert.match(other.stderr, /Another private window is active/);
  } finally {
    fs.writeFileSync(release, '');
    await done;
  }
  assert.equal(first.exitCode, 87);
});
