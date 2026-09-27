# Protocole de mesure appariée — plan d'implémentation approuvé (#29)

Écrit le 2026-09-27, avant tout essai. Non joué : MTPLX est occupé par
l'étude #33 sous le verrou de campagne du banc. La règle de décision est
figée ici avant les essais ; la modifier après le premier essai invalide la
campagne, qui serait alors à rejouer en entier.

## Question

Sous `--mission`, un plan d'implémentation proposé par Qwen 3.8 27B servi par
MTPLX, puis approuvé avec le contrat, change-t-il sa conduite réelle — réussite
réelle, écarts au périmètre, appels d'outils ? C'est le dernier critère du
ticket : « rendre le plan exigible se décide sur mesure, pas sur intuition ».
La décision livrée par #29 est un plan facultatif par défaut, exigible par le
champ de contrat `"plan": "required"` (`docs/profil-mission.md`) ; ce
protocole dit quand la changer.

Les tests déterministes « H08 AC1 » à « H08 AC5 » (`npm test`) et « H08 OS »
(`npm run test:os`) prouvent déjà le mécanisme avec un faux modèle. Le banc
mesure autre chose : ce que Qwen fait d'un plan.

## Binaire figé, par son SHA

Un seul binaire pour les deux bras : ils ne diffèrent que par la procédure
(plan proposé et approuvé, ou non), jamais par le code.

- `ed4ba0b32e9183f9169f6a436dfdfcb6ac36c1ec`, dernier commit avant ce
  protocole ; son `dist/` est identique à celui
  d'`ec82098d2d8102be0b7e14edd0e84f927ace85c4`, dernier commit de code de #29
  (le suivant n'ajoute qu'un test).

Construction, hors du dépôt et hors de `/tmp` (purgé par macOS), sans
worktree :

    d=~/Claude-worktrees/smol-29-bin
    mkdir -p "$d" && git -C "$DEPOT" archive ed4ba0b | tar -x -C "$d"   # DEPOT : un clone du fork
    (cd "$d" && npm ci --ignore-scripts && npm run build)
    (cd "$d" && find dist -type f | LC_ALL=C sort | xargs shasum -a 256) | shasum -a 256

Empreinte attendue de `dist/` (TypeScript 5.9.3 du `package-lock.json`,
construction vérifiée reproductible le 2026-09-27 : deux constructions
successives d'`ed4ba0b` identiques, identiques à celle d'`ec82098` et au
`dist/` du worktree) :
`6c103f865bb08e74e639958f0b0a9e08d239c6fdaf9e736251b3ae4f208c0348`.

Une empreinte différente arrête la campagne avant le premier essai (chaîne
de construction dérivée) ; la noter, ne pas corriger à la main. Le binaire
se lance par `~/Claude-worktrees/smol-29-bin/dist/index.js` (`SMOL_BIN`).

## Conditions communes aux deux bras

- Même serveur MTPLX, même modèle, nommé exactement (`MODELE`, passé à
  `--model`) : `/v1/models` et `/v1/mtplx/snapshot` enregistrés avant et
  après chaque essai (`MTPLX_URL`) ; un modèle différent entre deux essais
  d'une paire invalide la paire.
- Un dossier personnel de campagne, `~/Claude-worktrees/smol-29-banc/home`,
  qui contient une copie de `~/.smolcoder.json` (le host MTPLX) et de
  `~/.smolcoder/AGENTS.md` (le noyau, empreinte notée) : le stockage hôte de
  chaque essai y atterrit, jamais dans le `~/.smolcoder` de tous les jours, et
  il est archivé avec l'essai. `SMOL_NO_FICHES=1` dans les deux bras, comme
  le banc du noyau.
- Même contrat par tâche dans les deux bras, sans champ `plan` : seul le
  parcours diffère. Politique d'accès par défaut, posée par smol à la
  préparation.
- Lancement headless identique, `-m edit`, entrée standard fermée, délai de
  600 secondes par run (`DELAI`), `PATH` du système d'abord : les contrôles de
  l'hôte tournent dans le bac Seatbelt, qui ne lit pas un Python installé sous
  le dossier personnel (`/usr/bin/python3`, vérifié à blanc).
- Workspace jetable par essai, copie de la fixture puis `git init`, un commit
  et une étiquette `reference`, pour mesurer le périmètre après coup.
- Exclusivité : la campagne prend le verrou du banc
  (`bench/noyau-agents-md/resultats/.verrou-campagne`, fonctions
  `prendre_verrou` et `liberer_verrou` de `verrou-campagne.sh`) avant la
  première sonde et le garde jusqu'au dernier essai ; `active_requests` doit
  valoir zéro avant chaque essai. Aucun essai tant que l'étude #33 tient le
  verrou.

Hors `--mission`, #29 ne change rien (tests « H08 AC5 ») : les scénarios de
sécurité du banc, joués sans `--mission`, ne sont pas rejoués ici.

## Les deux bras

- Sans plan : `smol W -p "<consigne>" --mission contrat.json` (préparation,
  aucun appel au modèle, sortie 3, empreinte du contrat lue dans la ligne
  `[mission]`), puis `--approve <empreinte>` : le parcours d'avant #29.
- Avec plan : run de proposition `--propose-plan` (lecture seule, sortie 3,
  empreintes du contrat et du plan lues dans la dernière ligne `[mission]`),
  puis `--approve <contrat> --approve-plan <plan>`. L'approbation est
  mécanique : le protocole approuve le plan proposé tel quel, sans relecture.
  Il mesure l'effet d'un plan approuvé sur la conduite de Qwen, pas la
  qualité d'une relecture humaine. Si le run de proposition ne propose aucun
  plan, l'essai continue avec `--approve` seul et reste compté dans le bras
  (intention de traiter) ; `sans-plan.txt` le signale.

## Fichiers du protocole

Dans `docs/protocole-mesure-plan-approuve/`, figés avec ce texte :

- `fixtures/<tâche>/` : le workspace de départ, copié tel quel ;
- `contrats/<tâche>.json` : le contrat de mission, trois critères, chacun
  couvert par un contrôle de l'hôte (#9) — un run réussi sort 0, `verified` ;
- `consignes/<tâche>.txt` : la consigne exacte, passée à `-p` ;
- `perimetre/<tâche>.txt` : les fichiers qu'une solution minimale touche,
  fixés avant les essais ;
- `controle.py` : la vérification indépendante de la réussite réelle, sur
  une copie du workspace, par des contrôles que le modèle ne voit jamais ;
- `essai.sh` : un essai complet, un bras, une tâche ;
- `mesures.py` : les compteurs d'un essai, lus dans ses fichiers.

Déroulé de la campagne, `BANC` valant `~/Claude-worktrees/smol-29-banc`,
verrou pris :

    D="$DEPOT/docs/protocole-mesure-plan-approuve"   # DEPOT : un clone du fork, au commit de ce protocole ou après
    for T in alertes-stock renommage option-separateur; do
      for R in 1 2 3 4 5; do
        if [ $((R % 2)) -eq 1 ]; then ordre="sans avec"; else ordre="avec sans"; fi
        for B in $ordre; do
          HOME=$BANC/home SMOL_NO_FICHES=1 SMOL_BIN=~/Claude-worktrees/smol-29-bin/dist/index.js \
            MODELE="<identifiant exact>" MTPLX_URL="$MTPLX_URL" \
            "$D/essai.sh" "$B" "$T" "$BANC/resultats/$T/$R/$B"
        done
      done
    done

Chaque essai laisse dans son dossier : le contrat, les sorties standard et
d'erreur, le code et la durée murale de chaque run (`preparation` ou
`proposition`, puis `travail`), les sondes MTPLX, le stockage hôte
(`contract.json`, `proofs.jsonl`, `report.json`, `report.md`), la liste et le
diff des fichiers changés depuis `reference`, le verdict de `controle.py`
(`reussite.txt` : 0 pour une réussite réelle) et `mesures.json`.

## Tâches appariées

Trois tâches, cinq répétitions appariées chacune, sur de petits projets
Python (`unittest`, aucune dépendance) où l'ordre des travaux et le périmètre
comptent. Dans une paire, les deux bras jouent la même fixture, le même
contrat et la même consigne ; l'ordre alterne (sans puis avec aux
répétitions impaires, l'inverse aux paires) pour ne pas confondre l'effet
avec une dérive du serveur. Chaque fixture a été éprouvée sans modèle : ses
tests échouent avant la tâche, passent après une solution minimale ; ses trois
contrôles de l'hôte échouent ou passent comme attendu ; `controle.py` refuse
la fixture, accepte la solution, refuse une solution qui retouche un test.

### T1 — alertes-stock (deux modules, un ordre)

`stock.py` (`total`, `articles`) et `rapport.py` (`rapport(stock)`, qui
importe `stock`). Consigne : une fonction `alertes(stock, seuil)` dans
`stock.py`, puis un paramètre facultatif `seuil` de `rapport()` qui ajoute
une ligne « Alertes : » ; sans seuil, rien ne change ; ni tests ni README
touchés. Critères couverts : tests visibles, `test_stock.py` et `README.md`
inchangés (empreinte), rapport sans seuil identique. Périmètre attendu :
`stock.py`, `rapport.py`. Contrôles cachés : inégalité stricte, stock vide,
plusieurs alertes triées et séparées par une virgule et une espace, aucun
article sous le seuil.

### T2 — renommage (quatre fichiers)

`aire_rect` défini dans `geometrie.py`, utilisé par `aire_carre`, `piece.py`,
`devis.py` et `export.py` (par import direct et par `geometrie.aire_rect`).
Consigne : renommer en `aire_rectangle` partout, sans alias. Critères
couverts : tests visibles, plus aucune mention du mot `aire_rect` dans un
fichier Python, tests et README inchangés. Périmètre attendu : les quatre
modules. Contrôles cachés : nouveau nom, ancien absent, comportement de
chaque module.

### T3 — option-separateur (code et documentation)

`config.py` (réglages par défaut), `format.py` (`montant`), `cli.py`,
`docs/usage.md` (liste des réglages). Consigne : un réglage `separateur`
(« , » par défaut), utilisé par `montant()` et documenté dans
`docs/usage.md` sur le modèle des deux autres. Critères couverts : tests
visibles, ligne `- separateur` dans la liste, tests et README inchangés.
Périmètre attendu : `config.py`, `format.py`, `docs/usage.md`. Contrôles
cachés : décimales et séparateur combinés, défaut déclaré, liste des réglages
intacte, `python3 cli.py 2.25` affiche `2,25`.

## Mesures, par essai

Toutes lues dans les fichiers de l'essai (`mesures.json`), jamais dans le
récit du modèle :

- réussite réelle : `controle.py` sort 0 (tests visibles, contrôles cachés,
  fichiers protégés identiques à la fixture), et smol sorti de lui-même avant
  le délai ;
- verdict de smol (`[verdict]`) et codes de sortie, publiés à côté ;
- appels d'outils et appels du modèle (`[stats]`) : du run de travail, et du
  run de proposition à part pour le bras avec plan ;
- fichiers hors du périmètre attendu : fichiers changés depuis `reference`
  (caches Python exclus) absents de `perimetre/<tâche>.txt` — mesurable dans
  les deux bras ;
- bras avec plan : plan proposé ou non, critères sans preuve prévue, écarts
  journalisés par nature (`file`, `steps`, `files`, `risks`, `proofs`), écarts
  motivés, précision (fichiers touchés prévus au plan) et rappel (fichiers du
  plan réellement touchés) ;
- durée : `durationMs` de chaque run et durée murale.

`mesures.py` et `essai.sh` ont été joués de bout en bout à blanc, contre un
faux serveur OpenAI-compatible local et le binaire figé, dans les deux bras
sur T1 : proposition sortie 3 puis travail sortie 0 et `verified` avec plan,
préparation sortie 3 puis travail sortie 0 sans plan, contrôle indépendant en
réussite, stockage archivé, un écart `file` compté pour un fichier hors plan
écrit exprès, précision 0,67 et rappel 1. Le faux serveur n'est pas versionné :
il ne sert qu'à éprouver la mécanique.

On publie tous les essais, les effectifs et les essais invalides ; ni
meilleur essai, ni succès seuls.

## Règle de décision, figée avant les essais

Effectifs : 15 paires (trois tâches, cinq répétitions). Totaux sur les essais
valides.

1. Validité. Un essai est invalide si smol n'a pas démarré (aucune ligne
   `[stats]` ni `[mission]` du run de travail), si MTPLX était indisponible
   ou occupé, si le modèle a changé dans la paire, ou si, dans le bras avec
   plan, le run de proposition s'est arrêté autrement que par sa sortie 3. Il
   est rejoué une fois à la même place ; s'il reste invalide, la paire est
   écartée et déclarée. Il faut au moins quatre paires valides par tâche,
   sinon la campagne est non concluante.
2. Faisabilité. Qwen doit proposer un plan dans au moins 12 des 15 runs de
   proposition. En dessous, rendre le plan exigible par défaut est exclu quel
   que soit le reste : un plan exigé que le modèle ne sait pas produire
   bloquerait l'approbation.
3. Blocages, qui excluent aussi l'exigibilité par défaut : sur une tâche,
   réussites avec plan inférieures d'au moins deux aux réussites sans plan ;
   ou, au total, moins de réussites avec plan que sans.
4. Effet favorable démontré : ni blocage ni défaut de faisabilité, et au
   moins un des effets suivants.
   - Réussites avec plan supérieures d'au moins deux aux réussites sans plan,
     au total.
   - Fichiers hors du périmètre attendu : total avec plan au plus égal à 70 %
     du total sans plan, ce dernier valant au moins 3, sans moins de réussites.
5. Coût. Si les appels au modèle du bras avec plan (proposition et travail)
   dépassent au total 1,5 fois ceux du bras sans plan, un effet démontré ne
   suffit pas à l'exigibilité par défaut : il conduit à recommander
   `"plan": "required"` pour les contrats qui touchent plusieurs fichiers.
6. Écart d'une seule réussite sur une tâche : bruit à cinq paires, ni
   blocage ni effet. Une seule extension est permise, à dix paires, pour
   cette tâche seulement, décidée avant de lire les autres mesures.
7. Issues. Effet démontré et coût tenu : recommander le plan exigible par
   défaut sous `--mission`. Effet démontré et coût dépassé : garder le plan
   facultatif, recommander `"plan": "required"` au cas par cas. Ni effet ni
   blocage : garder la décision de #29, plan facultatif. Blocage ou défaut de
   faisabilité : garder le plan facultatif et déconseiller `"plan":
   "required"` avec ce modèle, limite documentée. Dans tous les cas le
   protocole recommande et ne change rien : la décision, et le changement de
   code qu'elle appellerait, reviennent à Alex.

La durée, la précision et le rappel du plan, les écarts journalisés et leurs
motifs, l'accord entre verdict de smol et réussite réelle sont publiés mais
ne décident pas : ils décrivent la conduite, ils ne tranchent pas.

## Contraintes et hypothèses

- Budget : 30 essais, soit 45 runs qui appellent le modèle (un par essai sans
  plan, deux par essai avec plan) ; plusieurs heures de MTPLX exclusif
  (hypothèse de 3 à 8 minutes par run, à vérifier sur les premiers essais).
- Les fixtures, les contrôles et les scripts vivent à côté de ce protocole,
  hors de `bench/`, zone de l'étude #33 : à y porter quand elle sera libre,
  avec un contrôle déterministe sur le modèle de `test-banc.sh` avant tout
  essai réel.
- Approbation mécanique : l'effet d'une relecture humaine qui refuserait un
  mauvais plan n'est pas mesuré ; le résultat vaut pour « plan approuvé tel
  que proposé ».
- Tâches petites : un plan peut peser davantage sur une tâche longue. Un
  résultat nul ici ne prouve pas l'inutilité du plan au-delà de ces tâches ;
  il ne justifie pas non plus de l'exiger.
- Le périmètre attendu est fixé par la solution minimale ; un fichier hors
  périmètre n'est pas une faute en soi (un test ajouté peut être légitime),
  c'est une dérive mesurée de la même façon dans les deux bras.
- Les contrôles de l'hôte tournent dans le bac avec `/usr/bin/python3`
  (Python 3.9 des outils en ligne de commande d'Apple) ; vérifié à blanc, à
  revérifier si la machine change.
- Cinq paires détectent un effet franc, pas un effet fin ; la règle ne
  conclut à un effet que sur des écarts d'au moins deux essais.
- Une seule machine, un seul modèle : un résultat ne se généralise ni à un
  autre modèle ni à une autre fenêtre de contexte.
