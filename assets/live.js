/* ==========================================================================
   CYFR console: live mode

   Loaded after app.js. When the page is served by the CYFR agent, this file
   replaces the sample data with real data from the agent's API, redraws the
   main screens from it, and adds the "Documents" and "Office simulator" pages.
   On any other host (for example the public Vercel demo) it does nothing.

   Sections: setup, API, data, status, shared pieces, overview, connections,
   networks, proofs, verify, record drawer, office simulator, documents, start.
   ========================================================================== */
(async function () {
  const POLL_MS = 2000; // how often to ask the agent for fresh data
  const OPS = {
    I: "INSERT",
    U: "UPDATE",
    D: "DELETE",
    S: "SNAPSHOT",
    R: "REGISTER",
    F: "FINDING",
    C: "CLEARED",
  }; // short codes to readable names
  const live = { key: "", info: null, health: null, stats: null, batches: [], sig: "", down: false }; // what live mode knows
  const demo = { rows: [], outage: false, canRestore: false, track: null, tab: "till" }; // state of the demo office page

  /* ---------- setup: is there an agent behind this page? ---------- */
  try {
    const probe = await fetch("/v1/health"); // no key on purpose
    if (probe.status !== 401 && probe.status !== 200) return; // not the agent, keep the sample data
  } catch (e) {
    return; // no server at all, keep the sample data
  }

  // switch the simulation off
  anchorQueued = function () {}; // stops the fake "batch anchored" timer
  openAdd = function () {}; // the "n" shortcut no longer opens the fake form
  state.outage = false;
  ["#addrec", "#outage", ".bellw"].forEach((s) => {
    const b = $(s);
    if (b) b.hidden = true; // sample-only controls
  });
  document
    .querySelectorAll('#nav>a[href="#/reports"],#nav>a[href="#/settings"]')
    .forEach((a) => (a.hidden = true)); // these two screens still use sample data
  const strip = document.querySelector(".proto");
  strip.textContent = "Live data. Connecting to the agent";
  strip.classList.add("live");

  /* ---------- API ---------- */
  function askKey(msg) {
    // asks for the api key in a small dialog
    return new Promise((done) => {
      const m = modal(`<h2>Connect to the CYFR agent</h2><p class="muted">${esc(msg)}</p>
        <form id="kf" class="fgrid"><label class="full">API key<input name="k" type="password" autocomplete="off" required></label>
        <div class="full row"><span></span><button class="btn primary">Connect</button></div></form>`);
      m.querySelector("#kf").onsubmit = (e) => {
        e.preventDefault();
        const k = e.target.k.value.trim();
        closeModal();
        done(k);
      };
    });
  }
  async function api(path, body) {
    // one authenticated request. with a body it is a POST, otherwise a GET
    const opt = { headers: { Authorization: "Bearer " + live.key } };
    if (body !== undefined) {
      opt.method = "POST";
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(path, opt);
    if (res.status === 401) {
      const e = new Error("unauthorized");
      e.auth = true;
      throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || path + " returned " + res.status);
    return data;
  }
  async function connect() {
    // loops until a key works
    live.key = sessionStorage.getItem("cyfr_api_key") || ""; // kept only until the tab closes
    let msg =
      "Enter the API key from the agent’s .env file (CYFR_API_KEY). It stays in this browser tab only.";
    for (;;) {
      if (!live.key) live.key = await askKey(msg);
      try {
        live.info = await api("/v1/info");
        break;
      } catch (e) {
        if (!e.auth) throw e;
        live.key = "";
        sessionStorage.removeItem("cyfr_api_key");
        msg = "That key was not accepted. Try again.";
      }
    }
    sessionStorage.setItem("cyfr_api_key", live.key);
  }

  /* ---------- data ---------- */
  const page = () => location.hash.replace("#/", "") || "overview"; // the screen being shown

  function fill(events) {
    // rewrites the shared "ledger" array in place, so app.js screens read real events
    const flagged = new Set(live.health.alerts.map((a) => a.ledger_seq)); // events a scan disagrees with
    ledger.length = 0;
    for (const e of events)
      ledger.push({
        seq: e.seq,
        table: e.table,
        office: live.info.office,
        op: OPS[e.op] || e.op,
        rid: e.pk_digest.slice(0, 8), // rows are known only by a digest of their key
        time: new Date(e.captured_at),
        hash: e.record_digest,
        rec: "",
        status: e.anchored ? "Anchored" : "Queued",
        batch: e.batch_id ? "B-" + e.batch_id : "Pending",
        tx: e.tx_hash === "already-anchored" ? "Confirmed on-chain after a restart" : e.tx_hash,
        chain: live.info.chain_rpc,
        tampered: flagged.has(e.seq),
      });
  }
  async function pull() {
    // one round of fetching. redraws only when something changed
    try {
      const [h, s, ev, b] = await Promise.all([
        api("/v1/health"),
        api("/v1/stats?days=30"),
        api("/v1/events/latest?limit=200"),
        api("/v1/batches"),
      ]);
      live.health = h;
      live.stats = s;
      live.batches = b.batches;
      live.down = false;
      fill(ev.events);
      if (live.info.demo) {
        const d = await api("/v1/demo/receipts"); // the office's own records, for the demo page
        demo.rows = d.receipts;
        demo.outage = d.outage;
        demo.canRestore = d.can_restore;
      }
    } catch (e) {
      if (e.auth) {
        sessionStorage.removeItem("cyfr_api_key");
        location.reload();
        return;
      }
      live.down = true; // the agent itself is not answering
    }
    if (!live.health) return;
    if (page() === "documents" && $("#doclist")) {
      await docRefresh(); // only the list changes, so a file being checked stays on screen
      decorate();
      return;
    }
    if (page() === "demo" && $("#dtrack")) {
      demoRefresh(); // this page updates its parts in place, so typing is never interrupted
      decorate();
      return;
    }
    const h = live.health;
    const sig = [
      live.down,
      h.events,
      h.batches,
      h.batches_waiting,
      h.database_up,
      h.chain_up,
      h.last_reconcile,
    ]
      .concat(JSON.stringify(h.alerts))
      .join("|"); // a fingerprint of what is on screen
    if (sig === live.sig) return;
    if ($("#modal") || !$("#drawer").hidden) return; // never redraw under an open dialog or drawer
    const el = document.activeElement;
    if (el && $("#view").contains(el) && /INPUT|SELECT/.test(el.tagName)) return; // never redraw while someone is typing
    if (["#pres", "#vcres", "#rwres"].some((r) => $(r) && $(r).innerHTML)) return; // keep a result on screen until the person leaves the page
    live.sig = sig; // stored only when the redraw really happens
    const keep = ["q", "fo", "fs"].map((i) => $("#" + i) && $("#" + i).value); // remember the ledger filters
    render();
    ["q", "fo", "fs"].forEach((i, n) => {
      const el = $("#" + i);
      if (el && keep[n]) {
        el.value = keep[n];
        el.dispatchEvent(new Event("input"));
      }
    });
  }

  /* ---------- status: strip, chip and banner ---------- */
  function decorate() {
    const h = live.health;
    if (!h) return;
    $("#orgname").textContent = h.office;
    strip.textContent = `Live data from the ${h.office} agent`;
    const net = $("#net");
    net.className = "pill livechip " + (h.chain_up ? "" : "warn");
    net.textContent = h.chain_up ? "Chain connected" : "Chain offline, queuing";
    const msgs = [];
    if (live.down)
      msgs.push(["bad", "<b>The agent is not answering.</b> The numbers below may be out of date."]);
    if (!h.database_up)
      msgs.push([
        "warn",
        "<b>Database unreachable.</b> Changes are safe in the database outbox and will be read when it returns.",
      ]);
    if (!h.chain_up)
      msgs.push([
        "warn",
        `<b>Chain unreachable.</b> ${h.batches_waiting} batch${h.batches_waiting === 1 ? "" : "es"} waiting in the offline queue. Nothing is lost.`,
      ]);
    if (h.alerts.length)
      msgs.push([
        "bad",
        `<b>${h.alerts.length} record${h.alerts.length === 1 ? " differs" : "s differ"} from the ledger.</b> <a href="#/verify">Review the findings</a>`,
      ]);
    const quiet = (page() === "overview" || page() === "demo") && !live.down; // those pages already say it themselves
    $("#banner").innerHTML = (quiet ? [] : msgs)
      .map((m) => `<div class="alert ${m[0]}" style="margin-bottom:8px"><span>${m[1]}</span></div>`)
      .join("");
  }
  const baseRender = render;
  render = function () {
    // our pages first, then the live status on top
    const k = page();
    if (k === "reports" || k === "settings") {
      location.hash = "#/overview";
      return;
    }
    baseRender();
    decorate();
  };
  window.addEventListener("hashchange", decorate); // app.js redraws on navigation, we re-apply the status after it

  /* ---------- shared pieces ---------- */
  const ICON = {
    // small line icon for the simulator's menu entry
    office: '<path d="M3 21h18M5 21V10M9 21V10M15 21V10M19 21V10M2 10l10-7 10 7z"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 15l2 2 4-4"/>',
  };
  const icon = (n) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;
  const clock = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const when = (d) =>
    // time alone for today, date and time otherwise
    d.toDateString() === new Date().toDateString()
      ? clock(d)
      : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + clock(d);
  const peso = (v) =>
    "₱" + Number(v).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const opTag = (op) => `<span class="op ${op.toLowerCase()}">${op}</span>`;
  const statusTag = (l) =>
    pill(l.tampered ? "Mismatch" : l.status, l.tampered ? "bad" : l.status === "Queued" ? "warn" : "");

  ledgerTable = function (rows) {
    // the event table used on the overview and the ledger page
    return `<table><thead><tr><th>Seq</th><th>Captured</th><th>Table</th><th>Row</th><th>Operation</th><th>Fingerprint</th><th>Batch</th><th>Status</th></tr></thead><tbody>${rows
      .map(
        (
          l,
        ) => `<tr class="click ${l.tampered ? "flag" : ""}" data-s="${l.seq}"><td>${l.seq}</td><td>${when(l.time)}</td><td>${esc(l.table)}</td>
        <td class="mono">${l.rid}</td><td>${opTag(l.op)}</td><td class="mono">${short(l.hash)}</td><td>${l.batch}</td><td>${statusTag(l)}</td></tr>`,
      )
      .join("")}</tbody></table>`;
  };

  /* ---------- overview ---------- */
  function verdict() {
    // the plain-language answer at the top of the overview
    const h = live.health,
      s = live.stats,
      n = h.alerts.length,
      queued = h.events - s.events_anchored;
    const scan = h.last_reconcile
      ? `Last checked at ${clock(new Date(h.last_reconcile))}.`
      : "The first check has not run yet.";
    let cls = "ok",
      title = "Records match the ledger",
      text = `${scan} Every change is anchored on-chain.`;
    if (queued > 0)
      text = `${scan} ${queued.toLocaleString()} recent change${queued === 1 ? " is" : "s are"} waiting for the next batch.`;
    if (!h.chain_up) {
      cls = "warn";
      title = "Records match, anchoring is paused";
      text = `The chain cannot be reached. ${h.batches_waiting} batch${h.batches_waiting === 1 ? " is" : "es are"} held in the offline queue until it returns.`;
    }
    if (!h.database_up) {
      cls = "warn";
      title = "The database cannot be reached";
      text = "Changes made meanwhile stay in the database outbox and are read when the connection returns.";
    }
    if (n) {
      cls = "bad";
      title = `${n} record${n === 1 ? " differs" : "s differ"} from the ledger`;
      text = `${scan} A change was made that CYFR did not capture. <a href="#/verify">Review the findings</a>`;
    }
    const stage = (st, name, detail, word) =>
      `<li class="${st}"><b>${name}</b><span>${detail}</span><em>${word}</em></li>`;
    return `<section class="verdict ${cls}" aria-label="Integrity summary">
      <div><h2>${title}</h2><p>${text}</p></div>
      <ol class="custody">
      ${stage(!h.database_up ? "warn" : n ? "bad" : "ok", "Database", `${(live.info.tables || []).length} protected tables`, !h.database_up ? "Unreachable" : n ? "Mismatch found" : "Matches the ledger")}
      ${stage("ok", "Ledger", `${h.events.toLocaleString()} entries`, "Hash chain intact")}
      ${stage(h.chain_up ? "ok" : "warn", "Blockchain", `${h.batches - h.batches_waiting} of ${h.batches} batches anchored`, h.chain_up ? "Connected" : "Offline, queuing")}
      </ol></section>`;
  }
  function dayChart(days) {
    // bars for the last 14 days, with the count above each bar
    const W = 640,
      H = 210,
      L = 34,
      R = 8,
      T = 22,
      B = 30; // drawing area and its margins
    const max = Math.max(...days.map((d) => d.count), 1);
    const top = Math.ceil((max * 1.1) / 10) * 10; // a round number just above the tallest bar
    const slot = (W - L - R) / days.length,
      bw = Math.min(slot * 0.56, 26);
    const y = (v) => H - B - (v / top) * (H - T - B);
    const grid = [0, 0.5, 1]
      .map(
        (f) =>
          `<line x1="${L}" x2="${W - R}" y1="${y(top * f)}" y2="${y(top * f)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(top * f) + 4}" font-size="10" text-anchor="end" fill="var(--mu)">${Math.round(top * f)}</text>`,
      )
      .join("");
    const bars = days
      .map((d, i) => {
        const cx = L + slot * i + slot / 2,
          h = d.count ? Math.max(H - B - y(d.count), 3) : 0;
        const label = new Date(d.day + "T00:00:00").toLocaleDateString([], {
          month: "short",
          day: "numeric",
        });
        return `<g><title>${label}: ${d.count} changes</title>
          ${d.count ? `<rect x="${cx - bw / 2}" y="${H - B - h}" width="${bw}" height="${h}" rx="2" fill="${i === days.length - 1 ? "var(--blue)" : "var(--bar)"}"/><text x="${cx}" y="${H - B - h - 6}" font-size="10" text-anchor="middle" fill="var(--tx)">${d.count}</text>` : `<rect x="${cx - bw / 2}" y="${H - B - 2}" width="${bw}" height="2" fill="var(--line-2)"/>`}
          ${i % 2 === 1 ? `<text x="${cx}" y="${H - 10}" font-size="10" text-anchor="middle" fill="var(--mu)">${label}</text>` : ""}</g>`;
      })
      .join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Changes recorded per day, last 14 days">${grid}${bars}</svg>`;
  }
  function batchChain() {
    // the newest batches drawn as linked blocks, the way a block explorer shows blocks
    const list = live.batches.slice(-9);
    if (!list.length) return '<p class="muted">No batch has closed yet.</p>';
    return `<div class="chain">${list
      .map((b, i) => {
        const n = b.last_seq - b.first_seq + 1;
        return `<div class="blk ${b.anchored ? "" : "wait"} ${i === list.length - 1 ? "new" : ""}" title="Merkle root ${b.root}">
          <b>B-${b.id}</b><span>${n} ${n === 1 ? "entry" : "entries"}</span><span class="mono">${b.root.slice(0, 8)}</span><em>${b.anchored ? "Anchored" : "Queued"}</em></div>`;
      })
      .join("")}</div>`;
  }
  pages.overview.r = function () {
    const h = live.health,
      s = live.stats,
      queued = h.events - s.events_anchored;
    const byDay = Object.fromEntries(s.daily.map((d) => [d.day, d.count])); // date to count
    const days = Array.from({ length: 14 }, (_, i) => {
      // the last 14 philippine dates, quiet days count as zero
      const day = new Date(Date.now() + 8 * 3600e3 - (13 - i) * 864e5).toISOString().slice(0, 10);
      return { day, count: byDay[day] || 0 };
    });
    const fig = (label, value, note, tone) =>
      `<div class="card kpi ${tone || ""}"><small>${label}</small><b>${value}</b><span>${note}</span></div>`;
    return `${verdict()}
      <div class="grid g4">
      ${fig("Ledger entries", h.events.toLocaleString(), `in ${h.batches.toLocaleString()} batches`)}
      ${fig("Anchored on-chain", s.events_anchored.toLocaleString(), `${h.batches - h.batches_waiting} batches published`)}
      ${fig("Waiting to anchor", queued.toLocaleString(), h.batches_waiting ? h.batches_waiting + " closed batches queued" : "Sent with the next batch", queued && !h.chain_up ? "warn" : "")}
      ${fig("Open findings", h.alerts.length, h.last_reconcile ? "Last check " + clock(new Date(h.last_reconcile)) : "No check yet", h.alerts.length ? "bad" : "")}
      </div>
      <div class="card"><div class="card-h"><h2>Batch chain</h2><span class="muted">Each batch is one Merkle root written to the contract. Newest on the right.</span></div>${batchChain()}</div>
      <div class="grid g2">
      <div class="card"><div class="card-h"><h2>Changes recorded per day</h2><span class="muted">Last 14 days</span></div>${dayChart(days)}</div>
      <div class="card"><div class="card-h"><h2>Activity by table</h2></div><div class="list">${s.by_table.length ? bars(s.by_table.map((t) => [esc(t.table), t.count])) : '<p class="muted">No changes recorded yet.</p>'}</div></div>
      </div>
      <div class="card"><div class="card-h"><h2>Latest entries</h2><a href="#/ledger">View full ledger</a></div><div class="scroll">${ledger.length ? ledgerTable(ledger.slice(0, 7)) : '<p class="muted">No changes recorded yet. Change a row in a protected table to see it here.</p>'}</div></div>`;
  };
  pages.overview.after = function () {};

  /* ---------- connections ---------- */
  pages.connections.r = function () {
    const i = live.info,
      h = live.health;
    return `<div class="card"><div class="card-h"><h2>Source database</h2>${pill(h.database_up ? "Connected" : "Unreachable", h.database_up ? "" : "warn")}</div>
      <div class="scroll"><table><thead><tr><th>Database</th><th>Engine</th><th>Host</th><th>Tables protected</th></tr></thead>
      <tbody><tr><td><b>${esc(i.database)}</b></td><td>${esc(i.driver)}</td><td class="mono">${esc(i.host)}</td><td>${(i.tables || []).length}</td></tr></tbody></table></div></div>
      <div class="grid g2e"><div class="card"><h2>Protected tables</h2><div class="list" style="margin-top:12px">
      ${
        (i.tables || [])
          .map((t) => {
            const c = (live.stats.by_table.find((x) => x.table === t) || {}).count || 0;
            return `<div class="row"><span class="mono">${esc(t)}</span><span>${c.toLocaleString()} changes recorded</span></div>`;
          })
          .join("") || '<p class="muted">No tables configured.</p>'
      }</div></div>
      <div class="card"><h2>What CYFR installed</h2><div class="list" style="margin-top:12px"><div>Three triggers per protected table, for inserts, updates and deletes. Reads are never touched.</div><div>One outbox table, <span class="mono">cyfr_outbox</span>, written in the same transaction as each change.</div><div>A read-only database user for the agent. It cannot change office records.</div></div></div></div>`;
  };
  pages.connections.after = function () {};

  /* ---------- blockchain networks ---------- */
  pages.networks.r = function () {
    const i = live.info,
      h = live.health;
    return `<div class="grid g2e"><div class="card chain-card"><div class="row"><b>Anchoring network</b>${pill(h.chain_up ? "Connected" : "Offline", h.chain_up ? "blue" : "warn")}</div>
      <div class="row"><span class="muted">RPC endpoint</span><span class="mono">${esc(i.chain_rpc || "not configured")}</span></div>
      <div class="row"><span class="muted">Contract</span><span class="mono">${esc(i.contract || "")}</span></div>
      <div class="row"><span class="muted">Batches published</span><span>${h.batches - h.batches_waiting} of ${h.batches}</span></div>
      <div class="row"><span class="muted">Waiting in offline queue</span><span>${h.batches_waiting}</span></div></div>
      <div class="card"><h2>Adapter design</h2><p class="muted">Anchoring goes through one EVM adapter. Moving from this test network to eGovChain changes the endpoint, the contract address and the signing key. Nothing in the office database changes.</p></div></div>`;
  };
  pages.networks.after = function () {};

  /* ---------- proofs: merkle check done in the browser ---------- */
  const hex2b = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16))); // hex text to bytes
  const b2hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); // bytes to hex text
  const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  const split = (n) => {
    let k = 1;
    while (k * 2 < n) k *= 2;
    return k; // same rule as merkle.go
  };
  async function node(l, r) {
    // parent hash, 0x01 marks an inner node
    const b = new Uint8Array(65);
    b[0] = 1;
    b.set(l, 1);
    b.set(r, 33);
    return sha256(b);
  }
  async function rootFrom(leaf, i, n, proof) {
    // rebuilds the root from one leaf and its siblings
    if (n === 1) return proof.length ? null : leaf;
    if (!proof.length) return null;
    const k = split(n),
      sib = proof[proof.length - 1],
      rest = proof.slice(0, -1);
    if (i < k) {
      const l = await rootFrom(leaf, i, k, rest);
      return l && node(l, sib);
    }
    const r = await rootFrom(leaf, i - k, n - k, rest);
    return r && node(sib, r);
  }
  async function checkProof(seq) {
    // fetches a proof and re-does the maths locally
    const p = await api("/v1/events/" + seq + "/proof");
    const root = await rootFrom(hex2b(p.leaf), p.index, p.batch_size, p.siblings.map(hex2b));
    return { p, ok: !!root && b2hex(root) === p.root };
  }
  function proofHtml(r) {
    const p = r.p;
    return `<div class="alert ${r.ok ? "ok" : "bad"}" style="margin:12px 0"><span><b>${r.ok ? "Proof is valid." : "Proof does not add up."}</b>
      ${r.ok ? `Event ${p.seq} is leaf ${p.index + 1} of ${p.batch_size} in batch B-${p.batch_id}.` : "The leaf and sibling hashes do not produce the batch root."}</span></div>
      <div class="fp"><small>Leaf (this event)</small><div class="mono">${esc(p.leaf)}</div>
      <small>Sibling hashes (${p.siblings.length})</small><div class="mono">${p.siblings.map(esc).join("<br>") || "none, the batch has one event"}</div>
      <small>Batch root, recomputed in this browser</small><div class="mono">${esc(p.root)}</div>
      <small>Anchoring transaction</small><div class="mono">${p.anchored ? esc(p.tx_hash) : "not anchored yet"}</div></div>
      <p class="muted">This recomputes the batch root from the event. To confirm the root against the chain itself, run <span class="mono">cyfr-verify</span>.</p>`;
  }

  /* ---------- verify records ---------- */
  function checkSteps(c, forged) {
    // the three levels of verification as a short list. "forged" changes the wording for the rewrite test
    const step = (st, title, note) =>
      `<div class="${st}"><i>${st === "d" ? "✓" : "!"}</i><div><b>${title}</b><small>${note}</small></div></div>`;
    const chainOK = !c.chain_error && c.mismatch_count === 0;
    return `<div class="pl">
      ${step(c.entries_ok ? "d" : "x", "Chain of entries", c.entries_ok ? `${c.entries.toLocaleString()} entries each link to the one before${forged ? ". The rewritten copy is consistent" : ""}` : esc(c.entries_error))}
      ${step(c.batches_ok ? "d" : "x", "Batch Merkle roots", c.batches_ok ? `${c.batches} roots recomputed from their entries${forged ? ". The rewritten copy is consistent" : ""}` : esc(c.batches_error))}
      ${
        c.chain_error
          ? step("x", "Roots on the blockchain", esc(c.chain_error))
          : step(
              chainOK ? "d" : "x",
              "Roots on the blockchain",
              chainOK
                ? `${c.chain_matched} of ${c.chain_checked} anchored roots match the contract${c.chain_waiting ? `, ${c.chain_waiting} waiting to anchor` : ""}`
                : `${c.mismatch_count} of ${c.chain_checked} anchored roots do not match the contract, starting at batch B-${c.mismatches[0].batch}`,
            )
      }</div>`;
  }
  function findingHistoryCard() {
    // every finding, open or closed. each one has its own ledger entries, so it outlives the data being put back
    return `<div class="card"><div class="card-h"><h2>Finding history</h2><span class="muted">Each finding is opened and closed with its own ledger entry, so it stays on record after the data is put back.</span></div><div id="fhist" class="scroll"><p class="muted">Loading</p></div></div>`;
  }
  function findingHistory(list) {
    if (!list.length) return '<p class="muted">No findings so far.</p>';
    return `<table class="dense"><thead><tr><th>Opened</th><th>Closed</th><th>Table</th><th>Row</th><th>Finding</th><th class="num">Ledger entries</th></tr></thead><tbody>${list
      .map(
        (
          f,
        ) => `<tr class="${f.close_seq ? "" : "flag"}"><td>${when(new Date(f.opened_at))}</td><td>${f.close_seq ? when(new Date(f.closed_at)) : pill("Open", "bad")}</td>
        <td>${esc(f.table)}</td><td class="mono">${esc(f.pk)}</td><td>${esc(f.kind)}</td><td class="num">${f.open_seq}${f.close_seq ? ", " + f.close_seq : ""}</td></tr>`,
      )
      .join("")}</tbody></table>`;
  }
  pages.verify.r = function () {
    const h = live.health;
    const rows = h.alerts
      .map(
        (a) =>
          `<tr class="flag"><td>${esc(a.table)}</td><td class="mono">${esc(a.pk)}</td><td>${esc(a.kind)}</td><td>${a.ledger_seq || "none"}</td></tr>`,
      )
      .join("");
    const chainCards = live.info.demo
      ? `<div class="grid g2e"><div class="card"><div class="card-h"><h2>Ledger against the blockchain</h2></div>
          <p class="muted">Checks that every entry links to the one before, that every batch root is the true root of its entries, and that each anchored root is the one the contract holds.</p>
          <button class="btn primary" id="vc" style="margin-top:14px">Verify now</button><div id="vcres"></div></div>
        <div class="card"><div class="card-h"><h2>Rewrite test</h2></div>
          <p class="muted">Rewrites a copy of the ledger the way someone with full access to this computer could: one entry is altered, then every hash after it is recomputed. The real ledger is not touched.</p>
          <form id="rw" class="inline-form"><input id="rwseq" type="number" min="1" max="${h.events}" value="${Math.max(1, Math.ceil(h.events / 2))}" aria-label="Entry to alter" required><button class="btn">Run on a copy</button></form><div id="rwres"></div></div></div>`
      : "";
    return `<div class="grid g2"><div class="card"><div class="card-h"><h2>Database against ledger</h2>${pill(h.last_reconcile ? "Last check " + clock(new Date(h.last_reconcile)) : "No check yet", "gray")}</div>
      <p class="muted">The agent re-hashes every live row in the protected tables and compares it with the latest fingerprint in the ledger. A row appears here when it disagrees on two checks in a row.</p>
      <div style="margin-top:16px">${
        h.alerts.length
          ? `<div class="alert bad"><span><b>${h.alerts.length} row${h.alerts.length === 1 ? " differs" : "s differ"} from the ledger.</b></span></div><div class="scroll" style="margin-top:12px"><table><thead><tr><th>Table</th><th>Row key</th><th>Finding</th><th>Ledger entry</th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<div class="alert ok"><span><b>All live rows match the ledger.</b></span></div>'
      }</div></div>
      <div class="card"><div class="card-h"><h2>Check a proof</h2></div><p class="muted">Enter an entry number from the ledger. The browser fetches its Merkle proof and recomputes the batch root itself.</p>
      <form id="pf" class="inline-form"><input id="ps" type="number" min="1" placeholder="Entry number" required><button class="btn primary">Check proof</button></form><div id="pres"></div></div></div>${chainCards}${findingHistoryCard()}`;
  };
  pages.verify.after = function () {
    api("/v1/findings") // load the history beneath the other cards
      .then((d) => $("#fhist") && ($("#fhist").innerHTML = findingHistory(d.findings)))
      .catch(
        () =>
          $("#fhist") && ($("#fhist").innerHTML = '<p class="muted">The history could not be loaded.</p>'),
      );
    $("#pf").onsubmit = async (e) => {
      e.preventDefault();
      try {
        $("#pres").innerHTML = proofHtml(await checkProof(+$("#ps").value));
      } catch (err) {
        $("#pres").innerHTML =
          '<div class="alert warn" style="margin-top:12px"><span>That entry was not found, or its batch has not closed yet.</span></div>';
      }
    };
    if (!$("#vc")) return; // the two blockchain cards exist only in demo mode
    $("#vc").onclick = async () => {
      $("#vcres").innerHTML =
        '<p class="muted" style="margin-top:12px"><span class="spin"></span> Reading roots from the contract</p>';
      try {
        const c = await api("/v1/demo/verify");
        const ok = c.entries_ok && c.batches_ok && !c.chain_error && c.mismatch_count === 0;
        $("#vcres").innerHTML =
          checkSteps(c, false) +
          `<div class="alert ${ok ? "ok" : "bad"}"><span><b>${ok ? "The ledger is intact and matches the blockchain." : "The ledger does not verify."}</b></span></div>`;
      } catch (err) {
        $("#vcres").innerHTML =
          `<div class="alert warn" style="margin-top:12px"><span>${esc(err.message)}</span></div>`;
      }
    };
    $("#rw").onsubmit = async (e) => {
      e.preventDefault();
      $("#rwres").innerHTML =
        '<p class="muted" style="margin-top:12px"><span class="spin"></span> Rewriting a copy and checking it</p>';
      try {
        const out = await api("/v1/demo/rewrite-test", { seq: +$("#rwseq").value }),
          c = out.result,
          m = c.mismatches[0];
        const caught = c.mismatch_count > 0;
        $("#rwres").innerHTML =
          `<p class="mon-h" style="margin-top:14px">Entry ${out.seq} altered in the copy, and ${(c.entries - out.seq + 1).toLocaleString()} hashes recomputed after it.</p>` +
          checkSteps(c, true) +
          (m
            ? `<div class="fp"><small>Batch B-${m.batch} in the rewritten ledger</small><div class="mono">${esc(m.ledger_root)}</div><small>Batch B-${m.batch} on the blockchain</small><div class="mono">${esc(m.chain_root)}</div></div>`
            : "") +
          `<div class="alert ${caught ? "bad" : "warn"}" style="margin-top:12px"><span>${caught ? "<b>Rewrite exposed by the blockchain.</b> Both local checks accepted the rewritten ledger. Only the roots already anchored show that it was changed." : "<b>Nothing to compare yet.</b> The altered entry is not in an anchored batch, so only the local checks apply to it."}</span></div>`;
      } catch (err) {
        $("#rwres").innerHTML =
          `<div class="alert warn" style="margin-top:12px"><span>${esc(err.message)}</span></div>`;
      }
    };
  };

  /* ---------- record drawer ---------- */
  openRec = function (seq) {
    // replaces the sample drawer with real fields
    const r = ledger.find((l) => l.seq === seq),
      d = $("#drawer");
    if (!r) return;
    d.innerHTML = `<div class="row"><h2>Event #${r.seq}</h2><button class="btn sm" id="x">Close</button></div><p class="muted">${esc(r.table)}, ${esc(r.office)}</p>
      <dl><dt>Operation</dt><dd>${opTag(r.op)}</dd><dt>Captured</dt><dd>${r.time.toLocaleString()}</dd>
      <dt>Record fingerprint</dt><dd class="mono">${r.hash}</dd><dt>Status</dt><dd>${statusTag(r)}</dd>
      <dt>Batch</dt><dd>${r.batch}</dd><dt>Transaction</dt><dd class="mono">${r.status === "Queued" ? "Waiting to be anchored" : esc(r.tx)}</dd></dl>
      <p class="muted">The fingerprint is a keyed hash. The record itself never leaves the database.</p>
      ${r.batch === "Pending" ? "" : '<button class="btn primary block" id="vp">Check Merkle proof</button>'}<div id="dp"></div>`;
    d.hidden = false;
    $("#x").onclick = () => (d.hidden = true);
    const vp = $("#vp");
    if (vp)
      vp.onclick = async () => {
        try {
          $("#dp").innerHTML = proofHtml(await checkProof(r.seq));
        } catch (e) {
          $("#dp").innerHTML = '<p class="muted">The proof could not be fetched.</p>';
        }
      };
  };

  /* ---------- office simulator: stands in for the office's own systems ---------- */
  const NATURE = [
    "Business permit renewal",
    "Real property tax",
    "Community tax certificate",
    "Market stall rental",
    "Building permit fee",
    "Civil registry certification",
  ];
  const TRIGGER = { update: "cyfr_receipts_au", delete: "cyfr_receipts_ad", insert: "cyfr_receipts_ai" }; // which trigger records which statement
  const pkId = (a) => {
    // the row id inside a finding's key, or null when the key is only a digest
    try {
      return JSON.parse(a.pk).id;
    } catch (e) {
      return null;
    }
  };
  const describe = (a) =>
    // one finding in plain words
    a.kind.includes("removed")
      ? `A row recorded in ledger entry ${a.ledger_seq} is missing from ${esc(a.table)}`
      : a.kind.includes("never recorded")
        ? `Row ${esc(a.pk)} in ${esc(a.table)} has no ledger entry`
        : a.kind.includes("deleted")
          ? `Row ${esc(a.pk)} in ${esc(a.table)} exists, but ledger entry ${a.ledger_seq} says it was deleted`
          : `Row ${esc(a.pk)} in ${esc(a.table)} no longer matches ledger entry ${a.ledger_seq}`;
  const findingFor = (t) =>
    // the finding raised by the last console statement, if any
    live.health.alerts.find(
      (a) => a.table === "receipts" && (t.op === "delete" ? a.kind.includes("removed") : pkId(a) === t.id),
    );

  function tillList() {
    // the collections terminal's own list of receipts. the office system knows nothing about cyfr
    if (!demo.rows.length) return '<p class="muted">No receipts yet.</p>';
    return `<table class="dense"><thead><tr><th>OR no.</th><th>Payor</th><th>Nature of collection</th><th class="num">Amount</th><th></th></tr></thead><tbody>${demo.rows
      .map((r) => {
        const voided = r.remarks.startsWith("VOID");
        return `<tr class="${voided ? "void" : ""}"><td class="mono">${esc(r.or_number)}</td><td>${esc(r.payer_name)}</td><td>${esc(r.particulars)}${voided ? `<br><span class="muted">${esc(r.remarks)}</span>` : ""}</td>
          <td class="num">${peso(r.amount)}</td><td class="num">${voided ? "" : `<button class="btn sm" data-void="${r.id}">Void</button>`}</td></tr>`;
      })
      .join("")}</tbody></table>`;
  }
  function dbGrid() {
    // the receipts table as a database client would show it
    if (!demo.rows.length) return '<p class="muted mono">Empty set</p>';
    return `<table class="dense grid-t"><thead><tr><th>id</th><th>or_number</th><th>payer_name</th><th class="num">amount</th><th>remarks</th></tr></thead><tbody>${demo.rows
      .map(
        (r) =>
          `<tr class="click" data-pick="${r.id}"><td>${r.id}</td><td>${esc(r.or_number)}</td><td>${esc(r.payer_name)}</td><td class="num">${esc(r.amount)}</td><td>${r.remarks ? esc(r.remarks) : '<span class="muted">NULL</span>'}</td></tr>`,
      )
      .join("")}</tbody></table>`;
  }
  function sqlText(f) {
    // the statements the console is about to run, as an administrator would type them
    const op = f.op.value,
      id = f.id.value || "?",
      amt = f.amount.value.trim() || "0.00";
    const stmt =
      op === "update"
        ? `UPDATE receipts SET amount = ${amt} WHERE id = ${id};`
        : op === "delete"
          ? `DELETE FROM receipts WHERE id = ${id};`
          : `INSERT INTO receipts (or_number, payer_name, particulars, amount, collector, paid_at)\n  VALUES (<next OR no.>, '${f.payer.value.trim() || "Walk-in payor"}', 'Real property tax', ${amt}, 'M. Santos', NOW() - INTERVAL 1 DAY);`;
    return f.bypass.checked
      ? `DROP TRIGGER ${TRIGGER[op]};\n${stmt}\nCREATE TRIGGER ${TRIGGER[op]} AFTER ${op.toUpperCase()} ON receipts ... ;`
      : stmt;
  }
  function sqlFields(f) {
    // shows only the inputs the chosen statement needs
    const op = f.op.value;
    f.querySelector("[data-f=id]").hidden = op === "insert";
    f.querySelector("[data-f=amount]").hidden = op === "delete";
    f.querySelector("[data-f=payer]").hidden = op !== "insert";
    $("#qsql").textContent = sqlText(f);
  }
  function monitor() {
    // what cyfr has done about the last action taken on this page
    const h = live.health,
      t = demo.track;
    const idle = `<p class="muted">Watching ${(live.info.tables || []).length} tables. ${h.last_reconcile ? "Last check at " + clock(new Date(h.last_reconcile)) + "." : ""} ${h.alerts.length ? "" : "No open findings."}</p>`;
    const restore = demo.canRestore && h.alerts.some((a) => a.kind.includes("removed")); // a deleted row the console can put back
    const findings = h.alerts.length
      ? `<div class="alert bad"><span><b>${h.alerts.length} open finding${h.alerts.length === 1 ? "" : "s"}.</b> ${h.alerts.map(describe).join(". ")}.</span>
          <span>${restore ? '<button class="btn sm" data-restore>Restore the row</button> ' : ""}<a class="btn sm" href="#/verify">Review</a></span></div>`
      : "";
    if (!t) return idle + findings;
    const step = (st, title, note) =>
      `<div class="${st}"><i>${st === "d" ? "✓" : st === "x" ? "!" : st === "r" ? '<span class="spin"></span>' : ""}</i><div><b>${title}</b><small>${note}</small></div></div>`;
    const head = `<p class="mon-h"><span class="mono">${t.time}</span> ${esc(t.text)}</p>`;
    const ev = ledger
      .filter((l) => l.seq > t.before && l.table === "receipts")
      .sort((a, b) => a.seq - b.seq)[0]; // the first entry after the action
    if (!ev && t.bypass) {
      const a = findingFor(t),
        waited = Date.now() - t.at > 4000;
      t.checks = t.checks || new Set(); // integrity checks that finished after the statement
      if (h.last_reconcile && Date.parse(h.last_reconcile) > t.at) t.checks.add(h.last_reconcile);
      if (!a && t.checks.size >= 2) {
        // two checks found no difference: a new mismatch would have been confirmed by now
        return `${head}<div class="pl">
          ${step("d", "Written to the database", "The statement ran and the table changed")}
          ${step("x", "No change was captured", "Nothing reached the ledger for this statement")}
          ${step("d", "Integrity check: the table matches the ledger", `${t.checks.size} checks since the statement found no difference`)}
          </div><div class="alert ${t.hadFinding ? "ok" : "warn"}"><span>${
            t.hadFinding
              ? "<b>The earlier finding is closed.</b> This statement undid a change that had been made with capture off, so the table is back to what the ledger last recorded. The finding and its closing both stay in the ledger. See the finding history on Verify records."
              : "<b>Nothing to flag.</b> The table ended up exactly as the ledger last recorded it, so there is no difference to report."
          }</span></div>${findings}`;
      }
      return `${head}<div class="pl">
        ${step("d", "Written to the database", "The statement ran and the table changed")}
        ${waited ? step("x", "No change was captured", "Nothing reached the ledger for this statement") : step("r", "Waiting for a captured change", "Every change to a protected table should produce a ledger entry")}
        ${a ? step("x", "Flagged by the integrity check", describe(a)) : step(waited ? "r" : "p", "Integrity check", "Live rows are re-hashed and compared with the ledger every few seconds")}
        </div>${findings}`;
    }
    const sealed = ev && ev.batch !== "Pending",
      anchored = ev && ev.status === "Anchored",
      off = demo.outage || !h.chain_up;
    return `${head}<div class="pl">
      ${step("d", "Written to the database", "By the office's own system. CYFR was not called")}
      ${ev ? step("d", "Captured by CYFR", `Ledger entry ${ev.seq}, ${ev.op}, fingerprint <span class="mono">${short(ev.hash)}</span>`) : step("r", "Waiting for a captured change", "The trigger writes an outbox entry in the same transaction")}
      ${sealed ? step("d", `Sealed in batch ${ev.batch}`, "Its fingerprint is part of the batch's Merkle root") : step(ev ? "r" : "p", "Batch", "Batches close on a timer or when full")}
      ${anchored ? step("d", "Anchored on the blockchain", `Transaction <span class="mono">${short(ev.tx)}</span>`) : off && sealed ? step("r", "Held in the offline queue", "The chain is unreachable. It will be sent when the link returns") : step(sealed ? "r" : "p", "Blockchain", "The batch root is sent to the contract")}
      </div>${findings}`;
  }
  const nowStamp = () =>
    new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  function demoBind() {
    // wires the buttons inside the parts that get redrawn
    document.querySelectorAll("[data-void]").forEach((b) => (b.onclick = () => voidReceipt(+b.dataset.void)));
    document.querySelectorAll("[data-pick]").forEach(
      (tr) =>
        (tr.onclick = () => {
          const f = $("#qf"),
            r = demo.rows.find((x) => x.id === +tr.dataset.pick);
          f.id.value = r.id;
          f.amount.value = r.amount;
          $("#qsql").textContent = sqlText(f);
        }),
    );
    document.querySelectorAll("[data-restore]").forEach(
      (b) =>
        (b.onclick = async () => {
          try {
            const before = live.health.events;
            const back = await api("/v1/demo/restore", {});
            demo.track = {
              id: back.id,
              before,
              at: Date.now(),
              time: nowStamp(),
              text: `Row ${back.or_number} put back exactly as it was`,
            };
            await pull();
          } catch (err) {
            toast(err.message);
          }
        }),
    );
  }
  function demoRefresh() {
    // updates the changing parts of the page without touching what the person is typing
    if ($("#modal")) return;
    if ($("#dlist")) $("#dlist").innerHTML = tillList();
    if ($("#dgrid")) {
      $("#dgrid").innerHTML = dbGrid();
      const sel = $("#qf").id,
        keep = sel.value; // refresh the row choices, keeping the selection if it still exists
      sel.innerHTML = demo.rows
        .map((r) => `<option value="${r.id}">id ${r.id}, ${esc(r.or_number)}</option>`)
        .join("");
      if (demo.rows.some((r) => String(r.id) === keep)) sel.value = keep;
      $("#qsql").textContent = sqlText($("#qf"));
    }
    $("#dtrack").innerHTML = monitor();
    if (document.activeElement !== $("#dout")) $("#dout").checked = !demo.outage;
    demoBind();
  }
  function voidReceipt(id) {
    // voiding is how a collector cancels a receipt: the record stays, marked void, with a reason
    const r = demo.rows.find((x) => x.id === id);
    modal(`<h2>Void receipt ${esc(r.or_number)}</h2><p class="muted">The receipt stays on file and is marked void. The amount is not changed.</p>
      <form id="vf" class="fgrid"><label class="full">Reason<input name="reason" required value="Wrong payor name"></label>
      <div class="full row"><button type="button" class="btn" id="cx">Cancel</button><button class="btn primary">Void receipt</button></div></form>`);
    $("#cx").onclick = closeModal;
    $("#vf").onsubmit = async (e) => {
      e.preventDefault();
      try {
        const before = live.health.events;
        await api(`/v1/demo/receipts/${id}/void`, { reason: e.target.reason.value });
        demo.track = {
          id,
          before,
          at: Date.now(),
          time: nowStamp(),
          text: `Receipt ${r.or_number} voided at the collections terminal`,
        };
        closeModal();
        await pull();
      } catch (err) {
        toast(err.message);
      }
    };
  }
  pages.demo = {
    t: "Office simulator",
    s: "Stands in for the office's own systems. Every action goes to the real test database.",
    r() {
      const till = demo.tab !== "db",
        first = demo.rows[0];
      const left = till
        ? `<header class="lgu-h"><div><b>City Treasurer's Office</b><span>Collections terminal</span></div><span class="muted">Collector: M. Santos</span></header>
          <form id="df" class="fgrid"><label class="full">Payor<input name="payer" required value="Juan Dela Cruz"></label>
          <label>Nature of collection<select name="particulars">${NATURE.map((n) => `<option>${n}</option>`).join("")}</select></label>
          <label>Amount (₱)<input name="amount" inputmode="decimal" required value="1500.00"></label>
          <p class="full" id="de" style="color:var(--bad)" hidden></p>
          <div class="full row"><span class="muted">Official receipt, Accountable Form 51, general fund</span><button class="btn primary">Issue receipt</button></div></form>
          <h2 class="sub-h">Receipts issued</h2><div id="dlist" class="scroll">${tillList()}</div>`
        : `<header class="lgu-h"><div><b class="mono">root@db-server</b><span>MySQL client, connected to lgu_test</span></div><span class="muted">Direct database access</span></header>
          <div id="dgrid" class="scroll">${dbGrid()}</div>
          <form id="qf" class="sqlc"><div class="fgrid">
          <label>Statement<select name="op"><option value="update">UPDATE: change an amount</option><option value="delete">DELETE: remove a row</option><option value="insert">INSERT: add a back-dated row</option></select></label>
          <label data-f="id">Row<select name="id">${demo.rows.map((r) => `<option value="${r.id}">id ${r.id}, ${esc(r.or_number)}</option>`).join("")}</select></label>
          <label data-f="payer" hidden>Payor name<input name="payer" value="Walk-in payor"></label>
          <label data-f="amount">Amount<input name="amount" inputmode="decimal" value="${first ? (Number(first.amount) / 100).toFixed(2) : "0.00"}"></label>
          <label class="full check"><input type="checkbox" name="bypass"> Drop the change-capture trigger first, then put it back</label></div>
          <pre class="sql" id="qsql"></pre>
          <div class="row"><span class="muted mono" id="qmsg"></span><button class="btn primary">Run</button></div></form>`;
      return `<div class="grid g2 ws"><section class="card">
          <div class="tabs" role="tablist"><button data-wt="till" class="${till ? "on" : ""}">Collections terminal</button><button data-wt="db" class="${till ? "" : "on"}">Database console</button></div>${left}</section>
        <aside class="card mon"><div class="card-h"><h2>Integrity monitor</h2><span class="muted">What CYFR records</span></div><div id="dtrack">${monitor()}</div>
          <div class="setrow link"><span>Office internet link<small>Switch off to see changes queue offline</small></span><label class="switch"><input type="checkbox" id="dout" aria-label="Office internet link"><span></span></label></div></aside></div>`;
    },
    after() {
      $("#dout").checked = !demo.outage;
      demoBind();
      document.querySelectorAll("[data-wt]").forEach(
        (b) =>
          (b.onclick = () => {
            demo.tab = b.dataset.wt;
            render();
          }),
      );
      $("#dout").onchange = async (e) => {
        try {
          await api("/v1/demo/outage", { on: !e.target.checked });
          toast(e.target.checked ? "Internet link restored" : "Internet link is down");
          await pull();
        } catch (err) {
          toast(err.message);
        }
      };
      const df = $("#df");
      if (df)
        df.onsubmit = async (e) => {
          e.preventDefault();
          const body = {
            payer: df.payer.value,
            particulars: df.particulars.value,
            amount: df.amount.value.trim(),
            collector: "M. Santos",
          };
          try {
            const before = live.health.events;
            const made = await api("/v1/demo/receipts", body);
            demo.track = {
              id: made.id,
              before,
              at: Date.now(),
              time: nowStamp(),
              text: `Receipt ${made.or_number} issued for ${peso(body.amount)}`,
            };
            $("#de").hidden = true;
            await pull();
          } catch (err) {
            $("#de").textContent = err.message;
            $("#de").hidden = false;
          }
        };
      const qf = $("#qf");
      if (qf) {
        qf.oninput = () => sqlFields(qf);
        qf.onchange = () => sqlFields(qf);
        sqlFields(qf);
        qf.onsubmit = async (e) => {
          e.preventDefault();
          const op = qf.op.value,
            id = +qf.id.value,
            bypass = qf.bypass.checked;
          const r = demo.rows.find((x) => x.id === id);
          if (op !== "insert" && !r) {
            $("#qmsg").textContent = "ERROR: choose a row first";
            return;
          }
          try {
            const before = live.health.events;
            const out = await api("/v1/demo/sql", {
              op,
              id,
              amount: qf.amount.value.trim(),
              payer: qf.payer.value,
              bypass,
            });
            const what =
              op === "insert" ? "INSERT of a back-dated receipt" : `${op.toUpperCase()} on ${r.or_number}`;
            demo.track = {
              op,
              id: out.id,
              bypass,
              hadFinding: live.health.alerts.length > 0, // was something already flagged before this statement?
              before,
              at: Date.now(),
              time: nowStamp(),
              text: `${what} run from the database console`,
            };
            $("#qmsg").textContent = `Query OK, ${bypass ? "3 statements" : "1 row affected"}`;
            await pull();
          } catch (err) {
            $("#qmsg").textContent = "ERROR: " + err.message;
          }
        };
      }
    },
  };

  /* ---------- documents: register official files, and check any copy against them ---------- */
  const docs = { list: [] }; // registered documents, refreshed while the page is open
  const size = (n) =>
    n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
  async function fileSum(file) {
    // the file's sha-256 fingerprint, computed here in the browser. the file itself is never sent anywhere
    return b2hex(await sha256(new Uint8Array(await file.arrayBuffer())));
  }
  const dropZone = (id, text, note) =>
    `<label class="drop" id="${id}"><input type="file" hidden><b>${text}</b><span>${note}</span></label>`;
  function wireDrop(id, onFile) {
    // a file can be chosen with the dialog or dropped onto the box
    const z = $("#" + id),
      input = z.querySelector("input");
    const take = (f) => {
      if (!f) return;
      if (f.size > 200 * 1048576) return toast("Choose a file under 200 MB");
      onFile(f);
    };
    input.onchange = () => take(input.files[0]);
    z.ondragover = (e) => {
      e.preventDefault();
      z.classList.add("over");
    };
    z.ondragleave = () => z.classList.remove("over");
    z.ondrop = (e) => {
      e.preventDefault();
      z.classList.remove("over");
      take(e.dataTransfer.files[0]);
    };
  }
  const VIEWABLE = ["application/pdf", "text/plain", "image/png", "image/jpeg", "image/gif", "image/webp"]; // safe to open in a tab
  async function archiveUpload(file) {
    // sends the file itself to the agent's archive folder. the agent keeps it only if it is registered
    const res = await fetch("/v1/documents/archive", {
      method: "POST",
      headers: { Authorization: "Bearer " + live.key, "Content-Type": "application/octet-stream" },
      body: file,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "the copy was not archived");
  }
  async function openCopy(sum, download) {
    // fetches the office's copy. the agent re-checks it against the anchored fingerprint every time
    const d = docs.list.find((x) => x.sha256 === sum) || {};
    const view = !download && VIEWABLE.includes(d.file_type);
    const tab = view ? window.open("", "_blank") : null; // opened now, while the click still counts, filled in below
    try {
      const res = await fetch(`/v1/documents/${sum}/file`, {
        headers: { Authorization: "Bearer " + live.key },
      });
      if (!res.ok)
        throw new Error((await res.json().catch(() => ({}))).detail || "the copy could not be opened");
      const intact = res.headers.get("X-Cyfr-Intact") === "yes",
        got = res.headers.get("X-Cyfr-Sha256");
      const blob = new Blob([await res.arrayBuffer()], {
        type:
          d.file_type === "text/plain"
            ? "text/plain;charset=utf-8"
            : d.file_type || "application/octet-stream",
      });
      const url = URL.createObjectURL(blob);
      if (!intact) {
        if (tab) tab.close();
        const m =
          modal(`<h2>The office copy has been changed</h2><p class="muted">The file kept in the archive no longer matches the fingerprint that was registered and anchored. It was altered or replaced on disk after registration, so it is not shown as the original.</p>
          <div class="fp"><small>Registered and anchored fingerprint</small><div class="mono">${esc(sum)}</div><small>Fingerprint of the file now on disk</small><div class="mono">${esc(got || "")}</div></div>
          <div class="row" style="margin-top:16px"><button class="btn" id="cx">Close</button><a class="btn danger" id="dl" download="${esc("CHANGED-" + (d.file_name || "file"))}">Download it for inspection</a></div>`);
        m.querySelector("#dl").href = url;
        m.querySelector("#cx").onclick = closeModal;
        return;
      }
      if (tab) {
        tab.location = url;
        return;
      }
      const a = document.createElement("a"); // save it under its original name
      a.href = url;
      a.download = d.file_name || "document";
      a.click();
    } catch (err) {
      if (tab) tab.close();
      toast(err.message);
    }
  }
  function copyCell(d) {
    // the office copy of one registered document
    if (!d.archived) return '<span class="muted">Not kept</span>';
    if (!d.archive_intact)
      return `${pill("Changed on disk", "bad")} <button class="btn sm" data-open="${d.sha256}">Inspect</button>`;
    return `${VIEWABLE.includes(d.file_type) ? `<button class="btn sm" data-open="${d.sha256}">View</button> ` : ""}<button class="btn sm" data-get="${d.sha256}">Download</button>`;
  }
  function bindCopies(root) {
    root.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openCopy(b.dataset.open, false)));
    root.querySelectorAll("[data-get]").forEach((b) => (b.onclick = () => openCopy(b.dataset.get, true)));
  }
  function docTable() {
    if (!docs.list.length) return '<p class="muted">No documents registered yet.</p>';
    return `<table class="dense"><thead><tr><th>Registered</th><th>Document</th><th>File</th><th>Fingerprint</th><th class="num">Entry</th><th>Status</th><th>Office copy</th></tr></thead><tbody>${docs.list
      .map(
        (
          d,
        ) => `<tr><td>${when(new Date(d.registered_at))}</td><td>${esc(d.label || "(no label)")}</td><td>${esc(d.file_name)}<br><span class="muted">${size(d.size)}</span></td>
        <td class="mono nowrap">${short(d.sha256)}</td><td class="num">${d.seq}</td><td>${d.anchored ? pill("Anchored") : d.batch_id ? pill("Waiting to anchor", "warn") : pill("Waiting for batch", "warn")}</td><td class="nowrap">${copyCell(d)}</td></tr>`,
      )
      .join("")}</tbody></table>`;
  }
  async function docRefresh() {
    try {
      docs.list = (await api("/v1/documents")).documents;
      if ($("#doclist")) {
        $("#doclist").innerHTML = docTable();
        bindCopies($("#doclist"));
      }
    } catch (e) {
      /* the next poll tries again */
    }
  }
  function checkResult(sum, r) {
    // explains the outcome of checking one file
    const fp = `<div class="fp"><small>Fingerprint of the file you chose</small><div class="mono">${sum}</div></div>`;
    if (!r.found)
      return `<div class="alert bad"><span><b>No match.</b> This file was never registered. Either it is not one of the office's registered documents, or it is a copy that was changed after registration, even by a single character.</span></div>${fp}`;
    const step = (st, title, note) =>
      `<div class="${st}"><i>${st === "d" ? "✓" : st === "x" ? "!" : '<span class="spin"></span>'}</i><div><b>${title}</b><small>${note}</small></div></div>`;
    const when2 = new Date(r.registered_at).toLocaleString();
    const steps = [
      step("d", "Fingerprint found", `Registered ${when2} as “${esc(r.label || "no label")}”`),
      r.sealed
        ? step(
            "d",
            `Sealed in ledger entry ${r.seq}`,
            "This exact fingerprint is the one stored in the entry",
          )
        : step("x", `Ledger entry ${r.seq} does not hold this fingerprint`, "The ledger has been altered"),
      !r.batch_closed
        ? step("r", "Waiting for the batch to close", "Batches close on a timer or when full")
        : r.in_batch
          ? step(
              "d",
              `Included in batch B-${r.batch_id}`,
              "The Merkle proof from the entry to the batch root checks out",
            )
          : step("x", `Not part of batch B-${r.batch_id}`, "The Merkle proof fails"),
      r.chain_checked
        ? r.on_chain
          ? step(
              "d",
              "Batch root matches the blockchain",
              `Transaction <span class="mono">${short(r.tx_hash.startsWith("0x") ? r.tx_hash : "")}</span>`,
            )
          : step(
              "x",
              "Batch root differs from the blockchain",
              "The local records were rewritten after anchoring",
            )
        : r.chain_error
          ? step("x", "The blockchain could not be read", esc(r.chain_error))
          : step("r", "Waiting to be anchored", "The batch root is sent to the contract"),
    ];
    const failed = !r.sealed || (r.batch_closed && !r.in_batch) || (r.chain_checked && !r.on_chain);
    const complete = r.sealed && r.in_batch && r.chain_checked && r.on_chain;
    const verdict = failed
      ? '<div class="alert bad"><span><b>The record does not verify.</b> The fingerprint was found, but the proof to the blockchain is broken.</span></div>'
      : complete
        ? `<div class="alert ok"><span><b>Authentic.</b> This file is identical, byte for byte, to the one registered on ${when2}, and the proof reaches a root on the blockchain.</span></div>`
        : '<div class="alert warn"><span><b>Registered, not yet anchored.</b> The fingerprint matches. The proof is complete once its batch is on the blockchain.</span></div>';
    const original = r.archived
      ? `<div class="row" style="margin-top:12px"><span class="muted">${r.archive_intact ? "The registered original is in the office archive." : "The office copy of the original has been changed on disk."}</span><button class="btn sm" data-open="${r.sha256}">${r.archive_intact ? "Open the original" : "Inspect"}</button></div>`
      : "";
    return `${verdict}<div class="pl">${steps.join("")}</div>${fp}${original}`;
  }
  pages.documents = {
    t: "Documents",
    s: "Register official files on the blockchain, and check any copy against them",
    r() {
      return `<div class="grid g2e">
        <div class="card"><div class="card-h"><h2>Register a document</h2></div>
          <p class="muted">For final, official files: an approved ordinance, a signed contract, an issued certificate. Registering fixes the file's fingerprint in the ledger, and with the next batch, on the blockchain.</p>
          ${dropZone("rz", "Choose a file to register", "Or drop it here. It is fingerprinted in this browser. The file itself goes to the office archive only if you keep a copy.")}<div id="rpick"></div><div id="rres"></div></div>
        <div class="card"><div class="card-h"><h2>Check a document</h2></div>
          <p class="muted">Choose any copy, such as a file someone sent you. If it matches a registered document byte for byte, you see when it was registered and the proof that reaches the blockchain.</p>
          ${dropZone("cz", "Choose a file to check", "Or drop it here. It is fingerprinted in this browser and never uploaded.")}<div id="cres"></div></div></div>
        <div class="card"><div class="card-h"><h2>Registered documents</h2><span class="muted">Only fingerprints go into the ledger and onto the blockchain. Office copies stay on this computer.</span></div><div id="doclist" class="scroll">${docTable()}</div></div>`;
    },
    after() {
      docRefresh();
      wireDrop("rz", async (file) => {
        $("#rres").innerHTML = "";
        $("#rpick").innerHTML =
          '<p class="muted" style="margin-top:12px"><span class="spin"></span> Fingerprinting the file</p>';
        const sum = await fileSum(file);
        $("#rpick").innerHTML =
          `<form id="rf" class="fgrid"><div class="full fp"><small>File</small><div>${esc(file.name)}, ${size(file.size)}</div><small>SHA-256 fingerprint</small><div class="mono">${sum}</div></div>
          <label class="full">Label<input name="label" required maxlength="150" value="${esc(file.name.replace(/\.[^.]+$/, ""))}"></label>
          <label class="full check"><input type="checkbox" name="keep" checked> Keep a copy in the office archive, so it can be opened from this console</label>
          <div class="full row"><span class="muted">Only the fingerprint is recorded.</span><button class="btn primary">Register document</button></div></form>`;
        $("#rf").onsubmit = async (e) => {
          e.preventDefault();
          try {
            const out = await api("/v1/documents", {
              sha256: sum,
              label: e.target.label.value,
              file_name: file.name,
              file_type: file.type || "unknown",
              size: file.size,
            });
            const keep = e.target.keep.checked;
            let kept = "";
            if (keep) {
              try {
                await archiveUpload(file);
                kept = " A copy is kept in the office archive.";
              } catch (err) {
                kept = ` The copy was not archived: ${esc(err.message)}.`;
              }
            }
            $("#rpick").innerHTML = "";
            $("#rres").innerHTML = out.existing
              ? `<div class="alert warn" style="margin-top:12px"><span><b>Already registered.</b> This exact file was registered on ${new Date(out.registered_at).toLocaleString()} as ledger entry ${out.seq}. The first registration stands.${kept}</span></div>`
              : `<div class="alert ok" style="margin-top:12px"><span><b>Registered as ledger entry ${out.seq}.</b> It is sealed in the next batch, then anchored. Keep the file unchanged: any edit, even re-saving it, produces a different fingerprint.${kept}</span></div>`;
            docRefresh();
          } catch (err) {
            $("#rres").innerHTML =
              `<div class="alert warn" style="margin-top:12px"><span>${esc(err.message)}</span></div>`;
          }
        };
      });
      wireDrop("cz", async (file) => {
        $("#cres").innerHTML =
          '<p class="muted" style="margin-top:12px"><span class="spin"></span> Fingerprinting and checking</p>';
        try {
          const sum = await fileSum(file);
          $("#cres").innerHTML =
            `<p class="mon-h" style="margin-top:14px">${esc(file.name)}, ${size(file.size)}</p>` +
            checkResult(sum, await api("/v1/documents/verify", { sha256: sum }));
          bindCopies($("#cres"));
        } catch (err) {
          $("#cres").innerHTML =
            `<div class="alert warn" style="margin-top:12px"><span>${esc(err.message)}</span></div>`;
        }
      });
    },
  };

  /* ---------- start ---------- */
  await connect();
  const d = document.createElement("a"); // documents are part of live mode, so the link is added here
  d.href = "#/documents";
  d.innerHTML = icon("file") + "Documents";
  document.querySelector('#nav>a[href="#/verify"]').after(d);
  if (live.info.demo) {
    // show the demo page in the menu only when the agent runs in demo mode
    const a = document.createElement("a");
    a.href = "#/demo";
    a.innerHTML = icon("office") + "Office simulator";
    d.after(a);
  }
  await pull(); // first full draw
  if (!live.health) strip.textContent = "Live mode. The agent did not answer";
  else render();
  setInterval(pull, POLL_MS); // then keep it fresh
})();
