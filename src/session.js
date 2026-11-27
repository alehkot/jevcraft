'use strict';
// The last death this process recorded, whichever connection it was in (note 1934).
let lastDeathSeen = null;
const DEATH_WORDS = /^(was |were |died|drowned|fell|burned|went up in flames|tried to swim|blew up|hit the ground|starved|suffocated|froze|withered|walked into|experienced kinetic|discovered the floor)/;

const path = require('path');
const fs = require('fs');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { configureMovements } = require('./movement');
const { interpret, GoalStore } = require('./objectives');
const { designerAvailable } = require('./designer');
const { WorldKnowledge } = require('./world-knowledge');
const { DAY } = require('./day');
const { setAside, isSetAside, attemptsFor } = require('./progress');
const { planCatalog } = require('./knowledge');
const { runGoal, runIdle, createSurvival } = require('./work');
const { Task } = require('./skills');
const { parseAddress, chatNames, clarificationReply, CLARIFY_MS } = require('./chat-address');
const { createReactiveWait } = require('./reactive-wait');
const { createHandoff } = require('./handoff');
const { createGuide } = require('./guide');
const stayClose = require('./stay-close');
const { splitLocation, resolveLocation, discoveryAt } = require('./work-site');
const { compatibilityPlugin } = require('./compatibility');
const { requestedCommand, createCommandAccess } = require('./commands');
const { classifyCommand } = require('./command-classifier');
const { recordDeath, observeAliveInventory } = require('./recovery');
const { statusMessage } = require('./status');
const { bundleSummary } = require('./item-bundle');
const { friendlyProblem, intakeProblem, recoveryHint, quietRepeats, thinking } = require('./speech');
const { withRequestSignal } = require('./typesafe');
const { suspendPrevious, resumeSaved, waitingCleared } = require('./suspended-tasks');
const { CompanionMemory, position } = require('./memory');
const { BuildRegistry, resolveBuildContinuation } = require('./builds');
const { nextDreamRequest, shouldLaunchDream, DREAMS, FAILED_LAUNCH_MS, dreamTitle, dreamReport, noteCustomAttempt, customVerdict } = require('./dream');
const { immediateThreat } = require('./danger');
const { Ledger, withRun, appendSummary } = require('./ledger');

// The planner's verdict on a request, before any work starts: an error
// when no survival method exists for something asked for, otherwise null.
// Only that verdict: a plan that fails for want of a tool or a place is
// work, and runGoal finds its way round those.
function unworkable(bot, spec) {
  if (bot.game?.gameMode !== 'survival' || !['obtain', 'craft', 'bundle'].includes(spec.kind)) return null;
  const wanted = spec.kind === 'bundle' ? (spec.tasks || []).map(t => [t.item, t.count]) : [[spec.item, spec.count]];
  const stock = {};
  for (const item of bot.inventory.items()) stock[item.name] = (stock[item.name] || 0) + item.count;
  for (const [item, count] of wanted) {
    if (!item) continue;
    try { planCatalog(bot.registry, item, count || 1, stock); }
    catch (err) { if (err.name === 'PlanError' && /No supported survival acquisition/.test(err.message)) return err; }
  }
  return null;
}

function createSession(config, client, { stateDirectory = path.join(__dirname, '..', '.bot-state'), recorder,
  runLedger = path.join(stateDirectory, 'run-ledger.md') } = {}) {
  let ended = false, spawned = false, resolveClosed;
  const connectedAt = Date.now();
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const bot = mineflayer.createBot({ ...config, respawn: false });
  global.__jevBot = bot;
  // The time of day from the Overworld's own clock, not the End's (world-clock.js).
  require('./world-clock').install(bot);
  // The damage types by index, from the registry the server sends before
  // login, for the flight record's damage frames (recorder/observer.js).
  bot._damageTypeNames = [];
  // Freezing, from the server's own word: powder snow has no collision
  // box, and a bot standing in it was not always seen to be (mid-202-f
  // froze to death at y 121 with the way out tried once, note 308).
  // Standing in fire, the same way (vitals.js inFire): mid-229-g burned from
  // eleven health to none in a fire a ghast's fireball lit (note 340).
  // The bot's own hit on a neutral of a group angers the group (anger.js,
  // note 703).
  require('./anger').install(bot);
  try { require('./drop-memory').install(bot); } catch (_) { /* not remembered */ }
  try { require('./blaze-fight').install(bot); } catch (_) { /* not recorded */ }
  bot._client.on('damage_event', packet => {
    if (!bot.entity || packet.entityId !== bot.entity.id) return;
    const type = bot._damageTypeNames?.[packet.sourceTypeId];
    if (type === 'freeze') bot._freezingAt = Date.now();
    if (type === 'in_fire') bot._inFireAt = Date.now();
    // What each lights the bot for, the longer kept (combat-estimate
    // burnLeft): the fire on the bot is in every stance's figures (note 548).
    const lights = require('./combat-estimate').FIRE_SECONDS[type];
    if (lights) bot._alightUntil = Math.max(bot._alightUntil || 0, Date.now() + lights * 1000);
    // A warden's boom, counted for the pocket's question (survival.js
    // wardenSays): mid-230-n was boomed through its pocket's wall and asked
    // again told nothing of it (note 412).
    if (type === 'sonic_boom') (bot._sonicBooms ||= []).push(Date.now());
    // A mob's blow at arm's length (not its shot): the body's own ways that
    // take seconds of footwork stop at it (cauldron.js struck, note 657).
    if (type === 'mob_attack' || type === 'mob_attack_no_aggro') { bot._blowAt = Date.now(); bot._blowBy = bot.entities?.[packet.sourceCauseId - 1]?.name || null; }
  });
  // When each of the bot's own effects came: mineflayer keeps the length the
  // server sent, and what is left of a poison or a wither is that less the
  // time since (combat-estimate effectLeft; note 542).
  bot.on('entityEffect', (entity, effect) => { if (entity === bot.entity && effect) effect.at = Date.now(); });
  // Each shriek of a sculk shrieker darkens the players about it: counted
  // as the warnings toward a warden (sculk.js).
  bot.on('entityEffect', (entity, effect) => {
    if (entity !== bot.entity || effect?.id !== bot.registry?.effectsByName?.darkness?.id) return;
    const shrieks = bot._shrieks ||= [];
    if (!shrieks.length || Date.now() - shrieks.at(-1) > 5000) shrieks.push(Date.now());
  });
  bot._client.on('registry_data', packet => { if (/damage_type/.test(String(packet?.id || '')) && Array.isArray(packet.entries)) packet.entries.forEach((e, i) => { bot._damageTypeNames[i] = String(e.key || e.id || '').replace('minecraft:', ''); }); });
  bot.on('physicsTick', () => { if (!ended) observeAliveInventory(bot); });
  bot.on('handover', event => { if (!ended) console.log(JSON.stringify({ handover: event })); });
  for (const event of ['recovery_advice', 'recovery_result']) bot.on(event, data => {
    if (ended) return;
    const record = data.record || data;
    console.log(JSON.stringify({ [event]: { status: record.status, source: record.source, model: record.model, diagnosis: record.diagnosis,
      jev: record.jev?.judgment, steps: record.steps, outcome: data.outcome || record.outcome, latencyMs: record.latencyMs, usage: record.usage } }));
  });
  bot.loadPlugin(compatibilityPlugin);
  bot.loadPlugin(pathfinder);
  // Every goal the pathfinder is given, by any route (goto calls setGoal),
  // is made whole first: one without isValid crashed the process four
  // times. A plugin, so it is injected after the pathfinder's: wrapped here
  // directly it found no pathfinder yet (plugins inject a tick later) and
  // wrapped nothing.
  bot.loadPlugin(require('./skills').goalGuardPlugin);
  bot.loadPlugin(require('./skills').digGuardPlugin);
  bot.loadPlugin(require('./labels').openGuardPlugin);
  // After the guard, so a dig it refuses never asks the server: a dig is
  // finished only when the server has broken the block (server-truth.js).
  bot.loadPlugin(require('./server-truth').serverTruthPlugin);
  bot.loadPlugin(require('./own-blocks').ownBlocksPlugin);
  // The way in, kept while in the Nether: the walk out with rods goes back
  // along it (walk-out.js, note 762).
  bot.loadPlugin(require('./walk-out').wayInPlugin);
  // The footing of the last three minutes, the retreat's way back (note 793).
  bot.loadPlugin(require('./way-back').plugin);
  bot.loadPlugin(require('./gaze').gazePlugin);
  bot.loadPlugin(require('./riders').ridersPlugin);
  // A window click the window refuses ("invalid operation") is logged with
  // the click and the window, so the craft that made it can be named: it
  // failed crafts twenty and more times a trial in mid-215-c and mid-220-a
  // with no more said than that (2026-09-26).
  bot.once('inject_allowed', () => {
    const click = bot.clickWindow;
    if (typeof click !== 'function') return;
    bot.clickWindow = async (slot, mouseButton, mode, ...rest) => {
      try { return await click.call(bot, slot, mouseButton, mode, ...rest); }
      catch (err) {
        if (/invalid operation/.test(err?.message || '')) {
          const w = bot.currentWindow || bot.inventory;
          console.log(`[window] invalid click ${JSON.stringify({ slot, mouseButton, mode, window: w?.type, inventoryEnd: w?.inventoryEnd, selected: w?.selectedItem?.name ?? null })} ${String(err.stack || '').split('\n').slice(1, 6).map(l => l.trim()).join(' | ')}`);
        }
        throw err;
      }
    };
  });
  // Mineflayer injects its own chat plugin after createBot, which would
  // overwrite a wrapper installed now; the filter goes on once chat exists.
  bot.once('spawn', () => { noteOwnLines(); quietRepeats(bot); });
  // A world search that holds the event loop, said by its caller (note 772).
  bot.once('spawn', () => { try { require('./slow-calls').install(bot); } catch (_) { /* not watched */ } });
  // A new build is taken at a quiet moment (quiet-restart.js).
  if (!process.env.JEV_NO_QUIET_RESTART) bot.once('spawn', () => require('./quiet-restart').watchRestartRequest(bot, path.join(stateDirectory, 'restart-requested'), { startedAt: require('./quiet-restart').PROCESS_STARTED, port: config.port }));
  if (!process.env.JEV_NO_QUIET_RESTART) bot.once('spawn', () => require('./quiet-restart').watchStuck(bot, { port: config.port }));
  const identity = `${config.host}-${config.port}-${config.username}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const commandLog = path.join(stateDirectory, `${identity}-commands.jsonl`);
  bot._client.on('declare_commands', tree => {
    if (ended) return;
    bot.commandTree = tree;
    fs.mkdirSync(path.dirname(commandLog), { recursive: true });
    fs.writeFileSync(path.join(stateDirectory, `${identity}-command-tree.json`), JSON.stringify(tree));
  });
  let commandAccess;
  bot.loadPlugin(() => { commandAccess = createCommandAccess(bot, {
    users: (process.env.MC_COMMAND_USERS || '').split(',').map(name => name.trim()).filter(Boolean),
    audit: event => { fs.mkdirSync(path.dirname(commandLog), { recursive: true }); fs.appendFileSync(commandLog, JSON.stringify(event) + '\n'); },
  }); });
  const store = new GoalStore(path.join(stateDirectory, `${identity}.json`));
  const memoryIdentity = process.env.MC_WORLD_ID ? `${identity}-${process.env.MC_WORLD_ID.replace(/[^a-zA-Z0-9_-]/g, '_')}` : identity;
  // The base, its bed and the shelters are places in one world. Kept per
  // server, a new world on the same port inherited them, and the bot walked
  // home at dusk to a bed that was never there.
  const survivalStore = new GoalStore(path.join(stateDirectory, `${memoryIdentity}-survival.json`));
  const idleStore = new GoalStore(path.join(stateDirectory, `${identity}-idle.json`));
  const memorySeed = store.read(), needsMemoryId = memorySeed && !memorySeed.memoryId;
  const memory = new CompanionMemory(path.join(stateDirectory, `${memoryIdentity}-memory.json`), {
    seedGoal: memorySeed, seedResources: { ...idleStore.read()?.resourceMemory, ...memorySeed?.resourceMemory },
  });
  if (needsMemoryId && memorySeed.memoryId) store.save(memorySeed);
  bot.companionMemory = memory;
  // Structures outlive the goal that built them, so this store is keyed to the
  // world rather than the request and is shared by every later build.
  const builds = new BuildRegistry(path.join(stateDirectory, `${memoryIdentity}-builds.json`));
  bot.buildRegistry = builds;
  // What the bot sees players lay (player-build.js): their dirt and stone told from the ground's, kept per world.
  bot.placedLog = new (require('./player-build').PlacedLog)(path.join(stateDirectory, `${memoryIdentity}-placed.json`));
  bot.labels = new (require('./labels').Labels)(path.join(stateDirectory, `${memoryIdentity}-labels.json`));
  // The saplings owed where trees were cut (tree-felling.js), kept across restarts.
  bot._replantFile = path.join(stateDirectory, `${memoryIdentity}-replant.json`);
  bot.loadPlugin(require('./player-build').placedPlugin);
  // The dream: what the bot works toward when nobody has asked for
  // anything. Kept per world, beside the builds it produces.
  const dreamStore = new GoalStore(path.join(stateDirectory, `${memoryIdentity}-dream.json`));
  const saveDream = standing => { if (!ended) dreamStore.save({ version: 1, ...standing }); };
  // Portals, villages, the End portal and the run's progress: kept per
  // world and handed to every goal, not left on the goal that found them.
  // Seeded from the old per-server goal stores only where they can be this
  // world's: with a world id they may be another world's, and a new world
  // began with the old one's portals and game progress.
  const world = new WorldKnowledge(new GoalStore(path.join(stateDirectory, `${memoryIdentity}-world.json`)),
    { seedFrom: memoryIdentity === identity ? [store.read(), idleStore.read()] : [] });
  // The cost ledger: every Jev call charged to the request or dream it
  // served, kept per world, and summarized to run-ledger.md in the state directory when a run
  // ends. The client feeds it; the session only says which run is paying.
  const ledger = new Ledger(path.join(stateDirectory, `${memoryIdentity}-ledger.json`), {
    age: () => bot.time?.age, onClose: run => { if (runLedger) appendSummary(runLedger, run); } });
  client.ledger = ledger;
  // Whatever is active pays for the calls made on its behalf; with nothing
  // active, an idle bot that has a dream is still that dream's cost.
  const routed = withRun(client, () => active?.goal.ledgerRun ?? dreamStore.read()?.ledgerRun);
  const dreamName = (key, text) => `dream · ${key === 'custom' ? text : DREAMS[key].title}`;
  // The dream's run in the ledger. A standing from before the ledger
  // existed gets one now, dated from when the dream was given.
  function dreamRun(standing) {
    if (!standing?.dream || standing.satisfiedAt || ended) return standing?.ledgerRun;
    const run = ledger.open({ id: standing.ledgerRun, kind: 'dream', name: dreamName(standing.dream, standing.text), startedAt: standing.setAt });
    if (standing.ledgerRun !== run.id) { standing.ledgerRun = run.id; saveDream(standing); }
    return run.id;
  }
  dreamRun(dreamStore.read());
  const readyForDream = () => bot.game?.gameMode === 'creative' ||
    ((bot.game?.dimension !== 'minecraft:overworld' && bot.game?.dimension !== 'overworld' || (bot.time?.timeOfDay ?? 0) < DAY.DUSK) &&
      (bot.health ?? 20) >= 14 && (bot.food ?? 20) >= 12 && !immediateThreat(bot));
  let launchingDream = false;
  // JEV_START=tools: whether this world is new to the bot, from its survival file before anything is saved to it.
  const firstJoin = !fs.existsSync(survivalStore.file) && !(memoryIdentity === identity && store.read()?.survival);
  // The old goal's copy only where it can be this world's: with a world id
  // the goal store is still per server.
  const survival = createSurvival(bot, { state: survivalStore.read() || (memoryIdentity === identity ? store.read()?.survival : undefined), client: routed });
  // The stance kept from the last connection is not this one's (recovery.js newConnection).
  { const dropped = require('./recovery').newConnection(survival.state); if (dropped.length) console.log(`[join] the last connection's fight left behind: ${dropped.join(', ')}`); }
  // JEV_IDLE=wait: between requests, wait where it stands and only defend itself.
  const waitMode = process.env.JEV_IDLE === 'wait';
  console.log(`[company] at night: ${require('./company').nightMode() ? `up while a player is within ${require('./company').STAY_UP} blocks, sheltering when alone (JEV_NIGHT=company)` : 'sheltering from dusk to dawn (JEV_NIGHT is not set)'}`);
  // Who hurt which player, for a guard (guard.js): from the server's damage events.
  require('./guard').watch(bot);
  const reactiveWait = waitMode ? createReactiveWait({ bot, survival, save: () => saveSurvival(),
    isReady: () => ready && !ended, isBusy: () => Boolean(active) || relaunching || launchingDream }) : null;
  // To bed when the players go (bedtime.js): the waiting bot's own move, like the reactive wait, and ended by whatever that would answer.
  const bedtime = waitMode ? require('./bedtime').createBedtime({ bot, save: () => saveSurvival(),
    isReady: () => ready && !ended, isBusy: () => Boolean(active) || relaunching || launchingDream,
    trouble: () => !!require('./reactive-wait').emergency(bot) }) : null;
  if (!survivalStore.read() && store.read()?.status === 'cancelled') survival.state.paused = true;
  const saveSurvival = () => { if (!ended) { survival.state.version = 1; survivalStore.save(survival.state); } };
  // JEV_START=tools: the first tools owed to a world new to the bot, decided once a world (first-tools.js).
  { const owed = require('./first-tools').onConnect(survival.state, { firstJoin });
    if (owed) { console.log(owed.skipped ? `[mission] no first tools: ${owed.skipped}` : '[mission] first tools owed: this world is new to me'); saveSurvival(); } }
  const locations = require('./home-location').attachHomeLocation(bot, survival, memory, builds, saveSurvival);
  bot.homeLocation = locations;
  const saveGoal = goal => { if (!ended) { memory.recordGoal(goal, bot); world.harvest(goal); store.save(goal); } };
  const workStore = { save: goal => { saveGoal(goal); saveSurvival(); } };
  let active = null;
  const noteOwnPlacement = block => {
    // Laid while idle or on a walk beside a building set aside, it is that building's to clear as well.
    const goal = active?.goal?.kind === 'build' ? active.goal : !active || active.idle ? store.read() : active.goal;
    if (goal && !['complete','failed'].includes(goal.status) && require('./construction-access').recordBuildPlacement(goal, block)) saveGoal(goal);
  };
  bot.on('blockPlaced', (_old, block) => noteOwnPlacement(block));
  bot.on('confirmedBuildScaffold', noteOwnPlacement);
  // A goal going again after a threat escaped its loop (launch's catch).
  let relaunching = false;
  let pending = Promise.resolve();
  let generation = 0;
  let requestController = new AbortController();
  // What the bot has in hand changed: a stop, a death, a new job. A shot answer asked before it is dropped (shot-reflex.js ask).
  const nextActivity = () => { bot._requestActivityEpoch = (bot._requestActivityEpoch || 0) + 1; };
  function invalidateRequests() {
    generation++;
    nextActivity();
    requestController.abort(new Error('Player request interrupted'));
    requestController = new AbortController();
  }
  let ready = false;
  let pendingRequests = 0;
  let observation;

  async function stop(status = 'cancelled') {
    if (status === 'cancelled') { survival.state.paused = true; saveSurvival(); guideQueue = null; require('./company').letGo(bot); }
    if (!active) {
      if (status === 'cancelled') {
        const saved = store.read();
        if (saved && ['pending', 'running', 'recovering'].includes(saved.status)) { saved.status = 'cancelled'; saveGoal(saved); }
      }
      await reactiveWait?.cancel(); await bedtime?.cancel();
      return;
    }
    active.task.cancel();
    // A walk back after monsters (launchBack) that is stopped or replaced is over, not kept for a later "resume"; so is
    // the bot's own errand for a sword (keep-armed.js).
    if (!active.idle) {
      // Ended by the bot itself (the idle timer: too long, or night) is not a player's stop.
      if (active.goal.weaponErrand && !active.goal.errandEnded) active.goal.errandStopped = status;
      active.goal.status = active.goal.back || active.goal.weaponErrand ? 'complete' : status; workStore.save(active.goal);
    }
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.stopDigging();
    bot.deactivateItem();
    await active.promise;
  }

  function launch(goal) {
    nextActivity();
    reactiveWait?.cancel().catch(() => {}); bedtime?.cancel().catch(() => {});
    // A request ends the scare a walk back was owed for (company.js): the player has said what comes next.
    if (!goal.back && !goal.weaponErrand) require('./company').letGo(bot);
    world.hydrate(goal);
    memory.bind(goal);
    goal.memoryContext = memory.context(goal.from);
    // A walk back after monsters is not a player's word: a bot told to stop is as stopped after it as before. Nor is
    // the bot's own errand for a sword (keep-armed.js).
    if (!goal.back && !goal.weaponErrand) { survival.state.paused = false; delete survival.state.idleBlocked; delete survival.state.deathBlocked; saveSurvival(); }
    // The goal's calls are charged to its run: the dream's when the dream
    // launched it, otherwise the request's own, picked back up by id.
    if (goal.dream) goal.ledgerRun = dreamRun(dreamStore.read()) ?? goal.ledgerRun;
    else goal.ledgerRun = ledger.open({ id: goal.ledgerRun, kind: 'request', name: goal.request, startedAt: goal.createdAt }).id;
    const task = new Task(goal.kind, goal.request);
    const session = { task, goal };
    active = session;
    session.promise = runGoal(bot, task, goal, workStore, {
      decisionClient: routed, survival,
      onStep: g => {
        // The same step with the same last decision is written once in two seconds, not at every pass (note 2686): a
        // loop spinning twenty passes a second wrote its 30 KB status line each pass, and full-250 (25588, 2026-10-31
        // 07:3x to 07:55Z) grew a 53 MB log in 25 minutes in a stand-off with a creeper, about a megabyte a minute.
        const line = JSON.stringify({ status: g.status, step: g.step, decision: g.decisions?.at(-1), position: bot.entity.position, error: g.lastError });
        const key = JSON.stringify([g.status, g.step, g.decisions?.at(-1)?.at, g.lastError]), at = Date.now();
        if (key !== session.lastStepKey || at - (session.lastStepAt || 0) >= 2000) { console.log(line); session.lastStepKey = key; session.lastStepAt = at; }
        observation?.sample('step', undefined, g);
        // Every step change, not only the one a second the supervisor sees:
        // mid-110-f's staircase and retreat traded seven times in eight
        // seconds, between its looks, and the audit caught what it did not.
        try { if (bot.game?.gameMode !== 'creative') require('./stillness').flipWatch(bot, g); } catch (_) { /* a look missed */ }
      },
    }).catch(err => {
      // A threat or a breath that escaped the goal's own loop is the moment,
      // not the goal: the dream run was parked "blocked" on "Threat nearby:
      // something unseen at 0 blocks" and stood idle for sixteen hours
      // (2026-09-25). It goes again in a few seconds, from where it is.
      // Five in a minute is not a moment, and is parked as before.
      const recent = (goal.relaunches || []).filter(t => Date.now() - t < 60000);
      if (['NeedsSafety', 'NeedsAir'].includes(err.name) && recent.length < 5) {
        goal.relaunches = [...recent, Date.now()]; goal.lastError = err.message; saveGoal(goal);
        observation?.sample('error', { message: err.message, relaunch: true }, goal);
        session.relaunch = true;
        return;
      }
      // A walk back after monsters that failed is the bot's own errand: nothing is said, nothing is left to resume, and
      // it is tried again later while the scare holds (company.js backDue).
      // The bot's own errand for a sword that failed: nothing said, nothing left to resume, rested (keep-armed.js).
      if (err.name !== 'Cancelled' && goal.weaponErrand) {
        goal.status = 'complete'; goal.errandFailed = err.message; saveGoal(goal);
        observation?.sample('error', { message: err.message, weaponErrand: true }, goal);
        console.log(`${goal.mission ? '[mission] the step failed' : '[weapon] the errand failed'}: ${err.message}`);
      } else if (err.name !== 'Cancelled' && goal.back) {
        goal.status = 'complete'; goal.backFailed = err.message; saveGoal(goal);
        observation?.sample('error', { message: err.message, back: true }, goal);
        console.log(`[company] the walk back to ${goal.target} failed: ${err.message}`);
      } else if (err.name !== 'Cancelled') {
        goal.status = 'blocked'; goal.lastError = err.message; saveGoal(goal);
        observation?.sample('error', { message: err.message }, goal);
        console.error(err); bot.chat(`${friendlyProblem(err)} ${recoveryHint(err)}`);
        // What the player may try instead: the look after it may offer it to them (JEV_GUIDE_SPEAK=unasked; lookOver).
        lookFor++; lookAbout = goal.from || null;
      }
    }).finally(() => {
      if (active === session) active = null;
      // Arrived: the scare is over. The player walking off again is not followed.
      if (goal.back && goal.status === 'complete' && !goal.backFailed && !session.relaunch) require('./company').letGo(bot);
      // The errand for a sword, over. With no sword ready it rests, and counts as one that came to nothing unless a
      // player stopped it or asked for something else. Then back to the player it waited with, as after monsters,
      // whatever came of it; not when a player stopped or replaced it: they have said what comes next. A step of the
      // first tools has its own (missionStepOver).
      if (goal.weaponErrand && goal.mission && !session.relaunch) missionStepOver(goal);
      else if (goal.weaponErrand && !session.relaunch) {
        const arms = require('./keep-armed');
        if (arms.ready(bot)) { armsFailed = 0; attemptsFor(survival).clear('weapon_errand', 'sword'); saveSurvival(); }
        else {
          if (!goal.errandStopped) armsFailed++;
          setAside(survival, 'weapon_errand', 'sword', String(goal.errandFailed || goal.errandEnded || goal.errandStopped || 'over with no sword ready').slice(0, 160), arms.ERRAND_REST_MS); saveSurvival();
        }
        if (goal.returnTo && !goal.errandStopped) require('./company').oweBack(bot, goal.returnTo);
      }
      if (session.relaunch) {
        relaunching = true;
        setTimeout(() => { relaunching = false; if (!ended && !active) launch(goal); }, 1500);
        return;
      }
      if (!goal.dream && ['complete', 'blocked'].includes(goal.status)) ledger.close(goal.ledgerRun, goal.status);
      // An errand done with work still set aside under it: said how to get the bot back on that work (agenda.js).
      if (goal.status === 'complete' && !ended && !guideQueue?.rest?.length) {
        const line = require('./agenda').reminder(goal, { username: bot.username });
        if (line) bot.chat(line);
      }
      // A custom dream is one request: done when it completes.
      if (goal.dream === 'custom' && goal.status === 'complete' && !ended) settleCustom(dreamStore.read(), goal);
    });
  }

  // A custom dream ends when its request completes, and is set aside after
  // too many attempts that came to nothing: said in chat, never retried forever.
  function settleCustom(standing, lastGoal) {
    const verdict = customVerdict(standing, lastGoal);
    if (!verdict || ended) return false;
    if (verdict === 'done') {
      const { ledgerRun, ...rest } = standing;
      saveDream({ ...rest, satisfiedAt: new Date().toISOString() });
      if (ledgerRun) ledger.close(ledgerRun, 'satisfied');
      bot.chat(`I did my dream: ${standing.text}. Tell me to chase it again, or give me a new dream, if you want more.`);
    } else {
      saveDream({ ...standing, paused: true, pausedBy: 'failures', pausedAt: new Date().toISOString() });
      bot.chat(`I could not do my dream (${standing.text}) after ${standing.failures} tries, so I am setting it aside. Say "chase your dream" to try again.`);
    }
    return true;
  }
  // The custom dream's text, read as a chat request would be, with the world as it is.
  function interpretDreamText(standing, runId) {
    const from = standing.setBy, requestClient = withRun(client, runId);
    const speaker = bot.players[from]?.entity?.position;
    return interpret(requestClient, `${bot.username} ${standing.text}`, from, bot.username, {
      registry: bot.registry, players: Object.keys(bot.players),
      speakerPosition: position(speaker), botPosition: position(bot.entity?.position), dimension: bot.game.dimension,
      memory: { ...memory.context(from), found: require('./exploration').foundEntries(world.known) },
      builds: builds.describe(bot, bot.entity.position, bot.game.dimension),
      continueBuilds: (request, candidates) => resolveBuildContinuation(requestClient, request, candidates, { speaker: position(speaker) }),
      inventory: Object.fromEntries(bot.inventory.items().map(item => [item.name, item.count])),
    });
  }

  // Hand the dream its next request, as if a player had typed it. Jev
  // chooses the milestone from what code enumerates; a failure to choose or
  // an unusable answer falls back to ordinary idling until the cool-down ends.
  async function launchDream(standing) {
    launchingDream = true;
    try {
      if (standing.dream === 'custom') {
        noteCustomAttempt(standing, store.read()); saveDream(standing);
        if (settleCustom(standing, store.read())) return;
      }
      const structures = builds.describe(bot, bot.entity.position, bot.game.dimension);
      const runId = dreamRun(standing);
      const next = await nextDreamRequest(withRun(client, runId), standing, { structures, shelf: require('./schematic-library').library(bot.registry), designer: designerAvailable(bot),
        interpretRequest: () => interpretDreamText(standing, runId) });
      if (ended || active) return;
      if (standing.dream === 'custom') {
        if (next.kind === 'house' && designerAvailable(bot)) next.kind = 'build';
        const impossible = unworkable(bot, next);
        if (impossible) throw Object.assign(new Error(`My dream "${standing.text}" cannot be done here: ${impossible.message}`), { name: 'DreamRequest' });
      }
      standing.lastAttemptAt = Date.now();
      if (!next || next.done) {
        standing.satisfiedAt = new Date().toISOString(); standing.lastScore = next?.villageScore; delete standing.ledgerRun; saveDream(standing);
        ledger.close(runId, 'satisfied');
        bot.chat(`I think my dream to ${dreamTitle(standing)} is done for now. Tell me to chase it again if you want more.`);
        return;
      }
      attemptsFor(survival).clear('dream_launch', standing.dream); saveDream(standing);
      const goal = { ...next, ledgerRun: runId, version: 1, status: 'pending', createdAt: new Date().toISOString(), suspendedTasks: suspendPrevious(store.read()),
        requesterPosition: null, initialInventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })) };
      saveGoal(goal);
      const firstRung = next.kind === 'win' ? require('./game-progress').nextGameStage(bot, goal).phase?.replaceAll('_', ' ') : null;
      bot.chat(`Nothing needs me, so I'm chasing my dream to ${dreamTitle(standing)}${next.villageScore !== undefined && next.villageScore !== null ? ` (the village is ${Math.round(next.villageScore * 100 / 3)}% there)` : ''}${firstRung ? `. First: ${firstRung}.` : `: ${next.request}.`}`);
      launch(goal);
    } catch (err) {
      console.error('[dream]', err.message);
      standing.lastAttemptAt = Date.now();
      // Only a text that would not come out as a doable request counts against
      // a custom dream; Jev being unreachable is not the dream's failure.
      const unusable = standing.dream === 'custom' && err.name === 'DreamRequest';
      if (unusable) standing.failures = (standing.failures || 0) + 1;
      saveDream(standing);
      if (unusable) settleCustom(standing, store.read());
      setAside(survival, 'dream_launch', standing.dream, err, FAILED_LAUNCH_MS); saveSurvival();
    } finally { launchingDream = false; }
  }

  // Back to the player the waiting bot stood with, once the monsters it gave ground to are gone (company.js
  // backDue): an ordinary "come", made by rule and not through the request interpreter, said once a scare.
  function launchBack(scare) {
    const seen = bot.players[scare.with]?.entity?.position;
    scare.tries++; scare.triedAt = Date.now();
    const after = typeof scare.errand === 'string' ? scare.errand : scare.errand ? 'the errand for a sword' : 'the monsters';
    const goal = { kind: 'come', back: true, request: `come back after ${after}`, from: scare.with, target: scare.with,
      version: 1, status: 'pending', createdAt: new Date().toISOString(), suspendedTasks: suspendPrevious(store.read()),
      requesterPosition: seen ? { ...seen } : { ...scare.position },
      initialInventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })) };
    saveGoal(goal);
    console.log(`[company] back to ${scare.with} after ${after}: try ${scare.tries}, ${seen ? `${Math.round(seen.distanceTo(bot.entity.position))} blocks off` : 'out of view, to where they were last seen'}`);
    if (!scare.said) { scare.said = true; bot.chat(`Coming back to you, ${scare.with}.`); }
    launch(goal);
  }

  // JEV_WEAPON=keep: the waiting bot's errand for a sword (keep-armed.js), looked at every five seconds.
  function errandNow(dark) {
    const opts = { survival, dark, paused: !!survival.state.paused, isSetAside, threatened: require('./danger').threats(bot, 16).some(t => t.visible) };
    // JEV_START=tools: while the first tools are under way they are the errand, the sword among them (first-tools.js).
    const tools = require('./first-tools');
    missionCheck();
    if (tools.underway(survival.state)) return tools.due(bot, opts);
    return require('./keep-armed').errandDue(bot, { ...opts, failures: armsFailed });
  }
  // JEV_START=tools: begun once the world's age is known; done once every step is carried or left out.
  function missionCheck() {
    const tools = require('./first-tools'), state = survival.state, began = tools.begin(state, bot);
    if (began) { console.log(began === 'begun' ? `[mission] first tools begun: the world is ${state.firstTools.age} ticks old` : `[mission] no first tools: ${state.firstTools.skipped}`); saveSurvival(); }
    if (tools.underway(state) && !tools.left(bot, state).length) missionDone(null);
  }
  // All made, or left out: said if a step was begun, and back to the player it was with.
  function missionDone(returnTo) {
    const tools = require('./first-tools'), ft = survival.state.firstTools, short = tools.givenUp(bot, survival.state);
    ft.done = new Date().toISOString(); saveSurvival();
    const line = ft.said ? tools.doneLine(bot, survival.state) : null, to = returnTo || ft.returnTo;
    console.log(`[mission] first tools done${short.length ? ', all but ' + short.join(', ') : ''}${line && to ? ', then back to ' + to.name : ''}`);
    if (line) bot.chat(line);
    if (line && to) { const scare = require('./company').oweBack(bot, to); if (scare) scare.errand = 'the first tools'; }
  }
  // A step over: one more that came to nothing unless it was made, or a player stopped it or asked for something else,
  // and rested two minutes. The last one: said, and back to the player. One the night ended: back to the player now,
  // the rest by day.
  function missionStepOver(goal) {
    const tools = require('./first-tools'), ft = survival.state.firstTools;
    if (!ft) return;
    if (!tools.covered(bot, goal.item) && !goal.errandStopped) {
      ft.failed = { ...ft.failed, [goal.item]: (ft.failed?.[goal.item] || 0) + 1 };
      const why = String(goal.errandFailed || goal.errandEnded || 'over without it').slice(0, 160);
      setAside(survival, 'first_tools', goal.item, why, tools.STEP_REST_MS);
      console.log(`[mission] no ${goal.item.replaceAll('_', ' ')} (${ft.failed[goal.item]} of ${tools.STEP_TRIES}): ${why}`);
    }
    saveSurvival();
    if (tools.underway(survival.state) && !tools.left(bot, survival.state).length) missionDone(goal.returnTo);
    else if (goal.errandEnded === 'night is near' && goal.returnTo && !goal.errandStopped) {
      const scare = require('./company').oweBack(bot, goal.returnTo); if (scare) scare.errand = 'the first tools';
    }
  }
  function armsDue(now, dark) {
    if (now - armsCheckedAt < 5000 || guideQueue?.rest?.length) return null;
    armsCheckedAt = now;
    try { return errandNow(dark); } catch (err) { console.error('[weapon] the errand check:', err.message); return null; }
  }

  // The errand itself: read as the request "craft a stone sword" would be (the dream's way), and marked as the bot's
  // own: nobody's work to ask about (handoff.js), quiet when it fails, ended by "stop" or by any request, rested after
  // (keep-armed.js), and followed by a walk back to the player it waited with (company.js oweBack).
  async function launchArms(due) {
    launchingArms = true;
    const arms = require('./keep-armed');
    let run = null;
    try {
      const company = require('./company');
      run = ledger.open({ kind: 'request', name: 'own errand: ' + arms.errandRequest(due.item) });
      const seen = bot._company, now = Date.now();
      const withNow = seen && now - seen.at <= company.WITH_MS ? { name: seen.name, position: { ...seen.position } } : null;
      // A step of the first tools: back, when all are made, to the player it was with when they began or since.
      const ft = due.mission ? survival.state.firstTools : null;
      const returnTo = ft ? withNow || ft.returnTo || null : withNow;
      const from = returnTo?.name || bot.username;
      const spec = await interpret(withRun(client, run.id), bot.username + ' ' + arms.errandRequest(due.item), from, bot.username, {
        registry: bot.registry, players: Object.keys(bot.players),
        speakerPosition: position(bot.players[from]?.entity?.position), botPosition: position(bot.entity?.position), dimension: bot.game.dimension,
        memory: { ...memory.context(from), found: require('./exploration').foundEntries(world.known) },
        inventory: Object.fromEntries(bot.inventory.items().map(item => [item.name, item.count])),
      });
      // Still due once the request is read: not stopped meanwhile ("stop" pauses with nothing active), not armed, not dark.
      const still = ended || active || pendingRequests ? null : errandNow(company.darkNow(bot));
      // Not due after all: no other model call for a minute, should what stopped it come and go.
      if (!still || still.item !== due.item) { armsCheckedAt = Date.now() + 60000; ledger.close(run.id, 'replaced'); return; }
      if (!spec || !['craft', 'obtain'].includes(spec.kind) || spec.item !== due.item)
        throw new Error('read as ' + (spec?.kind || 'nothing') + (spec?.item ? ' ' + spec.item : '') + ', not ' + due.item);
      // The total wanted, as at work (workSword): one sword more than is carried, or a worn one would be enough.
      const goal = { ...spec, count: arms.carried(bot, due.item) + 1, deliver: false, weaponErrand: true, ...(ft ? { mission: true } : {}), errandPockets: !!due.pockets, returnTo, request: 'make ' + arms.a(due.item) + (ft ? ' (my first tools)' : ' to carry'),
        errandUntil: Date.now() + arms.ERRAND_MS, ledgerRun: run.id, version: 1, status: 'pending', createdAt: new Date().toISOString(),
        suspendedTasks: suspendPrevious(store.read()), requesterPosition: null,
        initialInventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })) };
      saveGoal(goal);
      if (ft) {
        const tools = require('./first-tools');
        console.log('[mission] step: ' + goal.request + (due.pockets ? ', from the pockets' : '') + (returnTo ? ', back to ' + returnTo.name + ' when all are made' : ''));
        if (returnTo) ft.returnTo = returnTo;
        if (!ft.said) { ft.said = new Date().toISOString(); bot.chat(tools.startLine(tools.left(bot, survival.state))); }
        saveSurvival();
      } else {
        console.log('[weapon] errand: ' + goal.request + (due.pockets ? ', from the pockets' : '') + (returnTo ? ', then back to ' + returnTo.name : ''));
        bot.chat(arms.errandLine(bot, due.item, { pockets: due.pockets, returnTo }));
      }
      launch(goal);
    } catch (err) {
      if (run) ledger.close(run.id, 'blocked');
      if (due.mission) {
        // One more that came to nothing, as a step that failed (missionStepOver).
        const tools = require('./first-tools'), ft = survival.state.firstTools;
        if (ft) ft.failed = { ...ft.failed, [due.item]: (ft.failed?.[due.item] || 0) + 1 };
        console.log('[mission] the step was not begun: ' + err.message);
        setAside(survival, 'first_tools', due.item, String(err.message).slice(0, 160), tools.STEP_REST_MS); saveSurvival();
      } else {
        console.log('[weapon] the errand was not begun: ' + err.message);
        armsFailed++;
        setAside(survival, 'weapon_errand', 'sword', String(err.message).slice(0, 160), arms.ERRAND_REST_MS); saveSurvival();
      }
    } finally { launchingArms = false; }
  }

  // JEV_GUIDE_SPEAK=unasked, after a request of a player's failed and the chat has been quiet a while: the guide looks
  // over it (guide.js observe) and may offer that player something close to what they wanted, read as any other choice.
  // Never over the players' talk among themselves. A line said to the bot meanwhile has its own answer, and the look's
  // is let go.
  async function lookOver() {
    looking = true; lookFor = 0;
    const asked = lastToBotAt, player = lookAbout;
    try {
      const humans = Object.values(bot.players).map(p => p.username).filter(name => name && name !== bot.username);
      if (!player || !humans.includes(player)) return;
      const out = await guide.observe({ botName: bot.username, status: guideStatus(player), players: humans, player });
      if (!out) { console.log('[observer] nothing to say'); return; }
      if (ended || lastToBotAt !== asked || pendingRequests) return;
      console.log('[observer] ' + JSON.stringify(out.say) + (out.options ? ' -> ' + JSON.stringify(out.options.map(o => o.requests)) : ''));
      observation?.sample('guide', { observer: true, player, say: out.say, ...(out.options && { options: out.options.map(o => ({ label: o.label, requests: o.requests })) }) });
      if (!sayCounted(out.say)) return;
      talkWith.set(player, Date.now());
      if (out.options?.length) clarifying.set(player, { kind: 'guide', options: out.options, until: Date.now() + CLARIFY_MS, at: Date.now(), unasked: true });
    } finally { looking = false; }
  }

  // JEV_GUIDE_SPEAK=unasked: the guide's judge reads a line said without the bot's name against the chat (guide.js
  // judge). Only a clear yes is taken: onYes, or by default the line read again as if said with the name. No, unsure,
  // no answer or no budget left leave it alone, as a line without the name always was.
  function hearOut(data, from, text, onYes = null) {
    const since = toBotAt.get(from) || 0;
    const players = Object.values(bot.players).filter(p => p?.username && p.username !== bot.username)
      .map(p => ({ name: p.username, ...(p.entity && bot.entity && { blocks: p.entity.position.distanceTo(bot.entity.position) }) }));
    guide.judge({ from, text, botName: bot.username, players }).then(verdict => {
      if (ended) return;
      const line = `${from}: ${JSON.stringify(text)}`;
      if (!verdict?.forBot) { console.log(`[hear] ${line} -> left alone (${verdict ? verdict.why || 'not for me' : 'no answer from the judge'})`); return; }
      if ((toBotAt.get(from) || 0) > since) { console.log(`[hear] ${line} -> for me, but ${from} has spoken to me by name since`); return; }
      console.log(`[hear] ${line} -> for me (${verdict.why || 'no reason given'})`);
      observation?.sample('guide', { heard: true, from, said: text, why: verdict.why });
      if (onYes) { onYes(); return; }
      const again = { ...data, plainMessage: `${bot.username} ${text}`, judged: true };
      const kept = notedLines.get(data);
      if (kept) notedLines.set(again, kept);
      onPlayerChat(again);
    }).catch(err => console.error('[hear]', err));
  }

  function launchIdle() {
    bedtime?.cancel().catch(() => {});
    const retained = store.read();
    const standing = dreamStore.read();
    if (standing?.dream && !launchingDream && shouldLaunchDream(standing, retained, { ready: readyForDream(), resting: isSetAside(survival, 'dream_launch', standing.dream) })) { launchDream(standing); return; }
    const goal = { ...(idleStore.read() || {}), version: 1, kind: 'survive', request: 'Stay alive and prepare supplies between player requests',
      retainedRequest: retained?.request, blueprint: retained?.blueprint, survival: survival.state,
      // A dream set aside is not chased by the idle loop either.
      dream: standing?.dream && !standing.satisfiedAt && !standing.paused ? standing.dream : undefined,
      ledgerRun: standing?.dream && !standing.satisfiedAt && !standing.paused ? standing.ledgerRun : undefined };
    world.hydrate(goal);
    memory.bind(goal);
    const task = new Task('survival', goal.request);
    const session = { task, goal, idle: true };
    active = session;
    // The idle loop runs until something else should: a dream whose
    // next request can be launched ends it, and the next tick launches that.
    let checkedAt = 0, launchable = false;
    const until = () => {
      if (Date.now() - checkedAt < 3000) return launchable;
      checkedAt = Date.now();
      const current = dreamStore.read();
      launchable = !!current?.dream && shouldLaunchDream(current, store.read(), { ready: readyForDream(), resting: isSetAside(survival, 'dream_launch', current.dream) });
      return launchable;
    };
    session.promise = runIdle(bot, task, goal, { save: g => { if (!ended) { world.harvest(g); idleStore.save(g); memory.flush(); } saveSurvival(); } }, {
      survival, decisionClient: routed, until,
      onStep: g => { console.log(JSON.stringify({ idle: true, survivalAction: g.survivalAction, decision: g.decisions?.at(-1)?.path, health: bot.health, food: bot.food, position: bot.entity.position, error: g.lastError })); observation?.sample('step', undefined, g); },
    }).catch(err => {
      if (err.name !== 'Cancelled') {
        survival.state.idleBlocked = err.message; saveSurvival();
        observation?.sample('error', { message: err.message }, goal);
        console.error(err); bot.chat(friendlyProblem(err));
      }
    }).finally(() => { if (active === session) active = null; });
  }

  function walkWhileWaiting() {
    const task = new Task('stay_close', 'stay near the player');
    const session = { idle: true, closeWalk: true, goal: { kind: 'stay_close' }, task };
    active = session;
    session.promise = stayClose.regroup(bot, task, require('./skills').navigate, true)
      .catch(err => { if (err.name !== 'Cancelled') console.log('[stay close]', err.message); })
      .finally(() => { if (active === session) active = null; });
  }

  async function resume(revision = generation, options) {
    await reactiveWait?.cancel(); await bedtime?.cancel();
    if (active?.idle) await stop('interrupted');
    // The dream is what the bot does with nobody's work waiting. A player's
    // stopped or replaced request under it comes first; the dream picks up
    // again, knowing what it knew, once that is done.
    if (active?.goal.dream && !options?.currentOnly) {
      const waiting = resumeSaved({ ...active.goal, status: 'replaced' });
      if (waiting && !waiting.dream) await stop('replaced');
    }
    if (revision !== generation || ended) return;
    if (active) { bot.chat('Already working on the saved task.'); return; }
    const current = store.read(), saved = resumeSaved(current, options);
    if (!saved || saved.status === 'complete') {
      survival.state.paused = false; delete survival.state.idleBlocked; delete survival.state.deathBlocked; saveSurvival();
      bot.chat(waitMode ? "I'm back! I'll wait here for your next task and defend myself meanwhile." : "I'm back! I'll look after myself while I wait for your next task."); return;
    }
    delete saved.waitingOn;
    if (saved.kind === 'build' && !saved.design) saved.designAttempts = 0;
    if (saved !== current || options?.say) {
      const agenda = require('./agenda'), them = bot.players[options?.from || saved.from]?.entity?.position;
      bot.chat(`Back to ${saved !== current ? 'your earlier task' : 'it'}: ${agenda.said(saved, bot.username)}${agenda.whereSaid(saved, them)}.`);
    }
    launch(saved);
  }
  // The flight recording: what the bot sees and decides, for the audits.
  observation = recorder?.attach(bot, {
    server: `${config.host}:${config.port}`,
    getGoal: () => active?.goal || store.read() || {},
  });

  // One open question per player, answered within a minute and a half or
  // not at all.
  const clarifying = new Map();

  // A build parked on a block someone else put on its site is taken up
  // again by itself once that block is gone (siteChanged in work.js).
  let waitCheckedAt = 0;
  // JEV_IDLE=wait: when the waiting bot was last in its shelter or in a hole (company.js routine).
  let lastSheltered = 0;
  // JEV_WEAPON=keep: the waiting bot's errand for a sword (keep-armed.js).
  let launchingArms = false, armsCheckedAt = 0, armsFailed = 0;
  const idleTimer = setInterval(() => {
    const now = Date.now();
    // JEV_WEAPON=keep: an errand for a sword is ended after its eight minutes, and one gathering for it with a minute
    // of daylight left; either way the bot then walks back to the player it waited with (keep-armed.js errandOver).
    if (active && !active.idle && active.goal?.weaponErrand) {
      const over = require('./keep-armed').errandOver(active.goal, bot, now);
      if (over) {
        // Said with the daylight left and how far the player is, for the walk back after it.
        const arms = require('./keep-armed'), back = arms.backBlocks(active.goal, bot);
        active.goal.errandEnded = over;
        console.log(`${active.goal.mission ? '[mission] the step was ended' : '[weapon] the errand was ended'}: ${over} (${Math.round(Math.min(arms.dayLeft(bot), 24000) / 20)} s of daylight left; ${back == null ? 'nobody to go back to' : Math.round(back) + ' blocks from ' + active.goal.returnTo.name})`);
        stop('interrupted').catch(console.error);
      }
    }
    if (ready && !pendingRequests && !launchingDream && (!active || active.idle) && now - waitCheckedAt > 5000) {
      waitCheckedAt = now;
      const saved = resumeSaved(store.read());
      if (waitingCleared(bot, saved)) {
        bot.chat(`The ${String(saved.waitingOn.name).replaceAll('_', ' ')} is gone. Back to building!`);
        resume().catch(err => console.error(err));
        return;
      }
    }
    // What the guide asked for next, once the request before it is done; dropped if that one was blocked, stopped or needs an answer.
    if (guideQueue?.rest.length && ready && (!active || active.idle) && !pendingRequests && !relaunching && !launchingDream) {
      const last = store.read();
      if (clarifying.get(guideQueue.from)?.until > now || ['blocked', 'cancelled'].includes(last?.status)) guideQueue = null;
      else if (!last || last.status === 'complete') inject(guideQueue.sender, guideQueue.rest.shift(), guideQueue);
    }
    // JEV_GUIDE_SPEAK=unasked: a look over the chat once a request of a player's has failed and the chat has been quiet
    // for eight seconds. Not over a question still open, a message being read, a request in hand, or the guide's next
    // step for a player (lookOver).
    if (speakUnasked && guide && lookFor && !looking && !guideBusy && !pendingRequests && !guideQueue?.rest?.length && now - lastChatAt > LOOK_QUIET_MS
        && !(active && !active.idle && active.goal && !active.goal.weaponErrand && !active.goal.back && !active.goal.dream)
        && guide.observeReady() && !handoff?.pending?.() && ![...clarifying.values()].some(q => q.until > now)) lookOver().catch(err => console.error('[observer]', err));
    if (waitMode) {
      // JEV_IDLE=wait: nothing is done between requests but answering what would
      // hurt the bot where it stands; a standing dream is still launched, since
      // a player set it. Stopped ("Jev stop") it still defends itself.
      // Waiting in the open is for daylight. The test of 2026-11-20: unarmed at
      // midnight with two zombies summoned beside it, the waiting bot ran eighty
      // blocks and died twice in a minute. From dusk to dawn in the Overworld the
      // ordinary idle loop runs instead (it shelters), and is ended at sunrise.
      const dark = require('./company').darkNow(bot);
      // Nor is the day waited out in the night's shelter. Ended at sunrise where
      // it stood, the bot stayed sealed in its pocket until a player asked for
      // something, out of sight four blocks under the grass (2026-11-21). The
      // idle loop is let run on until the bot is out of the shelter and out of
      // the ground, and three seconds more to finish the climb (company.js
      // inShelter, holedUp, routine). It leaves by its own judgment, and is
      // started for that when the bot comes back by day still in one.
      // JEV_NIGHT=company: with a player near the dark is waited out like the
      // day, and a pocket a player has come close to is left like one at
      // sunrise (company.js standing).
      const company = require('./company'), stands = company.standing(bot, survival, dark, now);
      if (stands.sheltered) lastSheltered = now;
      const own = company.routine({ ...stands, sinceSheltered: now - lastSheltered });
      if (active?.idle && !active.closeWalk && own === 'end' && !relaunching) stop('interrupted').catch(console.error);
      else if (ready && !active && !relaunching && !launchingDream && !launchingArms && !pendingRequests) {
        const standing = survival.state.paused ? null : dreamStore.read();
        // The waiting bot's two own moves, by rule: to bed when every player is in one (bedtime.js), and back to its
        // player after monsters (company.js backDue). What would hurt it where it stands comes before both. A bot
        // told to stop makes them too, and is as stopped after: it was the monsters that moved it, and a "stop" said
        // during the walk back ends that walk (stop() lets the scare go).
        // Neither rule may end the waiting itself: what goes wrong in one is logged, and the bot waits as before.
        let hurting = false, abed = false, back = null, armsNow = null;
        try {
          company.withPlayer(bot, now);
          hurting = !!require('./reactive-wait').emergency(bot);
          abed = bedtime.busy();
          if (!hurting && !abed)
            back = company.backDue(bot, { now, dark,
              // After it: a monster in its sight within 16 blocks. About the player: one within 8 blocks and three
              // blocks of their height (a zombie in a cave under the house is not about them).
              chased: () => require('./danger').threats(bot, 16).some(t => t.visible),
              hostileNear: (at, blocks) => require('./danger').hostileEntities(bot, 64).some(e => e.position.distanceTo(at) <= blocks && Math.abs(e.position.y - at.y) <= 3) });
        } catch (err) { console.error('[company] the waiting bot\'s own moves:', err); }
        const toBed = () => { try { return bedtime.tick(); } catch (err) { console.error('[bedtime]', err); return false; } };
        if (standing?.dream && shouldLaunchDream(standing, store.read(), { ready: readyForDream(), resting: isSetAside(survival, 'dream_launch', standing.dream) })) launchDream(standing);
        else if (abed) { if (hurting) bedtime.cancel().catch(err => console.error('[bedtime]', err)); }
        else if (back) { try { launchBack(back); } catch (err) { console.error('[company] the walk back was not begun:', err); } }
        // JEV_WEAPON=keep: with no stone sword, it goes and makes one (keep-armed.js), by night only from its pockets.
        else if (!hurting && (armsNow = armsDue(now, dark))) launchArms(armsNow).catch(err => console.error('[weapon]', err));
        else if (own === 'run' && !survival.state.paused && !survival.state.idleBlocked) launchIdle();
        else if (hurting || !toBed()) {
          if (!hurting && !survival.state.paused && !bot._reactiveWaitActive && stayClose.due(bot, true)) walkWhileWaiting();
          else reactiveWait.tick().catch(err => console.error('[reactive wait]', err));
        }
      }
    } else if (ready && !active && !relaunching && !launchingDream && !pendingRequests && !survival.state.paused && !survival.state.idleBlocked) launchIdle();
  }, 500);

  // JEV_COOPERATION=ask: one player's work is not replaced by another's request unasked (handoff.js).
  const handoff = process.env.JEV_COOPERATION === 'ask' ? createHandoff() : null;
  // JEV_GUIDE_API_KEY: a language model reads what a player says first (guide.js). What it asks
  // for comes back through this same handler as plain requests, marked so they are not read twice.
  const guide = process.env.JEV_GUIDE_API_KEY ? createGuide({ file: path.join(stateDirectory, `${memoryIdentity}-guide.json`) }) : null;
  const guided = new WeakSet();
  // The game chat the guide reads (guide.js note): the bot's own lines as said, and the players' as heard (onPlayerChat):
  // with JEV_GUIDE_HEAR=all every line, else those to the bot and the answers to its questions. notedLines: the line kept
  // for each chat message, so that one read twice (a held request let through) is kept once.
  const hearAll = require('./guide').hearsAll(), speakUnasked = require('./guide').speaksUnasked();
  const notedLines = new WeakMap();
  // JEV_GUIDE_SPEAK=unasked, the look after a request of a player's failed (lookOver): lookFor is set by the failure and
  // lookAbout names the player; lastToBotAt is when a player last spoke to the bot.
  let lastChatAt = 0, lastToBotAt = 0, lastSpeaker = null, lookFor = 0, lookAbout = null, looking = false, guideBusy = 0;
  const LOOK_QUIET_MS = 8000;
  // JEV_GUIDE_SPEAK=unasked, a line said without the bot's name (hearOut): the guide's judge reads it when the player has
  // talked with the bot within TALK_MS (talkWith: their last line to it, the bot's last line naming them, a question put
  // to them), is alone with it, or names it in the line. heardAt: each player's last line, so that a bare yes to an offer
  // with another player's line since goes to the judge too. toBotAt: each player's last line to the bot, so that a line
  // judged for it after the player has said it again by name is let go.
  const talkWith = new Map(), heardAt = new Map(), toBotAt = new Map(), TALK_MS = 180000;
  const mentions = (text, name) => new RegExp(`(^|[^\\p{L}\\p{N}_])${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
  // Said, or dropped by quietRepeats as a repeat or over its rate (speech.js): an offer is open only once it is said.
  const sayCounted = line => { const before = bot._quietRepeats?.dropped || 0; bot.chat(line); return (bot._quietRepeats?.dropped || 0) === before; };
  // Inside quietRepeats (spawn): a line it drops was never said.
  function noteOwnLines() {
    if (!guide || typeof bot.chat !== 'function' || bot._notesTalk) return;
    bot._notesTalk = true;
    const say = bot.chat.bind(bot);
    bot.chat = message => {
      try {
        const text = String(message);
        guide.note(bot.username, text, { bot: true }); lastChatAt = Date.now();
        for (const name of Object.keys(bot.players)) if (name !== bot.username && mentions(text, name)) talkWith.set(name, lastChatAt);
      } catch (_) { /* the chat is kept for the guide; the line is said either way */ }
      return say(message);
    };
  }
  let guideQueue = null;         // { sender, from, rest: [request, ...], useBuildings }: what the guide asked for after the request in hand
  const passOn = data => { guided.add(data); onPlayerChat(data); };
  // `useBuildings`: the player's leave to take from what is built (built.js), carried by the request itself so that
  // one held for a "may I switch?" or waiting its turn in the queue keeps it.
  // `fromJudged`: fed in from a line taken for the bot without its name (hearOut): never a server command. Not `judged`
  // itself, which would ask about a chosen build all over again.
  const inject = (sender, text, { useBuildings = false, workSite, fromJudged = false } = {}) => passOn({ sender, plainMessage: `${bot.username} ${text}`, workSite, ...(useBuildings && { useBuildings: true }), ...(fromJudged && { fromJudged: true }) });
  // The work in hand may use them, said by a player while it runs. -> the line for chat.
  const useBuildingsNow = from => {
    const goal = active && !active.idle ? active.goal : null;
    if (!goal) return 'Nothing in hand to use them for. Ask for the thing and say the buildings may be used.';
    if (require('./built').allowed(goal)) return "I'm already using them for this.";
    require('./built').permit(bot, goal, from); saveGoal(goal);
    console.log(`[built] ${from} allowed the buildings for: ${goal.request}`);
    return "All right, I'll take it from the buildings for this job.";
  };
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const guideStatus = from => {
    const me = bot.entity?.position, them = bot.players[from]?.entity?.position, t = bot.time?.timeOfDay;
    const mine = memory.context(from);
    return { health: bot.health, food: bot.food, dimension: bot.game?.dimension,
      locations: locations.context(from),
      ...(stayClose.preference(bot) && { stayClose: stayClose.status(bot) }),
      time: Number.isFinite(t) ? (t >= 12300 && t < 23500 ? 'night' : 'day') : undefined,
      holding: bot.heldItem?.name, carrying: Object.fromEntries(bot.inventory.items().slice(0, 16).map(item => [item.name, item.count])),
      doing: active && !active.idle ? { request: active.goal.request, for: active.goal.from, ...(require('./built').allowed(active.goal) && { mayUseBuildings: true }) } : active?.idle ? 'looking after itself' : 'waiting for a request',
      // The request before, and how it ended: what "carry on" and "did you finish?" are about.
      lastRequest: (saved => saved?.request ? { request: clean(saved.request), for: saved.from, ended: saved.status } : null)(store.read()),
      // The work set aside and the buildings begun and not finished, with where they are (agenda.js): what "continue"
      // and "finish the house" are about.
      ...((agenda => {
        const setAside = agenda.setAside(store.read(), { username: bot.username, point: them });
        const unfinishedBuilds = agenda.unfinishedBuilds(builds, bot, { from, point: them || me, dimension: bot.game?.dimension }).slice(0, 4)
          .map(b => ({ name: b.name, request: clean(b.request), for: b.from, at: b.origin, blocksFromPlayer: b.distance, standingPercent: b.standing }));
        return { ...(setAside.length && { setAside }), ...(unfinishedBuilds.length && { unfinishedBuilds }) };
      })(require('./agenda'))),
      blocksFromPlayer: me && them ? Math.round(me.distanceTo(them)) : 'out of sight',
      dream: dreamStore.read()?.dream || null,
      // Which wood stands free near the bot, for a wish for wood that names none (built.js woodInView).
      ...(require('./built').on() && (wood => wood.length ? { woodInView: wood } : {})((() => { try { return require('./built').woodInView(bot, active?.goal); } catch (_) { return []; } })())),
      savedPlaces: (mine.places || []).map(place => place.label || place.name).filter(Boolean).slice(0, 12),
      savedNotes: (mine.notes || []).map(note => note.note).filter(Boolean).slice(-8),
      // What players have said of the things round them (labels.js): what "what's marked here?" is answered from.
      ...(near => (near.length ? { labels: near } : {}))(require('./labels').statusNear(bot, them || me)) };
  };
  const onPlayerChat = data => {
    if (ended) return;
    const player = Object.values(bot.players).find(p => p.uuid === data.sender);
    if (!player || player.username === bot.username || typeof data.plainMessage !== 'string') return;
    // A player spoke, so the next line is an answer and may repeat an earlier one (speech.js quietRepeats).
    // Its own listener for this is registered after this one and ran too late: a second "Jev stop" inside
    // two minutes, more than fifteen seconds after the last thing a player said, stopped the bot without a
    // word (live server, 2026-11-20).
    bot._lastPlayerChatAt = Date.now();
    const from = player.username;
    if (!guided.has(data) && !data.judged) heardAt.set(from, Date.now());
    let request = data.plainMessage;
    let literal;
    try { literal = requestedCommand(request, bot.username); }
    catch (err) { console.error(err); bot.chat('I could not use that command. Please check what you asked me to do.'); return; }
    // A slash command runs only as said with the name, never from a line taken for the bot without it (hearOut).
    if (literal && (data.judged || data.fromJudged)) { console.log(`[hear] ${from}: a command said without my name is not run`); return; }
    let address = parseAddress(request, bot.username);
    // The game chat the guide reads (guide.js note), each message once: every player's line with JEV_GUIDE_HEAR=all, else
    // the lines to the bot; an answer to a question the bot asked is marked as said to it (noteHeard). Not the requests
    // the guide itself fed in.
    const noteLine = toBot => {
      if (!guide || literal || guided.has(data)) return;
      const kept = notedLines.get(data);
      if (kept) { if (toBot) kept.toBot = true; }
      else { const entry = guide.note(from, address.text, { toBot }); if (entry) notedLines.set(data, entry); }
      lastChatAt = Date.now(); lastSpeaker = from;
      // Said to the bot: it has its answer coming, and the look after a failure (lookOver) is not wanted over it.
      if (toBot) { lastToBotAt = lastChatAt; toBotAt.set(from, lastChatAt); talkWith.set(from, lastChatAt); lookFor = 0; }
    };
    const noteHeard = () => noteLine(true);
    if (address.explicit) noteLine(true);
    else if (hearAll) noteLine(false);
    // The answer to "may I switch?": yes lets the held request through as it was said.
    const handed = handoff?.answer(from, address.text);
    if (handed) {
      noteHeard();
      if (handed.verdict === 'yes') { bot.chat(`Thanks. Switching to ${handed.question.asker}'s request.`); onPlayerChat(handed.question.payload); }
      else bot.chat(`Okay, I'll stay on your task. Sorry, ${handed.question.asker}.`);
      return;
    }
    // A pick among the guide's numbered choices (guide.js options), or no to them all, addressed or not: run as the guide
    // would have run it, with no second call to the model. Anything else addressed moves on from the choice.
    const offered = clarifying.get(from);
    if (offered?.kind === 'guide') {
      const open = offered.until > Date.now() && !literal;
      const pick = open ? require('./guide').pickOption(address.text, offered.options) : null;
      const no = open && !pick && require('./guide').declines(address.text);
      if (pick || no) {
        const take = () => {
          noteHeard(); clarifying.delete(from);
          if (no) { bot.chat('Okay, never mind.'); return; }
          console.log(`[guide] ${from} chose ${JSON.stringify(pick.label)}: ${JSON.stringify(pick.requests)}`);
          observation?.sample('guide', { from, said: address.text, chose: pick.label, requests: pick.requests });
          guideQueue = { sender: data.sender, from, rest: pick.requests.slice(1), useBuildings: !!offered.useBuildings, workSite: offered.workSite, ...(offered.judged && { fromJudged: true }) };
          inject(data.sender, pick.requests[0], guideQueue);
        };
        // Said without the name after another player has spoken since the offer, a yes or a number may be their answer:
        // the judge reads it (JEV_GUIDE_SPEAK=unasked; hearOut), and without one, or unsure, it is left alone and the
        // choice stays open for an answer by name. Said by name, or with nobody else talking since, it is the answer.
        const contested = !address.explicit && [...heardAt].some(([name, at]) => name !== from && at > (offered.at || 0));
        if (!contested) { take(); return; }
        if (speakUnasked && guide) hearOut(data, from, address.text, () => { if (clarifying.get(from) === offered && offered.until > Date.now()) take(); });
        else console.log(`[hear] ${from}: ${JSON.stringify(address.text)} came after another player spoke; the choice waits for an answer by name`);
        return;
      }
      if (address.explicit || offered.until <= Date.now()) clarifying.delete(from);
    }
    // Acknowledgements from other bots must never start new work. New goals
    // require an explicit name; short controls remain convenient when unprefixed.
    const me = String(bot.username || config.username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const control = new RegExp(`^(stop|cancel|resume|status)(,? (now|please|${me}))*[.!?]?$`, 'i');
    // The answer to a question Jev just asked. "Did you mean short grass or
    // grass block?" got "grass block" back, with no name in front, and the
    // gate dropped it; "Jev grass block" started a new request that had lost
    // the count and the recipient. The reply is read together with the
    // request it answers.
    const known = text => { const name = text.toLowerCase().replace(/\s+/g, '_'); return !!(bot.registry?.itemsByName?.[name] || bot.registry?.blocksByName?.[name] || bot.registry?.entitiesByName?.[name]); };
    const question = clarifying.get(from)?.kind === 'guide' ? null : clarifying.get(from);
    const answer = !literal && !control.test(address.text) && clarificationReply(question, address, { known });
    // A new addressed message moves on from the question either way.
    if (answer || address.explicit) clarifying.delete(from);
    if (answer) noteHeard();
    if (answer) {
      if (question.workSite) data.workSite = question.workSite;
      request = `${bot.username} ${answer}`;
      address = parseAddress(request, bot.username);
    }
    // JEV_GUIDE_SPEAK=unasked: a line without the name that may still be for the bot goes to the guide's judge (hearOut):
    // not one plainly for another player or one that asks nothing (guide.js mayBeForBot), and only from a player who has
    // talked with the bot lately, is alone with it, or names it in the line. Anything else without the name is left to
    // the players, as it always was.
    if (!address.explicit && !answer && !literal && speakUnasked && guide && !guided.has(data) && !data.judged && !control.test(address.text)) {
      const others = Object.keys(bot.players).filter(name => name !== bot.username && name !== from);
      const talking = Date.now() - (talkWith.get(from) || 0) < TALK_MS;
      if (require('./guide').mayBeForBot(address.text, { botNames: chatNames(bot.username || config.username), others, talking })) hearOut(data, from, address.text);
      return;
    }
    if (!address.explicit && !control.test(address.text)) return;
    // Stop has a synchronous fast path, even while a network request is pending.
    const normalized = address.text;
    const stopping = new RegExp(`^(stop|cancel)(,? (now|please|${me}))*[.!?]?$`, 'i').test(normalized);
    // "Stop!" between two players is not addressed to the bot. Unprefixed,
    // it counts from whoever gave the work in hand, or when nobody else is
    // here to be talking to; it froze the bot, self-care included, in the
    // middle of other people's conversations.
    const owner = (active?.goal || store.read())?.from;
    const company = Object.values(bot.players).filter(p => p.username !== bot.username && p.username !== from).length;
    // "Stop Jev", with the name last, is as addressed as "Jev stop".
    const named = chatNames(bot.username || config.username).some(name => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(address.text));
    if (stopping && !address.explicit && !named && owner !== from && company > 0) return;
    if (stopping) {
      invalidateRequests();
      stop().catch(console.error);
      bot.chat('Stopped. I saved our progress. Say "Jev resume" to keep going.');
      return;
    }
    if (!ready) { bot.chat('Still loading the world; please repeat the request in a moment. Stop is available now.'); return; }
    const proximity = address.explicit && !literal && stayClose.readControl(address.text);
    if (proximity) {
      bot.chat(stayClose.applyControl(bot, from, proximity));
      if (proximity.mode === 'on' && !active) { survival.state.paused = false; saveSurvival(); }
      if (guided.has(data) && guideQueue?.rest.length) inject(data.sender, guideQueue.rest.shift(), guideQueue);
      return;
    }
    const location = !literal && address.explicit && splitLocation(address.text, bot.registry);
    if (location) {
      try { data.workSite ||= resolveLocation(bot, from, location); }
      catch (err) { bot.chat(err.message); return; }
      request = `${bot.username} ${location.task}`;
      address = parseAddress(request, bot.username);
    }
    const locationIntent = address.explicit && !literal ? require('./home-location').locationRequest(address.text) : null;
    const scope = locationIntent && require('./home-location').homeScope(address.text);
    if (locationIntent && !locationIntent.startsWith('visit_')) {
      const reply = message => {
        if (scope === 'personal' || (!scope && ['home', 'both'].includes(locationIntent) && locations.home(from, 'personal'))) commandAccess.whisper(data.sender, message);
        else bot.chat(message);
      };
      if (locationIntent.startsWith('set')) reply(locations.setHome(from, bot.players[from]?.entity?.position, bot.game.dimension, locationIntent));
      else if (locationIntent === 'forget_home') reply(locations.forgetHome(from, scope));
      else locations.refresh().then(() => { if (!ended) reply(locations.describe(from, locationIntent, scope)); });
      return;
    }
    const directDiscovery = data.workSite && discoveryAt(address.text, bot.registry);
    // "Continue" with nothing set aside to continue is the guide's and the interpreter's to make sense of, as before (agenda.js).
    // Nor "finish my house" said at walls of their own with no building work near them: that is the house round them.
    const theirStart = a => a?.kind === 'continue_work' && a.what === 'build' && require('./agenda').theirStartFirst(bot, address.text, { at: position(bot.players[from]?.entity?.position),
      inHand: active && !active.idle ? active.goal : null, saved: store.read(), registry: builds });
    // Asked of the interpreter too, which reads the companion actions again unless told the house comes first.
    const companionAsk = address.explicit && !literal && require('./companion-actions').companionAction(address.text, data.workSite), houseFirst = theirStart(companionAsk);
    const action = (a => (a?.kind === 'continue_work' && !require('./agenda').hasWork(store.read(), builds, bot, a.what, { active: active && !active.idle ? active.goal : null, from })) || houseFirst ? null : a)(companionAsk);
    const knownVisit = locationIntent?.startsWith('visit_');
    const visitLocation = async () => {
      if (locationIntent === 'visit_respawn') await locations.refresh();
      const home = locationIntent === 'visit_home';
      const to = home ? locations.home(from, scope) : locations.respawn();
      if (!to?.position) return {kind:'clarify', from, request, message:locations.describe(from, home ? 'home' : 'respawn', scope)};
      const {dimension, ...position} = to.position;
      return {kind:'visit',from,request,destination:{label:home ? 'home' : 'my respawn point',position,dimension}};
    };
    const houseIntent = !literal && require('./house-details').houseRequest(address.text, bot.registry);
    // A literal status request reads local state immediately, even while a
    // previous natural-language request is waiting for a model response.
    if (/^status( please)?[.!?]?$/i.test(normalized)) {
      bot.chat(statusMessage(bot, active, store.read())); return;
    }
    // "Jev use the buildings": the answer to the line built.js says when the only source in view is built.
    // Read here, so it works with the language layer off or out of reach.
    if (require('./built').on() && address.explicit && !literal && !answer && /^(yes,? )?(you (may|can) )?use the buildings?[.!]?$/i.test(normalized)) {
      bot.chat(useBuildingsNow(from)); return;
    }
    // "Jev, don't cut my wall": the doorway through a player's wall left for them to open (player-build.js leaveDoorway).
    // Read here too, so it works with the language layer off or out of reach.
    if (address.explicit && !literal && !answer && require('./player-build').keepWallsRequest(normalized)) {
      const goal = active && !active.idle ? active.goal : store.read();
      const line = require('./player-build').leaveDoorway(bot, goal);
      if (goal?.keepWalls) saveGoal(goal);
      bot.chat(line); return;
    }
    // A house asked for without the name (hearOut) is asked about first, as a build is (below): if the line was not for
    // the bot it would cost an afternoon.
    if (data.judged && houseIntent) {
      const options = [{ label: 'build it', requests: [address.text] }];
      if (sayCounted(require('./guide').withOptions(`${from}, did you mean me: "${address.text.replace(/[.!?]+$/, '').slice(0, 60)}"?`, options))) {
        talkWith.set(from, Date.now());
        clarifying.set(from, { kind: 'guide', options, until: Date.now() + CLARIFY_MS, at: Date.now(), workSite: data.workSite, judged: true });
      }
      return;
    }
    if (guide && !directDiscovery && !houseIntent && !action && !knownVisit && !guided.has(data) && !literal && !answer && address.explicit && !control.test(address.text)) {
      guideQueue = null;
      bot.swingArm?.('right');
      guideBusy++;
      // What "this" and "here" are, read now: the answer comes seconds later, the head turned by then (labels.js).
      const pointed = require('./labels').pointedNow(bot, from);
      guide.consult({ from, text: address.text, botName: bot.username, status: guideStatus(from) }).then(out => {
        if (ended) return;
        // A line taken for the bot without its name (hearOut) is the guide's to read or nobody's: it never goes on to the
        // interpreter as said.
        if (!out) { if (data.judged) console.log(`[hear] ${from}: nothing from the guide for ${JSON.stringify(address.text)}; left alone`); else passOn(data); return; }
        // Taken without the name, a build is asked about first: if the line was not for the bot it would cost an afternoon.
        if (data.judged && !out.options?.length && out.requests.some(r => /^build\b/i.test(r))) {
          out.options = [{ label: out.requests.join(', then '), requests: out.requests }];
          out.say = require('./guide').withOptions(`${from}, shall I ${out.requests.join(', then ')}?`, out.options);
          out.requests = [];
        }
        observation?.sample('guide', { from, said: address.text, say: out.say, requests: out.requests, addedRule: out.addedRule, forgotRule: out.forgotRule,
          ...(out.label && { label: out.label }), ...(data.judged && { heard: true }), ...(out.options && { options: out.options.map(o => ({ label: o.label, requests: o.requests })) }) });
        console.log(`[guide] ${from}: ${JSON.stringify(address.text)} -> ${JSON.stringify(out)}`);
        // A label (labels.js): set or taken off now, and said back with what it is on, in place of the guide's own line,
        // which would say it twice. Choices offered with one go unasked: the label is the answer.
        const labelled = out.label ? require('./labels').apply(bot, from, out.label, pointed, { judged: !!data.judged }) : null;
        if (labelled) out.options = null;
        const said = labelled ? sayCounted(labelled) : out.say ? sayCounted(out.say) : false;
        if (said) talkWith.set(from, Date.now());
        // The holder's yes to "may I switch?" in words the yes list does not know, read by the language layer as the held
        // request itself (handoff.js approvesByRequest): it runs as the asker's request, for the asker, not again in the
        // holder's name for the holder.
        const approved = !labelled && !out.options?.length && handoff?.approvesByRequest(from, out.requests, bot.username);
        if (approved) {
          noteHeard();
          console.log(`[handoff] ${from} agreed in other words: ${approved.question.asker}'s request goes ahead as theirs`);
          if (!said) bot.chat(`Thanks. Switching to ${approved.question.asker}'s request.`);
          onPlayerChat(approved.question.payload);
          return;
        }
        const useBuildings = !!out.useBuildings && require('./built').on();
        // Choices offered: the pick is read when it comes (above), within the question's minute and a half, once said.
        if (out.options?.length) {
          if (said) clarifying.set(from, { kind: 'guide', options: out.options, until: Date.now() + CLARIFY_MS, at: Date.now(), workSite: data.workSite, useBuildings, ...(data.judged && { judged: true }) });
        } else if (out.requests.length) {
          guideQueue = { sender: data.sender, from, rest: out.requests.slice(1), useBuildings, workSite: data.workSite, ...(data.judged && { fromJudged: true }) };
          inject(data.sender, out.requests[0], guideQueue);
        } else if (useBuildings && !out.addedRule) {
          // No request with it: the leave is for the work in hand (a standing rule just stored is for the
          // requests to come). The guide's own line has been said; ours only where it says something else.
          const line = useBuildingsNow(from);
          if (!out.say || !/^All right/.test(line)) bot.chat(line);
        }
      }).catch(err => { console.error('[guide]', err); if (!ended && !data.judged) passOn(data); }).finally(() => { guideBusy--; });
      return;
    }
    // Acknowledge instantly. Everything below can wait on the model, and a
    // motionless bot reads as "it did not hear me" rather than "it is thinking".
    bot.swingArm?.('right');
    const revision = generation;
    const requestPosition = { speakerPosition: position(bot.players[from]?.entity?.position), botPosition: position(bot.entity?.position), dimension: bot.game.dimension };
    // The request pays for its own understanding. One that turns out to
    // start no work folds that cost into the standing bucket instead.
    const run = ledger.open({ kind: 'request', name: request });
    const requestClient = withRun(withRequestSignal(client, requestController.signal), run.id);
    let launched = false;
    pendingRequests++;
    pending = pending.then(async () => {
      if (revision !== generation || ended) return;
      // A catalog or list walk is several calls: look like it is thinking,
      // not like it did not hear. Not over work in hand: the glance turns the
      // head, and a dig in progress needs it where it is.
      const stopThinking = literal || directDiscovery || houseIntent || action || knownVisit || active ? () => {} : thinking(bot);
      const spec = literal ? { kind: 'operator_command' } : knownVisit ? await visitLocation() : directDiscovery ?
        { kind: 'find', discoveryTarget: directDiscovery, from, request } : await interpret(requestClient, request, from, bot.username, {
        registry: bot.registry, players: Object.keys(bot.players),
        ...requestPosition, houseIntent, action, houseFirst, workSite: data.workSite, memory: { ...memory.context(from), found: require('./exploration').foundEntries(world.known) },
        builds: builds.describe(bot, requestPosition.speakerPosition || bot.entity.position, bot.game.dimension),
        continueBuilds: (request, candidates) => resolveBuildContinuation(requestClient, request, candidates,
          { speaker: requestPosition.speakerPosition }),
        inventory: Object.fromEntries(bot.inventory.items().map(item => [item.name, item.count])),
      }).finally(stopThinking);
      // What Jev made of the request is the first thing worth seeing about
      // it, whether or not any work follows.
      if (spec && !literal) {
        observation?.sample(spec.kind === 'clarify' ? 'clarify' : 'request', { request, from, kind: spec.kind, message: spec.message,
          clarification: spec.clarification, interpretation: spec.interpretation, itemResolution: spec.itemResolution,
          discoveryResolution: spec.discoveryResolution, buildContinuation: spec.buildContinuation, usage: spec.usage, latencyMs: spec.latencyMs });
      }
      if (!spec || revision !== generation) return;
      if (data.workSite && ['build', 'house', 'obtain', 'craft', 'bundle', 'find', 'come', 'light_area', 'climb_ladder', 'place_at_site'].includes(spec.kind)) {
        spec.workSite = data.workSite;
        if (spec.kind === 'house') spec.kind = 'build';
        if (spec.kind === 'build') spec.buildAnchor = { ...data.workSite.position };
        if (spec.tasks) for (const child of spec.tasks) child.workSite = data.workSite;
      }
      if (spec.kind === 'operator_command') {
        if (data.judged || data.fromJudged) { bot.chat(`Say my name with that one, ${from}.`); return; }
        const allowed = (process.env.MC_COMMAND_USERS || '').split(',').map(name => name.trim().toLowerCase());
        if (!allowed.includes(from.toLowerCase())) { bot.chat(`${from} is not enabled for Jev's operator commands`); return; }
        const resolution = literal ? { command: literal } : await classifyCommand(requestClient, bot, request, from);
        if (revision !== generation) return;
        const command = commandAccess.accept(data, { resolvedCommand: resolution.command, interpretation: { routing: spec.interpretation, command: resolution.judgments } });
        if (!command) return;
        // A command is an aside, not a change of plan. Setting the time or the
        // game mode used to abandon whatever Jev was building and leave it
        // waiting to be asked again, which is not what "also do this" means.
        // Anything the command does to the world - a teleport, a mode change -
        // the goal already copes with, because the world changes anyway.
        const feedback = [];
        const collect = (message, position, original, sender) => {
          if (position === 'system' && sender == null && feedback.length < 4) feedback.push(message);
        };
        bot.on('messagestr', collect);
        try {
          bot.chat(`Running your command once: ${command.command}`);
          command.dispatch();
          await new Promise(resolve => setTimeout(resolve, 1000));
        } finally { bot.removeListener('messagestr', collect); }
        for (const reply of feedback) bot.chat(`Command response: ${reply}`);
        return;
      }
      if (spec.kind === 'status') {
        bot.chat(statusMessage(bot, active, store.read()));
        return;
      }
      if (spec.kind === 'other') {
        bot.chat('Ask for items or a full set, a biome or creature to find, someone to follow, or a structure to build.');
        return;
      }
      if (spec.kind === 'memory') {
        bot.chat(memory.handle(spec, { world: world.known }));
        if (active?.goal.from === from) active.goal.memoryContext = memory.context(from);
        observation?.sample('memory', { operation: spec.memory.operation });
        return;
      }
      if (spec.kind === 'dream') {
        const standing = dreamStore.read() || {};
        const { operation, key } = spec.dream;
        const title = standing.dream ? dreamTitle(standing) : null;
        if (operation === 'set_custom') {
          // The text routes as a request; a survival route may still not exist for it.
          const impossible = unworkable(bot, spec.dream.probe);
          if (impossible) { bot.chat(`I can't keep that as a dream. ${friendlyProblem(impossible)}`); return; }
        }
        if (operation === 'query') {
          bot.chat(dreamReport(standing, store.read()));
        } else if (operation === 'clear') {
          if (standing.ledgerRun) ledger.close(standing.ledgerRun, 'cleared');
          saveDream({ dream: null, clearedBy: from, clearedAt: new Date().toISOString() });
          if (active && !active.idle && active.goal.dream) await stop('cancelled');
          bot.chat('Okay, no dream for now. I\'ll just look after myself between requests.');
        } else if (operation === 'pause') {
          if (!standing.dream) bot.chat("I don't have a dream to set aside.");
          else {
            saveDream({ ...standing, paused: true, pausedBy: from, pausedAt: new Date().toISOString() });
            if (active && !active.idle && active.goal.dream) await stop('interrupted');
            bot.chat(`Okay, I'll set my dream aside for now. Say "chase your dream" when you want me back on it.`);
          }
        } else if (operation === 'resume') {
          if (!standing.dream) bot.chat(dreamReport(null));
          else {
            // Chasing a satisfied dream again is a new run; picking up a paused one is not.
            // A custom dream begins afresh from a resume: its earlier finish or failures are behind it.
            const fresh = standing.dream === 'custom' && (standing.satisfiedAt || standing.paused) ? { setAt: new Date().toISOString(), failures: undefined, countedGoal: undefined } : {};
            saveDream({ ...standing, ...fresh, paused: false, satisfiedAt: undefined, resumedBy: from, resumedAt: new Date().toISOString(),
              ledgerRun: standing.satisfiedAt || !standing.ledgerRun ? ledger.open({ kind: 'dream', name: dreamName(standing.dream, standing.text) }).id : standing.ledgerRun });
            // A stop paused the survival loop with everything else; taking the
            // dream up again takes that up too, or nothing would run it.
            survival.state.paused = false; saveSurvival();
            bot.chat(`Back to my dream: to ${title}.`);
            const saved = store.read();
            if (saved?.dream && (standing.dream !== 'custom' || saved.dream === 'custom') && ['interrupted', 'cancelled', 'blocked'].includes(saved.status) && !active) {
              if (standing.dream === 'custom') saved.dreamSetAt = fresh.setAt ?? standing.setAt;
              launch(saved);
            }
          }
        } else {
          if (standing.ledgerRun && !standing.satisfiedAt) ledger.close(standing.ledgerRun, 'replaced');
          const text = spec.dream.text;
          saveDream({ dream: key, ...(key === 'custom' && { text }), setBy: from, setAt: new Date().toISOString(), ledgerRun: ledger.open({ kind: 'dream', name: dreamName(key, text) }).id });
          bot.chat(key === 'custom' ? `Got it. My dream is to ${text}. I'll do it once, whenever nothing else needs me.`
            : `Got it. My dream is to ${DREAMS[key].title}. I'll chase it whenever nothing else needs me.`);
        }
        observation?.sample('dream', { operation, key, standing: dreamStore.read() });
        return;
      }
      if (spec.kind === 'clarify') {
        const reason = spec.clarification?.reason;
        clarifying.set(from, { request: address.text, workSite: data.workSite, options: spec.clarification?.options, until: Date.now() + CLARIFY_MS,
          confirm: ['uncertain_interaction', 'dream_unsure'].includes(reason), which: ['no_item', 'no_discovery_target', 'ambiguous_item', 'incomplete_bundle'].includes(reason) });
        bot.chat(spec.message); return;
      }
      if (spec.kind === 'stop') {
        invalidateRequests(); await stop();
        // Stopped after the bot said it would take from the buildings after all: that is a no, kept with the
        // goal for a later "resume" (built.js refuse).
        const stopped = store.read();
        if (stopped && require('./built').refuse(stopped)) { saveGoal(stopped); console.log(`[built] ${from} stopped the last resort for: ${stopped.request}`); }
        bot.chat('Stopped.'); return;
      }
      // Back to the work set aside, by what it is: the newest such request in the stack, where it stands; or a
      // building of its own left unfinished, finished from its saved plan (agenda.js, 2026-11-22).
      if (spec.kind === 'continue_work') {
        const agenda = require('./agenda');
        const prefer = spec.what === 'build' ? agenda.isBuild : agenda.notErrand;
        if (active && !active.idle && prefer(active.goal)) { bot.chat(`I'm on it: ${agenda.said(active.goal, bot.username)}.`); return; }
        if (resumeSaved(store.read(), { prefer })) {
          if (active && !active.idle) await stop('replaced');
          if (revision !== generation || ended) return;
          await resume(revision, { prefer, say: true, from }); return;
        }
        const entry = spec.what === 'build' && agenda.unfinishedBuilds(builds, bot, { from, point: requestPosition.speakerPosition || bot.entity.position, dimension: bot.game.dimension })[0];
        if (!entry) { bot.chat("There's nothing I was in the middle of. What should I do?"); return; }
        Object.assign(spec, { kind: 'build', continueBuild: { id: entry.id, mode: 'finish' },
          buildContinuation: { mode: 'finish', target: entry.id, name: entry.name, placement: 'anywhere', judgments: { rule: 'continue_work' } } });
        delete spec.what;
        bot.chat(`The ${entry.name} at ${entry.origin.x}, ${entry.origin.y}, ${entry.origin.z}${entry.distance != null ? `, ${entry.distance} blocks from you` : ''}${entry.standing != null ? `, ${entry.standing}% built` : ''}.`);
      }
      if (spec.kind === 'resume') {
        if (data.useBuildings) { const saved = store.read(); if (saved && !active) { require('./built').permit(bot, saved, from); saveGoal(saved); } }
        await resume(revision); return;
      }
      // In Creative with the generative designer, a plain house is drawn like
      // any other building rather than taken from the built-in catalog.
      if (spec.kind === 'house' && designerAvailable(bot)) spec.kind = 'build';
      // Work no survival route can do is refused here, before it replaces
      // work that can be done. "Get me bedrock" stopped a build, then was
      // parked as impossible, and the build had to be dug out with resume.
      const impossible = unworkable(bot, spec);
      if (impossible) { bot.chat(`${friendlyProblem(impossible)}${active && !active.idle ? " I'll carry on with what I was doing." : ''}`); return; }
      const holder = handoff && !handoff.approved(from, request) && handoff.holder({ active, from, online: name => Object.keys(bot.players).some(p => p.toLowerCase() === String(name).toLowerCase()) });
      if (holder) {
        handoff.ask({ holder, asker: from, request, payload: data });
        bot.chat(`I'm working on something for ${holder}. ${holder}, may I switch to ${from}'s request? Say "${bot.username} yes" or "${bot.username} no".`);
        return;
      }
      await stop('replaced');
      if (revision !== generation || ended) return;
      const goal = { ...spec, ledgerRun: run.id, version: 1, status: 'pending', createdAt: new Date().toISOString(),
        ...(data.useBuildings && require('./built').on() && { allowBuilt: { by: from, at: new Date().toISOString() } }),
        suspendedTasks: suspendPrevious(store.read()),
        requesterPosition: bot.players[from]?.entity ? { ...bot.players[from].entity.position } : null,
        initialInventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })) };
      saveGoal(goal);
      if (goal.workSite) { const s = goal.workSite; bot.chat(`I'll work beside the ${s.name.replaceAll('_', ' ')} at ${s.position.x}, ${s.position.y}, ${s.position.z}.`); }
      const changing = spec.kind === 'build' && spec.buildContinuation?.name &&
        { edit: spec.houseDetails?.room ? `I'll add a room to ${spec.buildContinuation.name}.` : `I'll work out what to change about ${spec.buildContinuation.name}.`,
          finish: `I'll carry on with ${spec.buildContinuation.name}.`,
          repair: `I'll look ${spec.buildContinuation.name} over and put right what is missing.`,
        }[spec.buildContinuation.mode];
      bot.chat(changing ? changing :
        spec.kind === 'build' && spec.addRoom ? "I'll add a room to your house, on the wall you are looking at." :
        spec.kind === 'build' && spec.onto === 'asked' ? (spec.ontoWhat === 'roof' ? "I'll have a look at what you've built and put a roof on it." : "I'll have a look at what you've built and finish it.") :
        spec.kind === 'build' ? "I'll make a plan, find a good spot, and build it for you." :
        spec.kind === 'bundle' ? `Working on the whole list: ${bundleSummary(spec)}.` :
        spec.kind === 'find' ? `I will look for ${spec.discoveryTarget.name.replaceAll('_', ' ')} and tell you where I find it.` :
        spec.kind === 'house' ? `Building a small ${spec.material} house with a floor, doorway and roof.` :
        ['obtain', 'craft'].includes(spec.kind) ? `I'll get ${spec.count} ${spec.item.replaceAll('_', ' ')}${spec.deliver ? ` for ${spec.deliverTo || from}` : ''}.` :
        spec.kind === 'light_area' ? (spec.radius > 6 ? `I'll light the ground within ${spec.radius} blocks so nothing spawns there.` : "I'll check the ground for dark spots and light them.") :
        spec.kind === 'place_at_site' ? `I'll place the ${spec.item} beside the ${spec.workSite.name.replaceAll('_', ' ')}.` :
        spec.kind === 'climb_ladder' ? `I'll climb ${spec.direction} the nearby ladder.` :
        spec.kind === 'replant' ? "I'll plant saplings where I cut trees." :
        spec.kind === 'visit' ? `I'll head to ${spec.destination.label}.` :
        spec.kind === 'come' ? `Coming to ${spec.target}.` : spec.kind === 'follow' && spec.guard ? `I'll stay by you and fight off what comes at you, ${spec.target}. Say Jev stop to stop.` :
        spec.kind === 'follow' ? `Following ${spec.target}; say Jev stop to stop.` :
        spec.kind === 'win' ? "Let's beat the dragon! I'll gather supplies and take it one step at a time." :
        "I'll get a Nether portal working, then go through to check it.");
      launch(goal); launched = true;
    }).catch(err => { console.error(err); if (!ended && revision === generation) bot.chat(intakeProblem(err)); }).finally(() => { if (!launched) ledger.fold(run.id); pendingRequests--; });
  };
  bot._client.on('playerChat', onPlayerChat);

  bot.once('spawn', async () => {
    try {
      spawned = true;
      configureMovements(bot);
      console.log(`[bot] spawned as ${bot.username} (${bot.version})`);
      // Put back in the boat it left in (boats.js leaveStrandedVehicle): the
      // seat comes a moment after the spawn, and no crossing is under way
      // this soon after joining.
      const joinedAt = Date.now();
      const seated = () => { if (Date.now() - joinedAt < 5000) require('./boats').leaveStrandedVehicle(bot).then(left => left && console.log('[bot] joined in a boat; got out'), err => console.log(`[bot] joined in a boat and could not get out: ${err.message}`)); };
      bot.once('mount', seated);
      if (bot.vehicle || bot._seatedIn != null) seated();
      // The seat can come by the raw packet alone (compatibility.js), with no mount event.
      bot._client.on('set_passengers', () => { if (bot._seatedIn != null && !bot.vehicle) seated(); });
      await bot.waitForChunksToLoad();
      if (ended || !bot.isAlive) return;
      // The ground about the bot read again before anything resumes: in
      // lava, out at once; in water beside lava, onto dry ground clear of it
      // (lava-escape.js settleAfterJoin, note 756). 25597 came back standing
      // in its poured water a block from lava, was asked the turn's question
      // while the flow carried it in, and died there.
      try { await require('./lava-escape').settleAfterJoin(bot, survival); saveSurvival(); }
      catch (err) { console.error('[join] reading the ground:', err.message); }
      if (ended || !bot.isAlive) return;
      ready = true;
      console.log(JSON.stringify({ sessionReady: true, username: bot.username }));
      const saved = store.read();
      // A walk back after monsters from before this start is over: the scare it answered went with that run.
      if ((saved?.back || saved?.weaponErrand) && saved.status !== 'complete') { saved.status = 'complete'; store.save(saved); }
      // A "come here" is not taken up again when its player is not in the
      // game, or it was said minutes ago (company.js lapsed).
      if (saved && ['running', 'recovering'].includes(saved.status) && require('./company').lapsed(saved, bot)) {
        console.log('[company] a call from before this start is not taken up again');
        saved.status = 'complete'; saved.lapsed = new Date().toISOString(); store.save(saved);
      }
      if (saved && ['running', 'recovering'].includes(saved.status) && !survival.state.paused) {
        bot.chat(survival.state.recovery?.status === 'pending' ? "I'm back! I'll look for my dropped items, then carry on." : "I'm back! I'll carry on where I left off.");
        // What was tried, judged by its own clock: moved on by the time the
        // save lay unplayed (a restart, a trial begun from a stage's save).
        require('./tried').resumed(saved, { savedAt: Date.parse(saved.updatedAt) });
        launch(saved);
      } else {
        // Work set aside from before this start is said, not started unasked (agenda.js).
        const waiting = saved && resumeSaved(saved);
        const { playerWork, errand } = require('./suspended-tasks');
        if (waiting && waiting.status !== 'complete' && playerWork(waiting) && !errand(waiting) && !waiting.dream)
          bot.chat(`I'm back. I still have ${require('./agenda').said(waiting, bot.username)} to finish; say "${bot.username} continue" when you want me on it.`);
        else bot.chat('Call me Jev: "Jev come here", "Jev follow me", "Jev craft a chest", or "Jev get me 8 birch stairs".');
      }
    } catch (err) { console.error('[bot] spawn:', err); bot.quit('Could not initialize the world'); }
  });
  // The game's death message for this bot, kept for the death record: the
  // cause said in the game's words ("was shot by Skeleton").
  bot.on('messagestr', text => {
    const name = bot.username;
    if (name && typeof text === 'string' && text.startsWith(`${name} `) && DEATH_WORDS.test(text.slice(name.length + 1))) {
      bot._deathMessage = { text: text.slice(name.length + 1), at: Date.now() };
      const last = (survival.state.deaths || []).at(-1);
      if (last && !last.cause && Date.now() - Date.parse(last.at) < 5000) last.cause = bot._deathMessage.text;
    }
  });
  bot.on('death', () => {
    ready = false; invalidateRequests();
    // A dead player can rejoin before respawning. No work has started in this
    // connection, so request respawn directly without recording a second death.
    if (!spawned && survival.state.recovery?.status === 'pending') { bot.respawn(); return; }
    // One death, one record (note 1930): the event came again 1.2 seconds after the first on the rejoin, at the same spot with an empty inventory, and full-3 (2026-10-19 21:58:22 and 21:58:23Z) was written down dead twice; of the dragon runs' two-death ledgers, one in each was this echo. The echo is answered with the respawn alone.
    // The record kept in the process too (note 1934): the second event comes on the rejoin, a new connection whose state is read from disk, and the store's save is debounced, so the death a second old was not in it yet; full-3 (2026-10-19 22:45:37 and 22:45:38Z) was written down twice with the guard above in the build.
    const lastDeath = [(survival.state.deaths || []).at(-1), lastDeathSeen].filter(Boolean).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0], p = bot.entity?.position;
    const echo = !!lastDeath && Date.now() - Date.parse(lastDeath.at) < 10000 && p && lastDeath.position && Math.hypot(lastDeath.position.x - p.x, lastDeath.position.y - p.y, lastDeath.position.z - p.z) < 2;
    if (echo) { console.log(`[death] the death event came again ${Math.round((Date.now() - Date.parse(lastDeath.at)) / 100) / 10} s after the one recorded, at the same spot: not written down twice`); if (!spawned) { bot.respawn(); return; } stop('recovering').catch(console.error); bot.quit('Respawning after death'); return; }
    const saved = active && !active.idle ? active.goal : store.read();
    recordDeath(bot, survival.state);
    lastDeathSeen = (survival.state.deaths || []).at(-1) || null;
    if (saved && ['pending', 'running', 'recovering'].includes(saved.status)) {
      saved.lastError = 'The bot died; recovering from observed inventory after respawn';
      saved.status = 'recovering';
      saveGoal(saved);
    }
    saveSurvival();
    console.log(JSON.stringify({ death: survival.state.recovery }));
    if (!spawned) { bot.respawn(); return; }
    // Reconnect to discard all old inventory/window promises before respawning.
    // They must not issue a late action against the new life's inventory.
    stop('recovering').catch(console.error);
    // A new build waiting is taken here, where the bot reconnects anyway
    // (quiet-restart.js pendingRestart, note 1994).
    if (!process.env.JEV_NO_QUIET_RESTART && require('./quiet-restart').pendingRestart(path.join(stateDirectory, 'restart-requested'), { port: config.port })) {
      console.log('[restart] asked for, and the bot died: quitting for the new build');
      bot.quit('restart for a new build');
      setTimeout(() => process.exit(0), 500);
      return;
    }
    bot.quit('Respawning after death');
  });
  function close(reason) {
    if (ended) return;
    observation?.detach(String(reason || 'connection closed'));
    ready = false; clearInterval(idleTimer); invalidateRequests();
    reactiveWait?.cancel().catch(() => {});
    if (active && !active.task.cancelled) stop('running').catch(console.error);
    // This connection's saves on disk before a replacement reads state (note 2042): the survival store's save waits up to
    // 1.5 s, the rejoin read the file without the death just recorded, and its own saves then wrote over it. full-2's death
    // of 2026-10-23 06:38:10Z ('the death event came again 1.4 s after the one recorded') and full-3's in the End at
    // 06:0xZ were never on disk; the survival file's last death stayed 04:55 and 04:54, and every question's recent deaths
    // and the bed kit's bare-death count with it.
    for (const s of [store, survivalStore, idleStore]) { try { s.flushSync(); } catch (err) { console.error(`[bug] a store was not flushed at close: ${err.message}`); } }
    // Fence late saves from this connection before a replacement reads state.
    ended = true;
    memory.flush();
    resolveClosed({ reason, spawned, uptimeMs: Date.now() - connectedAt });
  }
  bot.on('end', reason => close(reason));
  bot.on('kicked', reason => console.error('[bot] kicked:', reason));
  bot.on('error', err => console.error('[bot]', err.message));
  return { bot, closed, shutdown() { close('shutdown'); bot.quit('Shutting down'); } };
}

module.exports = { unworkable, createSession };
