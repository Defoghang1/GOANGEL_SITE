import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => /^https:\/\//i.test(u || "") ? u : "#";
const packsCol = collection(db, "packs");
const mediaCol = collection(db, "media");

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

function showDenied() { $("admin-denied").classList.remove("hidden"); $("admin-content").classList.add("hidden"); }
function showContent() { $("admin-content").classList.remove("hidden"); $("admin-denied").classList.add("hidden"); loadPacks(); loadMedia(); }

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
          <strong>${esc(data.name)} - ${esc(data.price)} USDT${data.featured ? " ⭐" : ""}</strong>
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

async function editPack(id) {
  const docSnap = await getDoc(doc(packsCol, id));
  if (!docSnap.exists()) return;
  const data = docSnap.data();
  $("pack-id").value = id;
  $("pack-name").value = data.name;
  $("pack-price").value = data.price;
  $("pack-features").value = (data.features || []).join("\n");
  $("pack-featured").value = data.featured ? "true" : "false";
  $("pack-submit").textContent = "Mettre à jour";
  $("pack-cancel").style.display = "inline-block";
}

async function deletePack(id) {
  if (await showConfirm("Supprimer le pack", "Voulez-vous vraiment supprimer ce pack ? Cette action est irréversible.")) {
    await deleteDoc(doc(packsCol, id)); loadPacks();
  }
}

async function deleteMedia(id) {
  if (await showConfirm("Supprimer le média", "Voulez-vous vraiment retirer ce contenu du site ? (Un fichier envoyé reste stocké sur Cloudinary)")) {
    await deleteDoc(doc(mediaCol, id)); loadMedia();
  }
}

$("pack-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("pack-id").value;
  const name = $("pack-name").value.trim();
  const price = Number($("pack-price").value);
  const features = $("pack-features").value.split("\n").map(s => s.trim()).filter(Boolean);
  const featured = $("pack-featured").value === "true";
  if (!name || !(price > 0) || price > 5000 || features.length === 0) return;
  try {
    if (id) await updateDoc(doc(packsCol, id), { name, price, features, featured });
    else await addDoc(packsCol, { name, price, features, featured });
    resetPackForm(); loadPacks();
  } catch (err) { alert("Erreur d'enregistrement : " + (err.code || err.message)); }
});
$("pack-cancel").addEventListener("click", resetPackForm);

// Type texte : pas de fichier, un champ texte
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
  } catch (error) {
    fail("❌ Erreur lors de la publication : " + (error.code || error.message));
  }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) { location.replace("login.html"); return; }
  try {
    const r = await user.getIdTokenResult(true);
    if (r.claims.admin === true) showContent(); else showDenied();
  } catch (error) { showDenied(); }
});
