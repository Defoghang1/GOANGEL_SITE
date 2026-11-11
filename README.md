# GOANGEL — Site web + API IA + paiement crypto + packs sur Google Drive

## Architecture
- **Frontend** : HTML/CSS/JS vanilla, GitHub Pages → https://goangel.dpdns.org
- **API** : FastAPI + Ollama (`phi3:mini`) sur GitHub Actions, tunnel Cloudflare → https://api.goangel.dpdns.org
- **Auth / commandes** : Firebase Auth + Firestore (v10.12.2 via CDN) — le backend vérifie le jeton Firebase de chaque achat
- **Paiement** : NOWPayments (USDT TRC-20)
- **Packs ZIP** : Google Drive via rclone (remote `gdrive`, dossier `gdrive:goangel_packs`) — plus de Backblaze, Boto3 ni S3
- **DNS** : Cloudflare, enregistrements GitHub Pages en **DNS only** (nuage gris)

## Secrets GitHub (Settings → Secrets and variables → Actions)
| Secret | Contenu |
|---|---|
| `FIREBASE_CREDENTIALS` | JSON du compte de service Firebase **encodé en Base64** |
| `CRYPTO_API_KEY` | Clé API NOWPayments |
| `RCLONE_CONFIG` | Fichier `rclone.conf` (avec le remote `[gdrive]`) **encodé en Base64** |
| `CLOUDFLARE_TUNNEL_TOKEN` | Jeton du tunnel Cloudflare |

Anciens secrets `B2_*` : à supprimer, ils ne sont plus utilisés.
Vérification : `https://api.goangel.dpdns.org/api/health` doit afficher `firebase`, `storage` (Google Drive) et `nowpayments_key` à `true`.

## Créer le secret RCLONE_CONFIG (une seule fois)
1. Sur un ordinateur : `rclone config` → *New remote* → nom **gdrive** → type **drive** → scope **drive** (accès complet) ; sans navigateur sur la machine, utilisez `rclone authorize "drive"` ailleurs et collez le jeton.
2. `base64 -w0 ~/.config/rclone/rclone.conf` → copiez la sortie dans le secret `RCLONE_CONFIG`.
3. ⚠️ Avec votre propre *client_id* Google, publiez l'écran de consentement OAuth en **Production** : en mode « Test », le jeton expire après 7 jours et les téléchargements s'arrêtent.

## Envoyer les packs sur Google Drive
Placez les ZIP dans `./packs` : `starter.zip`, `pro.zip`, `elite.zip` ou avec version `pro-v1.2.0.zip` (nom du produit en minuscules, espaces → tirets).
Actions → **Upload Packs to Google Drive** → *Run workflow*.
⚠️ Les fichiers d'un dépôt servi par GitHub Pages sont **publics**. Gardez `packs/` sur une branche qui n'est pas celle de Pages (ex. `packs-storage`) ou dans un dépôt privé, et indiquez-la dans le champ `source_ref` du workflow ; ne la fusionnez jamais dans la branche publiée.

## Téléchargement sécurisé
`POST /api/download-token/{id}` (connecté, commande payée) → lien signé valable 2 min → `GET /api/download/{id}?token=…` : le serveur récupère le ZIP sur Drive (rclone), le renvoie en `FileResponse` puis supprime le fichier temporaire. 3 téléchargements simultanés maximum, dossier temporaire distinct par téléchargement.

## Boutique : catalogue, stock, versions, promo
- **Source de vérité de la disponibilité : Google Drive.** Au démarrage puis toutes les 5 minutes (`CATALOG_REFRESH_SECONDS`), le backend liste les ZIP présents (un seul appel `rclone lsjson`, aucun téléchargement) et reconstruit le catalogue. Le navigateur lit `GET /api/catalog` (connecté uniquement) : aucun secret ni accès Drive côté client.
- **Infos commerciales** : `catalog.json` (nom, prix USDT, description, version, fonctionnalités, prérequis…) et/ou `admin.html` (collection Firestore `packs`, prioritaire pour le même nom). Un produit sans ZIP sur Drive passe seul en **Indisponible** (message d'épuisement, achat impossible). Il suffit de déposer le ZIP pour qu'il redevienne disponible, sans toucher au HTML.
- **Versions** : `<id>.zip` (compte comme la version déclarée au catalogue) ou `<id>-vX.Y.Z.zip`. La version vendue est la plus haute (comparaison numérique : 1.10 > 1.2) ; égalité = fichier versionné ; `pinned_version` force une version. Les anciennes versions restent sur Drive. Chaque commande enregistre le fichier et la version achetés : le client reçoit toujours exactement ce qu'il a payé, même si une version plus récente arrive ensuite.
- **Revérification** : Drive est consulté de nouveau juste avant la création du paiement et juste avant la livraison. Si Drive est injoignable, l'état est « vérification en cours » (jamais « épuisé » à tort) et aucun paiement n'est créé.
- **Code promo** : bloc `promo` de `catalog.json` (`"enabled": false` pour désactiver le bandeau ET le code ; `"expires"` pour une date de fin). Le bandeau n'apparaît que si le serveur confirme que l'offre est active ; la remise est calculée côté serveur.
- **Track record et témoignages** : saisis dans `admin.html` (collections Firestore `track_record` et `testimonials`). Sans donnée réelle, le site l'indique honnêtement ; rien n'est inventé.
- **Indicateur IA** : la pastille reflète la réponse réelle de `/api/health` (« IA connectée » / « IA hors ligne »).
- **Admin** : `admin.html` → « Catalogue & stock » (état, versions, fichiers non référencés, bouton « Synchroniser maintenant »).

## Règles à ne jamais casser
1. `backend.py` : pas de `app.mount("/", StaticFiles(...))`.
2. CORS : origine explicite `https://goangel.dpdns.org`.
3. Ollama : `keep_alive: -1` et `num_predict: 100`.
4. `auth.js`, `app.js`, `login.js` en `type="module"` ; `app.js` fait `await Auth.require()` avant d'afficher.
5. Le frontend appelle l'URL absolue de l'API.
6. Les prix sont décidés par le serveur : le navigateur n'envoie que le nom du pack.
7. `RCLONE_CONFIG` contient du Base64 : ne jamais l'exporter dans l'environnement de la commande `rclone` (qui y lit un chemin de fichier). Le backend le décode lui-même.

## Simulateur
Démonstration en USDT : capital 1 000, mise minimale 5 (paliers de 10), réinitialisation sous 30 USDT. Résultats fictifs.

## Compte admin
`ADMIN_EMAIL=... ADMIN_PASSWORD=... node tools/create-admin.js` (avec `serviceAccountKey.json` à la racine, jamais publié).

## Checklists
- Firebase (`auth/configuration-not-found`) : activer *Email/Password*, autoriser `goangel.dpdns.org`, créer Firestore, publier `firestore.rules`.
- DNS (erreur 404) : A (185.199.108-111.153) et CNAME `www` en **DNS only** ; fichier `CNAME` = `goangel.dpdns.org`.

## Hébergement : limite à connaître
GitHub Actions n'est pas un hébergeur permanent : le job dure 5 h 58 max puis se relance seul (relance + watchdog toutes les 20 min). Une courte coupure est possible entre deux cycles ; le workflow redémarre FastAPI ou le tunnel s'ils tombent pendant l'exécution.
