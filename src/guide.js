'use strict';
// JEV_GUIDE: a language model in front of the request interpreter, for
// guidance in plain words. It never acts. It reads what a player said, that
// player's standing rules and what the bot is doing, and answers with at most
// three things: a chat line, up to three plain requests for the existing
// interpreter (fed in as if that player had said them, one after another),
// and a standing rule to keep or forget. It cannot run commands: a request is
// only text for the interpreter, which has its own gates (MC_COMMAND_USERS,
// JEV_COOPERATION).
//
// Any OpenAI-compatible chat-completions endpoint works (JEV_GUIDE_URL). Off
// unless JEV_GUIDE_API_KEY is set. If the model cannot be reached the message
// goes to the interpreter as it was said, so the bot is never deaf.
//
// The shape (a planner above Jev that emits goals) is alexrmsouza/jevcraft's
// and rkhazh/jevcraft's; none of their code is used.
const fs = require('node:fs'), path = require('node:path');

const clean = (value, size = 200) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, size) : '';
const owner = name => clean(String(name || ''), 64).toLowerCase();
const MAX_RULES = 16, MAX_REQUESTS = 3, MAX_OPTIONS = 3, CHAT_KEPT = 24, CHAT_MS = 15 * 60000;

// JEV_PERSONALITY: how "say" sounds, the three manners of alexrmsouza/jevcraft
// e244c34d's personality.js. Unset: the instructions as measured (.env.example).
const PERSONALITIES = {
  __proto__: null,
  reserved: 'Speak briefly and calmly. Keep to what the player needs: no jokes, no filler, no question that is not needed.',
  companion: 'Be cooperative, curious and conversational, with light humor now and then when it fits. Ask a useful question when a preference or a missing fact changes the task.',
  playful: 'Be cooperative and lightly playful: a short joke about the situation now and then, never in place of useful information or while the player is in danger, and no catchphrase twice.',
};
// What the engine understands: the list both the reading of a message (SYSTEM) and the look over the chat (OBSERVE) offer from.
const ENGINE = bot => `The engine understands these requests (short imperative English, without the bot's name):
- "follow me", "come here", "come to me by boat", "climb up the ladder", "climb down the ladder", "light up this area", "light up the whole area" (torches on the dark ground within 16 blocks, so monsters do not spawn there)
- "continue" (takes up again the newest work in status.setAside, where it was left), "continue building the house" (takes up again the building in status.setAside or status.unfinishedBuilds, where it stands; never a new one). For any wish to carry on with or finish earlier work, emit one of these and name in "say" what and where it is.
- "protect me": stays with the player like "follow me" and fights the monsters that come at them or hurt them, until "stop". "Guard me", "keep me safe", "watch my back", "defend me from the zombies" and the like all mean "protect me".
- "stay close to me" (12 blocks), "stay within <N> blocks of me" (N is any whole number of blocks the player names, small or large: "stay max 50 blocks away", "no more than 50 blocks from me" and "50 blocks is fine" said of how close to stay all mean "stay within 50 blocks of me"), "stop staying close" (free to roam again), "stay-close status". These are persistent movement controls alongside the current job; status.stayClose says the one in force. For a combined request, emit the control first and the job second.
- "stop" (drop the work in hand and wait), "resume" (take up again the last request if status.lastRequest shows it ended as cancelled, interrupted or blocked; the engine resumes without a word, so with "resume" always add a short "say" naming what is taken up again)
- "get me <N> <item>": gathers, mines, smelts and crafts whatever is needed and brings it. Examples: "get me 16 oak logs", "get me a stone pickaxe", "get me 8 cooked beef", "get me full iron armor and a shield"
- "craft <N> <item>"
- "find a <biome, creature, block or structure>"
- "build a starter house for two people", "build a starter house for three people", "build a small <material> house", "build a cottage", "build a tower". "Help me build a house" is one actual build request. Keep the requested number of people or beds and any requested material. If the player leaves the wood open, let the builder use local wood.
- "remember this as <place name>", "set home here", "go to <place name>", "go home", "go to your respawn point". Use status.locations for home, the effective respawn and last observed landing.
- "install a door in the house", "add windows and torches to the house", "add a sofa and a chest to the house", "furnish the house". A reminder like "you forgot the door" asks to install it in the nearby house Jev built. Keep an explicit request to craft a door as an item. A standard house has two rooms under a roof, doors, beds, glass windows, torches, a stair sofa and a chest. Preserve custom design and biome requests for the schematic designer.
- "remember that <fact or preference>", "what do you remember"
- "your dream is to <one request>" (a job for when nothing else is asked), "set your dream aside", "chase your dream"
The engine does one job at a time. Stay-close controls leave that job running. A job can have a location, for example "craft a chest beside the nearest crafting table" or "build a house next to the block I am pointing at". Preserve location clauses and the speaker's point of view. Guarding a spot with nobody there, scheduled farming and attacking a named target are outside the engine's abilities; protecting the player is not ("protect me").`;
const SYSTEM = (bot, { built = false, personality = null } = {}) => `You are the language layer of ${bot}, a companion bot in Minecraft survival. ${bot} plays honest survival: no commands, no cheats, nothing from nowhere. Everything it has was gathered, mined, smelted or crafted by it.

You never act yourself. A separate engine does the work. Your job is to turn what the player said into what that engine understands, following the player's standing rules. Read it against recentChat, the game chat so far, oldest first: who said each line (the bot's own under its name), how many seconds ago, and toBot when it was said to the bot. A short message often answers what the bot said last ("50 blocks are fine" after the bot said how close it stays is a stay-close distance), and "do it" or "help him" can point at what the players were just saying to each other. A line not said to the bot is never a request in itself: it only helps to understand this message.

${ENGINE(bot)}

Answer with JSON only:
{"say": string or null, "requests": [strings, at most ${MAX_REQUESTS}, done in order], "options": [{"label": string, "requests": [strings]}, at most ${MAX_OPTIONS}] or null, "add_rule": string or null, "forget_rule": number or null${built ? ', "use_buildings": true or false' : ''}}

How to decide:
1. A plain request the engine understands: pass it on unchanged as the only request, "say" null. Apply the standing rules where the request leaves something open (which wood, how many, what to do first or afterwards).${built ? ` Wood or logs wanted with no kind named and no rule about it: name the first kind in status.woodInView that has trees (the free wood near ${bot}, the nearest trees first; a kind with "trees": 0 is only bushes of one log each), or with no trees listed the first kind there, or with no list oak.` : ''}
2. A vague or compound wish ("help me get started", "we need to go mining"): break it into at most ${MAX_REQUESTS} requests from the list, each in the list's own words ("come here", not "come to me"), in a sensible order, and say in one short line what you will do.
3. Handle staying close using the movement controls above, including "always stay near me". For other standing instructions ("when I say X, do Y"), use "add_rule" for the meaning of words, materials, quantities or sequence. Confirm it in "say". Rules about combat and digging behaviour cannot be honoured (a wish to be protected is the request "protect me", not a rule).${built ? ' For permissions to use buildings see (8).' : ''}
4. "Forget rule N" or a clear withdrawal of a listed rule: set "forget_rule" to its number.
5. A question or small talk: answer in "say" from the facts given, in at most 180 characters. Do not invent facts about the world. No requests.
6. Something the engine cannot do: say so in "say" and name the nearest thing it can do. No requests. A number is never the reason: the counts, sizes and distances in a request on the list are the player's to choose.
7. A job for idle time ("when you have nothing to do, collect coal"): that is a dream. Emit "your dream is to get me <N> <item>" yourself, with a sensible amount such as one stack, and say what you set. Never tell the player how to phrase something you can emit yourself.
${built ? `8. What someone built is left alone by the engine: it takes wood, stone and the rest from the wild, and never from a house, a village, a fence, a wall or anything else made by players or villagers. When the only source in view is built it says so and looks further. "use_buildings" is false unless the player clearly allows taking from buildings, in this message or in a standing rule ("take the wood from that house", "you can break the village houses", "use the buildings"): then true. With requests in the answer it covers those requests; with none it covers the work in hand (status.doing), and "say" confirms it. A plain request ("get wood") never sets it, and you never set it because it would be quicker. A standing rule that allows it ("you may always take wood from buildings") is stored like any other and applied to each request. Asked not to touch buildings: say that is how ${bot} works already, no rule needed.
` : ''}Choices: when a wish could mean two or three different jobs the engine can do, or the nearest job it can do is not quite what was asked, offer them rather than pick one: put them in "options", each {"label": a few words, "requests": what it runs}, with only the question in "say" (the options are listed after it by number and the player answers with the number), and no requests. A single likely meaning is one option, answered with yes. Details are never choices: an amount, a kind of wood or anything else a request leaves open is filled in as rule 1 and the facts say. A clear request is acted on, never offered back as a choice.
Never write anything that starts with "/". Never promise what the engine cannot do. "say" is plain text, friendly and brief, in the player's language.${PERSONALITIES[personality] ? ` ${PERSONALITIES[personality]} The manner is for "say" only: it never changes the requests.` : ''}`;

// The requests a model answer may hold: plain text, none a command, at most MAX_REQUESTS.
const requestsOf = list => (Array.isArray(list) ? list : []).map(r => clean(r, 160)).filter(r => r && !r.startsWith('/')).slice(0, MAX_REQUESTS);
// Choices, each with the requests it runs (the pick is read by session.js, pickOption).
const optionsOf = list => (Array.isArray(list) ? list : []).map(o => ({ label: clean(o?.label, 40), requests: requestsOf(o?.requests) }))
  .filter(o => o.label && o.requests.length).slice(0, MAX_OPTIONS);
// The question with its choices by number, as said; one choice is a yes question.
function withOptions(say, options) {
  const question = clean(say || (options.length === 1 ? options[0].label + '?' : 'Which one?'), 120);
  return options.length === 1 ? question + ' (say yes)'
    : /(^|\s)1[).:]/.test(question) ? question : question + ' ' + options.map((o, i) => (i + 1) + ') ' + o.label).join(' ') + ' (say ' + (options.length === 2 ? '1 or 2' : '1, 2 or 3') + ')';
}
// JEV_GUIDE_HEAR=all: the guide reads every player's line, not only those to the bot (asked for 2026-11-23: "reading chat
// that isn't addressed to jev is fine"). JEV_GUIDE_SPEAK=unasked: the bot may speak up unasked ("and that's fine for jev
// to speak when unasked"): offers the players choose from, never work begun on its own.
const hearsAll = (env = process.env) => String(env?.JEV_GUIDE_HEAR || '').trim().toLowerCase() === 'all';
const speaksUnasked = (env = process.env) => String(env?.JEV_GUIDE_SPEAK || '').trim().toLowerCase() === 'unasked';

// The look over the chat (observe): whether the bot should speak up unasked, and with what offer.
const OBSERVE = (bot, { personality = null } = {}) => `You are the language layer of ${bot}, a companion bot in Minecraft survival, and you keep an eye on the game chat. ${bot} plays honest survival: no commands, no cheats; everything it has, it gathered, mined, smelted or crafted.

You never act yourself. A separate engine does the work, and ${bot} does only what a player asks or chooses. You are called now and then, when the chat has gone quiet for a moment, with recentChat (the game chat so far, oldest first: who said each line, ${bot}'s own under its name, how many seconds ago, and toBot when it was said to ${bot}), the players online with their standing rules, and ${bot}'s status.

Decide whether ${bot} should speak up unasked. Most of the time it should not: then answer {"say": null, "options": null}. It speaks up only when the chat makes one of these clear:
- A player wants or needs something the engine can do and has not asked ${bot} for it ("we need more wood", "I'm starving", "I wish we had a house"): offer it.
- ${bot} and a player misunderstood each other, or a player could not get ${bot} to do something the engine can do: offer what was meant.
- The players agreed on a plan ${bot} can help with: offer its next step.
- Something in the status matters now and a player may not have seen it (night is coming and a player said they have no shelter or weapon; ${bot} carries food and a player is hungry): one short line, with an offer when there is one.
Never offer what a player or ${bot} is already doing (status.doing), anything ${bot} offered or said in recentChat, or anything a player turned down. Never answer a line said to ${bot} (toBot): it has had its answer. What the players say to each other is never a request to ${bot}: you only offer, and a player chooses.

${ENGINE(bot)}

Answer with JSON only:
{"say": string or null, "options": [{"label": a few words, "requests": [requests from the list above, at most ${MAX_REQUESTS}, done in order]}, at most ${MAX_OPTIONS}] or null}
"say" is one short line, at most 140 characters, friendly and plain, in the players' language, naming the player it is for. With options "say" is only the question: the options are listed after it by number and a player answers with the number; a single option is a yes question. Apply a player's standing rules to what is offered to them. Never write anything that starts with "/". Never promise what the engine cannot do.${PERSONALITIES[personality] ? ` ${PERSONALITIES[personality]}` : ''}`;

function createGuide({ file, fetchImpl = fetch, apiKey = process.env.JEV_GUIDE_API_KEY,
  url = process.env.JEV_GUIDE_URL || 'https://api.openai.com/v1/chat/completions',
  model = process.env.JEV_GUIDE_MODEL || 'gpt-6.1-terra', timeoutMs = 15000, now = Date.now,
  // Sent only when set: newer models take no temperature but their default and name their own
  // reasoning efforts (gpt-6-luna and gpt-6.1-terra, 2026-11-20: none, low, medium, high, xhigh).
  temperature = process.env.JEV_GUIDE_TEMPERATURE, reasoning = process.env.JEV_GUIDE_REASONING ?? 'low',
  // Reasoning is paid from the same budget as the answer; a short one cuts the JSON off.
  maxTokens = Number(process.env.JEV_GUIDE_MAX_TOKENS || 600),
  minGapMs = 1500, perHour = Number(process.env.JEV_GUIDE_PER_HOUR || 60),
  // JEV_GUIDE_SPEAK=unasked: looks over the chat, at most one a minute and a half and twelve an hour.
  observeGapMs = 90000, observePerHour = Number(process.env.JEV_GUIDE_LOOKS_PER_HOUR || 12),
  // Whether the engine leaves built things alone (built.js): the layer is told so, and may pass on a player's leave.
  built = require('./built').on(), personality = process.env.JEV_PERSONALITY } = {}) {
  const manner = String(personality || '').trim().toLowerCase();
  if (manner && !PERSONALITIES[manner]) console.log(`[guide] JEV_PERSONALITY=${clean(manner, 32)} is not ${Object.keys(PERSONALITIES).join(', ')}; the instructions are left as they are`);
  let state = { version: 1, rules: [] };
  if (file && fs.existsSync(file)) {
    try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.version === 1 && Array.isArray(saved.rules)) state = saved; }
    catch (_) { /* an unreadable rules file starts empty rather than stopping the bot */ }
  }
  const save = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state) + '\n'); fs.renameSync(`${file}.tmp`, file);
  };
  const chat = [], calls = new Map(), looks = [], refused = new Set();
  const rulesFor = from => state.rules.filter(rule => owner(rule.from) === owner(from));
  // The game chat as the bot hears it (session.js notes the players' lines and the bot's own, and the replies are
  // noted here too): who said each line, toBot when it was said to the bot, bot when the bot said it. With
  // JEV_GUIDE_HEAR=all every player's line, else the lines to the bot and the answers to its questions. In memory only:
  // the last CHAT_KEPT lines of the last quarter hour. The same line again from the same speaker within three seconds is
  // one line (a reply is noted here and again as it is said). -> the line kept, or null.
  const note = (speaker, text, { toBot = false, bot = false } = {}) => {
    const line = clean(text, 240), who = clean(String(speaker || ''), 64), at = now(), last = chat.at(-1);
    if (!line || !who) return null;
    if (last && last.speaker === who && last.text === line && at - last.at < 3000) { if (toBot) last.toBot = true; return last; }
    const entry = { speaker: who, text: line, at, ...(toBot && { toBot: true }), ...(bot && { bot: true }) };
    chat.push(entry);
    if (chat.length > CHAT_KEPT) chat.splice(0, chat.length - CHAT_KEPT);
    return entry;
  };
  // The chat as sent to the model, oldest first, without the line being read (skip).
  const recentChat = (skip = null) => chat.filter(l => l !== skip && now() - l.at <= CHAT_MS)
    .map(l => ({ from: l.speaker, text: l.text, secondsAgo: Math.max(0, Math.round((now() - l.at) / 1000)), ...(l.toBot && { toBot: true }) }));
  // The player's own line among them: the newest from them with these words, said within the last half minute.
  const lineOf = (from, text) => { const said = clean(text, 240); return [...chat].reverse().find(l => !l.bot && owner(l.speaker) === owner(from) && l.text === said && now() - l.at < 30000) || null; };
  // Chat is untrusted and each call costs money: a floor between calls and a cap an hour, per player.
  function allowed(from) {
    const t = now(), mine = (calls.get(owner(from)) || []).filter(at => t - at < 3600000);
    if (mine.length >= perHour || (mine.length && t - mine.at(-1) < minGapMs)) { calls.set(owner(from), mine); return false; }
    mine.push(t); calls.set(owner(from), mine); return true;
  }

  // One call to the model: -> the JSON object it answered, or null (said in the log, with what follows from it: failing).
  async function ask(system, user, failing) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    const fallsThrough = why => { console.log(`[guide] ${why}; ${failing}`); return null; };
    // The service's own words for a refusal, for the log. A refused key is quoted back in part by
    // the service: nothing that looks like a key is ever written out.
    const said = message => clean(String(message || 'no reason given'), 200).split(apiKey).join('<key>')
      .replace(/[A-Za-z0-9_*-]{12,}/g, word => (word.includes('*') || (word.length >= 20 && /\d/.test(word) && /[A-Za-z]/.test(word)) ? '<key>' : word)).slice(0, 160);
    let parsed;
    try {
      const body = { model, max_completion_tokens: maxTokens, response_format: { type: 'json_object' },
        ...(temperature !== undefined && temperature !== '' && { temperature: Number(temperature) }),
        ...(reasoning && { reasoning_effort: reasoning }),
        messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) }] };
      let reply;
      // A setting this model does not take is left out from then on and the call made again, so one
      // wrong line in .env does not leave the layer silently off.
      for (let attempt = 0; attempt < 3 && !reply; attempt++) {
        for (const param of refused) delete body[param];
        const response = await fetchImpl(url, { method: 'POST', signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (response.ok) { reply = await response.json(); break; }
        const problem = await response.json().catch(() => null), reason = said(problem?.error?.message);
        // Named in the error's param by the newer models, only in its words by the older ones.
        const param = ['temperature', 'reasoning_effort'].find(name => problem?.error?.param === name || reason.includes(name));
        if (response.status === 400 && param && !refused.has(param) && param in body) {
          refused.add(param);
          console.log(`[guide] ${model} does not take ${param} as set (${reason}); left out from now on`);
          continue;
        }
        return fallsThrough(`${model} answered ${response.status} (${reason})`);
      }
      const choice = reply?.choices?.[0];
      if (!choice?.message?.content) return fallsThrough(`${model} gave no answer (finish: ${choice?.finish_reason || 'none'})`);
      if (choice.finish_reason === 'length') return fallsThrough(`${model}'s answer was cut off at ${maxTokens} tokens (JEV_GUIDE_MAX_TOKENS)`);
      try { parsed = JSON.parse(choice.message.content); }
      catch (_) { return fallsThrough(`${model}'s answer was not JSON`); }
    } catch (err) { return fallsThrough(`${model} not reached (${err.name === 'AbortError' ? `no answer in ${timeoutMs / 1000} s` : err.name})`); }
    finally { clearTimeout(timer); }
    return parsed && typeof parsed === 'object' ? parsed : null;
  }

  // -> { say, requests, addedRule, forgotRule, useBuildings? } or null when the model was not asked or did not answer usably.
  async function consult({ from, text, botName, status = {} }) {
    if (!apiKey || !allowed(from)) return null;
    const rules = rulesFor(from);
    const user = { player: clean(from, 64), said: clean(text, 300),
      standingRules: rules.map((rule, i) => `${i + 1}. ${rule.text}`),
      recentChat: recentChat(lineOf(from, text)), status };
    const parsed = await ask(SYSTEM(botName, { built, personality: manner }), user, 'the message goes to the interpreter as said');
    if (!parsed || typeof parsed !== 'object') return null;
    // Choices, each with the requests it runs: offered in place of requests, the pick read by session.js (pickOption).
    const options = optionsOf(parsed.options);
    const requests = options.length ? [] : requestsOf(parsed.requests);
    // A chat line that begins with a slash is sent by the client as a command. The model's line never is one.
    const out = { say: clean(clean(parsed.say, 240).replace(/^[\s/]+/, ''), 200) || null, requests, addedRule: null, forgotRule: null,
      ...(built && parsed.use_buildings === true && { useBuildings: true }) };
    if (options.length) { out.options = options; out.say = withOptions(out.say, options); }
    const add = clean(parsed.add_rule, 200);
    if (add && !add.startsWith('/')) {
      state.rules.push({ from: clean(from, 64), text: add, at: new Date(now()).toISOString() });
      const mine = rulesFor(from);
      for (const old of mine.slice(0, Math.max(0, mine.length - MAX_RULES))) state.rules.splice(state.rules.indexOf(old), 1);
      save(); out.addedRule = add;
    }
    const n = Number(parsed.forget_rule);
    if (Number.isInteger(n) && n >= 1 && n <= rules.length) {
      state.rules.splice(state.rules.indexOf(rules[n - 1]), 1); save(); out.forgotRule = rules[n - 1].text;
    }
    // The player's line is noted by session.js as it is said; the reply here, and again (as one) as it is said.
    if (out.say) note(botName, out.say, { bot: true });
    if (!out.say && !requests.length && !out.addedRule && !out.forgotRule && !out.useBuildings) return null;
    return out;
  }

  // JEV_GUIDE_SPEAK=unasked: whether a look over the chat may be had now (at most one in observeGapMs, observePerHour an hour).
  const observeReady = () => { const t = now(); return looks.filter(at => t - at < 3600000).length < observePerHour && !(looks.length && t - looks.at(-1) < observeGapMs); };
  // A look over the chat when it has gone quiet (session.js): what the bot might say unasked. -> { say, options? } or null.
  async function observe({ botName, status = {}, players = [] }) {
    if (!apiKey || !observeReady()) return null;
    const lines = recentChat();
    if (!lines.some(l => owner(l.from) !== owner(botName))) return null;
    const t = now(); looks.push(t); while (looks.length && t - looks[0] >= 3600000) looks.shift();
    const online = players.map(p => clean(p, 64)).filter(Boolean);
    const user = { players: online, standingRules: state.rules.filter(r => online.some(p => owner(p) === owner(r.from))).map(r => r.from + ': ' + r.text),
      recentChat: lines, status };
    const parsed = await ask(OBSERVE(botName, { personality: manner }), user, 'nothing is said unasked');
    if (!parsed) return null;
    const options = optionsOf(parsed.options), say = clean(clean(parsed.say, 240).replace(/^[\s/]+/, ''), 160) || null;
    if (!say && !options.length) return null;
    const out = options.length ? { say: withOptions(say, options), options } : { say };
    note(botName, out.say, { bot: true });
    return out;
  }

  return { available: Boolean(apiKey), consult, observe, observeReady, rulesFor, model, note };
}

// The player's pick among the choices offered (out.options): the option, or null when the line is not a pick. A
// number, "the second", the label itself, or yes to a single one; a long line that starts with a number is not one.
const ORDINAL = { first: 0, one: 0, second: 1, two: 1, third: 2, three: 2 };
// Yes and nothing else: "ok get me 16 oak logs" is a new request, not a yes (the whole line, so it runs through).
const CONSENT = /^(?:(?:yes|yeah|yep|yup|ya|sure|ok|okay|please|do it|go ahead|go for it|sounds good|that one|right|correct|alright|all right)[\s,!.]*)+$/;
// No to every choice offered: the bot lets the question go.
const declines = text => /^(?:no|nope|nah|neither|neither of them|none|none of them|never ?mind|forget it|no thanks?(?: you)?)$/.test(String(text || '').toLowerCase().trim().replace(/[.!?,]+$/, '').trim());
function pickOption(text, options = []) {
  const s = String(text || '').toLowerCase().trim().replace(/[.!?]+$/, '').trim();
  if (!s || !options.length) return null;
  let m = s.length <= 12 && /^(?:option |number |no\.? |#)?([1-9])(?:\)| please| one)?$/.exec(s);
  if (m) return options[Number(m[1]) - 1] || null;
  m = /^(?:the )?(first|second|third)(?: one)?(?: please)?$/.exec(s) || /^(one|two|three)$/.exec(s);
  if (m) return options[ORDINAL[m[1]]] || null;
  if (options.length === 1 && CONSENT.test(s)) return options[0];
  return options.find(o => o.label.toLowerCase() === s) || null;
}

module.exports = { createGuide, SYSTEM, OBSERVE, PERSONALITIES, pickOption, declines, hearsAll, speaksUnasked, withOptions };
