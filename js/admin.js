import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const API = "https://api.goangel.dpdns.org";
const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => /^https:\/\//i.test(u || "") ? u : "#";
const packsCol = collection(db, "packs");
const mediaCol = collection(db, "media");
const trackCol = collection(db, "track_record");
const revCol = collection(db, "testimonials");

// --- Système de confirmation personnalisé ---
function showConfirm(title, message) {
  return new Promise((resolve) => {
    const modal = $("confirm-modal");
    $("confirm-title").textContent = title;
    $("confirm-message").textContent = message;
    modal.classList.remove("hidden");
    const btnOk = $("confirm-ok"), btnCancel = $("confirm-cancel");
    const cleanup = () => { modal.classList.add("hidden"); btnOk.removeEventListener("click", onOk); btnCancel.removeEventListener("click", onCancel); };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    btnOk.addEventListener("click", onOk);
    btnCancel.addEventListener("click", onCancel);
  });
}

// --- API backend (jeton Firebase ; le serveur vérifie le claim admin) ---
async function adminApi(path, method = "GET") {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(API + path, { method, headers: { Authorization: "Bearer " + token } });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data && typeof data.detail === "string" ? data.detail : "Erreur serveur (" + res.status + ")");
  return data;
}

function showDenied() { $("admin-denied").classList.remove("hidden"); $("admin-content").classList.add("hidden"); }
function showContent() {
  $("admin-content").classList.remove("hidden"); $("admin-denied").classList.add("hidden");
  loadPacks(); loadMedia(); loadTrack(); loadReviews(); loadStock();
}

// ---------- Catalogue & stock ----------
const STATE_LABEL = { available: "✅ Disponible", unavailable: "⛔ Indisponible (épuisé)", unknown: "⚠️ Non vérifiable" };
function renderStock(v) {
  const list = $("stock-list"); list.innerHTML = "";
  (v.products || []).forEach(p => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="item-info"><strong>${esc(p.name)} — v${esc(p.version)} — ${esc(p.price_usdt)} USDT</strong>
      <small>${STATE_LABEL[p.state] || esc(p.state)}${p.recently_updated ? " · 🆕 récemment mis à jour" : ""}${p.file ? " · " + esc(p.file.name) + " (" + (p.file.size / 1048576).toFixed(1) + " Mo)" : ""}${p.archived && p.archived.length ? "<br>Anciennes versions conservées : " + esc(p.archived.join(", ")) : ""}</small></div>`;
    list.appendChild(li);
  });
  if (!(v.products || []).length) list.innerHTML = '<li class="muted">Aucun produit.</li>';
  $("unlisted-box").textContent = v.unlisted && v.unlisted.length
    ? "Fichiers présents sur Drive mais absents du catalogue (nom à rapprocher d'un produit) : " + v.unlisted.join(", ") : "";
  const st = $("sync-status");
  if (v.drive === "ok") { st.textContent = "Drive connecté — dernière synchronisation : " + new Date(v.synced_at).toLocaleTimeString("fr-FR"); st.style.color = "var(--pos)"; }
  else { st.textContent = "⚠️ Drive : " + (v.error || v.drive); st.style.color = "var(--err)"; }
}
async function loadStock() { try { renderStock(await adminApi("/api/admin/catalog")); } catch (e) { const st = $("sync-status"); st.textContent = "Serveur indisponible : " + e.message; st.style.color = "var(--err)"; } }
async function syncNow(quiet) {
  const st = $("sync-status");
  if (!quiet) { st.textContent = "Synchronisation en cours…"; st.style.color = "var(--gold)"; }
  try { renderStock(await adminApi("/api/admin/sync", "POST")); } catch (e) { st.textContent = "❌ " + e.message; st.style.color = "var(--err)"; }
}
$("sync-btn").addEventListener("click", () => syncNow(false));

// ---------- Packs / produits ----------
function resetPackForm() {
  $("pack-form").reset(); $("pack-id").value = "";
  $("pack-submit").textContent = "Ajouter le pack"; $("pack-cancel").style.display = "none";
}

async function loadPacks() {
  try {
    const snapshot = await getDocs(query(packsCol, orderBy("name")));
    const list = $("pack-list");
    list.innerHTML = "";
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="item-info">
          <strong>${esc(data.name)} - ${esc(data.price)} USDT${data.featured ? " ⭐" : ""}${data.hidden ? " (masqué)" : ""}</strong>
          <small>${esc((data.features || []).join(", "))}</small>
        </div>
        <div class="item-actions">
          <button class="btn small ghost edit-pack" data-id="${esc(docSnap.id)}">Modifier</button>
          <button class="btn small btn-danger delete-pack" data-id="${esc(docSnap.id)}">Supprimer</button>
        </div>`;
      list.appendChild(li);
    });
    list.querySelectorAll(".edit-pack").forEach(b => b.addEventListener("click", () => editPack(b.dataset.id)));
    list.querySelectorAll(".delete-pack").forEach(b => b.addEventListener("click", () => deletePack(b.dataset.id)));
  } catch (e) { console.error(e); }
}

async function editPack(id) {
  const docSnap = await getDoc(doc(packsCol, id));
  if (!docSnap.exists()) return;
  const data = docSnap.data();
  $("pack-id").value = id;
  $("pack-name").value = data.name || "";
  $("pack-price").value = data.price || "";
  $("pack-features").value = (data.features || []).join("\n");
  $("pack-featured").value = data.featured ? "true" : "false";
  $("pack-tagline").value = data.tagline || "";
  $("pack-version").value = data.version || "";
  $("pack-requirements").value = (data.requirements || []).join("\n");
  $("pack-long").value = data.long_description || "";
  $("pack-visible").value = data.hidden ? "false" : "true";
  $("pack-submit").textContent = "Mettre à jour";
  $("pack-cancel").style.display = "inline-block";
  $("pack-form").scrollIntoView({ behavior: "smooth" });
}

async function deletePack(id) {
  if (await showConfirm("Supprimer le pack", "Voulez-vous vraiment supprimer cette fiche ? Un produit de catalog.json reviendra à sa version d'origine.")) {
    await deleteDoc(doc(packsCol, id)); loadPacks(); syncNow(true);
  }
}

$("pack-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("pack-id").value;
  const lines = v => v.split("\n").map(s => s.trim()).filter(Boolean);
  const name = $("pack-name").value.trim();
  const price = Number($("pack-price").value);
  const features = lines($("pack-features").value);
  if (!name || !(price > 0) || price > 5000 || features.length === 0) return;
  const payload = {
    name, price, features,
    featured: $("pack-featured").value === "true",
    tagline: $("pack-tagline").value.trim(),
    version: $("pack-version").value.trim(),
    requirements: lines($("pack-requirements").value),
    long_description: $("pack-long").value.trim(),
    hidden: $("pack-visible").value === "false"
  };
  try {
    if (id) await updateDoc(doc(packsCol, id), payload); else await addDoc(packsCol, payload);
    resetPackForm(); loadPacks(); syncNow(true);
  } catch (err) { alert("Erreur d'enregistrement : " + (err.code || err.message)); }
});
$("pack-cancel").addEventListener("click", resetPackForm);

// ---------- Médias ----------
async function loadMedia() {
  try {
    const snapshot = await getDocs(mediaCol);
    const list = $("media-list");
    list.innerHTML = "";
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      const li = document.createElement("li");
      const info = data.type === "text" ? "texte" : `${esc(data.type)} - ${((data.size || 0) / 1024).toFixed(1)} KB`;
      li.innerHTML = `
        <div class="item-info">
          <strong>${esc(data.description || data.type)}</strong>
          <small>${info}</small>
        </div>
        <div class="item-actions">
          ${data.url ? `<a href="${esc(safeUrl(data.url))}" target="_blank" rel="noopener" class="btn small ghost">Voir</a>` : ""}
          <button class="btn small btn-danger delete-media" data-id="${esc(docSnap.id)}">Supprimer</button>
        </div>`;
      list.appendChild(li);
    });
    list.querySelectorAll(".delete-media").forEach(b => b.addEventListener("click", () => deleteMedia(b.dataset.id)));
  } catch (e) { console.error(e); }
}
async function deleteMedia(id) {
  if (await showConfirm("Supprimer le média", "Voulez-vous vraiment retirer ce contenu du site ? (Un fichier envoyé reste stocké sur Cloudinary)")) {
    await deleteDoc(doc(mediaCol, id)); loadMedia();
  }
}

function syncMediaType() {
  const isText = $("media-type").value === "text";
  $("file-group").classList.toggle("hidden", isText);
  $("text-group").classList.toggle("hidden", !isText);
}
$("media-type").addEventListener("change", syncMediaType);
syncMediaType();

$("media-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const type = $("media-type").value;
  const desc = $("media-desc").value.trim();
  const statusEl = $("media-status");
  const fail = (m) => { statusEl.textContent = m; statusEl.style.color = "var(--err)"; };
  try {
    if (type === "text") {
      const text = $("media-text").value.trim();
      if (!text) return fail("⚠️ Saisissez un texte.");
      await addDoc(mediaCol, { type, description: desc, text, createdAt: new Date().toISOString() });
    } else {
      const file = $("media-file").files[0];
      if (!file) return fail("⚠️ Choisissez un fichier.");
      if (file.size > 20 * 1024 * 1024) return fail("⚠️ Fichier trop lourd (> 20 Mo). Utilisez un lien externe.");
      statusEl.textContent = "Téléversement en cours..."; statusEl.style.color = "var(--gold)";
      const formData = new FormData();
      formData.append("file", file);
      formData.append("upload_preset", "goangel_unsigned");
      const response = await fetch("https://api.cloudinary.com/v1_1/gkiui3xc/auto/upload", { method: "POST", body: formData });
      if (!response.ok) throw new Error("Erreur Cloudinary");
      const data = await response.json();
      await addDoc(mediaCol, { type, description: desc, url: data.secure_url, size: file.size, createdAt: new Date().toISOString() });
    }
    $("media-form").reset(); syncMediaType();
    statusEl.textContent = "✅ Contenu publié, visible par tous les utilisateurs !";
    statusEl.style.color = "var(--pos)";
    loadMedia();
  } catch (error) { fail("❌ Erreur lors de la publication : " + (error.code || error.message)); }
});

// ---------- Track record ----------
const TR = { win: "Gagné", loss: "Perdu", pending: "En attente" };
async function loadTrack() {
  try {
    const snap = await getDocs(trackCol);
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const list = $("track-list"); list.innerHTML = "";
    rows.forEach(r => {
      const li = document.createElement("li");
      li.innerHTML = `<div class="item-info"><strong>${esc(r.match)}</strong><small>${esc(r.date)} · ${esc(r.pick)} · ${esc(r.confidence)} %</small></div>
        <div class="item-actions"><select data-id="${esc(r.id)}" class="tr-status" aria-label="Statut">${Object.keys(TR).map(k => `<option value="${k}"${r.status === k ? " selected" : ""}>${TR[k]}</option>`).join("")}</select>
        <button class="btn small btn-danger" data-del="${esc(r.id)}">Supprimer</button></div>`;
      list.appendChild(li);
    });
    list.querySelectorAll(".tr-status").forEach(s => s.addEventListener("change", async () => { await updateDoc(doc(trackCol, s.dataset.id), { status: s.value }); }));
    list.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (await showConfirm("Supprimer l'analyse", "Retirer cette ligne du track record ?")) { await deleteDoc(doc(trackCol, b.dataset.del)); loadTrack(); }
    }));
  } catch (e) { console.error(e); }
}
$("track-form").addEventListener("submit", async e => {
  e.preventDefault();
  const conf = Number($("track-conf").value);
  if (!(conf >= 0 && conf <= 100)) return;
  try {
    await addDoc(trackCol, { date: $("track-date").value, match: $("track-match").value.trim(), pick: $("track-pick").value.trim(), confidence: conf, status: $("track-status").value, createdAt: new Date().toISOString() });
    $("track-form").reset(); loadTrack();
  } catch (err) { alert("Erreur d'enregistrement : " + (err.code || err.message)); }
});

// ---------- Témoignages ----------
async function loadReviews() {
  try {
    const snap = await getDocs(revCol);
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const list = $("rev-list"); list.innerHTML = "";
    rows.forEach(r => {
      const li = document.createElement("li");
      li.innerHTML = `<div class="item-info"><strong>${esc(r.name)} — ${"★".repeat(Number(r.rating) || 0)}${r.verified === true ? " ✔ vérifié" : ""}</strong><small>${esc(r.text)}</small></div>
        <div class="item-actions"><button class="btn small btn-danger" data-del="${esc(r.id)}">Supprimer</button></div>`;
      list.appendChild(li);
    });
    list.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (await showConfirm("Supprimer le témoignage", "Retirer ce témoignage du site ?")) { await deleteDoc(doc(revCol, b.dataset.del)); loadReviews(); }
    }));
  } catch (e) { console.error(e); }
}
$("rev-form").addEventListener("submit", async e => {
  e.preventDefault();
  const avatar = $("rev-avatar").value.trim();
  if (avatar && !/^https:\/\//i.test(avatar)) { alert("La photo doit être un lien https."); return; }
  try {
    await addDoc(revCol, { name: $("rev-name").value.trim(), rating: Math.max(1, Math.min(5, Number($("rev-rating").value) || 5)), text: $("rev-text").value.trim(),
      avatar_url: avatar, verified: $("rev-verified").value === "true", createdAt: new Date().toISOString() });
    $("rev-form").reset(); loadReviews();
  } catch (err) { alert("Erreur d'enregistrement : " + (err.code || err.message)); }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) { location.replace("login.html"); return; }
  try {
    const r = await user.getIdTokenResult(true);
    if (r.claims.admin === true) showContent(); else showDenied();
  } catch (error) { showDenied(); }
});
