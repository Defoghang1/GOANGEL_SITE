import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, doc, getDocs, addDoc, updateDoc, deleteDoc, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = id => document.getElementById(id);
const packsCol = collection(db, "packs");
const mediaCol = collection(db, "media");

// On force l'affichage de l'interface immédiatement
$("admin-content").classList.remove("hidden");
$("admin-denied").classList.add("hidden");

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.replace("login.html");
    return;
  }
  try {
    // On vérifie le rôle en arrière-plan
    const idTokenResult = await user.getIdTokenResult(true);
    if (idTokenResult.claims.admin === true) {
      loadPacks();
      loadMedia();
    } else {
      // Si tu n'es pas admin, on cache l'interface
      $("admin-content").classList.add("hidden");
      $("admin-denied").classList.remove("hidden");
    }
  } catch (error) {
    $("admin-content").classList.add("hidden");
    $("admin-denied").classList.remove("hidden");
  }
});

async function loadPacks() {
  try {
    const q = query(packsCol, orderBy("name"));
    const snapshot = await getDocs(q);
    const list = $("pack-list");
    list.innerHTML = "";
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="item-info">
          <strong>${data.name} - ${data.price} FCFA</strong>
          <small>${data.features.join(", ")}</small>
        </div>
        <div class="item-actions">
          <button class="btn small ghost edit-pack" data-id="${docSnap.id}">Modifier</button>
          <button class="btn small btn-danger delete-pack" data-id="${docSnap.id}">Supprimer</button>
        </div>
      `;
      list.appendChild(li);
    });
    list.querySelectorAll(".edit-pack").forEach(btn => {
      btn.addEventListener("click", () => editPack(btn.dataset.id));
    });
    list.querySelectorAll(".delete-pack").forEach(btn => {
      btn.addEventListener("click", () => deletePack(btn.dataset.id));
    });
  } catch(e) { console.error(e); }
}

async function loadMedia() {
  try {
    const snapshot = await getDocs(mediaCol);
    const list = $("media-list");
    list.innerHTML = "";
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="item-info">
          <strong>${data.description || data.type}</strong>
          <small>${data.type} - ${(data.size / 1024).toFixed(1)} KB</small>
        </div>
        <div class="item-actions">
          <a href="${data.url}" target="_blank" class="btn small ghost">Voir</a>
          <button class="btn small btn-danger delete-media" data-id="${docSnap.id}" data-url="${data.url}">Supprimer</button>
        </div>
      `;
      list.appendChild(li);
    });
    list.querySelectorAll(".delete-media").forEach(btn => {
      btn.addEventListener("click", () => deleteMedia(btn.dataset.id, btn.dataset.url));
    });
  } catch(e) { console.error(e); }
}

async function editPack(id) {
  const docSnap = await getDocs(packsCol).then(s => s.docs.find(d => d.id === id));
  if (!docSnap) return;
  const data = docSnap.data();
  $("pack-id").value = id;
  $("pack-name").value = data.name;
  $("pack-price").value = data.price;
  $("pack-features").value = data.features.join("\n");
  $("pack-featured").value = data.featured ? "true" : "false";
  $("pack-submit").textContent = "Mettre à jour";
  $("pack-cancel").style.display = "inline-block";
}

async function deletePack(id) {
  if (!confirm("Supprimer ce pack ?")) return;
  await deleteDoc(doc(packsCol, id));
  loadPacks();
}

async function deleteMedia(id, url) {
  if (!confirm("Supprimer ce média ? (Attention : le fichier restera sur Cloudinary)")) return;
  await deleteDoc(doc(mediaCol, id));
  loadMedia();
}

$("pack-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("pack-id").value;
  const name = $("pack-name").value.trim();
  const price = Number($("pack-price").value);
  const features = $("pack-features").value.split("\n").map(s => s.trim()).filter(Boolean);
  const featured = $("pack-featured").value === "true";
  if (!name || !price || features.length === 0) return;
  if (id) {
    await updateDoc(doc(packsCol, id), { name, price, features, featured });
  } else {
    await addDoc(packsCol, { name, price, features, featured });
  }
  $("pack-form").reset();
  $("pack-id").value = "";
  $("pack-submit").textContent = "Ajouter le pack";
  $("pack-cancel").style.display = "none";
  loadPacks();
});

$("pack-cancel").addEventListener("click", () => {
  $("pack-form").reset();
  $("pack-id").value = "";
  $("pack-submit").textContent = "Ajouter le pack";
  $("pack-cancel").style.display = "none";
});

$("media-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = $("media-file");
  const file = fileInput.files[0];
  if (!file) return;
  const type = $("media-type").value;
  const desc = $("media-desc").value.trim();
  const statusEl = $("media-status");
  
  if (file.size > 20 * 1024 * 1024) {
    statusEl.textContent = "⚠️ Fichier trop lourd (> 20 Mo). Utilise GitHub Releases ou un lien externe.";
    statusEl.style.color = "var(--err)";
    return;
  }

  statusEl.textContent = "Téléversement en cours...";
  statusEl.style.color = "var(--gold)";

  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", "goangel_unsigned");

  try {
    const response = await fetch("https://api.cloudinary.com/v1_1/gkiui3xc/auto/upload", {
      method: "POST",
      body: formData
    });
    if (!response.ok) throw new Error("Erreur Cloudinary");
    const data = await response.json();
    await addDoc(mediaCol, { type, description: desc, url: data.secure_url, size: file.size, createdAt: new Date().toISOString() });
    $("media-form").reset();
    statusEl.textContent = "✅ Média ajouté avec succès !";
    statusEl.style.color = "var(--pos)";
    loadMedia();
  } catch (error) {
    statusEl.textContent = "❌ Erreur lors de l'envoi. Vérifie tes clés Cloudinary.";
    statusEl.style.color = "var(--err)";
  }
});
