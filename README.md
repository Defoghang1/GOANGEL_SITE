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
- **Synchronisation Drive 100 % automatique, côté serveur.** Dès le démarrage, le backend vérifie le dossier `gdrive:goangel_packs` **toutes les 2 secondes** (`DRIVE_POLL_SECONDS`, défaut 2) : nouveau ZIP, nouvelle version, ZIP supprimé → le catalogue est mis à jour seul, sans aucune action de l'administrateur. Optimisations : un seul démon `rclone rcd` local persistant (aucun processus lancé à chaque vérification ; repli automatique sur `rclone lsjson`), **liste seulement** (aucun ZIP téléchargé), reconstruction du catalogue uniquement si la liste a changé (signature), aucune relecture périodique de Firestore (fiches produit reçues en temps réel via `on_snapshot`), recul automatique si Google limite les requêtes, tolérance de 30 s aux micro-coupures (les achats, eux, revérifient toujours), redémarrage automatique de la surveillance si elle se bloque. Elle tourne dans ses propres threads : paiements, commandes et téléchargements ne l'attendent jamais.
- **Côté navigateur** : sur la page Tarifs, le site interroge toutes les 3 s `GET /api/catalog-version` (≈ 90 octets) et ne recharge le catalogue complet que si la version a changé : un ZIP déposé sur Drive apparaît en quelques secondes, sans recharger la page. `GET /api/catalog` est réservé aux connectés et ne contient aucun secret.
- **Suivi** : `admin.html` → « Catalogue & stock » affiche en direct « Drive vérifié il y a X s » ; `/api/health` expose `catalog.checked_at`, `poll_seconds` et `watcher_fails`. Variables facultatives : `DRIVE_POLL_SECONDS`, `DRIVE_USE_RCD=0` (désactive le démon).
- ⚠️ La vérification est exécutée toutes les 2 s mais Google Drive peut mettre quelques secondes à rendre un fichier visible dans ses listes. Avec le *client_id* partagé de rclone, les quotas Google sont communs à tous ses utilisateurs : créez votre propre client OAuth si vous voyez des erreurs de quota.
- **Infos commerciales** : `catalog.json` (nom, prix USDT, description, version, fonctionnalités, prérequis…) et/ou `admin.html` (collection Firestore `packs`, prioritaire pour le même nom). Un produit sans ZIP sur Drive passe seul en **Indisponible** (message d'épuisement, achat impossible). Il suffit de déposer le ZIP pour qu'il redevienne disponible, sans toucher au HTML.
- **Versions** : `<id>.zip` (compte comme la version déclarée au catalogue) ou `<id>-vX.Y.Z.zip`. La version vendue est la plus haute (comparaison numérique : 1.10 > 1.2) ; égalité = fichier versionné ; `pinned_version` force une version. Les anciennes versions restent sur Drive. Chaque commande enregistre le fichier et la version achetés : le client reçoit toujours exactement ce qu'il a payé, même si une version plus récente arrive ensuite.
- **Revérification** : Drive est consulté de nouveau juste avant la création du paiement et juste avant la livraison. Si Drive est injoignable, l'état est « vérification en cours » (jamais « épuisé » à tort) et aucun paiement n'est créé.
- **Code promo** : pilotable depuis `admin.html` → « Code promo & bandeau » (activer/désactiver, code, %, pack concerné ou tous, message, date de fin, bandeau affiché ou code privé) ; effet en quelques secondes, sans redéploiement. Réglages enregistrés dans Firestore `settings/promo` (prioritaires) ; à défaut, le bloc `promo` de `catalog.json` sert de valeur par défaut. **La réduction est liée au compte** : quand un client applique le code, `POST /api/promo/apply` l'enregistre pour son compte seulement (collection serveur `promo_redemptions`) ; le catalogue renvoie `my_promo` pour lui seul, les prix publics ne changent jamais, et rien n'est mémorisé dans le navigateur. Changer ou désactiver l'offre annule aussi les réductions déjà appliquées. Plafond de sécurité : 90 %. Le prix payé est toujours recalculé côté serveur.
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
