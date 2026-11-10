// 🎮 Simulateur de paris GOANGEL — DÉMONSTRATION avec des matchs et des résultats fictifs
const Simulator = (() => {
  let timer = null, st = null, root = null;
  const $ = s => root.querySelector(s);
  const teams = ["Atlas FC", "Nordia United", "Real Solaris", "Olympia 04", "Vento Calcio", "Port Azur", "Dynamo Keld", "Sporting Aurea", "Lumen City", "Borea SC", "Tiber AC", "Kasai Stars"];
  const markets = ["Victoire domicile", "Victoire extérieur", "Plus de 2,5 buts", "Les deux marquent", "Nul ou domicile"];
  const fmt = n => Math.round(n).toLocaleString("fr-FR") + " " + CONFIG.currency;
  const pick = a => a[Math.random() * a.length | 0];

  function tween(el, from, to, f = fmt) {
    const t0 = performance.now();
    (function s(t) { const k = Math.min(1, (t - t0) / 600); el.textContent = f(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(s); })(t0);
  }

  function chart() {
    const cv = $("#sim-chart"), D = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * D; cv.height = h * D; const x = cv.getContext("2d"); x.setTransform(D, 0, 0, D, 0, 0); x.clearRect(0, 0, w, h);
    const d = st.hist.slice(-60), min = Math.min(...d, st.start) * .98, max = Math.max(...d, st.start) * 1.02;
    const X = i => 10 + i * (w - 20) / Math.max(1, d.length - 1), Y = v => h - 12 - (v - min) / (max - min) * (h - 24);
    x.setLineDash([4, 4]); x.strokeStyle = "rgba(255,255,255,.2)"; x.beginPath(); x.moveTo(0, Y(st.start)); x.lineTo(w, Y(st.start)); x.stroke(); x.setLineDash([]);
    const up = d[d.length - 1] >= st.start, col = up ? "16,185,129" : "248,113,113";
    const gr = x.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, `rgba(${col},.35)`); gr.addColorStop(1, `rgba(${col},0)`);
    x.beginPath(); d.forEach((v, i) => i ? x.lineTo(X(i), Y(v)) : x.moveTo(X(i), Y(v))); x.strokeStyle = `rgb(${col})`; x.lineWidth = 2.5; x.stroke();
    x.lineTo(X(d.length - 1), h); x.lineTo(X(0), h); x.fillStyle = gr; x.fill();
    x.fillStyle = `rgb(${col})`; x.shadowColor = `rgb(${col})`; x.shadowBlur = 12; x.beginPath(); x.arc(X(d.length - 1), Y(d[d.length - 1]), 4, 0, 6.3); x.fill(); x.shadowBlur = 0;
  }

  function step() {
    const home = pick(teams); let away = pick(teams); while (away === home) away = pick(teams);
    const odds = +(1.5 + Math.random() * 1.9).toFixed(2), q = 1 / odds;
    const p = Math.min(.9, q + .03 + Math.random() * .09);                 // probabilité estimée par le modèle (avantage simulé)
    const kelly = (p * odds - 1) / (odds - 1), stake = Math.max(5, Math.round(Math.min(.05, kelly * .25) * st.bank / 10) * 10);
    const win = Math.random() < p, gain = win ? Math.round(stake * (odds - 1)) : -stake;
    const before = st.bank; st.bank += gain; st.bets++; if (win) st.wins++; st.hist.push(st.bank);
    tween($("#s-bank"), before, st.bank); tween($("#s-pl"), st.last, st.bank - st.start, v => (v >= 0 ? "+" : "") + fmt(v)); st.last = st.bank - st.start;
    $("#s-pl").className = st.last >= 0 ? "pos" : "neg";
    $("#s-rate").textContent = Math.round(st.wins / st.bets * 100) + " %"; $("#s-n").textContent = st.bets;
    const li = document.createElement("li"); li.className = win ? "win" : "loss";
    li.innerHTML = `<div><strong>${home} – ${away}</strong><span>${pick(markets)} · cote ${odds} · confiance ${Math.round(p * 100)} % · mise ${fmt(stake)}</span></div><b>${win ? "+" : "−"}${fmt(Math.abs(gain))}</b>`;
    const ul = $("#s-log"); ul.prepend(li); while (ul.children.length > 7) ul.lastChild.remove();
    if (st.bank < 30) reset(); chart();
  }

  function schedule() { clearInterval(timer); if (st.run) timer = setInterval(step, 2600 / st.speed); }
  function reset() { st.bank = st.start; st.hist = [st.start]; st.bets = 0; st.wins = 0; st.last = 0; $("#s-log").innerHTML = ""; $("#s-bank").textContent = fmt(st.bank); $("#s-pl").textContent = "+" + fmt(0); $("#s-rate").textContent = "–"; $("#s-n").textContent = 0; chart(); }

  function mount(el) {
    if (!el) return; root = el; st = { start: 1000, bank: 1000, hist: [1000], bets: 0, wins: 0, last: 0, run: true, speed: 1 };
    root.innerHTML = `
      <p class="sim-note">Démonstration : matchs et résultats fictifs. Elle illustre le fonctionnement d'une mise calibrée, pas des gains réels ni garantis.</p>
      <div class="sim-kpis">
        <div><small>Capital simulé</small><b id="s-bank">${fmt(st.bank)}</b></div>
        <div><small>Gain / perte</small><b id="s-pl" class="pos">+${fmt(0)}</b></div>
        <div><small>Paris gagnés</small><b id="s-rate">–</b></div>
        <div><small>Paris joués</small><b id="s-n">0</b></div>
      </div>
      <div class="sim-grid">
        <div class="sim-panel"><canvas id="sim-chart" aria-label="Évolution du capital simulé"></canvas></div>
        <div class="sim-panel"><ul id="s-log" aria-live="polite"></ul></div>
      </div>
      <div class="sim-ctl">
        <button class="btn small" id="s-toggle">Pause</button>
        <button class="btn small ghost" id="s-speed">Vitesse ×1</button>
        <button class="btn small ghost" id="s-reset">Réinitialiser</button>
      </div>`;
    $("#s-toggle").onclick = e => { st.run = !st.run; e.target.textContent = st.run ? "Pause" : "Reprendre"; schedule(); };
    $("#s-speed").onclick = e => { st.speed = st.speed === 4 ? 1 : st.speed * 2; e.target.textContent = "Vitesse ×" + st.speed; schedule(); };
    $("#s-reset").onclick = reset;
    chart(); step(); schedule();
  }
  const destroy = () => { clearInterval(timer); timer = null; };
  addEventListener("resize", () => { if (st && root && root.isConnected) chart(); });
  return { mount, destroy };
})();
