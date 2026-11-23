'use strict';
// Waiting for a player's word (JEV_IDLE=wait): between requests the bot does not
// gather, shelter or explore. It only answers what would hurt it where it stands:
// lava, fire, drowning, suffocation, a mob in reach. Ported from
// alexrmsouza/jevcraft (commit d1f4533f, 'wait for requests with reactive
// defense'), without that fork's planner and request-epoch plumbing.
const danger = require('./danger'), vitals = require('./vitals'), body = require('./body');
const { Task, Cancelled } = require('./skills');

function emergency(bot) {
  if (!bot.entity?.position || bot.isAlive === false || ['creative', 'spectator'].includes(bot.game?.gameMode)) return null;
  if (require('./terrain').bodyInLava(bot)) return { kind: 'lava' };
  if (vitals.headInBlock(bot)) return { kind: 'head_in_block' };
  if (vitals.inFire(bot) || (vitals.onFire(bot) && !body.outlastsBurning(bot) && !body.held(bot, 'fire'))) return { kind: 'fire' };
  const hot = vitals.onHotFloor(bot); if (hot) return { kind: 'hot_floor', hot };
  if (vitals.inPowderSnow(bot)) return { kind: 'snow' };
  if (vitals.needsAir(bot) && vitals.headSubmerged(bot)) return { kind: 'air' };
  const threat = danger.immediateThreat(bot);
  return threat && !threat.projectile ? { kind: 'mob', threat } : null;
}

// What the waiting bot chose against a mob, in the log: once a mob and choice, again after five seconds of the same.
// Its runs were written nowhere (the trial of 2026-11-22: 109 blocks from its player in under a minute, and not a
// line of it), so what moved it had to be worked out afterwards.
function said(bot, threat, choice, acted, now = Date.now(), held = null) {
  const key = `${threat?.entity?.id}|${choice}|${acted}|${!!held}`;
  if (bot._waitSaid?.key === key && now - bot._waitSaid.at < 5000) return null;
  bot._waitSaid = { key, at: now };
  const name = bot._company?.name, at = name && bot.players?.[name]?.entity?.position, me = bot.entity?.position;
  const off = Number.isFinite(threat?.distance) ? ` ${Math.round(threat.distance * 10) / 10} blocks off` : '';
  const line = `[wait] the ${threat?.entity?.name || 'mob'}${off}: ${choice || 'nothing chosen'}${held ? ', no run offered' : ''}${acted ? '' : ', not acted on'}${name ? `; ${name} ${at && me ? `${Math.round(at.distanceTo(me))} blocks off` : 'out of sight'}` : ''}`;
  console.log(line);
  return line;
}

// The waiting bot's ways against a mob in reach. Waiting with a player more than company.WAIT_TETHER blocks off, the
// run is left off (company.js holdsGround), and the one way left is taken without asking.
function mobWays(bot, survival, task, goal, save, threats, now = Date.now()) {
  const tree = {
    retreat: { description: 'Escape the immediate attackers using nearby safe footing; do not gather or prepare supplies.', run: () => survival.runAway(task, goal, save, threats) },
    fight: { description: 'Defend against attackers already in reach with the equipment currently carried, for one second.', run: () => survival.swingFor(task, goal, save, 1000) },
  };
  const held = require('./company').holdsGround(bot, threats, now);
  if (held) delete tree.retreat;
  return { tree, held };
}

async function respond(bot, survival, task, goal, save, event, fresh) {
  task.check();
  event = emergency(bot);
  if (!event) return false;
  const report = action => { goal.survivalAction = { ...action, at: new Date().toISOString() }; save(); };
  const answerBody = (kind, ways, facts = {}) => {
    const check = () => { task.check(); if (!fresh() || emergency(bot)?.kind !== event.kind) throw new Cancelled(task.label); };
    const guarded = Object.fromEntries(Object.entries(ways).map(([key, way]) => [key, { ...way, run: () => { check(); return way.run(); } }]));
    return body.answer(bot, task, kind, guarded, { client: survival.client, goal, save, facts,
      decide: async (id, options) => {
        check();
        const answer = await require('./decisions').decide(id, { ...options, interrupt: () => { check(); options.interrupt?.(); } });
        check(); return answer;
      } });
  };
  if (event.kind === 'lava') {
    const lava = require('./lava-escape');
    if (lava.mustEscape(bot)) await lava.escape(survival, task, goal, save);
    else await answerBody('lava', survival.lavaWays(task, goal, save));
  } else if (event.kind === 'snow') await vitals.outOfPowderSnow(bot, task, report);
  else if (event.kind !== 'mob') {
    const ways = event.kind === 'fire' ? vitals.fireWays(bot, task, report)
      : event.kind === 'head_in_block' ? vitals.headWays(bot, task, report)
      : event.kind === 'hot_floor' ? vitals.hotFloorWays(bot, task, report, event.hot) : vitals.airWays(bot, task, report);
    task.check();
    await answerBody(event.kind, ways, event.kind === 'fire' ? { inFire: vitals.inFire(bot) } : {});
  } else {
    const threats = danger.threats(bot).filter(t => t.visible || t.distance <= 3);
    if (!threats.length) threats.push(event.threat);
    const { tree, held } = mobWays(bot, survival, task, goal, save, threats);
    // Holding its ground, the one way left is taken at once: nothing is asked.
    const decision = held ? { path: ['fight'] } : await survival.decide(task, goal, save, { id: 'encounter_stance', tree,
      state: { health: bot.health, food: bot.food, waitingForPlayer: true, threats: threats.map(t => ({ name: t.entity.name, distance: t.distance })) },
      isFresh: () => fresh() && emergency(bot)?.threat?.entity?.id === event.threat.entity.id });
    task.check();
    const acts = !decision?.stale && fresh() && emergency(bot)?.threat?.entity?.id === event.threat.entity.id && Object.hasOwn(tree, decision?.path?.[0]);
    said(bot, event.threat, decision?.path?.[0], acts, Date.now(), held);
    if (acts) await tree[decision.path[0]].run();
  }
  task.check();
  return true;
}

function createReactiveWait({ bot, survival, save = () => {}, isReady = () => true, isBusy = () => false } = {}) {
  let active = null;
  bot._reactiveWaitActive = false;
  const allowed = () => isReady() && !isBusy() && bot.isAlive !== false;
  const stopMotion = () => { bot.pathfinder?.setGoal?.(null); bot.clearControlStates?.(); bot.deactivateItem?.(); };
  return {
    async tick() {
      if (!allowed()) return false;
      const event = emergency(bot);
      if (active) { if (!event) active.task.cancel(); return false; }
      if (!event) return false;
      const task = new Task('reactive_wait', 'React to immediate danger while waiting for a player request');
      const fresh = () => allowed() && !task.cancelled;
      task.interruptCheck = () => { if (!fresh()) throw new Cancelled(task.label); };
      const record = { task, promise: null }; active = record; bot._reactiveWaitActive = true;
      const goal = { kind: 'survive', request: task.description, survival: survival.state };
      record.promise = Promise.resolve().then(() => respond(bot, survival, task, goal, save, event, fresh))
        .catch(error => { if (error.name === 'Cancelled' || task.cancelled) return false; throw error; })
        .finally(() => { if (active === record) { active = null; bot._reactiveWaitActive = false; stopMotion(); } });
      return record.promise;
    },
    async cancel() {
      const record = active; if (!record) return;
      record.task.cancel(); stopMotion();
      await record.promise.catch(() => {});
    },
  };
}

module.exports = { createReactiveWait, emergency, said, mobWays };
