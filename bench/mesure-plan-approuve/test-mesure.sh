#!/bin/bash
# Vérifications déterministes de la mesure #29, sans modèle ni MTPLX réel. Un
# faux MTPLX (faux-mtplx.py) scénarise le modèle ; les essais tournent sur le
# binaire figé du protocole quand il est construit (sinon sur le dist/ du
# dépôt, déclaré SAUTÉ), par l'essai.sh figé du protocole. Prouve : le déroulé
# complet des deux bras sur les trois tâches (préparation ou proposition,
# approbation mécanique du plan, travail, contrôle indépendant, mesures,
# stockage archivé), la lecture de la trace (plan propose refusé sous un
# contrat approuvé sans plan), le classement des statuts et de la validité
# (délai du travail, délai de la proposition, erreur du serveur, requête d'un
# autre client, MTPLX occupé ou absent, autre modèle, verrous, empreinte, smol
# qui ne démarre pas, pièce du protocole modifiée, interruption), l'isolement
# du vrai dossier personnel, la campagne (ordre alterné, rejeu unique à la même
# place, extension décidée sur les réussites, reprise, dossiers temporaires
# supprimés) et chaque point de la règle de décision sur manifestes
# synthétiques.
set -u

B="$(cd "$(dirname "$0")" && pwd)" || exit 1
REPO="$(git -C "$B" rev-parse --show-toplevel)" || exit 1
BASE_TMP="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo /tmp/)"
TMP="$(mktemp -d "${BASE_TMP%/}/test-mesure-29.XXXXXX")" || exit 1
SERVEUR_PID=""
VIVANT=""
nettoyer() {
  [ -n "$SERVEUR_PID" ] && kill "$SERVEUR_PID" 2>/dev/null && wait "$SERVEUR_PID" 2>/dev/null
  [ -n "$VIVANT" ] && kill "$VIVANT" 2>/dev/null && wait "$VIVANT" 2>/dev/null
  chmod -R u+w "$TMP" 2>/dev/null
  rm -rf "$TMP"
}
trap nettoyer EXIT HUP INT TERM
ECHECS=0
SAUTES=0
echec() { echo "ÉCHEC : $*" >&2; ECHECS=$((ECHECS + 1)); }
ok() { echo "ok : $*"; }
saute() { echo "SAUTÉ : $*"; SAUTES=$((SAUTES + 1)); }

PLAN="$B/plan.json"
BINS="$(printenv MESURE_BIN_RACINE 2>/dev/null || true)"
[ -n "$BINS" ] || BINS="$(python3 -c 'import json,os,sys; print(os.path.expanduser(json.load(open(sys.argv[1]))["binaire"]["racine"]))' "$PLAN")"
empreinte() { (cd "$1" && find dist -type f | LC_ALL=C sort | xargs shasum -a 256) | shasum -a 256 | cut -d' ' -f1; }
avec_empreinte() {  # plan source, plan cible, empreinte
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
p["binaire"]["empreinte_dist"] = sys.argv[3]
json.dump(p, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
}
if [ -f "$BINS/dist/index.js" ]; then
  ATTENDUE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["binaire"]["empreinte_dist"])' "$PLAN")"
  [ "$(empreinte "$BINS")" = "$ATTENDUE" ] && ok "binaire figé présent, empreinte de dist/ conforme ($ATTENDUE)" \
    || echec "binaire figé présent mais empreinte de dist/ $(empreinte "$BINS") au lieu de $ATTENDUE"
else
  [ -f "$REPO/dist/index.js" ] || { echo "Ni binaire figé ni dist/ construit : npm run build d'abord" >&2; exit 1; }
  BINS="$REPO"
  PLAN="$TMP/plan-dist.json"
  avec_empreinte "$B/plan.json" "$PLAN" "$(empreinte "$BINS")"
  saute "binaire figé absent : dist/ du dépôt, pas le binaire du protocole"
fi

# Faux dossier personnel « réel » : copié par l'essai, jamais écrit.
VRAIE_MAISON="$TMP/vraie-maison"
mkdir -p "$VRAIE_MAISON/.smolcoder"
printf 'Noyau de test.\n' > "$VRAIE_MAISON/.smolcoder/AGENTS.md"
PILOTE="$TMP/pilote.json"
echo '{}' > "$PILOTE"
python3 "$B/faux-mtplx.py" "$TMP/port" "$PILOTE" > "$TMP/serveur.log" 2>&1 &
SERVEUR_PID=$!
for _ in $(seq 1 50); do [ -s "$TMP/port" ] && break; sleep 0.1; done
[ -s "$TMP/port" ] || { echo "Faux MTPLX non démarré" >&2; exit 1; }
URL="http://127.0.0.1:$(cat "$TMP/port")"
printf '{"hosts":[{"address":"%s","name":"mtplx"}],"lastModel":"fixture-qwen","lastModelUrl":"%s","lastMode":"edit","effort":null}\n' "$URL" "$URL" > "$VRAIE_MAISON/.smolcoder.json"
find "$VRAIE_MAISON" -exec stat -f "%N %z %m %p" {} + | sort > "$TMP/vraie-maison-avant.txt"

piloter() { printf '%s\n' "$1" > "$PILOTE"; }
etrangers() { curl -s "$URL/v1/mtplx/snapshot" | python3 -c 'import json,sys; print(json.load(sys.stdin)["test_etrangers"])'; }
attendre_vide() {
  for _ in $(seq 1 60); do
    [ "$(curl -s "$URL/v1/mtplx/snapshot" | python3 -c 'import json,sys; print(json.load(sys.stdin)["active_requests"])')" = 0 ] && return 0
    sleep 1
  done
}

# Un essai ; le dossier de résultats reçoit un seul manifeste.
essai() {
  local resultats="$1" bras="$2" tache="$3"
  shift 3
  mkdir -p "$resultats"
  env HOME="$VRAIE_MAISON" MESURE_PLAN="$PLAN" MESURE_RESULTATS_DIR="$resultats" MESURE_BIN_RACINE="$BINS" \
    MTPLX_URL="$URL" MESURE_MODELE_ATTENDU=fixture-qwen MESURE_MAISON_SOURCE="$VRAIE_MAISON" MESURE_TMP="$TMP/essais-tmp" \
    BANC_LOCK_FILE="$TMP/verrou-banc" MESURE_VERROUS_EXTERNES="" MESURE_ATTENTE=1 MESURE_DELAI_SECONDES=60 "$@" \
    "$B/essai.sh" "$bras" "$tache" 1 > "$resultats/stdout" 2> "$resultats/stderr"
  echo $? > "$resultats/rc"
}
champ() { python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    d = d[k] if not isinstance(d, list) else d[int(k)]
print(json.dumps(d, ensure_ascii=False) if isinstance(d,(dict,list,bool)) or d is None else d)' "$1" "$2"; }
manifeste_de() { ls "$1"/*/manifeste.json 2>/dev/null | head -1; }
dossier_de() { dirname "$(manifeste_de "$1")"; }

# 0. Pièces du protocole.
python3 "$B/mesure.py" controler "$REPO" > /dev/null 2>&1 && ok "pièces du protocole et outillage réutilisé conformes au plan figé" || echec "pièces du protocole"
python3 - "$PLAN" "$TMP/plan-piece.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
p["protocole"]["pieces"]["docs/protocole-mesure-plan-approuve/controle.py"] = "0" * 64
json.dump(p, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
essai "$TMP/piece" avec alertes-stock MESURE_PLAN="$TMP/plan-piece.json"
M="$(manifeste_de "$TMP/piece")"
[ "$(champ "$M" status)" = blocage_harnais ] && [ "$(champ "$M" execution.smol_lance)" = false ] && [ "$(champ "$M" valide)" = false ] \
  && ok "pièce du protocole modifiée : blocage_harnais, smol non lancé, essai invalide" || echec "pièce modifiée non bloquée"

# 1. Déroulé nominal : trois tâches, deux bras.
for tache in alertes-stock renommage option-separateur; do
  for bras in sans avec; do
    essai "$TMP/nominal-$tache-$bras" "$bras" "$tache"
  done
done
python3 - "$TMP" <<'PY' && ok "trois tâches, deux bras : succes valides, plan proposé (sortie 3) puis approuvé, précision et rappel 1, stockage et workspace archivés, requêtes attribuées" || echec "déroulé nominal : $(tail -2 "$TMP"/nominal-*/stderr | tr '\n' ' ')"
import json, pathlib, sys, tarfile
racine = pathlib.Path(sys.argv[1])
for t in ("alertes-stock", "renommage", "option-separateur"):
    for b in ("sans", "avec"):
        d = next((racine / f"nominal-{t}-{b}").glob("*/manifeste.json")).parent
        m = json.loads((d / "manifeste.json").read_text())
        assert m["status"] == "succes" and m["valide"] and m["reussite_reelle"], (t, b, m["status_reason"])
        x = m["mesures"]
        assert x["verdict_smol"] == "verified" and x["rc_travail"] == "0" and x["hors_perimetre_nombre"] == 0, (t, b, x)
        assert x["source_appels_modele_travail"] == "stats" and x["source_appels_outils_travail"] == "stats", x
        c = m["server"]["concurrence"]
        attendu = x["appels_modele_travail"] + (x["appels_modele_proposition"] or 0)
        assert not c["occupe"] and c["requetes_essai"] == attendu, (t, b, c, attendu)
        assert m["binaire"]["commande"].endswith("/dist/index.js") and m["maison_de_test"]["noyau_sha256"], m["binaire"]
        assert (d / "espace-final.tar.gz").is_file(), "workspace non archivé"
        noms = tarfile.open(d / "maison-smolcoder.tar.gz").getnames()
        assert any(n.endswith("/proofs.jsonl") for n in noms) and any(n.endswith("/contract.json") for n in noms), noms
        assert (d / "essai" / "stockage" / "proofs.jsonl").is_file()
        if b == "avec":
            assert x["rc_proposition"] == "3" and x["plan_propose"] and x["plan_approuve"], x
            assert x["precision_plan"] == 1.0 and x["rappel_plan"] == 1.0 and x["ecarts"] == 0, x
            assert not m["sans_plan_signale"] and m["execution"]["preparation"] is None
            assert m["execution"]["proposition"]["trace"]["propose"] == 1, m["execution"]["proposition"]
        else:
            assert x["rc_proposition"] is None and not x["plan_propose"] and not x["plan_approuve"], x
            assert m["execution"]["preparation"]["rc"] == 3 and m["execution"]["proposition"] is None
PY

# 2. Aucun plan proposé : l'essai continue avec --approve seul (intention de traiter).
piloter '{"variante": "sans_plan"}'
essai "$TMP/sans-plan" avec alertes-stock
M="$(manifeste_de "$TMP/sans-plan")"
[ "$(champ "$M" status)" = succes ] && [ "$(champ "$M" sans_plan_signale)" = true ] && [ "$(champ "$M" mesures.plan_propose)" = false ] \
  && [ "$(champ "$M" mesures.plan_approuve)" = false ] && [ "$(champ "$M" mesures.rc_proposition)" = 3 ] \
  && ok "aucun plan proposé : sans-plan.txt, travail approuvé sans plan, essai valide compté dans le bras" || echec "aucun plan proposé : $(champ "$M" status_reason)"

# 3. Fichier hors du périmètre : écart « file » avec plan, dérive comptée dans les deux bras.
piloter '{"variante": "hors_plan"}'
essai "$TMP/hors-avec" avec alertes-stock
essai "$TMP/hors-sans" sans alertes-stock
python3 - "$(manifeste_de "$TMP/hors-avec")" "$(manifeste_de "$TMP/hors-sans")" <<'PY' && ok "fichier hors périmètre : compté dans les deux bras, écart file 1 avec plan, précision 0,67, rappel 1" || echec "hors périmètre"
import json, sys
av, sa = (json.load(open(p))["mesures"] for p in sys.argv[1:3])
assert av["hors_perimetre_attendu"] == ["NOTES.md"] and sa["hors_perimetre_attendu"] == ["NOTES.md"], (av, sa)
assert av["ecarts_par_nature"]["file"] == 1 and av["precision_plan"] == 0.67 and av["rappel_plan"] == 1.0, av
assert sa["ecarts"] == 0 and sa["precision_plan"] is None, sa
PY

# 4. Le point de la revue : plan propose sous un contrat approuvé sans plan.
piloter '{"variante": "propose_sans_plan"}'
essai "$TMP/propose-sans" sans alertes-stock
essai "$TMP/propose-avec" avec alertes-stock
python3 - "$(manifeste_de "$TMP/propose-sans")" "$(manifeste_de "$TMP/propose-avec")" <<'PY' && ok "plan propose sans plan approuvé : refusé (« already approved without a plan »), compté dans la trace ; aucun avec plan approuvé" || echec "plan propose dans le bras sans plan"
import json, sys
sa, av = (json.load(open(p)) for p in sys.argv[1:3])
t = sa["execution"]["travail"]["trace"]
assert t["propose"] == 1 and t["propose_refuses"] == 1 and t["propose_deja_approuve"] == 1, t
assert "already approved without a plan" in t["appels_plan"][0]["resultat"], t["appels_plan"]
assert sa["status"] == "succes", sa["status_reason"]
assert av["execution"]["travail"]["trace"]["propose"] == 0 and av["status"] == "succes"
PY

# 5. Réussite réelle, pas le verdict de smol : tests visibles verts, contrôle caché en échec.
piloter '{"variante": "rate"}'
essai "$TMP/rate" sans alertes-stock
M="$(manifeste_de "$TMP/rate")"
[ "$(champ "$M" status)" = echec_test ] && [ "$(champ "$M" valide)" = true ] && [ "$(champ "$M" reussite_reelle)" = false ] \
  && [ "$(champ "$M" mesures.verdict_smol)" = verified ] \
  && ok "verdict verified mais contrôle caché en échec : echec_test valide, pas une réussite" || echec "rate : $(champ "$M" status)"

# 6. Délai du travail dépassé : essai valide, jamais une réussite ; appels lus au contrat.
piloter '{"lent_travail": true}'
essai "$TMP/delai" sans alertes-stock MESURE_DELAI_SECONDES=3
M="$(manifeste_de "$TMP/delai")"
[ "$(champ "$M" status)" = echec_test ] && [ "$(champ "$M" valide)" = true ] && [ "$(champ "$M" mesures.rc_travail)" = 124 ] \
  && [ "$(champ "$M" reussite_reelle)" = false ] && [ "$(champ "$M" mesures.source_appels_modele_travail)" = contrat ] \
  && [ "$(champ "$M" mesures.appels_modele_travail_retenus)" = 1 ] && [ "$(champ "$M" mesures.source_appels_outils_travail)" = trace ] \
  && ok "délai du travail : echec_test valide, code 124, appels au modèle lus dans le contrat archivé (1)" \
  || echec "délai du travail : $(champ "$M" status) $(champ "$M" status_reason) $(champ "$M" mesures.source_appels_modele_travail)"
attendre_vide

# 7. Délai de la proposition : sortie autre que 3, essai invalide (règle, point 1).
piloter '{"lent_proposition": true}'
essai "$TMP/delai-prop" avec alertes-stock MESURE_DELAI_SECONDES=3
M="$(manifeste_de "$TMP/delai-prop")"
[ "$(champ "$M" status)" = proposition_invalide ] && [ "$(champ "$M" valide)" = false ] && [ "$(champ "$M" mesures.rc_proposition)" = 124 ] \
  && ok "délai de la proposition : code 124 au lieu de 3, essai invalide" || echec "délai de la proposition : $(champ "$M" status)"
attendre_vide

# 8. Erreur du serveur (HTTP 500, nouvelles tentatives de smol) : MTPLX indisponible.
piloter '{"erreur_serveur": true}'
essai "$TMP/erreur" sans alertes-stock
M="$(manifeste_de "$TMP/erreur")"
[ "$(champ "$M" status)" = mtplx_indisponible ] && [ "$(champ "$M" valide)" = false ] \
  && [ "$(champ "$M" execution.travail.trace.nouvelles_tentatives_serveur)" != 0 ] \
  && ok "erreur du serveur pendant le travail : invalide (MTPLX indisponible)" || echec "erreur du serveur : $(champ "$M" status)"
piloter '{}'

# 9. Un autre client pendant l'essai : MTPLX occupé, essai invalide.
piloter "{\"etranger_total\": $(( $(etrangers) + 1 ))}"
essai "$TMP/etranger" avec renommage
M="$(manifeste_de "$TMP/etranger")"
[ "$(champ "$M" status)" = mtplx_indisponible ] && [ "$(champ "$M" valide)" = false ] && [ "$(champ "$M" server.concurrence.occupe)" = true ] \
  && ok "requête d'un autre client pendant l'essai : invalide (MTPLX occupé)" || echec "autre client non détecté : $(champ "$M" status)"

# 10 à 12. MTPLX occupé avant, autre modèle, MTPLX absent : smol jamais lancé.
piloter '{"active": 1}'
essai "$TMP/occupe" sans renommage
M="$(manifeste_de "$TMP/occupe")"
[ "$(champ "$M" status)" = mtplx_indisponible ] && [ "$(champ "$M" execution.smol_lance)" = false ] \
  && ok "MTPLX occupé avant l'essai : attente puis invalide, smol non lancé" || echec "MTPLX occupé avant"
piloter '{}'
essai "$TMP/modele" sans renommage MESURE_MODELE_ATTENDU=autre-modele
M="$(manifeste_de "$TMP/modele")"
[ "$(champ "$M" status)" = mtplx_indisponible ] && [ "$(champ "$M" execution.smol_lance)" = false ] \
  && ok "autre modèle servi : invalide, smol non lancé" || echec "autre modèle accepté"
essai "$TMP/absent" sans renommage MTPLX_URL=http://127.0.0.1:9
M="$(manifeste_de "$TMP/absent")"
[ "$(champ "$M" status)" = mtplx_indisponible ] && [ "$(champ "$M" execution.smol_lance)" = false ] \
  && ok "MTPLX absent : invalide, smol non lancé" || echec "MTPLX absent"

# 13 et 14. Verrous : celui du banc (vivant), celui d'une autre campagne.
sleep 300 &
VIVANT=$!
printf '%s\n' "$VIVANT" > "$TMP/verrou-vivant"
essai "$TMP/verrou" sans renommage BANC_LOCK_FILE="$TMP/verrou-vivant"
M="$(manifeste_de "$TMP/verrou")"
[ "$(champ "$M" status)" = blocage_harnais ] && [ "$(champ "$M" execution.smol_lance)" = false ] \
  && [ "$(sed -n 1p "$TMP/verrou-vivant")" = "$VIVANT" ] && ok "verrou du banc actif : blocage sans toucher au verrou" || echec "verrou actif ignoré"
essai "$TMP/externe" sans renommage MESURE_VERROUS_EXTERNES="$TMP/verrou-vivant"
M="$(manifeste_de "$TMP/externe")"
[ "$(champ "$M" status)" = mtplx_indisponible ] && [ "$(champ "$M" execution.smol_lance)" = false ] \
  && ok "verrou d'une autre campagne : attente puis invalide, smol non lancé" || echec "verrou externe ignoré"
kill "$VIVANT" 2>/dev/null
wait "$VIVANT" 2>/dev/null
VIVANT=""

# 15. Empreinte différente : code 5, la campagne s'arrête avant l'essai.
avec_empreinte "$PLAN" "$TMP/plan-empreinte.json" "$(printf '0%.0s' $(seq 1 64))"
essai "$TMP/empreinte" sans renommage MESURE_PLAN="$TMP/plan-empreinte.json"
M="$(manifeste_de "$TMP/empreinte")"
[ "$(cat "$TMP/empreinte/rc")" = 5 ] && [ "$(champ "$M" execution.smol_lance)" = false ] \
  && ok "empreinte de dist/ différente : code 5, smol non lancé" || echec "empreinte différente acceptée"

# 16. smol qui ne démarre pas (ni [stats] ni [mission]) : invalide.
mkdir -p "$TMP/fauxbin/dist"
printf 'console.error("Aucun modèle joignable");\nprocess.exit(1);\n' > "$TMP/fauxbin/dist/index.js"
avec_empreinte "$PLAN" "$TMP/plan-fauxbin.json" "$(empreinte "$TMP/fauxbin")"
essai "$TMP/nondemarre" sans renommage MESURE_PLAN="$TMP/plan-fauxbin.json" MESURE_BIN_RACINE="$TMP/fauxbin"
M="$(manifeste_de "$TMP/nondemarre")"
[ "$(champ "$M" status)" = blocage_harnais ] && [ "$(champ "$M" execution.smol_lance)" = true ] && [ "$(champ "$M" valide)" = false ] \
  && ok "smol qui ne démarre pas : invalide" || echec "smol non démarré mal classé : $(champ "$M" status) $(champ "$M" status_reason)"

# 17. Interruption pendant l'essai : smol arrêté, manifeste invalide, verrou
# libéré, workspace et dossier personnel supprimés.
piloter '{"lent": true}'
mkdir -p "$TMP/interrompu"
env HOME="$VRAIE_MAISON" MESURE_PLAN="$PLAN" MESURE_RESULTATS_DIR="$TMP/interrompu" MESURE_BIN_RACINE="$BINS" \
  MTPLX_URL="$URL" MESURE_MODELE_ATTENDU=fixture-qwen MESURE_MAISON_SOURCE="$VRAIE_MAISON" MESURE_TMP="$TMP/interrompu-tmp" \
  BANC_LOCK_FILE="$TMP/verrou-interrompu" MESURE_VERROUS_EXTERNES="" MESURE_ATTENTE=1 MESURE_DELAI_SECONDES=60 \
  "$B/essai.sh" sans renommage 1 > /dev/null 2>&1 &
ESSAI_PID=$!
for _ in $(seq 1 150); do grep -q '^\[mission\]' "$TMP"/interrompu/*/essai/travail.erreurs.txt 2>/dev/null && break; sleep 0.1; done
sleep 1
kill -TERM "$ESSAI_PID"
wait "$ESSAI_PID"
RC_INT=$?
M="$(manifeste_de "$TMP/interrompu")"
[ "$RC_INT" = 130 ] && [ "$(champ "$M" status)" = blocage_harnais ] && [ "$(champ "$M" valide)" = false ] \
  && [ ! -e "$TMP/verrou-interrompu" ] && [ -z "$(ls -A "$TMP/interrompu-tmp" 2>/dev/null)" ] \
  && ! pgrep -f "$TMP/interrompu-tmp" > /dev/null \
  && ok "interruption : code 130, essai invalide, smol arrêté, verrou libéré, dossiers supprimés" \
  || echec "interruption : code $RC_INT, $(champ "$M" status), restes $(ls "$TMP/interrompu-tmp" 2>/dev/null)"
piloter '{}'
attendre_vide

# 18. Le vrai dossier personnel n'est jamais écrit ; les essais nettoient.
find "$VRAIE_MAISON" -exec stat -f "%N %z %m %p" {} + | sort > "$TMP/vraie-maison-apres.txt"
cmp -s "$TMP/vraie-maison-avant.txt" "$TMP/vraie-maison-apres.txt" && ok "dossier personnel réel inchangé" || echec "dossier personnel réel modifié"
[ -z "$(ls -A "$TMP/essais-tmp" 2>/dev/null)" ] && ok "workspaces, dossiers personnels et TMPDIR des essais supprimés" \
  || echec "restes dans le dossier temporaire des essais : $(ls "$TMP/essais-tmp")"

# 19. Campagne réduite : une tâche, deux paires, extension à quatre.
python3 - "$PLAN" "$TMP/plan-campagne.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
p["taches"] = ["alertes-stock"]
p["paires"], p["paires_extension"], p["paires_valides_minimales"] = 2, 4, 2
json.dump(p, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
# Première requête : un autre client (essai invalide, rejoué) ; premier
# travail avec plan : raté (écart d'une réussite, extension décidée).
piloter "{\"etranger_total\": $(( $(etrangers) + 1 )), \"rate_avec_n\": 1}"
campagne() {
  env HOME="$VRAIE_MAISON" TMPDIR="$TMP/campagne-tmp/" MESURE_PLAN="$TMP/plan-campagne.json" MESURE_RESULTATS_DIR="$TMP/campagne" \
    MESURE_BIN_RACINE="$BINS" MTPLX_URL="$URL" MESURE_MODELE_ATTENDU=fixture-qwen MESURE_MAISON_SOURCE="$VRAIE_MAISON" \
    BANC_LOCK_FILE="$TMP/verrou-campagne" MESURE_VERROUS_EXTERNES="$TMP/verrou-campagn[e]" MESURE_ATTENTE=1 MESURE_ACCEPTER_MODIFIE=1 \
    "$B/campagne.sh" "$@" > "$TMP/campagne-${1:-base}.out" 2> "$TMP/campagne-${1:-base}.err"
}
mkdir -p "$TMP/campagne-tmp"
campagne --inconnu 2>/dev/null
RC_USAGE=$?
campagne
RC1=$?
N1="$(ls "$TMP"/campagne/*/manifeste.json 2>/dev/null | wc -l | tr -d ' ')"
python3 - "$TMP/campagne" <<'PY' && ok "campagne : ordre alterné, invalide rejoué une fois à la même place, extension jouée pour un écart d'une réussite" || echec "campagne ($RC1) : $(tail -3 "$TMP/campagne-base.err")"
import json, pathlib, sys
racine = pathlib.Path(sys.argv[1])
ms = sorted((json.loads(p.read_text()) for p in racine.glob("*/manifeste.json")),
            key=lambda m: m["run"]["started_at"] + m["run"]["id"])
ordre = [(m["run"]["paire"], m["run"]["bras"], m["run"]["tentative"], m["valide"], m["reussite_reelle"]) for m in ms]
assert ordre == [(1, "sans", 1, False, False), (1, "sans", 2, True, True), (1, "avec", 1, True, False),
                 (2, "avec", 1, True, True), (2, "sans", 1, True, True),
                 (3, "sans", 1, True, True), (3, "avec", 1, True, True),
                 (4, "avec", 1, True, True), (4, "sans", 1, True, True)], ordre
assert len({m["run"]["campagne_id"] for m in ms}) == 1 and None not in {m["run"]["campagne_id"] for m in ms}
journal = next(racine.glob("campagne-*.log")).read_text()
assert "extension décidée pour alertes-stock" in journal, journal
PY
[ "$RC_USAGE" = 2 ] && [ "$RC1" = 0 ] && [ ! -e "$TMP/verrou-campagne" ] && [ -z "$(ls -A "$TMP/campagne-tmp" 2>/dev/null)" ] \
  && ok "campagne : code 0, verrou libéré, dossiers temporaires supprimés" || echec "campagne : code $RC1 (usage $RC_USAGE), verrou ou restes"
campagne
N2="$(ls "$TMP"/campagne/*/manifeste.json 2>/dev/null | wc -l | tr -d ' ')"
[ "$N1" = "$N2" ] && grep -q "déjà comptée : alertes-stock paire 4 sans" "$TMP"/campagne/campagne-*.log \
  && ok "reprise : cellules comptées non rejouées, extension comprise" || echec "reprise ($N1 puis $N2 manifestes)"
campagne --extension
[ "$?" = 2 ] && ok "extension sans tâche refusée" || echec "extension sans tâche acceptée"
SHA_TEST="$(git -C "$REPO" rev-parse HEAD)"
MESURE_ACCEPTER_MODIFIE=1 python3 "$B/analyse.py" "$TMP/campagne" --sha "$SHA_TEST" --plan "$TMP/plan-campagne.json" --etape verdict \
  --json "$TMP/campagne-verdict.json" > "$TMP/campagne-verdict.txt" 2>&1
python3 - "$TMP/campagne-verdict.json" <<'PY' && ok "analyse de la campagne réduite : invalide déclaré, quatre paires retenues après extension, trois réussites sur quatre avec plan" || echec "analyse de la campagne réduite : $(tail -5 "$TMP/campagne-verdict.txt")"
import json, sys
r = json.load(open(sys.argv[1]))
assert len(r["point1"]["essais_invalides"]) == 1 and r["point6"]["alertes-stock"]["extension_jouee"], r["point1"]
assert r["point6"]["alertes-stock"]["paires_valides_retenues"] == 4, r["point6"]
assert r["point3"]["total"] == {"sans": 4, "avec": 3} and r["point3"]["blocage_total"], r["point3"]
PY

# 20. Règle de décision sur manifestes synthétiques.
python3 - "$B" "$TMP/synthese" <<'PY' && ok "règle : validité et rejeu, faisabilité (12 sur 15, prorata), blocages (tâche, total), deux effets, coût, bruit et extension, issues" || echec "règle de décision"
import hashlib, json, os, pathlib, subprocess, sys
banc, racine = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
PLAN_SHA = hashlib.sha256((banc / "plan.json").read_bytes()).hexdigest()
TACHES = ["alertes-stock", "renommage", "option-separateur"]

def essai(d, tache, paire, bras, reussite=True, tentative=1, valide=True, plan=True, hors=0,
          travail=10, prop=4, modele="m"):
    nom = f"{tache}-p{paire}-{bras}-t{tentative}"
    m = {"format": "mesure-plan-approuve/v1",
         "run": {"id": nom, "tache": tache, "paire": paire, "bras": bras, "tentative": tentative,
                 "started_at": f"2026-09-27T00:{paire:02d}:{tentative:02d}Z", "campagne_id": "c"},
         "status": ("succes" if reussite else "echec_test") if valide else "mtplx_indisponible",
         "status_reason": "", "valide": valide, "invalidite": None if valide else "MTPLX occupé",
         "harness": {"repository_sha": "abc", "working_tree_dirty": False, "plan_sha256": PLAN_SHA},
         "server": {"model_id": modele}, "execution": {"duree_murale_s": 60, "travail": {"trace": {}}},
         "sans_plan_signale": bras == "avec" and not plan,
         "reussite_reelle": bool(valide and reussite),
         "mesures": {"plan_propose": bras == "avec" and plan, "plan_approuve": bras == "avec" and plan,
                     "hors_perimetre_nombre": hors, "hors_perimetre_attendu": ["x"] * hors,
                     "appels_modele_travail_retenus": travail,
                     "appels_modele_proposition": prop if bras == "avec" else None,
                     "verdict_smol": "verified", "rc_travail": "0"}}
    (d / nom).mkdir(parents=True)
    (d / nom / "manifeste.json").write_text(json.dumps(m))

def campagne(nom, reussites=None, plans=15, hors=(0, 0), prop=4, invalides=None, paires=5, modele_avec="m", sans_compte=False):
    d = racine / nom
    reussites = reussites or {}
    invalides = invalides or {}
    rang = 0
    for t in TACHES:
        sa, av = reussites.get(t, (5, 5))
        for p in range(1, paires + 1):
            for b, n in (("sans", sa), ("avec", av)):
                tent = 1
                if (t, p, b) in invalides:
                    essai(d, t, p, b, valide=False)
                    if invalides[(t, p, b)] == 2:
                        essai(d, t, p, b, tentative=2, valide=False)
                        continue
                    tent = 2
                propose = True
                if b == "avec":
                    rang += 1
                    propose = rang <= plans
                h = (hors[0] if b == "sans" else hors[1]) if (t, p) == ("alertes-stock", 1) else 0
                essai(d, t, p, b, reussite=p <= n, tentative=tent, plan=propose, hors=h, prop=prop,
                      modele=modele_avec if (b == "avec" and (t, p) == ("renommage", 1)) else "m",
                      travail=None if (sans_compte and (t, p, b) == ("renommage", 2, "sans")) else 10)
    return d

def analyser(d, etape="verdict", extension=None):
    out = d / f"analyse-{etape}.json"
    cmd = [sys.executable, str(banc / "analyse.py"), str(d), "--sha", "abc", "--etape", etape, "--json", str(out)]
    if extension:
        cmd += ["--extension-de", extension]
    env = {k: v for k, v in os.environ.items() if k != "MESURE_ACCEPTER_MODIFIE"}
    p = subprocess.run(cmd, capture_output=True, text=True, check=False, env=env)
    return (json.loads(out.read_text()) if out.exists() else None), p.returncode

r, _ = analyser(campagne("egal"))
assert r["issue"] == "NI EFFET NI BLOCAGE" and r["point2"]["plans_proposes"] == 15 and r["point2"]["seuil"] == 12, r["issue"]
r, _ = analyser(campagne("effet-reussites", {"alertes-stock": (2, 5)}))
assert r["issue"] == "EFFET DÉMONTRÉ, COÛT TENU" and r["point5"]["rapport_decimal"] == 1.4, (r["issue"], r["point5"])
r, _ = analyser(campagne("effet-cout", {"alertes-stock": (2, 5)}, prop=6))
assert r["issue"] == "EFFET DÉMONTRÉ, COÛT DÉPASSÉ" and r["point5"]["rapport_decimal"] == 1.6, (r["issue"], r["point5"])
r, _ = analyser(campagne("cout-limite", {"alertes-stock": (2, 5)}, prop=5))
assert r["issue"] == "EFFET DÉMONTRÉ, COÛT TENU", "1,5 exactement ne dépasse pas"
r, _ = analyser(campagne("cout-incomplet", {"alertes-stock": (2, 5)}, sans_compte=True))
assert r["issue"] == "EFFET DÉMONTRÉ, COÛT DÉPASSÉ" and not r["point5"]["comptes_complets"], r["point5"]
r, _ = analyser(campagne("effet-perimetre", hors=(4, 2)))
assert r["issue"].startswith("EFFET") and r["point4"]["effet_perimetre"] and not r["point4"]["effet_reussites"], r["point4"]
r, _ = analyser(campagne("perimetre-insuffisant", hors=(4, 3)))
assert r["issue"] == "NI EFFET NI BLOCAGE", "3 > 70 % de 4"
r, _ = analyser(campagne("perimetre-petit", hors=(2, 0)))
assert r["issue"] == "NI EFFET NI BLOCAGE", "sans < 3 : pas d'effet"
r, _ = analyser(campagne("blocage-tache", {"renommage": (5, 3)}))
assert r["issue"].startswith("BLOCAGE") and r["point3"]["taches_bloquees"] == ["renommage"], r["point3"]
r, _ = analyser(campagne("blocage-total", {"alertes-stock": (5, 4)}))
assert r["issue"].startswith("BLOCAGE") and r["point3"]["blocage_total"] and not r["point3"]["taches_bloquees"], r["point3"]
assert r["point6"]["alertes-stock"]["extension_permise"], r["point6"]
r, _ = analyser(campagne("compense", {"alertes-stock": (5, 4), "renommage": (4, 5)}))
assert r["issue"] == "NI EFFET NI BLOCAGE", r["issue"]
r, _ = analyser(campagne("faisabilite", {"alertes-stock": (2, 5)}, plans=11))
assert r["issue"].startswith("BLOCAGE OU DÉFAUT") and not r["point2"]["faisable"] and r["point2"]["seuil"] == 12, r["point2"]
# Une paire écartée : 14 runs, seuil 12 (80 % arrondi au-dessus).
inv = {("option-separateur", 5, "avec"): 2}
r, _ = analyser(campagne("faisabilite-14-ok", plans=12, invalides=inv))
assert r["point2"]["runs_de_proposition"] == 14 and r["point2"]["seuil"] == 12 and r["point2"]["faisable"], r["point2"]
r, _ = analyser(campagne("faisabilite-14-non", plans=11, invalides=inv))
assert not r["point2"]["faisable"], r["point2"]
# Rejeu : invalide puis valide retenu ; deux fois invalide : paire écartée.
r, _ = analyser(campagne("rejeu", invalides={("renommage", 2, "avec"): 1, ("option-separateur", 3, "sans"): 2}))
assert r["point1"]["paires_valides_base"] == {"alertes-stock": 5, "renommage": 5, "option-separateur": 4}, r["point1"]
assert len(r["point1"]["essais_invalides"]) == 3 and r["issue"] == "NI EFFET NI BLOCAGE", r
r, _ = analyser(campagne("non-concluante", invalides={("renommage", p, "sans"): 2 for p in (1, 2)}))
assert r["issue"] == "NON CONCLUANTE", r["issue"]
r, _ = analyser(campagne("non-concluante-blocage", {"alertes-stock": (5, 2)}, invalides={("renommage", p, "sans"): 2 for p in (1, 2)}))
assert r["issue"].startswith("BLOCAGE"), "un blocage prime sur la validité insuffisante"
r, _ = analyser(campagne("modele", modele_avec="autre"))
assert r["point1"]["paires_ecartees"][0]["motif"] == "modèle différent dans la paire", r["point1"]
# Bruit : un seul écart, extension permise pour cette tâche seulement.
d = campagne("bruit", {"alertes-stock": (5, 4)})
r, rc = analyser(d, "reussites", "alertes-stock")
assert rc == 0 and r["taches"]["alertes-stock"]["extension_permise"], r
_, rc = analyser(d, "reussites", "renommage")
assert rc == 1
# Extension jouée : paires 6 à 10 pour alertes-stock (sans 4, avec 5) ; au
# total, 9 contre 9 ; paire 6 d'une autre tâche ignorée.
for p in range(6, 11):
    essai(d, "alertes-stock", p, "sans", reussite=p <= 9)
    essai(d, "alertes-stock", p, "avec", reussite=True)
essai(d, "renommage", 6, "avec", reussite=False)
r, _ = analyser(d)
assert r["point6"]["alertes-stock"]["paires_valides_retenues"] == 10 and r["point6"]["renommage"]["paires_valides_retenues"] == 5, r["point6"]
assert r["point3"]["reussites_par_tache"]["alertes-stock"] == {"sans": 9, "avec": 9} and r["issue"] == "NI EFFET NI BLOCAGE", r["point3"]
assert r["essais_hors_regle"] == ["renommage paire 6 avec"], r["essais_hors_regle"]
assert r["point2"]["runs_de_proposition"] == 15 and r["point2"]["extension_runs"] == 5, r["point2"]
PY

if [ "$ECHECS" -eq 0 ]; then
  echo "PASS: mesure #29 — déroulé complet sur le binaire $([ "$SAUTES" = 0 ] && echo "figé du protocole" || echo "du dépôt"), validité, isolement, campagne et règle vérifiés sans modèle ($SAUTES sauté(s))"
  exit 0
fi
echo "FAIL: $ECHECS vérification(s) en échec, $SAUTES sautée(s)" >&2
exit 1
