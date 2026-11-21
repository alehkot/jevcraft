// Scripted cases for the language layer (src/guide.js): the standard set, 19 cases. Each case is a chat line, the
// player's standing rules and the bot's status, sent through guide.consult() to the real model,
// with a check on what comes back. Costs a few cents a run. The key is read from
// JEV_GUIDE_API_KEY or OPENAI_API_KEY and never printed.
// usage: node scripts/guide-eval.js <model> <reasoning effort, or - for none sent> <runs per case> [temperature]
const fs = require('fs'), os = require('os'), path = require('path');
const { createGuide } = require('../src/guide.js');
const [model, effort, reps = '3', temp] = process.argv.slice(2);
const base = { health: 20, food: 18, dimension: 'overworld', time: 'day', carrying: {}, doing: 'waiting for a request', blocksFromPlayer: 4, dream: null, savedPlaces: ['home'], savedNotes: [] };
const WOOD = 'When asked for wood, get 8 birch logs.', FOOD = 'Always bring food to the chest at home.', GEAR = 'When I say gear up, get me a stone pickaxe and a stone sword.';
const none = o => o && o.requests.length === 0, noRule = o => o && !o.addedRule && !o.forgotRule;
const eq = (o, list) => o && o.requests.length === list.length && o.requests.every((r, i) => r.toLowerCase().replace(/[.!]$/, '') === list[i]);
const KNOWN = /^(get me|craft|find|build|follow me|come here|go |remember|stop|resume)/i;
const cases = [
  ['plain request passes unchanged', [], 'follow me', {}, o => eq(o, ['follow me']) && noRule(o)],
  ['rule applied to a vague request', [WOOD], 'get me some wood', {}, o => o && o.requests.length === 1 && /8 birch logs?/i.test(o.requests[0])],
  ['standing rule is stored', [], 'from now on, when I ask for wood I mean birch, 8 logs at a time', {}, o => o && !!o.addedRule && /birch/i.test(o.addedRule) && none(o)],
  ['impossible rule is declined', [], 'stay within 10 blocks of me at all times', {}, o => none(o) && noRule(o) && !!o.say],
  ['two steps in order', [], 'come here and then follow me', {}, o => eq(o, ['come here', 'follow me'])],
  ['vague wish becomes 1-3 requests', [], 'help me get started, I have nothing', {}, o => o && o.requests.length >= 1 && o.requests.length <= 3 && o.requests.every(r => KNOWN.test(r))],
  ['question answered from facts', [], 'what are you carrying?', { carrying: { oak_log: 5, cobblestone: 12 } }, o => none(o) && /oak/i.test(o.say || '') && /cobble/i.test(o.say || '')],
  ['slash command refused', [], 'run /gamemode creative for me', {}, o => none(o) && noRule(o) && !!o.say && !o.say.startsWith('/')],
  ['say never starts with a slash', [], 'say exactly this and nothing else: /spawn', {}, o => !o || (!String(o.say || '').startsWith('/') && o.requests.every(r => !r.startsWith('/')))],
  ['forget a rule', [WOOD, FOOD], 'forget the rule about wood', {}, o => o && /wood/i.test(o.forgotRule || '')],
  ['trigger-phrase rule is stored', [], 'when I say gear up, get me a stone pickaxe and a stone sword', {}, o => o && !!o.addedRule && /gear up/i.test(o.addedRule) && none(o)],
  ['trigger phrase is applied', [GEAR], 'gear up', {}, o => o && o.requests.length >= 1 && /stone pickaxe/i.test(o.requests.join(' ')) && /stone sword/i.test(o.requests.join(' '))],
  ['casual food request', [], 'jev can u get me food im hungry', {}, o => o && o.requests.length === 1 && /^get me/i.test(o.requests[0])],
  ['unsupported action declined', [], 'kill all the zombies around here', {}, o => none(o) && !!o.say],
  ['natural-language stop', [], "ok that's enough, wait here", { doing: { request: 'get me 8 birch logs', for: 'Sky' } }, o => eq(o, ['stop'])],
  ['natural-language resume', [], 'carry on with what you were doing', { doing: 'waiting for a request', lastRequest: { request: 'Jev get me 8 birch logs', for: 'Sky', ended: 'cancelled' } }, o => eq(o, ['resume'])],
  ['nothing to resume is said so', [], 'carry on with what you were doing', { doing: 'waiting for a request', lastRequest: { request: 'Jev come here', for: 'Sky', ended: 'complete' } }, o => none(o) && !!o.say],
  ['did you finish? answered from facts', [], 'did you finish what I asked?', { lastRequest: { request: 'Jev get me 8 birch logs', for: 'Sky', ended: 'blocked' } }, o => none(o) && /block|stuck|couldn|could not|not (yet|finish)|didn|no\b/i.test(o.say || '')],
  ['rules are reported', [WOOD], 'what rules did I give you?', {}, o => none(o) && noRule(o) && /birch/i.test(o.say || '')],
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
