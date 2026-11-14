/* cyfr live mode: replaces the sample data in app.js with data from the agent's api.
   it only switches on when the page is served by the agent. on vercel nothing changes. */
(async function () {
  const POLL_MS = 3000;                                  // how often to ask the agent for fresh data
  const OPS = { I: 'INSERT', U: 'UPDATE', D: 'DELETE', S: 'SNAPSHOT' }; // short codes to readable names
  const live = { key: '', info: null, health: null, stats: null, sig: '', down: false }; // everything live mode knows

  /* ---------- is there an agent behind this page? ---------- */
  try {
    const probe = await fetch('/v1/health');             // no key on purpose
    if (probe.status !== 401 && probe.status !== 200) return; // not the agent, keep the sample data
  } catch (e) { return; }                                // no server at all, keep the sample data

  /* ---------- switch the simulation off ---------- */
  anchorQueued = function () {};                         // stops the fake "batch anchored" timer
  openAdd = function () {};                              // the "n" shortcut no longer opens the fake form
  state.outage = false;
  ['#addrec', '#outage', '.bellw'].forEach(s => { const b = $(s); if (b) b.hidden = true; }); // sample-only controls, real changes come from the real database
  document.querySelectorAll('#nav>a[href="#/reports"],#nav>a[href="#/settings"]')
    .forEach(a => a.hidden = true);                      // these two screens still use sample data, so hide them
  const strip = document.querySelector('.proto');
  strip.textContent = 'Live data · connecting to the agent';
  strip.style.background = 'var(--ok-l)'; strip.style.color = 'var(--ok)';

  /* ---------- talking to the api ---------- */
  function askKey(msg) {                                 // asks for the api key in a small dialog
    return new Promise(done => {
      const m = modal(`<h2>Connect to the CYFR agent</h2><p class="muted">${esc(msg)}</p>
        <form id="kf" class="fgrid"><label class="full">API key<input name="k" type="password" autocomplete="off" required></label>
        <div class="full row"><span></span><button class="btn primary">Connect</button></div></form>`);
      m.querySelector('#kf').onsubmit = e => { e.preventDefault(); const k = e.target.k.value.trim(); closeModal(); done(k); };
    });
  }
  async function api(path) {                             // one authenticated request, returns parsed json
    const res = await fetch(path, { headers: { Authorization: 'Bearer ' + live.key } });
    if (res.status === 401) { const e = new Error('unauthorized'); e.auth = true; throw e; }
    if (!res.ok) throw new Error(path + ' returned ' + res.status);
    return res.json();
  }
  async function connect() {                             // loops until a key works
    live.key = sessionStorage.getItem('cyfr_api_key') || ''; // kept only until the tab closes
    let msg = 'Enter the API key from the agent’s .env file (CYFR_API_KEY). It stays in this browser tab only.';
    for (;;) {
      if (!live.key) live.key = await askKey(msg);
      try { live.info = await api('/v1/info'); break; }
      catch (e) { if (!e.auth) throw e; live.key = ''; sessionStorage.removeItem('cyfr_api_key'); msg = 'That key was not accepted. Try again.'; }
    }
    sessionStorage.setItem('cyfr_api_key', live.key);
  }

  /* ---------- turning api data into what the screens expect ---------- */
  function fill(events) {                                // rewrites the shared "ledger" array in place
    const flagged = new Set(live.health.alerts.map(a => a.ledger_seq)); // events a scan disagrees with
    ledger.length = 0;
    for (const e of events) ledger.push({
      seq: e.seq, table: e.table, office: live.info.office, op: OPS[e.op] || e.op,
      rid: e.pk_digest.slice(0, 8),                      // rows are known only by a digest of their key
      time: new Date(e.captured_at), hash: e.record_digest, leaf: e.leaf, rec: '',
      status: e.anchored ? 'Anchored' : 'Queued',
      batch: e.batch_id ? 'B-' + e.batch_id : 'Pending',
      tx: e.tx_hash === 'already-anchored' ? 'Confirmed on-chain after a restart' : e.tx_hash,
      chain: live.info.chain_rpc, tampered: flagged.has(e.seq),
    });
  }
  async function pull() {                                // one round of fetching, redraws only if something changed
    try {
      const [h, s, ev] = await Promise.all([api('/v1/health'), api('/v1/stats?days=30'), api('/v1/events/latest?limit=200')]);
      live.health = h; live.stats = s; live.down = false; fill(ev.events);
    } catch (e) {
      if (e.auth) { sessionStorage.removeItem('cyfr_api_key'); location.reload(); return; }
      live.down = true;                                  // the agent itself is not answering
    }
    const h = live.health || {};
    const sig = [live.down, h.events, h.batches, h.batches_waiting, h.database_up, h.chain_up,
      h.last_reconcile, JSON.stringify(h.alerts)].join('|'); // a fingerprint of what is on screen
    if (sig === live.sig) return;
    live.sig = sig;
    if ($('#modal') || !$('#drawer').hidden) return;     // never redraw under an open dialog or drawer
    const keep = ['q', 'fo', 'fs'].map(i => $('#' + i) && $('#' + i).value); // remember the ledger filters
    render();
    ['q', 'fo', 'fs'].forEach((i, n) => { const el = $('#' + i); if (el && keep[n]) { el.value = keep[n]; el.dispatchEvent(new Event('input')); } });
  }

  /* ---------- status strip, pill and banner ---------- */
  function decorate() {
    const h = live.health; if (!h) return;
    $('#orgname').textContent = h.office;
    strip.textContent = `Live data · office ${h.office} · ${h.events.toLocaleString()} events`;
    const net = $('#net');
    net.className = 'pill ' + (h.chain_up ? '' : 'warn');
    net.textContent = h.chain_up ? 'Chain connected' : 'Chain offline · queuing';
    const msgs = [];
    if (live.down) msgs.push(['bad', '<b>The agent is not answering.</b> The numbers below may be out of date.']);
    if (!h.database_up) msgs.push(['warn', '<b>Database unreachable.</b> Changes are safe in the database outbox and will be read when it returns.']);
    if (!h.chain_up) msgs.push(['warn', `<b>Chain unreachable.</b> ${h.batches_waiting} batch${h.batches_waiting === 1 ? '' : 'es'} waiting in the offline queue. Nothing is lost.`]);
    if (h.alerts.length) msgs.push(['bad', `<b>${h.alerts.length} record${h.alerts.length === 1 ? '' : 's'} changed without being recorded.</b> <a href="#/verify">See details</a>`]);
    $('#banner').innerHTML = msgs.map(m => `<div class="alert ${m[0]}" style="margin-bottom:8px"><span>${m[1]}</span></div>`).join('');
  }
  const baseRender = render;
  render = function () {                                 // our pages first, then the live status on top
    const k = location.hash.replace('#/', '');
    if (k === 'reports' || k === 'settings') { location.hash = '#/overview'; return; }
    baseRender(); decorate();
  };
  window.addEventListener('hashchange', decorate);       // app.js redraws on navigation, we re-apply the status after it

  /* ---------- overview ---------- */
  pages.overview.r = function () {
    const h = live.health, s = live.stats, queued = h.events - s.events_anchored;
    const days = s.daily.slice().reverse();              // api gives newest first, the chart wants oldest first
    return `<div class="grid g4">
      <div class="card kpi"><small>Changes fingerprinted</small><b>${h.events.toLocaleString()}</b><span>${h.batches.toLocaleString()} batches closed</span></div>
      <div class="card kpi"><small>Anchored on-chain</small><b>${s.events_anchored.toLocaleString()}</b><span>${h.batches - h.batches_waiting} batches published</span></div>
      <div class="card kpi"><small>Waiting to anchor</small><b>${queued.toLocaleString()}</b><span>${h.batches_waiting ? h.batches_waiting + ' closed batches queued' : 'Sends with the next batch'}</span></div>
      <div class="card kpi"><small>Unrecorded changes found</small><b>${h.alerts.length}</b><span>${h.last_reconcile ? 'Last scan ' + new Date(h.last_reconcile).toLocaleTimeString() : 'No scan yet'}</span></div></div>
      <div class="grid g2"><div class="card"><div class="card-h"><h2>Changes fingerprinted per day</h2>${pill('Last 30 days', 'gray')}</div>
      ${days.length ? lineChart(days.map(d => d.count), 'bar', days.map(d => d.day)) : '<p class="muted">No events yet.</p>'}</div>
      <div class="card"><h2 style="margin-bottom:12px">Activity by table</h2><div class="list">${s.by_table.length ? bars(s.by_table.map(t => [esc(t.table), t.count])) : '<p class="muted">No events yet.</p>'}</div></div></div>
      <div class="card"><div class="card-h"><h2>Latest activity</h2><a href="#/ledger">View full ledger</a></div>${ledger.length ? ledgerTable(ledger.slice(0, 8)) : '<p class="muted">No events yet. Change a row in a protected table to see it here.</p>'}</div>`;
  };
  pages.overview.after = function () {};

  /* ---------- connections ---------- */
  pages.connections.r = function () {
    const i = live.info, h = live.health;
    return `<div class="card"><div class="card-h"><h2>Source database</h2>${pill(h.database_up ? 'Connected' : 'Unreachable', h.database_up ? '' : 'warn')}</div>
      <div class="scroll"><table><thead><tr><th>Database</th><th>Engine</th><th>Host</th><th>Tables protected</th></tr></thead>
      <tbody><tr><td><b>${esc(i.database)}</b></td><td>${esc(i.driver)}</td><td class="mono">${esc(i.host)}</td><td>${(i.tables || []).length}</td></tr></tbody></table></div></div>
      <div class="grid g2e"><div class="card"><h2>Protected tables</h2><div class="list" style="margin-top:12px">
      ${(i.tables || []).map(t => { const c = (live.stats.by_table.find(x => x.table === t) || {}).count || 0; return `<div class="row"><span class="mono">${esc(t)}</span><span>${c.toLocaleString()} changes recorded</span></div>`; }).join('') || '<p class="muted">No tables configured.</p>'}</div></div>
      <div class="card"><h2>What CYFR installed</h2><div class="list" style="margin-top:12px"><div>Three triggers per protected table, for inserts, updates and deletes. Reads are never touched.</div><div>One outbox table, <span class="mono">cyfr_outbox</span>, written in the same transaction as each change.</div><div>A read-only database user for the agent. It cannot change office records.</div></div></div></div>`;
  };
  pages.connections.after = function () {};

  /* ---------- blockchain networks ---------- */
  pages.networks.r = function () {
    const i = live.info, h = live.health;
    return `<div class="grid g2e"><div class="card chain-card"><div class="row"><b>Anchoring network</b>${pill(h.chain_up ? 'Connected' : 'Offline', h.chain_up ? 'blue' : 'warn')}</div>
      <div class="row"><span class="muted">RPC endpoint</span><span class="mono">${esc(i.chain_rpc || 'not configured')}</span></div>
      <div class="row"><span class="muted">Contract</span><span class="mono">${esc(i.contract || '')}</span></div>
      <div class="row"><span class="muted">Batches published</span><span>${h.batches - h.batches_waiting} of ${h.batches}</span></div>
      <div class="row"><span class="muted">Waiting in offline queue</span><span>${h.batches_waiting}</span></div></div>
      <div class="card"><h2>Adapter design</h2><p class="muted">Anchoring goes through one EVM adapter. Moving from this test network to eGovChain changes the endpoint, the contract address and the signing key. Nothing in the office database changes.</p></div></div>`;
  };
  pages.networks.after = function () {};

  /* ---------- merkle proof check, done in the browser ---------- */
  const hex2b = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16))); // hex text to bytes
  const b2hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join(''); // bytes to hex text
  const sha256 = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  const split = n => { let k = 1; while (k * 2 < n) k *= 2; return k; }; // same rule as merkle.go
  async function node(l, r) {                            // parent hash, 0x01 marks an inner node
    const b = new Uint8Array(65); b[0] = 1; b.set(l, 1); b.set(r, 33); return sha256(b);
  }
  async function rootFrom(leaf, i, n, proof) {           // rebuilds the root from one leaf and its siblings
    if (n === 1) return proof.length ? null : leaf;
    if (!proof.length) return null;
    const k = split(n), sib = proof[proof.length - 1], rest = proof.slice(0, -1);
    if (i < k) { const l = await rootFrom(leaf, i, k, rest); return l && node(l, sib); }
    const r = await rootFrom(leaf, i - k, n - k, rest); return r && node(sib, r);
  }
  async function checkProof(seq) {                       // fetches a proof and re-does the maths locally
    const p = await api('/v1/events/' + seq + '/proof');
    const root = await rootFrom(hex2b(p.leaf), p.index, p.batch_size, p.siblings.map(hex2b));
    return { p, ok: !!root && b2hex(root) === p.root };
  }
  function proofHtml(r) {
    const p = r.p;
    return `<div class="alert ${r.ok ? 'ok' : 'bad'}" style="margin:12px 0"><span><b>${r.ok ? 'Proof is valid.' : 'Proof does not add up.'}</b>
      ${r.ok ? `Event ${p.seq} is leaf ${p.index + 1} of ${p.batch_size} in batch B-${p.batch_id}.` : 'The leaf and sibling hashes do not produce the batch root.'}</span></div>
      <div class="fp"><small>Leaf (this event)</small><div class="mono">${esc(p.leaf)}</div>
      <small>Sibling hashes (${p.siblings.length})</small><div class="mono">${p.siblings.map(esc).join('<br>') || 'none, the batch has one event'}</div>
      <small>Batch root, recomputed in this browser</small><div class="mono">${esc(p.root)}</div>
      <small>Anchoring transaction</small><div class="mono">${p.anchored ? esc(p.tx_hash) : 'not anchored yet'}</div></div>
      <p class="muted">This recomputes the batch root from the event. To confirm the root against the chain itself, run <span class="mono">cyfr-verify</span>.</p>`;
  }

  /* ---------- verify records ---------- */
  pages.verify.r = function () {
    const h = live.health;
    const rows = h.alerts.map(a => `<tr class="flag"><td>${esc(a.table)}</td><td class="mono">${esc(a.pk)}</td><td>${esc(a.kind)}</td><td>${a.ledger_seq || 'none'}</td></tr>`).join('');
    return `<div class="grid g2"><div class="card"><div class="card-h"><h2>Database against ledger</h2>${pill(h.last_reconcile ? 'Last scan ' + new Date(h.last_reconcile).toLocaleTimeString() : 'No scan yet', 'gray')}</div>
      <p class="muted">The agent re-hashes every live row in the protected tables and compares it with the latest fingerprint in the ledger. A row appears here when it disagrees on two scans in a row.</p>
      <div style="margin-top:16px">${h.alerts.length
        ? `<div class="alert bad"><span><b>${h.alerts.length} row${h.alerts.length === 1 ? '' : 's'} changed without being recorded.</b></span></div><div class="scroll" style="margin-top:12px"><table><thead><tr><th>Table</th><th>Row key</th><th>Finding</th><th>Ledger entry</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="alert ok"><span><b>All live rows match the ledger.</b></span></div>'}</div></div>
      <div class="card"><h2>Check a proof</h2><p class="muted">Enter an event number from the ledger. The browser fetches its Merkle proof and recomputes the batch root itself.</p>
      <form id="pf" class="row" style="margin-top:12px"><input id="ps" type="number" min="1" placeholder="Event number" required><button class="btn primary">Check proof</button></form><div id="pres"></div></div></div>`;
  };
  pages.verify.after = function () {
    $('#pf').onsubmit = async e => {
      e.preventDefault();
      try { $('#pres').innerHTML = proofHtml(await checkProof(+$('#ps').value)); }
      catch (err) { $('#pres').innerHTML = '<div class="alert warn" style="margin-top:12px"><span>That event was not found, or its batch has not closed yet.</span></div>'; }
    };
  };

  /* ---------- record drawer ---------- */
  openRec = function (seq) {                             // replaces the sample drawer with real fields
    const r = ledger.find(l => l.seq === seq), d = $('#drawer'); if (!r) return;
    d.innerHTML = `<div class="row"><h2>Event #${r.seq}</h2><button class="btn sm" id="x">Close</button></div><p class="muted">${esc(r.table)} · ${esc(r.office)}</p>
      <dl><dt>Operation</dt><dd>${r.op}</dd><dt>Captured</dt><dd>${r.time.toLocaleString()}</dd>
      <dt>Record fingerprint</dt><dd class="mono" style="word-break:break-all">${r.hash}</dd>
      <dt>Status</dt><dd>${pill(r.tampered ? 'Mismatch' : r.status, r.tampered ? 'bad' : r.status === 'Queued' ? 'warn' : '')}</dd>
      <dt>Batch</dt><dd>${r.batch}</dd><dt>Transaction</dt><dd class="mono" style="word-break:break-all">${r.status === 'Queued' ? 'Waiting to be anchored' : esc(r.tx)}</dd></dl>
      <p class="muted">The fingerprint is a keyed hash. The record itself never leaves the database.</p>
      ${r.batch === 'Pending' ? '' : '<button class="btn primary block" id="vp">Check Merkle proof</button>'}<div id="dp"></div>`;
    d.hidden = false; $('#x').onclick = () => d.hidden = true;
    const vp = $('#vp'); if (vp) vp.onclick = async () => {
      try { $('#dp').innerHTML = proofHtml(await checkProof(r.seq)); } catch (e) { $('#dp').innerHTML = '<p class="muted">The proof could not be fetched.</p>'; }
    };
  };

  /* ---------- start ---------- */
  await connect();
  await pull();                                          // first full draw
  if (!live.health) strip.textContent = 'Live mode · the agent did not answer';
  setInterval(pull, POLL_MS);                            // then keep it fresh
})();
