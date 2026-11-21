'use strict';
// How the bot talks: JEV_NARRATION's levels (narration.js narrate) and
// JEV_PERSONALITY in the language layer's instructions (guide.js SYSTEM).
//
//   node test/voice.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { narrate, setRandom } = require('../src/narration');
const { createGuide, SYSTEM, PERSONALITIES } = require('../src/guide');

const bot = () => ({ said: [], chat(line) { this.said.push(line); }, game: { dimension: 'overworld' }, time: { timeOfDay: 1000 }, food: 20, entity: { position: { x: 0, y: 64, z: 0 } } });
const step = () => ({ step: { action: 'craft', item: 'stick' }, decisions: [] });
const survival = () => ({ survivalAction: { action: 'sheltered', at: 1 } });
function said(level, goal) {
  if (level) process.env.JEV_NARRATION = level; else delete process.env.JEV_NARRATION;
  try { const b = bot(); setRandom(() => 0); narrate(b, goal, { now: 10000 }); return b.said.length; }
  finally { delete process.env.JEV_NARRATION; setRandom(); }
}

test('narration: unset and full say both, important survival only, off neither', () => {
  assert.deepEqual([undefined, 'full', 'important', 'off'].map(level => [said(level, step()), said(level, survival())]),
    [[1, 1], [1, 1], [0, 1], [0, 0]]);
});

test('personality: a manner for say only, none when unset or unknown', async () => {
  assert.ok(SYSTEM('Jev', { personality: 'playful' }).includes(PERSONALITIES.playful));
  assert.equal(SYSTEM('Jev'), SYSTEM('Jev', { personality: 'grumpy' }));
  const sent = [];
  const fetchImpl = async (url, { body }) => { sent.push(JSON.parse(body).messages[0].content); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"say":"Hi!","requests":[]}' } }] }) }; };
  const guide = createGuide({ apiKey: 'test', fetchImpl, personality: 'Reserved' });
  await guide.consult({ from: 'Alex', text: 'hello', botName: 'Jev' });
  assert.ok(sent[0].includes(PERSONALITIES.reserved));
});
