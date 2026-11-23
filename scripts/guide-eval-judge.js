// Scripted cases for the judge of lines said without the bot's name (src/guide.js judge; JEV_GUIDE_SPEAK=unasked),
// asked for 2026-11-23: the bot answers only what is meant for it, a reply or a follow-up to its talk with a player
// included, and leaves the players' talk among themselves alone. Each case is the chat so far and one line, sent to the
// real model. A line taken wrongly (false positive) sets the bot to work nobody asked for and counts first; a line
// missed is left for the player to say again with the name. Costs a cent or two a run. The key is read from
// JEV_GUIDE_API_KEY or OPENAI_API_KEY and never printed.
// 26 cases scored, 4 shown only.
// usage: node scripts/guide-eval-judge.js <model> <reasoning effort, or - for none sent> <runs per case>
const { createGuide } = require('../src/guide.js');
const [model, effort, reps = '3'] = process.argv.slice(2);
const P = (who, text, toBot) => [who, text, toBot ? { toBot: true } : {}], J = text => ['Jev', text, { bot: true }];
const TWO = [{ name: 'Sky', blocks: 9 }, { name: 'Robin', blocks: 6 }], ONE = [{ name: 'Robin', blocks: 6 }];
// [label, meant for the bot (true, false, or null when either is fine), players, chat before the line, [who, line]]
const cases = [
  ['continues: 50 blocks are fine', true, TWO, [P('Robin', 'stay close to me', true), J("I aim to stay within 12 blocks of Robin. We're 13 blocks apart.")], ['Robin', '50 blocks are fine']],
  ['why not, after a refusal', true, TWO, [P('Sky', 'stay max 50 bloxks away', true), J("Sorry, I can't do that. I can stay close to you (12 blocks).")], ['Sky', 'why not?']],
  ['and some coal too', true, TWO, [P('Robin', 'get me 16 oak logs', true), J('On it: 16 oak logs.')], ['Robin', 'and some coal too']],
  ['the birch one', true, TWO, [P('Robin', 'get me some planks', true), J('Which wood, Robin: oak or birch?')], ['Robin', 'the birch one']],
  ['where did you go', true, TWO, [P('Robin', 'follow me', true), J('Following you, Robin.'), J('Off to make a stone sword to carry; back soon.')], ['Robin', 'where did you go??']],
  ['alone, asks whoever hears', true, ONE, [P('Robin', 'brb')], ['Robin', 'can someone get me some wood']],
  ['names the bot at the end, Sky online', true, TWO, [P('Robin', 'dad look at this')], ['Robin', 'come here jev']],
  ['continues, in Russian', true, TWO, [P('Robin', 'держись рядом со мной', true), J("I aim to stay within 12 blocks of Robin. We're 13 blocks apart.")], ['Robin', '50 блоков нормально']],
  ['no, a spruce one', true, TWO, [P('Sky', 'craft me a door', true), J('Crafting an oak door.')], ['Sky', 'no, a spruce one']],
  ["yes to the bot's offer, nobody else spoke", true, TWO, [J('Robin, want me to get you some food? (say yes)')], ['Robin', 'yes']],
  ['to Sky, his name last', false, TWO, [J('Following you, Robin.')], ['Robin', 'come see my house Sky']],
  ["answers Sky's question", false, TWO, [J('Following you, Robin.'), P('Sky', 'Robin where are you?')], ['Robin', 'at the lake']],
  ["the players' plan", false, TWO, [P('Sky', 'lets build a house by the lake')], ['Robin', 'yes and a tower next to it']],
  ['a need between the players', false, TWO, [P('Robin', 'im so hungry')], ['Sky', 'same, we have no food left']],
  ['wood talk between the players', false, TWO, [P('Sky', 'we need more wood for the house')], ['Robin', 'yeah lots of planks']],
  ['about the bot, to Robin', false, TWO, [P('Robin', 'mom did you see jev fall in the lava lol')], ['Sky', 'is jev ok? he is so slow today']],
  ['answers Sky right after the bot spoke', false, TWO, [J("I've made a stone sword to carry."), P('Sky', 'Robin want to go mining?')], ['Robin', 'sure, after this']],
  ["yes with the bot's and Sky's questions open", false, TWO, [J('Robin, want me to get you some food? (say yes)'), P('Sky', 'Robin, are you coming to the cave?')], ['Robin', 'yes']],
  ['small talk after a request', false, TWO, [P('Robin', 'get me 8 oak logs', true), J('On it: 8 oak logs.'), P('Sky', 'lol the pig is stuck')], ['Robin', 'haha it is, look at it go']],
  ['asks Sky, his name last, after talk with the bot', false, TWO, [P('Robin', 'follow me', true), J('Following you, Robin.')], ['Robin', 'can you give me your sword dad']],
  ['can someone get wood, two players talking', false, TWO, [P('Sky', 'we should start the house')], ['Robin', 'can someone get wood?']],
  ["asks Sky about the bot's offer", false, TWO, [J('Robin, want me to stay within 50 blocks of you? (say yes)')], ['Robin', 'should i say yes mom?']],
  ["answers Sky's question with an order", false, TWO, [P('Robin', 'follow me', true), J('Following you, Robin.'), P('Sky', 'what should I do?')], ['Robin', 'get the wood']],
  ['to Sky too, his name last, while asking the bot', false, TWO, [P('Robin', 'get me 8 oak logs', true), J('On it: 8 oak logs.')], ['Robin', 'you come too dad']],
  ["answers the bot's question past Sky's lol", true, TWO, [J('Which wood, Robin: oak or birch?'), P('Sky', 'lol')], ['Robin', 'birch']],
  ['alone and hungry', null, ONE, [], ['Robin', 'im so hungry']],
  ["Sky answers the bot's offer to Robin", null, TWO, [J('Robin, want me to get you some food? (say yes)')], ['Sky', 'yes he is hungry']],
  ['praise with the name in it', null, TWO, [J("I've made a stone sword to carry.")], ['Robin', 'nice one jev']],
  ['alone, help with zombies about', null, ONE, [J('Following you, Robin.')], ['Robin', 'help!! zombies']],
];
(async () => {
  const times = [], usage = { n: 0, in: 0, out: 0, reasoning: 0 };
  const fetchImpl = async (url, init) => { const t = Date.now(); const r = await fetch(url, init); times.push(Date.now() - t);
    try { const u = (await r.clone().json()).usage; if (u) { usage.n++; usage.in += u.prompt_tokens; usage.out += u.completion_tokens; usage.reasoning += u.completion_tokens_details?.reasoning_tokens || 0; } } catch (_) {}
    return r; };
  const log = console.log; const notes = []; console.log = (...a) => notes.push(a.join(' '));
  const rows = [], wrong = [];
  let falsePos = 0, misses = 0, scoredTrue = 0, scoredFalse = 0;
  for (const [label, want, players, before, [from, said]] of cases) {
    let ok = 0; const seen = [];
    for (let i = 0; i < Number(reps); i++) {
      let t = 1000000;
      const guide = createGuide({ file: null, fetchImpl, now: () => t, apiKey: process.env.JEV_GUIDE_API_KEY || process.env.OPENAI_API_KEY, model, judgeModel: model,
        judgeReasoning: effort === '-' ? '' : effort, judgePerHour: 100000, built: false, personality: '' });
      for (const [who, text, opts] of before) { guide.note(who, text, opts); t += 6000; }
      guide.note(from, said, {}); t += 1500;
      let v = null; try { v = await guide.judge({ from, text: said, botName: 'Jev', players }); } catch (e) { v = { error: e.message }; }
      const got = v && v.forBot === true;
      seen.push(v ? (got ? 'yes' : 'no') + (v.why ? ' (' + v.why + ')' : '') : 'none');
      if (want === null) continue;
      if (want) scoredTrue++; else scoredFalse++;
      if (got === want) ok++;
      else { if (want) misses++; else falsePos++; wrong.push(label + ': ' + JSON.stringify(said) + ' -> ' + seen.at(-1)); }
    }
    rows.push((want === null ? 'either ' : ok + '/' + reps + ' ') + label + (want === null ? ': ' + seen.join(' | ') : ''));
  }
  console.log = log;
  times.sort((a, b) => a - b);
  console.log('\n=== judge ' + model + ' effort=' + effort + ': false positives ' + falsePos + '/' + scoredFalse + ', missed ' + misses + '/' + scoredTrue +
    '; latency median ' + times[Math.floor(times.length / 2)] + ' ms, p90 ' + times[Math.floor(times.length * 0.9)] + ' ms; per call avg in ' + Math.round(usage.in / usage.n) + ' out ' + Math.round(usage.out / usage.n) + ' (reasoning ' + Math.round(usage.reasoning / usage.n) + ') tokens');
  for (const r of rows) if (!r.startsWith(reps + '/')) console.log('  ' + r);
  for (const w of wrong.slice(0, 12)) console.log('  WRONG ' + w.slice(0, 300));
  const odd = [...new Set(notes.filter(n => /\[guide\]/.test(n)))]; for (const n of odd.slice(0, 3)) console.log('  NOTE ' + n.slice(0, 200));
})();
