'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(process.env.TESTCOPY || process.cwd());
const server = path.join(root, 'newworld');
if (!fs.existsSync(path.join(root, '.jevcraft-private-review')) || fs.realpathSync(server) !== server)
  throw new Error('Select the marked private review directory with TESTCOPY.');
const props = fs.readFileSync(path.join(server, 'server.properties'), 'utf8');
if (
  !/^server-ip=127\.0\.0\.1$/m.test(props) ||
  !/^server-port=25575$/m.test(props) ||
  !/^level-name=world$/m.test(props) ||
  fs.realpathSync(path.join(server, 'world')) !== path.join(server, 'world')
)
  throw new Error('Expected a separate loopback Paper world on port 25575.');
const base = fs.realpathSync(process.env.JEV_REVIEW_BASE || root);
const runs = path.join(base, 'runs');
const run = path.resolve(process.env.JEV_REVIEW_RUN || path.join(runs, String(Date.now())));
if (path.dirname(run) !== runs) throw new Error('Review output must be a direct child of the private runs directory.');
if (process.env.JEV_REVIEW_VALIDATE_ONLY !== '1') fs.mkdirSync(run, { recursive: true });

function interruptedBuild() {
  const selected = process.env.JEV_REVIEW_FROM;
  for (const name of selected ? [selected] : fs.readdirSync(runs).sort().reverse()) {
    if (path.basename(name) !== name || name === '.' || name === '..') throw new Error('Select a run directory by name.');
    const dir = path.join(runs, name, 'state');
    const description = path.join(runs, name, 'fixture.json');
    if (fs.existsSync(description) && JSON.parse(fs.readFileSync(description)).mode !== 'fresh') continue;
    const file = path.join(dir, '127_0_0_1-25575-HouseJev.json');
    if (!fs.existsSync(file)) continue;
    const g = JSON.parse(fs.readFileSync(file));
    if (g.kind === 'build' && g.starterBeds && g.blueprint && g.design?.model && g.status !== 'complete') return dir;
  }
  throw new Error('No interrupted fresh house was found in the private runs directory.');
}

function reviewWorld(mode) {
  if (mode === 'resume') {
    const saved = path.join(path.dirname(interruptedBuild()), 'paper');
    // Runs from before isolated fixtures used the original private server.
    if (fs.existsSync(path.join(path.dirname(saved), 'fixture.json')) && !fs.existsSync(saved))
      throw new Error('The private world for this fresh run is missing.');
    return fs.existsSync(saved) ? saved : base;
  }
  const dir = mode === 'fresh' ? path.join(run, 'paper') : path.join(base, 'fixtures', 'regular');
  if (fs.existsSync(path.join(dir, '.jevcraft-private-review'))) return dir;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const staging = fs.mkdtempSync(dir + '.preparing-');
  try {
    fs.cpSync(path.join(base, 'newworld'), path.join(staging, 'newworld'), {
      recursive: true, mode: fs.constants.COPYFILE_FICLONE,
      filter: file => !['logs', 'crash-reports', 'console.in', 'server.log', 'session.lock'].includes(path.basename(file))
    });
    fs.writeFileSync(path.join(staging, '.jevcraft-private-review'), 'Isolated Paper review world\n');
    fs.renameSync(staging, dir);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  return dir;
}

if (require.main === module && process.env.JEV_REVIEW_PREPARE) {
  const mode = process.env.JEV_REVIEW_PREPARE;
  if (!['regular', 'fresh', 'resume'].includes(mode)) throw new Error('Unknown private fixture mode.');
  const selected = reviewWorld(mode);
  fs.writeFileSync(path.join(run, 'fixture.json'), JSON.stringify({ mode, directory: selected }) + '\n');
  console.log(selected);
}
module.exports = {
  root,
  run,
  runs,
  interruptedBuild,
  lib: require('node:module').createRequire(path.join(__dirname, '../../package.json'))
};
