import os
import re
import json
import time
import base64
from collections import defaultdict, deque
from typing import Optional

import requests
import boto3
import firebase_admin
from firebase_admin import credentials, firestore, auth as fb_auth
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from botocore.config import Config

# ⚠️ Ne JAMAIS ajouter app.mount("/", StaticFiles(...)) : l'API ne sert que des routes /api/*.
app = FastAPI(title="GOANGEL Server", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://goangel.dpdns.org", "https://www.goangel.dpdns.org"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# --- FIREBASE (Firestore + vérification des jetons) ---
db = None
try:
    firebase_cred_b64 = os.environ.get("FIREBASE_CREDENTIALS")
    if firebase_cred_b64:
        firebase_admin.initialize_app(credentials.Certificate(json.loads(base64.b64decode(firebase_cred_b64))))
        db = firestore.client()
    else:
        print("⚠️ FIREBASE_CREDENTIALS non configuré.")
except Exception as e:
    print(f"❌ Initialisation Firebase impossible : {e}")
    db = None

# --- BACKBLAZE B2 ---
B2_BUCKET = os.environ.get("B2_BUCKET_NAME")
s3_client = None
try:
    if os.environ.get("B2_ACCESS_KEY_ID") and os.environ.get("B2_ENDPOINT_URL"):
        s3_client = boto3.client(
            "s3",
            endpoint_url=os.environ.get("B2_ENDPOINT_URL"),
            region_name=os.environ.get("B2_REGION"),
            aws_access_key_id=os.environ.get("B2_ACCESS_KEY_ID"),
            aws_secret_access_key=os.environ.get("B2_SECRET_ACCESS_KEY"),
            config=Config(signature_version="s3v4"),
        )
except Exception as e:
    print(f"❌ Initialisation B2 impossible : {e}")

# --- NOWPAYMENTS ---
NOWPAYMENTS_API_KEY = os.environ.get("CRYPTO_API_KEY")
NOWPAYMENTS_URL = "https://api.nowpayments.io/v1"
print(f"🔑 NOWPayments: {bool(NOWPAYMENTS_API_KEY)} | Firebase: {db is not None} | B2: {s3_client is not None}")

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


def get_order(payment_id: str, uid: str) -> dict:
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
        "firebase": db is not None, "storage": s3_client is not None,
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


@app.get("/api/download/{payment_id}")
def download_file(payment_id: str, authorization: Optional[str] = Header(None)):
    uid = current_uid(authorization)
    if s3_client is None:
        raise HTTPException(status_code=503, detail="Stockage non configuré côté serveur (secrets B2_*).")
    order = get_order(payment_id, uid)
    if order.get("status") != "paid":
        raise HTTPException(status_code=403, detail="Paiement non validé.")
    file_key = f"packs/{slug(order['pack_name'])}.zip"
    try:
        s3_client.head_object(Bucket=B2_BUCKET, Key=file_key)
    except Exception:
        raise HTTPException(status_code=404, detail=f"Fichier {file_key} introuvable sur le stockage.")
    try:
        url = s3_client.generate_presigned_url("get_object", Params={"Bucket": B2_BUCKET, "Key": file_key}, ExpiresIn=300)
        return {"download_url": url}
    except Exception:
        raise HTTPException(status_code=500, detail="Erreur génération du lien.")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
