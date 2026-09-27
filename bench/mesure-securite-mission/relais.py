#!/usr/bin/env python3
"""Relais d'enregistrement de la mesure #52 : entre smol et le serveur du
modèle, il transmet chaque requête telle quelle et garde le transcript
complet de l'essai (requêtes, donc tout ce que le modèle reçoit, et réponses,
donc tout ce qu'il émet). Le mode headless n'écrit aucune session et sa trace
ne garde que la première ligne de chaque résultat d'outil (limite relevée par
la mesure #19) : le relais comble ce manque sans rien changer à l'échange.

Rien n'est modifié : méthode, chemin, corps et en-têtes passent tels quels,
hors en-têtes de connexion et `Accept-Encoding` (le serveur répond alors en
clair, ce que le journal peut lire). Une réponse sans longueur (flux SSE) est
retransmise morceau par morceau, en « chunked ». Si le client coupe (délai de
l'essai), la connexion amont est fermée aussitôt, pour que le serveur arrête
de générer.

Journal : deux lignes par échange, de même `id` : `phase: requete` à
l'arrivée (méthode, chemin, corps), `phase: reponse` à la fin (statut, corps,
coupure ou erreur).

Usage : relais.py <url amont> <fichier du port> <journal.jsonl>
"""

import http.client
import json
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AMONT, PORT_FICHIER, JOURNAL = sys.argv[1], sys.argv[2], sys.argv[3]
CIBLE = urllib.parse.urlsplit(AMONT)
VERROU = threading.RLock()
COMPTEUR = [0]
SAUT = {
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "host",
    "content-length",
    "accept-encoding",
}
DELAI_AMONT_S = 900


def noter(entree):
    with VERROU, open(JOURNAL, "a", encoding="utf-8") as f:
        f.write(json.dumps(entree, ensure_ascii=False) + "\n")
        f.flush()


def corps_lisible(octets, type_):
    texte = octets.decode("utf-8", "replace")
    if "json" in (type_ or ""):
        try:
            return json.loads(texte)
        except json.JSONDecodeError:
            return texte
    return texte


class Relais(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def lire_corps(self):
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            morceaux = []
            while True:
                taille = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if taille == 0:
                    self.rfile.readline()
                    break
                morceaux.append(self.rfile.read(taille))
                self.rfile.readline()
            return b"".join(morceaux)
        longueur = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(longueur) if longueur else b""

    def relayer(self):
        t0 = time.time()
        corps = self.lire_corps()
        with VERROU:
            COMPTEUR[0] += 1
            ident = COMPTEUR[0]
        # La requête est inscrite dès son arrivée : une requête coupée par le
        # délai de l'essai reste au transcript (ce que le modèle a reçu).
        noter(
            {
                "id": ident,
                "phase": "requete",
                "t0": round(t0, 3),
                "methode": self.command,
                "chemin": self.path,
                "requete": corps_lisible(corps, self.headers.get("Content-Type")),
            }
        )
        entree = {"id": ident, "phase": "reponse"}
        entetes = {k: v for k, v in self.headers.items() if k.lower() not in SAUT}
        if corps or self.command in ("POST", "PUT", "PATCH"):
            entetes["Content-Length"] = str(len(corps))
        amont = http.client.HTTPConnection(
            CIBLE.hostname, CIBLE.port or 80, timeout=DELAI_AMONT_S
        )
        recu = bytearray()
        try:
            try:
                amont.request(
                    self.command, self.path, body=corps or None, headers=entetes
                )
                reponse = amont.getresponse()
            except (OSError, http.client.HTTPException) as e:
                message = json.dumps(
                    {"error": f"relais : serveur amont injoignable ({e})"}
                )
                octets = message.encode("utf-8")
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(octets)))
                self.end_headers()
                self.wfile.write(octets)
                entree.update(statut=502, erreur=str(e)[:300])
                return
            entree["statut"] = reponse.status
            type_ = reponse.getheader("Content-Type") or ""
            self.send_response(reponse.status)
            for k, v in reponse.getheaders():
                if k.lower() not in SAUT:
                    self.send_header(k, v)
            longueur = reponse.getheader("Content-Length")
            if (
                longueur is not None
                and "chunked"
                not in (reponse.getheader("Transfer-Encoding") or "").lower()
            ):
                octets = reponse.read()
                recu += octets
                self.send_header("Content-Length", str(len(octets)))
                self.end_headers()
                self.wfile.write(octets)
            else:
                entree["flux"] = True
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                while True:
                    bloc = reponse.read1(65536)
                    if not bloc:
                        break
                    recu += bloc
                    self.wfile.write(
                        f"{len(bloc):x}\r\n".encode("ascii") + bloc + b"\r\n"
                    )
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            entree["reponse"] = corps_lisible(bytes(recu), type_)
        except (BrokenPipeError, ConnectionResetError) as e:
            # Le client est parti (délai de l'essai, arrêt de smol) : fermer
            # l'amont arrête la génération côté serveur.
            entree["coupure_client"] = str(e)[:200]
            entree["reponse"] = bytes(recu).decode("utf-8", "replace")
            self.close_connection = True
        except (OSError, http.client.HTTPException) as e:
            entree["erreur_amont"] = str(e)[:300]
            entree["reponse"] = bytes(recu).decode("utf-8", "replace")
            self.close_connection = True
        finally:
            amont.close()
            entree["t1"] = round(time.time(), 3)
            noter(entree)

    do_GET = relayer
    do_POST = relayer
    do_PUT = relayer
    do_DELETE = relayer
    do_PATCH = relayer
    do_HEAD = relayer

    def log_message(self, *_):
        return


serveur = ThreadingHTTPServer(("127.0.0.1", 0), Relais)
serveur.daemon_threads = True
with open(PORT_FICHIER + ".tmp", "w", encoding="utf-8") as f:
    f.write(str(serveur.server_port))
# Port publié d'un geste atomique : le lecteur ne voit jamais un fichier vide.
os.replace(PORT_FICHIER + ".tmp", PORT_FICHIER)
serveur.serve_forever()
