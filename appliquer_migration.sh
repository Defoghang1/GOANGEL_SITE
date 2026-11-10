#!/bin/bash
# Applique la migration GOANGEL (Google Drive + rclone, simulateur USDT). À lancer à la racine du projet : bash appliquer_migration.sh
set -e
[ -f index.html ] && [ -d js ] || { echo "❌ Lancez ce script à la racine du projet (là où se trouve index.html)."; exit 1; }
BK=".backup_avant_migration"; mkdir -p "$BK"
for f in "backend.py" "requirements.txt" ".github/workflows/ai-backend.yml" ".github/workflows/upload-packs.yml" "js/simulator.js" "js/config.js" "js/app.js" "index.html" "admin.html" "README.md"; do [ -f "$f" ] && cp --parents "$f" "$BK/" || true; done
echo "💾 Sauvegarde des anciens fichiers dans $BK/"
mkdir -p .github/workflows js

cat > backend.py << 'EOF'
import os
import re
import json
import time
import glob
import base64
import hmac
import hashlib
import secrets
import shutil
import tempfile
import threading
import subprocess
from collections import defaultdict, deque
from typing import Optional

import requests
import firebase_admin
from firebase_admin import credentials, firestore, auth as fb_auth
from fastapi import FastAPI, HTTPException, Header, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field

# ⚠️ Ne JAMAIS ajouter app.mount("/", StaticFiles(...)) : l'API ne sert que des routes /api/*.
app = FastAPI(title="GOANGEL Server", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://goangel.dpdns.org", "https://www.goangel.dpdns.org"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

def _decode_secret(raw: str) -> bytes:
    """Décode un secret Base64 (espaces/retours à la ligne et '=' manquants tolérés).
    Un contenu déjà en clair (JSON ou fichier rclone) est accepté tel quel."""
    raw = raw.strip()
    if raw.startswith(("{", "[")):
        return raw.encode("utf-8")
    compact = "".join(raw.split())
    compact += "=" * (-len(compact) % 4)
    try:
        return base64.b64decode(compact, validate=True)
    except Exception:
        return base64.urlsafe_b64decode(compact)


# --- FIREBASE (Firestore + vérification des jetons) ---
def init_firebase():
    raw = os.environ.get("FIREBASE_CREDENTIALS")
    if not raw:
        print("⚠️ FIREBASE_CREDENTIALS absent.")
        return None
    try:
        info = json.loads(_decode_secret(raw))
        missing = [k for k in ("project_id", "private_key", "client_email") if not info.get(k)]
        if missing:
            print(f"❌ FIREBASE_CREDENTIALS : champs manquants {missing}")
            return None
        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.Certificate(info))
        return firestore.client()
    except Exception as e:  # on ne journalise jamais le contenu du secret
        print(f"❌ FIREBASE_CREDENTIALS invalide ({type(e).__name__}) : Base64 d'un fichier JSON de compte de service attendu.")
        return None


db = init_firebase()

# --- GOOGLE DRIVE via rclone (remote « gdrive », dossier goangel_packs) ---
RCLONE_REMOTE = "gdrive:goangel_packs"
RCLONE_CONF_PATH = None


def init_rclone():
    if not shutil.which("rclone"):
        print("⚠️ rclone introuvable dans le PATH.")
        return None
    raw = os.environ.get("RCLONE_CONFIG")
    if not raw:
        print("⚠️ RCLONE_CONFIG absent.")
        return None
    try:
        conf = _decode_secret(raw).decode("utf-8")
        if "[gdrive]" not in conf:
            print("❌ RCLONE_CONFIG : section [gdrive] absente.")
            return None
        folder = tempfile.mkdtemp(prefix="goangel_rclone_")
        path = os.path.join(folder, "rclone.conf")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(conf)
        return path
    except Exception as e:
        print(f"❌ RCLONE_CONFIG invalide ({type(e).__name__}).")
        return None


RCLONE_CONF_PATH = init_rclone()

# --- NOWPAYMENTS ---
NOWPAYMENTS_API_KEY = os.environ.get("CRYPTO_API_KEY")
NOWPAYMENTS_URL = "https://api.nowpayments.io/v1"
print(f"🔑 NOWPayments: {bool(NOWPAYMENTS_API_KEY)} | Firebase: {db is not None} | Google Drive (rclone): {RCLONE_CONF_PATH is not None}")

# --- PRIX CÔTÉ SERVEUR (USDT) : jamais pris dans la requête du navigateur ---
DEFAULT_PRICES = {"starter": 40.0, "pro": 120.0, "elite": 250.0}
MAX_PRICE_USD = 5000.0

# --- OLLAMA ---
OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL_NAME = "phi3:mini"
SYSTEM_PROMPT = (
    "Tu es l'assistant commercial de GOANGEL AI ENGINE, expert en analyse de données footballistiques. "
    "Les packs sont : Starter (40 USDT), Pro (120 USDT), Elite (250 USDT), payables en USDT ou TRX sur le réseau Tron. "
    "GOANGEL est un outil d'analyse statistique : tu ne promets jamais de gains. "
    "Réponds de manière professionnelle et brève, en français."
)


class ChatRequest(BaseModel):
    message: str = Field(..., max_length=500)


class ChatResponse(BaseModel):
    response: str


class PaymentRequest(BaseModel):
    pack_name: str = Field(..., min_length=1, max_length=60)


# ---------- Utilitaires (testables) ----------
def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-")


def map_status(raw: str) -> str:
    if raw in ("confirmed", "finished"):
        return "paid"
    if raw in ("failed", "refunded"):
        return "failed"
    if raw == "expired":
        return "expired"
    if raw == "partially_paid":
        return "partial"
    return "waiting"


def resolve_pack(pack_name: str):
    """Retourne (nom_canonique, prix_usd) ou None. Firestore (admin) prioritaire, sinon prix par défaut."""
    key = pack_name.strip().lower()
    if db is not None:
        try:
            for d in db.collection("packs").stream():
                data = d.to_dict() or {}
                if str(data.get("name", "")).strip().lower() == key:
                    price = float(data.get("price", 0))
                    if 0 < price <= MAX_PRICE_USD:
                        return str(data["name"]).strip(), price
                    print(f"⚠️ Prix Firestore invalide pour {key} ({price}) : prix par défaut utilisé.")
        except Exception as e:
            print(f"⚠️ Lecture des packs Firestore impossible : {e}")
    if key in DEFAULT_PRICES:
        return key.capitalize(), DEFAULT_PRICES[key]
    return None


def current_uid(authorization: Optional[str]) -> str:
    if db is None:
        raise HTTPException(status_code=503, detail="Base de données non configurée côté serveur (secret FIREBASE_CREDENTIALS).")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Connexion requise.")
    try:
        return fb_auth.verify_id_token(authorization[7:])["uid"]
    except Exception:
        raise HTTPException(status_code=401, detail="Session invalide, reconnectez-vous.")


PAYMENT_ID_RE = re.compile(r"^[0-9A-Za-z_-]{1,64}$")
SAFE_PACK_FILE = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}\.zip$")


def check_payment_id(payment_id: str) -> str:
    if not PAYMENT_ID_RE.match(str(payment_id)):
        raise HTTPException(status_code=400, detail="Identifiant de commande invalide.")
    return str(payment_id)


def get_order(payment_id: str, uid: str) -> dict:
    check_payment_id(payment_id)
    snap = db.collection("orders").document(str(payment_id)).get()
    order = snap.to_dict() if snap.exists else None
    if not order or order.get("uid") != uid:
        raise HTTPException(status_code=404, detail="Commande introuvable.")
    return order


# ---------- Limiteur simple pour le chat (par IP) ----------
_hits = defaultdict(deque)


def rate_limited(ip: str, limit: int = 12, window: int = 60) -> bool:
    now = time.time()
    q = _hits[ip]
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= limit:
        return True
    q.append(now)
    return False


# ---------- Routes ----------
@app.get("/api/health")
def health_check():
    return {
        "status": "ok", "model": MODEL_NAME,
        "firebase": db is not None, "storage": RCLONE_CONF_PATH is not None,
        "nowpayments_key": bool(NOWPAYMENTS_API_KEY),
    }


@app.post("/api/chat", response_model=ChatResponse)
def chat(request: ChatRequest, http: Request):
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message vide.")
    ip = http.headers.get("cf-connecting-ip") or (http.client.host if http.client else "?")
    if rate_limited(ip):
        raise HTTPException(status_code=429, detail="Trop de messages, patientez une minute.")
    payload = {
        "model": MODEL_NAME,
        "prompt": f"{SYSTEM_PROMPT}\nClient: {request.message.strip()}\nAssistant:",
        "stream": False, "keep_alive": -1,
        "options": {"temperature": 0.6, "num_predict": 100, "num_ctx": 1024},
    }
    try:
        r = requests.post(OLLAMA_URL, json=payload, timeout=60)
        r.raise_for_status()
        return ChatResponse(response=r.json().get("response", "").strip() or "Désolé, je n'ai pas pu générer de réponse.")
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="L'IA met trop de temps à répondre.")
    except Exception:
        raise HTTPException(status_code=500, detail="Erreur IA.")


@app.post("/api/create-payment")
def create_payment(req: PaymentRequest, authorization: Optional[str] = Header(None)):
    uid = current_uid(authorization)
    if not NOWPAYMENTS_API_KEY:
        print("❌ CRYPTO_API_KEY manquante (secret GitHub non transmis au backend ?).")
        raise HTTPException(status_code=503, detail="Paiement crypto non configuré côté serveur (secret CRYPTO_API_KEY).")

    pack = resolve_pack(req.pack_name)
    if not pack:
        raise HTTPException(status_code=404, detail="Pack inconnu.")
    pack_name, price = pack

    payload = {
        "price_amount": round(price, 2),
        "price_currency": "usd",
        "pay_currency": "usdttrc20",
        "order_id": f"GOANGEL_{int(time.time())}_{slug(pack_name)}",
        "order_description": f"Achat du pack {pack_name}",
    }
    headers = {"x-api-key": NOWPAYMENTS_API_KEY, "Content-Type": "application/json"}
    try:
        res = requests.post(f"{NOWPAYMENTS_URL}/payment", json=payload, headers=headers, timeout=30)
    except requests.exceptions.RequestException as e:
        print(f"❌ NOWPayments injoignable : {e}")
        raise HTTPException(status_code=502, detail="Service de paiement injoignable, réessayez.")

    if res.status_code >= 400:
        print(f"❌ NOWPayments {res.status_code} : {res.text[:300]}")
        try:
            msg = res.json().get("message", "")
        except Exception:
            msg = ""
        raise HTTPException(status_code=502, detail=f"Paiement refusé par le fournisseur ({res.status_code}). {msg}".strip())

    try:
        data = res.json()
        payment_id = str(data["payment_id"])
        db.collection("orders").document(payment_id).set({
            "uid": uid, "pack_name": pack_name, "price_usd": price, "status": "waiting",
            "pay_address": data["pay_address"], "pay_amount": data["pay_amount"],
            "pay_currency": data["pay_currency"], "created_at": firestore.SERVER_TIMESTAMP,
        })
        return {"payment_id": payment_id, "pack_name": pack_name, "pay_address": data["pay_address"],
                "amount": data["pay_amount"], "currency": data["pay_currency"]}
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Réponse NOWPayments inattendue / Firestore : {e}")
        raise HTTPException(status_code=500, detail="Erreur interne lors de l'enregistrement de la commande.")


@app.get("/api/check-payment/{payment_id}")
def check_payment(payment_id: str, authorization: Optional[str] = Header(None)):
    uid = current_uid(authorization)
    order = get_order(payment_id, uid)
    if order.get("status") == "paid":
        return {"status": "paid"}
    if not NOWPAYMENTS_API_KEY:
        raise HTTPException(status_code=503, detail="Paiement crypto non configuré côté serveur.")
    try:
        res = requests.get(f"{NOWPAYMENTS_URL}/payment/{payment_id}", headers={"x-api-key": NOWPAYMENTS_API_KEY}, timeout=30)
        res.raise_for_status()
        status = map_status(res.json().get("payment_status", ""))
    except Exception:
        raise HTTPException(status_code=502, detail="Vérification du paiement impossible pour le moment.")
    if status in ("paid", "failed", "expired") and order.get("status") != status:
        db.collection("orders").document(str(payment_id)).update({"status": status})
    return {"status": status}


@app.get("/api/my-orders")
def my_orders(authorization: Optional[str] = Header(None)):
    uid = current_uid(authorization)
    out = []
    for d in db.collection("orders").where("uid", "==", uid).stream():
        o = d.to_dict() or {}
        if o.get("hidden"):
            continue
        ts = o.get("created_at")
        out.append({
            "payment_id": d.id, "pack_name": o.get("pack_name"), "status": o.get("status", "waiting"),
            "pay_address": o.get("pay_address"), "pay_amount": o.get("pay_amount"), "pay_currency": o.get("pay_currency"),
            "created_at": ts.isoformat() if hasattr(ts, "isoformat") else None,
        })
    out.sort(key=lambda x: x["created_at"] or "", reverse=True)
    return {"orders": out[:30]}


@app.post("/api/delete-order/{payment_id}")
def delete_order(payment_id: str, authorization: Optional[str] = Header(None)):
    """Suppression douce : la commande disparaît de l'historique mais reste enregistrée (support / comptabilité)."""
    uid = current_uid(authorization)
    order = get_order(payment_id, uid)
    if order.get("status") == "waiting" and NOWPAYMENTS_API_KEY:
        # Dernière vérification : ne jamais masquer un paiement qui vient d'arriver
        try:
            res = requests.get(f"{NOWPAYMENTS_URL}/payment/{payment_id}", headers={"x-api-key": NOWPAYMENTS_API_KEY}, timeout=30)
            res.raise_for_status()
            status = map_status(res.json().get("payment_status", ""))
        except Exception:
            raise HTTPException(status_code=502, detail="Impossible de vérifier le paiement pour le moment, réessayez dans un instant.")
        if status == "paid":
            db.collection("orders").document(str(payment_id)).update({"status": "paid"})
            raise HTTPException(status_code=409, detail="Ce paiement vient d'être validé : il n'a pas été supprimé. Téléchargez votre pack.")
        if status == "partial":
            raise HTTPException(status_code=409, detail="Un paiement partiel a été reçu : contactez le support avant de supprimer cette commande.")
    db.collection("orders").document(str(payment_id)).update({"hidden": True, "hidden_at": firestore.SERVER_TIMESTAMP})
    return {"deleted": True}


# ---------- Téléchargement des packs (Google Drive via rclone) ----------
DL_SECRET = secrets.token_bytes(32)   # propre au processus : les liens expirent aussi au redémarrage
DL_TTL = 120                          # secondes de validité d'un lien de téléchargement
MAX_DOWNLOADS = 3                     # téléchargements simultanés maximum (espace disque / RAM du runner)
DL_STALE = 1800                       # un téléchargement « fantôme » est purgé après 30 min
_dl_lock = threading.Lock()
_dl_active = {}                       # dossier temporaire -> heure de début

# Nettoyage des dossiers temporaires laissés par un ancien processus
for _d in glob.glob(os.path.join(tempfile.gettempdir(), "goangel_dl_*")):
    shutil.rmtree(_d, ignore_errors=True)


def run_rclone(args, timeout):
    env = {k: v for k, v in os.environ.items() if k != "RCLONE_CONFIG"}  # rclone lirait ce nom comme un CHEMIN de fichier
    return subprocess.run(
        ["rclone", "--config", RCLONE_CONF_PATH, "--retries", "3", *args],
        capture_output=True, text=True, timeout=timeout, env=env,
    )


def ensure_drive_ready():
    if RCLONE_CONF_PATH is None:
        raise HTTPException(status_code=503, detail="Stockage Google Drive non configuré côté serveur (secret RCLONE_CONFIG).")


def list_pack_files() -> set:
    try:
        res = run_rclone(["lsf", RCLONE_REMOTE, "--files-only"], timeout=60)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Google Drive met trop de temps à répondre, réessayez.")
    if res.returncode != 0:
        print(f"❌ rclone lsf : {res.stderr[:200]}")
        raise HTTPException(status_code=502, detail="Google Drive inaccessible pour le moment, réessayez.")
    return {line.strip() for line in res.stdout.splitlines() if line.strip()}


def pack_filename(pack_name: str) -> str:
    name = f"{slug(pack_name)}.zip"
    if not SAFE_PACK_FILE.match(name):
        raise HTTPException(status_code=400, detail="Nom de pack invalide.")
    return name


def make_dl_token(payment_id: str, uid: str) -> str:
    exp = int(time.time()) + DL_TTL
    sig = hmac.new(DL_SECRET, f"{payment_id}.{uid}.{exp}".encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def check_dl_token(token: str, payment_id: str, uid: str) -> bool:
    try:
        exp_s, sig = token.split(".", 1)
        if int(exp_s) < time.time():
            return False
        expected = hmac.new(DL_SECRET, f"{payment_id}.{uid}.{exp_s}".encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, expected)
    except Exception:
        return False


def authorize_download(payment_id: str, token: Optional[str], authorization: Optional[str]) -> dict:
    """Commande existante + payée + propriétaire (jeton Firebase OU lien signé court)."""
    check_payment_id(payment_id)
    if db is None:
        raise HTTPException(status_code=503, detail="Base de données non configurée côté serveur (secret FIREBASE_CREDENTIALS).")
    if token:
        snap = db.collection("orders").document(payment_id).get()
        order = snap.to_dict() if snap.exists else None
        if not order:
            raise HTTPException(status_code=404, detail="Commande introuvable.")
        if not check_dl_token(token, payment_id, str(order.get("uid", ""))):
            raise HTTPException(status_code=403, detail="Lien de téléchargement expiré ou invalide : relancez le téléchargement depuis le site.")
    else:
        order = get_order(payment_id, current_uid(authorization))
    if order.get("status") != "paid":
        raise HTTPException(status_code=403, detail="Paiement non validé.")
    return order


def _reserve_slot() -> Optional[str]:
    with _dl_lock:
        now = time.time()
        for d, t in list(_dl_active.items()):
            if now - t > DL_STALE:
                shutil.rmtree(d, ignore_errors=True)
                _dl_active.pop(d, None)
        if len(_dl_active) >= MAX_DOWNLOADS:
            return None
        folder = tempfile.mkdtemp(prefix="goangel_dl_")   # dossier unique par téléchargement : aucun conflit
        _dl_active[folder] = now
        return folder


def _release_slot(folder: str):
    with _dl_lock:
        _dl_active.pop(folder, None)
    shutil.rmtree(folder, ignore_errors=True)


@app.post("/api/download-token/{payment_id}")
def download_token(payment_id: str, authorization: Optional[str] = Header(None)):
    """Vérifie l'achat et le fichier, puis renvoie un lien signé de 2 min (le navigateur ne peut pas envoyer d'en-tête Authorization en naviguant)."""
    order = authorize_download(payment_id, None, authorization)
    ensure_drive_ready()
    filename = pack_filename(order["pack_name"])
    if filename not in list_pack_files():
        raise HTTPException(status_code=404, detail=f"Le fichier du pack « {order['pack_name']} » n'est pas encore disponible : contactez le support.")
    return {"url": f"/api/download/{payment_id}?token={make_dl_token(payment_id, str(order.get('uid', '')))}"}


@app.get("/api/download/{payment_id}")
def download_file(payment_id: str, token: Optional[str] = Query(None, max_length=200), authorization: Optional[str] = Header(None)):
    order = authorize_download(payment_id, token, authorization)
    ensure_drive_ready()
    filename = pack_filename(order["pack_name"])

    folder = _reserve_slot()
    if folder is None:
        raise HTTPException(status_code=429, detail="Serveur occupé par d'autres téléchargements, réessayez dans un instant.")
    try:
        if filename not in list_pack_files():
            raise HTTPException(status_code=404, detail="Fichier du pack introuvable sur le stockage.")
        dest = os.path.join(folder, filename)
        try:
            res = run_rclone(["copyto", f"{RCLONE_REMOTE}/{filename}", dest], timeout=900)
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="Téléchargement depuis Google Drive trop long, réessayez.")
        if res.returncode != 0 or not os.path.isfile(dest):
            print(f"❌ rclone copyto : {res.stderr[:200]}")
            raise HTTPException(status_code=502, detail="Impossible de récupérer le fichier depuis Google Drive.")
    except BaseException:
        _release_slot(folder)
        raise
    return FileResponse(
        dest, media_type="application/zip", filename=f"goangel-{filename}",
        background=BackgroundTask(_release_slot, folder),   # supprime le fichier temporaire après l'envoi
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
EOF
echo "✅ backend.py"

cat > requirements.txt << 'EOF'
fastapi==0.110.0
uvicorn==0.29.0
requests==2.31.0
pydantic==2.6.4
firebase-admin==6.5.0
EOF
echo "✅ requirements.txt"

cat > .github/workflows/ai-backend.yml << 'EOF'
name: GOANGEL AI Backend

on:
  workflow_dispatch:

permissions:
  contents: read
  actions: write

# Une seule exécution active. Les nouvelles attendent (1 seule en file),
# l'ancienne n'est JAMAIS annulée.
concurrency:
  group: goangel-ai-backend
  cancel-in-progress: false

jobs:
  run-backend:
    runs-on: ubuntu-latest
    # Filet de sécurité uniquement (limite GitHub = 360 min)
    timeout-minutes: 359

    # ⚠️ Volontairement AUCUN secret rclone ici : la variable RCLONE_CONFIG est lue par rclone
    # comme un CHEMIN de fichier. Elle n'est donc fournie qu'aux étapes Python (le backend la
    # décode lui-même et appelle rclone avec --config).
    env:
      GOANGEL_STATE_DIR: /tmp/goangel-state
      RUN_SECONDS: 21480   # 5 h 58 min

    steps:
      - name: Fixer l'échéance (5h58 depuis le début du job)
        run: echo "DEADLINE=$(( $(date +%s) + RUN_SECONDS ))" >> "$GITHUB_ENV"

      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Restaurer l'état précédent
        uses: actions/cache/restore@v4
        with:
          path: /tmp/goangel-state
          key: goangel-state-none
          restore-keys: |
            goangel-state-

      - name: Préparer le dossier d'état
        run: |
          mkdir -p "$GOANGEL_STATE_DIR"
          echo "État restauré :"; ls -la "$GOANGEL_STATE_DIR"

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.10'

      - name: Installer rclone
        run: |
          curl -fsSL https://rclone.org/install.sh | sudo bash
          rclone version | head -n 1

      - name: Configurer rclone (secret RCLONE_CONFIG en Base64)
        env:
          RCLONE_CONFIG_B64: ${{ secrets.RCLONE_CONFIG }}
        run: |
          if [ -z "$RCLONE_CONFIG_B64" ]; then
            echo "::warning::Secret RCLONE_CONFIG absent : les téléchargements de packs seront indisponibles."
            exit 0
          fi
          mkdir -p "$HOME/.config/rclone"
          python3 - <<'PY'
          import base64, os
          raw = os.environ["RCLONE_CONFIG_B64"].strip()
          try:
              if raw.startswith("["):
                  text = raw
              else:
                  compact = "".join(raw.split())
                  compact += "=" * (-len(compact) % 4)
                  text = base64.b64decode(compact).decode("utf-8")
              assert "[gdrive]" in text
              path = os.path.expanduser("~/.config/rclone/rclone.conf")
              fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
              with os.fdopen(fd, "w") as f:
                  f.write(text)
              print("Configuration rclone restaurée (remote gdrive présent).")
          except Exception:
              print("::warning::RCLONE_CONFIG invalide (Base64 d'un fichier rclone avec un remote [gdrive] attendu).")
          PY
          # Diagnostic non bloquant : le chat IA doit rester disponible même si Drive a un souci
          rclone lsd gdrive: --max-depth 0 > /dev/null 2>&1 && echo "✅ Google Drive accessible" || echo "::warning::Google Drive inaccessible (jeton OAuth expiré ?)"

      - name: Install Ollama
        run: curl -fsSL https://ollama.com/install.sh | sh

      - name: Start Ollama & Pull Model
        run: |
          ollama serve > ollama.log 2>&1 &
          for i in $(seq 1 30); do curl -sf http://localhost:11434/api/tags > /dev/null && break; sleep 2; done
          ollama pull phi3:mini
          curl -s http://localhost:11434/api/generate -d '{"model": "phi3:mini", "keep_alive": -1}' > /dev/null 2>&1 &
          echo "✅ Modèle phi3:mini pré-chargé."

      - name: Install Python dependencies
        run: pip install -r requirements.txt

      - name: Start FastAPI Backend
        # Les secrets DOIVENT être transmis ici, sinon backend.py ne voit ni Firebase, ni NOWPayments, ni Drive
        env:
          FIREBASE_CREDENTIALS: ${{ secrets.FIREBASE_CREDENTIALS }}
          CRYPTO_API_KEY: ${{ secrets.CRYPTO_API_KEY }}
          RCLONE_CONFIG: ${{ secrets.RCLONE_CONFIG }}
        run: |
          nohup python backend.py > backend.log 2>&1 &
          echo $! > backend.pid
          for i in $(seq 1 30); do curl -sf http://localhost:8000/api/health > /dev/null && break; sleep 1; done
          kill -0 "$(cat backend.pid)" || { cat backend.log; exit 1; }
          echo "Santé du backend :"; curl -s http://localhost:8000/api/health; echo
          grep -E "NOWPayments|FIREBASE|RCLONE|rclone" backend.log || true

      - name: Start Cloudflare Tunnel
        env:
          CLOUDFLARE_TUNNEL_TOKEN: ${{ secrets.CLOUDFLARE_TUNNEL_TOKEN }}
        run: |
          curl -L -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
          chmod +x cloudflared
          nohup ./cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" > tunnel.log 2>&1 &
          echo $! > tunnel.pid
          sleep 10
          if curl -sf --max-time 15 https://api.goangel.dpdns.org/api/health > /dev/null; then
            echo "✅ BACKEND ACCESSIBLE PUBLIQUEMENT SUR https://api.goangel.dpdns.org"
          else
            echo "::warning::api.goangel.dpdns.org ne répond pas encore (vérifier tunnel.log et le DNS Cloudflare)."
            tail -n 20 tunnel.log || true
          fi

      - name: Exécution jusqu'à l'échéance (supervision)
        id: run
        env:
          FIREBASE_CREDENTIALS: ${{ secrets.FIREBASE_CREDENTIALS }}
          CRYPTO_API_KEY: ${{ secrets.CRYPTO_API_KEY }}
          RCLONE_CONFIG: ${{ secrets.RCLONE_CONFIG }}
          CLOUDFLARE_TUNNEL_TOKEN: ${{ secrets.CLOUDFLARE_TUNNEL_TOKEN }}
        run: |
          start_backend() { nohup python backend.py >> backend.log 2>&1 & echo $! > backend.pid; }
          start_tunnel()  { nohup ./cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" >> tunnel.log 2>&1 & echo $! > tunnel.pid; }
          stop_pid()      { kill -TERM "$(cat "$1")" 2>/dev/null || true; sleep 2; kill -KILL "$(cat "$1")" 2>/dev/null || true; }

          FAILS=0; PUB_FAILS=0; RESTARTS=0; TICK=0
          while [ "$(date +%s)" -lt "$DEADLINE" ]; do
            TICK=$((TICK + 1))

            # 1) FastAPI doit répondre en local
            if kill -0 "$(cat backend.pid)" 2>/dev/null && curl -sf --max-time 10 http://localhost:8000/api/health > /dev/null; then
              FAILS=0
            else
              FAILS=$((FAILS + 1)); echo "⚠️ Santé locale KO ($FAILS/3)"
            fi
            if [ "$FAILS" -ge 3 ]; then
              RESTARTS=$((RESTARTS + 1))
              if [ "$RESTARTS" -gt 5 ]; then echo "❌ Trop de redémarrages du backend"; tail -n 50 backend.log; exit 1; fi
              echo "🔁 Redémarrage du backend ($RESTARTS/5)"
              stop_pid backend.pid; start_backend; FAILS=0
              sleep 15
            fi

            # 2) Le tunnel doit tourner
            if ! kill -0 "$(cat tunnel.pid)" 2>/dev/null; then
              echo "🔁 Tunnel arrêté : redémarrage"; start_tunnel
            fi

            # 3) Toutes les 5 min : l'API doit répondre depuis Internet (via Cloudflare)
            if [ $((TICK % 10)) -eq 0 ]; then
              if curl -sf --max-time 15 https://api.goangel.dpdns.org/api/health > /dev/null; then
                PUB_FAILS=0
              else
                PUB_FAILS=$((PUB_FAILS + 1)); echo "⚠️ API publique injoignable ($PUB_FAILS/3)"
                if [ "$PUB_FAILS" -ge 3 ]; then echo "🔁 Redémarrage du tunnel"; stop_pid tunnel.pid; start_tunnel; PUB_FAILS=0; fi
              fi
            fi
            sleep 30
          done
          echo "⏱️ Échéance 5h58 atteinte."

      - name: Arrêt propre du backend
        if: always()
        run: |
          if [ -f backend.pid ] && kill -0 "$(cat backend.pid)" 2>/dev/null; then
            kill -TERM "$(cat backend.pid)"
            for i in $(seq 1 20); do
              kill -0 "$(cat backend.pid)" 2>/dev/null || break
              sleep 1
            done
            kill -KILL "$(cat backend.pid)" 2>/dev/null || true
          fi
          pkill -f cloudflared || true
          pkill -f "ollama serve" || true
          rm -f "$HOME/.config/rclone/rclone.conf"

      - name: Écrire le marqueur d'état
        if: always()
        run: |
          mkdir -p "$GOANGEL_STATE_DIR"
          echo "{\"last_run\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"run_id\": \"${{ github.run_id }}\"}" > "$GOANGEL_STATE_DIR/run_meta.json"

      - name: Sauvegarder l'état
        if: always()
        uses: actions/cache/save@v4
        with:
          path: /tmp/goangel-state
          key: goangel-state-${{ github.run_id }}-${{ github.run_attempt }}

      - name: Relance automatique (une seule, sans boucle)
        # Uniquement si le cycle s'est terminé normalement à l'échéance
        if: always() && steps.run.outcome == 'success'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          WAITING=0
          for s in queued pending waiting requested; do
            n=$(gh run list --workflow ai-backend.yml --status "$s" --json databaseId --jq 'length' --repo "${{ github.repository }}")
            WAITING=$((WAITING + n))
          done
          if [ "$WAITING" -gt 0 ]; then
            echo "Une exécution est déjà en attente, pas de nouvelle relance."
          else
            gh workflow run ai-backend.yml --ref main --repo "${{ github.repository }}"
            echo "✅ Relance planifiée (démarrera après la fin de ce job)."
          fi
EOF
echo "✅ .github/workflows/ai-backend.yml"

cat > .github/workflows/upload-packs.yml << 'EOF'
name: Upload Packs to Google Drive

# Envoie le contenu du dossier ./packs (fichiers .zip) vers gdrive:goangel_packs
on:
  workflow_dispatch:
    inputs:
      source_ref:
        description: "Branche ou tag contenant le dossier packs/ (vide = branche courante)"
        required: false
        default: ""

permissions:
  contents: read

concurrency:
  group: goangel-upload-packs
  cancel-in-progress: false

jobs:
  upload:
    runs-on: ubuntu-latest
    timeout-minutes: 90

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          ref: ${{ inputs.source_ref || github.ref }}

      - name: Installer rclone
        run: |
          curl -fsSL https://rclone.org/install.sh | sudo bash
          rclone version | head -n 1

      - name: Restaurer la configuration rclone (secret RCLONE_CONFIG en Base64)
        env:
          RCLONE_CONFIG_B64: ${{ secrets.RCLONE_CONFIG }}
        run: |
          if [ -z "$RCLONE_CONFIG_B64" ]; then
            echo "::error::Le secret GitHub RCLONE_CONFIG est absent ou vide."
            exit 1
          fi
          mkdir -p "$HOME/.config/rclone"
          python3 - <<'PY'
          import base64, os, sys
          raw = os.environ["RCLONE_CONFIG_B64"].strip()
          try:
              if raw.startswith("["):
                  data = raw.encode()
              else:
                  compact = "".join(raw.split())
                  compact += "=" * (-len(compact) % 4)
                  data = base64.b64decode(compact)
              text = data.decode("utf-8")
          except Exception:
              print("::error::RCLONE_CONFIG n'est pas un Base64 valide.")
              sys.exit(1)
          if "[gdrive]" not in text:
              print("::error::La configuration rclone ne contient pas de remote nommé [gdrive].")
              sys.exit(1)
          path = os.path.expanduser("~/.config/rclone/rclone.conf")
          fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
          with os.fdopen(fd, "w") as f:
              f.write(text)
          print("Configuration rclone restaurée (remote gdrive présent).")
          PY

      - name: Vérifier l'accès à Google Drive
        run: |
          rclone lsd gdrive: --max-depth 0 || { echo "::error::Connexion à Google Drive impossible : jeton OAuth expiré ou configuration invalide (voir README)."; exit 1; }

      - name: Créer le dossier distant si nécessaire
        run: rclone mkdir gdrive:goangel_packs

      - name: Vérifier le contenu de ./packs
        run: |
          if [ ! -d ./packs ]; then
            echo "::error::Le dossier ./packs n'existe pas dans le dépôt (ref : ${{ inputs.source_ref || github.ref }})."
            exit 1
          fi
          shopt -s nullglob
          FILES=(./packs/*.zip)
          if [ "${#FILES[@]}" -eq 0 ]; then
            echo "::error::Aucun fichier .zip dans ./packs."
            exit 1
          fi
          BAD=0
          for f in "${FILES[@]}"; do
            n=$(basename "$f")
            if ! [[ "$n" =~ ^[a-z0-9][a-z0-9-]*\.zip$ ]]; then
              echo "::error::Nom invalide : $n (minuscules, chiffres et tirets uniquement, ex. starter.zip)"
              BAD=1
            fi
          done
          [ "$BAD" -eq 0 ] || exit 1
          ls -lh ./packs

      - name: Transférer ./packs vers gdrive:goangel_packs
        run: |
          rclone copy ./packs gdrive:goangel_packs \
            --include "*.zip" --checksum --transfers 2 \
            --drive-chunk-size 64M -v --stats 15s --stats-one-line

      - name: Contenu final du dossier distant
        run: rclone lsl gdrive:goangel_packs

      - name: Supprimer la configuration rclone du runner
        if: always()
        run: rm -f "$HOME/.config/rclone/rclone.conf"
EOF
echo "✅ .github/workflows/upload-packs.yml"

cat > js/simulator.js << 'EOF'
// 🎮 Simulateur de paris GOANGEL — DÉMONSTRATION avec des matchs et des résultats fictifs
const Simulator = (() => {
  let timer = null, st = null, root = null;
  const $ = s => root.querySelector(s);
  const teams = ["Atlas FC", "Nordia United", "Real Solaris", "Olympia 04", "Vento Calcio", "Port Azur", "Dynamo Keld", "Sporting Aurea", "Lumen City", "Borea SC", "Tiber AC", "Kasai Stars"];
  const markets = ["Victoire domicile", "Victoire extérieur", "Plus de 2,5 buts", "Les deux marquent", "Nul ou domicile"];
  const fmt = n => (Math.round(n * 100) / 100).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + CONFIG.currency;
  const pick = a => a[Math.random() * a.length | 0];

  function tween(el, from, to, f = fmt) {
    const t0 = performance.now();
    (function s(t) { const k = Math.min(1, (t - t0) / 600); el.textContent = f(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(s); })(t0);
  }

  function chart() {
    const cv = $("#sim-chart"), D = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * D; cv.height = h * D; const x = cv.getContext("2d"); x.setTransform(D, 0, 0, D, 0, 0); x.clearRect(0, 0, w, h);
    const d = st.hist.slice(-60), min = Math.min(...d, st.start) * .98, max = Math.max(...d, st.start) * 1.02;
    const X = i => 10 + i * (w - 20) / Math.max(1, d.length - 1), Y = v => h - 12 - (v - min) / (max - min) * (h - 24);
    x.setLineDash([4, 4]); x.strokeStyle = "rgba(255,255,255,.2)"; x.beginPath(); x.moveTo(0, Y(st.start)); x.lineTo(w, Y(st.start)); x.stroke(); x.setLineDash([]);
    const up = d[d.length - 1] >= st.start, col = up ? "16,185,129" : "248,113,113";
    const gr = x.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, `rgba(${col},.35)`); gr.addColorStop(1, `rgba(${col},0)`);
    x.beginPath(); d.forEach((v, i) => i ? x.lineTo(X(i), Y(v)) : x.moveTo(X(i), Y(v))); x.strokeStyle = `rgb(${col})`; x.lineWidth = 2.5; x.stroke();
    x.lineTo(X(d.length - 1), h); x.lineTo(X(0), h); x.fillStyle = gr; x.fill();
    x.fillStyle = `rgb(${col})`; x.shadowColor = `rgb(${col})`; x.shadowBlur = 12; x.beginPath(); x.arc(X(d.length - 1), Y(d[d.length - 1]), 4, 0, 6.3); x.fill(); x.shadowBlur = 0;
  }

  function step() {
    const home = pick(teams); let away = pick(teams); while (away === home) away = pick(teams);
    const odds = +(1.5 + Math.random() * 1.9).toFixed(2), q = 1 / odds;
    const p = Math.min(.9, q + .03 + Math.random() * .09);                 // probabilité estimée par le modèle (avantage simulé)
    const kelly = (p * odds - 1) / (odds - 1), stake = Math.max(5, Math.round(Math.min(.05, kelly * .25) * st.bank / 10) * 10);
    const win = Math.random() < p, gain = win ? +(stake * (odds - 1)).toFixed(2) : -stake;
    const before = st.bank; st.bank = Math.round((st.bank + gain) * 100) / 100; st.bets++; if (win) st.wins++; st.hist.push(st.bank);
    tween($("#s-bank"), before, st.bank); const pl = Math.round((st.bank - st.start) * 100) / 100; tween($("#s-pl"), st.last, pl, v => (v >= 0 ? "+" : "") + fmt(v)); st.last = pl;
    $("#s-pl").className = st.last >= 0 ? "pos" : "neg";
    $("#s-rate").textContent = Math.round(st.wins / st.bets * 100) + " %"; $("#s-n").textContent = st.bets;
    const li = document.createElement("li"); li.className = win ? "win" : "loss";
    li.innerHTML = `<div><strong>${home} – ${away}</strong><span>${pick(markets)} · cote ${odds} · confiance ${Math.round(p * 100)} % · mise ${fmt(stake)}</span></div><b>${win ? "+" : "−"}${fmt(Math.abs(gain))}</b>`;
    const ul = $("#s-log"); ul.prepend(li); while (ul.children.length > 7) ul.lastChild.remove();
    if (st.bank < 30) reset(); chart();
  }

  function schedule() { clearInterval(timer); if (st.run) timer = setInterval(step, 2600 / st.speed); }
  function reset() { st.bank = st.start; st.hist = [st.start]; st.bets = 0; st.wins = 0; st.last = 0; $("#s-log").innerHTML = ""; $("#s-bank").textContent = fmt(st.bank); $("#s-pl").textContent = "+" + fmt(0); $("#s-rate").textContent = "–"; $("#s-n").textContent = 0; chart(); }

  function mount(el) {
    if (!el) return; root = el; st = { start: 1000, bank: 1000, hist: [1000], bets: 0, wins: 0, last: 0, run: true, speed: 1 };
    root.innerHTML = `
      <p class="sim-note">Démonstration : matchs et résultats fictifs. Elle illustre le fonctionnement d'une mise calibrée, pas des gains réels ni garantis.</p>
      <div class="sim-kpis">
        <div><small>Capital simulé</small><b id="s-bank">${fmt(st.bank)}</b></div>
        <div><small>Gain / perte</small><b id="s-pl" class="pos">+${fmt(0)}</b></div>
        <div><small>Paris gagnés</small><b id="s-rate">–</b></div>
        <div><small>Paris joués</small><b id="s-n">0</b></div>
      </div>
      <div class="sim-grid">
        <div class="sim-panel"><canvas id="sim-chart" aria-label="Évolution du capital simulé"></canvas></div>
        <div class="sim-panel"><ul id="s-log" aria-live="polite"></ul></div>
      </div>
      <div class="sim-ctl">
        <button class="btn small" id="s-toggle">Pause</button>
        <button class="btn small ghost" id="s-speed">Vitesse ×1</button>
        <button class="btn small ghost" id="s-reset">Réinitialiser</button>
      </div>`;
    $("#s-toggle").onclick = e => { st.run = !st.run; e.target.textContent = st.run ? "Pause" : "Reprendre"; schedule(); };
    $("#s-speed").onclick = e => { st.speed = st.speed === 4 ? 1 : st.speed * 2; e.target.textContent = "Vitesse ×" + st.speed; schedule(); };
    $("#s-reset").onclick = reset;
    chart(); step(); schedule();
  }
  const destroy = () => { clearInterval(timer); timer = null; };
  addEventListener("resize", () => { if (st && root && root.isConnected) chart(); });
  return { mount, destroy };
})();
EOF
echo "✅ js/simulator.js"

cat > js/config.js << 'EOF'
// ⚙️ CONFIGURATION — le seul fichier à modifier pour changer d'adresse ou de contact
const CONFIG = {
  brand: "GOANGEL AI ENGINE",
  siteUrl: "https://goangel.dpdns.org/",
  telegram: "https://t.me/goangelaiengine_bot",
  currency: "USDT",
  minAge: 18
};
EOF
echo "✅ js/config.js"

cat > js/app.js << 'EOF'
// Application principale — chargé avec <script type="module">
import { Auth } from "./auth.js";
import { db } from "./firebase-config.js";
import { updateProfile } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const API = "https://api.goangel.dpdns.org";
const CLOUDINARY_URL = "https://api.cloudinary.com/v1_1/gkiui3xc/image/upload";
const CLOUDINARY_PRESET = "goangel_unsigned";

const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => /^https:\/\//i.test(u || "") ? u : "";
const fmtPrice = p => Number(p).toLocaleString("fr-FR");
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

let user = null;
let dynamicPacks = null;
let payTimer = null;

// ---------- API (avec jeton Firebase) ----------
async function api(path, opts = {}) {
  const token = await Auth.token();
  const res = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, ...(opts.headers || {}) }
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const d = data && data.detail;
    throw new Error(typeof d === "string" ? d : "Erreur serveur (" + res.status + ").");
  }
  return data;
}

// ---------- Packs ----------
async function loadPacks() {
  try {
    const snap = await getDocs(collection(db, "packs"));
    dynamicPacks = snap.empty ? null : snap.docs.map(d => d.data()).filter(p => p && p.name && Array.isArray(p.features) && Number(p.price) > 0);
  } catch (e) { dynamicPacks = null; }
}
function getPacks() {
  const packs = SITE_DATA.packs.map(p => ({ ...p }));
  (dynamicPacks || []).forEach(dp => {
    const i = packs.findIndex(p => p.name.toLowerCase() === String(dp.name).toLowerCase());
    if (i !== -1) packs[i] = dp; else packs.push(dp);
  });
  return packs;
}

// ---------- Panier (par utilisateur, localStorage) ----------
const cartKey = () => "goangel_cart_" + (user ? user.uid : "anon");
const getCart = () => { try { return JSON.parse(localStorage.getItem(cartKey())) || []; } catch (e) { return []; } };
const setCart = c => { try { localStorage.setItem(cartKey(), JSON.stringify(c)); } catch (e) {} renderCart(); };
function addToCart(name) { const c = getCart(); if (!c.includes(name)) c.push(name); setCart(c); }
function renderCart() {
  const cart = getCart(), packs = getPacks();
  $("cart-count").textContent = cart.length;
  $("cart-count").style.display = cart.length ? "inline-block" : "none";
  let total = 0;
  $("cart-items").innerHTML = cart.length ? cart.map((n, i) => {
    const p = packs.find(x => x.name === n); const price = p ? Number(p.price) : 0; total += price;
    return `<div class="cart-item"><span>${esc(n)}</span><span>${fmtPrice(price)} USDT <button data-rm="${i}" aria-label="Retirer">✕</button></span></div>`;
  }).join("") : '<p class="muted">Votre panier est vide.</p>';
  $("cart-total").textContent = fmtPrice(total) + " USDT";
  $("cart-items").querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { const c = getCart(); c.splice(Number(b.dataset.rm), 1); setCart(c); });
}

// ---------- Paiement crypto ----------
function closePayModal(modal) { clearInterval(payTimer); payTimer = null; modal.remove(); }

function showPayModal(order) {
  clearInterval(payTimer);
  document.querySelectorAll(".pay-modal").forEach(m => m.remove());
  const modal = document.createElement("div");
  modal.className = "modal pay-modal";
  modal.innerHTML = `
    <div class="modal-content">
      <button class="modal-close" aria-label="Fermer">×</button>
      <h2 style="color:var(--gold)">Paiement Crypto</h2>
      <p style="margin:1rem 0 .5rem">Pack <b>${esc(order.pack_name)}</b> — envoyez exactement :</p>
      <div class="copy-row"><code id="pay-amount">${esc(order.amount)}</code><button class="btn small ghost" data-copy="pay-amount">Copier</button></div>
      <p style="margin-bottom:.5rem"><b>${esc(String(order.currency).toUpperCase())}</b> (réseau Tron TRC-20) à cette adresse :</p>
      <div class="copy-row"><code id="pay-addr">${esc(order.pay_address)}</code><button class="btn small ghost" data-copy="pay-addr">Copier</button></div>
      <p id="pay-status" style="color:var(--muted)">En attente du paiement sur la blockchain…</p>
      <div id="pay-actions" style="margin-top:1rem"></div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector(".modal-close").onclick = () => closePayModal(modal);
  modal.querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(modal.querySelector("#" + b.dataset.copy).textContent); b.textContent = "Copié ✓"; setTimeout(() => b.textContent = "Copier", 1500); } catch (e) {}
  });
  const status = modal.querySelector("#pay-status");
  let tries = 0;
  const poll = async () => {
    if (++tries > 360) { clearInterval(payTimer); status.textContent = "Délai dépassé. Retrouvez votre commande dans « Vos achats »."; return; }
    try {
      const r = await api("/api/check-payment/" + encodeURIComponent(order.payment_id));
      if (r.status === "paid") {
        clearInterval(payTimer);
        status.textContent = "✅ Paiement validé !"; status.style.color = "var(--pos)";
        const act = modal.querySelector("#pay-actions");
        act.innerHTML = '<button class="btn" style="width:100%">Télécharger le ZIP</button>';
        act.firstChild.onclick = () => downloadOrder(order.payment_id);
        refreshOrders();
      } else if (r.status === "failed" || r.status === "expired") {
        clearInterval(payTimer);
        status.textContent = "❌ Paiement " + (r.status === "expired" ? "expiré" : "échoué") + ". Relancez une commande."; status.style.color = "var(--err)";
        refreshOrders();
      } else if (r.status === "partial") {
        status.textContent = "⚠️ Montant partiel reçu : complétez le paiement ou contactez le support.";
      }
    } catch (e) { status.textContent = "Vérification impossible pour le moment, nouvelle tentative…"; }
  };
  payTimer = setInterval(poll, 10000);
  poll();
}

async function initiatePayment(packName, btn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = "Création…";
  try {
    const order = await api("/api/create-payment", { method: "POST", body: JSON.stringify({ pack_name: packName }) });
    showPayModal(order);
    refreshOrders();
  } catch (e) {
    alert("Erreur lors de la création du paiement : " + e.message);
  } finally { btn.disabled = false; btn.textContent = old; }
}

async function downloadOrder(paymentId) {
  try {
    const r = await api("/api/download-token/" + encodeURIComponent(paymentId), { method: "POST" });
    if (!r.url) throw new Error("Lien indisponible.");
    window.location.href = API + r.url;   // le serveur envoie le ZIP en flux (lien signé valable 2 min)
  } catch (e) { alert("Téléchargement impossible : " + e.message); }
}

function confirmBox(title, html, okLabel) {
  return new Promise(resolve => {
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `<div class="modal-content confirm-box"><h2 style="color:var(--gold);margin-bottom:1rem">${esc(title)}</h2>${html}
      <div class="confirm-actions"><button class="btn ghost" data-r="0">Annuler</button><button class="btn btn-danger" data-r="1">${esc(okLabel)}</button></div></div>`;
    document.body.appendChild(m);
    m.querySelectorAll("[data-r]").forEach(b => b.onclick = () => { m.remove(); resolve(b.dataset.r === "1"); });
  });
}

function deleteMessage(o) {
  const id = `<p>ID de paiement : <code>${esc(o.payment_id)}</code></p>`;
  if (o.status === "paid") return ["Supprimer cet achat payé ?", `<p class="warn"><b>Attention :</b> vous perdrez le bouton de téléchargement de ce pack depuis votre compte. Téléchargez-le d'abord si ce n'est pas fait.</p>${id}<p>Gardez cet ID : le support Telegram pourra retrouver la commande.</p>`];
  if (o.status === "waiting") return ["Supprimer cette commande en attente ?", `<p>Si vous n'avez <b>envoyé aucun fonds</b>, vous ne perdez rien.</p><p class="warn"><b>Attention :</b> si vous avez déjà envoyé le paiement (même pas encore confirmé sur la blockchain), vous perdrez l'accès à ce pack depuis votre compte et le bouton de téléchargement ne reviendra pas. Le paiement n'est pas remboursé automatiquement.</p>${id}<p>Notez cet ID et contactez-nous sur Telegram pour retrouver la commande.</p>`];
  return ["Supprimer cette commande ?", `<p>Elle sera retirée de votre historique.</p>${id}`];
}

const ST_LABEL = { paid: "Payé", waiting: "En attente", failed: "Échoué", expired: "Expiré" };
async function refreshOrders() {
  const box = $("orders-list"); if (!box) return;
  try {
    const orders = (await api("/api/my-orders")).orders || [];
    box.innerHTML = orders.length ? orders.map(o => `
      <div class="order-item">
        <div><strong>${esc(o.pack_name)}</strong> <span class="st ${esc(o.status)}">${esc(ST_LABEL[o.status] || o.status)}</span>
        <small>${esc(o.created_at ? new Date(o.created_at).toLocaleString("fr-FR") : "")}</small></div>
        <div class="order-actions">${o.status === "paid" ? `<button class="btn small" data-dl="${esc(o.payment_id)}">Télécharger</button>`
          : o.status === "waiting" ? `<button class="btn small ghost" data-resume="${esc(o.payment_id)}">Reprendre</button>` : ""}
          <button class="btn small btn-danger" data-del="${esc(o.payment_id)}" aria-label="Supprimer">🗑 Supprimer</button></div>
      </div>`).join("") : '<p class="muted">Aucun achat pour le moment.</p>';
    box.querySelectorAll("[data-dl]").forEach(b => b.onclick = () => downloadOrder(b.dataset.dl));
    box.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
      const o = orders.find(x => x.payment_id === b.dataset.del); if (!o) return;
      const [title, html] = deleteMessage(o);
      if (!(await confirmBox(title, html, "Supprimer définitivement"))) return;
      try {
        await api("/api/delete-order/" + encodeURIComponent(o.payment_id), { method: "POST" });
        document.querySelectorAll(".pay-modal").forEach(m => closePayModal(m));
      } catch (e) { alert(e.message); }
      refreshOrders();
    });
    box.querySelectorAll("[data-resume]").forEach(b => b.onclick = () => {
      const o = orders.find(x => x.payment_id === b.dataset.resume);
      if (o) showPayModal({ payment_id: o.payment_id, pack_name: o.pack_name, amount: o.pay_amount, currency: o.pay_currency, pay_address: o.pay_address });
    });
  } catch (e) { box.innerHTML = '<p class="muted">Historique indisponible (serveur IA/paiement hors ligne).</p>'; }
}

// ---------- Média ----------
async function renderMedia() {
  const box = $("media-list"); if (!box) return;
  try {
    const snap = await getDocs(collection(db, "media"));
    const items = snap.docs.map(d => d.data()).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    if (!items.length) { box.innerHTML = '<p class="muted">Aucun contenu publié pour le moment.</p>'; return; }
    box.innerHTML = items.map(m => {
      const url = safeUrl(m.url), title = esc(m.description || ""), date = m.createdAt ? esc(new Date(m.createdAt).toLocaleDateString("fr-FR")) : "";
      let body = "";
      if (m.type === "image" && url) body = `<img src="${esc(url)}" alt="${title}" loading="lazy">`;
      else if (m.type === "video" && url) body = `<video src="${esc(url)}" controls preload="metadata"></video>`;
      else if (m.type === "audio" && url) body = `<audio src="${esc(url)}" controls preload="none"></audio>`;
      else if (m.type === "document" && url) body = `<a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">Ouvrir le document</a>`;
      else if (m.type === "text") body = `<p>${esc(m.text || "")}</p>`;
      else return "";
      return `<article class="card media-card">${body}${m.type !== "text" && title ? `<h3>${title}</h3>` : ""}${m.type === "text" && title ? `<h3>${title}</h3>` : ""}<small>${date}</small></article>`;
    }).join("");
  } catch (e) { box.innerHTML = '<p class="muted">Impossible de charger les contenus.</p>'; }
}

// ---------- Pages ----------
const pages = {
  home: () => `<section class="hero"><div class="monogram">GA</div><h1>${SITE_DATA.hero.title}</h1><p>${SITE_DATA.hero.subtitle}</p>
    <div class="actions"><a href="${esc(CONFIG.telegram)}" target="_blank" rel="noopener" class="btn">${SITE_DATA.hero.cta}</a><a href="#simulator" class="btn ghost">${SITE_DATA.hero.cta2}</a></div>
    <dl class="stats">${SITE_DATA.stats.map(s => `<div><dt>${s.v}</dt><dd>${s.l}</dd></div>`).join("")}</dl></section>`,
  features: () => `<section class="block"><h2>Technologie</h2><div class="grid">${SITE_DATA.features.map(f => `<article class="card"><div class="ico">${f.icon}</div><h3>${f.title}</h3><p>${f.desc}</p></article>`).join("")}</div></section>
    <section class="block narrow"><h2>Comment ça marche</h2><ol class="steps">${SITE_DATA.steps.map(s => `<li><div><strong>${s.t}</strong><br><span>${s.d}</span></div></li>`).join("")}</ol></section>`,
  simulator: () => `<section class="block"><h2>Simulateur</h2><div id="sim-root"></div></section>`,
  pricing: () => `<section class="block"><h2>Choisissez votre pack</h2>
    <div class="grid">${getPacks().map(p => `
      <article class="card price ${p.featured ? "featured" : ""}">
        ${p.featured ? '<span class="badge">Recommandé</span>' : ""}
        <h3>${esc(p.name)}</h3>
        <div class="amount">${fmtPrice(p.price)} <small>USDT (TRC-20)</small></div>
        <ul>${p.features.map(f => `<li>${esc(f)}</li>`).join("")}</ul>
        <div class="btn-row"><button class="btn buy-btn" data-name="${esc(p.name)}">Acheter</button><button class="btn ghost cart-add" data-name="${esc(p.name)}" aria-label="Ajouter au panier" title="Ajouter au panier">🛒</button></div>
      </article>`).join("")}</div>
    <div class="orders"><h3>Vos achats</h3><div id="orders-list"><p class="muted">Chargement…</p></div></div></section>`,
  faq: () => `<section class="block narrow"><h2>FAQ</h2>${SITE_DATA.faq.map(i => `<details><summary>${i.q}</summary><p>${i.a}</p></details>`).join("")}</section>`,
  legal: () => `<section class="block narrow"><h2>Nos Modèles</h2>${SITE_DATA.legal.map(t => `<p class="legal">${t}</p>`).join("")}</section>`,
  media: () => `<section class="block"><h2>Médias</h2><div id="media-list" class="media-grid"><p class="muted">Chargement…</p></div></section>`
};

let currentKey = null;
const router = () => {
  const key = pages[location.hash.slice(1)] ? location.hash.slice(1) : "home";
  if (currentKey === "simulator" && key !== "simulator") Simulator.destroy();
  currentKey = key;
  $("app").innerHTML = pages[key]();
  document.querySelectorAll("[data-nav]").forEach(a => a.removeAttribute("aria-current"));
  const act = document.querySelector(`[data-nav="${key}"]`); if (act) act.setAttribute("aria-current", "page");
  $("menu").classList.remove("open"); $("burger").setAttribute("aria-expanded", "false");
  window.scrollTo(0, 0);
  if (key === "simulator") Simulator.mount($("sim-root"));
  if (key === "media") renderMedia();
  if (key === "pricing") {
    document.querySelectorAll(".buy-btn").forEach(b => b.onclick = () => initiatePayment(b.dataset.name, b));
    document.querySelectorAll(".cart-add").forEach(b => b.onclick = () => { addToCart(b.dataset.name); b.textContent = "✓"; setTimeout(() => b.textContent = "🛒", 1000); });
    refreshOrders();
  }
};

// ---------- Profil (photo) ----------
function setAvatar() {
  const img = $("nav-avatar"), initial = esc((user.displayName || user.email || "?").charAt(0).toUpperCase());
  img.src = safeUrl(user.photoURL) || "data:image/svg+xml," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' fill='#0e131d'/><text x='20' y='27' font-size='20' text-anchor='middle' fill='#d4af37' font-family='Arial'>${initial}</text></svg>`);
  img.style.display = "block";
}
function initProfile() {
  setAvatar();
  $("nav-avatar").onclick = () => $("profile-modal").classList.remove("hidden");
  $("profile-input").onchange = async e => {
    const file = e.target.files[0], st = $("profile-status"); if (!file) return;
    if (!file.type.startsWith("image/")) { st.textContent = "Choisissez une image."; return; }
    if (file.size > 5 * 1024 * 1024) { st.textContent = "Image trop lourde (max 5 Mo)."; return; }
    st.textContent = "Envoi en cours…";
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("upload_preset", CLOUDINARY_PRESET);
      const r = await fetch(CLOUDINARY_URL, { method: "POST", body: fd });
      if (!r.ok) throw new Error("upload");
      const d = await r.json();
      await updateProfile(user, { photoURL: d.secure_url });
      setAvatar(); st.textContent = "✅ Photo mise à jour.";
    } catch (err) { st.textContent = "❌ Échec de l'envoi."; }
  };
}

// ---------- Démarrage ----------
const start = async () => {
  const isAuth = await Auth.require();
  if (!isAuth) return;
  user = Auth.current();
  await loadPacks();
  document.body.hidden = false;

  $("nav-brand").textContent = CONFIG.brand;
  $("footer-brand").textContent = CONFIG.brand;
  $("year").textContent = new Date().getFullYear();
  $("nav-cta").href = CONFIG.telegram;
  $("user-name").textContent = user.displayName || (user.email || "").split("@")[0];
  $("logout").onclick = () => Auth.logout();
  $("burger").onclick = () => { const o = $("menu").classList.toggle("open"); $("burger").setAttribute("aria-expanded", String(o)); };

  user.getIdTokenResult().then(r => {
    if (r.claims.admin === true) {
      const a = document.createElement("a");
      a.href = "admin.html"; a.textContent = "Admin"; a.className = "btn small"; a.style.marginLeft = "1rem";
      document.querySelector(".user").prepend(a);
    }
  }).catch(() => {});

  initProfile();
  $("cart-btn").onclick = () => { renderCart(); $("cart-modal").classList.remove("hidden"); };
  $("checkout-btn").onclick = () => {
    const cart = getCart(); if (!cart.length) return;
    const param = ("order_" + cart.map(slug).join("-")).slice(0, 60);
    window.open(CONFIG.telegram + "?start=" + encodeURIComponent(param), "_blank", "noopener");
  };
  renderCart();

  addEventListener("hashchange", router);
  router();
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
EOF
echo "✅ js/app.js"

cat > index.html << 'EOF'
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GOANGEL | Moteur de prédiction football</title>
  <meta name="description" content="Moteur d'analyse football : XGBoost, Poisson, Dixon-Coles. Probabilités calibrées.">
  <meta name="theme-color" content="#07090f">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚽</text></svg>">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,800&family=Inter:wght@400;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="css/style.css">
</head>
<body hidden>
  <canvas id="bg" aria-hidden="true"></canvas>
  <header class="nav">
    <a href="#home" class="logo" id="nav-brand"></a>
    
    <div class="nav-icons">
      <button id="cart-btn" class="icon-btn" aria-label="Panier">🛒<span id="cart-count" class="cart-count">0</span></button>
      <img id="nav-avatar" class="user-avatar" src="" alt="Profil" title="Changer de photo" style="display:none;">
    </div>

    <button id="burger" class="burger" aria-label="Menu" aria-expanded="false" aria-controls="menu">☰</button>
    <nav id="menu" class="menu">
      <a href="#home" data-nav="home">Accueil</a>
      <a href="#features" data-nav="features">Technologie</a>
      <a href="#simulator" data-nav="simulator">Simulateur</a>
      <a href="#media" data-nav="media">Médias</a>
      <a href="#pricing" data-nav="pricing">Tarifs</a>
      <a href="#faq" data-nav="faq">FAQ</a>
      <a href="#legal" data-nav="legal">Nos Modèles</a>
      <a id="nav-cta" class="btn small" target="_blank" rel="noopener" href="#">Lancer le bot</a>
      <span class="user">
        <span id="user-name"></span> · <button id="logout" class="link">Déconnexion</button>
      </span>
    </nav>
  </header>
  
  <main id="app"></main>
  
  <footer class="footer">
    <p>&copy; <span id="year"></span> <span id="footer-brand"></span>. Tous droits réservés.</p>
    <p class="muted">Les performances passées ne garantissent pas les résultats futurs. Réservé aux adultes.</p>
  </footer>

  <!-- Modale Profil -->
  <div id="profile-modal" class="modal hidden">
    <div class="modal-content">
      <button class="modal-close" onclick="document.getElementById('profile-modal').classList.add('hidden')">×</button>
      <h2 style="color:var(--gold); margin-bottom:1rem;">Photo de profil</h2>
      <input type="file" id="profile-input" accept="image/*" style="margin-bottom:1rem; width:100%;">
      <p id="profile-status" style="color:var(--gold); font-size:0.9rem;"></p>
    </div>
  </div>

  <!-- Modale Panier -->
  <div id="cart-modal" class="modal hidden">
    <div class="modal-content">
      <button class="modal-close" onclick="document.getElementById('cart-modal').classList.add('hidden')">×</button>
      <h2 style="color:var(--gold); margin-bottom:1rem;">Votre Panier</h2>
      <div id="cart-items"></div>
      <div style="margin-top:1rem; font-weight:bold; display:flex; justify-content:space-between;">
        <span>Total :</span>
        <span id="cart-total">0 USDT</span>
      </div>
      <button id="checkout-btn" class="btn" style="width:100%; margin-top:1rem;">Commander sur Telegram</button>
    </div>
  </div>

  <script src="js/config.js"></script>
  <script type="module" src="js/auth.js"></script>
  <script src="js/data.js"></script>
  <script src="js/background.js"></script>
  <script src="js/simulator.js"></script>
  <script type="module" src="js/app.js"></script>
  <script src="js/ai-assistant.js"></script>
</body>
</html>
EOF
echo "✅ index.html"

cat > admin.html << 'EOF'
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Administration | GOANGEL</title>
  <meta name="robots" content="noindex">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚽</text></svg>">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,800&family=Inter:wght@400;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="css/style.css">
  <style>
    .admin-container { max-width: 1200px; margin: 2rem auto; padding: 0 1rem; }
    .admin-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
    .admin-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
    @media (max-width: 768px) { .admin-grid { grid-template-columns: 1fr; } }
    .admin-card { background: rgba(10,15,26,.72); backdrop-filter: blur(14px); border: 1px solid var(--line); border-radius: 12px; padding: 1.5rem; }
    .admin-card h2 { color: var(--gold); margin-bottom: 1rem; font-size: 1.3rem; }
    .form-group { margin-bottom: 1rem; }
    .form-group label { display: block; margin-bottom: .3rem; color: var(--muted); font-size: .9rem; }
    .form-group input, .form-group textarea, .form-group select { width: 100%; padding: .7rem; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font-size: 1rem; }
    .form-group input:focus, .form-group textarea:focus { border-color: var(--gold); outline: 0; }
    .admin-list { list-style: none; margin-top: 1rem; }
    .admin-list li { display: flex; justify-content: space-between; align-items: center; padding: .8rem; border-bottom: 1px solid var(--line); }
    .admin-list li:last-child { border-bottom: 0; }
    .admin-list .item-info { flex: 1; }
    .admin-list .item-info strong { display: block; }
    .admin-list .item-info small { color: var(--muted); }
    .admin-list .item-actions { display: flex; gap: .5rem; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <canvas id="bg" aria-hidden="true"></canvas>
  <main class="admin-container">
    <div class="admin-header">
      <h1>Administration GOANGEL</h1>
      <a href="index.html" class="btn small ghost">Retour au site</a>
    </div>
    <div id="admin-content" class="hidden">
      <div class="admin-grid">
        <div class="admin-card">
          <h2>Gérer les packs</h2>
          <form id="pack-form">
            <input type="hidden" id="pack-id">
            <div class="form-group">
              <label>Nom du pack</label>
              <input type="text" id="pack-name" required>
            </div>
            <div class="form-group">
              <label>Prix (USDT)</label>
              <input type="number" id="pack-price" min="1" max="5000" step="0.01" required>
              <p class="form-hint">Prix facturé en USDT (TRC-20). Le fichier ZIP doit se nommer &lt;nom-du-pack-en-minuscules&gt;.zip (ex. starter.zip) dans Google Drive : gdrive:goangel_packs.</p>
            </div>
            <div class="form-group">
              <label>Description (une ligne par avantage)</label>
              <textarea id="pack-features" rows="3" required></textarea>
            </div>
            <div class="form-group">
              <label>Pack recommandé ?</label>
              <select id="pack-featured">
                <option value="false">Non</option>
                <option value="true">Oui</option>
              </select>
            </div>
            <button type="submit" class="btn" id="pack-submit">Ajouter le pack</button>
            <button type="button" class="btn ghost" id="pack-cancel" style="display:none;">Annuler</button>
          </form>
          <ul class="admin-list" id="pack-list"></ul>
        </div>
        <div class="admin-card">
          <h2>Gérer les médias</h2>
          <form id="media-form">
            <div class="form-group">
              <label>Type de média</label>
              <select id="media-type">
                <option value="image">Image</option>
                <option value="video">Vidéo</option>
                <option value="audio">Audio</option>
                <option value="document">Document</option>
                <option value="text">Texte</option>
              </select>
            </div>
            <div class="form-group" id="file-group">
              <label>Fichier</label>
              <input type="file" id="media-file">
            </div>
            <div class="form-group hidden" id="text-group">
              <label>Texte à publier</label>
              <textarea id="media-text" rows="4" maxlength="5000"></textarea>
            </div>
            <div class="form-group">
              <label>Titre / description (optionnel)</label>
              <input type="text" id="media-desc">
            </div>
            <p id="media-status" style="font-size:0.9rem; margin-bottom:0.5rem; min-height:1.2rem;"></p>
            <button type="submit" class="btn">Téléverser</button>
          </form>
          <ul class="admin-list" id="media-list"></ul>
        </div>
      </div>
    </div>
    <div id="admin-denied" class="admin-card hidden">
      <h2>Accès refusé</h2>
      <p>Vous n'avez pas les droits d'administration.</p>
    </div>
  </main>

  <!-- Modale de confirmation -->
  <div id="confirm-modal" class="modal hidden">
    <div class="modal-content">
      <h2 id="confirm-title" style="color:var(--gold); margin-bottom:1rem;">Confirmation</h2>
      <p id="confirm-message">Êtes-vous sûr ?</p>
      <div class="confirm-actions">
        <button id="confirm-cancel" class="btn ghost">Annuler</button>
        <button id="confirm-ok" class="btn btn-danger">Supprimer</button>
      </div>
    </div>
  </div>

  <script src="js/config.js"></script>
  <script type="module" src="js/auth.js"></script>
  <script type="module" src="js/admin.js"></script>
</body>
</html>
EOF
echo "✅ admin.html"

cat > README.md << 'EOF'
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
Placez les ZIP dans `./packs` avec des noms en minuscules : `starter.zip`, `pro.zip`, `elite.zip` (nom du pack, minuscules, espaces → tirets).
Actions → **Upload Packs to Google Drive** → *Run workflow*.
⚠️ Les fichiers d'un dépôt servi par GitHub Pages sont **publics**. Gardez `packs/` sur une branche qui n'est pas celle de Pages (ex. `packs-storage`) ou dans un dépôt privé, et indiquez-la dans le champ `source_ref` du workflow ; ne la fusionnez jamais dans la branche publiée.

## Téléchargement sécurisé
`POST /api/download-token/{id}` (connecté, commande payée) → lien signé valable 2 min → `GET /api/download/{id}?token=…` : le serveur récupère le ZIP sur Drive (rclone), le renvoie en `FileResponse` puis supprime le fichier temporaire. 3 téléchargements simultanés maximum, dossier temporaire distinct par téléchargement.

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
EOF
echo "✅ README.md"

echo; echo "Terminé. Vérifiez avec : git status ; puis : bash deploy.sh \"migration Google Drive\""