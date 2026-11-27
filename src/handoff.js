'use strict';
// JEV_COOPERATION=ask: work one player gave is not dropped because another
// player asked for something. The second request is held, the first player is
// asked, and their yes lets it through. Nothing is asked when the first
// player has left, when the bot is only looking after itself or chasing its
// dream, or when the same player asks again. Stop is never gated: anyone may
// stop the bot. The idea is alexrmsouza/jevcraft's cooperation.js (0e2f597c);
// this is the task-replacement case only, kept in memory because a question
// is worth ninety seconds and no longer.
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
// A yes said the way players say it. "yea" was not one, the holder's yes went on to the language layer as a line of
// its own, and that started the held request again in the holder's name: the items went to the wrong player. The
// short words count only as the whole answer ("go home" is a request, not a yes).
const YES = /^(?:(?:yes|yea|yeah|yeh|yah|ya|yep|yup|yes please|sure|ok|okay|okey|alright|all right|of course|absolutely|definitely|go ahead|go for it|do it|please do|sounds good|no problem|fine|let (?:him|her|them))\b|(?:y|k|kk|go|np|why not)$)/i;
const NO = /^(?:(?:no|nope|nah|not now|later|no thanks|stay|don't|do not)\b|n$)/i;
// The request as said, for comparing two sayings of it: no name in front, no case, no punctuation.
const plain = (text, botName) => String(text || '').toLowerCase().replace(new RegExp(`^\\s*${String(botName || '').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,:]?\\s+`), '')
  .replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim();

function createHandoff({ now = Date.now, questionMs = 90000, approvalMs = 120000 } = {}) {
  let question = null;           // { holder, asker, payload, request, until }
  const approvals = new Map();   // "asker\nrequest" -> until
  const key = (asker, request) => `${String(asker).toLowerCase()}\n${request}`;
  const live = () => { if (question && question.until <= now()) question = null; return question; };
  return {
    // Whose work would be replaced, or null when nothing needs asking.
    holder({ active, from, online = () => true }) {
      const goal = active && !active.idle ? active.goal : null;
      // A walk back to a player after monsters (company.js backDue) is the bot's own errand: nobody's work to ask about.
      // Nor its own errand for a sword (keep-armed.js).
      if (!goal || goal.dream || goal.back || goal.weaponErrand || goal.chore || !goal.from || same(goal.from, from) || !online(goal.from)) return null;
      return goal.from;
    },
    approved(asker, request) {
      const until = approvals.get(key(asker, request));
      if (!until) return false;
      approvals.delete(key(asker, request));
      return until > now();
    },
    ask({ holder, asker, request, payload }) { question = { holder, asker, request, payload, until: now() + questionMs }; },
    // The holder's reply to the open question: { verdict: 'yes'|'no', question } or null.
    answer(from, text) {
      const q = live();
      if (!q || !same(q.holder, from)) return null;
      const said = String(text || '').trim().replace(/[.!]+$/, '');
      const verdict = YES.test(said) ? 'yes' : NO.test(said) ? 'no' : null;
      if (!verdict) return null;
      question = null;
      if (verdict === 'yes') approvals.set(key(q.asker, q.request), now() + approvalMs);
      return { verdict, question: q };
    },
    // The language layer's reading of the holder's line, when it asks for the held request itself: that is the
    // holder's yes said another way, and the request stays the asker's (with "for <asker>" or without).
    // -> { verdict: 'yes', question } or null.
    approvesByRequest(from, requests, botName) {
      const q = live();
      if (!q || !same(q.holder, from) || !Array.isArray(requests) || !requests.length) return null;
      const held = plain(q.request, botName), asker = plain(q.asker), said = plain(requests[0], botName);
      if (said !== held && said !== `${held} for ${asker}`) return null;
      question = null;
      approvals.set(key(q.asker, q.request), now() + approvalMs);
      return { verdict: 'yes', question: q };
    },
    pending: () => live(),
    clear() { question = null; approvals.clear(); },
  };
}

module.exports = { createHandoff };
