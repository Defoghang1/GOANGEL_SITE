import { Auth } from "./auth.js";
import { auth, db } from "./firebase-config.js";
import { collection, getDocs, query, orderBy, doc, updateDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let dynamicPacks = null;
let cart = JSON.parse(localStorage.getItem('goangel_cart')) || [];

const start = async () => {
  const isAuth = await Auth.require();
  if (!isAuth) return;

  try {
    const packsRef = collection(db, "packs");
    const q = query(packsRef, orderBy("name"));
    const snapshot = await getDocs(q);
    if (!snapshot.empty) {
      dynamicPacks = snapshot.docs.map(doc => doc.data());
    }
  } catch (e) {
    console.warn("Impossible de charger les packs Firestore", e);
  }

  document.body.hidden = false;

  const $ = id => document.getElementById(id);
  const user = Auth.current();
  
  $("nav-brand").textContent = CONFIG.brand;
  $("footer-brand").textContent = CONFIG.brand;
  $("year").textContent = new Date().getFullYear();
  $("nav-cta").href = CONFIG.telegram;
  $("user-name").textContent = user.displayName || (user.email || "").split("@")[0];
  $("logout").onclick = () => Auth.logout();

  // Gestion Avatar
  const avatarImg = $("nav-avatar");
  const userDocRef = doc(db, "users", user.uid);
  const userDoc = await getDoc(userDocRef);
  if (userDoc.exists() && userDoc.data().photoURL) {
    avatarImg.src = userDoc.data().photoURL;
    avatarImg.style.display = "block";
  } else {
    avatarImg.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(user.email)}&background=d4af37&color=000`;
    avatarImg.style.display = "block";
  }

  avatarImg.onclick = () => $("profile-modal").classList.remove("hidden");

  $("profile-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $("profile-status").textContent = "Téléversement en cours...";
    
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", "goangel_unsigned");

    try {
      const res = await fetch("https://api.cloudinary.com/v1_1/gkiui3xc/auto/upload", { method: "POST", body: formData });
      const data = await res.json();
      await updateDoc(userDocRef, { photoURL: data.secure_url });
      avatarImg.src = data.secure_url;
      $("profile-status").textContent = "✅ Photo mise à jour !";
      setTimeout(() => $("profile-modal").classList.add("hidden"), 1500);
    } catch (err) {
      $("profile-status").textContent = "❌ Erreur de téléversement.";
    }
  });

  // Gestion Panier
  const updateCartUI = () => {
    $("cart-count").textContent = cart.length;
    const container = $("cart-items");
    container.innerHTML = "";
    let total = 0;
    cart.forEach((item, index) => {
      total += Number(item.price);
      container.innerHTML += `
        <div class="cart-item">
          <span>${item.name}</span>
          <span>${item.price} FCFA <button class="link" data-index="${index}" style="color:var(--err);">✕</button></span>
        </div>`;
    });
    $("cart-total").textContent = total + " FCFA";
    container.querySelectorAll("button").forEach(btn => {
      btn.onclick = () => { cart.splice(btn.dataset.index, 1); localStorage.setItem('goangel_cart', JSON.stringify(cart)); updateCartUI(); };
    });
  };

  $("cart-btn").onclick = () => { updateCartUI(); $("cart-modal").classList.remove("hidden"); };

  $("checkout-btn").onclick = () => {
    if (cart.length === 0) return alert("Votre panier est vide.");
    const itemsText = cart.map(i => i.name).join(", ");
    window.open(`${CONFIG.telegram}?text=Bonjour, je souhaite commander : ${itemsText}`, "_blank");
  };

  updateCartUI();

  // Nav Admin
  user.getIdTokenResult().then((idTokenResult) => {
    if (idTokenResult.claims.admin === true) {
      const adminLink = document.createElement("a");
      adminLink.href = "admin.html";
      adminLink.textContent = "Admin";
      adminLink.className = "btn small";
      adminLink.style.marginLeft = "1rem";
      document.querySelector(".user").prepend(adminLink);
    }
  });

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
      </section>`,
    simulator: () => `<section class="block"><h2>Simulateur GOANGEL</h2><div id="sim"></div></section>`,
    features: () => `<section class="block"><h2>Pourquoi GOANGEL</h2>
      <div class="grid">${D.features.map(f => `<article class="card"><div class="ico">${f.icon}</div><h3>${f.title}</h3><p>${f.desc}</p></article>`).join("")}</div></section>`,
    pricing: () => {
      let finalPacks = [...D.packs];
      if (dynamicPacks && dynamicPacks.length > 0) {
        dynamicPacks.forEach(dp => {
          const existingIndex = finalPacks.findIndex(p => p.name.toLowerCase() === dp.name.toLowerCase());
          if (existingIndex !== -1) finalPacks[existingIndex] = dp;
          else finalPacks.push(dp);
        });
      }
      return `<section class="block"><h2>Choisissez votre pack</h2>
        <div class="grid">${finalPacks.map(p => `
          <article class="card price ${p.featured ? "featured" : ""}">
            ${p.featured ? '<span class="badge">Recommandé</span>' : ""}
            <h3>${p.name}</h3>
            <div class="amount">${p.price} <small>${CONFIG.currency}</small></div>
            <ul>${p.features.map(f => `<li>${f}</li>`).join("")}</ul>
            <button class="btn add-to-cart" data-name="${p.name}" data-price="${p.price}">Ajouter au panier</button>
          </article>`).join("")}</div></section>`
    },
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
    
    // Attacher les événements du panier
    document.querySelectorAll(".add-to-cart").forEach(btn => {
      btn.onclick = () => {
        cart.push({ name: btn.dataset.name, price: btn.dataset.price });
        localStorage.setItem('goangel_cart', JSON.stringify(cart));
        updateCartUI();
        alert("Pack ajouté au panier !");
      };
    });
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
