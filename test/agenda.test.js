'use strict';
// The work set aside and taken up again (src/agenda.js, src/suspended-tasks.js; asked for 2026-11-22): "continue"
// and "continue building the house" read by rule; an errand on top gives way to the work it interrupted; a building
// begun and not finished is known wherever it stands, however little of it stands; and the line said when an
// errand is done with work still set aside.
//
//   node test/agenda.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const agenda = require('../src/agenda');
const { resumeSaved } = require('../src/suspended-tasks');
const { BuildRegistry } = require('../src/builds');

const house = { kind: 'build', request: 'Jev build a starter house for two people', from: 'Robin', status: 'replaced', buildId: 'h1',
  blueprint: { origin: { x: 300, y: 64, z: 10 } } };
const planks = { kind: 'obtain', request: 'Jev get me 8 planks', from: 'Robin', status: 'replaced', item: 'oak_planks', count: 8 };
const come = (over = {}) => ({ kind: 'come', request: 'Jev come to me', from: 'Robin', target: 'Robin', status: 'complete', ...over });

test('continuation requests are read by rule: any work, or a building', () => {
  for (const t of ['continue', 'carry on', 'keep going', 'get back to work', 'continue what you were doing', 'Continue!'])
    assert.deepEqual(agenda.continueAsk(t), { what: 'any' }, t);
  for (const t of ['continue building the house', 'continue building house', 'finish the house', 'finish building', 'keep building',
    'go back to building the house', 'continue the house you started', 'finish my house', 'resume building the starter house', 'carry on with the cottage', 'please finish the tower',
    // A full stop in the middle once took it past the rule.
    'continue building. house', 'Continue building, house!', 'please, finish the house.'])
    assert.deepEqual(agenda.continueAsk(t), { what: 'build' }, t);
  for (const t of ['build a house', 'follow me', 'continue to follow me', 'continue mining', 'get me 8 planks', 'come here', 'continue. follow me', 'finish. the house is ugly'])
    assert.equal(agenda.continueAsk(t), null, t);
  const { companionAction } = require('../src/companion-actions');
  assert.deepEqual(companionAction('continue building the house'), { kind: 'continue_work', what: 'build' });
  assert.deepEqual(companionAction('carry on'), { kind: 'continue_work', what: 'any' });
  assert.deepEqual(companionAction('continue building. house'), { kind: 'continue_work', what: 'build' });
});

test('an errand on top gives way to the work it interrupted; with only errands, the newest as before', () => {
  // the house, then "come to me", done
  assert.equal(resumeSaved({ ...come(), suspendedTasks: [house] }).buildId, 'h1');
  // the house, then "follow me", stopped: the follow is an errand, the house is the work
  assert.equal(resumeSaved({ ...come({ kind: 'follow', status: 'cancelled' }), suspendedTasks: [house] }).buildId, 'h1');
  // the house, the planks, then a come: the newest work, the planks
  assert.equal(resumeSaved({ ...come(), suspendedTasks: [house, planks] }).item, 'oak_planks');
  // a follow stopped with nothing under it is still taken up
  assert.equal(resumeSaved({ ...come({ kind: 'follow', status: 'cancelled' }), suspendedTasks: [] }).kind, 'follow');
  // a stopped build on top is taken up as ever
  assert.equal(resumeSaved({ ...house, status: 'cancelled', suspendedTasks: [planks] }).buildId, 'h1');
  assert.equal(resumeSaved({ ...come(), suspendedTasks: [house] }, { currentOnly: true }).kind, 'come');
});

test('work asked for by what it is: the newest such, wherever it lies; the rest kept, an errand on top dropped', () => {
  const saved = { ...planks, status: 'cancelled', suspendedTasks: [house, come({ status: 'replaced' })] };
  const picked = resumeSaved(saved, { prefer: agenda.isBuild });
  assert.equal(picked.buildId, 'h1');
  assert.deepEqual(picked.suspendedTasks.map(g => g.kind), ['obtain'], 'the planks kept under it, to be taken up after; the old come dropped');
  assert.equal(picked.suspendedTasks.at(-1).suspendedTasks, undefined, 'kept bare');
  const fromErrand = resumeSaved({ ...come({ kind: 'follow', status: 'replaced' }), suspendedTasks: [house] }, { prefer: agenda.isBuild });
  assert.deepEqual(fromErrand.suspendedTasks, [], 'the follow is not kept');
  assert.equal(resumeSaved({ ...planks, suspendedTasks: [] }, { prefer: agenda.isBuild }), null, 'no building set aside');
  assert.equal(resumeSaved({ ...house, status: 'running', suspendedTasks: [] }, { prefer: agenda.isBuild }).buildId, 'h1');
});

test('the line when an errand is done with work set aside, and only then', () => {
  assert.equal(agenda.reminder({ ...come(), suspendedTasks: [house] }, { username: 'Jev' }),
    'Say "Jev continue" when you want me back on build a starter house for two people.');
  assert.equal(agenda.reminder({ ...come(), suspendedTasks: [] }), null, 'nothing set aside');
  assert.equal(agenda.reminder({ ...house, status: 'complete', suspendedTasks: [] }), null);
  assert.equal(agenda.reminder({ ...come({ status: 'blocked' }), suspendedTasks: [house] }), null, 'not done');
  assert.equal(agenda.reminder({ ...come({ back: true }), suspendedTasks: [house] }), null, 'the walk back is the bot\'s own');
  assert.equal(agenda.reminder({ ...come(), suspendedTasks: [{ ...house, impossible: true }] }), null, 'impossible work is not offered');
});

test('what is set aside, newest first, with where it is and how far from the player', () => {
  const list = agenda.setAside({ ...come(), suspendedTasks: [house, planks, come({ status: 'replaced' })] }, { username: 'Jev', point: { x: 0, y: 64, z: 10 } });
  assert.deepEqual(list.map(x => x.request), ['get me 8 planks', 'build a starter house for two people']);
  assert.deepEqual(list[1].at, { x: 300, y: 64, z: 10 });
  assert.equal(list[1].blocksFromPlayer, 300);
  assert.match(agenda.whereSaid(house, { x: 0, y: 64, z: 10 }), /^ at 300, 64, 10 \(300 blocks from you\)$/);
  assert.deepEqual(agenda.setAside(null), []);
});

test('a building begun and not finished is known wherever it stands, however little of it stands; a finished one mostly gone is not', () => {
  const registry = new BuildRegistry(null);
  const goal = (id, from, x, status) => ({ buildId: id, kind: 'build', request: `Jev build a house ${id}`, from, design: { source: { name: `house ${id}` } },
    blueprint: { origin: { x, y: 64, z: 0 }, bounds: { min: { x, y: 64, z: 0 }, max: { x: x + 6, y: 68, z: 6 } }, blocks: [{ x, y: 64, z: 0, name: 'oak_planks' }] }, status });
  registry.remember(goal('far', 'Robin', 400), { dimension: 'overworld' });
  registry.remember(goal('near', 'Sky', 20), { dimension: 'overworld' });
  registry.remember(goal('done', 'Robin', 10), { dimension: 'overworld', status: 'complete' });
  const bot = { blockAt: () => null, entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' } };
  const list = agenda.unfinishedBuilds(registry, bot, { from: 'Robin', point: { x: 0, y: 64, z: 0 }, dimension: 'overworld' });
  assert.deepEqual(list.map(b => b.id), ['far', 'near'], 'the player\'s own first, then the nearest; the finished one not');
  assert.equal(list[0].standing, 0); assert.equal(list[0].distance, 403);
  const described = registry.describe(bot, { x: 0, y: 64, z: 0 }, 'overworld').map(b => b.id);
  assert.deepEqual(described.sort(), ['far', 'near'], 'unfinished, 400 blocks off and nothing standing: still on the list; finished and gone: not');
  assert.equal(agenda.hasWork({ ...come(), suspendedTasks: [] }, registry, bot, 'build', { from: 'Robin' }), true, 'a building of its own to finish');
  assert.equal(agenda.hasWork({ ...come(), suspendedTasks: [] }, new BuildRegistry(null), bot, 'build', { from: 'Robin' }), false);
  assert.equal(agenda.hasWork({ ...come(), suspendedTasks: [planks] }, new BuildRegistry(null), bot, 'any', {}), true);
  assert.equal(agenda.hasWork({ ...come(), suspendedTasks: [] }, new BuildRegistry(null), bot, 'any', { active: house }), true, 'the work in hand is it');
});
