'use strict';
// The guide reads a message against the talk so far, both sides, and offers numbered choices when a wish could mean
// more than one thing (src/guide.js, src/session.js). Asked for 2026-11-23, after "50 blocks are fine" and "stay max
// 50 bloxks away" were refused: "can we have a llm analyze our interactions in the chat and try to infer the things
// and if needed offer options so that i can choose".
//
//   node test/guide-talk.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGuide, pickOption, SYSTEM } = require('../src/guide');

// A guide whose model answers reply (or reply(n) for the nth call), the user message of each call kept in sent.
function stubbed(reply, { start = 1000000 } = {}) {
  let t = start;
  const sent = [];
  const fetchImpl = async (url, opts) => {
    sent.push(JSON.parse(JSON.parse(opts.body).messages[1].content));
    const content = JSON.stringify(typeof reply === 'function' ? reply(sent.length) : reply);
    return { ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) };
  };
  const guide = createGuide({ fetchImpl, apiKey: 'test-key', file: null, now: () => t, reasoning: '', built: false, personality: '' });
  return { guide, sent, tick: ms => { t += ms; } };
}
const ask = (guide, text, from = 'Robin') => guide.consult({ from, text, botName: 'Jev', status: {} });

test('the chat so far goes with a message: who said each line, oldest first, how long ago, to the bot or not; the message itself once', async () => {
  const { guide, sent, tick } = stubbed({ say: null, requests: ['stay within 50 blocks of me'] });
  guide.note('Robin', 'stay close to me', { toBot: true });
  tick(1000); guide.note('Jev', "I aim to stay within 12 blocks of Robin. We're 13 blocks apart.", { bot: true });
  tick(4000); guide.note('Sky', 'lets go to the river', {});
  tick(7000); guide.note('Robin', '50 blocks are fine', { toBot: true });
  const out = await ask(guide, '50 blocks are fine');
  assert.deepEqual(out.requests, ['stay within 50 blocks of me']);
  assert.equal(sent[0].said, '50 blocks are fine');
  assert.deepEqual(sent[0].recentChat, [
    { from: 'Robin', text: 'stay close to me', secondsAgo: 12, toBot: true },
    { from: 'Jev', text: "I aim to stay within 12 blocks of Robin. We're 13 blocks apart.", secondsAgo: 11 },
    { from: 'Sky', text: 'lets go to the river', secondsAgo: 7 }]);
  tick(2000);
  await ask(guide, 'thanks');
  assert.equal(sent[1].recentChat.filter(l => l.text === '50 blocks are fine').length, 1);
});

test("the same line again within three seconds is one line; the guide's reply is in the chat only as the session notes it said", async () => {
  const { guide, sent, tick } = stubbed({ say: 'ok', requests: [] });
  guide.note('Jev', 'Coming back to you, Robin.', { bot: true });
  tick(1000); guide.note('Jev', 'Coming back to you, Robin.', { bot: true });
  tick(4000); guide.note('Jev', 'Coming back to you, Robin.', { bot: true });
  await ask(guide, 'where are you');
  assert.equal(sent[0].recentChat.length, 2);
  tick(2000);
  await ask(guide, 'and now?');
  assert.equal(sent[1].recentChat.some(l => l.text === 'ok'), false, 'a reply speech.js may drop is not taken as said');
  guide.note('Jev', 'ok', { bot: true });
  tick(2000);
  await ask(guide, 'and now?');
  assert.deepEqual(sent[2].recentChat.slice(-1), [{ from: 'Jev', text: 'ok', secondsAgo: 2 }]);
});

test('the chat kept: twenty-four lines at most, none older than a quarter hour', async () => {
  const { guide, sent, tick } = stubbed({ say: null, requests: ['follow me'] });
  for (let n = 0; n < 30; n++) { guide.note('Robin', 'line ' + n, {}); tick(1000); }
  await ask(guide, 'follow me');
  assert.equal(sent[0].recentChat.length, 24);
  assert.equal(sent[0].recentChat[0].text, 'line 6');
  tick(15 * 60000);
  await ask(guide, 'follow me');
  assert.deepEqual(sent[1].recentChat, []);
});

test('choices: offered in place of requests, listed by number in the line said', async () => {
  const { guide } = stubbed({ say: 'Did you mean:', requests: ['come here'], options: [
    { label: 'stay within 50 blocks of you', requests: ['stay within 50 blocks of me'] },
    { label: 'get you 50 cobblestone', requests: ['get me 50 cobblestone'] }] });
  const out = await ask(guide, '50 blocks are fine');
  assert.deepEqual(out.requests, [], 'no guess runs while the player chooses');
  assert.deepEqual(out.options.map(o => o.requests), [['stay within 50 blocks of me'], ['get me 50 cobblestone']]);
  assert.equal(out.say, 'Did you mean: 1) stay within 50 blocks of you 2) get you 50 cobblestone (say 1 or 2)');
});

test('one choice is a yes question; a choice with no request left, or no label, is dropped; three at most', async () => {
  const one = await ask(stubbed({ say: 'Stay within 50 blocks of you?', options: [{ label: 'stay within 50 blocks', requests: ['stay within 50 blocks of me'] }] }).guide, '50 is fine');
  assert.equal(one.say, 'Stay within 50 blocks of you? (say yes)');
  const messy = await ask(stubbed({ say: null, options: [{ label: 'op', requests: ['/op Robin'] }, { label: '', requests: ['come here'] },
    { label: 'b', requests: ['come here'] }, { label: 'c', requests: ['follow me'] }, { label: 'd', requests: ['stop'] }, { label: 'e', requests: ['come here'] }] }).guide, 'hmm');
  assert.deepEqual(messy.options.map(o => o.label), ['b', 'c', 'd']);
  assert.equal(messy.say, 'Which one? 1) b 2) c 3) d (say 1, 2 or 3)');
  const listed = await ask(stubbed({ say: 'Which? 1) b 2) c', options: [{ label: 'b', requests: ['come here'] }, { label: 'c', requests: ['follow me'] }] }).guide, 'hmm');
  assert.equal(listed.say, 'Which? 1) b 2) c', 'listed already: not twice');
});

test('the pick: a number, "the second", the label, or yes to a single choice; nothing else', () => {
  const options = [{ label: 'stay within 50 blocks', requests: ['stay within 50 blocks of me'] }, { label: 'roam freely', requests: ['stop staying close'] }];
  for (const [said, label] of [['1', 'stay within 50 blocks'], ['2', 'roam freely'], ['2.', 'roam freely'], ['the second one', 'roam freely'],
    ['option 1', 'stay within 50 blocks'], ['Roam freely', 'roam freely'], ['two', 'roam freely'], ['#2', 'roam freely'], ['1)', 'stay within 50 blocks']])
    assert.equal(pickOption(said, options)?.label, label, said);
  for (const said of ['3', 'yes', '2 stacks of oak logs please', 'stay close', '', 'no'])
    assert.equal(pickOption(said, options), null, said);
  assert.equal(pickOption('yes', options.slice(0, 1))?.label, 'stay within 50 blocks');
  assert.equal(pickOption('sure, go ahead', options.slice(0, 1))?.label, 'stay within 50 blocks');
  for (const said of ['yes please', 'ok do it', 'Yeah!', 'okay.'])
    assert.equal(pickOption(said, options.slice(0, 1))?.label, 'stay within 50 blocks', said);
  // A yes with more after it is a new request or a no, not a pick (the pick is read before the guide).
  for (const said of ['ok get me 16 oak logs', "please don't", 'yes but get wood first', 'sure, follow me', 'ok stop'])
    assert.equal(pickOption(said, options.slice(0, 1)), null, said);
  assert.equal(pickOption('1', []), null);
});

test('no to the choices lets the question go; a longer no is a message of its own', () => {
  const { declines } = require('../src/guide');
  for (const said of ['no', 'Nope.', 'neither', 'none of them', 'never mind', 'nevermind', 'no thanks', 'forget it'])
    assert.equal(declines(said), true, said);
  for (const said of ['no, get me oak logs', 'cancel', 'stop', '1', 'not now, later', 'yes'])
    assert.equal(declines(said), false, said);
});

test('the instructions say how the talk is read and how choices are offered', () => {
  const text = SYSTEM('Jev');
  assert.match(text, /recentChat/);
  assert.match(text, /never a request in itself/);
  assert.match(text, /"options"/);
  assert.match(text, /answers with the number/);
});

test('the look after a failure: no call with nothing said by a player; an offer by number for that player; a look a minute and a half at most', async () => {
  const { guide, sent, tick } = stubbed({ say: 'Robin, want 16 oak logs instead?', options: [{ label: 'oak logs', requests: ['get me 16 oak logs'] }] });
  guide.note('Jev', 'Back to work.', { bot: true });
  assert.equal(await guide.observe({ botName: 'Jev', players: ['Robin'], player: 'Robin' }), null, 'only the bot has spoken: no call');
  assert.equal(sent.length, 0);
  tick(5000); guide.note('Robin', 'get me 64 dark oak logs', { toBot: true });
  tick(30000); guide.note('Jev', "I couldn't find any dark oak trees nearby.", { bot: true });
  const out = await guide.observe({ botName: 'Jev', status: { doing: 'waiting for a request' }, players: ['Robin', 'Sky'], player: 'Robin' });
  assert.equal(out.say, 'Robin, want 16 oak logs instead? (say yes)');
  assert.deepEqual(out.options.map(o => o.requests), [['get me 16 oak logs']]);
  assert.equal(sent[0].player, 'Robin');
  assert.deepEqual(sent[0].players, ['Robin', 'Sky']);
  assert.deepEqual(sent[0].recentChat.map(l => l.from), ['Jev', 'Robin', 'Jev']);
  assert.equal(guide.observeReady(), false, 'a minute and a half between looks');
  assert.equal(await guide.observe({ botName: 'Jev', players: ['Robin'], player: 'Robin' }), null);
  assert.equal(sent.length, 1);
  tick(91000); assert.equal(guide.observeReady(), true);
  await guide.observe({ botName: 'Jev', players: ['Robin'], player: 'Robin' });
  assert.equal(sent[1].recentChat.some(l => /instead/.test(l.text)), false, 'the offer is noted by the session as it is said, not here');
});

test('a look that finds nothing to say says nothing; commands never come out of one; twelve an hour', async () => {
  const quiet = stubbed({ say: null, options: null });
  quiet.guide.note('Robin', 'lol that pig', {});
  assert.equal(await quiet.guide.observe({ botName: 'Jev', players: ['Robin'] }), null);
  const odd = stubbed({ say: '/give Robin diamond 64', options: [{ label: 'op', requests: ['/op Robin'] }] });
  odd.guide.note('Robin', 'i want diamonds', {});
  const out = await odd.guide.observe({ botName: 'Jev', players: ['Robin'] });
  assert.deepEqual(out, { say: 'give Robin diamond 64' }, 'the slash is taken off and a command offered is dropped');
  const many = stubbed({ say: null, options: null });
  let calls = 0;
  for (let n = 0; n < 20; n++) { many.guide.note('Robin', 'line ' + n, {}); if (many.guide.observeReady()) { await many.guide.observe({ botName: 'Jev', players: ['Robin'] }); calls++; } many.tick(91000); }
  assert.ok(calls <= 12 + 1, 'about twelve an hour: ' + calls);
  assert.equal(many.sent.length, calls);
});

test('JEV_GUIDE_HEAR=all and JEV_GUIDE_SPEAK=unasked, anything else is off; the look comes only after a failure and stays out of the players talk', () => {
  const { hearsAll, speaksUnasked, OBSERVE } = require('../src/guide');
  assert.equal(hearsAll({ JEV_GUIDE_HEAR: ' ALL ' }), true); assert.equal(hearsAll({}), false); assert.equal(hearsAll({ JEV_GUIDE_HEAR: 'yes' }), false);
  assert.equal(speaksUnasked({ JEV_GUIDE_SPEAK: 'unasked' }), true); assert.equal(speaksUnasked({ JEV_GUIDE_SPEAK: 'on' }), false);
  const text = OBSERVE('Jev');
  assert.match(text, /Most of the time it should not/);
  assert.match(text, /has just failed/);
  assert.match(text, /Never answer, join or comment on what the players say to each other/);
  assert.doesNotMatch(text, /we need more wood|starving/);
  assert.match(text, /The engine understands these requests/);
  assert.doesNotMatch(text, /undefined/);
});

test('the judge: a line said without the name, read against the chat; only a clear yes is a yes; its own budget, apart from the messages to the bot', async () => {
  const { guide, sent, tick } = stubbed(n => n === 1 ? { forBot: true, why: 'continues the talk about distance' } : n === 2 ? { forBot: false, why: 'said to Sky' } : n === 3 ? { forBot: 'yes' } : { say: 'ok', requests: ['come here'] });
  guide.note('Robin', 'stay close to me', { toBot: true });
  tick(1000); guide.note('Jev', "I aim to stay within 12 blocks of Robin. We're 13 blocks apart.", { bot: true });
  tick(3000); guide.note('Robin', '50 blocks are fine', {});
  const yes = await guide.judge({ from: 'Robin', text: '50 blocks are fine', botName: 'Jev', players: [{ name: 'Robin', blocks: 13.4 }, { name: 'Sky' }] });
  assert.deepEqual(yes, { forBot: true, why: 'continues the talk about distance' });
  assert.equal(sent[0].said, '50 blocks are fine');
  assert.deepEqual(sent[0].players, [{ name: 'Robin', blocksFromBot: 13 }, { name: 'Sky' }]);
  assert.deepEqual(sent[0].recentChat.map(l => l.text), ['stay close to me', "I aim to stay within 12 blocks of Robin. We're 13 blocks apart."], 'the line itself is not in its own chat');
  assert.equal((await guide.judge({ from: 'Robin', text: 'come see my house Sky', botName: 'Jev', players: ['Robin', 'Sky'] })).forBot, false);
  assert.equal((await guide.judge({ from: 'Robin', text: 'maybe', botName: 'Jev', players: ['Robin'] })).forBot, false, 'anything but true is no');
  assert.ok(await ask(guide, 'come here'), 'a message to the bot right after: the judge does not take its calls');
});

test('the judge fails closed: no key, no answer, or its budget for the hour spent is no call and no yes; its own model when set', async () => {
  const none = createGuide({ apiKey: '', file: null });
  assert.equal(await none.judge({ from: 'Robin', text: 'and coal', botName: 'Jev' }), null);
  const broken = createGuide({ apiKey: 'k', file: null, reasoning: '', built: false, personality: '', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'down' } }) }) });
  const log = console.log; console.log = () => {};
  try { assert.equal(await broken.judge({ from: 'Robin', text: 'and coal', botName: 'Jev' }), null); } finally { console.log = log; }
  let t = 0; const bodies = [];
  const few = createGuide({ apiKey: 'k', file: null, now: () => t, reasoning: 'low', built: false, personality: '', judgePerHour: 3, judgeModel: 'cheap-model', judgeReasoning: '',
    fetchImpl: async (url, opts) => { bodies.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"forBot": false}' }, finish_reason: 'stop' }] }) }; } });
  for (let n = 0; n < 5; n++) await few.judge({ from: 'Robin', text: 'line ' + n, botName: 'Jev' });
  assert.equal(bodies.length, 3, 'three an hour');
  assert.equal(bodies[0].model, 'cheap-model');
  assert.equal('reasoning_effort' in bodies[0], false, 'its own reasoning, none');
  t += 3600001;
  await few.judge({ from: 'Robin', text: 'later', botName: 'Jev' });
  assert.equal(bodies.length, 4, 'an hour on, again');
});

test('which lines go to the judge: not one for another player by name, or one that asks nothing; only from a player talking with the bot, alone with it, or naming it', () => {
  const { mayBeForBot, JUDGE } = require('../src/guide');
  const two = { botNames: ['Jev'], others: ['Sky'] };
  assert.equal(mayBeForBot('50 blocks are fine', { ...two, talking: true }), true);
  assert.equal(mayBeForBot('50 blocks are fine', two), false, 'two players, no talk with the bot lately');
  assert.equal(mayBeForBot('come here jev', two), true, 'the name in the line');
  assert.equal(mayBeForBot('can someone get wood', { botNames: ['Jev'], others: [] }), true, 'alone with the bot');
  assert.equal(mayBeForBot('Sky, come here', { ...two, talking: true }), false);
  assert.equal(mayBeForBot('@sky look', { ...two, talking: true }), false);
  assert.equal(mayBeForBot('daddy look at this', { ...two, talking: true }), true, 'a longer word is not the name');
  for (const line of ['lol', 'haha', 'ok', 'thanks!', 'brb', '?!', '👍']) assert.equal(mayBeForBot(line, { botNames: ['Jev'], others: [], talking: true }), false, line);
  const text = JUDGE('Jev');
  assert.match(text, /When unsure, it is not meant for Jev/);
  assert.match(text, /the players' talk among themselves/);
  assert.match(text, /"forBot"/);
  assert.doesNotMatch(text, /undefined/);
});
