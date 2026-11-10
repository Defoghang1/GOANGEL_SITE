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
