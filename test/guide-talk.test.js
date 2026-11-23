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

test('the talk so far goes with a message: both sides, oldest first, how long ago; the message itself once', async () => {
  const { guide, sent, tick } = stubbed({ say: null, requests: ['stay within 50 blocks of me'] });
  guide.note('Robin', 'player', 'stay close to me');
  tick(1000); guide.note('Robin', 'bot', "I aim to stay within 12 blocks of Robin. We're 13 blocks apart.");
  tick(11000); guide.note('Robin', 'player', '50 blocks are fine');
  const out = await ask(guide, '50 blocks are fine');
  assert.deepEqual(out.requests, ['stay within 50 blocks of me']);
  assert.equal(sent[0].said, '50 blocks are fine');
  assert.deepEqual(sent[0].recentTalk, [
    { role: 'player', text: 'stay close to me', secondsAgo: 12 },
    { role: 'bot', text: "I aim to stay within 12 blocks of Robin. We're 13 blocks apart.", secondsAgo: 11 }]);
  tick(2000);
  await ask(guide, 'thanks');
  assert.equal(sent[1].recentTalk.filter(l => l.text === '50 blocks are fine').length, 1);
  assert.deepEqual(await ask(guide, 'hi', 'Sky').then(() => sent[2].recentTalk), [], "another player's talk is their own");
});

test('the same line again within three seconds is one line; later it is two', async () => {
  const { guide, sent, tick } = stubbed({ say: 'ok', requests: [] });
  guide.note('Robin', 'bot', 'Coming back to you, Robin.');
  tick(1000); guide.note('Robin', 'bot', 'Coming back to you, Robin.');
  tick(4000); guide.note('Robin', 'bot', 'Coming back to you, Robin.');
  await ask(guide, 'where are you');
  assert.equal(sent[0].recentTalk.length, 2);
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
  assert.match(text, /recentTalk/);
  assert.match(text, /"options"/);
  assert.match(text, /answers with the number/);
});
