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
const MAX_RULES = 16, MAX_REQUESTS = 3, TALK_KEPT = 6;

const SYSTEM = bot => `You are the language layer of ${bot}, a companion bot in Minecraft survival. ${bot} plays honest survival: no commands, no cheats, nothing from nowhere. Everything it has was gathered, mined, smelted or crafted by it.

You never act yourself. A separate engine does the work. Your job is to turn what the player said into what that engine understands, following the player's standing rules.

The engine understands these requests (short imperative English, without the bot's name):
- "follow me", "come here"
- "get me <N> <item>": gathers, mines, smelts and crafts whatever is needed and brings it. Examples: "get me 16 oak logs", "get me a stone pickaxe", "get me 8 cooked beef", "get me full iron armor and a shield"
- "craft <N> <item>"
- "find a <biome, creature or structure>"
- "build a small <material> house", "build a cottage", "build a tower"
- "remember this as <place name>", "go to <place name>", "go home"
- "remember that <fact or preference>", "what do you remember"
- "your dream is to <one request>" (a job for when nothing else is asked), "set your dream aside", "chase your dream"
The engine does one request at a time; a new one replaces the work in hand. It cannot do anything else: no guarding a spot, no keeping a distance, no farming on a schedule, no attacking named targets, no giving items it does not have.

Answer with JSON only:
{"say": string or null, "requests": [strings, at most ${MAX_REQUESTS}, done in order], "add_rule": string or null, "forget_rule": number or null}

How to decide:
1. A plain request the engine understands: pass it on unchanged as the only request, "say" null. Apply the standing rules where the request leaves something open (which wood, how many, what to do first or afterwards).
2. A vague or compound wish ("help me get started", "we need to go mining"): break it into at most ${MAX_REQUESTS} requests from the list, in a sensible order, and say in one short line what you will do.
3. A standing instruction ("from now on", "always", "never", "when I say X, do Y", "I want you to ..." about behaviour in general): put it in "add_rule" as one clear sentence, no requests, and confirm in "say". If the engine cannot honour it, say so plainly and do not store it.
4. "Forget rule N" or a clear withdrawal of a listed rule: set "forget_rule" to its number.
5. A question or small talk: answer in "say" from the facts given, in at most 180 characters. Do not invent facts about the world. No requests.
6. Something the engine cannot do: say so in "say" and name the nearest thing it can do. No requests.
Never write anything that starts with "/". Never promise what the engine cannot do. "say" is plain text, friendly and brief, in the player's language.`;

function createGuide({ file, fetchImpl = fetch, apiKey = process.env.JEV_GUIDE_API_KEY,
  url = process.env.JEV_GUIDE_URL || 'https://api.openai.com/v1/chat/completions',
  model = process.env.JEV_GUIDE_MODEL || 'gpt-4.1-mini', timeoutMs = 15000, now = Date.now,
  minGapMs = 1500, perHour = Number(process.env.JEV_GUIDE_PER_HOUR || 60) } = {}) {
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
  const talk = new Map(), calls = new Map();
  const rulesFor = from => state.rules.filter(rule => owner(rule.from) === owner(from));
  const heard = (from, role, text) => {
    const lines = talk.get(owner(from)) || [];
    lines.push({ role, text: clean(text, 240) });
    talk.set(owner(from), lines.slice(-TALK_KEPT));
  };
  // Chat is untrusted and each call costs money: a floor between calls and a cap an hour, per player.
  function allowed(from) {
    const t = now(), mine = (calls.get(owner(from)) || []).filter(at => t - at < 3600000);
    if (mine.length >= perHour || (mine.length && t - mine.at(-1) < minGapMs)) { calls.set(owner(from), mine); return false; }
    mine.push(t); calls.set(owner(from), mine); return true;
  }

  // -> { say, requests, addedRule, forgotRule } or null when the model was not asked or did not answer usably.
  async function consult({ from, text, botName, status = {} }) {
    if (!apiKey || !allowed(from)) return null;
    const rules = rulesFor(from);
    const user = { player: clean(from, 64), said: clean(text, 300),
      standingRules: rules.map((rule, i) => `${i + 1}. ${rule.text}`),
      recentTalk: talk.get(owner(from)) || [], status };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    let parsed;
    try {
      const response = await fetchImpl(url, { method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0.2, max_completion_tokens: 300, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: SYSTEM(botName) }, { role: 'user', content: JSON.stringify(user) }] }) });
      if (!response.ok) { console.log(`[guide] the model answered ${response.status}; the message goes to the interpreter as said`); return null; }
      parsed = JSON.parse((await response.json()).choices?.[0]?.message?.content || 'null');
    } catch (err) { console.log(`[guide] not reached (${err.name}); the message goes to the interpreter as said`); return null; }
    finally { clearTimeout(timer); }
    if (!parsed || typeof parsed !== 'object') return null;
    const requests = (Array.isArray(parsed.requests) ? parsed.requests : []).map(r => clean(r, 160))
      .filter(r => r && !r.startsWith('/')).slice(0, MAX_REQUESTS);
    const out = { say: clean(parsed.say, 200) || null, requests, addedRule: null, forgotRule: null };
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
    heard(from, 'player', text);
    if (out.say) heard(from, 'bot', out.say);
    if (!out.say && !requests.length && !out.addedRule && !out.forgotRule) return null;
    return out;
  }

  return { available: Boolean(apiKey), consult, rulesFor, model };
}

module.exports = { createGuide, SYSTEM };
