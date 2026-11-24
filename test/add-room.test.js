'use strict';
// A room added to a house (add-room.js): what is read as asking for one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const registry = require('prismarine-registry')('26.1');
const { roomRequest } = require('../src/add-room');
const { houseRequest } = require('../src/house-details');

test('a room, a bedroom or a bigger house is a room added; its material only when named', () => {
  for (const text of ['add a room', 'add a room to the house', 'build another room', 'add one more room to our house', 'make us a new room', 'extend the house', 'expand my home', 'make the house bigger'])
    assert.deepEqual(roomRequest(text, registry), { addRoom: { bed: false }, anyMaterial: true }, text);
  assert.deepEqual(roomRequest('add a bedroom to the house', registry), { addRoom: { bed: true }, anyMaterial: true });
  assert.deepEqual(roomRequest('add a small spruce bedroom', registry), { addRoom: { bed: true }, material: 'spruce_planks' });
  assert.deepEqual(roomRequest('add a stone room to my house', registry), { addRoom: { bed: false }, material: 'stone' });
  // Wooden: the planks of the house's own wood, chosen when the room is drawn.
  assert.deepEqual(roomRequest('add a wooden room', registry), { addRoom: { bed: false, wooden: true } });
  // Through the house reader as the chat gives it.
  assert.deepEqual(houseRequest('Please add a bedroom to the house!', registry), { addRoom: { bed: true }, anyMaterial: true });
});

test('fittings, other buildings and rooms of things it cannot build are not a room added', () => {
  for (const text of ['add a window to the house', 'add a door', 'build a house', 'add a big purple room', 'add a room to the castle', 'clean my room', 'room for two', 'make room', 'add room for the sword'])
    assert.equal(roomRequest(text, registry), null, text);
  assert.ok(!houseRequest('add a window to the house', registry)?.addRoom);
});
