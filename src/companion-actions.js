'use strict';
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { darkCells, connectedGround, torchPlan } = require('./torches');

const vec = (p) => new Vec3(p.x, p.y, p.z);
const directions = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const blocked = (message) => Object.assign(new Error(message), { name: 'Blocked', needsPlayer: true });

function companionAction(text, workSite) {
  const ask = text
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/^(?:(?:please|can you|could you|would you)[ ,]+)+/, '')
    .replace(/,? please$/, '');
  const boat =
    /^(come(?: to me| here)?|follow me|cross (?:the (?:lake|river|water) )?to me) (?:by|in|using|with) (?:a |the |your )?boat$/.exec(
      ask
    );
  if (boat) return { kind: boat[1] === 'follow me' ? 'follow' : 'come', byBoat: true };
  const ladder =
    /^(?:climb|go|head) (?:(up|down) )?(?:the |this |that |a |the nearest |the closest )?ladder(?: (up|down))?$/.exec(
      ask
    );
  if (ladder) return { kind: 'climb_ladder', direction: ladder[1] || ladder[2] || 'up' };
  if (workSite) {
    const placement = /^(?:put(?: down)?|place|install|add|set up) (?:(a|an|one|two|three|four|[1-9]\d{0,2}) )?(torch(?:es)?|chests?)(?: here)?$/.exec(ask);
    if (placement) {
      const count = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 }[placement[1]] || Number(placement[1] || 1);
      return { kind: 'place_at_site', item: placement[2].startsWith('torch') ? 'torch' : 'chest', count, workSite };
    }
  }
  if (
    /^(?:light (?:up (?:this (?:area|room)|the area|around (?:me|here)|here)|(?:this (?:area|room)|the area) up)|(?:put|place|add|set up) (?:some |a few )?torches (?:around (?:here|me)|here|in this (?:area|room)))$/.test(
      ask
    )
  )
    return { kind: 'light_area' };
  return null;
}

function safeLadderEnds(bot, foot, landing, top) {
  const clear = p => {
    const b = bot.blockAt(p);
    return b?.boundingBox === 'empty' && !/lava|water|fire/.test(b.name);
  };
  const safe = p => {
    const floor = bot.blockAt(p.offset(0, -1, 0));
    return floor?.boundingBox === 'block' && !/magma_block|campfire|cactus/.test(floor.name) && clear(p) && clear(p.offset(0, 1, 0));
  };
  return safe(foot) && safe(landing) && clear(top.offset(0, 1, 0)) && clear(top.offset(0, 2, 0));
}

function ladderColumn(bot, anchor, direction) {
  const matches = bot.findBlocks({
    matching: bot.registry.blocksByName.ladder.id,
    point: anchor,
    maxDistance: 24,
    count: 256
  });
  const seen = new Set(),
    columns = [];
  for (const p of matches) {
    if (seen.has(p.toString())) continue;
    const facing = bot.blockAt(p)?.getProperties().facing;
    if (!directions[facing]) continue;
    const same = (q) => {
      const b = bot.blockAt(q);
      return b?.name === 'ladder' && b.getProperties().facing === facing;
    };
    let bottom = p,
      top = p;
    while (same(bottom.offset(0, -1, 0))) bottom = bottom.offset(0, -1, 0);
    while (same(top.offset(0, 1, 0))) top = top.offset(0, 1, 0);
    for (let y = bottom.y; y <= top.y; y++) seen.add(new Vec3(p.x, y, p.z).toString());
    const [dx, dz] = directions[facing];
    const foot = bottom.offset(dx, 0, dz),
      landing = top.offset(-dx, 1, -dz);
    if (!safeLadderEnds(bot, foot, landing, top)) continue;
    const nearest = new Vec3(p.x, Math.max(bottom.y, Math.min(anchor.y, top.y)), p.z);
    columns.push({
      bottom,
      top,
      facing,
      foot,
      landing,
      distance: nearest.distanceTo(anchor),
      approach: (direction === 'up' ? foot : landing).distanceTo(bot.entity.position)
    });
  }
  return columns.sort((a, b) => a.distance - b.distance || a.approach - b.approach)[0];
}

async function climbLadder(bot, task, goal, save, navigate) {
  const anchor = vec(goal.workSite?.position || goal.requesterPosition || bot.entity.position).floored();
  if (!goal.ladder) {
    goal.ladder = ladderColumn(bot, anchor, goal.direction);
    if (!goal.ladder) throw blocked('I need a ladder nearby with a safe place to stand at each end.');
    goal.step = { action: 'climb_ladder', direction: goal.direction };
    save();
  }
  const { facing } = goal.ladder,
    [dx, dz] = directions[facing];
  const up = goal.direction === 'up',
    start = vec(up ? goal.ladder.foot : goal.ladder.landing);
  const end = vec(up ? goal.ladder.landing : goal.ladder.foot),
    bottom = vec(goal.ladder.bottom),
    top = vec(goal.ladder.top);
  const centred = (p) => p.offset(0.5, 0, 0.5);
  const atEnd = () => bot.entity.onGround && bot.entity.position.floored().equals(end);
  const checkLandings = () => {
    if (!safeLadderEnds(bot, start, end, top)) throw blocked('The ladder landing has changed. I need safe ground and headroom at both ends.');
  };
  checkLandings();
  if (atEnd()) return true;
  const here = bot.entity.position.floored();
  if (here.x !== bottom.x || here.z !== bottom.z || here.y < bottom.y || here.y > top.y) {
    await navigate(bot, task, new goals.GoalBlock(start.x, start.y, start.z), { timeoutMs: 25000, stallMs: 5000 });
  }
  try {
    let previousY = bot.entity.position.y,
      lastProgress = Date.now();
    for (let tick = 0; tick < 140 + 12 * (top.y - bottom.y + 1); tick++) {
      task.check();
      checkLandings();
      if (atEnd()) return true;
      const feet = bot.entity.position,
        cell = feet.floored();
      const rung = bot.blockAt(new Vec3(bottom.x, Math.max(bottom.y, Math.min(top.y, cell.y)), bottom.z));
      if (rung?.name !== 'ladder' || rung.getProperties().facing !== facing)
        throw blocked('The ladder has changed. I need a continuous set of rungs.');
      // While descending, let gravity carry the bot down the column. Pushing
      // into its supporting wall would make Minecraft climb it again.
      let target = centred(bottom),
        jump = false,
        forward = true;
      if (up) {
        target = centred(top).offset(-dx, 0, -dz);
        jump = true;
      } else if (feet.y < bottom.y + 0.25) target = centred(end);
      else {
        target = centred(bottom).offset(dx * 0.16, 0, dz * 0.16);
        const inColumn = cell.x === bottom.x && cell.z === bottom.z;
        // Step past the top edge of the rung and the lip of the landing
        // before releasing forward. A player's feet are 0.6 blocks wide.
        if (inColumn && (feet.y < top.y + 0.9 || Math.hypot(feet.x - target.x, feet.z - target.z) < 0.12))
          forward = false;
      }
      const ex = target.x - feet.x,
        ez = target.z - feet.z;
      if (forward) await bot.look(Math.atan2(-ex, -ez), 0, true);
      bot.setControlState('jump', jump);
      bot.setControlState('forward', forward);
      if (Math.abs(feet.y - previousY) > 0.15) {
        previousY = feet.y;
        lastProgress = Date.now();
      }
      if (Date.now() - lastProgress > 5000) break;
      await bot.waitForTicks(1);
    }
    throw blocked('I could not reach the landing safely. Please check the ends of the ladder.');
  } finally {
    bot.clearControlStates();
  }
}

async function lightArea(bot, task, goal, save, { acquireStep, place, navigate }) {
  const centre = vec(
    goal.workSite?.position || goal.lightCentre || goal.requesterPosition || bot.entity.position
  ).floored();
  if (!goal.lightCentre) {
    goal.lightCentre = { ...centre };
    save();
  }
  if (bot.entity.position.distanceTo(centre) > 11) {
    await navigate(bot, task, new goals.GoalNear(centre.x, centre.y, centre.z, 3));
  }
  const cells = connectedGround(bot, centre, 6);
  if (!cells.length) throw blocked('I need solid ground nearby with room above it to place torches.');
  const dark = darkCells(bot, cells);
  if (!dark.length) return true;
  const sites = dark.filter(
    (p) =>
      !bot.entities || !Object.values(bot.entities).some((e) => e !== bot.entity && e.position?.floored().equals(p))
  );
  const [next] = torchPlan(sites, 1, bot);
  if (!next) throw blocked('Please leave me a free spot for the torch.');
  if (!bot.inventory.items().some((i) => i.name === 'torch')) {
    await acquireStep(bot, task, 'torch', 1, goal, save);
    return false;
  }
  goal.step = { action: 'light_area', position: { ...next } };
  save();
  task.check();
  await place(bot, task, next, 'torch');
  if (bot.blockAt(next)?.name !== 'torch') throw new Error('The torch did not stay on its support.');
  goal.torchesPlaced = (goal.torchesPlaced || 0) + 1;
  save();
  return false;
}
module.exports = { companionAction, ladderColumn, climbLadder, lightArea };
