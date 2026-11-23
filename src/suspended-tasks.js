'use strict';

// Kept in the same atomic checkpoint as the current task: replacing a request
// cannot create a crash gap between separate history and active-state files.
function suspendPrevious(previous) {
  if (!previous) return [];
  const { suspendedTasks = [], ...current } = previous;
  const tasks = [...suspendedTasks];
  if (current.kind !== 'survive' && current.status !== 'complete') tasks.push(current);
  return tasks.slice(-8);
}

const unfinished = goal => goal.status !== 'complete' && goal.kind !== 'survive';
// A player's own work that a resume can pick up. Not the dream, which is
// the bot's idle time and relaunches itself, and not a request parked as
// impossible, which a retry cannot change. Other blocked goals (a death, a
// handover waiting on the player, a launch that failed) told the player to
// say resume, and resume must reach them: passing over every blocked goal
// discarded them from the stack.
// A goal parked as impossible before the mark existed is known by its error.
const IMPOSSIBLE_ERROR = /No supported survival acquisition|does not spawn in Peaceful|Unsupported mob source|Please request at most|spans too many catalog branches/;
const impossible = goal => goal.impossible || (goal.status === 'blocked' && IMPOSSIBLE_ERROR.test(goal.lastError || ''));
const playerWork = goal => unfinished(goal) && !goal.dream && !impossible(goal);
// A come, a follow, a walk to a place or up a ladder: an errand, not the work it interrupted (agenda.js).
const ERRANDS = new Set(['come', 'follow', 'visit', 'climb_ladder']);
const errand = goal => ERRANDS.has(goal?.kind);
const strip = ({ suspendedTasks, ...goal }) => goal;

function resumeSaved(saved, { currentOnly = false, prefer = null } = {}) {
  // Maintenance may unpause an idle companion after a reconnect. It must not
  // turn a completed request into permission to start older suspended work.
  if (currentOnly || !saved) return saved;
  const tasks = [...(saved.suspendedTasks || [])];
  // Work asked for by what it is ("continue building the house", agenda.js): the newest that is it, wherever it
  // lies in the stack; the rest kept, and the work on top kept under it unless it was an errand. Null for none.
  if (prefer) {
    if (playerWork(saved) && prefer(saved)) return saved;
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (!playerWork(tasks[i]) || !prefer(tasks[i])) continue;
      // An errand left in the stack is not taken up later in place of work: it was a moment's.
      const rest = [...tasks.slice(0, i), ...tasks.slice(i + 1)].filter(t => !errand(t));
      if (playerWork(saved) && !errand(saved)) rest.push(strip(saved));
      return { ...tasks[i], suspendedTasks: rest.slice(-8) };
    }
    return null;
  }
  // An errand on top of the work it interrupted is not what a resume takes up (2026-11-22: a house build was set
  // aside by "come to me"); the work under it is.
  if (playerWork(saved) && !(errand(saved) && tasks.some(t => playerWork(t) && !errand(t)))) return saved;
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (playerWork(tasks[i]) && !errand(tasks[i])) return { ...tasks[i], suspendedTasks: tasks.slice(0, i) };
  }
  // The newest player work under whatever is on top. "Get me bedrock"
  // replaced a build and was parked as impossible, and "resume" retried the
  // bedrock forever; the dream started over a stopped build, and "resume"
  // answered that it was already working. Both buried the build where
  // nothing could reach it.
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (playerWork(tasks[i])) return { ...tasks[i], suspendedTasks: tasks.slice(0, i) };
  }
  if (saved.status !== 'complete') return saved;
  while (tasks.length) {
    const previous = tasks.pop();
    if (unfinished(previous)) return { ...previous, suspendedTasks: tasks };
  }
  return saved;
}

// A request parked on a block that only a player can move (a build site's
// stranger block) is ready again once that block is something else. Unloaded,
// or in another dimension, it is not known to be gone.
function waitingCleared(bot, goal) {
  const w = goal?.status === 'blocked' && goal.waitingOn;
  if (!w || String(bot.game?.dimension || 'overworld') !== (w.dimension || 'overworld')) return false;
  const { Vec3 } = require('vec3');
  const block = bot.blockAt?.(new Vec3(w.x, w.y, w.z));
  return !!block && block.name !== w.name;
}

module.exports = { suspendPrevious, resumeSaved, waitingCleared, playerWork, errand, ERRANDS };
