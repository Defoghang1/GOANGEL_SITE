import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

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
session = requests.Session()

SYSTEM_PROMPT = "Tu es l'assistant de GOANGEL. Packs: Starter 25k, Pro 75k, Elite 150k FCFA. Analyse football (XGBoost, Poisson). Réponds brièvement."

class ChatRequest(BaseModel):
    message: str = Field(..., max_length=300)

class ChatResponse(BaseModel):
    response: str

@app.get("/api/health")
def health_check():
    return {"status": "ok", "model": MODEL_NAME}

@app.post("/api/chat", response_model=ChatResponse)
def chat(request: ChatRequest):
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message vide.")

    full_prompt = f"{SYSTEM_PROMPT}\nClient: {request.message.strip()}\nAssistant:"

    payload = {
        "model": MODEL_NAME,
        "prompt": full_prompt,
        "stream": False,
        "keep_alive": -1,
        "options": {
            "temperature": 0.6,
            "num_predict": 60,
            "num_ctx": 1024,
            "stop": ["\n\n", "Client:", "Assistant:"]
        },
    }

    try:
        response = session.post(OLLAMA_URL, json=payload, timeout=60)
        response.raise_for_status()
        bot_reply = response.json().get("response", "").strip()
        if not bot_reply:
            bot_reply = "Désolé, je n'ai pas pu générer de réponse."
        return ChatResponse(response=bot_reply)
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="Timeout de l'IA.")
    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=503, detail="Ollama n'est pas joignable.")
    except Exception:
        raise HTTPException(status_code=500, detail="Erreur interne.")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
