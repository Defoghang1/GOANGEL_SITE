import os
import json
import time
import base64
import requests
import boto3
import firebase_admin
from firebase_admin import credentials, firestore
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from botocore.config import Config

app = FastAPI(title="GOANGEL Server", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://goangel.dpdns.org", "https://www.goangel.dpdns.org"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# --- INITIALISATION FIREBASE ---
firebase_cred_b64 = os.environ.get("FIREBASE_CREDENTIALS")
if firebase_cred_b64:
    cred_dict = json.loads(base64.b64decode(firebase_cred_b64))
    cred = credentials.Certificate(cred_dict)
    firebase_admin.initialize_app(cred)
    db = firestore.client()
else:
    print("⚠️ FIREBASE_CREDENTIALS non configuré.")
    db = None

# --- INITIALISATION BACKBLAZE B2 ---
B2_ACCESS_KEY = os.environ.get("B2_ACCESS_KEY_ID")
B2_SECRET_KEY = os.environ.get("B2_SECRET_ACCESS_KEY")
B2_BUCKET = os.environ.get("B2_BUCKET_NAME")
B2_ENDPOINT = os.environ.get("B2_ENDPOINT_URL")
B2_REGION = os.environ.get("B2_REGION")

s3_client = boto3.client(
    's3',
    endpoint_url=B2_ENDPOINT,
    region_name=B2_REGION,
    aws_access_key_id=B2_ACCESS_KEY,
    aws_secret_access_key=B2_SECRET_KEY,
    config=Config(signature_version='s3v4')
) if B2_ACCESS_KEY and B2_ENDPOINT else None

# --- INITIALISATION NOWPAYMENTS ---
NOWPAYMENTS_API_KEY = os.environ.get("CRYPTO_API_KEY")
NOWPAYMENTS_URL = "https://api.nowpayments.io/v1"

print(f"🔑 Clé API NOWPayments présente : {bool(NOWPAYMENTS_API_KEY)}")

# --- OLLAMA ---
OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL_NAME = "phi3:mini"
SYSTEM_PROMPT = "Tu es l'assistant commercial de GOANGEL, expert en analyse de données footballistiques. Tes packs sont : Starter (25k FCFA), Pro (75k FCFA), Elite (150k FCFA). Réponds de manière professionnelle et brève."

class ChatRequest(BaseModel):
    message: str = Field(..., max_length=300)
class ChatResponse(BaseModel):
    response: str
class PaymentRequest(BaseModel):
    pack_name: str
    price_usd: float

@app.get("/api/health")
def health_check():
    return {"status": "ok", "model": MODEL_NAME, "firebase": db is not None, "storage": s3_client is not None, "nowpayments_key": bool(NOWPAYMENTS_API_KEY)}

@app.post("/api/chat", response_model=ChatResponse)
def chat(request: ChatRequest):
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message vide.")
    payload = {
        "model": MODEL_NAME, "prompt": f"{SYSTEM_PROMPT}\nClient: {request.message}\nAssistant:",
        "stream": False, "keep_alive": -1,
        "options": {"temperature": 0.6, "num_predict": 60, "num_ctx": 1024}
    }
    try:
        response = requests.post(OLLAMA_URL, json=payload, timeout=60)
        return ChatResponse(response=response.json().get("response", "").strip())
    except Exception:
        raise HTTPException(status_code=500, detail="Erreur IA.")

@app.post("/api/create-payment")
def create_payment(req: PaymentRequest):
    if not NOWPAYMENTS_API_KEY:
        print("❌ ERREUR : Clé API NOWPayments manquante.")
        raise HTTPException(status_code=500, detail="Clé API Crypto non configurée.")
    
    headers = {"x-api-key": NOWPAYMENTS_API_KEY, "Content-Type": "application/json"}
    
    # On force le prix à être un nombre flottant propre
    price = round(float(req.price_usd), 2)
    
    payload = {
        "price_amount": price,
        "price_currency": "usd",
        "pay_currency": "usdttrc20",
        "order_id": f"GOANGEL_{int(time.time())}_{req.pack_name}",
        "order_description": f"Achat du pack {req.pack_name}"
    }
    
    print(f"📤 Envoi à NOWPayments : {json.dumps(payload)}")
    
    try:
        res = requests.post(f"{NOWPAYMENTS_URL}/payment", json=payload, headers=headers, timeout=30)
        print(f"📥 Réponse NOWPayments : {res.status_code} - {res.text}")
        
        res.raise_for_status()
        data = res.json()
        
        if db:
            db.collection("orders").document(data["payment_id"]).set({
                "pack_name": req.pack_name,
                "price_usd": price,
                "status": "waiting",
                "pay_address": data["pay_address"],
                "created_at": firestore.SERVER_TIMESTAMP
            })
            
        return {"payment_id": data["payment_id"], "pay_address": data["pay_address"], "amount": data["pay_amount"], "currency": data["pay_currency"]}
    except requests.exceptions.HTTPError as e:
        print(f"❌ HTTP Error : {e}")
        raise HTTPException(status_code=500, detail=f"Erreur NOWPayments : {res.text}")
    except Exception as e:
        print(f"❌ Exception : {e}")
        raise HTTPException(status_code=500, detail="Erreur interne du serveur.")

@app.get("/api/check-payment/{payment_id}")
def check_payment(payment_id: str):
    headers = {"x-api-key": NOWPAYMENTS_API_KEY}
    try:
        res = requests.get(f"{NOWPAYMENTS_URL}/payment/{payment_id}", headers=headers, timeout=30)
        res.raise_for_status()
        data = res.json()
        status = data["payment_status"]
        if status in ["confirmed", "finished"]:
            if db:
                db.collection("orders").document(payment_id).update({"status": "paid"})
            return {"status": "paid"}
        return {"status": "waiting"}
    except Exception:
        raise HTTPException(status_code=500, detail="Erreur vérification.")

@app.get("/api/download/{payment_id}")
def download_file(payment_id: str):
    if not db or not s3_client:
        raise HTTPException(status_code=500, detail="Stockage non configuré.")
        
    doc = db.collection("orders").document(payment_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Commande introuvable.")
    order = doc.to_dict()
    if order.get("status") != "paid":
        raise HTTPException(status_code=403, detail="Paiement non validé.")
        
    file_key = f"packs/{order['pack_name'].lower()}.zip"
    try:
        url = s3_client.generate_presigned_url(
            'get_object',
            Params={'Bucket': B2_BUCKET, 'Key': file_key},
            ExpiresIn=300
        )
        return {"download_url": url}
    except Exception:
        raise HTTPException(status_code=500, detail="Erreur génération lien.")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
