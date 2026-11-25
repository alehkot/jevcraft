'use strict';
// Crafting clicked one answered step at a time, in place of mineflayer's craft (compatibility.js installs it).
//
// Mineflayer's craft chooses each click from its own picture of the window, and the server's full resend of the
// window for an earlier click, come after the next clicks were sent, puts that picture back. At a test server's
// tables (2026-11-24) it read, by all its traces show, the sticks it held as planks again, clicked the stick stack a
// second time, and laid a plank where the pickaxe's second stick goes:
// "grid 1 oak planks, 1 oak planks, 1 oak planks, -, 1 stick, -, -, 1 oak planks, -; cursor 12 oak planks"
// (craft-trace.js), eleven clicks where ten make a pickaxe, and the table made nothing. Each click here goes with a
// state id the server never holds, so the server answers it with the whole window, its slots and the cursor; the
// next click is chosen from that answer alone, and the grid is read back against the recipe before the output is
// taken.

const LEFT = 0, RIGHT = 1, PICKUP = 0, QUICK_MOVE = 1;
const ANSWER_MS = 5000, OPEN_MS = 10000;
const words = name => String(name || 'something').replaceAll('_', ' ');
const said = item => item ? `${item.count} ${words(item.name)}` : 'nothing';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A click whose answer did not show what it did: the window read again and laid afresh, once.
class OutOfStep extends Error {}

const windowSays = (bot, window) => window === bot.inventory ? 'pockets' : 'crafting table';

// One click, and the server's whole answer to it. A click whose state id is not the server's own is answered with the
// whole window (the server takes the client to be out of step with it), which mineflayer reads into the window's slots
// and its cursor (window_items) before it says setWindowItems. Slot -999 with the third button in mode 5 is the window
// sync's own click, the end of a drag never begun, which changes nothing: a plain read.
async function answered(bot, window, slot, button, mode, { timeoutMs = ANSWER_MS } = {}) {
  if (window !== bot.inventory && bot.currentWindow !== window) throw new Error(`The ${windowSays(bot, window)} window closed before the craft was done`);
  const stop = () => require('./compatibility').throwIfStopped(bot);
  stop();
  const Item = require('prismarine-item')(bot.registry);
  const event = `setWindowItems:${window.id}`;
  let settled = false, failure = null, timer = null;
  const done = () => { settled = true; clearTimeout(timer); };
  bot.once(event, done);
  timer = setTimeout(() => {
    bot.removeListener(event, done);
    settled = true;
    failure = new Error(`The server did not answer a click in the ${windowSays(bot, window)} window within ${Math.round(timeoutMs / 1000)} seconds`);
  }, timeoutMs);
  try {
    bot._client.write('window_click', { windowId: window.id, stateId: -1, slot, mouseButton: button, mode, changedSlots: [], cursorItem: Item.toNotch(window.selectedItem) });
    while (!settled) { stop(); await sleep(20); }
  } finally {
    if (!settled) { bot.removeListener(event, done); clearTimeout(timer); }
  }
  if (failure) throw failure;
}

// The cells a recipe fills, its shape from the top left and then its loose ingredients, each ingredient's cells
// together so that the cursor changes stack as few times as it can.
function layout(recipe, width) {
  const cells = [];
  if (recipe.inShape) {
    if (recipe.inShape.length > width || recipe.inShape.some(row => row.length > width)) throw new Error('This recipe needs a crafting table');
    recipe.inShape.forEach((row, y) => row.forEach((item, x) => { if (item && item.id !== -1) cells.push({ slot: 1 + x + width * y, id: item.id }); }));
  }
  if (recipe.ingredients) {
    const free = [];
    for (let s = 1; s <= width * width; s++) if (!cells.some(c => c.slot === s)) free.push(s);
    for (const item of recipe.ingredients) {
      const slot = free.shift();
      if (slot === undefined) throw new Error('This recipe needs a crafting table');
      cells.push({ slot, id: item.id });
    }
  }
  const order = [...new Set(cells.map(c => c.id))];
  return cells.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

// The clicks of one window: its grid, its pockets, and putting back what is on the cursor or in the grid.
function bench(bot, window, width) {
  const click = (slot, button, mode) => answered(bot, window, slot, button, mode);
  const grid = Array.from({ length: width * width }, (_, i) => i + 1);
  const pockets = [];
  for (let s = window.inventoryStart; s < window.inventoryEnd; s++) pockets.push(s);
  const b = { click, grid, pockets, home: null };
  const sameStack = (x, y) => x.type === y.type && JSON.stringify(x.components ?? x.nbt ?? null) === JSON.stringify(y.components ?? y.nbt ?? null);
  // Where the cursor's stack goes back: the slot it was picked up from, a stack of its kind with room, an empty slot.
  const roomFor = held => {
    if (b.home !== null && !window.slots[b.home]) return b.home;
    const stack = pockets.find(s => window.slots[s] && sameStack(window.slots[s], held) && window.slots[s].count < (window.slots[s].stackSize || 64));
    return stack ?? pockets.find(s => !window.slots[s]) ?? null;
  };
  b.read = () => click(-999, 2, 5);
  b.emptyCursor = async () => {
    for (let n = 0; window.selectedItem && n < 4; n++) {
      const to = roomFor(window.selectedItem);
      if (to === null) throw new Error(`No room in the pockets for the ${said(window.selectedItem)} on the cursor`);
      await click(to, LEFT, PICKUP);
    }
    if (window.selectedItem) throw new OutOfStep(`the ${said(window.selectedItem)} on the cursor did not go back into the pockets`);
    b.home = null;
  };
  b.emptyGrid = async () => {
    for (const slot of grid) {
      if (!window.slots[slot]) continue;
      await click(slot, LEFT, QUICK_MOVE);
      if (window.slots[slot]) throw new Error(`No room in the pockets for the ${said(window.slots[slot])} left in the crafting grid`);
    }
  };
  b.count = id => pockets.reduce((n, s) => n + (window.slots[s]?.type === id ? window.slots[s].count : 0), 0);
  b.gridSays = () => grid.map(s => window.slots[s] ? said(window.slots[s]) : '-').join(', ');
  return b;
}

// One craft of the recipe: true once its output is in the pockets, false when the server made nothing of the grid
// (put back) or the output had no room.
async function craftOnce(bot, window, recipe, width) {
  const b = bench(bot, window, width), { click } = b;
  const name = id => words(bot.registry.items[id]?.name || `item ${id}`);
  const resultName = name(recipe.result.id);
  async function lay(cells) {
    for (const { slot, id } of cells) {
      if (window.selectedItem?.type !== id) {
        if (window.selectedItem) await b.emptyCursor();
        const from = b.pockets.find(s => window.slots[s]?.type === id);
        if (from === undefined) throw new Error(`missing ingredient: no ${name(id)} in the pockets for the ${resultName}`);
        await click(from, LEFT, PICKUP);
        if (window.selectedItem?.type !== id) throw new OutOfStep(`the cursor held ${said(window.selectedItem)} after the ${name(id)} were picked up`);
        b.home = from;
      }
      await click(slot, RIGHT, PICKUP);
      const there = window.slots[slot];
      if (there?.type !== id || there.count !== 1) throw new OutOfStep(`grid slot ${slot} held ${said(there)} after one ${name(id)} was put there`);
    }
    await b.emptyCursor();
  }
  // The window as the server has it, and whatever an earlier craft left on the cursor or in the grid back first.
  await b.read();
  await b.emptyCursor();
  await b.emptyGrid();
  const cells = layout(recipe, width);
  for (let attempt = 0; ; attempt++) {
    try { await lay(cells); break; }
    catch (err) {
      if (!(err instanceof OutOfStep)) throw err;
      console.log(`[craft] ${resultName}: ${err.message}; ${attempt ? 'put back, made nothing' : 'read again and laid afresh'}`);
      await b.read();
      await b.emptyCursor();
      await b.emptyGrid();
      if (attempt) return false;
    }
  }
  // Laid as the recipe has it: anything else the server makes of the grid (or nothing) is not taken.
  const wrong = cells.some(({ slot, id }) => window.slots[slot]?.type !== id || window.slots[slot].count !== 1) ||
    b.grid.some(slot => window.slots[slot] && !cells.some(c => c.slot === slot));
  const out = window.slots[0];
  if (wrong || out?.type !== recipe.result.id) {
    console.log(`[craft] ${resultName}: the server's grid ${b.gridSays()} gave ${said(out)}; put back into the pockets`);
    await b.emptyGrid();
    return false;
  }
  const before = b.count(recipe.result.id);
  await click(0, LEFT, QUICK_MOVE);
  if (b.count(recipe.result.id) < before + recipe.result.count) {
    console.log(`[craft] ${resultName}: the output stayed in the grid's output slot (${said(window.slots[0])}), no room for it in the pockets`);
    await b.emptyGrid();
    return false;
  }
  // What a recipe leaves in its grid (a bucket, a bottle) goes into the pockets too.
  await b.emptyGrid();
  return true;
}

function openTable(bot, table) {
  // A table a player marked keep on its own (labels.js): not used. The open guard on bot.openBlock is not on this way in.
  const refused = require('./labels').openRefused(bot, table);
  if (refused) return Promise.reject(refused);
  return new Promise((resolve, reject) => {
    const opened = window => { clearTimeout(timer); resolve(window); };
    const timer = setTimeout(() => { bot.removeListener('windowOpen', opened); reject(new Error('The crafting table did not open')); }, OPEN_MS);
    bot.once('windowOpen', opened);
    Promise.resolve().then(() => bot.activateBlock(table)).catch(err => { clearTimeout(timer); bot.removeListener('windowOpen', opened); reject(err); });
  });
}

// bot.craft(recipe, count, table), as mineflayer's: the table's window opened, the recipe made count times, the
// window closed. A grid the server makes nothing of is put back and the craft ends there, as mineflayer's ended with
// nothing made: the caller reads its pockets and clicks again (work.js craft).
async function craft(bot, recipe, count = 1, table = null) {
  if (!recipe) throw new Error('No recipe to craft');
  const times = parseInt(count ?? 1, 10);
  if (recipe.requiresTable && !table) throw new Error('Recipe requires craftingTable, but one was not supplied: ' + JSON.stringify(recipe));
  // While another window is open the server takes no click in the pockets' own grid and says nothing (note 690).
  if (!table && bot.currentWindow && bot.currentWindow !== bot.inventory) throw new Error(`A ${String(bot.currentWindow.type || 'window').replace(/^minecraft:/, '').replaceAll('_', ' ')} window is open: the pockets' grid takes no click while it is`);
  const window = table ? await openTable(bot, table) : bot.inventory, width = table ? 3 : 2;
  try {
    if (table && !String(window.type || '').startsWith('minecraft:crafting')) throw new Error('crafting: non craftingTable used as craftingTable: ' + window.type);
    for (let i = 0; i < times; i++) if (!await craftOnce(bot, window, recipe, width)) break;
  } catch (err) {
    // The cursor and the grid back into the pockets where they will go, best effort: a table's window shut gives
    // the rest back to the pockets, and the pockets' own grid is settled after every craft (work.js settleCraftInventory).
    try { const b = bench(bot, window, width); await b.read(); await b.emptyCursor(); await b.emptyGrid(); } catch (_) { /* given back as it can be */ }
    throw err;
  } finally {
    if (table && bot.currentWindow === window) bot.closeWindow(window);
  }
}

function install(bot) {
  if (typeof bot?.craft !== 'function' || bot.craft._answered) return false;
  const original = bot.craft;
  const answeredCraft = (recipe, count, table) =>
    (typeof bot.supportFeature === 'function' && !bot.supportFeature('stateIdUsed') ? original(recipe, count, table) : craft(bot, recipe, count, table));
  answeredCraft._answered = true;
  answeredCraft.original = original;
  bot.craft = answeredCraft;
  return true;
}

module.exports = { craft, install, layout, answered };
