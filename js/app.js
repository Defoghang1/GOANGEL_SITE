// Application principale — chargé avec <script type="module">
import { Auth } from "./auth.js";
import { db } from "./firebase-config.js";
import { updateProfile } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const API = "https://api.goangel.dpdns.org";
const CLOUDINARY_URL = "https://api.cloudinary.com/v1_1/gkiui3xc/image/upload";
const CLOUDINARY_PRESET = "goangel_unsigned";
const VERSION_POLL_MS = 3000;          // le site demande « le catalogue a-t-il changé ? » (réponse minuscule)

const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => /^https:\/\//i.test(u || "") ? u : "";
const fmtPrice = p => Number(p).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const fmtDate = s => { const d = new Date(s); return isNaN(d) ? esc(s || "") : d.toLocaleDateString("fr-FR"); };
const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1).replace(".", ",") + " Mo" : Math.max(1, Math.round(b / 1024)) + " Ko";
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const store = { get: k => { try { return sessionStorage.getItem(k) || ""; } catch (e) { return ""; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} } };

let user = null;
let payTimer = null;
let shopTimer = null;
let catalog = { products: [], promo: null, drive: "unknown", loaded: false, error: null };

// ---------- API (avec jeton Firebase) ----------
async function api(path, opts = {}) {
  const token = await Auth.token();
  const res = await fetch(API + path, {
    cache: "no-store",
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

// ---------- Modale accessible (fiches produit) ----------
function openModal(inner, label) {
  const prev = document.activeElement;
  const m = document.createElement("div");
  m.className = "modal";
  m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true"); m.setAttribute("aria-label", label);
  m.innerHTML = `<div class="modal-content prod-modal"><button class="modal-close" aria-label="Fermer">×</button>${inner}</div>`;
  document.body.appendChild(m);
  const close = () => { document.removeEventListener("keydown", onKey); m.remove(); if (prev && prev.focus) prev.focus(); };
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  m.addEventListener("click", e => { if (e.target === m) close(); });
  m.querySelector(".modal-close").onclick = close;
  m.querySelector(".modal-close").focus();
  return { el: m, close };
}

// ---------- Catalogue (Google Drive → backend → ici) ----------
let catalogLoading = null;
function fetchCatalog() {
  if (catalogLoading) return catalogLoading;
  catalogLoading = api("/api/catalog")
    .then(d => { catalog = { products: d.products || [], promo: d.promo || null, myPromo: d.my_promo || null, drive: d.drive, loaded: true, error: null, at: Date.now(), version: d.version }; })
    .catch(e => { catalog = { ...catalog, loaded: true, error: e.message || "Catalogue indisponible." }; })
    .finally(() => { catalogLoading = null; onCatalogChange(); });
  return catalogLoading;
}
let versionBusy = false;
async function checkCatalogVersion() {
  if (document.hidden || versionBusy || catalogLoading) return;
  versionBusy = true;
  try {
    const v = await api("/api/catalog-version");
    if (v.version && v.version !== catalog.version) await fetchCatalog();      // le catalogue complet n'est rechargé que s'il a changé
  } catch (e) { /* serveur hors ligne : nouvel essai au prochain passage */ }
  finally { versionBusy = false; }
}
const productById = id => catalog.products.find(p => p.id === id);
const promoApplies = p => !!catalog.myPromo && (!catalog.myPromo.pack_id || catalog.myPromo.pack_id === p.id);
const priceOf = p => promoApplies(p) ? +(Number(p.price_usdt) * (1 - catalog.myPromo.percent / 100)).toFixed(2) : Number(p.price_usdt);
function onCatalogChange() { renderPromo(); renderShop(); renderCart(); syncPromoForm(); }

// ---------- Bandeau promotionnel (affiché uniquement si le serveur confirme que l'offre est active) ----------
function renderPromo() {
  const slot = $("promo-slot"); if (!slot) return;
  const pr = catalog.promo, xKey = pr && "goangel_promo_x_" + user.uid + "_" + pr.code;
  if (!pr || store.get(xKey)) { slot.innerHTML = ""; return; }
  const mine = catalog.myPromo && catalog.myPromo.code === pr.code;
  slot.innerHTML = `<div class="promo-bar" role="region" aria-label="Offre promotionnelle">
    <span class="promo-msg">${esc(pr.message)}</span>
    <button class="promo-use" type="button"${mine ? " disabled" : ""}>${mine ? "✓ Code appliqué" : "Utiliser le code"}</button>
    <button class="promo-x" type="button" aria-label="Fermer l'offre">×</button></div>`;
  slot.querySelector(".promo-x").onclick = () => { store.set(xKey, "1"); slot.innerHTML = ""; };
  slot.querySelector(".promo-use").onclick = async () => {
    if (await applyPromo(pr.code)) {
      if (location.hash !== "#pricing") location.hash = "pricing"; else { const s = $("shop"); if (s) s.scrollIntoView({ behavior: "smooth" }); }
    }
  };
}
// La réduction est enregistrée côté serveur pour CE compte uniquement : elle ne change jamais le prix des autres utilisateurs.
async function applyPromo(code) {
  code = String(code || "").trim().toUpperCase();
  const msg = $("promo-msg");
  if (!code) { if (msg) msg.textContent = "Saisissez un code promo."; return false; }
  try {
    const r = await api("/api/promo/apply", { method: "POST", body: JSON.stringify({ code }) });
    catalog.myPromo = r.promo;
    const pk = r.promo.pack_id ? productById(r.promo.pack_id) : null;
    if (msg) msg.textContent = `✅ Code appliqué à votre compte : -${r.promo.percent} %${pk ? " sur le pack " + pk.name : " sur tous les packs"}.`;
    syncPromoForm(); renderShop(); renderCart(); renderPromo();
    return true;
  } catch (e) { if (msg) msg.textContent = "❌ " + e.message; return false; }
}
async function clearPromo() {
  try {
    await api("/api/promo/clear", { method: "POST" });
    catalog.myPromo = null;
    const msg = $("promo-msg"); if (msg) msg.textContent = "Code retiré de votre compte.";
    syncPromoForm(); renderShop(); renderCart(); renderPromo();
  } catch (e) { const msg = $("promo-msg"); if (msg) msg.textContent = "❌ " + e.message; }
}
function syncPromoForm() {
  const input = $("promo-input"), clr = $("promo-clear"); if (!input) return;
  if (catalog.myPromo) { input.value = catalog.myPromo.code; input.dataset.applied = "1"; }
  else if (input.dataset.applied) { input.value = ""; delete input.dataset.applied; }
  if (clr) clr.hidden = !catalog.myPromo;
}

// ---------- Fiches produit ----------
function stateBadge(p) {
  if (p.state === "unavailable") return '<span class="badge badge-off">Indisponible</span>';
  if (p.featured) return '<span class="badge">Recommandé</span>';
  return "";
}
function priceBlock(p) {
  const base = Number(p.price_usdt), now = priceOf(p);
  return `<div class="amount">${now !== base ? `<s class="was">${fmtPrice(base)}</s> ` : ""}${fmtPrice(now)} <small>USDT (TRC-20)</small></div>${promoApplies(p) ? `<p class="promo-tag">Code ${esc(catalog.myPromo.code)} : -${catalog.myPromo.percent} %</p>` : ""}`;
}
function artBlock(p, small) {
  const img = safeUrl(p.image_url);
  return `<div class="prod-art${small ? " sm" : ""}" aria-hidden="true">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : `<span class="prod-ico">${esc(p.icon || "📦")}</span><i></i><i></i><i></i>`}</div>`;
}
function buyButton(p, label) {
  return p.available
    ? `<button class="btn buy-btn" data-buy="${esc(p.id)}">${label || "Acheter"}</button>`
    : `<button class="btn buy-btn" disabled aria-disabled="true">${p.state === "unknown" ? "Vérification…" : "Indisponible"}</button>`;
}
function fileLine(p) {
  if (!p.available || !p.file) return "";
  return `<p class="prod-file">📦 ${esc(p.file.name)} · ${fmtSize(p.file.size)}${p.file.updated_at ? " · mis à jour le " + fmtDate(p.file.updated_at) : ""}</p>`;
}
function productCard(p) {
  return `<article class="card prod-card ${p.featured ? "featured" : ""} ${p.available ? "" : "is-off"}" data-id="${esc(p.id)}">
    ${stateBadge(p)}
    ${artBlock(p)}
    <div class="prod-head"><h3>${esc(p.name)}</h3><span class="prod-ver">v${esc(p.version)}</span>${p.recently_updated ? '<span class="prod-new">Mis à jour</span>' : ""}</div>
    <p class="prod-tag">${esc(p.tagline || p.description || "")}</p>
    ${priceBlock(p)}
    <ul>${(p.features || []).slice(0, 5).map(f => `<li>${esc(f)}</li>`).join("")}</ul>
    ${fileLine(p)}
    ${p.available ? "" : `<p class="prod-soldout" role="status">${esc(p.message)}</p>`}
    <div class="btn-row">${buyButton(p)}<button class="btn ghost cart-add" data-add="${esc(p.id)}" aria-label="Ajouter ${esc(p.name)} au panier" title="Ajouter au panier"${p.available ? "" : " disabled"}>🛒</button></div>
    <button class="btn ghost prod-more" data-more="${esc(p.id)}">Voir les détails</button>
  </article>`;
}
function renderShop() {
  const box = $("shop-box"); if (!box) return;
  if (!catalog.loaded) { box.innerHTML = '<p class="muted">Chargement du catalogue…</p>'; return; }
  if (!catalog.products.length) {
    box.innerHTML = `<div class="shop-empty" role="status"><p>${catalog.error ? "La boutique est momentanément indisponible : " + esc(catalog.error) : "Aucun logiciel n'est publié pour le moment."}</p><button class="btn small ghost" id="shop-retry">Réessayer</button></div>`;
    $("shop-retry").onclick = () => { catalog.loaded = false; renderShop(); fetchCatalog(); };
    return;
  }
  const unknown = catalog.products.some(p => p.state === "unknown");
  box.innerHTML = (unknown ? '<p class="shop-note" role="status">⚠️ Vérification des fichiers en cours : l\'achat est désactivé le temps de confirmer la disponibilité.</p>' : "") +
    '<div class="grid prod-grid">' + catalog.products.map(productCard).join("") + "</div>";
  box.querySelectorAll("[data-buy]").forEach(b => b.onclick = () => initiatePayment(b.dataset.buy, b));
  box.querySelectorAll("[data-add]").forEach(b => b.onclick = () => { const p = productById(b.dataset.add); if (p) { addToCart(p.name); b.textContent = "✓"; setTimeout(() => b.textContent = "🛒", 1000); } });
  box.querySelectorAll("[data-more]").forEach(b => b.onclick = () => openDetails(b.dataset.more));
}
function detailSection(title, content, ordered) {
  if (!content || (Array.isArray(content) && !content.length)) return "";
  const body = Array.isArray(content) ? `<${ordered ? "ol" : "ul"} class="pd-list">${content.map(c => `<li>${esc(c)}</li>`).join("")}</${ordered ? "ol" : "ul"}>` : `<p>${esc(content)}</p>`;
  return `<section class="pd-sec"><h3>${esc(title)}</h3>${body}</section>`;
}
function openDetails(id) {
  const p = productById(id); if (!p) return;
  const base = Number(p.price_usdt), now = priceOf(p);
  const label = p.available ? `Acheter — ${fmtPrice(now)} USDT` : "Indisponible";
  const buy = p.available ? `<button class="btn buy-btn" data-buy="${esc(p.id)}">${label}</button>` : `<button class="btn buy-btn" disabled aria-disabled="true">${p.state === "unknown" ? "Vérification…" : "Indisponible"}</button>`;
  const inner = `
    <div class="pd-head">${artBlock(p, true)}<div><h2>Pack ${esc(p.name)} <span class="prod-ver">v${esc(p.version)}</span></h2><p class="muted">${esc(p.tagline || "")}</p></div></div>
    <div class="pd-buy"><div>${now !== base ? `<s class="was">${fmtPrice(base)}</s> ` : ""}<b class="pd-price">${fmtPrice(now)} USDT</b>${promoApplies(p) ? ` <span class="promo-tag">Code ${esc(catalog.myPromo.code)} : -${catalog.myPromo.percent} %</span>` : ""}</div>${buy}</div>
    ${p.available ? "" : `<p class="prod-soldout" role="status">${esc(p.message)}</p>`}
    ${detailSection("Description", p.long_description || p.description)}
    ${detailSection("Fonctionnalités", p.features)}
    ${detailSection("Avantages", p.benefits)}
    ${detailSection("Outils et technologies", p.technologies)}
    ${detailSection("Fichiers inclus dans le ZIP", [...(p.included_files || []), ...(p.available && p.file ? [`Fichier livré : ${p.file.name} (${fmtSize(p.file.size)})`] : [])])}
    ${detailSection("Prérequis d'installation", p.requirements)}
    ${detailSection("Compatibilité", p.compatibility)}
    ${detailSection("Instructions d'utilisation", p.usage, true)}
    ${detailSection("Version et mises à jour", [`Version disponible : ${p.version}${p.file && p.file.updated_at ? " (fichier du " + fmtDate(p.file.updated_at) + ")" : ""}`, ...(p.updates ? [p.updates] : [])])}
    ${detailSection("Conditions de livraison", p.delivery)}
    <p class="muted pd-legal">GOANGEL est un outil d'analyse statistique : aucun gain n'est garanti. Réservé aux personnes majeures.</p>
    <div class="pd-buy pd-buy-bottom"><b class="pd-price">${fmtPrice(now)} USDT</b>${buy}</div>`;
  const m = openModal(inner, "Détails du pack " + p.name);
  m.el.querySelectorAll("[data-buy]").forEach(b => b.onclick = () => { m.close(); initiatePayment(b.dataset.buy, b); });
}

// ---------- Panier (par utilisateur, localStorage) ----------
const cartKey = () => "goangel_cart_" + (user ? user.uid : "anon");
const getCart = () => { try { return JSON.parse(localStorage.getItem(cartKey())) || []; } catch (e) { return []; } };
const setCart = c => { try { localStorage.setItem(cartKey(), JSON.stringify(c)); } catch (e) {} renderCart(); };
function addToCart(name) { const c = getCart(); if (!c.includes(name)) c.push(name); setCart(c); }
function renderCart() {
  const cart = getCart();
  $("cart-count").textContent = cart.length;
  $("cart-count").style.display = cart.length ? "inline-block" : "none";
  let total = 0;
  $("cart-items").innerHTML = cart.length ? cart.map((n, i) => {
    const p = catalog.products.find(x => x.name === n);
    const price = p ? priceOf(p) : 0; if (p && p.available) total += price;
    return `<div class="cart-item"><span>${esc(n)}${p && !p.available ? " <small>(indisponible)</small>" : ""}</span><span>${p ? fmtPrice(price) + " USDT" : "—"} <button data-rm="${i}" aria-label="Retirer">✕</button></span></div>`;
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
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-label", "Paiement crypto");
  const promoLine = order.promo_code ? `<p class="promo-tag">Code ${esc(order.promo_code)} : -${esc(order.discount_percent)} % (au lieu de ${esc(fmtPrice(order.base_price))} USDT)</p>` : "";
  modal.innerHTML = `
    <div class="modal-content">
      <button class="modal-close" aria-label="Fermer">×</button>
      <h2 style="color:var(--gold)">Paiement Crypto</h2>
      <p style="margin:1rem 0 .5rem">Pack <b>${esc(order.pack_name)}</b>${order.version ? " v" + esc(order.version) : ""} — envoyez exactement :</p>
      ${promoLine}
      <div class="copy-row"><code id="pay-amount">${esc(order.amount)}</code><button class="btn small ghost" data-copy="pay-amount">Copier</button></div>
      <p style="margin-bottom:.5rem"><b>${esc(String(order.currency).toUpperCase())}</b> (réseau Tron TRC-20) à cette adresse :</p>
      <div class="copy-row"><code id="pay-addr">${esc(order.pay_address)}</code><button class="btn small ghost" data-copy="pay-addr">Copier</button></div>
      <p id="pay-status" style="color:var(--muted)" role="status">En attente du paiement sur la blockchain…</p>
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

async function initiatePayment(productId, btn) {
  const p = productById(productId);
  const old = btn.textContent; btn.disabled = true; btn.textContent = "Création…";
  try {
    const body = { product_id: productId };
    if (p && promoApplies(p)) body.promo_code = catalog.myPromo.code;      // le serveur revérifie tout (disponibilité, code, prix)
    const order = await api("/api/create-payment", { method: "POST", body: JSON.stringify(body) });
    showPayModal(order);
    refreshOrders();
  } catch (e) {
    alert(e.message);
    fetchCatalog();                                              // stock/état peut avoir changé
  } finally { btn.disabled = false; btn.textContent = old; }
}

async function downloadOrder(paymentId) {
  try {
    const r = await api("/api/download-token/" + encodeURIComponent(paymentId), { method: "POST" });
    if (!r.url) throw new Error("Lien indisponible.");
    window.location.href = API + r.url;   // le serveur envoie le ZIP en flux (lien signé valable 2 min)
  } catch (e) { alert("Téléchargement impossible : " + e.message); }
}

function confirmBox(title, html, okLabel) {
  return new Promise(resolve => {
    const m = document.createElement("div");
    m.className = "modal";
    m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true"); m.setAttribute("aria-label", title);
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
        <div><strong>${esc(o.pack_name)}${o.version ? " v" + esc(o.version) : ""}</strong> <span class="st ${esc(o.status)}">${esc(ST_LABEL[o.status] || o.status)}</span>
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
      if (o) showPayModal({ payment_id: o.payment_id, pack_name: o.pack_name, version: o.version, amount: o.pay_amount, currency: o.pay_currency, pay_address: o.pay_address });
    });
  } catch (e) { box.innerHTML = '<p class="muted">Historique indisponible (serveur hors ligne).</p>'; }
}

// ---------- Track record (résultats réels saisis par l'administrateur) ----------
const TR_LABEL = { win: "Gagné", loss: "Perdu", pending: "En attente" };
async function renderTrack() {
  const box = $("track-box"); if (!box) return;
  try {
    const snap = await getDocs(collection(db, "track_record"));
    if (!$("track-box")) return;
    const rows = snap.docs.map(d => d.data()).filter(r => r && r.match && r.pick && TR_LABEL[r.status])
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).slice(0, 5);
    if (!rows.length) { box.innerHTML = '<p class="muted tr-empty">Le suivi public des analyses sera publié dès les premiers résultats vérifiés. Aucune performance n\'est affichée tant qu\'elle n\'est pas réelle.</p>'; return; }
    box.innerHTML = `<div class="tr-wrap"><table class="tr-table"><caption class="sr-only">Cinq dernières analyses GOANGEL</caption>
      <thead><tr><th scope="col">Date</th><th scope="col">Match</th><th scope="col">Pronostic</th><th scope="col">Confiance</th><th scope="col">Statut</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td data-label="Date">${fmtDate(r.date)}</td><td data-label="Match">${esc(r.match)}</td><td data-label="Pronostic">${esc(r.pick)}</td><td data-label="Confiance">${esc(Number(r.confidence))} %</td><td data-label="Statut"><span class="tr-badge ${esc(r.status)}">${TR_LABEL[r.status]}</span></td></tr>`).join("")}
      </tbody></table></div>`;
  } catch (e) { box.innerHTML = '<p class="muted tr-empty">Suivi des analyses momentanément indisponible.</p>'; }
}

// ---------- Avis clients (réels, saisis par l'administrateur) ----------
async function renderReviews() {
  const box = $("rev-box"); if (!box) return;
  try {
    const snap = await getDocs(collection(db, "testimonials"));
    if (!$("rev-box")) return;
    const rows = snap.docs.map(d => d.data()).filter(r => r && r.name && r.text)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, 3);
    if (!rows.length) { box.innerHTML = '<p class="muted rev-empty">Les premiers avis clients seront publiés ici. Seuls de vrais retours de clients sont affichés.</p>'; return; }
    box.innerHTML = '<div class="rev-grid" role="list">' + rows.map(r => {
      const n = Math.max(1, Math.min(5, Math.round(Number(r.rating) || 5)));
      const av = safeUrl(r.avatar_url);
      return `<article class="rev-card" role="listitem">
        <div class="rev-top">${av ? `<img class="rev-av" src="${esc(av)}" alt="" loading="lazy">` : `<span class="rev-av rev-init" aria-hidden="true">${esc(String(r.name).charAt(0).toUpperCase())}</span>`}
        <div><strong>${esc(r.name)}</strong>${r.verified === true ? '<span class="rev-ok">✔ Avis vérifié</span>' : ""}</div></div>
        <div class="rev-stars" role="img" aria-label="${n} sur 5">${"★".repeat(n)}${"☆".repeat(5 - n)}</div>
        <p>${esc(r.text)}</p></article>`;
    }).join("") + "</div>";
  } catch (e) { box.innerHTML = '<p class="muted rev-empty">Avis momentanément indisponibles.</p>'; }
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
      return `<article class="card media-card">${body}${title ? `<h3>${title}</h3>` : ""}<small>${date}</small></article>`;
    }).join("");
  } catch (e) { box.innerHTML = '<p class="muted">Impossible de charger les contenus.</p>'; }
}

// ---------- Pages ----------
const ICO = {
  py: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m9.5 13-2 2 2 2M14.5 13l2 2-2 2"/></svg>',
  doc: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20M9 8h6M9 11h4"/></svg>',
  tg: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 4 3 11l6 2.2L11 20l3-4.2L19 20z"/><path d="m9 13.2 8-6.2"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>'
};
const pages = {
  home: () => `<div id="promo-slot"></div><section class="hero"><div class="monogram">GA</div><h1>${SITE_DATA.hero.title}</h1><p>${SITE_DATA.hero.subtitle}</p>
    <div class="actions"><a href="${esc(CONFIG.telegram)}" target="_blank" rel="noopener" class="btn">${SITE_DATA.hero.cta}</a><a href="#simulator" class="btn ghost">${SITE_DATA.hero.cta2}</a></div>
    <dl class="stats">${SITE_DATA.stats.map(s => `<div><dt>${s.v}</dt><dd>${s.l}</dd></div>`).join("")}</dl></section>`,
  features: () => `<section class="block"><h2>Technologie</h2><div class="grid">${SITE_DATA.features.map(f => `<article class="card"><div class="ico">${f.icon}</div><h3>${f.title}</h3><p>${f.desc}</p></article>`).join("")}</div></section>
    <section class="block narrow"><h2>Comment ça marche</h2><ol class="steps">${SITE_DATA.steps.map(s => `<li><div><strong>${s.t}</strong><br><span>${s.d}</span></div></li>`).join("")}</ol></section>`,
  simulator: () => `<section class="block"><h2>Simulateur</h2><div id="sim-root"></div></section>`,
  pricing: () => `<div id="promo-slot"></div>
    <section class="block tight"><h2>Nos dernières analyses</h2><div id="track-box"><p class="muted">Chargement…</p></div>
      <p class="tr-note">Les performances passées ne préjugent pas des performances futures. Notre force est la transparence.</p></section>
    <section class="block tight" id="shop"><h2>Choisissez votre pack</h2>
      <form id="promo-form" class="promo-row" autocomplete="off"><label for="promo-input">Code promo</label><input id="promo-input" maxlength="40" placeholder="Votre code" value="${esc(catalog.myPromo ? catalog.myPromo.code : "")}"><button class="btn small ghost" type="submit">Appliquer</button><button class="btn small ghost" type="button" id="promo-clear"${catalog.myPromo ? "" : " hidden"}>Retirer</button></form>
      <p id="promo-msg" class="form-hint" role="status"></p>
      <div id="shop-box"><p class="muted">Chargement du catalogue…</p></div></section>
    <section class="block tight pc"><h2>Que contient le pack ?</h2>
      <div class="pc-wrap"><pre class="pc-term" aria-hidden="true"><span class="pc-dots">● ● ●</span>
# GOANGEL · analyse football
model = ensemble(xgboost, poisson, dixon_coles)
proba = calibrate(model.predict(match))
# validation walk-forward · sans fuite de données</pre>
        <div class="pc-grid">
          <article class="pc-tile">${ICO.py}<h3>Fichiers Python prêts à l'emploi</h3><p>Le code livré fonctionne sur votre machine.</p></article>
          <article class="pc-tile">${ICO.doc}<h3>Documentation complète</h3><p>Installation et utilisation expliquées pas à pas.</p></article>
          <article class="pc-tile">${ICO.tg}<h3>Accès au bot Telegram</h3><p>Retrouvez GOANGEL directement dans Telegram.</p></article>
          <article class="pc-tile">${ICO.bolt}<h3>Scripts optimisés</h3><p>Des scripts pensés pour des analyses rapides.</p></article>
        </div></div>
      <p class="muted pc-note">Le contenu exact varie selon le pack : consultez « Voir les détails » sur chaque fiche.</p></section>
    <section class="block tight"><h2>Ce que disent nos clients</h2><div id="rev-box"><p class="muted">Chargement…</p></div></section>
    <section class="block tight orders"><h3>Vos achats</h3><div id="orders-list"><p class="muted">Chargement…</p></div></section>`,
  faq: () => `<section class="block narrow"><h2>FAQ</h2>${SITE_DATA.faq.map(i => `<details><summary>${i.q}</summary><p>${i.a}</p></details>`).join("")}</section>`,
  legal: () => `<section class="block narrow"><h2>Nos Modèles</h2>${SITE_DATA.legal.map(t => `<p class="legal">${t}</p>`).join("")}</section>`,
  media: () => `<section class="block"><h2>Médias</h2><div id="media-list" class="media-grid"><p class="muted">Chargement…</p></div></section>`
};

let currentKey = null;
const router = () => {
  const key = pages[location.hash.slice(1)] ? location.hash.slice(1) : "home";
  if (currentKey === "simulator" && key !== "simulator") Simulator.destroy();
  clearInterval(shopTimer); shopTimer = null;
  currentKey = key;
  $("app").innerHTML = pages[key]();
  document.querySelectorAll("[data-nav]").forEach(a => a.removeAttribute("aria-current"));
  const act = document.querySelector(`[data-nav="${key}"]`); if (act) act.setAttribute("aria-current", "page");
  $("menu").classList.remove("open"); $("burger").setAttribute("aria-expanded", "false");
  window.scrollTo(0, 0);
  renderPromo();
  if (key === "simulator") Simulator.mount($("sim-root"));
  if (key === "media") renderMedia();
  if (key === "pricing") {
    $("promo-form").onsubmit = e => { e.preventDefault(); applyPromo($("promo-input").value); };
    $("promo-clear").onclick = clearPromo;
    syncPromoForm();
    renderTrack(); renderReviews(); refreshOrders(); renderShop();
    if (!catalog.loaded || Date.now() - (catalog.at || 0) > 30000) fetchCatalog();
    shopTimer = setInterval(checkCatalogVersion, VERSION_POLL_MS);   // nouveau ZIP, rupture de stock, nouvelle version : la boutique se met à jour seule
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
  document.body.hidden = false;

  $("nav-brand").textContent = CONFIG.brand;
  $("footer-brand").textContent = CONFIG.brand;
  $("year").textContent = new Date().getFullYear();
  $("nav-cta").href = CONFIG.telegram;
  $("user-name").textContent = user.displayName || (user.email || "").split("@")[0];
  $("logout").onclick = () => Auth.logout();
  // La barre fixe peut dépasser 70 px (logo sur 2 lignes) : le contenu est décalé de sa hauteur réelle
  const nav = document.querySelector("header.nav");
  const setNavH = () => document.documentElement.style.setProperty("--nav-h", nav.offsetHeight + "px");
  setNavH(); addEventListener("resize", setNavH); addEventListener("load", setNavH);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(setNavH);
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

  document.addEventListener("visibilitychange", () => { if (!document.hidden && currentKey === "pricing") checkCatalogVersion(); });
  addEventListener("hashchange", router);
  router();
  fetchCatalog();                                   // bandeau promo (accueil) + boutique
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
