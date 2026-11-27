'use strict';
// Items asked for another player, and the yes that lets a held request through (src/handoff.js, src/objectives.js
// namedRecipient, src/delivery.js recipientOf and handoverPickup, src/speech.js completion).
// Seen in play: one player asked for a stack while the bot worked for another; the holder answered "yea", which the yes
// list did not know, so the language layer started the request again in the holder's name. The stack was then handed
// to the holder, the player beside them picked it up, and the bot said it was not sure anyone got the items.
//
//   node test/delivery-recipient.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandoff } = require('../src/handoff');
const { namedRecipient } = require('../src/objectives');
const { recipientOf, handoverPickup } = require('../src/delivery');
const { completion } = require('../src/speech');

const held = h => h.ask({ holder: 'Robin', asker: '.p4nda77', request: 'Jev get me 64 acacia logs', payload: { sender: 'x' } });

test('the yes and no words players use answer "may I switch?"; a request is not a yes', () => {
  for (const said of ['yea', 'Yea!', 'ya', 'yup', 'yes', 'yeah sure', 'ok', 'okay go', 'alright', 'all right then', 'sure thing', 'go ahead', 'let him', 'let her have it', 'why not', 'k', 'go', 'of course', 'no problem']) {
    const h = createHandoff(); held(h);
    assert.equal(h.answer('Robin', said)?.verdict, 'yes', said);
  }
  for (const said of ['no', 'nope', 'nah', 'not now', 'n', "don't", 'later']) {
    const h = createHandoff(); held(h);
    assert.equal(h.answer('Robin', said)?.verdict, 'no', said);
  }
  for (const said of ['go home', 'yesterday was fun', 'get me a sword', 'keep building', 'kill that zombie']) {
    const h = createHandoff(); held(h);
    assert.equal(h.answer('Robin', said), null, said);
    assert.ok(h.pending(), 'the question stays open');
  }
});

test('only the holder answers, and a yes approves the held request once', () => {
  const h = createHandoff(); held(h);
  assert.equal(h.answer('.p4nda77', 'yes'), null, 'the asker cannot approve their own request');
  const r = h.answer('Robin', 'yea');
  assert.equal(r.question.asker, '.p4nda77');
  assert.equal(h.approved('.p4nda77', 'Jev get me 64 acacia logs'), true);
  assert.equal(h.approved('.p4nda77', 'Jev get me 64 acacia logs'), false, 'once');
});

test('the holder agreeing in other words, read as the held request itself, is the yes, and the request stays the asker\'s', () => {
  let h = createHandoff(); held(h);
  const r = h.approvesByRequest('Robin', ['get me 64 acacia logs'], 'Jev');
  assert.equal(r?.verdict, 'yes');
  assert.equal(r.question.asker, '.p4nda77');
  assert.equal(h.pending(), null);
  assert.equal(h.approved('.p4nda77', 'Jev get me 64 acacia logs'), true);
  h = createHandoff(); held(h);
  assert.equal(h.approvesByRequest('Robin', ['Get me 64 acacia logs for .p4nda77.'], 'Jev')?.verdict, 'yes', 'with the asker named');
  h = createHandoff(); held(h);
  assert.equal(h.approvesByRequest('Robin', ['get me 64 oak logs'], 'Jev'), null, 'another request is not the yes');
  assert.equal(h.approvesByRequest('.p4nda77', ['get me 64 acacia logs'], 'Jev'), null, 'nor the asker repeating it');
  assert.equal(h.approvesByRequest('Robin', [], 'Jev'), null);
  assert.ok(h.pending());
});

test('a request naming another player is for that player', () => {
  const players = ['Jev', 'Robin', '.p4nda77', 'Sky'];
  assert.equal(namedRecipient('get me 64 acacia logs for .p4nda77', players, 'Jev', 'Robin'), '.p4nda77');
  assert.equal(namedRecipient('bring 64 acacia logs to p4nda', players, 'Jev', 'Robin'), '.p4nda77', 'without the dot and the digits');
  assert.equal(namedRecipient('get 10 bread for sky', players, 'Jev', 'Robin'), 'Sky');
  assert.equal(namedRecipient('get me 64 acacia logs', players, 'Jev', 'Robin'), null);
  assert.equal(namedRecipient('get me 64 logs for the house', players, 'Jev', 'Robin'), null);
  assert.equal(namedRecipient('get me 64 logs for me', players, 'Jev', 'Robin'), null);
  assert.equal(namedRecipient('get me 64 logs for robin', players, 'Jev', 'Robin'), null, 'the speaker is the default anyway');
  assert.equal(namedRecipient('bring logs to jev', players, 'Jev', 'Robin'), null, 'not the bot');
});

test('the items go to the named player while online, else to the player who asked', () => {
  const bot = { players: { Robin: {}, '.p4nda77': {} } };
  assert.equal(recipientOf(bot, { from: 'Robin', deliverTo: '.p4nda77' }), '.p4nda77');
  assert.equal(recipientOf(bot, { from: 'Robin' }), 'Robin');
  assert.equal(recipientOf({ players: { Robin: {} } }, { from: 'Robin', deliverTo: '.p4nda77' }), 'Robin', 'gone: back to the speaker');
});

test('a pickup of the throw by the receiver or another player counts; a mob\'s or the bot\'s own does not', () => {
  const drop = id => ({ id, getDroppedItem: () => ({ name: 'acacia_log' }) });
  const bot = { entity: { id: 1 }, entities: { 1: { id: 1, type: 'player', username: 'Jev' }, 63: { id: 63, type: 'player', username: 'Robin' },
    27: { id: 27, type: 'player', username: '.p4nda77' }, 40: { id: 40, type: 'hostile', name: 'zombie' }, 500: drop(500), 9: drop(9),
    501: { id: 501, getDroppedItem: () => ({ name: 'dirt' }) } } };
  const receiver = { id: 63 }, known = new Set([9]);
  assert.deepEqual(handoverPickup(bot, { collectorEntityId: 63, collectedEntityId: 500 }, receiver, known, 'acacia_log'), { by: null });
  assert.deepEqual(handoverPickup(bot, { collectorEntityId: 27, collectedEntityId: 500 }, receiver, known, 'acacia_log'), { by: '.p4nda77' });
  assert.equal(handoverPickup(bot, { collectorEntityId: 40, collectedEntityId: 500 }, receiver, known, 'acacia_log'), null, 'a zombie');
  assert.equal(handoverPickup(bot, { collectorEntityId: 1, collectedEntityId: 500 }, receiver, known, 'acacia_log'), null, 'its own');
  assert.equal(handoverPickup(bot, { collectorEntityId: 63, collectedEntityId: 9 }, receiver, known, 'acacia_log'), null, 'a drop from before the throw');
  assert.equal(handoverPickup(bot, { collectorEntityId: 63, collectedEntityId: 501 }, receiver, known, 'acacia_log'), null, 'another item');
});

test('the line at the end says who has the items', () => {
  const base = { kind: 'obtain', deliver: true, item: 'acacia_log', count: 64, from: 'Robin' };
  assert.equal(completion({ ...base, deliveryEvidence: [{ recipient: 'Robin', count: 64 }] }), 'You got 64 acacia log!');
  assert.equal(completion({ ...base, deliverTo: '.p4nda77', deliveryEvidence: [{ recipient: '.p4nda77', count: 64 }] }), '.p4nda77 got 64 acacia log!');
  assert.equal(completion({ ...base, deliveryEvidence: [{ recipient: 'Robin', by: '.p4nda77', count: 64 }] }), '.p4nda77 picked up the 64 acacia log.');
  assert.equal(completion({ ...base, deliveryEvidence: [{ recipient: 'Robin', count: 32 }, { recipient: 'Robin', by: '.p4nda77', count: 32 }] }), 'You got 64 acacia log!');
  assert.equal(completion({ ...base, deliver: false }), "I've got 64 acacia log.");
});
