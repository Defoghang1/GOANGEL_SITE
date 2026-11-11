// Page d'inscription / connexion — chargé avec <script type="module">
import { Auth } from "./auth.js";

const init = () => {
  // Interface liée immédiatement ; l'attente Firebase ne sert qu'à la redirection éventuelle
  Auth.ready().then(() => { if (Auth.current()) location.replace("index.html"); });

  const $ = id => document.getElementById(id);
  $("brand").textContent = CONFIG.brand;
  $("minage").textContent = CONFIG.minAge;
  const msg = $("msg"), submit = $("submit");
  submit.disabled = false; // activé seulement quand le script est prêt
  let mode = "register";

  const setMode = m => {
    mode = m; msg.textContent = "";
    $("tab-register").setAttribute("aria-selected", m === "register");
    $("tab-login").setAttribute("aria-selected", m === "login");
    document.querySelectorAll(".only-register").forEach(e => e.hidden = m !== "register");
    submit.textContent = m === "register" ? "Créer mon compte" : "Me connecter";
    $("password").autocomplete = m === "register" ? "new-password" : "current-password";
  };
  $("tab-register").onclick = () => setMode("register");
  $("tab-login").onclick = () => setMode("login");
  setMode("register");

  $("form").addEventListener("submit", async e => {
    e.preventDefault(); msg.textContent = "";
    const d = { name: $("name").value, email: $("email").value, password: $("password").value };
    submit.disabled = true;
    try {
      if (!d.email.includes("@")) throw new Error("Saisissez une adresse e-mail valide.");
      if (mode === "register") {
        if (!d.name.trim()) throw new Error("Saisissez votre nom.");
        if (d.password.length < 8) throw new Error("Le mot de passe doit contenir au moins 8 caractères.");
        if (d.password !== $("password2").value) throw new Error("Les deux mots de passe ne correspondent pas.");
        if (!$("accept").checked) throw new Error("Confirmez que vous êtes majeur et acceptez les conditions.");
        await Auth.register(d);
      } else await Auth.login(d);
      location.href = "index.html";
    } catch (err) { msg.textContent = err.message; submit.disabled = false; }
  });
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
