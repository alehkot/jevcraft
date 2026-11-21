// Scripted cases for the language layer (src/guide.js) where built things are left alone (JEV_BUILT, src/built.js):
// 12 cases about which wood a wish for wood means and when a player's leave to use the buildings is passed on.
// The same harness as guide-eval.js: each case goes through guide.consult() to the real model. The key is read
// from JEV_GUIDE_API_KEY or OPENAI_API_KEY and never printed.
// usage: node scripts/guide-eval-built.js <model> <reasoning effort, or - for none sent> <runs per case> [temperature]
const fs = require('fs'), os = require('os'), path = require('path');
const { createGuide } = require('../src/guide.js');
const [model, effort, reps = '3', temp] = process.argv.slice(2);
const base = { health: 20, food: 18, dimension: 'overworld', time: 'day', carrying: {}, doing: 'waiting for a request', blocksFromPlayer: 4, dream: null, savedPlaces: ['home'], savedNotes: [] };
// The spawn of the live world, 2026-11-21: birches near, oak only as bushes, a village beside it.
const WOODS = [{ wood: 'birch', trees: 4, nearestTreeBlocks: 16 }, { wood: 'spruce', trees: 3, nearestTreeBlocks: 32 }, { wood: 'oak', trees: 0, singleLogs: 49, nearestLogBlocks: 10 }];
const BUSY = { request: 'Jev get me 16 oak logs', for: 'Sky' };
const none = o => o && o.requests.length === 0, plain = o => o && !o.useBuildings, noRule = o => o && !o.addedRule && !o.forgotRule;
const one = (o, re) => o && o.requests.length === 1 && re.test(o.requests[0]);
const cases = [
  ['wood with no kind named: the nearest trees', [], 'get some wood', { woodInView: WOODS }, o => one(o, /^get me \d+ birch logs?/i) && plain(o)],
  ['the same, said casually', [], 'jev i need wood pls', { woodInView: WOODS }, o => one(o, /birch logs?/i) && plain(o)],
  ['a named wood stays', [], 'get me 10 oak logs', { woodInView: WOODS }, o => one(o, /^get me 10 oak logs?/i) && plain(o)],
  ['only bushes about: the first kind listed', [], 'get wood', { woodInView: [WOODS[2]] }, o => one(o, /oak logs?/i) && plain(o)],
  ['a standing rule beats the list', ['I prefer spruce for anything wooden.'], 'get some wood', { woodInView: WOODS }, o => one(o, /spruce logs?/i) && plain(o)],
  ['leave given with the request', [], 'get 12 oak logs, you can take them from that old house', { woodInView: WOODS }, o => one(o, /12 oak logs?/i) && o.useBuildings === true],
  ['leave for the work in hand', [], 'ok you can take it from the houses', { doing: BUSY, woodInView: WOODS }, o => none(o) && o.useBuildings === true && noRule(o)],
  ['a plain request never sets it', [], 'get me a crafting table and a wooden pickaxe', { woodInView: WOODS }, o => o && o.requests.length >= 1 && plain(o)],
  ['quicker is not a reason', [], 'hurry up with the wood, the village is right there', { doing: BUSY, woodInView: WOODS }, o => plain(o)],
  ['asked to keep off: how it works already', [], "don't break the village houses", { woodInView: WOODS }, o => none(o) && plain(o) && !!o.say],
  ['standing leave applied', ['You may always take wood from buildings.'], 'get me 8 oak logs', { woodInView: WOODS }, o => one(o, /8 oak logs?/i) && o.useBuildings === true],
  ['a question about it is answered', [], 'why did you not take the wood from the house?', { woodInView: WOODS }, o => none(o) && plain(o) && noRule(o) && !!o.say],
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
      const guide = createGuide({ file, fetchImpl, apiKey: process.env.JEV_GUIDE_API_KEY || process.env.OPENAI_API_KEY, model, reasoning: effort === '-' ? undefined : effort, temperature: temp, minGapMs: 0, perHour: 100000, built: true });
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
  console.log(`\n=== ${model} effort=${effort}${temp ? ' temperature=' + temp : ''}: ${total}/${cases.length * reps} passed; latency median ${times[Math.floor(times.length / 2)]} ms, p90 ${times[Math.floor(times.length * 0.9)]} ms, max ${times.at(-1)} ms; per call ${Math.round(usage.in / Math.max(1, usage.n))} tokens in, ${Math.round(usage.out / Math.max(1, usage.n))} out (${Math.round(usage.reasoning / Math.max(1, usage.n))} reasoning)`);
  console.log(rows.filter(r => !r.startsWith(`${reps}/`)).map(r => '  ' + r).join('\n') || '  every case passed every time');
  for (const f of fails.slice(0, 10)) console.log('  FAIL ' + f.slice(0, 420));
  const odd = [...new Set(notes.filter(n => /\[guide\]/.test(n)))]; for (const n of odd.slice(0, 3)) console.log('  NOTE ' + n.slice(0, 200));
})();
