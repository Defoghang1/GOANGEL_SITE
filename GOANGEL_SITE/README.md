# GOANGEL — Site web + API IA

## Architecture
- **Frontend** : HTML/CSS/JS vanilla, GitHub Pages → https://goangel.dpdns.org
- **API** : FastAPI + Ollama (`phi3:mini`) sur GitHub Actions, tunnel Cloudflare → https://api.goangel.dpdns.org
- **Auth** : Firebase Auth + Firestore (v10.12.2 via CDN)
- **DNS** : Cloudflare, enregistrements GitHub Pages en **DNS only** (nuage gris)

## Structure
- `index.html` / `login.html` / `404.html`
- `css/style.css`
- `js/config.js` (marque, lien, Telegram) · `js/data.js` (textes, packs, FAQ)
- `js/firebase-config.js`, `js/auth.js`, `js/app.js`, `js/login.js` → **`<script type="module">`**
- `js/ai-assistant.js` → appelle `https://api.goangel.dpdns.org/api/chat`
- `backend.py`, `requirements.txt`, `.github/workflows/ai-backend.yml`

## Règles à ne jamais casser
1. `backend.py` : pas de `app.mount("/", StaticFiles(...))` — seulement `/api/health` et `/api/chat`.
2. CORS : origine explicite `https://goangel.dpdns.org`.
3. Ollama : `keep_alive: -1` et `num_predict: 100`.
4. `auth.js`, `app.js`, `login.js` en `type="module"` ; `app.js` fait `await Auth.require()` avant d'afficher.
5. Le frontend appelle l'URL absolue de l'API.

## Checklist Firebase (erreur `auth/configuration-not-found`)
Console Firebase → Authentication → **Sign-in method** : activer *Email/Password* ;
**Settings → Authorized domains** : ajouter `goangel.dpdns.org` ; **Firestore** : créer la base (la règle doit autoriser `users/{uid}` à son propriétaire).

## Checklist DNS (erreur 404)
Cloudflare : les enregistrements A (185.199.108-111.153) et le CNAME `www` vers `TON-PSEUDO.github.io` en **DNS only**. Fichier `CNAME` = `goangel.dpdns.org`. Le sous-domaine `api` est géré par le tunnel Cloudflare.

## Déploiement / test local
`bash deploy.sh "message"` · test : `python3 -m http.server 8000` puis http://localhost:8000
(l'IA répond seulement si le workflow GitHub Actions « GOANGEL AI Backend » est en cours).
