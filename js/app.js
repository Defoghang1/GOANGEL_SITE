import { Auth } from "./auth.js";

const start = async () => {
  const isAuth = await Auth.require();
  if (!isAuth) return;

  document.body.hidden = false;

  const $ = id => document.getElementById(id);
  const user = Auth.current();

  $("nav-brand").textContent = CONFIG.brand;
  $("footer-brand").textContent = CONFIG.brand;
  $("year").textContent = new Date().getFullYear();
  $("nav-cta").href = CONFIG.telegram;
  $("user-name").textContent = user.displayName || (user.email || "").split("@")[0];
  $("logout").onclick = () => Auth.logout();

  const idTokenResult = await user.getIdTokenResult();
  if (idTokenResult.claims.admin === true) {
    const adminLink = document.createElement("a");
    adminLink.href = "admin.html";
    adminLink.textContent = "Admin";
    adminLink.className = "btn small";
    adminLink.style.marginLeft = "1rem";
    document.querySelector(".user").prepend(adminLink);
  }

  const setMeta = (sel, attr, val) => { const el = document.querySelector(sel); if (el) el.setAttribute(attr, val); };
  setMeta('link[rel="canonical"]', "href", CONFIG.siteUrl);
  setMeta('meta[property="og:url"]', "content", CONFIG.siteUrl);

  const D = SITE_DATA;
  const pages = {
    home: () => `
      <section class="hero">
        <div class="monogram" aria-hidden="true">GA</div>
        <h1>${D.hero.title}</h1>
        <p>${D.hero.subtitle}</p>
        <div class="actions">
          <a href="${CONFIG.telegram}" target="_blank" rel="noopener" class="btn">${D.hero.cta}</a>
          <a href="#simulator" class="btn ghost">${D.hero.cta2}</a>
        </div>
        <dl class="stats">${D.stats.map(s => `<div><dt>${s.v}</dt><dd>${s.l}</dd></div>`).join("")}</dl>
      </section>
      <section class="block"><h2>Comment ça marche</h2>
        <ol class="steps">${D.steps.map(s => `<li><strong>${s.t}</strong><span>${s.d}</span></li>`).join("")}</ol>
      </section>`,
    simulator: () => `<section class="block"><h2>Simulateur GOANGEL</h2><div id="sim"></div></section>`,
    features: () => `<section class="block"><h2>Pourquoi GOANGEL</h2>
      <div class="grid">${D.features.map(f => `<article class="card"><div class="ico">${f.icon}</div><h3>${f.title}</h3><p>${f.desc}</p></article>`).join("")}</div></section>`,
    pricing: () => `<section class="block"><h2>Choisissez votre pack</h2>
      <div class="grid">${D.packs.map(p => `
        <article class="card price ${p.featured ? "featured" : ""}">
          ${p.featured ? '<span class="badge">Recommandé</span>' : ""}
          <h3>${p.name}</h3>
          <div class="amount">${p.price} <small>${CONFIG.currency}</small></div>
          <ul>${p.features.map(f => `<li>${f}</li>`).join("")}</ul>
          <a class="btn" target="_blank" rel="noopener" href="${CONFIG.telegram}?start=${p.name.toLowerCase()}">Acheter via Telegram</a>
        </article>`).join("")}</div></section>`,
    faq: () => `<section class="block narrow"><h2>Questions fréquentes</h2>
      ${D.faq.map(i => `<details><summary>${i.q}</summary><p>${i.a}</p></details>`).join("")}</section>`,
    legal: () => `<section class="block narrow"><h2>Avertissements</h2>
      ${D.legal.map(t => `<p class="legal">${t}</p>`).join("")}</section>`
  };
  const titles = { home: "Accueil", features: "Technologie", pricing: "Tarifs", faq: "FAQ", simulator: "Simulateur", legal: "Avertissements" };

  const router = () => {
    const key = location.hash.slice(1);
    const page = pages[key] ? key : "home";
    $("app").innerHTML = pages[page]();
    document.title = `${titles[page]} | ${CONFIG.brand}`;
    document.querySelectorAll("[data-nav]").forEach(a => a.setAttribute("aria-current", a.dataset.nav === page ? "page" : "false"));
    $("menu").classList.remove("open");
    $("burger").setAttribute("aria-expanded", "false");
    Simulator.destroy();
    if (page === "simulator") Simulator.mount($("sim"));
    window.scrollTo(0, 0);
  };

  $("burger").onclick = () => {
    const open = $("menu").classList.toggle("open");
    $("burger").setAttribute("aria-expanded", open);
  };

  addEventListener("hashchange", router);
  router();
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
