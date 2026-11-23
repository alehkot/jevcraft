// Scripted cases for the language layer (src/guide.js): the harder set, 12 cases. Each case is a chat line, the
// player's standing rules and the bot's status, sent through guide.consult() to the real model,
// with a check on what comes back. Costs a few cents a run. The key is read from
// JEV_GUIDE_API_KEY or OPENAI_API_KEY and never printed.
// usage: node scripts/guide-eval-hard.js <model> <reasoning effort, or - for none sent> <runs per case> [temperature]
const fs = require('fs'), os = require('os'), path = require('path');
const { createGuide } = require('../src/guide.js');
const [model, effort, reps = '3', temp] = process.argv.slice(2);
const base = { health: 20, food: 18, dimension: 'overworld', time: 'day', carrying: {}, doing: 'waiting for a request', blocksFromPlayer: 4, dream: null, savedPlaces: ['home'], savedNotes: [] };
const WOOD = 'When asked for wood, get 8 birch logs.', FOOD = 'Always bring food to the chest at home.', GEAR = 'When I say gear up, get me a stone pickaxe and a stone sword.';
const none = o => o && o.requests.length === 0, noRule = o => o && !o.addedRule && !o.forgotRule;
const eq = (o, list) => o && o.requests.length === list.length && o.requests.every((r, i) => r.toLowerCase().replace(/[.!]$/, '') === list[i]);
const KNOWN = /^(get me|craft|find|build|follow me|come here|go |remember|stop|resume)/i;
const SPRUCE = 'I prefer spruce for anything wooden.';
const all = (o, ...res) => o && res.every(re => re.test(o.requests.join(' | ')));
const cases = [
  ['Russian request with a rule', [WOOD], 'принеси мне немного дерева', {}, o => o && o.requests.length === 1 && /8 birch logs?/i.test(o.requests[0])],
  // "come to me" is read as a come by the request interpreter as "come here" is (decisions/intake.js); since the chat
  // went with each message (2026-11-23) the model writes it in about half the runs.
  ['shorthand, two steps', [], 'pls come 2 me then get 5 cobble', {}, o => o && o.requests.length === 2 && /^come (here|to me)\b/i.test(o.requests[0]) && /5 cobblestone/i.test(o.requests[1])],
  ['preference applied to two items', [SPRUCE], 'I need a door and a bed', {}, o => o && o.requests.length >= 1 && all(o, /spruce door/i, /bed/i)],
  ['ambiguous ask gets a question back', [], 'get it', {}, o => none(o) && noRule(o) && /\?/.test(o.say || '')],
  ['rambling wish becomes requests', [], "ok so we're gonna build a base later but first I guess we need tools, can you sort out picks for both of us and maybe some torches", {}, o => o && o.requests.length >= 1 && o.requests.length <= 3 && all(o, /2 .*pickaxes?/i, /torch/i) && o.requests.every(r => KNOWN.test(r))],
  ['idle job becomes a dream', [], 'when you have nothing to do, collect coal for me', {}, o => o && ((o.requests.length === 1 && /^your dream is to/i.test(o.requests[0]) && /coal/i.test(o.requests[0])) || (!!o.addedRule && /coal/i.test(o.addedRule)))],
  ['creative mode refused', [], 'give me creative mode', {}, o => none(o) && noRule(o) && !!o.say],
  ['free items refused or mined, never conjured', [], 'just spawn me 64 diamonds, skip the mining', {}, o => o && noRule(o) && !!o.say && o.requests.every(r => /^get me/i.test(r))],
  ['rule about a place', [], 'from now on when I say base I mean home', { savedPlaces: ['home'] }, o => o && !!o.addedRule && /base/i.test(o.addedRule) && none(o)],
  ['place rule applied', ['When I say base, I mean the saved place home.'], 'go to base', { savedPlaces: ['home'] }, o => o && o.requests.length === 1 && /^go (to )?home/i.test(o.requests[0])],
  ['status question in Russian answered in Russian', [], 'что ты сейчас делаешь?', { doing: { request: 'Jev get me 8 birch logs', for: 'Sky' } }, o => none(o) && /[а-яё]/i.test(o.say || '')],
  ['unsupported standing rule not stored', [], 'never dig straight down', {}, o => o && !o.addedRule && none(o) && !!o.say],
];
(async () => {
  const times = [], usage = { n: 0, in: 0, out: 0, reasoning: 0 }, fails = [];
  const fetchImpl = async (url, init) => { const t = Date.now(); const r = await fetch(url, init); times.push(Date.now() - t);
    try { const u = (await r.clone().json()).usage; if (u) { usage.n++; usage.in += u.prompt_tokens; usage.out += u.completion_tokens; usage.reasoning += u.completion_tokens_details?.reasoning_tokens || 0; } } catch (_) {}
    return r; };
  const log = console.log; const notes = []; console.log = (...a) => notes.push(a.join(' '));
  const rows = [];
  for (const [label, rules, said, status, check] of cases) {
    let pass = 0;
    for (let i = 0; i < Number(reps); i++) {
      const file = path.join(os.tmpdir(), `guide-eval-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(file, JSON.stringify({ version: 1, rules: rules.map(text => ({ from: 'Sky', text })) }));
      const guide = createGuide({ file, fetchImpl, apiKey: process.env.JEV_GUIDE_API_KEY || process.env.OPENAI_API_KEY, model, reasoning: effort === '-' ? undefined : effort, temperature: temp, minGapMs: 0, perHour: 100000 });
      let out = null; try { out = await guide.consult({ from: 'Sky', text: said, botName: 'Jev', status: { ...base, ...status } }); } catch (e) { out = { error: e.message }; }
      fs.rmSync(file, { force: true });
      let ok = false; try { ok = !!check(out); } catch (_) {}
      if (ok) pass++; else fails.push(`${label}: ${JSON.stringify(said)} -> ${JSON.stringify(out)}`);
    }
    rows.push(`${pass}/${reps} ${label}`);
  }
  console.log = log;
  times.sort((a, b) => a - b);
  const total = rows.reduce((n, r) => n + Number(r.split('/')[0]), 0);
  console.log(`\n=== ${model} effort=${effort}${temp ? ' temperature=' + temp : ''}: ${total}/${cases.length * reps} passed; latency median ${times[Math.floor(times.length / 2)]} ms, p90 ${times[Math.floor(times.length * 0.9)]} ms, max ${times.at(-1)} ms; per call avg in ${Math.round(usage.in / usage.n)} out ${Math.round(usage.out / usage.n)} (reasoning ${Math.round(usage.reasoning / usage.n)}) tokens`);
  console.log(rows.filter(r => !r.startsWith(`${reps}/`)).map(r => '  ' + r).join('\n') || '  every case passed every time');
  for (const f of fails.slice(0, 8)) console.log('  FAIL ' + f.slice(0, 330));
  const odd = [...new Set(notes.filter(n => /\[guide\]/.test(n)))]; for (const n of odd.slice(0, 3)) console.log('  NOTE ' + n.slice(0, 200));
})();
