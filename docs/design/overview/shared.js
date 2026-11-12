// One invented network, shared by the five overview mockups so they can be compared on the same work.
const L = {
  network: 'harbor', you: 'yan',
  leads: [
    { id: 'yan', area: 'Checkout', on: true, c: '#5fd4d0' },
    { id: 'sam', area: 'Billing', on: true, c: '#e8b755' },
    { id: 'mira', area: 'Platform', on: true, c: '#c79bf2' },
    { id: 'teo', area: 'Mobile', on: false, seen: '2h', c: '#7aa7ff' },
  ],
  repos: ['shop', 'billing-api', 'infra', 'mobile', 'docs-site'],
  phases: ['brief', 'build', 'verify', 'landed'],
  // start/end are days from today (Wed 11 Nov). Kid states: run, ask (waits on a person), idle, wait (waits on a session), done.
  streams: [
    { id: 'checkout-v2', repo: 'shop', owner: 'yan', phase: 'build', risk: 'med', start: -9, end: 5, note: 'New checkout with saved cards.',
      waits: [{ on: 'pricing-migration', what: 'price-tables', by: 'tax-lines', at: 1 }],
      kids: [['payments', 'run', 'task'], ['stripe-webhooks', 'ask', 'task'], ['cart-api', 'done', 'task'], ['tax-lines', 'wait', 'task'], ['e2e-tests', 'wait', 'verify']] },
    { id: 'pricing-migration', repo: 'billing-api', owner: 'sam', phase: 'build', risk: 'high', start: -6, end: 3, note: 'Move prices to the new tables without a freeze.',
      kids: [['price-tables', 'run', 'task'], ['backfill', 'run', 'task'], ['dual-write', 'idle', 'task'], ['parity-check', 'wait', 'verify']] },
    { id: 'invoice-export', repo: 'billing-api', owner: 'sam', phase: 'verify', risk: 'low', start: -12, end: 1, note: 'Invoices as PDF and CSV.',
      kids: [['csv-writer', 'done', 'task'], ['pdf-renderer', 'ask', 'task'], ['fixtures', 'done', 'task'], ['review', 'run', 'verify']] },
    { id: 'sso-rollout', repo: 'infra', owner: 'mira', phase: 'build', risk: 'high', start: -8, end: 8, note: 'Single sign-on for every internal tool.',
      kids: [['oidc-provider', 'run', 'task'], ['session-store', 'run', 'task'], ['audit-log', 'idle', 'task'], ['runbook', 'wait', 'task']] },
    { id: 'rate-limits', repo: 'infra', owner: 'mira', phase: 'verify', risk: 'med', start: -10, end: 4, note: 'Per-tenant limits at the gateway.',
      waits: [{ on: 'sso-rollout', what: 'session-store', by: 'load-test', at: 2 }],
      kids: [['token-bucket', 'done', 'task'], ['gateway-rules', 'done', 'task'], ['load-test', 'wait', 'verify']] },
    { id: 'search-reindex', repo: 'shop', owner: 'mira', phase: 'brief', risk: 'low', start: 0, end: 9, note: 'Rebuild the catalog index. Offered to @yan.', offer: 'yan',
      kids: [['brief', 'idle', 'task'], ['index-schema', 'idle', 'task']] },
    { id: 'offline-cart', repo: 'mobile', owner: 'teo', phase: 'build', risk: 'med', start: -7, end: 6, note: 'The cart works without a connection.',
      waits: [{ on: 'checkout-v2', what: 'cart-api', by: 'sync-engine', at: -3, met: true }],
      kids: [['sync-engine', 'idle', 'task'], ['conflict-rules', 'ask', 'task'], ['local-store', 'done', 'task']] },
    { id: 'docs-refresh', repo: 'docs-site', owner: 'yan', phase: 'landed', risk: 'low', start: -11, end: -2, note: 'API pages for the new checkout.',
      kids: [['api-pages', 'done', 'task'], ['changelog', 'done', 'task']] },
  ],
  needs: [
    { t: '?', who: 'yan', stream: 'checkout-v2', from: 'stripe-webhooks', text: 'Run `stripe listen` against the staging account?', age: '6m' },
    { t: '✉', who: 'yan', stream: 'checkout-v2', from: 'cart-api → payments', text: '“Totals endpoint is live, switch over when ready.”', age: '14m' },
    { t: '⇄', who: 'yan', stream: 'search-reindex', from: '@mira offers', text: 'Take search-reindex? It changes the catalog you own.', age: '31m' },
    { t: '?', who: 'sam', stream: 'invoice-export', from: 'pdf-renderer', text: 'Overwrite fixtures/invoice.pdf?', age: '3m' },
    { t: '?', who: 'teo', stream: 'offline-cart', from: 'conflict-rules', text: 'Last write wins, or keep both carts?', age: '2h' },
  ],
  between: [
    { g: '⧗', c: 'ty', a: 'yan', b: 'sam', text: 'checkout-v2 ▸ tax-lines starts when pricing-migration ▸ price-tables finishes', sub: 'expected Thu 12 Nov' },
    { g: '⇄', c: 'tm', a: 'mira', b: 'yan', text: 'search-reindex offered to you', sub: '31m ago · not answered' },
    { g: '?', c: 'ty', a: 'teo', b: 'teo', text: 'offline-cart ▸ conflict-rules has waited 2h on @teo, who is offline', sub: 'you own the cart rules it asks about' },
    { g: '✓', c: 'tg', a: 'teo', b: 'yan', text: 'offline-cart ▸ sync-engine was waiting on your cart-api', sub: 'met Sun 8 Nov · it has not started again' },
  ],
  done14: [3, 5, 4, 6, 2, 0, 0, 5, 7, 6, 8, 1, 0, 9],
};

const S = id => L.streams.find(s => s.id === id), P = id => L.leads.find(l => l.id === id);
const $ = (q, el = document) => el.querySelector(q);
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const G = { run: ['⠹', 'tg spin'], ask: ['●', 'ty'], idle: ['○', 'td'], wait: ['⧗', 'tb'], done: ['✓', 'td'] };
const GC = { run: '#7fd18b', ask: '#e8b755', idle: '#808a9e', wait: '#7aa7ff', done: '#808a9e' };
const g = s => `<span class="${G[s][1]}">${G[s][0]}</span>`;
const count = (s, st) => s.kids.filter(k => k[1] === st).length;
const total = st => L.streams.reduce((n, s) => n + count(s, st), 0);
const day = d => new Date(2026, 10, 11 + d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const neededBy = id => L.streams.flatMap(s => (s.waits || []).filter(w => w.on === id).map(w => ({ s, w })));
const NS = 'http://www.w3.org/2000/svg';
const E = (t, a = {}, txt) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; };

// The inspector: everything about one workstream, in the vocabulary of the pane.
function inspect(id) {
  const s = S(id), o = P(s.owner), pad = (t, n) => t + ' '.repeat(Math.max(1, n - t.length));
  const risk = { low: 'td', med: 'ty', high: 'tr' }[s.risk];
  let h = `<span class="tw">${s.id}</span><span class="right td">feature</span>\n`;
  h += `<span class="td">◆ ${s.repo} · </span><span style="color:${o.c}">@${s.owner}</span><span class="td">${o.on ? '' : ' offline ' + o.seen} · ${s.phase} · risk </span><span class="${risk}">${s.risk}</span>\n`;
  h += `${esc(s.note)}\n<span class="td">${day(s.start)} → ${day(s.end)}</span>\n\n`;
  s.kids.forEach((k, i) => {
    const w = (s.waits || []).find(w => w.by === k[0]), n = L.needs.find(n => n.stream === id && n.from.startsWith(k[0]));
    h += `<span class="td">${i < s.kids.length - 1 ? '├' : '└'}</span> ${g(k[1])} ${pad(k[0], 17)}<span class="td">${pad(k[2], 7)}</span>${n ? `<span class="ty">${n.t}1</span>` : ''}\n`;
    if (w) h += `<span class="td">${i < s.kids.length - 1 ? '│' : ' '}  </span><span class="${w.met ? 'tg' : 'tb'}">${w.met ? '✓' : '⧗'} ${w.on} ▸ ${w.what}</span>\n`;
  });
  const nb = neededBy(id);
  if (nb.length) h += `\n<span class="td">NEEDED BY</span>\n` + nb.map(({ s: d, w }) => `  ${d.id} ▸ ${w.by} <span class="td">@${d.owner}</span>${w.met ? ' <span class="tg">✓</span>' : ''}`).join('\n') + '\n';
  const ns = L.needs.filter(n => n.stream === id);
  if (ns.length) h += `\n<span class="td">NEEDS</span>\n` + ns.map(n => `<span class="ty">${n.t}</span> <span style="color:${P(n.who).c}">@${n.who}</span> <span class="td">${n.age}</span>\n  ${esc(n.text)}`).join('\n') + '\n';
  h += `\n<span class="td"><span class="tk">enter</span> open  <span class="tk">${s.owner === L.you ? 'o' : 't'}</span> ${s.owner === L.you ? 'offer' : 'ask for it'}  <span class="tk">m</span> message</span>`;
  return `<pre>${h}</pre>`;
}

const VIEWS = [['dendrite', 'dendrite'], ['orbit', 'orbits'], ['timeline', 'timeline'], ['lattice', 'lattice'], ['ledger', 'ledger'], ['canopy', 'canopy']];
function chrome(n, keys) {
  const people = L.leads.map(l => `<span style="color:${l.on ? l.c : 'var(--t-dim)'}">${l.on ? '' : '○'}@${l.id}${l.on ? '' : ' ' + l.seen}</span>`).join(' ');
  $('#top').innerHTML = `<span class="net">◆ ${L.network}</span><span>${people}</span>` +
    `<span class="td">${L.repos.length} repositories · ${L.streams.length} workstreams · <span class="tg">${g('run')} ${total('run')}</span> running · <span class="ty">● ${L.needs.length}</span> need someone</span>` +
    `<nav><a href="index.html">all</a>${VIEWS.map((v, i) => `<a href="${v[0]}.html"${i + 1 === n ? ' class="on"' : ''}><b>${i + 1}</b>${v[1]}</a>`).join('')}</nav>`;
  $('#keys').innerHTML = keys.map(k => `<span><kbd>${k[0]}</kbd> ${k[1]}</span>`).join('') + `<span><kbd>1</kbd>–<kbd>6</kbd> change view</span><span><kbd>alt+l</kbd> back to the sessions</span>`;
  document.addEventListener('keydown', e => { const v = VIEWS[+e.key - 1]; if (v && !e.metaKey && !e.ctrlKey) location.href = v[0] + '.html'; });
  const F = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'; let f = 0;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) setInterval(() => { f = (f + 1) % F.length; document.querySelectorAll('.spin').forEach(e => e.textContent = F[f]); }, 90);
}
