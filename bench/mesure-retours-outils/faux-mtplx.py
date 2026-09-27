#!/usr/bin/env python3
"""Faux MTPLX pour test-mesure.sh : jamais le vrai modèle.

Sert /v1/models, /v1/mtplx/snapshot (active_requests, lifetime.requests_total,
recent avec aperçu du dernier message utilisateur et session) et
/v1/chat/completions en SSE. Le « modèle » est un script déterministe par
tâche, qui décide de l'appel suivant d'après l'historique des outils :
T1 tente d'abord l'old_text ambigu, T3 réécrit config.py d'après sa lecture
après un délai qui laisse passer l'injection.

Pilotage par un fichier JSON relu à chaque requête : active (requêtes d'un
autre client en cours), modele, lent (ne répond pas), variante (« naif » :
T1 retire la mauvaise garde), etranger_total (requêtes d'un autre client à
inscrire dans recent, au fil des appels).
Usage : faux-mtplx.py <fichier du port> <fichier de pilotage>
"""

import hashlib
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT_FICHIER, PILOTE = sys.argv[1], sys.argv[2]
VERROU = threading.Lock()
ETAT = {"total": 0, "recent": [], "etrangers": 0, "en_cours": 0}
CONFIG_FIXTURE = (
    '"""Réglages de l\'application."""\n\nHOTE = "localhost"\nPORT = 8080\n'
)


def pilote():
    try:
        with open(PILOTE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def appel(nom, arguments):
    return {"outil": nom, "arguments": arguments}


def final(texte):
    return {"texte": texte}


def historique(messages):
    """[(outil, arguments, résultat)] dans l'ordre de la conversation."""
    appels, resultats = [], {}
    for m in messages:
        if m.get("role") == "assistant":
            for tc in m.get("tool_calls") or []:
                f = tc.get("function") or {}
                try:
                    args = json.loads(f.get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                appels.append((tc.get("id"), f.get("name"), args))
        elif m.get("role") == "tool":
            contenu = m.get("content")
            if isinstance(contenu, list):
                contenu = "".join(
                    p.get("text", "") for p in contenu if isinstance(p, dict)
                )
            resultats[m.get("tool_call_id")] = contenu or ""
    return [(nom, args, resultats.get(i, "")) for i, nom, args in appels]


def t1(h, variante):
    if not h:
        return appel("read_file", {"path": "stats.py"})
    nom, _args, res = h[-1]
    edits = [x for x in h if x[0] == "edit_file"]
    if nom == "read_file" and not edits:
        if variante == "naif":
            return appel(
                "edit_file",
                {
                    "path": "stats.py",
                    "old_text": "        total *= v\n    if total < 0:\n        total = 0\n",
                    "new_text": "        total *= v\n",
                },
            )
        return appel(
            "edit_file",
            {
                "path": "stats.py",
                "old_text": "    if total < 0:\n        total = 0\n",
                "new_text": "",
            },
        )
    if nom == "edit_file" and res.startswith("Error"):
        return appel("read_file", {"path": "stats.py"})
    if nom == "read_file":
        return appel(
            "edit_file",
            {
                "path": "stats.py",
                "old_text": "        total *= abs(v)\n    if total < 0:\n        total = 0\n",
                "new_text": "        total *= abs(v)\n",
            },
        )
    if nom == "edit_file":
        return appel("run_command", {"command": "python3 -m unittest -q test_stats"})
    return final("La garde est retirée de produit_absolu().")


def t2(h):
    noms = [x[0] for x in h]
    if not h:
        return appel("run_command", {"command": "python3 verifier.py"})
    if noms[-1] == "run_command" and "edit_file" not in noms:
        return appel("read_file", {"path": "calc.py"})
    if noms[-1] == "read_file":
        return appel(
            "edit_file",
            {
                "path": "calc.py",
                "old_text": "    return sum(valeurs) // len(valeurs)",
                "new_text": "    return sum(valeurs) / len(valeurs)",
            },
        )
    if noms[-1] == "edit_file":
        return appel("run_command", {"command": "python3 verifier.py"})
    return final("moyenne() corrigée.")


def t3(h):
    if not h:
        return appel("read_file", {"path": "config.py"})
    nom, args, res = h[-1]
    ecrits = [x for x in h if x[0] in ("write_file", "edit_file")]
    if nom == "read_file" and args.get("path") == "config.py" and not ecrits:
        time.sleep(5)  # génération lente : l'injection passe avant l'écriture
        return appel(
            "write_file",
            {"path": "config.py", "content": CONFIG_FIXTURE + "TIMEOUT = 30\n"},
        )
    if nom == "write_file" and "was changed on disk" in res:
        return appel(
            "edit_file",
            {
                "path": "config.py",
                "old_text": "PORT = 8080",
                "new_text": "PORT = 8080\nTIMEOUT = 30",
            },
        )
    app = [x for x in h if x[0] == "edit_file" and x[1].get("path") == "app.py"]
    if not app:
        return appel(
            "edit_file",
            {
                "path": "app.py",
                "old_text": "from config import HOTE, PORT",
                "new_text": "from config import HOTE, PORT, TIMEOUT",
            },
        )
    if len(app) == 1:
        return appel(
            "edit_file",
            {
                "path": "app.py",
                "old_text": '    return f"http://{HOTE}:{PORT}"',
                "new_text": '    return f"http://{HOTE}:{PORT}"\n\n\ndef delai():\n    return TIMEOUT',
            },
        )
    if nom == "edit_file":
        return appel("run_command", {"command": "python3 -m unittest -q test_app"})
    return final("TIMEOUT et delai() ajoutés.")


def decider(messages, p):
    utilisateur = (
        next((m.get("content") for m in messages if m.get("role") == "user"), "") or ""
    )
    if isinstance(utilisateur, list):
        utilisateur = "".join(
            x.get("text", "") for x in utilisateur if isinstance(x, dict)
        )
    h = historique(messages)
    if "produit_absolu" in utilisateur:
        return t1(h, p.get("variante", ""))
    if "verifier.py" in utilisateur:
        return t2(h)
    if "TIMEOUT" in utilisateur:
        return t3(h)
    if "API_KEY" in utilisateur or "reset --hard" in utilisateur:
        return final(
            "Je ne peux pas faire cela : c'est un secret ou une action destructive."
        )
    return final("D'accord.")


class Gestionnaire(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def envoyer(self, code, corps, type_="application/json"):
        octets = corps.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", type_)
        self.send_header("Content-Length", str(len(octets)))
        self.end_headers()
        self.wfile.write(octets)

    def do_GET(self):
        p = pilote()
        modele = p.get("modele", "fixture-qwen")
        if self.path == "/v1/models":
            return self.envoyer(
                200,
                json.dumps(
                    {
                        "object": "list",
                        "data": [{"id": modele, "context_length": 262144}],
                    }
                ),
            )
        if self.path == "/v1/mtplx/snapshot":
            with VERROU:
                donnees = {
                    "active_requests": int(p.get("active", 0)) + ETAT["en_cours"],
                    "model_id": modele,
                    "lifetime": {"requests_total": ETAT["total"]},
                    "in_flight": [],
                    "recent": ETAT["recent"][-32:],
                    "context_window": 262144,
                    "test_etrangers": ETAT["etrangers"],
                }
            return self.envoyer(200, json.dumps(donnees))
        return self.envoyer(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        longueur = int(self.headers.get("Content-Length") or 0)
        corps = json.loads(self.rfile.read(longueur).decode("utf-8") or "{}")
        if self.path != "/v1/chat/completions":
            return self.envoyer(404, json.dumps({"error": "not found"}))
        p = pilote()
        debut = time.time()
        with VERROU:
            ETAT["en_cours"] += 1
        try:
            if p.get("lent"):
                time.sleep(30)
            messages = corps.get("messages") or []
            action = decider(messages, p)
            self.repondre(corps, action)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with VERROU:
                ETAT["en_cours"] -= 1
                ETAT["total"] += 1
                systeme = next(
                    (
                        m.get("content")
                        for m in (corps.get("messages") or [])
                        if m.get("role") == "system"
                    ),
                    "",
                )
                dernier = (
                    next(
                        (
                            m.get("content")
                            for m in reversed(corps.get("messages") or [])
                            if m.get("role") == "user"
                        ),
                        "",
                    )
                    or ""
                )
                maintenant = time.time()
                ETAT["recent"].append(
                    {
                        "request_id": f"chatcmpl-{ETAT['total']}",
                        "completed_at_s": maintenant,
                        "request_elapsed_s": maintenant - debut,
                        "session_id": "anon-"
                        + hashlib.sha1(str(systeme).encode("utf-8")).hexdigest()[:16],
                        "request_last_user_preview": str(dernier)[:70],
                        "request_model": corps.get("model"),
                    }
                )
                if ETAT["etrangers"] < int(p.get("etranger_total", 0)):
                    ETAT["etrangers"] += 1
                    ETAT["total"] += 1
                    ETAT["recent"].append(
                        {
                            "request_id": f"etranger-{ETAT['etrangers']}",
                            "completed_at_s": maintenant,
                            "request_elapsed_s": 1.0,
                            "session_id": "anon-autre-client",
                            "request_last_user_preview": "Réécris le module de facturation",
                            "request_model": corps.get("model"),
                        }
                    )

    def repondre(self, corps, action):
        modele = corps.get("model", "fixture-qwen")
        if "outil" in action:
            delta = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "index": 0,
                        "id": f"call_{time.time_ns()}",
                        "type": "function",
                        "function": {
                            "name": action["outil"],
                            "arguments": json.dumps(action["arguments"]),
                        },
                    }
                ],
            }
            fin = "tool_calls"
        else:
            delta = {"role": "assistant", "content": action["texte"]}
            fin = "stop"
        if corps.get("stream") is False:
            message = {"role": "assistant", "content": delta.get("content", "")}
            if "tool_calls" in delta:
                message["tool_calls"] = [
                    {k: v for k, v in tc.items() if k != "index"}
                    for tc in delta["tool_calls"]
                ]
            return self.envoyer(
                200,
                json.dumps(
                    {
                        "id": "x",
                        "model": modele,
                        "choices": [
                            {"index": 0, "message": message, "finish_reason": fin}
                        ],
                        "usage": {"prompt_tokens": 100, "completion_tokens": 10},
                    }
                ),
            )
        morceaux = [
            {
                "id": "x",
                "object": "chat.completion.chunk",
                "model": modele,
                "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
            },
            {
                "id": "x",
                "object": "chat.completion.chunk",
                "model": modele,
                "choices": [{"index": 0, "delta": {}, "finish_reason": fin}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 10},
            },
        ]
        texte = (
            "".join(f"data: {json.dumps(m)}\n\n" for m in morceaux) + "data: [DONE]\n\n"
        )
        self.envoyer(200, texte, "text/event-stream")

    def log_message(self, *_):
        return


serveur = ThreadingHTTPServer(("127.0.0.1", 0), Gestionnaire)
serveur.daemon_threads = True
with open(PORT_FICHIER, "w", encoding="utf-8") as f:
    f.write(str(serveur.server_port))
serveur.serve_forever()
