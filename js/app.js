import { Auth } from "./auth.js";
import { db } from "./firebase-config.js";
import { collection, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let dynamicPacks = null;

const start = async () => {
  const isAuth = await Auth.require();
  if (!isAuth) return;

  try {
    const snapshot = await getDocs(query(collection(db, "packs"), orderBy("name")));
    if (!snapshot.empty) dynamicPacks = snapshot.docs.map(doc => doc.data());
  } catch (e) {}

  document.body.hidden = false;
  const $ = id => document.getElementById(id);
  const user = Auth.current();
  
  $("nav-brand").textContent = CONFIG.brand;
  $("user-name").textContent = user.displayName || (user.email || "").split("@")[0];
  $("logout").onclick = () => Auth.logout();

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

  const pages = {
    home: () => `<section class="hero"><div class="monogram">GA</div><h1>${SITE_DATA.hero.title}</h1><p>${SITE_DATA.hero.subtitle}</p><div class="actions"><a href="${CONFIG.telegram}" target="_blank" class="btn">${SITE_DATA.hero.cta}</a></div></section>`,
    pricing: () => {
      let finalPacks = [...SITE_DATA.packs];
      if (dynamicPacks) {
        dynamicPacks.forEach(dp => {
          const idx = finalPacks.findIndex(p => p.name.toLowerCase() === dp.name.toLowerCase());
          if (idx !== -1) finalPacks[idx] = dp; else finalPacks.push(dp);
        });
      }
      return `<section class="block"><h2>Choisissez votre pack</h2>
        <div class="grid">${finalPacks.map(p => `
          <article class="card price">
            <h3>${p.name}</h3>
            <div class="amount">${p.price} <small>USDT / TRX</small></div>
            <ul>${p.features.map(f => `<li>${f}</li>`).join("")}</ul>
            <button class="btn buy-btn" data-name="${p.name}" data-price="${p.price}">Acheter</button>
            <a class="btn ghost download-btn" id="dl-${p.name}" style="display:none; margin-top:10px; background:var(--gold); color:#111;" target="_blank">Télécharger le ZIP</a>
          </article>`).join("")}</div></section>`;
    },
    faq: () => `<section class="block"><h2>FAQ</h2>${SITE_DATA.faq.map(i => `<details><summary>${i.q}</summary><p>${i.a}</p></details>`).join("")}</section>`
  };

  const router = () => {
    const key = location.hash.slice(1) || "home";
    $("app").innerHTML = pages[key] ? pages[key]() : pages.home();
    
    if (key === "pricing") {
      document.querySelectorAll(".buy-btn").forEach(btn => {
        btn.onclick = () => initiatePayment(btn.dataset.name, btn.dataset.price);
      });
    }
  };

  const initiatePayment = async (packName, price) => {
    try {
      const res = await fetch("https://api.goangel.dpdns.org/api/create-payment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack_name: packName, price_usd: Number(price.toString().replace(/\s/g, "")) })
      });
      const data = await res.json();
      
      const modal = document.createElement("div");
      modal.className = "modal";
      modal.innerHTML = `
        <div class="modal-content">
          <button class="modal-close" onclick="this.parentElement.parentElement.remove()">×</button>
          <h2 style="color:var(--gold)">Paiement Crypto</h2>
          <p style="margin:1rem 0">Envoyez exactement <b>${data.amount} ${data.currency.toUpperCase()}</b> à cette adresse :</p>
          <code style="display:block; background:#000; padding:1rem; word-break:break-all; border:1px solid var(--gold); margin-bottom:1rem;">${data.pay_address}</code>
          <p id="pay-status" style="color:var(--muted)">En attente de la blockchain...</p>
        </div>
      `;
      document.body.appendChild(modal);
      
      const interval = setInterval(async () => {
        const chk = await fetch(`https://api.goangel.dpdns.org/api/check-payment/${data.payment_id}`);
        const statusData = await chk.json();
        if (statusData.status === "paid") {
          clearInterval(interval);
          modal.querySelector("#pay-status").textContent = "✅ Paiement validé !";
          modal.querySelector("#pay-status").style.color = "var(--pos)";
          
          const dlBtn = document.getElementById(`dl-${packName}`);
          if (dlBtn) {
            dlBtn.style.display = "inline-block";
            dlBtn.onclick = async (e) => {
              e.preventDefault();
              const dlRes = await fetch(`https://api.goangel.dpdns.org/api/download/${data.payment_id}`);
              const dlData = await dlRes.json();
              if (dlData.download_url) window.location.href = dlData.download_url;
              else alert("Erreur de téléchargement");
            };
          }
        }
      }, 10000);
      
      modal.querySelector(".modal-close").onclick = () => { clearInterval(interval); modal.remove(); };
      
    } catch (e) { alert("Erreur lors de la création du paiement."); }
  };

  addEventListener("hashchange", router);
  router();
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
