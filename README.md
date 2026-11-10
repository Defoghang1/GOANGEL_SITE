# GOANGEL — Site web + API IA + paiement crypto

## Architecture
- **Frontend** : HTML/CSS/JS vanilla, GitHub Pages → https://goangel.dpdns.org
- **API** : FastAPI + Ollama (`phi3:mini`) sur GitHub Actions, tunnel Cloudflare → https://api.goangel.dpdns.org
- **Auth** : Firebase Auth + Firestore (v10.12.2 via CDN) — le backend vérifie le jeton Firebase de chaque achat
- **Paiement** : NOWPayments (USDT TRC-20) ; **fichiers** : Backblaze B2 (`packs/<nom>.zip`, lien signé 5 min)
- **DNS** : Cloudflare, enregistrements GitHub Pages en **DNS only** (nuage gris)

## Secrets GitHub obligatoires (Settings → Secrets and variables → Actions)
`CLOUDFLARE_TUNNEL_TOKEN`, `FIREBASE_CREDENTIALS` (JSON du compte de service encodé en base64), `CRYPTO_API_KEY` (clé NOWPayments),
`B2_ACCESS_KEY_ID`, `B2_SECRET_ACCESS_KEY`, `B2_BUCKET_NAME`, `B2_ENDPOINT_URL`, `B2_REGION`.
Ils sont transmis au backend dans l'étape « Start FastAPI Backend » du workflow. Vérification : `https://api.goangel.dpdns.org/api/health`
doit afficher `firebase`, `storage` et `nowpayments_key` à `true`.

## Règles à ne jamais casser
1. `backend.py` : pas de `app.mount("/", StaticFiles(...))`.
2. CORS : origine explicite `https://goangel.dpdns.org`.
3. Ollama : `keep_alive: -1` et `num_predict: 100`.
4. `auth.js`, `app.js`, `login.js` en `type="module"` ; `app.js` fait `await Auth.require()` avant d'afficher.
5. Le frontend appelle l'URL absolue de l'API.
6. Les prix sont décidés par le serveur (Firestore `packs` ou prix par défaut) : le navigateur n'envoie que le nom du pack.

## Packs et prix (USDT)
Par défaut : Starter 40, Pro 120, Elite 250. L'admin peut les modifier dans `admin.html` (prix en USDT, max 5000).
Chaque pack doit avoir son fichier `packs/<nom-en-minuscules>.zip` dans le bucket B2.

## Compte admin
`ADMIN_EMAIL=... ADMIN_PASSWORD=... node tools/create-admin.js` (avec `serviceAccountKey.json` à la racine, jamais publié).
L'admin publie images, vidéos, audios, documents et textes depuis `admin.html` ; tous les utilisateurs les voient dans l'onglet « Médias ».

## Checklist Firebase (erreur `auth/configuration-not-found`)
Authentication → **Sign-in method** : activer *Email/Password* ; **Authorized domains** : `goangel.dpdns.org` ; **Firestore** : créer la base et publier `firestore.rules`.

## Checklist DNS (erreur 404)
Cloudflare : enregistrements A (185.199.108-111.153) et CNAME `www` vers `TON-PSEUDO.github.io` en **DNS only**. Fichier `CNAME` = `goangel.dpdns.org`. Le sous-domaine `api` est géré par le tunnel.

## Déploiement
`bash deploy.sh "message"` · l'IA et les paiements ne répondent que si le workflow « GOANGEL AI Backend » est en cours (le watchdog le relance).
