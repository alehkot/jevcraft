'use strict';
// What the server answered while a crafting table was clicked, said when the craft makes nothing.
// Three table crafts made nothing with the ingredients carried, slots free and no other window open,
// both clicks each time (two wooden pickaxes and a stone axe, each at a table just set down). The log
// said "no output" and no more, and what the server had answered could not be told afterwards:
// whether the window it opened stayed open, whether its output slot ever held the item, what the grid
// held at the end. Kept here for the clicks of one craft.
const words = name => String(name).replaceAll('_', ' ');
const ms = n => `${Math.round(n)} ms`;

function startCraftTrace(bot, { now = Date.now } = {}) {
  const client = bot?._client;
  const idle = { state: null, stop() {}, says: () => 'nothing recorded (no connection to listen on)' };
  if (!client || typeof client.on !== 'function' || typeof client.write !== 'function') return idle;
  const t0 = now(), at = () => now() - t0;
  const state = { opened: [], types: {}, serverClosed: [], botClosed: [], clicks: {}, outputs: [], last: null };
  let Item = null;
  try { Item = require('prismarine-item')(bot.registry); } catch (_) { Item = null; }
  const named = raw => {
    if (raw == null) return null;
    try { const it = Item ? Item.fromNotch(raw) : null; return it ? `${it.count} ${words(it.name)}` : null; } catch (_) { return '?'; }
  };
  let live = true;
  const listeners = {
    open_window: p => { if (live) state.opened.push({ id: p.windowId, at: at() }); },
    close_window: p => { if (live) state.serverClosed.push({ id: p.windowId, at: at() }); },
    // Slot 0 of a window other than the pockets is a table's output.
    set_slot: p => { if (live && p.windowId > 0 && p.slot === 0) state.outputs.push({ id: p.windowId, item: named(p.item), at: at() }); },
    window_items: p => {
      if (!live || !(p.windowId > 0)) return;
      state.last = { id: p.windowId, at: at(), output: named(p.items?.[0]), grid: (p.items || []).slice(1, 10).map(named), cursor: named(p.carriedItem) };
      // A full resend can be the only word of the output (a click out of step with the server).
      if (state.last.output) state.outputs.push({ id: p.windowId, item: state.last.output, at: state.last.at });
    },
  };
  for (const [name, fn] of Object.entries(listeners)) client.on(name, fn);
  const typed = w => { if (live && w) state.types[w.id] = String(w.type || '?').replace(/^minecraft:/, ''); };
  if (typeof bot.on === 'function') bot.on('windowOpen', typed);
  const write = client.write;
  const wrapped = function (name, packet, ...rest) {
    if (live && packet) {
      // The window sync's no-op click (slot -999, the end of a drag) is not one of the craft's.
      if (name === 'window_click' && !(packet.slot === -999 && packet.mode === 5)) state.clicks[packet.windowId] = (state.clicks[packet.windowId] || 0) + 1;
      else if (name === 'close_window') state.botClosed.push({ id: packet.windowId, at: at() });
    }
    return write.call(this, name, packet, ...rest);
  };
  client.write = wrapped;
  return {
    state,
    stop() {
      if (!live) return;
      live = false;
      for (const [name, fn] of Object.entries(listeners)) client.removeListener?.(name, fn);
      bot.removeListener?.('windowOpen', typed);
      // Put back only if nothing has wrapped it since; a passthrough otherwise.
      if (client.write === wrapped) client.write = write;
    },
    says: () => traceSays(state),
  };
}

function traceSays(state) {
  if (!state) return 'nothing recorded';
  const parts = [];
  if (!state.opened.length) parts.push('the server opened no window');
  for (const w of state.opened) {
    const clicks = state.clicks[w.id] || 0;
    const shut = state.serverClosed.find(c => c.id === w.id), mine = state.botClosed.find(c => c.id === w.id);
    const outs = state.outputs.filter(o => o.id === w.id), made = outs.find(o => o.item);
    parts.push(`window ${w.id} (${state.types[w.id] || 'type unread'}) opened at ${ms(w.at)}, clicked ${clicks} time${clicks === 1 ? '' : 's'}, ` +
      (made ? `its output set to ${made.item} at ${ms(made.at)}` : outs.length ? 'its output only ever emptied' : 'its output never set') +
      (shut ? `, closed by the server at ${ms(shut.at)}` : '') + (mine ? `, closed by the bot at ${ms(mine.at)}` : ', not closed by the bot'));
  }
  const strays = Object.keys(state.clicks).filter(id => !state.opened.some(w => String(w.id) === id));
  if (strays.length) parts.push(`clicks sent to a window it had not opened: ${strays.map(id => `${id === '0' ? 'the pockets' : 'window ' + id} ${state.clicks[id]}`).join(', ')}`);
  if (state.last) {
    parts.push(`the server's last full view (window ${state.last.id}, at ${ms(state.last.at)}): output ${state.last.output || 'empty'}; grid ${state.last.grid.map(g => g || '-').join(', ')}; cursor ${state.last.cursor || 'empty'}`);
  }
  return parts.join('; ');
}

module.exports = { startCraftTrace, traceSays };
