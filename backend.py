import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ⚠️ Ne JAMAIS ajouter app.mount("/", StaticFiles(...)) : l'API ne sert que /api/health et /api/chat.
app = FastAPI(title="GOANGEL Server", docs_url=None, redoc_url=None)

origins = [
    "https://goangel.dpdns.org",
    "https://www.goangel.dpdns.org",
    "http://localhost",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL_NAME = "phi3:mini"

SYSTEM_PROMPT = (
    "Tu es l'assistant commercial de GOANGEL AI ENGINE, un bot Telegram de prédictions footballistiques. "
    "Tes packs sont : Starter (25 000 FCFA), Pro (75 000 FCFA), Elite (150 000 FCFA). "
    "Ton avantage : XGBoost, Poisson, Dixon-Coles, Zéro Data Leakage. "
    "Tu ne promets jamais de gains : c'est un outil d'analyse statistique. "
    "Réponds à la question du client de manière courte, professionnelle et convaincante."
)


class ChatRequest(BaseModel):
    message: str = Field(..., max_length=500)


class ChatResponse(BaseModel):
    response: str


@app.get("/api/health")
def health_check():
    return {"status": "ok", "model": MODEL_NAME}


@app.post("/api/chat", response_model=ChatResponse)
def chat(request: ChatRequest):
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Le message ne peut pas être vide.")

    full_prompt = f"{SYSTEM_PROMPT}\n\nClient: {request.message.strip()}\nAssistant:"

    payload = {
        "model": MODEL_NAME,
        "prompt": full_prompt,
        "stream": False,
        "keep_alive": -1,        # garde le modèle en RAM en permanence
        "options": {
            "temperature": 0.7,
            "num_predict": 100,  # réponse courte = réponse rapide
            "num_ctx": 2048,
        },
    }

    try:
        response = requests.post(OLLAMA_URL, json=payload, timeout=120)
        response.raise_for_status()
        bot_reply = response.json().get("response", "").strip()
        if not bot_reply:
            bot_reply = "Désolé, je n'ai pas pu générer de réponse."
        return ChatResponse(response=bot_reply)
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="L'IA a mis trop de temps à répondre.")
    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=503, detail="Le moteur IA (Ollama) n'est pas joignable.")
    except Exception:
        raise HTTPException(status_code=500, detail="Erreur interne du serveur IA.")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
