import { auth, db, storage } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, doc, getDocs, addDoc, updateDoc, deleteDoc, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref, uploadBytes, deleteObject, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const $ = id => document.getElementById(id);
const packsCol = collection(db, "packs");
const mediaCol = collection(db, "media");

function showDenied() {
  $("admin-denied").classList.remove("hidden");
  $("admin-content").classList.add("hidden");
}

function showContent() {
  $("admin-content").classList.remove("hidden");
  $("admin-denied").classList.add("hidden");
  loadPacks();
  loadMedia();
}

async function loadPacks() {
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
}

async function loadMedia() {
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
        <button class="btn small btn-danger delete-media" data-id="${docSnap.id}" data-path="${data.path}">Supprimer</button>
      </div>
    `;
    list.appendChild(li);
  });
  list.querySelectorAll(".delete-media").forEach(btn => {
    btn.addEventListener("click", () => deleteMedia(btn.dataset.id, btn.dataset.path));
  });
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

async function deleteMedia(id, path) {
  if (!confirm("Supprimer ce média ?")) return;
  await deleteDoc(doc(mediaCol, id));
  const storageRef = ref(storage, path);
  await deleteObject(storageRef).catch(() => {});
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
  const path = `media/${Date.now()}_${file.name}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  const url = await getDownloadURL(storageRef);
  await addDoc(mediaCol, { type, description: desc, url, path, size: file.size, createdAt: new Date().toISOString() });
  $("media-form").reset();
  loadMedia();
});

onAuthStateChanged(auth, (user) => {
  if (!user) {
    location.replace("login.html");
    return;
  }
  user.getIdTokenResult().then((idTokenResult) => {
    if (idTokenResult.claims.admin === true) {
      showContent();
    } else {
      showDenied();
    }
  }).catch(() => showDenied());
});
