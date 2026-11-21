'use strict';
// The time of day, read from the right clock.
//
// From 26.1 the time packet carries a running count for each world clock (the
// registry minecraft:world_clock: the Overworld's and the End's), named by its
// number in that registry. mineflayer 4.39 (lib/plugins/time.js) files a count
// under the dimension type that has the same number. The two registries are
// numbered apart, so that is right only while they happen to line up. A
// datapack that adds a dimension type ahead of the Overworld's (Terralith
// does) moves every type up by one, and the End's clock is then filed as the
// Overworld's.
//
// The End's clock is the world's age. It reads the same as the time of day
// until someone sets the time or sleeps a night away, and wrong from then on:
// on a server whose time had been set to morning the bot read 16,000, took a
// bright morning for night, hunted and dug itself a night's pocket, with a
// player's "come here" waiting (2026-11-21).
//
// Here each clock is filed under the dimension of its own name, before the
// library reads the packet. A clock with no dimension of its name is left out
// rather than filed under a stranger's.
const VANILLA = ['minecraft:overworld', 'minecraft:the_end'];
const bare = name => String(name ?? '').replace(/^minecraft:/, '');

// -> the updates with each id changed from the clock's number to the number of
// the dimension type the library will look it up by. `keys`: the clock
// registry's names in their order.
function refile(updates, keys, dimensionsById) {
  const dims = Object.entries(dimensionsById || {});
  if (!dims.length) return updates;
  const out = [];
  for (const update of updates) {
    const name = bare(keys[update?.id]);
    const dim = name && dims.find(([, d]) => bare(d?.name) === name);
    if (dim) out.push({ ...update, id: Number(dim[0]) });
  }
  return out;
}

function install(bot) {
  const client = bot?._client;
  if (!client || typeof client.prependListener !== 'function') return;
  let keys = null, warned = false, last = null;
  // The registry comes before login, so this is called as the bot is made.
  client.on('registry_data', packet => {
    try { if (bare(packet?.id) === 'world_clock' && Array.isArray(packet.entries)) keys = packet.entries.map(entry => entry.key); } catch (_) { /* keeps the last known */ }
  });
  // The clocks filed from the packet before are where they were put: looked at
  // when the next packet comes, the library having read that one by then. If
  // a later mineflayer files them by name itself, this says so once, and
  // src/world-clock.js is to go (scripts/world-clock-test.js fails on it too).
  const verify = filed => {
    if (warned || !bot.time?.clocks) return;
    const types = bot.registry?.dimensionsById || {};
    if (filed.every(update => bot.time.clocks[types[update.id]?.name] === update)) return;
    warned = true;
    console.error('[clock] the library did not file the world clocks as src/world-clock.js expects; the time of day may be wrong');
  };
  // Ahead of the library's own listener, whenever that one is added.
  client.prependListener('update_time', packet => {
    if (last) { const filed = last; last = null; try { verify(filed); } catch (_) { /* a check only */ } }
    if (!Array.isArray(packet?.clockUpdates) || !packet.clockUpdates.length) return;
    try {
      const filed = packet.clockUpdates = refile(packet.clockUpdates, keys || VANILLA, bot.registry?.dimensionsById);
      if (filed.length) last = filed;
    } catch (_) { /* the packet as it came */ }
  });
}

module.exports = { install, refile, VANILLA };
