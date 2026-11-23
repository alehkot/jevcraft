'use strict';
// The work a player set and the bot has not finished, and how it is taken up again (asked for 2026-11-22: "i want to
// introduce some kind of planner for jev so that it stays on track on high level goals i set if he got distracted and
// remembers where he was doing things, e.g. he started building a house then got distracted and i asked it to finish
// and he couldn't remember where it was"). A house begun for a player was once set aside by a death and a
// "come to me"; "continue building house" then went to the build-continuation question with the house left off the
// list (builds.js describe kept only buildings a quarter standing, within 96 blocks of the speaker), and a new house
// was planned somewhere else.
//
// The work set aside is the goal stack (suspended-tasks.js): every request a later one replaced, with its plan and
// how far it got. Here:
// - continueAsk: "continue", "carry on", "continue building the house", "finish the house" and the like, read by rule
//   (companion-actions.js), not left to the request interpreter;
// - unfinishedBuilds: the buildings the bot began and did not finish, from the registry, wherever they stand and
//   however little of them stands, this player's first and then the nearest;
// - setAside and reminder: the list the guide is told (session.js guideStatus), and the line said when an errand
//   that interrupted the work is done.
const BUILD_KINDS = new Set(['build', 'house']);
const isBuild = goal => BUILD_KINDS.has(goal?.kind) || !!goal?.continueBuild;
const { errand, playerWork, resumeSaved } = require('./suspended-tasks');
const notErrand = goal => !errand(goal);

const BUILDING = '(?:house|home|building|build|cottage|tower|hut|cabin|shelter|base|barn|starter house|structure)';
const ANY_ASK = /^(?:continue|carry on|keep going|go on|get back to (?:work|it)|go back to (?:work|it|what you were doing)|back to work|(?:continue|finish|carry on with) (?:what you were doing|your work|your job|the job|the work|working)|keep working)$/;
const BUILD_ASK = new RegExp(`^(?:(?:continue|finish|complete|resume|keep|carry on|go on|go back to|get back to|back to)(?: with| on)? (?:building|constructing|the building of|work on|working on)(?: (?:the|my|our|your|that|this|his|her))?(?: [a-z ]{0,30}?${BUILDING})?|(?:continue|finish|complete|resume|carry on with|go on with|go back to|get back to|back to)(?: (?:the|my|our|your|that|this|his|her))? (?:[a-z ]{0,30}? )?${BUILDING})(?: (?:you (?:were building|started|began)|we started|from before))?$`);

// What a continuation request asks for: { what: 'build' | 'any' }, or null for another request.
function continueAsk(text) {
  // Punctuation is no part of the asking, wherever it falls: "continue building. house" was once read past this
  // rule for its full stop, and a new house was offered.
  const ask = String(text || '').toLowerCase().replace(/[.,;:!?]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:(?:please|can you|could you|would you|now) )+/, '').replace(/ please$/, '');
  if (BUILD_ASK.test(ask)) return { what: 'build' };
  if (ANY_ASK.test(ask)) return { what: 'any' };
  return null;
}

// The request as it was asked, without the bot's name in front.
function said(goal, username = 'Jev') {
  const text = String(goal?.request || goal?.kind || 'that').replace(/\s+/g, ' ').trim();
  const name = String(username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (name ? text.replace(new RegExp(`^${name}[,:]?\\s+`, 'i'), '') : text).slice(0, 100);
}

// Where a piece of work stands: its site's corner, or the place it was asked for; and how far that is from `point`.
function siteOf(goal) {
  const p = goal?.blueprint?.origin || goal?.buildAnchor || goal?.workSite?.position || null;
  return p && Number.isFinite(p.x) && Number.isFinite(p.z) ? { x: Math.round(p.x), y: Math.round(p.y ?? 64), z: Math.round(p.z) } : null;
}
function whereSaid(goal, point) {
  const at = siteOf(goal);
  if (!at) return '';
  const d = point && Number.isFinite(point.x) ? Math.round(Math.hypot(at.x - point.x, at.y - (point.y ?? at.y), at.z - point.z)) : null;
  return ` at ${at.x}, ${at.y}, ${at.z}${d != null ? ` (${d} blocks from you)` : ''}`;
}

// The player work set aside, newest first: what the guide is told the bot still has to do.
function setAside(saved, { username, point, max = 5 } = {}) {
  if (!saved) return [];
  const { suspendedTasks = [], ...top } = saved;
  return [top, ...[...suspendedTasks].reverse()].filter(g => playerWork(g) && notErrand(g)).slice(0, max)
    .map(g => ({ request: said(g, username), for: g.from, ended: g.status, ...(siteOf(g) ? { at: siteOf(g) } : {}),
      ...(point && siteOf(g) ? { blocksFromPlayer: Math.round(Math.hypot(siteOf(g).x - point.x, siteOf(g).z - point.z)) } : {}) }));
}

// The buildings begun and not finished, from the registry (builds.js): this player's first, then the nearest to
// `point`; the share still standing given, however small.
function unfinishedBuilds(registry, bot, { from, point, dimension } = {}) {
  if (!registry?.all) return [];
  const at = point || bot?.entity?.position;
  return registry.all(dimension).filter(e => e.status !== 'complete' && e.origin).map(e => {
    let standing = null; try { standing = Math.round(registry.standing(bot, e) * 100); } catch (_) { standing = null; }
    const c = e.bounds ? { x: (e.bounds.min.x + e.bounds.max.x) / 2, y: e.bounds.min.y, z: (e.bounds.min.z + e.bounds.max.z) / 2 } : e.origin;
    const distance = at ? Math.round(Math.hypot(c.x - at.x, (c.y ?? 0) - (at.y ?? c.y ?? 0), c.z - at.z)) : null;
    return { id: e.id, name: e.name || 'building', request: e.request, from: e.from, origin: e.origin, distance, standing, updatedAt: e.updatedAt };
  }).sort((a, b) => (Number(b.from === from) - Number(a.from === from)) || ((a.distance ?? 1e9) - (b.distance ?? 1e9)));
}

// Said when an errand is done with work still set aside under it: how to get the bot back on that work.
function reminder(done, { username = 'Jev' } = {}) {
  if (!done || done.status !== 'complete' || done.dream || done.back || done.weaponErrand) return null;
  const next = resumeSaved(done);
  if (!next || next === done || !playerWork(next) || errand(next)) return null;
  return `Say "${username} continue" when you want me back on ${said(next, username)}.`;
}

// Whether a continuation has something to take up: the work in hand being it, work set aside, or for a building one
// of the bot's own left unfinished.
function hasWork(saved, registry, bot, what, { active = null, from } = {}) {
  const prefer = what === 'build' ? isBuild : notErrand;
  if (active && prefer(active)) return true;
  if (resumeSaved(saved, { prefer })) return true;
  return what === 'build' && unfinishedBuilds(registry, bot, { from, dimension: bot?.game?.dimension }).length > 0;
}

module.exports = { hasWork, BUILD_KINDS, isBuild, notErrand, continueAsk, said, siteOf, whereSaid, setAside, unfinishedBuilds, reminder };
