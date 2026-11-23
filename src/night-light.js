'use strict';
// Ground lit enough about the bot that monsters do not spawn there (asked for 2026-11-22: "for covering criteria jev
// should consider lighting in some radious i.e. if the area is well lit then the monsters won't spawn actually so it
// should be relatively safe and jev should be able to put torches").
//
// Since 1.18 a monster spawns only at block light 0, and never within 24 blocks of a player, the bot being one; the
// ones that come at a player at night mostly spawned in the dark some 24 to 40 blocks off and walked in. So the ground
// read is that ring: every third column, its top standing cell within twelve blocks of the bot's height (torches.js
// spawnable), lit or not by the torches, lanterns and glowstone in view (the light worked out from them, torches.js
// propagatedLight, as mineflayer on 26.1 does not apply the server's light updates). Lit at LIT_SHARE of the spots
// read, with at least MIN_SPOTS read, the routine night's shelter is not sought there (survival.js); a threat is
// answered as ever. Caves under the ring are not read. Worked out at most once a minute where the bot stands.
const torches = require('./torches');

const INNER = 24, OUTER = 40, STRIDE = 3, RISE = 12, TILE = 12;
const LIT_SHARE = 0.85, MIN_SPOTS = 40, KEEP_MS = 60000, MOVED = 8;
const key = p => `${p.x},${p.y},${p.z}`;

// The top standing cell of each column read in the ring, over loaded ground.
function ringSpots(bot, centre) {
  const spots = [];
  for (let x = -OUTER; x <= OUTER; x += STRIDE) for (let z = -OUTER; z <= OUTER; z += STRIDE) {
    const d = Math.hypot(x, z);
    if (d < INNER || d > OUTER) continue;
    for (let dy = RISE; dy >= -RISE; dy--) {
      const c = centre.offset(x, dy, z);
      if (!bot.blockAt(c)) break;
      if (torches.spawnable(bot, c)) { spots.push(c); break; }
    }
  }
  return spots;
}

// -> { lit: bool, share, spots, litSpots } for the ground about `bot` (no cache).
function survey(bot, { centre = bot.entity.position.floored(), sources = null } = {}) {
  const spots = ringSpots(bot, centre);
  if (!spots.length) return { lit: false, share: 0, spots: 0, litSpots: 0 };
  const all = sources || torches.lightSources(bot, centre, OUTER);
  // Tile by tile: each tile's light from the sources that can reach it, so the spread is worked out near the spots.
  const tiles = new Map();
  for (const s of spots) { const k = `${Math.floor(s.x / TILE)},${Math.floor(s.z / TILE)}`; (tiles.get(k) || tiles.set(k, []).get(k)).push(s); }
  let lit = 0;
  for (const cells of tiles.values()) {
    const cx = cells.reduce((n, c) => n + c.x, 0) / cells.length, cz = cells.reduce((n, c) => n + c.z, 0) / cells.length;
    const near = all.filter(s => Math.abs(s.position.x - cx) + Math.abs(s.position.z - cz) <= TILE + s.emission);
    if (!near.length) continue;
    const levels = torches.propagatedLight(bot, cells, near);
    lit += cells.filter(c => levels.has(key(c))).length;
  }
  const share = lit / spots.length;
  return { lit: spots.length >= MIN_SPOTS && share >= LIT_SHARE, share, spots: spots.length, litSpots: lit };
}

// Whether the ground about the bot is lit enough to pass the night without a shelter. Kept a minute where it stands;
// said in the log when the answer changes.
function wellLit(bot, now = Date.now()) {
  if (!bot?.entity?.position || typeof bot.blockAt !== 'function') return false;
  const here = bot.entity.position, kept = bot._wellLit;
  if (kept && now - kept.at < KEEP_MS && kept.where.distanceTo(here) < MOVED) return kept.lit;
  let out;
  try { out = survey(bot); } catch (err) { console.log(`[night] the light about could not be read: ${err.message}`); out = { lit: false, share: 0, spots: 0 }; }
  if (!kept || kept.lit !== out.lit) console.log(`[night] ${out.lit ? 'lit about' : 'not lit enough about'}: ${Math.round(out.share * 100)}% of ${out.spots} spots ${INNER} to ${OUTER} blocks off${out.lit ? ', so no shelter is needed here' : ''}`);
  bot._wellLit = { at: now, where: here.clone(), lit: out.lit, share: out.share, spots: out.spots };
  return out.lit;
}

module.exports = { wellLit, survey, ringSpots, INNER, OUTER, LIT_SHARE, MIN_SPOTS };
