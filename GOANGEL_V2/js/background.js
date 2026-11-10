// 🌌 Arrière-plan animé : ballon-réseau de neurones, chandeliers, flux de données
(() => {
  const c = document.getElementById("bg"); if (!c) return;
  const x = c.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W, H, D, t = 0, mx = 0, my = 0, off = 0;

  // Nœuds répartis sur une sphère (spirale de Fibonacci) + liaisons proches
  const N = 110, P = [], E = [];
  for (let i = 0; i < N; i++) { const y = 1 - 2 * (i + .5) / N, r = Math.sqrt(1 - y * y), a = i * 2.399963; P.push([Math.cos(a) * r, y, Math.sin(a) * r]); }
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const d = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1], P[i][2] - P[j][2]); if (d < .55) E.push([i, j]);
  }
  const pulses = Array.from({ length: 16 }, () => ({ e: Math.random() * E.length | 0, p: Math.random(), s: .006 + Math.random() * .01 }));

  // Chandeliers
  const K = 70, CW = 22, candles = []; let last = 100;
  const nextCandle = () => { const o = last, cl = o + (Math.random() - .46) * 7, h = Math.max(o, cl) + Math.random() * 4, l = Math.min(o, cl) - Math.random() * 4; last = cl; if (last > 160 || last < 40) last = 100; return { o, h, l, c: cl }; };
  for (let i = 0; i < K; i++) candles.push(nextCandle());

  // Flux de données
  const S = Array.from({ length: 46 }, () => ({ x: Math.random(), y: Math.random(), v: .0008 + Math.random() * .002, l: 30 + Math.random() * 80, k: Math.random() < .5 }));

  function resize() {
    D = Math.min(devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight;
    c.width = W * D; c.height = H * D; c.style.width = W + "px"; c.style.height = H + "px"; x.setTransform(D, 0, 0, D, 0, 0);
  }

  function frame() {
    t++;
    // fond
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#04060b"); g.addColorStop(.6, "#070d1c"); g.addColorStop(1, "#050810");
    x.fillStyle = g; x.fillRect(0, 0, W, H);

    // chandeliers (défilement continu)
    off += reduce ? 0 : .35; if (off >= CW) { off -= CW; candles.shift(); candles.push(nextCandle()); }
    const top = H * .52, hh = H * .42, sc = hh / 110;
    x.lineWidth = 1.5;
    candles.forEach((k, i) => {
      const px = i * CW - off, up = k.c >= k.o, col = up ? "16,185,129" : "70,120,170", Y = v => top + hh - (v - 30) * sc;
      x.strokeStyle = `rgba(${col},.22)`; x.fillStyle = `rgba(${col},.14)`;
      x.beginPath(); x.moveTo(px + 8, Y(k.h)); x.lineTo(px + 8, Y(k.l)); x.stroke();
      x.fillRect(px + 3, Math.min(Y(k.o), Y(k.c)), 10, Math.max(2, Math.abs(Y(k.o) - Y(k.c))));
    });
    x.strokeStyle = "rgba(212,175,55,.2)"; x.beginPath();
    candles.forEach((k, i) => { const px = i * CW - off + 8, y = top + hh - (k.c - 30) * sc; i ? x.lineTo(px, y) : x.moveTo(px, y); }); x.stroke();

    // flux
    S.forEach(s => {
      s.y += s.v * (reduce ? 0 : 1); if (s.y > 1.2) { s.y = -.1; s.x = Math.random(); }
      const px = s.x * W, py = s.y * H, gr = x.createLinearGradient(px, py - s.l, px, py);
      const col = s.k ? "16,185,129" : "34,211,238"; gr.addColorStop(0, `rgba(${col},0)`); gr.addColorStop(1, `rgba(${col},.4)`);
      x.strokeStyle = gr; x.beginPath(); x.moveTo(px, py - s.l); x.lineTo(px, py); x.stroke();
    });

    // ballon
    const cx = W * .5 + mx * 14, cy = H * .45 + my * 10, R = Math.min(W, H) * .32;
    const halo = x.createRadialGradient(cx, cy, R * .2, cx, cy, R * 1.6); halo.addColorStop(0, "rgba(34,211,238,.13)"); halo.addColorStop(.5, "rgba(20,60,140,.08)"); halo.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = halo; x.fillRect(0, 0, W, H);
    const ay = (reduce ? 1 : t * .004) + mx * .3, ax = .4 + my * .2, ca = Math.cos(ay), sa = Math.sin(ay), cb = Math.cos(ax), sb = Math.sin(ax);
    const Q = P.map(([a, b, d]) => { const X = a * ca + d * sa, Z0 = -a * sa + d * ca, Y = b * cb - Z0 * sb, Z = b * sb + Z0 * cb, s = 1 + Z * .14; return [cx + X * R * s, cy + Y * R * s, Z]; });
    x.lineWidth = 1;
    E.forEach(([i, j]) => { const a = Q[i], b = Q[j], al = .04 + .3 * ((a[2] + b[2]) / 2 + 1) / 2; x.strokeStyle = `rgba(80,200,230,${al})`; x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.stroke(); });
    Q.forEach((q, i) => { const al = .25 + .75 * (q[2] + 1) / 2, gold = i % 11 === 0; x.fillStyle = gold ? `rgba(240,200,80,${al})` : `rgba(120,230,255,${al})`; x.beginPath(); x.arc(q[0], q[1], gold ? 3.2 : 2, 0, 6.3); x.fill(); });
    pulses.forEach(p => { p.p += reduce ? 0 : p.s; if (p.p > 1) { p.p = 0; p.e = Math.random() * E.length | 0; }
      const [i, j] = E[p.e], px = Q[i][0] + (Q[j][0] - Q[i][0]) * p.p, py = Q[i][1] + (Q[j][1] - Q[i][1]) * p.p;
      x.fillStyle = "rgba(16,255,170,.95)"; x.shadowColor = "#10ffaa"; x.shadowBlur = 10; x.beginPath(); x.arc(px, py, 2.6, 0, 6.3); x.fill(); x.shadowBlur = 0; });

    // vignette
    const v = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .4, W / 2, H / 2, Math.max(W, H) * .8); v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.65)");
    x.fillStyle = v; x.fillRect(0, 0, W, H);
    if (!reduce) requestAnimationFrame(frame);
  }
  addEventListener("resize", () => { resize(); if (reduce) frame(); });
  addEventListener("pointermove", e => { mx = e.clientX / innerWidth - .5; my = e.clientY / innerHeight - .5; });
  resize(); frame();
})();
