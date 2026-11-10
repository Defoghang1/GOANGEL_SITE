// Application principale — chargé avec <script type="module">
import { Auth } from "./auth.js";
import { db } from "./firebase-config.js";
import { updateProfile } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const API = "https://api.goangel.dpdns.org";
const CLOUDINARY_URL = "https://api.cloudinary.com/v1_1/gkiui3xc/image/upload";
const CLOUDINARY_PRESET = "goangel_unsigned";

const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => /^https:\/\//i.test(u || "") ? u : "";
const fmtPrice = p => Number(p).toLocaleString("fr-FR");
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

let user = null;
let dynamicPacks = null;
let payTimer = null;

// ---------- API (avec jeton Firebase) ----------
async function api(path, opts = {}) {
  const token = await Auth.token();
  const res = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, ...(opts.headers || {}) }
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const d = data && data.detail;
    throw new Error(typeof d === "string" ? d : "Erreur serveur (" + res.status + ").");
  }
  return data;
}

// ---------- Packs ----------
async function loadPacks() {
  try {
    const snap = await getDocs(collection(db, "packs"));
    dynamicPacks = snap.empty ? null : snap.docs.map(d => d.data()).filter(p => p && p.name && Array.isArray(p.features) && Number(p.price) > 0);
  } catch (e) { dynamicPacks = null; }
}
function getPacks() {
  const packs = SITE_DATA.packs.map(p => ({ ...p }));
  (dynamicPacks || []).forEach(dp => {
    const i = packs.findIndex(p => p.name.toLowerCase() === String(dp.name).toLowerCase());
    if (i !== -1) packs[i] = dp; else packs.push(dp);
  });
  return packs;
}

// ---------- Panier (par utilisateur, localStorage) ----------
const cartKey = () => "goangel_cart_" + (user ? user.uid : "anon");
const getCart = () => { try { return JSON.parse(localStorage.getItem(cartKey())) || []; } catch (e) { return []; } };
const setCart = c => { try { localStorage.setItem(cartKey(), JSON.stringify(c)); } catch (e) {} renderCart(); };
function addToCart(name) { const c = getCart(); if (!c.includes(name)) c.push(name); setCart(c); }
function renderCart() {
  const cart = getCart(), packs = getPacks();
  $("cart-count").textContent = cart.length;
  $("cart-count").style.display = cart.length ? "inline-block" : "none";
  let total = 0;
  $("cart-items").innerHTML = cart.length ? cart.map((n, i) => {
    const p = packs.find(x => x.name === n); const price = p ? Number(p.price) : 0; total += price;
    return `<div class="cart-item"><span>${esc(n)}</span><span>${fmtPrice(price)} USDT <button data-rm="${i}" aria-label="Retirer">✕</button></span></div>`;
  }).join("") : '<p class="muted">Votre panier est vide.</p>';
  $("cart-total").textContent = fmtPrice(total) + " USDT";
  $("cart-items").querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { const c = getCart(); c.splice(Number(b.dataset.rm), 1); setCart(c); });
}

// ---------- Paiement crypto ----------
function closePayModal(modal) { clearInterval(payTimer); payTimer = null; modal.remove(); }

function showPayModal(order) {
  clearInterval(payTimer);
  document.querySelectorAll(".pay-modal").forEach(m => m.remove());
  const modal = document.createElement("div");
  modal.className = "modal pay-modal";
  modal.innerHTML = `
    <div class="modal-content">
      <button class="modal-close" aria-label="Fermer">×</button>
      <h2 style="color:var(--gold)">Paiement Crypto</h2>
      <p style="margin:1rem 0 .5rem">Pack <b>${esc(order.pack_name)}</b> — envoyez exactement :</p>
      <div class="copy-row"><code id="pay-amount">${esc(order.amount)}</code><button class="btn small ghost" data-copy="pay-amount">Copier</button></div>
      <p style="margin-bottom:.5rem"><b>${esc(String(order.currency).toUpperCase())}</b> (réseau Tron TRC-20) à cette adresse :</p>
      <div class="copy-row"><code id="pay-addr">${esc(order.pay_address)}</code><button class="btn small ghost" data-copy="pay-addr">Copier</button></div>
      <p id="pay-status" style="color:var(--muted)">En attente du paiement sur la blockchain…</p>
      <div id="pay-actions" style="margin-top:1rem"></div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector(".modal-close").onclick = () => closePayModal(modal);
  modal.querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(modal.querySelector("#" + b.dataset.copy).textContent); b.textContent = "Copié ✓"; setTimeout(() => b.textContent = "Copier", 1500); } catch (e) {}
  });
  const status = modal.querySelector("#pay-status");
  let tries = 0;
  const poll = async () => {
    if (++tries > 360) { clearInterval(payTimer); status.textContent = "Délai dépassé. Retrouvez votre commande dans « Vos achats »."; return; }
    try {
      const r = await api("/api/check-payment/" + encodeURIComponent(order.payment_id));
      if (r.status === "paid") {
        clearInterval(payTimer);
        status.textContent = "✅ Paiement validé !"; status.style.color = "var(--pos)";
        const act = modal.querySelector("#pay-actions");
        act.innerHTML = '<button class="btn" style="width:100%">Télécharger le ZIP</button>';
        act.firstChild.onclick = () => downloadOrder(order.payment_id);
        refreshOrders();
      } else if (r.status === "failed" || r.status === "expired") {
        clearInterval(payTimer);
        status.textContent = "❌ Paiement " + (r.status === "expired" ? "expiré" : "échoué") + ". Relancez une commande."; status.style.color = "var(--err)";
        refreshOrders();
      } else if (r.status === "partial") {
        status.textContent = "⚠️ Montant partiel reçu : complétez le paiement ou contactez le support.";
      }
    } catch (e) { status.textContent = "Vérification impossible pour le moment, nouvelle tentative…"; }
  };
  payTimer = setInterval(poll, 10000);
  poll();
}

async function initiatePayment(packName, btn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = "Création…";
  try {
    const order = await api("/api/create-payment", { method: "POST", body: JSON.stringify({ pack_name: packName }) });
    showPayModal(order);
    refreshOrders();
  } catch (e) {
    alert("Erreur lors de la création du paiement : " + e.message);
  } finally { btn.disabled = false; btn.textContent = old; }
}

async function downloadOrder(paymentId) {
  try {
    const r = await api("/api/download/" + encodeURIComponent(paymentId));
    if (r.download_url) window.location.href = r.download_url; else throw new Error("Lien indisponible.");
  } catch (e) { alert("Téléchargement impossible : " + e.message); }
}


function confirmBox(title, html, okLabel) {
  return new Promise(resolve => {
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `<div class="modal-content confirm-box"><h2 style="color:var(--gold);margin-bottom:1rem">${esc(title)}</h2>${html}
      <div class="confirm-actions"><button class="btn ghost" data-r="0">Annuler</button><button class="btn btn-danger" data-r="1">${esc(okLabel)}</button></div></div>`;
    document.body.appendChild(m);
    m.querySelectorAll("[data-r]").forEach(b => b.onclick = () => { m.remove(); resolve(b.dataset.r === "1"); });
  });
}

function deleteMessage(o) {
  const id = `<p>ID de paiement : <code>${esc(o.payment_id)}</code></p>`;
  if (o.status === "paid") return ["Supprimer cet achat payé ?", `<p class="warn"><b>Attention :</b> vous perdrez le bouton de téléchargement de ce pack depuis votre compte. Téléchargez-le d'abord si ce n'est pas fait.</p>${id}<p>Gardez cet ID : le support Telegram pourra retrouver la commande.</p>`];
  if (o.status === "waiting") return ["Supprimer cette commande en attente ?", `<p>Si vous n'avez <b>envoyé aucun fonds</b>, vous ne perdez rien.</p><p class="warn"><b>Attention :</b> si vous avez déjà envoyé le paiement (même pas encore confirmé sur la blockchain), vous perdrez l'accès à ce pack depuis votre compte et le bouton de téléchargement ne reviendra pas. Le paiement n'est pas remboursé automatiquement.</p>${id}<p>Notez cet ID et contactez-nous sur Telegram pour retrouver la commande.</p>`];
  return ["Supprimer cette commande ?", `<p>Elle sera retirée de votre historique.</p>${id}`];
}

const ST_LABEL = { paid: "Payé", waiting: "En attente", failed: "Échoué", expired: "Expiré" };
async function refreshOrders() {
  const box = $("orders-list"); if (!box) return;
  try {
    const orders = (await api("/api/my-orders")).orders || [];
    box.innerHTML = orders.length ? orders.map(o => `
      <div class="order-item">
        <div><strong>${esc(o.pack_name)}</strong> <span class="st ${esc(o.status)}">${esc(ST_LABEL[o.status] || o.status)}</span>
        <small>${esc(o.created_at ? new Date(o.created_at).toLocaleString("fr-FR") : "")}</small></div>
        <div class="order-actions">${o.status === "paid" ? `<button class="btn small" data-dl="${esc(o.payment_id)}">Télécharger</button>`
          : o.status === "waiting" ? `<button class="btn small ghost" data-resume="${esc(o.payment_id)}">Reprendre</button>` : ""}
          <button class="btn small btn-danger" data-del="${esc(o.payment_id)}" aria-label="Supprimer">🗑 Supprimer</button></div>
      </div>`).join("") : '<p class="muted">Aucun achat pour le moment.</p>';
    box.querySelectorAll("[data-dl]").forEach(b => b.onclick = () => downloadOrder(b.dataset.dl));
    box.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
      const o = orders.find(x => x.payment_id === b.dataset.del); if (!o) return;
      const [title, html] = deleteMessage(o);
      if (!(await confirmBox(title, html, "Supprimer définitivement"))) return;
      try {
        await api("/api/delete-order/" + encodeURIComponent(o.payment_id), { method: "POST" });
        document.querySelectorAll(".pay-modal").forEach(m => closePayModal(m));
      } catch (e) { alert(e.message); }
      refreshOrders();
    });
    box.querySelectorAll("[data-resume]").forEach(b => b.onclick = () => {
      const o = orders.find(x => x.payment_id === b.dataset.resume);
      if (o) showPayModal({ payment_id: o.payment_id, pack_name: o.pack_name, amount: o.pay_amount, currency: o.pay_currency, pay_address: o.pay_address });
    });
  } catch (e) { box.innerHTML = '<p class="muted">Historique indisponible (serveur IA/paiement hors ligne).</p>'; }
}

// ---------- Média ----------
async function renderMedia() {
  const box = $("media-list"); if (!box) return;
  try {
    const snap = await getDocs(collection(db, "media"));
    const items = snap.docs.map(d => d.data()).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    if (!items.length) { box.innerHTML = '<p class="muted">Aucun contenu publié pour le moment.</p>'; return; }
    box.innerHTML = items.map(m => {
      const url = safeUrl(m.url), title = esc(m.description || ""), date = m.createdAt ? esc(new Date(m.createdAt).toLocaleDateString("fr-FR")) : "";
      let body = "";
      if (m.type === "image" && url) body = `<img src="${esc(url)}" alt="${title}" loading="lazy">`;
      else if (m.type === "video" && url) body = `<video src="${esc(url)}" controls preload="metadata"></video>`;
      else if (m.type === "audio" && url) body = `<audio src="${esc(url)}" controls preload="none"></audio>`;
      else if (m.type === "document" && url) body = `<a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">Ouvrir le document</a>`;
      else if (m.type === "text") body = `<p>${esc(m.text || "")}</p>`;
      else return "";
      return `<article class="card media-card">${body}${m.type !== "text" && title ? `<h3>${title}</h3>` : ""}${m.type === "text" && title ? `<h3>${title}</h3>` : ""}<small>${date}</small></article>`;
    }).join("");
  } catch (e) { box.innerHTML = '<p class="muted">Impossible de charger les contenus.</p>'; }
}

// ---------- Pages ----------
const pages = {
  home: () => `<section class="hero"><div class="monogram">GA</div><h1>${SITE_DATA.hero.title}</h1><p>${SITE_DATA.hero.subtitle}</p>
    <div class="actions"><a href="${esc(CONFIG.telegram)}" target="_blank" rel="noopener" class="btn">${SITE_DATA.hero.cta}</a><a href="#simulator" class="btn ghost">${SITE_DATA.hero.cta2}</a></div>
    <dl class="stats">${SITE_DATA.stats.map(s => `<div><dt>${s.v}</dt><dd>${s.l}</dd></div>`).join("")}</dl></section>`,
  features: () => `<section class="block"><h2>Technologie</h2><div class="grid">${SITE_DATA.features.map(f => `<article class="card"><div class="ico">${f.icon}</div><h3>${f.title}</h3><p>${f.desc}</p></article>`).join("")}</div></section>
    <section class="block narrow"><h2>Comment ça marche</h2><ol class="steps">${SITE_DATA.steps.map(s => `<li><div><strong>${s.t}</strong><br><span>${s.d}</span></div></li>`).join("")}</ol></section>`,
  simulator: () => `<section class="block"><h2>Simulateur</h2><div id="sim-root"></div></section>`,
  pricing: () => `<section class="block"><h2>Choisissez votre pack</h2>
    <div class="grid">${getPacks().map(p => `
      <article class="card price ${p.featured ? "featured" : ""}">
        ${p.featured ? '<span class="badge">Recommandé</span>' : ""}
        <h3>${esc(p.name)}</h3>
        <div class="amount">${fmtPrice(p.price)} <small>USDT (TRC-20)</small></div>
        <ul>${p.features.map(f => `<li>${esc(f)}</li>`).join("")}</ul>
        <div class="btn-row"><button class="btn buy-btn" data-name="${esc(p.name)}">Acheter</button><button class="btn ghost cart-add" data-name="${esc(p.name)}" aria-label="Ajouter au panier" title="Ajouter au panier">🛒</button></div>
      </article>`).join("")}</div>
    <div class="orders"><h3>Vos achats</h3><div id="orders-list"><p class="muted">Chargement…</p></div></div></section>`,
  faq: () => `<section class="block narrow"><h2>FAQ</h2>${SITE_DATA.faq.map(i => `<details><summary>${i.q}</summary><p>${i.a}</p></details>`).join("")}</section>`,
  legal: () => `<section class="block narrow"><h2>Nos Modèles</h2>${SITE_DATA.legal.map(t => `<p class="legal">${t}</p>`).join("")}</section>`,
  media: () => `<section class="block"><h2>Médias</h2><div id="media-list" class="media-grid"><p class="muted">Chargement…</p></div></section>`
};

let currentKey = null;
const router = () => {
  const key = pages[location.hash.slice(1)] ? location.hash.slice(1) : "home";
  if (currentKey === "simulator" && key !== "simulator") Simulator.destroy();
  currentKey = key;
  $("app").innerHTML = pages[key]();
  document.querySelectorAll("[data-nav]").forEach(a => a.removeAttribute("aria-current"));
  const act = document.querySelector(`[data-nav="${key}"]`); if (act) act.setAttribute("aria-current", "page");
  $("menu").classList.remove("open"); $("burger").setAttribute("aria-expanded", "false");
  window.scrollTo(0, 0);
  if (key === "simulator") Simulator.mount($("sim-root"));
  if (key === "media") renderMedia();
  if (key === "pricing") {
    document.querySelectorAll(".buy-btn").forEach(b => b.onclick = () => initiatePayment(b.dataset.name, b));
    document.querySelectorAll(".cart-add").forEach(b => b.onclick = () => { addToCart(b.dataset.name); b.textContent = "✓"; setTimeout(() => b.textContent = "🛒", 1000); });
    refreshOrders();
  }
};

// ---------- Profil (photo) ----------
function setAvatar() {
  const img = $("nav-avatar"), initial = esc((user.displayName || user.email || "?").charAt(0).toUpperCase());
  img.src = safeUrl(user.photoURL) || "data:image/svg+xml," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' fill='#0e131d'/><text x='20' y='27' font-size='20' text-anchor='middle' fill='#d4af37' font-family='Arial'>${initial}</text></svg>`);
  img.style.display = "block";
}
function initProfile() {
  setAvatar();
  $("nav-avatar").onclick = () => $("profile-modal").classList.remove("hidden");
  $("profile-input").onchange = async e => {
    const file = e.target.files[0], st = $("profile-status"); if (!file) return;
    if (!file.type.startsWith("image/")) { st.textContent = "Choisissez une image."; return; }
    if (file.size > 5 * 1024 * 1024) { st.textContent = "Image trop lourde (max 5 Mo)."; return; }
    st.textContent = "Envoi en cours…";
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("upload_preset", CLOUDINARY_PRESET);
      const r = await fetch(CLOUDINARY_URL, { method: "POST", body: fd });
      if (!r.ok) throw new Error("upload");
      const d = await r.json();
      await updateProfile(user, { photoURL: d.secure_url });
      setAvatar(); st.textContent = "✅ Photo mise à jour.";
    } catch (err) { st.textContent = "❌ Échec de l'envoi."; }
  };
}

// ---------- Démarrage ----------
const start = async () => {
  const isAuth = await Auth.require();
  if (!isAuth) return;
  user = Auth.current();
  await loadPacks();
  document.body.hidden = false;

  $("nav-brand").textContent = CONFIG.brand;
  $("footer-brand").textContent = CONFIG.brand;
  $("year").textContent = new Date().getFullYear();
  $("nav-cta").href = CONFIG.telegram;
  $("user-name").textContent = user.displayName || (user.email || "").split("@")[0];
  $("logout").onclick = () => Auth.logout();
  $("burger").onclick = () => { const o = $("menu").classList.toggle("open"); $("burger").setAttribute("aria-expanded", String(o)); };

  user.getIdTokenResult().then(r => {
    if (r.claims.admin === true) {
      const a = document.createElement("a");
      a.href = "admin.html"; a.textContent = "Admin"; a.className = "btn small"; a.style.marginLeft = "1rem";
      document.querySelector(".user").prepend(a);
    }
  }).catch(() => {});

  initProfile();
  $("cart-btn").onclick = () => { renderCart(); $("cart-modal").classList.remove("hidden"); };
  $("checkout-btn").onclick = () => {
    const cart = getCart(); if (!cart.length) return;
    const param = ("order_" + cart.map(slug).join("-")).slice(0, 60);
    window.open(CONFIG.telegram + "?start=" + encodeURIComponent(param), "_blank", "noopener");
  };
  renderCart();

  addEventListener("hashchange", router);
  router();
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
