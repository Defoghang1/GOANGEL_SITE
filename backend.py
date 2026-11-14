import os
import re
import atexit
import socket
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
from datetime import datetime, timezone
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
RCLONE_REMOTE = "gdrive_wadoum:goangel_packs"
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


class PromoRequest(BaseModel):
    code: str = Field("", max_length=40)


class PaymentRequest(BaseModel):
    product_id: Optional[str] = Field(None, max_length=60)
    pack_name: Optional[str] = Field(None, max_length=60)      # ancien nom du champ, toujours accepté
    promo_code: Optional[str] = Field(None, max_length=40)


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


# ---------- Catalogue : Google Drive = source de vérité de la DISPONIBILITÉ ----------
CATALOG_FILE = os.environ.get("CATALOG_FILE") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "catalog.json")
RECENT_DAYS = 14
OUT_OF_STOCK_MESSAGE = ("Ce logiciel est actuellement épuisé. Nous préparons l'arrivée de nouvelles marques ou versions. "
                        "Merci de patienter, le produit sera de nouveau disponible dès son réapprovisionnement.")
UNKNOWN_MESSAGE = "La disponibilité de ce logiciel est en cours de vérification (Google Drive injoignable). Réessayez dans un instant."
# <id>.zip ou <id>-vX.Y.Z.zip (en minuscules pour la comparaison)
FILE_NAME_RE = re.compile(r"^(?P<id>[a-z0-9]+(?:-[a-z0-9]+)*?)(?:[-_]v(?P<ver>\d+(?:\.\d+){0,3}))?\.zip$")
SAFE_FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.zip$")
LIST_FIELDS = ("features", "benefits", "technologies", "included_files", "requirements", "compatibility", "usage")
TEXT_FIELDS = ("tagline", "description", "long_description", "updates", "delivery", "icon")
PUBLIC_KEYS = ("id", "name", "tagline", "description", "long_description", "features", "benefits", "technologies",
               "included_files", "requirements", "compatibility", "usage", "updates", "delivery", "icon", "image_url",
               "featured", "order")


class DriveError(Exception):
    pass


def _as_list(v):
    if isinstance(v, str):
        v = v.splitlines()
    if not isinstance(v, (list, tuple)):
        return []
    return [str(x).strip()[:300] for x in v if str(x).strip()][:30]


def normalize_product(raw: dict) -> Optional[dict]:
    """Nettoie une définition de produit (catalog.json ou Firestore) ; ne garde que des champs connus."""
    name = str(raw.get("name") or "").strip()[:60]
    pid = slug(raw.get("id") or name)
    if not name or not pid:
        return None
    p = {"id": pid, "name": name}
    try:
        price = float(raw.get("price_usdt", raw.get("price")))
        if 0 < price <= MAX_PRICE_USD:
            p["price_usdt"] = round(price, 2)
        else:
            print(f"⚠️ Prix hors limites ignoré pour « {pid} ».")
    except (TypeError, ValueError):
        pass
    for k in LIST_FIELDS:
        lst = _as_list(raw.get(k))
        if lst:
            p[k] = lst
    for k in TEXT_FIELDS:
        if raw.get(k):
            p[k] = str(raw[k]).strip()[:4000]
    if str(raw.get("image_url") or "").startswith("https://"):
        p["image_url"] = str(raw["image_url"]).strip()[:500]
    for k in ("version", "pinned_version"):
        if raw.get(k):
            p[k] = str(raw[k]).strip()[:20]
    if "featured" in raw:
        p["featured"] = bool(raw["featured"])
    try:
        p["order"] = int(raw["order"])
    except (KeyError, TypeError, ValueError):
        pass
    if raw.get("hidden"):
        p["hidden"] = True
    return p


def load_base_catalog() -> dict:
    try:
        with open(CATALOG_FILE, encoding="utf-8") as f:
            data = json.load(f)
        prods = [normalize_product(x) for x in data.get("products", []) if isinstance(x, dict)]
        return {"promo": data.get("promo") or {}, "products": [p for p in prods if p]}
    except Exception as e:
        print(f"⚠️ catalog.json illisible ({type(e).__name__}) : catalogue minimal utilisé.")
        mini = [normalize_product({"name": n.capitalize(), "price_usdt": v, "order": i}) for i, (n, v) in enumerate(DEFAULT_PRICES.items())]
        return {"promo": {}, "products": mini}


def normalize_promo(raw: dict) -> dict:
    """Offre promotionnelle saisie dans l'admin (Firestore settings/promo)."""
    code = re.sub(r"[^A-Za-z0-9_-]", "", str(raw.get("code") or "")).upper()[:30]
    try:
        pct = float(raw.get("percent") or 0)
    except (TypeError, ValueError):
        pct = 0.0
    return {"enabled": raw.get("enabled") is True, "code": code, "percent": pct,
            "pack": slug(raw.get("pack") or ""), "message": str(raw.get("message") or "").strip()[:200],
            "expires": (str(raw.get("expires") or "").strip()[:25] or None), "banner": raw.get("banner") is not False}


def load_promo_doc():
    """dict = offre définie dans l'admin ; None = aucune (catalog.json sert de valeur par défaut) ; False = lecture impossible."""
    if db is None:
        return False
    ref = db.collection("settings").document("promo")
    try:
        snap = ref.get(timeout=10)
    except TypeError:
        snap = ref.get()
    return normalize_promo(snap.to_dict() or {}) if snap.exists else None


def load_overrides():
    """Produits saisis dans l'admin (Firestore « packs ») ; None si Firestore est indisponible."""
    if db is None:
        return None
    out = []
    col = db.collection("packs")
    try:
        docs = col.stream(timeout=15)           # jamais d'attente infinie sur Firestore
    except TypeError:
        docs = col.stream()
    for d in docs:
        n = normalize_product(d.to_dict() or {})
        if n:
            out.append(n)
    return out


def merge_products(base, overrides) -> list:
    prods = {p["id"]: dict(p) for p in base}
    for o in overrides or []:
        prods[o["id"]] = {**prods.get(o["id"], {}), **o}
    out = [p for p in prods.values() if p.get("price_usdt") and not p.get("hidden")]
    out.sort(key=lambda p: (p.get("order", 999), p["price_usdt"], p["name"]))
    return out


def vtuple(v) -> tuple:
    nums = [int(x) for x in re.findall(r"\d+", str(v))[:4]] or [0]
    return tuple(nums + [0] * (4 - len(nums)))


def pick_file(product: dict, files: dict):
    """Règle de version : version épinglée si son fichier existe ; sinon la plus haute parmi <id>-vX.Y.Z.zip et
    <id>.zip (qui compte comme la version déclarée au catalogue) ; égalité = fichier versionné. Retourne (info, version) ou None."""
    pid = product["id"]
    versioned, unversioned = [], None
    for low, info in files.items():
        m = FILE_NAME_RE.match(low)
        if not m or m.group("id") != pid:
            continue
        if m.group("ver"):
            versioned.append((vtuple(m.group("ver")), m.group("ver"), info))
        else:
            unversioned = info
    if not versioned and unversioned is None:
        return None
    pinned = product.get("pinned_version")
    if pinned:
        for t, v, info in versioned:
            if t == vtuple(pinned):
                return info, v
    best = max(versioned, key=lambda x: x[0]) if versioned else None
    declared = str(product.get("version") or "1.0.0")
    if unversioned is not None and (best is None or vtuple(declared) > best[0]):
        return unversioned, declared
    return best[2], best[1]


def _parse_iso(s):
    try:
        s = re.sub(r"(\.\d{6})\d+", r"\1", str(s)).replace("Z", "+00:00")
        d = datetime.fromisoformat(s)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


# ---------- Liste des ZIP sur Drive : un processus rclone persistant (rcd), sinon rclone lsjson ----------
USE_RCD = os.environ.get("DRIVE_USE_RCD", "1") != "0"
_rcd = {"proc": None, "port": 0, "auth": None, "next_try": 0.0}
_rcd_lock = threading.Lock()
_rcd_http = requests.Session()           # connexion HTTP locale réutilisée (keep-alive) entre deux vérifications


def _rcd_stop():
    p = _rcd.get("proc")
    if p is not None and p.poll() is None:
        try:
            p.terminate()
            p.wait(timeout=5)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
    _rcd["proc"] = None


atexit.register(_rcd_stop)


def _rcd_start() -> bool:
    """Lance (au plus une fois toutes les 30 s) un démon rclone local : plus aucun processus à créer à chaque vérification."""
    with _rcd_lock:
        p = _rcd["proc"]
        if p is not None and p.poll() is None:
            return True
        if RCLONE_CONF_PATH is None or time.time() < _rcd["next_try"]:
            return False
        _rcd["next_try"] = time.time() + 30
        try:
            s = socket.socket()
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
            s.close()
            auth = (secrets.token_hex(8), secrets.token_hex(16))      # accès local protégé, jamais exposé
            env = {k: v for k, v in os.environ.items() if k != "RCLONE_CONFIG"}
            proc = subprocess.Popen(
                ["rclone", "--config", RCLONE_CONF_PATH, "--retries", "3", "rcd", "--rc-addr", f"127.0.0.1:{port}",
                 "--rc-user", auth[0], "--rc-pass", auth[1], "--log-level", "ERROR"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
            deadline = time.time() + 8
            while time.time() < deadline:
                if proc.poll() is not None:
                    return False
                try:
                    if _rcd_http.post(f"http://127.0.0.1:{port}/rc/noop", json={}, auth=auth, timeout=1).status_code == 200:
                        _rcd.update(proc=proc, port=port, auth=auth)
                        print("⚡ Démon rclone local prêt : vérification de Drive sans nouveau processus.")
                        return True
                except requests.exceptions.RequestException:
                    pass
                time.sleep(0.15)
            proc.kill()
        except Exception as e:
            print(f"⚠️ Démon rclone non démarré ({type(e).__name__}) : repli sur rclone lsjson.")
        return False


def _items_via_rcd():
    if not USE_RCD or not _rcd_start():
        return None
    try:
        r = _rcd_http.post(f"http://127.0.0.1:{_rcd['port']}/operations/list", auth=_rcd["auth"], timeout=20,
                          json={"fs": RCLONE_REMOTE, "remote": "", "opt": {"filesOnly": True}})
        if r.status_code == 200:
            return r.json().get("list", [])
        print(f"⚠️ rcd operations/list : HTTP {r.status_code}")
    except (requests.exceptions.RequestException, ValueError):
        pass
    return None


def _items_via_lsjson():
    try:
        res = run_rclone(["lsjson", RCLONE_REMOTE, "--files-only"], timeout=60)
    except subprocess.TimeoutExpired:
        raise DriveError("Google Drive met trop de temps à répondre.")
    if res.returncode != 0:
        print(f"❌ rclone lsjson : {res.stderr[:200]}")
        raise DriveError("Google Drive inaccessible pour le moment.")
    try:
        return json.loads(res.stdout or "[]")
    except ValueError:
        raise DriveError("Réponse Google Drive illisible.")


def fetch_drive_files() -> dict:
    """Liste réelle des ZIP présents sur Drive : une requête de LISTE (jamais de téléchargement de fichier)."""
    if RCLONE_CONF_PATH is None:
        raise DriveError("Stockage Google Drive non configuré côté serveur (secret RCLONE_CONFIG).")
    items = _items_via_rcd()
    if items is None:
        items = _items_via_lsjson()
    files = {}
    for it in items:
        name = str(it.get("Name", ""))
        if it.get("IsDir") or not SAFE_FILE_NAME.match(name) or ".." in name:
            continue
        files[name.lower()] = {"name": name, "size": int(it.get("Size") or 0), "modified": str(it.get("ModTime") or "")}
    return files


def drive_files_or_http() -> dict:
    try:
        return fetch_drive_files()
    except DriveError as e:
        raise HTTPException(status_code=503 if RCLONE_CONF_PATH is None else 502, detail=str(e))


def _files_of(pid: str, files: dict) -> list:
    out = []
    for low, i in files.items():
        m = FILE_NAME_RE.match(low)
        if m and m.group("id") == pid:
            out.append(i["name"])
    return out


def build_snapshot(products, files, drive_state, error, promo_cfg) -> dict:
    now = datetime.now(timezone.utc)
    items, used = [], set()
    for p in products:
        it = dict(p)
        declared = str(p.get("version") or "1.0.0")
        if files is None:
            it.update(state="unknown", file=None, sold_version=declared, archived=[], recent=False)
        else:
            sel = pick_file(p, files)
            others = _files_of(p["id"], files)
            if sel is None:
                it.update(state="unavailable", file=None, sold_version=declared, archived=[], recent=False)
            else:
                info, ver = sel
                mod = _parse_iso(info["modified"])
                it.update(state="available", sold_version=ver,
                          file={"name": info["name"], "size": info["size"], "updated_at": mod.isoformat() if mod else info["modified"]},
                          archived=[n for n in others if n != info["name"]],
                          recent=bool(mod and (now - mod).days <= RECENT_DAYS))
            used.update(n.lower() for n in others)
        items.append(it)
    unlisted = sorted(i["name"] for low, i in (files or {}).items() if low not in used)
    return {"items": items, "unlisted": unlisted, "drive": drive_state, "error": error, "promo": promo_cfg or {},
            "synced_at": now.isoformat(), "ts": time.time()}


# ---------- Synchronisation AUTOMATIQUE avec Google Drive (côté serveur) ----------
DRIVE_POLL_SECONDS = max(0.2, float(os.environ.get("DRIVE_POLL_SECONDS", "2")))   # vérification de Drive
OVERRIDES_RELOAD_SECONDS = 60       # relecture des produits de l'admin (si l'écoute temps réel est indisponible)
GRACE_SECONDS = 30                  # coupure Drive très brève : l'état connu est conservé (les achats revérifient toujours)
STALL_SECONDS = max(30.0, DRIVE_POLL_SECONDS * 15)   # surveillance bloquée au-delà : redémarrage automatique
SUPERVISOR_SECONDS = 10

_state_lock = threading.Lock()      # protège uniquement l'échange d'état en mémoire, jamais un appel réseau
_snapshot = {"items": [], "unlisted": [], "drive": "unknown", "error": None, "promo": {}, "synced_at": None, "ts": 0,
             "version": "", "checked_at": None, "changed_at": None}
_products = None                    # (produits fusionnés, config promo)
_products_key = None
_products_version = 0
_overrides = []
_promo_doc = None                   # offre promo définie dans l'admin (prioritaire sur catalog.json)
_listener_ok = False
_last_build_key = None
_last_good = 0.0
_started = False
_watch = {"gen": 0, "beat": 0.0, "fails": 0}
_base_cache = {"mtime": None, "data": None}


def _log_changes(old, new):
    prev = {i["id"]: i for i in old["items"]}
    for i in new["items"]:
        o = prev.get(i["id"])
        if o is None:
            if old["ts"]:
                print(f"🆕 Produit ajouté au catalogue : {i['id']}")
        elif o["state"] != i["state"]:
            print(f"🔄 {i['id']} : {o['state']} → {i['state']}")
        elif o.get("sold_version") != i.get("sold_version"):
            print(f"🔄 {i['id']} : version {o.get('sold_version')} → {i.get('sold_version')}")
    for pid in prev:
        if pid not in {i['id'] for i in new["items"]}:
            print(f"➖ Produit retiré du catalogue : {pid}")
    if old["drive"] != new["drive"] and old["ts"]:
        print(f"📡 Google Drive : {old['drive']} → {new['drive']}")


def _load_base_cached() -> dict:
    try:
        m = os.stat(CATALOG_FILE).st_mtime
    except OSError:
        m = None
    if _base_cache["data"] is None or _base_cache["mtime"] != m:
        _base_cache.update(mtime=m, data=load_base_catalog())
    return _base_cache["data"]


def load_products(reload_overrides: bool = False):
    """Produits = catalog.json + fiches de l'admin (Firestore). Relit Firestore seulement à la demande."""
    global _products, _products_key, _products_version, _overrides, _promo_doc
    if reload_overrides:
        try:
            ov = load_overrides()
            if ov is not None:
                _overrides = ov
        except Exception as e:
            print(f"⚠️ Lecture des produits Firestore impossible ({type(e).__name__}) : dernière version connue conservée.")
    if reload_overrides:
        try:
            pd = load_promo_doc()
            if pd is not False:
                _promo_doc = pd
        except Exception as e:
            print(f"⚠️ Lecture de l'offre promo impossible ({type(e).__name__}) : dernière version connue conservée.")
    base = _load_base_cached()
    prods = merge_products(base["products"], _overrides)
    promo_cfg = _promo_doc if _promo_doc is not None else base["promo"]
    key = json.dumps([prods, promo_cfg], sort_keys=True, default=str)
    with _state_lock:
        if _products is None or key != _products_key:
            _products, _products_key = (prods, promo_cfg), key
            _products_version += 1


def drive_listing_now():
    global _last_good
    try:
        files = fetch_drive_files()
        _last_good = time.time()
        return files, None
    except DriveError as e:
        return None, str(e)


def _catalog_version(snap: dict, promo) -> str:
    payload = json.dumps([[public_item(i) for i in snap["items"]], promo, snap["drive"]], sort_keys=True, default=str)
    return hashlib.sha1(payload.encode()).hexdigest()[:12]


def rebuild(files, err) -> dict:
    """Reconstruit le catalogue SEULEMENT si quelque chose a changé (fichiers, produits, état Drive, promo)."""
    global _snapshot, _last_build_key
    prods, promo_cfg = _products
    promo = active_promo(promo_cfg)
    state = "ok" if files is not None else ("unconfigured" if RCLONE_CONF_PATH is None else "error")
    sig = hashlib.sha1(json.dumps(sorted((k, v["size"], v["modified"]) for k, v in (files or {}).items())).encode()).hexdigest()
    key = (sig, _products_version, state, json.dumps(promo, sort_keys=True, default=str))
    now = datetime.now(timezone.utc).isoformat()
    if key == _last_build_key:
        with _state_lock:
            _snapshot = {**_snapshot, "checked_at": now, "ts": time.time()}
            return _snapshot
    snap = build_snapshot(prods, files, state, err, promo_cfg)
    snap["version"] = _catalog_version(snap, promo)
    snap["checked_at"] = snap["changed_at"] = snap["synced_at"]
    with _state_lock:
        _log_changes(_snapshot, snap)
        _snapshot, _last_build_key = snap, key
    return snap


def refresh_catalog(reload_overrides: bool = False) -> dict:
    """Vérification immédiate (admin, achat) : relit Drive maintenant, sans attendre la prochaine passe."""
    if _products is None or reload_overrides:
        load_products(reload_overrides)
    files, err = drive_listing_now()
    return rebuild(files, err)


def get_snapshot() -> dict:
    return _snapshot


def _drive_loop(gen: int):
    fails = 0
    while _watch["gen"] == gen:
        t0 = time.time()
        try:
            if _products is None:
                load_products(False)
            files, err = drive_listing_now()
            _watch["beat"] = time.time()
            fails = 0 if files is not None else fails + 1
            _watch["fails"] = fails
            if files is None and _snapshot["drive"] == "ok" and time.time() - _last_good < GRACE_SECONDS:
                pass                                   # coupure brève : on garde l'état connu
            else:
                rebuild(files, err)
        except Exception as e:
            fails += 1
            _watch["fails"] = fails
            print(f"⚠️ Surveillance de Drive : erreur ({type(e).__name__}).")
        pause = DRIVE_POLL_SECONDS if fails == 0 else min(10.0, DRIVE_POLL_SECONDS * 2 ** min(fails, 6))   # recul si Drive refuse
        time.sleep(max(0.05, pause - (time.time() - t0)) if fails == 0 else pause)


def _spawn_drive_loop():
    _watch["gen"] += 1
    _watch["beat"] = time.time()
    threading.Thread(target=_drive_loop, args=(_watch["gen"],), daemon=True, name="drive-watch").start()


def _products_loop():
    last = 0.0
    while True:
        try:
            now = time.time()
            reload = now - last >= (600 if _listener_ok else OVERRIDES_RELOAD_SECONDS)
            load_products(reload)                      # relit aussi catalog.json s'il a changé (simple stat)
            if reload:
                last = now
        except Exception as e:
            print(f"⚠️ Chargement des produits : erreur ({type(e).__name__}).")
        time.sleep(5)


def _supervisor():
    while True:
        time.sleep(SUPERVISOR_SECONDS)
        try:
            if time.time() - _watch["beat"] > STALL_SECONDS:
                print("⚠️ Surveillance de Drive bloquée : redémarrage automatique.")
                _spawn_drive_loop()
        except Exception:
            pass


def _start_overrides_listener():
    """Les fiches produit de l'admin arrivent en temps réel (aucune relecture périodique de Firestore)."""
    global _listener_ok
    if db is None:
        return
    def on_change(col_snapshot, changes, read_time):
        global _overrides
        try:
            out = []
            for d in col_snapshot:
                n = normalize_product(d.to_dict() or {})
                if n:
                    out.append(n)
            _overrides = out
            load_products(False)
        except Exception as e:
            print(f"⚠️ Écoute Firestore : erreur ({type(e).__name__}).")
    def on_promo(doc_snapshots, changes, read_time):
        global _promo_doc
        try:
            d = doc_snapshots[0] if doc_snapshots else None
            _promo_doc = normalize_promo(d.to_dict() or {}) if d is not None and d.exists else None
            load_products(False)
        except Exception as e:
            print(f"⚠️ Écoute de l'offre promo : erreur ({type(e).__name__}).")
    ok_packs = ok_promo = False
    try:
        db.collection("packs").on_snapshot(on_change)
        ok_packs = True
    except Exception as e:
        print(f"⚠️ Écoute temps réel des produits indisponible ({type(e).__name__}) : relecture toutes les {OVERRIDES_RELOAD_SECONDS} s.")
    try:
        db.collection("settings").document("promo").on_snapshot(on_promo)
        ok_promo = True
    except Exception as e:
        print(f"⚠️ Écoute temps réel de l'offre promo indisponible ({type(e).__name__}) : relecture toutes les {OVERRIDES_RELOAD_SECONDS} s.")
    _listener_ok = ok_packs and ok_promo          # relecture lente de secours seulement si TOUT est écouté en temps réel


def start_background():
    global _started
    if _started:
        return
    _started = True
    load_products(False)                               # la boutique est utilisable dès le démarrage
    _start_overrides_listener()
    threading.Thread(target=_products_loop, daemon=True, name="products").start()
    _spawn_drive_loop()
    threading.Thread(target=_supervisor, daemon=True, name="watch-supervisor").start()
    print(f"🔁 Synchronisation Drive automatique : vérification toutes les {DRIVE_POLL_SECONDS:g} s.")


def public_item(it: dict) -> dict:
    out = {k: it[k] for k in PUBLIC_KEYS if k in it}
    st = it["state"]
    out.update(price_usdt=it["price_usdt"], version=it["sold_version"], state=st, available=(st == "available"),
               file=it["file"], recently_updated=it["recent"],
               message=OUT_OF_STOCK_MESSAGE if st == "unavailable" else (UNKNOWN_MESSAGE if st == "unknown" else ""))
    return out


def active_promo(cfg: dict) -> Optional[dict]:
    """Promotion réellement utilisable (activée, code valide, non expirée) ou None."""
    try:
        if not cfg or not cfg.get("enabled"):
            return None
        code = str(cfg.get("code") or "").strip().upper()
        pct = float(cfg.get("percent") or 0)
        if not code or not (0 < pct <= 90):          # plafond de sécurité : une faute de frappe ne peut pas offrir un pack
            return None
        exp = cfg.get("expires")
        if exp:
            d = _parse_iso(str(exp) + ("T23:59:59" if len(str(exp)) <= 10 else ""))
            if d is None or d < datetime.now(timezone.utc):
                return None
        return {"code": code, "percent": pct, "pack_id": slug(cfg.get("pack") or "") or None,
                "message": str(cfg.get("message") or f"-{pct:g}% avec le code {code}")[:200], "expires": exp or None,
                "banner": cfg.get("banner") is not False}
    except Exception:
        return None


def _mine(promo: dict) -> dict:
    return {"code": promo["code"], "percent": promo["percent"], "pack_id": promo["pack_id"]}


def my_promo_for(uid: str, promo: Optional[dict]) -> Optional[dict]:
    """Réduction de CE compte uniquement : il faut qu'il ait lui-même appliqué le code en vigueur."""
    if not promo or db is None:
        return None
    try:
        snap = db.collection("promo_redemptions").document(uid).get()
        d = snap.to_dict() if snap.exists else None
    except Exception:
        return None
    return _mine(promo) if d and d.get("code") == promo["code"] else None


def verified_product(product_id: str):
    """Revérifie Drive AU MOMENT de l'achat : jamais de paiement pour un fichier absent ou invérifiable."""
    if _products is None:
        load_products(True)
    files, err = drive_listing_now()                   # liste fraîche (jamais le cache de la surveillance)
    if files is None:
        raise HTTPException(status_code=503, detail="Impossible de vérifier la disponibilité du logiciel (Google Drive injoignable). Aucun paiement n'a été créé, réessayez dans un instant.")
    snap = rebuild(files, None)
    item = next((i for i in snap["items"] if i["id"] == product_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="Pack inconnu.")
    if item["state"] == "unavailable":
        raise HTTPException(status_code=409, detail=OUT_OF_STOCK_MESSAGE)
    return item, snap


def admin_claims(authorization: Optional[str]) -> dict:
    if db is None:
        raise HTTPException(status_code=503, detail="Base de données non configurée côté serveur.")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Connexion requise.")
    try:
        claims = fb_auth.verify_id_token(authorization[7:])
    except Exception:
        raise HTTPException(status_code=401, detail="Session invalide, reconnectez-vous.")
    if claims.get("admin") is not True:
        raise HTTPException(status_code=403, detail="Réservé à l'administrateur.")
    return claims


def admin_view(snap: dict) -> dict:
    age = round(time.time() - snap["ts"], 1) if snap["ts"] else None
    return {
        "drive": snap["drive"], "error": snap["error"], "synced_at": snap["synced_at"],
        "checked_at": snap["checked_at"], "changed_at": snap["changed_at"], "checked_age_seconds": age,
        "poll_seconds": DRIVE_POLL_SECONDS, "watcher_fails": _watch["fails"], "realtime_products": _listener_ok,
        "promo": active_promo(snap["promo"]), "promo_config": snap["promo"] or {},
        "promo_source": "admin" if _promo_doc is not None else "catalog.json",
        "products": [{"id": i["id"], "name": i["name"], "price_usdt": i["price_usdt"], "state": i["state"],
                      "version": i["sold_version"], "file": i["file"], "recently_updated": i["recent"],
                      "archived": i["archived"]} for i in snap["items"]],
        "unlisted": snap["unlisted"],
        "naming": "<id>.zip ou <id>-vX.Y.Z.zip (ex. pro-v1.2.0.zip)",
    }


# ---------- Routes ----------
@app.get("/api/health")
def health_check():
    return {
        "status": "ok", "model": MODEL_NAME,
        "firebase": db is not None, "storage": RCLONE_CONF_PATH is not None,
        "nowpayments_key": bool(NOWPAYMENTS_API_KEY),
        "catalog": {"drive": _snapshot["drive"], "products": len(_snapshot["items"]), "checked_at": _snapshot["checked_at"],
                    "poll_seconds": DRIVE_POLL_SECONDS, "watcher_fails": _watch["fails"]},
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

    product_id = slug(req.product_id or req.pack_name or "")
    if not product_id:
        raise HTTPException(status_code=400, detail="Produit manquant.")
    item, snap = verified_product(product_id)        # revérifie Google Drive avant de créer le paiement
    base_price = item["price_usdt"]
    price, promo_code, percent = base_price, None, 0
    if req.promo_code and req.promo_code.strip():
        promo = active_promo(snap["promo"])
        code = req.promo_code.strip().upper()
        if not promo or code != promo["code"]:
            raise HTTPException(status_code=400, detail="Code promo invalide ou expiré.")
        if promo["pack_id"] and promo["pack_id"] != item["id"]:
            raise HTTPException(status_code=400, detail="Ce code promo ne s'applique pas à ce pack.")
        percent, promo_code = promo["percent"], promo["code"]
        price = round(base_price * (1 - percent / 100), 2)
    pack_name, version, file_name = item["name"], item["sold_version"], item["file"]["name"]

    payload = {
        "price_amount": price,
        "price_currency": "usd",
        "pay_currency": "usdttrc20",
        "order_id": f"GOANGEL_{int(time.time())}_{slug(pack_name)}",
        "order_description": f"Achat du pack {pack_name} v{version}",
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
            "uid": uid, "product_id": item["id"], "pack_name": pack_name, "version": version, "file_name": file_name,
            "price_usd": price, "base_price_usd": base_price, "promo_code": promo_code, "status": "waiting",
            "pay_address": data["pay_address"], "pay_amount": data["pay_amount"],
            "pay_currency": data["pay_currency"], "created_at": firestore.SERVER_TIMESTAMP,
        })
        return {"payment_id": payment_id, "pack_name": pack_name, "version": version, "pay_address": data["pay_address"],
                "amount": data["pay_amount"], "currency": data["pay_currency"], "price": price,
                "base_price": base_price, "promo_code": promo_code, "discount_percent": percent}
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
            "payment_id": d.id, "pack_name": o.get("pack_name"), "version": o.get("version"), "status": o.get("status", "waiting"),
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


def order_file_name(order: dict) -> str:
    """Le fichier livré est TOUJOURS celui enregistré par le serveur à l'achat (jamais un paramètre du client).
    Anciennes commandes sans file_name : <pack>.zip."""
    name = str(order.get("file_name") or f"{slug(order.get('pack_name', ''))}.zip")
    if not SAFE_FILE_NAME.match(name) or ".." in name:
        raise HTTPException(status_code=400, detail="Nom de fichier de commande invalide.")
    return name


MISSING_FILE_MESSAGE = ("Le fichier de ce logiciel n'est plus disponible sur le stockage pour le moment. Votre commande est conservée : "
                        "contactez le support avec votre ID de paiement.")


@app.post("/api/download-token/{payment_id}")
def download_token(payment_id: str, authorization: Optional[str] = Header(None)):
    """Vérifie l'achat et le fichier, puis renvoie un lien signé de 2 min (le navigateur ne peut pas envoyer d'en-tête Authorization en naviguant)."""
    order = authorize_download(payment_id, None, authorization)
    ensure_drive_ready()
    filename = order_file_name(order)
    if filename.lower() not in drive_files_or_http():
        raise HTTPException(status_code=404, detail=MISSING_FILE_MESSAGE)
    return {"url": f"/api/download/{payment_id}?token={make_dl_token(payment_id, str(order.get('uid', '')))}"}


@app.get("/api/download/{payment_id}")
def download_file(payment_id: str, token: Optional[str] = Query(None, max_length=200), authorization: Optional[str] = Header(None)):
    order = authorize_download(payment_id, token, authorization)
    ensure_drive_ready()
    filename = order_file_name(order)

    folder = _reserve_slot()
    if folder is None:
        raise HTTPException(status_code=429, detail="Serveur occupé par d'autres téléchargements, réessayez dans un instant.")
    try:
        info = drive_files_or_http().get(filename.lower())      # revérification juste avant la livraison
        if not info:
            raise HTTPException(status_code=404, detail=MISSING_FILE_MESSAGE)
        dest = os.path.join(folder, info["name"])
        try:
            res = run_rclone(["copyto", f"{RCLONE_REMOTE}/{info['name']}", dest], timeout=900)
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="Téléchargement depuis Google Drive trop long, réessayez.")
        if res.returncode != 0 or not os.path.isfile(dest):
            print(f"❌ rclone copyto : {res.stderr[:200]}")
            raise HTTPException(status_code=502, detail="Impossible de récupérer le fichier depuis Google Drive.")
    except BaseException:
        _release_slot(folder)
        raise
    return FileResponse(
        dest, media_type="application/zip", filename=f"goangel-{info['name']}",
        background=BackgroundTask(_release_slot, folder),   # supprime le fichier temporaire après l'envoi
    )


# ---------- Catalogue public (connecté) et administration ----------
@app.get("/api/catalog")
def catalog(http: Request, authorization: Optional[str] = Header(None)):
    uid = current_uid(authorization)
    ip = http.headers.get("cf-connecting-ip") or (http.client.host if http.client else "?")
    if rate_limited("cat:" + ip, limit=60):
        raise HTTPException(status_code=429, detail="Trop de requêtes, patientez un instant.")
    snap = get_snapshot()
    promo = active_promo(snap["promo"])
    public = {k: promo[k] for k in ("code", "percent", "pack_id", "message", "expires")} if promo and promo["banner"] else None
    return {"products": [public_item(i) for i in snap["items"]], "promo": public, "my_promo": my_promo_for(uid, promo),
            "drive": snap["drive"], "synced_at": snap["synced_at"], "checked_at": snap["checked_at"],
            "version": snap["version"], "refresh_seconds": DRIVE_POLL_SECONDS}


@app.post("/api/promo/apply")
def promo_apply(req: PromoRequest, http: Request, authorization: Optional[str] = Header(None)):
    """Applique le code au compte connecté SEULEMENT (enregistré côté serveur, jamais partagé avec les autres comptes)."""
    uid = current_uid(authorization)
    ip = http.headers.get("cf-connecting-ip") or (http.client.host if http.client else "?")
    if rate_limited("promo:" + ip, limit=20):
        raise HTTPException(status_code=429, detail="Trop d'essais, patientez une minute.")
    promo = active_promo(get_snapshot()["promo"])
    code = (req.code or "").strip().upper()
    if not promo or not code or not hmac.compare_digest(code, promo["code"]):
        raise HTTPException(status_code=400, detail="Code promo invalide ou expiré.")
    db.collection("promo_redemptions").document(uid).set({"code": code, "applied_at": firestore.SERVER_TIMESTAMP})
    return {"promo": _mine(promo)}


@app.post("/api/promo/clear")
def promo_clear(authorization: Optional[str] = Header(None)):
    uid = current_uid(authorization)
    db.collection("promo_redemptions").document(uid).delete()
    return {"promo": None}


@app.get("/api/catalog-version")
def catalog_version(http: Request, authorization: Optional[str] = Header(None)):
    """Réponse minuscule interrogée par le site : le catalogue complet n'est rechargé que si la version a changé."""
    current_uid(authorization)
    ip = http.headers.get("cf-connecting-ip") or (http.client.host if http.client else "?")
    if rate_limited("ver:" + ip, limit=120):
        raise HTTPException(status_code=429, detail="Trop de requêtes, patientez un instant.")
    snap = get_snapshot()
    return {"version": snap["version"], "checked_at": snap["checked_at"], "drive": snap["drive"]}


@app.get("/api/admin/catalog")
def admin_catalog(authorization: Optional[str] = Header(None)):
    admin_claims(authorization)
    return admin_view(get_snapshot())


@app.post("/api/admin/sync")
def admin_sync(authorization: Optional[str] = Header(None)):
    """Vérification immédiate facultative : la synchronisation automatique tourne déjà seule."""
    admin_claims(authorization)
    return admin_view(refresh_catalog(reload_overrides=True))


@app.on_event("startup")
def _on_startup():
    start_background()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
