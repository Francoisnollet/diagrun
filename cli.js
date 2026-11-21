#!/usr/bin/env node
// diag run : une commande : lit tes sessions Claude Code, ouvre un diagnostic dans le navigateur.
// Tout reste en local : rien n'est envoyé nulle part. Aucune dépendance (Node 18+).
const fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");

// Tarifs ($/M tokens) : hypothèse, à ajuster. Sur abonnement, lis-les comme des PARTS de consommation.
const PRICES = { opus: [5, 25], sonnet: [3, 15], haiku: [1, 5] };
const CW = 1.25, CR = 0.1;
const CTX_WARN = 100000, CTX_HIGH = 150000, BIG = 20000;
const EDIT = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"]);
const COMPLEX = /architect|refactor|redesign|migrat|investigat|root cause|pourquoi|concoi|conçoi|stratég|sécurit|security|performance|debug|race condition|from scratch/i;
const GIT = /\b(commit|push|pull request|pr|git (status|log|diff))\b/i;
const LABEL = { "question courte": "questions courtes", exploration: "recherches dans le code",
  "git/commande": "commandes git", "petite correction": "petites corrections", moyenne: "tâches moyennes", complexe: "tâches complexes" };
const TARGET = { "question courte": "haiku", exploration: "haiku", "git/commande": "haiku", "petite correction": "haiku", moyenne: "sonnet", complexe: null };
const RANK = { haiku: 0, sonnet: 1, opus: 2 };

const VERSION = (() => { try { return require("./package.json").version; } catch { return "dev"; } })();
if (process.argv.includes("--version")) { console.log(VERSION); process.exit(0); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const DAYS_ARG = arg("--days", null);
const MAX_DAYS = DAYS_ARG ? Number(DAYS_ARG) : 30;
const family = (m) => ["opus", "sonnet", "haiku"].find((f) => (m || "").toLowerCase().includes(f));
const cost = (fam, u, as) => { const [pi, po] = PRICES[as || fam]; return (u.in * pi + u.out * po + u.cw * pi * CW + u.cr * pi * CR) / 1e6; };
const textOf = (c) => typeof c === "string" ? c : (c || []).filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");

function walk(dir, out = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, out); else if (it.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function realPrompt(e) {
  if (e.type !== "user" || e.isSidechain || e.isMeta) return null;
  const c = e.message && e.message.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === "tool_result")) return null;
  const t = textOf(c).trim();
  if (!t || /^(<local-command|Caveat:|<system-reminder)/.test(t)) return null;
  return t;
}
const resultSize = (b) => typeof b.content === "string" ? b.content.length
  : Array.isArray(b.content) ? b.content.reduce((n, x) => n + ((x && x.text) || "").length, 0) : 0;

function load() {
  const root = path.join(os.homedir(), ".claude", "projects");
  const cutoff = Date.now() - MAX_DAYS * 864e5;
  const sessions = new Map();
  for (const file of walk(root)) {
    let raw; try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (!e.timestamp) continue;
      e._t = Date.parse(e.timestamp);
      if (!(e._t >= cutoff)) continue;
      const sid = e.sessionId || file;
      if (!sessions.has(sid)) sessions.set(sid, []);
      sessions.get(sid).push(e);
    }
  }
  return sessions;
}

function buildTurns(sessions) {
  const turns = [], clears = {};
  for (const [sid, events] of sessions) {
    events.sort((a, b) => a._t - b._t);
    const toolNames = {}; let cur = null; clears[sid] = 0;
    for (const e of events) {
      const p = realPrompt(e);
      if (p !== null) {
        if (p.includes("<command-name>/clear")) { clears[sid]++; cur = null; continue; }
        if (p.startsWith("<command-name>")) continue;
        cur = { sid, ts: e._t, prompt: p, msgs: new Map(), tools: [], filesRead: [], edited: new Set(), bash: [], big: [] };
        turns.push(cur); continue;
      }
      if (!cur) continue;
      const msg = e.message || {};
      if (e.type === "assistant" && msg.usage) {
        const id = msg.id || e.uuid;
        const r = cur.msgs.get(id) || { model: msg.model, in: 0, out: 0, cw: 0, cr: 0 };
        const u = msg.usage;
        r.in = Math.max(r.in, u.input_tokens || 0); r.out = Math.max(r.out, u.output_tokens || 0);
        r.cw = Math.max(r.cw, u.cache_creation_input_tokens || 0); r.cr = Math.max(r.cr, u.cache_read_input_tokens || 0);
        cur.msgs.set(id, r);
        for (const b of msg.content || []) {
          if (b && b.type === "tool_use" && !(b.id in toolNames)) {
            toolNames[b.id] = b.name; const inp = b.input || {};
            cur.tools.push(b.name);
            if (b.name === "Read" && inp.file_path) cur.filesRead.push(inp.file_path);
            if (EDIT.has(b.name)) cur.edited.add(inp.file_path || inp.notebook_path || "?");
            if (b.name === "Bash") cur.bash.push((inp.command || "").trim());
          }
        }
      } else if (e.type === "user" && Array.isArray(msg.content)) {
        for (const b of msg.content)
          if (b && b.type === "tool_result" && resultSize(b) >= BIG) cur.big.push(toolNames[b.tool_use_id] || "?");
      }
    }
  }
  const out = [];
  for (const t of turns) {
    const agg = { in: 0, out: 0, cw: 0, cr: 0 }; let total = 0, peak = 0, ex100 = 0, ex150 = 0; const fams = {};
    for (const m of t.msgs.values()) {
      const f = family(m.model); if (!f) continue;
      const c = cost(f, m); total += c; fams[f] = (fams[f] || 0) + c;
      for (const k of Object.keys(agg)) agg[k] += m[k];
      const ctx = m.in + m.cw + m.cr; peak = Math.max(peak, ctx);
      const unit = PRICES[f][0] * CR / 1e6;   // l'excès est supposé relu depuis le cache
      ex100 += Math.max(0, ctx - 100000) * unit; ex150 += Math.max(0, ctx - 150000) * unit;
    }
    const main = Object.keys(fams).sort((a, b) => fams[b] - fams[a])[0];
    if (!main) continue;
    Object.assign(t, { usage: agg, cost: total, peak, main, fams, ex100, ex150 });
    out.push(t);
  }
  return { turns: out, clears };
}

function classify(t) {
  const nt = t.tools.length, ed = t.edited.size, o = t.usage.out, tools = new Set(t.tools);
  if (COMPLEX.test(t.prompt) || ed >= 5 || tools.has("Task") || o > 8000) return "complexe";
  if (nt === 0 && o < 1500) return "question courte";
  if (ed === 0 && [...tools].every((x) => READ.has(x)) && nt <= 10) return "exploration";
  if (GIT.test(t.prompt) && ed === 0) return "git/commande";
  if (ed <= 2 && o < 3000 && nt <= 8) return "petite correction";
  return "moyenne";
}

function analyse(turns, clears) {
  const total = turns.reduce((s, t) => s + t.cost, 0) || 1e-9;
  const byModel = {}; turns.forEach((t) => { for (const f in t.fams) byModel[f] = (byModel[f] || 0) + t.fams[f]; });
  const fit = {}, examples = []; let save = 0;
  for (const t of turns) {
    t.kind = classify(t); const tgt = TARGET[t.kind];
    if (tgt && RANK[t.main] > RANK[tgt]) {
      const s = t.cost - cost(t.main, t.usage, tgt); save += s;
      const k = `${t.kind}|${t.main}|${tgt}`; fit[k] = fit[k] || { n: 0, save: 0, kind: t.kind, from: t.main, to: tgt };
      fit[k].n++; fit[k].save += s; examples.push({ s, t });
    }
  }
  let afterLo = 0, afterHi = 0, exSum = 0;
  for (const t of turns) {
    const tgt = TARGET[t.kind];
    const ratio = tgt && RANK[t.main] > RANK[tgt] && t.cost > 0 ? cost(t.main, t.usage, tgt) / t.cost : 1;
    afterLo += Math.max(0, t.cost - t.ex150) * ratio;   // prudent : conversation plafonnée à 150k
    afterHi += Math.max(0, t.cost - t.ex100) * ratio;   // standard : plafonnée à 100k
    exSum += t.ex100;
  }
  const proj = { lo: 1 - afterLo / total, hi: 1 - afterHi / total, ctx: exSum / total };
  const longTurns = turns.filter((t) => t.peak >= CTX_WARN);
  const ctxCost = longTurns.reduce((s, t) => s + t.cost, 0);
  const crShare = turns.reduce((s, t) => s + t.usage.cr * PRICES[t.main][0] * CR / 1e6, 0) / total;
  const bySess = {}; turns.forEach((t) => (bySess[t.sid] = bySess[t.sid] || []).push(t));
  const marathons = Object.entries(bySess).filter(([sid, ts]) => ts.length >= 25 && !clears[sid] && Math.max(...ts.map((x) => x.peak)) >= CTX_HIGH);
  const reread = [], repeat = [], big = {};
  for (const ts of Object.values(bySess)) {
    const rc = {}; ts.forEach((t) => t.filesRead.forEach((f) => (rc[f] = (rc[f] || 0) + 1)));
    for (const [f, n] of Object.entries(rc)) if (n >= 3) reread.push([f, n]);
    const cc = {}; ts.forEach((t) => t.bash.forEach((c) => { if (c.length > 8) cc[c] = (cc[c] || 0) + 1; }));
    for (const [c, n] of Object.entries(cc)) if (n >= 3) repeat.push([c, n]);
    ts.forEach((t) => t.big.forEach((n) => (big[n] = (big[n] || 0) + 1)));
  }
  examples.sort((a, b) => b.s - a.s);
  return { proj, total, byModel, fit: Object.values(fit).sort((a, b) => b.save - a.save), save, examples: examples.slice(0, 5),
    longTurns: longTurns.length, ctxPct: ctxCost / total, crShare, marathons, reread: reread.sort((a, b) => b[1] - a[1]).slice(0, 5),
    repeat: repeat.sort((a, b) => b[1] - a[1]).slice(0, 5), big };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (x) => Math.round(x * 100);

function view(a, n, days) {
  const savePct = pct(a.save / a.total);
  const models = Object.entries(a.byModel).sort((x, y) => y[1] - x[1])
    .map(([f, c]) => `<div class="bar"><span>${f}</span><i style="width:${Math.max(2, pct(c / a.total))}%"></i><b>${pct(c / a.total)} %</b></div>`).join("");
  const fitRows = a.fit.filter((f) => f.save / a.total >= 0.01).map((f) => `<li><b>${f.n}</b> ${f.n > 1 ? LABEL[f.kind] : LABEL[f.kind].replace(/s$/, "").replace("questions courtes", "question courte")} ${f.n > 1 ? "faites" : "faite"} avec <b>${f.from}</b> : <b>${f.to}</b> aurait probablement suffi <em>(−${pct(f.save / a.total)} %)</em></li>`).join("");
  const ex = a.examples.map((x) => `<li>« ${esc(x.t.prompt.slice(0, 90).replace(/\n/g, " "))} » <em>${x.t.main} → ${x.t.target || TARGET[x.t.kind]}</em></li>`).join("");
  const ctxItems = [];
  if (a.longTurns) ctxItems.push(`<li><b>${a.longTurns}</b> demandes lancées avec une conversation très longue = <b>${pct(a.ctxPct)} %</b> de ta consommation</li>`);
  ctxItems.push(`<li>Claude relit tout l'historique à chaque message : <b>${pct(a.crShare)} %</b> de la consommation</li>`);
  a.marathons.slice(0, 3).forEach(([sid, ts]) => ctxItems.push(`<li>Une conversation de <b>${ts.length}</b> demandes sans jamais repartir de zéro</li>`));
  const waste = [];
  a.reread.forEach(([f, k]) => waste.push(`<li>Même fichier relu <b>${k}</b> fois : <code>${esc(path.basename(f))}</code></li>`));
  a.repeat.forEach(([c, k]) => waste.push(`<li>Même commande lancée <b>${k}</b> fois : <code>${esc(c.slice(0, 60))}</code></li>`));
  Object.entries(a.big).forEach(([nm, k]) => waste.push(`<li><b>${k}</b> résultats « ${esc(nm)} » énormes : Claude a ingéré beaucoup de texte d'un coup</li>`));
  const det = (label, inner) => `<details><summary>${label}</summary>${inner}</details>`;
  const card = (title, big, bigLabel, body, tip) => `<section><h2>${title}</h2><div class="big">${big}<small>${bigLabel}</small></div>${body}${tip ? `<p class="tip">${tip}</p>` : ""}</section>`;
  const rng = (lo, hi, f) => f(lo) === f(hi) ? f(lo) : `${f(lo)} à ${f(hi)}`;
  const mult = (x) => (1 / Math.max(0.05, 1 - x)).toFixed(1).replace(".", ",");
  const projCard = a.proj.hi >= 0.05
    ? card("Si tu avais suivi ces conseils", (pct(a.proj.lo) === pct(a.proj.hi) ? `−${pct(a.proj.lo)} %` : `−${pct(a.proj.lo)} à −${pct(a.proj.hi)} %`), "de consommation",
        `<p>Soit environ <b>×${rng(a.proj.lo, a.proj.hi, mult)}</b> de travail avant d'atteindre ta limite.</p>
<details><summary>Comment on l'estime</summary><ul><li>Le bon modèle pour les tâches simples : environ <b>−${pct(a.save / a.total)} %</b></li>
<li>Repartir de zéro avant que la conversation gonfle : environ <b>−${pct(a.proj.ctx)} %</b></li></ul>
<p><em>Les deux effets se recoupent, ils ne s'additionnent pas. C'est une estimation : Haiku peut faire un peu moins bien qu'Opus, repartir de zéro oblige à réexpliquer, et le lien avec ta limite d'abonnement reste approximatif.</em></p></details>`, "")
    : card("Si tu avais suivi ces conseils", "≈ 0 %", "d'écart", "<p class='ok'>Tu utilises déjà bien ton forfait : il n'y a presque rien à gagner.</p>", "");
  return `<div class="view" data-days="${days}"><p class="sub">${n} demandes analysées sur ${days > 1 ? `les ${days} derniers jours` : "le dernier jour"}. Tout est resté sur ton ordinateur.</p>
<section><h2>Où part ta consommation</h2>${models}<details><summary>Vérifier ces chiffres dans Claude Code</summary><p>Tape <code>/usage</code> (tokens par modèle) et <code>/context</code> (ce qui remplit ta conversation).</p></details></section>
${card("Le bon modèle pour la bonne tâche", a.fit.length ? `${savePct} %` : "✓", a.fit.length ? "de ta consommation aurait pu être évitée" : "rien à signaler",
  a.fit.length ? det("Voir le détail", `<ul>${fitRows}</ul><p><em>Exemples :</em></p><ul>${ex}</ul>`) : "<p class='ok'>Tes tâches simples ne tournent pas sur un modèle trop gros.</p>",
  a.fit.length ? "Un gros modèle pour une petite tâche, c'est un camion pour livrer une lettre. Choisis le modèle au début d'une session, ou juste après <code>/clear</code> (commande <code>/model</code>). Changer en pleine conversation oblige Claude à tout relire sans économie : un message cher, qui ne se rentabilise que si la conversation continue longtemps." : "")}
${card("Conversation trop longue", `${pct(a.crShare)} %`, "de la consommation vient de la relecture de l'historique", det("Voir le détail", `<ul>${ctxItems.join("")}</ul><p><b>Ce qui dure</b> (comment lancer le projet, les conventions, ce qu'il ne faut pas toucher) va dans <code>CLAUDE.md</code>. <b>L'état d'une tâche en cours</b> se range plutôt dans un petit fichier de notes à part : <code>CLAUDE.md</code> est relu à chaque message, donc chaque ligne qu'on y met coûte à chaque fois.</p>`),
  "Quand tu changes de sujet, tape <code>/clear</code> : Claude oublie la conversation (il faudra tout réexpliquer) mais ne la relit plus à chaque message. Pour continuer la même tâche, <code>/compact</code> la résume : on perd du détail, alors fais-le entre deux étapes plutôt qu'en plein milieu. Avant de nettoyer, demande à Claude : « note en dix lignes maximum ce qu'il faut retenir de ce projet dans CLAUDE.md ».")}
${card("Actions inutiles", String(waste.length || "0"), "signaux repérés", waste.length ? det("Voir le détail", `<ul>${waste.join("")}</ul>`) : "<p class='ok'>Rien de flagrant.</p>",
  waste.length ? "Demande à Claude de chercher dans un fichier précis plutôt que de tout relire." : "")}
${projCard}
</div>`;
}

const CSS = `
:root{color-scheme:dark;--marine:#0B2E4A;--deep:#082238;--sable:#FFE3A6;--ciel:#5E9BA6;--rouge:#E0262B;--muted:#A9C1D1;
--sans:"Space Grotesk",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:"Space Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace}
body{margin:0;background:var(--marine);color:#fff;font:16px/1.55 var(--sans)}
main{max-width:760px;margin:0 auto;padding:36px 20px 72px}
.logo{font:700 30px var(--sans);letter-spacing:-.5px;margin:0 0 6px}.pill{display:inline-block;margin-left:4px;padding:0 12px;background:var(--rouge);border-radius:999px}
.sub{color:var(--muted);margin:0 0 28px}
section{background:var(--deep);border:2px solid var(--deep);border-radius:12px;padding:22px 24px;margin:22px 0;box-shadow:8px 8px 0 var(--ciel)}
h2{margin:0 0 10px;font:700 12px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--sable)}
.big{font-size:52px;font-weight:700;line-height:1.1;color:var(--sable)}.big small{display:block;font-size:16px;font-weight:400;color:var(--muted);margin-top:4px}
ul{padding-left:20px}li{margin:7px 0}em{color:var(--muted);font-style:normal}
code{font-family:var(--mono);font-size:.9em;background:var(--marine);padding:1px 6px;border-radius:4px}
.tip{background:var(--ciel);color:#fff;border-radius:8px;padding:12px 14px;margin:14px 0 0}.tip code{background:var(--marine)}
.bar{display:flex;align-items:center;gap:10px;margin:8px 0}.bar span{width:70px;font-family:var(--mono);font-size:14px}
.bar i{display:block;height:12px;background:var(--sable);border-radius:6px}.bar b{font-weight:700;white-space:nowrap;min-width:52px;text-align:right}
.ok{color:var(--sable)}
details{margin:14px 0 0}summary{cursor:pointer;color:var(--ciel);font:700 13px var(--mono);letter-spacing:.04em}summary::marker{color:var(--ciel)}details[open] summary{margin-bottom:6px}footer{color:var(--muted);font-size:13px;margin-top:34px}
[hidden]{display:none!important}
.tabs{display:flex;gap:8px;margin:14px 0 6px}
.tabs button{font:700 13px var(--mono);letter-spacing:.04em;background:var(--deep);color:var(--muted);border:2px solid var(--ciel);border-radius:999px;padding:6px 16px;cursor:pointer}
.tabs button.on{background:var(--sable);color:var(--marine);border-color:var(--sable)}
`;
const TABS_JS = `document.querySelectorAll(".tabs button").forEach(function(b){b.onclick=function(){document.querySelectorAll(".tabs button").forEach(function(x){x.classList.toggle("on",x===b)});document.querySelectorAll(".view").forEach(function(v){v.hidden=v.dataset.days!==b.dataset.d})}})`;

function page(views) {
  const tabs = views.length > 1
    ? `<div class="tabs">${views.map((v, i) => `<button type="button" data-d="${v.days}"${i === 0 ? ' class="on"' : ""}>${v.days} jours</button>`).join("")}</div>` : "";
  const body = views.map((v, i) => view(v.a, v.n, v.days).replace('class="view"', i === 0 ? 'class="view"' : 'class="view" hidden')).join("\n");
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>diag run</title><style>${CSS}</style>
<main><h1 class="logo">diag<span class="pill">run</span></h1>${tabs}
${body}
<footer>diag run v${VERSION} · Les montants sont des estimations basées sur les tarifs publics (modifiables dans cli.js). L'analyse de la tâche est approximative : c'est une indication, pas un verdict.</footer></main>${views.length > 1 ? `<script>${TABS_JS}</script>` : ""}</html>`;
}

function openBrowser(file) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [file]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch {}
}

const { turns, clears } = buildTurns(load());
if (!turns.length) {
  console.log(`Aucune session Claude Code trouvée dans ${path.join(os.homedir(), ".claude", "projects")} sur les ${MAX_DAYS} derniers jours.`);
  process.exit(0);
}
const periods = DAYS_ARG ? [MAX_DAYS] : [7, 30];
const now = Date.now();
let views = periods.map((d) => {
  const sub = turns.filter((t) => t.ts >= now - d * 864e5);
  return sub.length ? { days: d, n: sub.length, a: analyse(sub, clears) } : null;
}).filter(Boolean);
views = views.filter((v, i) => i === 0 || v.n !== views[i - 1].n);   // pas d'onglet en double
const out = arg("--out", path.join(process.env.DIAGRUN_HOME || path.join(os.homedir(), ".diagrun"), "rapport.html"));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page(views));
console.log(`Diagnostic prêt (diag run v${VERSION}) : ${out}`);
if (!process.argv.includes("--no-open")) openBrowser(out);
