'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const registry = require('prismarine-registry')('26.1');
const Item = require('prismarine-item')(registry);
const windows = require('prismarine-windows')('26.1');
const Recipe = require('prismarine-recipe')(registry).Recipe;
const { craft, install, layout } = require('../src/craft-clicks');
const id = name => registry.itemsByName[name].id;
const P = 'oak_planks', S = 'stick';
const pickaxe = new Recipe({ result: { id: id('wooden_pickaxe'), count: 1 }, inShape: [[id(P), id(P), id(P)], [null, id(S), null], [null, id(S), null]] });

// A crafting table as the server keeps it: its slots and the cursor, the game's clicks (pick up, put down one, swap,
// shift-click), the output worked out from the grid, and the whole window sent back for a click out of step with it.
// staleFirst(click): a resend of the window as it was before that click comes ahead of the answer to it (a plugin's
// inventory update), the answer itself a little after.
function table({ pockets, makesNothing = false, staleFirst = () => false, window: kind = 'table' } = {}) {
  const bot = new EventEmitter();
  bot.registry = registry;
  bot.inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory');
  const win = kind === 'table' ? windows.createWindow(1, 'minecraft:crafting', 'Crafting') : bot.inventory;
  bot.currentWindow = null;
  const server = { slots: new Array(win.slots.length).fill(null), carried: null, stateId: 3 };
  for (const [slot, name, count] of pockets) server.slots[slot] = { name, count };
  const clicks = [], closed = [];
  const stack = name => registry.itemsByName[name].stackSize;
  const copy = () => ({ slots: server.slots.map(s => s && { ...s }), carried: server.carried && { ...server.carried } });
  const gridSlots = kind === 'table' ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [1, 2, 3, 4];
  const pocketSlots = []; for (let s = win.inventoryStart; s < win.inventoryEnd; s++) pocketSlots.push(s);
  function output() {
    const g = gridSlots.map(s => server.slots[s]?.name || null);
    if (!makesNothing && kind === 'table' && JSON.stringify(g) === JSON.stringify([P, P, P, null, S, null, null, S, null])) return { name: 'wooden_pickaxe', count: 1 };
    if (kind !== 'table' && JSON.stringify(g) === JSON.stringify([P, null, P, null])) return { name: S, count: 4 };
    if (g.filter(Boolean).length === 1 && g.includes(P)) return { name: 'oak_button', count: 1 };
    return null;
  }
  const recompute = () => { server.slots[0] = output(); };
  const consume = () => { for (const s of gridSlots) if (server.slots[s] && --server.slots[s].count === 0) server.slots[s] = null; recompute(); };
  function intoPockets(item) {
    for (const s of [...pocketSlots].reverse()) {
      const here = server.slots[s];
      if (here?.name === item.name && here.count < stack(item.name)) { const n = Math.min(item.count, stack(item.name) - here.count); here.count += n; item.count -= n; }
      if (!item.count) return true;
    }
    for (const s of [...pocketSlots].reverse()) if (!server.slots[s]) { server.slots[s] = { ...item }; return true; }
    return false;
  }
  function apply(slot, button, mode) {
    const s = server.slots;
    if (mode === 5) return;
    if (mode === 1) {
      if (slot === 0) { while (s[0] && intoPockets({ ...s[0] })) consume(); return; }
      if (s[slot] && intoPockets({ ...s[slot] })) s[slot] = null;
      recompute(); return;
    }
    if (slot === 0) {
      if (!s[0]) return;
      if (!server.carried) { server.carried = { ...s[0] }; consume(); }
      else if (server.carried.name === s[0].name && server.carried.count + s[0].count <= stack(s[0].name)) { server.carried.count += s[0].count; consume(); }
      return;
    }
    const here = s[slot], held = server.carried;
    if (button === 0) {
      if (!held && here) { server.carried = here; s[slot] = null; }
      else if (held && !here) { s[slot] = held; server.carried = null; }
      else if (held && here && held.name === here.name) { const n = Math.min(stack(here.name) - here.count, held.count); here.count += n; held.count -= n; if (!held.count) server.carried = null; }
      else if (held && here) { s[slot] = held; server.carried = here; }
    } else {
      if (held && !here) { s[slot] = { name: held.name, count: 1 }; if (!--held.count) server.carried = null; }
      else if (held && here && held.name === here.name && here.count < stack(here.name)) { here.count++; if (!--held.count) server.carried = null; }
      else if (held && here) { s[slot] = held; server.carried = here; }
      else if (!held && here) { const n = Math.ceil(here.count / 2); server.carried = { name: here.name, count: n }; here.count -= n; if (!here.count) s[slot] = null; }
    }
    recompute();
  }
  const item = x => x ? new Item(id(x.name), x.count) : null;
  function send(view) {
    server.stateId++;
    view.slots.forEach((x, i) => win.updateSlot(i, item(x)));
    win.selectedItem = item(view.carried);
    bot.emit(`setWindowItems:${win.id}`);
  }
  bot._client = { write(name, packet) {
    if (name !== 'window_click' || packet.windowId !== win.id || (win !== bot.inventory && bot.currentWindow !== win)) return;
    clicks.push({ slot: packet.slot, button: packet.mouseButton, mode: packet.mode });
    const before = copy();
    apply(packet.slot, packet.mouseButton, packet.mode);
    const after = copy();
    const stale = staleFirst(packet, clicks.length);
    if (stale) setImmediate(() => send(before));
    if (packet.stateId !== server.stateId) setTimeout(() => send(after), stale ? 60 : 1);
  } };
  bot.activateBlock = async () => { setImmediate(() => { bot.currentWindow = win; send(copy()); bot.emit('windowOpen', win); }); };
  bot.closeWindow = w => { closed.push(w.id); bot.currentWindow = null; };
  send(copy());
  const pocketsNow = () => Object.fromEntries(Object.entries(pocketSlots.reduce((n, s) => { const x = server.slots[s]; if (x) n[x.name] = (n[x.name] || 0) + x.count; return n; }, {})));
  return { bot, win, server, clicks, closed, pocketsNow, gridNow: () => gridSlots.map(s => server.slots[s]) };
}

test('a pickaxe is laid from the server\'s answers alone, and the grid read back before the output is taken', async () => {
  const t = table({ pockets: [[10, P, 16], [11, S, 4]] });
  await craft(t.bot, pickaxe, 1, { position: { x: 0, y: 64, z: 0 } });
  assert.deepEqual(t.pocketsNow(), { [P]: 13, [S]: 2, wooden_pickaxe: 1 });
  assert.equal(t.server.carried, null);
  assert.deepEqual(t.gridNow(), Array(9).fill(null));
  assert.deepEqual(t.closed, [1]);
  // Each click sent out of step on purpose, for the whole window back; the stick stack clicked once, as the cursor
  // changed to it: three planks in a row, the sticks, the two sticks, the output.
  assert.ok(t.clicks.every(c => c.slot === -999 || c.slot >= 0));
  assert.equal(t.clicks.filter(c => c.slot === 11 && c.mode === 0).length, 2, 'picked up once and put back once');
});

test('the test window\'s pickaxe: a resend of the window as it was, ahead of a click\'s answer, puts no plank where a stick goes', async () => {
  // Ahead of the answer to the click that picks up the sticks, and again on the first stick put down.
  let picked = 0;
  const t = table({ pockets: [[10, P, 16], [11, S, 4]], staleFirst: p => (p.slot === 11 && p.mode === 0 && ++picked === 1) || (p.slot === 5 && p.mouseButton === 1 && picked === 1) });
  const lines = [], log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await craft(t.bot, pickaxe, 1, { position: { x: 0, y: 64, z: 0 } }); }
  finally { console.log = log; }
  assert.deepEqual(t.pocketsNow(), { [P]: 13, [S]: 2, wooden_pickaxe: 1 });
  assert.equal(t.server.carried, null);
  assert.deepEqual(t.gridNow(), Array(9).fill(null));
  assert.ok(lines.some(l => /read again and laid afresh/.test(l)), lines.join('\n'));
});

test('a grid the server makes nothing of is put back, and the craft ends with nothing made', async () => {
  const t = table({ pockets: [[10, P, 16], [11, S, 4]], makesNothing: true });
  const lines = [], log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await craft(t.bot, pickaxe, 1, { position: { x: 0, y: 64, z: 0 } }); }
  finally { console.log = log; }
  assert.deepEqual(t.pocketsNow(), { [P]: 16, [S]: 4 });
  assert.equal(t.server.carried, null);
  assert.deepEqual(t.gridNow(), Array(9).fill(null));
  assert.deepEqual(t.closed, [1]);
  assert.ok(lines.some(l => /wooden pickaxe: the server's grid 1 oak planks, 1 oak planks, 1 oak planks, -, 1 stick, -, -, 1 stick, - gave nothing; put back/.test(l)), lines.join('\n'));
});

test('without the ingredients the craft says so, and leaves nothing on the cursor or in the grid', async () => {
  const t = table({ pockets: [[10, P, 16]] });
  await assert.rejects(craft(t.bot, pickaxe, 1, { position: { x: 0, y: 64, z: 0 } }), /missing ingredient: no stick in the pockets for the wooden pickaxe/);
  assert.deepEqual(t.pocketsNow(), { [P]: 16 });
  assert.equal(t.server.carried, null);
  assert.deepEqual(t.gridNow(), Array(9).fill(null));
  assert.deepEqual(t.closed, [1]);
});

test('the pockets\' own grid crafts the same way, and what an earlier craft left in it goes back first', async () => {
  const sticks = new Recipe({ result: { id: id(S), count: 4 }, inShape: [[id(P)], [id(P)]] });
  const t = table({ window: 'pockets', pockets: [[9, P, 3], [2, 'cobblestone', 1]] });
  await craft(t.bot, sticks, 1, null);
  assert.deepEqual(t.pocketsNow(), { [P]: 1, [S]: 4, cobblestone: 1 });
  assert.deepEqual(t.gridNow(), [null, null, null, null]);
  assert.equal(t.server.carried, null);
  t.bot.currentWindow = { id: 2, type: 'minecraft:furnace' };
  await assert.rejects(craft(t.bot, sticks, 1, null), /A furnace window is open: the pockets' grid takes no click while it is/);
});

test('the answered craft stands in for the library\'s from 1.17 on, and lays a recipe\'s cells by ingredient', () => {
  const calls = [];
  const bot = { craft: (...a) => { calls.push(a); return 'library'; }, supportFeature: f => f !== 'stateIdUsed' };
  assert.equal(install(bot), true);
  assert.equal(install(bot), false);
  assert.equal(bot.craft(pickaxe, 1, null), 'library');
  assert.equal(calls.length, 1);
  const torch = new Recipe({ result: { id: id('torch'), count: 4 }, inShape: [[id('coal')], [id(S)]] });
  assert.deepEqual(layout(torch, 2), [{ slot: 1, id: id('coal') }, { slot: 3, id: id(S) }]);
  assert.deepEqual(layout(pickaxe, 3).map(c => c.slot), [1, 2, 3, 5, 8]);
  const planks = new Recipe({ result: { id: id(P), count: 4 }, ingredients: [id('oak_log')] });
  assert.deepEqual(layout(planks, 2), [{ slot: 1, id: id('oak_log') }]);
  assert.throws(() => layout(pickaxe, 2), /needs a crafting table/);
});
