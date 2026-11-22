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
const runs = path.join(root, 'runs');
const run = path.resolve(process.env.JEV_REVIEW_RUN || path.join(runs, String(Date.now())));
if (path.dirname(run) !== runs) throw new Error('Review output must be a direct child of the private runs directory.');
if (process.env.JEV_REVIEW_VALIDATE_ONLY !== '1') fs.mkdirSync(run, { recursive: true });
module.exports = {
  root,
  run,
  runs,
  lib: require('node:module').createRequire(path.join(__dirname, '../../package.json'))
};
