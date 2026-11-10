// 🔐 Authentification Firebase (Email/Password) — chargé avec <script type="module">
import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const ERRORS = {
  "auth/email-already-in-use": "Un compte existe déjà avec cet e-mail. Connectez-vous.",
  "auth/invalid-credential": "E-mail ou mot de passe incorrect.",
  "auth/wrong-password": "E-mail ou mot de passe incorrect.",
  "auth/user-not-found": "E-mail ou mot de passe incorrect.",
  "auth/invalid-email": "Adresse e-mail invalide.",
  "auth/weak-password": "Mot de passe trop faible (8 caractères minimum).",
  "auth/too-many-requests": "Trop de tentatives. Réessayez dans quelques minutes.",
  "auth/network-request-failed": "Problème de connexion réseau. Vérifiez votre internet.",
  "auth/configuration-not-found": "Configuration Firebase incomplète : activez « Email/Password » dans Authentication > Sign-in method.",
  "auth/operation-not-allowed": "Connexion Email/Password désactivée dans la console Firebase.",
  "auth/unauthorized-domain": "Domaine non autorisé : ajoutez goangel.dpdns.org dans Authentication > Settings > Authorized domains."
};
const friendly = e => new Error(ERRORS[e && e.code] || (e && e.message) || "Erreur inconnue.");

// Résolu dès que Firebase a restauré (ou non) la session — évite la page blanche / les redirections à tort
let _unsub, _done = false;
const _ready = new Promise(resolve => {
  _unsub = onAuthStateChanged(auth, () => {
    if (_done) return;
    _done = true; resolve();
    if (_unsub) _unsub();
  });
});

export const Auth = {
  ready: () => _ready,
  current: () => auth.currentUser,
  token: () => auth.currentUser ? auth.currentUser.getIdToken() : Promise.reject(new Error("Non connecté")),
  async register({ name, email, password }) {
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
      await updateProfile(cred.user, { displayName: name.trim() });
      // Profil dans Firestore : non bloquant (ne doit jamais empêcher l'inscription)
      try {
        await setDoc(doc(db, "users", cred.user.uid), {
          name: name.trim(), email: cred.user.email, created: serverTimestamp()
        });
      } catch (e) { console.warn("Firestore (profil) :", e.code || e.message); }
    } catch (e) { throw friendly(e); }
  },
  async login({ email, password }) {
    try { await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password); }
    catch (e) { throw friendly(e); }
  },
  async logout() {
    try { await signOut(auth); } finally { location.href = "login.html"; }
  },
  // À appeler avec await : attend Firebase, redirige vers login si non connecté
  async require() {
    await _ready;
    if (!auth.currentUser) { location.replace("login.html"); return false; }
    return true;
  }
};
window.Auth = Auth;
