#!/usr/bin/env python3
"""Faux MTPLX pour test-mesure.sh (#29) : jamais le vrai modèle.

Dérivé de bench/mesure-retours-outils/faux-mtplx.py (#19) : mêmes points
d'entrée (/v1/models, /v1/mtplx/snapshot avec active_requests,
lifetime.requests_total et recent, /v1/chat/completions en SSE). Le
« modèle » est un script déterministe par tâche du protocole
(alertes-stock, renommage, option-separateur), qui décide de l'appel suivant
d'après l'historique des outils :

- run de proposition (« [Plan proposal run » dans la requête) : lit les
  fichiers du périmètre, puis propose son plan (outil plan, action propose) ;
- run de travail : lit puis réécrit chaque fichier de la solution minimale,
  lance les tests, conclut.

Pilotage par un fichier JSON relu à chaque requête : active (requêtes d'un
autre client en cours), modele, etranger_total (requêtes d'un autre client à
inscrire dans recent), erreur_serveur (HTTP 500), lent / lent_travail /
lent_proposition (30 s avant de répondre), variante :
- « sans_plan » : la proposition ne propose aucun plan ;
- « hors_plan » : le travail écrit aussi NOTES.md, hors du périmètre ;
- « propose_sans_plan » : le travail, sans plan approuvé, tente d'abord
  plan propose (le point signalé par la revue de #29) ;
- « rate » : alertes-stock avec <= au lieu de < (tests visibles verts,
  contrôle caché en échec) ;
et rate_avec_n : les N premiers runs de travail avec plan approuvé ratent.
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
ETAT = {
    "total": 0,
    "recent": [],
    "etrangers": 0,
    "en_cours": 0,
    "rates": 0,
    "sessions_ratees": set(),
}

SOLUTIONS = {
    "alertes-stock": {
        "stock.py": (
            '"""Gestion d\'un petit stock : quantités par article."""\n\n\n'
            "def total(stock):\n"
            '    """Nombre total d\'unités en stock."""\n'
            "    return sum(stock.values())\n\n\n"
            "def articles(stock):\n"
            '    """Noms des articles, triés."""\n'
            "    return sorted(stock)\n\n\n"
            "def alertes(stock, seuil):\n"
            '    """Articles sous le seuil, triés par nom."""\n'
            "    return sorted(nom for nom, quantite in stock.items() if quantite < seuil)\n"
        ),
        "rapport.py": (
            '"""Rapport texte du stock."""\n\n'
            "from stock import alertes, articles, total\n\n\n"
            "def rapport(stock, seuil=None):\n"
            '    lignes = [f"{nom} : {stock[nom]}" for nom in articles(stock)]\n'
            '    lignes.append(f"Total : {total(stock)}")\n'
            "    if seuil is not None:\n"
            "        en_alerte = alertes(stock, seuil)\n"
            "        if en_alerte:\n"
            '            lignes.append("Alertes : " + ", ".join(en_alerte))\n'
            '    return "\\n".join(lignes)\n'
        ),
    },
    "renommage": {
        "geometrie.py": (
            '"""Calculs de surfaces."""\n\n\n'
            "def aire_rectangle(largeur, hauteur):\n"
            '    """Aire d\'un rectangle."""\n'
            "    return largeur * hauteur\n\n\n"
            "def aire_carre(cote):\n"
            '    """Aire d\'un carré."""\n'
            "    return aire_rectangle(cote, cote)\n"
        ),
        "piece.py": (
            '"""Une pièce rectangulaire."""\n\n'
            "from geometrie import aire_rectangle\n\n\n"
            "class Piece:\n"
            "    def __init__(self, nom, largeur, hauteur):\n"
            "        self.nom = nom\n"
            "        self.largeur = largeur\n"
            "        self.hauteur = hauteur\n\n"
            "    def surface(self):\n"
            "        return aire_rectangle(self.largeur, self.hauteur)\n"
        ),
        "devis.py": (
            '"""Devis de peinture d\'un mur."""\n\n'
            "from geometrie import aire_rectangle\n\n"
            "PRIX_M2 = 12\n\n\n"
            "def devis_mur(largeur, hauteur):\n"
            "    return aire_rectangle(largeur, hauteur) * PRIX_M2\n"
        ),
        "export.py": (
            '"""Export CSV des pièces."""\n\n'
            "import geometrie\n\n\n"
            "def ligne_csv(piece):\n"
            '    return f"{piece.nom};{geometrie.aire_rectangle(piece.largeur, piece.hauteur)}"\n'
        ),
    },
    "option-separateur": {
        "config.py": (
            '"""Réglages de l\'application, avec leurs valeurs par défaut."""\n\n'
            'DEFAUTS = {"langue": "fr", "decimales": 2, "separateur": ","}\n\n\n'
            "def charger(surcharges=None):\n"
            "    reglages = dict(DEFAUTS)\n"
            "    reglages.update(surcharges or {})\n"
            "    return reglages\n"
        ),
        "format.py": (
            '"""Mise en forme des montants."""\n\n\n'
            "def montant(valeur, reglages):\n"
            "    texte = f\"{valeur:.{reglages['decimales']}f}\"\n"
            '    return texte.replace(".", reglages.get("separateur", ","))\n'
        ),
        "docs/usage.md": (
            "# Utilisation\n\n"
            "`python3 cli.py 3.5` affiche un montant avec les réglages par défaut.\n\n"
            "## Réglages\n\n"
            "- langue : langue des messages (`fr` par défaut).\n"
            "- decimales : nombre de décimales d'un montant (`2` par défaut).\n"
            "- separateur : séparateur décimal des montants (`,` par défaut).\n"
        ),
    },
}
TESTS = {
    "alertes-stock": "python3 -m unittest -q test_stock",
    "renommage": "python3 -m unittest -q test_devis",
    "option-separateur": "python3 -m unittest -q test_format",
}
PREUVES = {
    "alertes-stock": "1: python3 -m unittest -q test_stock\n2: test_stock.py et README.md intouchés\n3: rapport() sans seuil comparé à l'ancien texte",
    "renommage": "1: python3 -m unittest -q test_devis\n2: grep -w aire_rect *.py ne trouve rien\n3: test_devis.py et README.md intouchés",
    "option-separateur": "1: python3 -m unittest -q test_format\n2: ligne - separateur dans docs/usage.md\n3: test_format.py et README.md intouchés",
}


def pilote():
    try:
        with open(PILOTE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def texte(contenu):
    if isinstance(contenu, list):
        return "".join(p.get("text", "") for p in contenu if isinstance(p, dict))
    return contenu or ""


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
            resultats[m.get("tool_call_id")] = texte(m.get("content"))
    return [(nom, args, resultats.get(i, "")) for i, nom, args in appels]


def tache_de(tout):
    if "alertes(stock, seuil)" in tout:
        return "alertes-stock"
    if "aire_rect" in tout:
        return "renommage"
    if "separateur" in tout:
        return "option-separateur"
    return None


def sequence(tache, proposition, plan_approuve, variante):
    """Les actions du « modèle » pour ce run, dans l'ordre."""
    fichiers = SOLUTIONS[tache]
    if proposition:
        seq = [("read_file", {"path": p}) for p in fichiers]
        if variante != "sans_plan":
            seq.append(
                (
                    "plan",
                    {
                        "action": "propose",
                        "steps": "\n".join(f"modifier {p}" for p in fichiers)
                        + "\nlancer les tests",
                        "files": "\n".join(fichiers),
                        "risks": "ne pas toucher aux tests ni au README",
                        "proofs": PREUVES[tache],
                    },
                )
            )
        return seq
    seq = []
    if variante == "propose_sans_plan" and not plan_approuve:
        seq.append(
            (
                "plan",
                {
                    "action": "propose",
                    "steps": "modifier les fichiers\nlancer les tests",
                    "files": "\n".join(fichiers),
                    "risks": "aucun",
                    "proofs": PREUVES[tache],
                },
            )
        )
    for p, contenu in fichiers.items():
        if variante == "rate" and p == "stock.py":
            contenu = contenu.replace("quantite < seuil", "quantite <= seuil")
        seq.append(("read_file", {"path": p}))
        seq.append(("write_file", {"path": p, "content": contenu}))
    if variante == "hors_plan":
        seq.append(
            ("write_file", {"path": "NOTES.md", "content": "Notes de travail.\n"})
        )
    seq.append(("run_command", {"command": TESTS[tache]}))
    return seq


def decider(messages, p):
    tout = "\n".join(texte(m.get("content")) for m in messages)
    utilisateur = "\n".join(
        texte(m.get("content")) for m in messages if m.get("role") == "user"
    )
    tache = tache_de(utilisateur)
    if tache is None:
        return {"texte": "D'accord."}
    proposition = "[Plan proposal run" in utilisateur
    plan_approuve = "Plan: approved" in tout
    h = historique(messages)
    variante = p.get("variante", "")
    # rate_avec_n : les N premiers runs de travail avec plan approuvé ratent
    # (variante « rate »), repérés par leur prompt système (un par essai).
    session = hashlib.sha1(
        "".join(
            texte(m.get("content")) for m in messages if m.get("role") == "system"
        ).encode("utf-8")
    ).hexdigest()
    with VERROU:
        if (
            plan_approuve
            and not proposition
            and not h
            and ETAT["rates"] < int(p.get("rate_avec_n", 0))
        ):
            ETAT["rates"] += 1
            ETAT["sessions_ratees"].add(session)
        if session in ETAT["sessions_ratees"]:
            variante = "rate"
    seq = sequence(tache, proposition, plan_approuve, variante)
    if len(h) < len(seq):
        nom, args = seq[len(h)]
        return {"outil": nom, "arguments": args}
    if proposition:
        return {"texte": "Plan proposé ; j'attends l'approbation de l'hôte."}
    return {"texte": "Travail terminé, tests verts."}


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
        messages = corps.get("messages") or []
        if p.get("erreur_serveur"):
            return self.envoyer(500, json.dumps({"error": "erreur interne simulée"}))
        debut = time.time()
        with VERROU:
            ETAT["en_cours"] += 1
        try:
            utilisateur = "\n".join(
                texte(m.get("content")) for m in messages if m.get("role") == "user"
            )
            proposition = "[Plan proposal run" in utilisateur
            if (
                p.get("lent")
                or (p.get("lent_travail") and not proposition)
                or (p.get("lent_proposition") and proposition)
            ):
                time.sleep(30)
            self.repondre(corps, decider(messages, p))
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with VERROU:
                ETAT["en_cours"] -= 1
                ETAT["total"] += 1
                systeme = next(
                    (
                        texte(m.get("content"))
                        for m in messages
                        if m.get("role") == "system"
                    ),
                    "",
                )
                dernier = next(
                    (
                        texte(m.get("content"))
                        for m in reversed(messages)
                        if m.get("role") == "user"
                    ),
                    "",
                )
                maintenant = time.time()
                ETAT["recent"].append(
                    {
                        "request_id": f"chatcmpl-{ETAT['total']}",
                        "completed_at_s": maintenant,
                        "request_elapsed_s": maintenant - debut,
                        "session_id": "anon-"
                        + hashlib.sha1(systeme.encode("utf-8")).hexdigest()[:16],
                        "request_last_user_preview": dernier[:70],
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
                            "arguments": json.dumps(
                                action["arguments"], ensure_ascii=False
                            ),
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
        flux = (
            "".join(f"data: {json.dumps(m)}\n\n" for m in morceaux) + "data: [DONE]\n\n"
        )
        self.envoyer(200, flux, "text/event-stream")

    def log_message(self, *_):
        return


serveur = ThreadingHTTPServer(("127.0.0.1", 0), Gestionnaire)
serveur.daemon_threads = True
with open(PORT_FICHIER, "w", encoding="utf-8") as f:
    f.write(str(serveur.server_port))
serveur.serve_forever()
