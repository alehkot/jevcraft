'use strict';
const { Vec3 } = require('vec3');
const { dimension } = require('./memory');
const CHANNEL = 'jevcraft:locations';
function point(value, dim = value?.dimension) {
  if (!dim || !value || !['x', 'y', 'z'].every((k) => Number.isFinite(value[k]))) return null;
  return { x: Math.floor(value.x), y: Math.floor(value.y), z: Math.floor(value.z), dimension: dimension(dim) };
}
function where(p) {
  return `${p.x}, ${p.y}, ${p.z} in ${p.dimension.replaceAll('_', ' ')}`;
}

function locationRequest(raw) {
  const text = raw
    .toLowerCase()
    .trim()
    .replace(/[?!.]+$/, '')
    .replace(/^(?:please |can you |could you )+/, '');
  if (
    /^(?:remember (?:this|here) as|set (?:this|here) as|make this|mark (?:this|here) as) (?:our |your |my )?home$|^set (?:our |your |my )?home here$/.test(
      text
    )
  )
    return 'set';
  if (/^(?:go|come|return|head)(?: back)? (?:to (?:your |our )?)?home$/.test(text)) return 'visit_home';
  if (
    /^(?:go|return|head)(?: back)? to (?:the |your )?(?:(?:re)?spawn|resurrection) (?:point|spot|location)$/.test(text)
  )
    return 'visit_respawn';
  if (
    !/^(?:where(?:'s| is| are| will| do| would)?\b|what(?:'s| is| are)\b|do you know where\b|tell me (?:where|your)\b)/.test(
      text
    )
  )
    return null;
  // Leave questions about other things near home to the ordinary guide.
  if (text.replace(/\b(?:where|what|s|s?coordinates?|position|location|spot|point|is|are|will|would|do|does|you|your|our|my|we|me|the|and|know|tell|home|base|spawn|spawnpoint|respawn|resurrect|resurrection|come|back|to|life|die|if|after|death|again|please)\b/g, '').replace(/[\s?',]/g, '')) return null;
  const home = /\bhome(?: base)?\b/.test(text);
  const spawn = /\b(?:respawn|resurrect(?:ion)?|spawn(?:point)?|come back to life)\b/.test(text);
  return home && spawn ? 'both' : home ? 'home' : spawn ? 'respawn' : null;
}

function attachHomeLocation(bot, survival, memory, builds, save) {
  const state = (survival.state.locations ||= {});
  const pending = new Set();
  let lastReply = 0;
  let current = false,
    interval,
    recentUse,
    registered = false;
  function update(values) {
    if (!Object.entries(values).some(([k, v]) => JSON.stringify(state[k]) !== JSON.stringify(v))) return;
    Object.assign(state, values);
    save();
  }
  function request() {
    if (!registered) return;
    try {
      bot._client.write('custom_payload', { channel: CHANNEL, data: Buffer.from([1]) });
    } catch {
      /* the connection is closing */
    }
  }
  function packet({ channel, data }) {
    if (channel !== CHANNEL || !Buffer.isBuffer(data) || data.length > 4096) return;
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (message?.version === 1 && message.scaffold) {
      const p = point(message.scaffold), type = message.scaffold.material;
      if (p && p.dimension === dimension(bot.game.dimension) && ['dirt', 'cobblestone'].includes(type)) {
        const stateId = bot.registry.blocksByName[type]?.defaultState;
        if (Number.isInteger(stateId)) bot.emit('confirmedBuildScaffold', { name: type, stateId, position: new Vec3(p.x,p.y,p.z) });
      }
      return;
    }
    const world = point(message?.worldSpawn),
      effective = point(message?.effective);
    if (
      message?.version !== 1 ||
      !world ||
      !['personal', 'world', 'server_spawn', 'server'].includes(message.rule) ||
      (message.rule !== 'server' && !effective)
    )
      return;
    current = true;
    lastReply = Date.now();
    update({
      worldSpawn: world,
      personal: point(message.personal),
      effective,
      rule: message.rule,
      personalBlock: false,
      ...(point(message.landing) && { lastLanding: point(message.landing) })
    });
    for (const finish of pending) finish();
    pending.clear();
  }
  bot._client.on('custom_payload', packet);
  bot._client.on('spawn_position', (packet) => {
    const p = point(packet.globalPos?.location || packet.location, packet.globalPos?.dimensionName || 'overworld');
    if (p && !current) update({ worldSpawn: p });
  });
  bot.on('spawn', () => {
    if (!registered) {
      registered = true;
      bot._client.write('custom_payload', { channel: 'minecraft:register', data: Buffer.from(CHANNEL) });
      interval = setInterval(request, 30000);
      interval.unref?.();
    }
    if (state.awaitingRespawn && bot.entity?.position)
      update({ awaitingRespawn: false, lastLanding: point(bot.entity.position, bot.game.dimension) });
    request();
  });
  bot.on('death', () => update({ awaitingRespawn: true }));
  // Portable fallback for servers without the Paper companion. Only record a
  // bed/anchor interaction after the server confirms it, never from placement.
  let wrapped = false;
  function watchUse() {
    if (wrapped || !bot.activateBlock) return;
    wrapped = true;
    const activate = bot.activateBlock;
    bot.activateBlock = function (block, ...args) {
      const dim = dimension(bot.game?.dimension);
      if (
        (dim === 'overworld' && block?.name.endsWith('_bed')) ||
        (dim === 'nether' && block?.name === 'respawn_anchor')
      ) {
        let p = block.position;
        const props = block.getProperties?.() || {};
        if (props.part === 'foot') {
          const sides = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] },
            side = sides[props.facing];
          if (side) p = p.offset(side[0], 0, side[1]);
        }
        recentUse = { position: point(p, dim), at: Date.now() };
      }
      return activate.call(this, block, ...args);
    };
  }
  watchUse();
  bot.once('spawn', watchUse);
  function confirmed() {
    if (recentUse && Date.now() - recentUse.at < 5000 && !current)
      update({ personal: recentUse.position, rule: 'personal', effective: recentUse.position, personalBlock: true });
    recentUse = null;
    request();
  }
  bot.on('sleep', confirmed);
  bot.on('message', (message, position) => {
    if (position === 'chat') return;
    const key = message?.json?.translate || message?.translate;
    if (key === 'block.minecraft.set_spawn' || key === 'block.minecraft.respawn_anchor.set_spawn') confirmed();
  });
  bot.on('spawnReset', () => {
    if (!current) update({ personal: null, effective: null, rule: 'world' });
    request();
  });
  bot.on('end', () => {
    clearInterval(interval);
    for (const finish of pending) finish();
    pending.clear();
  });
  function home(from) {
    const named = memory
      .context(from)
      .places?.filter((e) => /^home$/i.test(e.label))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    if (named) return { position: point(named.position, named.dimension), source: 'saved home' };
    if (state.home) return { position: state.home, source: 'saved home' };
    const base = survival.state.home;
    if (base?.origin) return { position: point(base.origin, base.dimension || 'overworld'), source: 'home base' };
    const built = builds
      .all()
      .filter(
        (b) =>
          b.status === 'complete' &&
          (b.kind === 'house' || /\b(?:house|cabin|cottage|hut|home)\b/i.test([b.name, b.request].join(' ')))
      )
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (!state.firstHouse && built) update({ firstHouse: point(built.entrance || built.origin, built.dimension) });
    if (state.firstHouse) return { position: state.firstHouse, source: 'house entrance' };
    return state.worldSpawn ? { position: state.worldSpawn, source: 'temporary home at world spawn' } : null;
  }
  function respawn() {
    if (current && Date.now() - lastReply > 65000) current = false;
    if (current || state.rule === 'server' || state.rule === 'server_spawn')
      return { position: state.effective, rule: state.rule, confirmed: current };
    const p = state.personal;
    if (p && dimension(bot.game?.dimension) === p.dimension) {
      const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
      if (b && !b.name.endsWith('_bed') && b.name !== 'respawn_anchor' && state.rule === 'personal') {
        // A forced server spawn may be on any block. Only a personal point
        // confirmed by our own bed interaction can be invalidated this way.
        if (state.personalBlock) update({ personal: null, rule: 'world', effective: null, personalBlock: false });
      }
    }
    return {
      position: state.personal || state.worldSpawn,
      rule: state.personal ? 'personal' : 'world',
      confirmed: false
    };
  }
  function context(from) {
    return { home: home(from), respawn: respawn(), lastRespawn: state.lastLanding || null };
  }
  async function refresh() {
    if (!registered) return;
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pending.delete(done);
        resolve();
      };
      const timer = setTimeout(done, current ? 800 : 650);
      pending.add(done);
      request();
    });
  }
  function describe(from, what) {
    const h = home(from),
      r = respawn(),
      messages = [];
    if (what === 'home' || what === 'both')
      messages.push(
        h
          ? `My ${h.source} is at ${where(h.position)}.`
          : 'I have not learned a home yet. Stand there and say “Jev set home here”.'
      );
    if (what === 'respawn' || what === 'both') {
      const label =
        { world: 'world spawn', personal: 'personal respawn point', server_spawn: 'server spawn' }[r.rule] ||
        'respawn point';
      messages.push(
        r.position
          ? `${r.confirmed ? 'My' : 'My last known'} ${label} is at ${where(r.position)}.`
          : `The server chooses where I respawn.${state.lastLanding ? ' I last came back at ' + where(state.lastLanding) + '.' : ''}`
      );
    }
    if ((what === 'both' || what === 'respawn') && current && state.personal && state.rule === 'server_spawn')
      messages.push(`My personal point is at ${where(state.personal)}, but this server sends me to its spawn.`);
    return messages.join(' ');
  }
  return {
    context,
    describe,
    refresh,
    home,
    respawn,
    setHome(from, position, dim) {
      const p = point(position, dim);
      if (!p) return 'Stand where you want home and ask me again when I can see you.';
      memory.rememberPlace(from, 'home', p, p.dimension);
      update({ home: p });
      return `I will remember home at ${where(p)}.`;
    }
  };
}
module.exports = { attachHomeLocation, locationRequest };
