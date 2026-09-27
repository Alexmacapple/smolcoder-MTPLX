# Mesure appariée du plan approuvé (#29) — 2026-09-27

Campagne jouée selon le protocole pré-enregistré
`docs/protocole-mesure-plan-approuve.md` (commité avant tout essai dans
`9502a2e`), avec le runner `bench/mesure-plan-approuve/`. La règle de
décision du protocole est appliquée telle quelle ; les sections « Binaire et
empreinte », « Runner », « Écarts déclarés » et « Plan de jeu » sont écrites
et commitées avant le premier essai.

## Question

Sous `--mission`, un plan d'implémentation proposé par Qwen 3.8 27B servi par
MTPLX, puis approuvé avec le contrat, change-t-il sa conduite réelle —
réussite réelle, écarts au périmètre, appels d'outils ? C'est le dernier
critère du ticket #29 : « rendre le plan exigible se décide sur mesure, pas
sur intuition ». La décision livrée par #29 est un plan facultatif par
défaut, exigible par le champ de contrat `"plan": "required"`. La mesure
recommande ; la décision revient à Alex.

## Binaire et empreinte

Un seul binaire pour les deux bras, `ed4ba0b32e9183f9169f6a436dfdfcb6ac36c1ec`,
construit le 2026-09-27 selon la recette du protocole : `git archive ed4ba0b`
depuis `/Users/alex/smolcoder` (clone du fork, remote
`git@github.com:Alexmacapple/smolcoder-MTPLX.git`), extrait dans
`~/Claude-worktrees/smol-29-bin` (hors du dépôt, hors de `/tmp`, sans
worktree), puis `npm ci --ignore-scripts` et `npm run build`. Node v26.9.0,
TypeScript 5.9.3 (celui du `package-lock.json`).

Empreinte de `dist/` (50 fichiers), par la commande du protocole :
`6c103f865bb08e74e639958f0b0a9e08d239c6fdaf9e736251b3ae4f208c0348`,
identique à l'empreinte attendue. Le runner la recalcule avant chaque essai
et avant la campagne ; une différence arrête tout (code 5), sans correction
à la main.

## Runner

`bench/mesure-plan-approuve/`, qui réutilise l'outillage de la mesure #19 :

- `plan.json` : binaire et empreinte, modèle attendu
  (`mtplx-qwen38-27b-optimized-speed-fp16`), délai de 600 s par run, tâches,
  paires, seuil de faisabilité, empreintes SHA-256 des 29 pièces du
  protocole (texte, fixtures, contrats, consignes, périmètres,
  `controle.py`, `essai.sh`, `mesures.py`) et de l'outillage réutilisé
  (`bench/mesure-retours-outils/mesure.py`, `verrou-campagne.sh`). Chaque
  essai refuse de partir si une pièce diffère, manque ou s'ajoute.
- `essai.sh` : un essai d'une tâche avec un bras. Le déroulé est celui de
  l'`essai.sh` figé du protocole, appelé tel quel (workspace jetable,
  préparation ou proposition, approbation mécanique, travail, sondes,
  stockage hôte, périmètre, `controle.py`, `mesures.py`). Le runner y ajoute
  ce que le protocole laisse à la campagne : verrou, pièces figées,
  empreinte, préconditions MTPLX, dossier personnel jetable, sonde de
  concurrence (commandes `sonde` et `concurrence` de la mesure #19,
  inchangées), classement de validité, manifeste JSON et statuts du banc
  (`succes`, `echec_test`, `blocage_harnais`, `mtplx_indisponible`, plus
  `proposition_invalide`).
- `mesure.py` : contrôle des pièces, lecture de la trace des runs (appels de
  l'outil `plan` par action et leur résultat, erreurs du serveur),
  classement de validité, manifeste, état des cellules pour la reprise.
- `campagne.sh` : ordre du protocole sous le verrou, rejeu unique à la même
  place, extension du point 6 décidée par l'analyse et jouée dans la même
  campagne, reprise.
- `analyse.py` : la règle de décision, point par point, depuis les
  manifestes bruts ; l'étape `reussites` ne lit que validité et réussites.
- `test-mesure.sh` et `faux-mtplx.py` : contrôle déterministe sans modèle.
  Un faux MTPLX compatible OpenAI scénarise Qwen sur les trois tâches
  (lecture puis `plan propose` au run de proposition, solution minimale au
  travail, variantes) et les essais tournent sur le binaire figé, par
  l'`essai.sh` du protocole. Résultat avant tout essai réel : PASS,
  28 contrôles, aucun sauté (3 min 19 s). Il montre notamment : les deux
  bras sur les trois tâches (proposition sortie 3, plan approuvé, précision
  et rappel 1, `verified`, contrôle indépendant en réussite, stockage et
  workspace archivés, requêtes MTPLX toutes attribuées à l'essai) ; un run
  de proposition sans plan (l'essai continue avec `--approve` seul,
  `sans-plan.txt`) ; un fichier hors périmètre compté dans les deux bras et
  journalisé comme écart `file` avec plan (précision 0,67) ; un
  `plan propose` tenté au travail sans plan approuvé, refusé par l'hôte
  (« already approved without a plan ») et compté dans la trace ; un
  `verified` de smol démenti par un contrôle caché ; les cas d'invalidité ;
  la campagne (ordre alterné, rejeu, extension jouée pour un écart d'une
  réussite, reprise) ; chaque point de la règle sur manifestes
  synthétiques. Deux mutations volontaires (seuil de coût porté à 2,
  sortie 124 de la proposition acceptée) font échouer exactement les deux
  contrôles visés ; les fichiers ont été restaurés à l'identique.

## Écarts déclarés avant le premier essai

La règle de décision n'est pas modifiée. Les points suivants sont des
écarts imposés par l'exécution, ou des précisions opératoires d'une
formulation ambiguë, tranchées avant tout essai.

1. Source du binaire. `git archive` part de `/Users/alex/smolcoder`, clone
   du fork (le protocole dit « un clone du fork ») ; l'empreinte obtenue est
   celle du protocole.
2. Emplacements. Le protocole range chaque essai dans
   `$BANC/resultats/<tâche>/<répétition>/<bras>` avec
   `BANC=~/Claude-worktrees/smol-29-banc`. Le runner écrit chaque essai dans
   `bench/mesure-plan-approuve/resultats/<horodatage>-<tâche>-p<paire>-<bras>.<suffixe>/`
   (ignoré par Git), avec la sortie de l'`essai.sh` du protocole dans le
   sous-dossier `essai/`, qui porte exactement les fichiers que le protocole
   énumère. Aucun dossier `smol-29-banc` n'est créé.
3. Dossier personnel. Jetable par essai plutôt qu'un seul pour la campagne,
   créé dans le dossier temporaire de l'utilisateur, avec les copies du
   noyau `~/.smolcoder/AGENTS.md` et de `~/.smolcoder.json` figées une fois
   au début de la campagne (empreintes notées dans chaque manifeste) ; le
   stockage hôte y atterrit, puis tout son `.smolcoder` est archivé avec
   l'essai (`maison-smolcoder.tar.gz`, en plus du `stockage/` du protocole)
   et le dossier est supprimé. Aucun état ne passe ainsi d'un essai à
   l'autre ; mêmes conditions dans les deux bras. Le vrai `~/.smolcoder`
   n'est que lu.
4. Environnement de smol. `FORCE_COLOR` (qui vaut 3 dans l'environnement de
   la session et colorerait la trace), `SMOL_NO_GLOBAL_AGENTS`,
   `SMOLCODER_CONFIG` et `OLLAMA_HOST` sont retirés ; `SMOL_NO_FICHES=1`
   (protocole) ; le `PATH` est celui que pose l'`essai.sh` du protocole
   (`/usr/bin` d'abord). `TMPDIR` pointe dans un dossier jetable par essai :
   l'`essai.sh` du protocole y crée le workspace, smol ses dossiers de bac ;
   le workspace final est archivé (`espace-final.tar.gz`), puis tout est
   supprimé. Mêmes conditions dans les deux bras.
5. Verrou. La campagne prend le verrou du banc de ce worktree
   (`bench/noyau-agents-md/resultats/.verrou-campagne`, fonctions de
   `verrou-campagne.sh`) avant la première sonde et le garde jusqu'au
   dernier essai, extension comprise (jouée dans la même campagne). Avant
   chaque essai, elle attend (dix minutes au plus), sans les prendre, les
   verrous vivants de même nom des campagnes de `~/smolcoder/bench/*` et des
   autres worktrees `~/Claude-worktrees/*/bench/*`, son propre verrou
   exclu : l'étude #33 citée par le protocole ne tient plus de verrou
   (constaté), d'autres worktrees préparent des mesures.
6. Garde de l'essai. L'`essai.sh` du protocole tourne dans son propre
   groupe de processus, sous une garde globale de 2 × 600 + 300 s qui
   n'intervient pas en temps normal (chaque run de smol garde son délai de
   600 s, `DELAI` du protocole) ; une interruption arrête tout le groupe et
   laisse un manifeste invalide.
7. Validité (point 1), définitions opératoires :
   - smol n'a pas démarré : ni `[stats]` ni `[mission]` dans la sortie
     d'erreur du run de travail (formulation du protocole). Également
     invalide, parce que rien n'a tourné : la première ligne `[mission]` du
     travail dans un autre état que `approved` (approbation refusée par la
     porte), ou un essai non lancé pour une cause du harnais (verrou, pièce
     modifiée ; empreinte : arrêt de la campagne) ;
   - MTPLX indisponible : `/v1/models` ou le snapshot inexploitable avant
     l'essai ; dans la trace de la proposition ou du travail, une ligne
     « backend error … retrying » (le serveur a failli, même si smol s'en
     est remis) ou un tour arrêté en erreur sur une erreur du transport ;
     MTPLX muet après l'essai. Le run de proposition sort 3 même quand il a
     échoué sur le serveur : d'où la lecture de la trace ;
   - MTPLX occupé : comme #19, `active_requests` non nul après dix minutes
     d'attente avant l'essai ; pendant l'essai, `active_requests` d'au moins
     2 à une sonde (toutes les cinq secondes), ou une requête relevée dans
     `recent` qui chevauche l'essai et ne lui appartient pas (dernier
     message utilisateur autre que la consigne, session MTPLX autre que
     celles de l'essai). C'est ainsi qu'est traité « si Alex utilise Qwen en
     même temps » ;
   - modèle : chaque essai exige, avant (précondition) et après (sondes de
     l'`essai.sh` du protocole), le modèle nommé
     `mtplx-qwen38-27b-optimized-speed-fp16`, passé à `--model` ; un autre
     modèle rend l'essai invalide. Les deux essais valides d'une paire ont
     donc le même modèle (contrôle gardé dans l'analyse) ;
   - proposition : dans le bras avec plan, un run de proposition sorti
     autrement que par 3 rend l'essai invalide (statut
     `proposition_invalide`), délai de 600 s compris ;
   - rejeu : immédiat, à la même place ; au plus deux tentatives par
     cellule ; la première valide est retenue ; deux invalides écartent la
     paire, déclarée. Le seuil de quatre paires valides se lit sur les cinq
     paires de base.
8. Réussite réelle : `controle.py` sort 0 et le run de travail n'est pas
   sorti par 124 (délai), 137 ou 143 (arrêt forcé). Un run de travail arrêté
   au délai est un essai valide et un échec. Toute autre sortie (0, 3 pour
   un budget épuisé, code de verdict) est une sortie de lui-même : la
   réussite ne dépend alors que de `controle.py`.
9. Comptes. Appels d'outils et appels au modèle lus dans `[stats]`
   (protocole). Pour un run de travail sans `[stats]` (arrêté au délai) :
   appels au modèle = `usage.steps` du `contract.json` archivé (smol débite
   un pas avant chaque appel au modèle d'un run approuvé ; égal à
   `modelCalls` sur les traces du test), appels d'outils = lignes « → » de
   la trace hors contrôles de l'hôte (« → verification ») ; la source est
   notée dans le manifeste. Un run de proposition sans `[stats]` rend de
   toute façon l'essai invalide.
10. Cas limites de la règle, tranchés avant les essais :
    - point 2, faisabilité : comptée sur les runs de proposition des essais
      « avec » retenus dans les paires valides de base (15 au plus) ; seuil
      12 sur 15, soit 80 % des runs comptés arrondis au-dessus (12 quand les
      15 sont là, 12 aussi pour 14, 11 pour 13) ; les runs de proposition
      d'une extension sont publiés, pas comptés ;
    - point 3, blocages, lus à la lettre sur les paires retenues : par
      tâche, réussites avec plan inférieures ou égales aux réussites sans
      plan moins deux ; au total, réussites avec plan strictement
      inférieures. Un écart total d'une seule réussite est donc un blocage,
      même s'il vient d'une seule tâche : le point 6 parle de l'écart « sur
      une tâche », pas du total ; l'extension, quand elle est due, est jouée
      avant cette lecture ;
    - point 4 : « sans moins de réussites » veut dire total avec plan au
      moins égal au total sans plan ; les fichiers hors périmètre se
      comptent en nombre de fichiers (`hors_perimetre_attendu` de
      `mesures.py`), sommés sur les paires retenues ;
    - point 5 : « dépassent » est strict (plus de 1,5 fois) ; si un compte
      manque dans un essai retenu, le coût n'est pas établi et il est tenu
      pour dépassé, le sens prudent pour l'exigibilité par défaut ;
    - point 6 : l'extension à dix paires est jouée mécaniquement, dans la
      même campagne et sous le même verrou, pour chaque tâche dont les
      réussites diffèrent d'exactement une sur les paires de base avec au
      moins quatre paires valides (décision d'`analyse.py --etape
      reussites`, qui ne lit que validité et réussites) ; au plus une
      extension par tâche, paires 6 à 10 de cette tâche seulement, même
      alternance ; mêmes seuils absolus ensuite ;
    - point 7, préséance : un blocage ou un défaut de faisabilité exclut
      l'exigibilité par défaut « quel que soit le reste », validité
      insuffisante comprise ; sinon, validité insuffisante : non concluante,
      aucune recommandation de changement ; sinon effet et coût ; sinon ni
      effet ni blocage.
11. Observations hors règle, publiées, qui ne décident rien : pour chaque
    run, les appels de l'outil `plan` par action (`propose`, `set`, `done`,
    `add`…) et leur résultat, lus dans la trace ; dans le bras sans plan, les
    `plan propose` tentés au travail et la réponse de l'hôte, pour le point
    signalé par la revue de #29 (sous `--mission`, la description de l'outil
    `plan` montre l'action `propose` même sans plan) ; les relances « plan
    has unfinished steps — nudging » de smol ; l'accord entre `verified` et
    réussite réelle ; durées, précision et rappel du plan, écarts
    journalisés et leurs motifs.

## Plan de jeu

`campagne.sh` sur le commit qui porte ce runner et ces écarts (arbre propre
exigé, SHA noté dans chaque manifeste), puis `analyse.py --etape verdict`
sur ce SHA, puis relecture à la main d'au moins un essai par tâche et par
bras. Ordre du protocole : `alertes-stock`, puis `renommage`, puis
`option-separateur` ; répétitions 1 à 5 ; sans puis avec aux répétitions
impaires, l'inverse aux paires.

Estimation annoncée avant le lancement : 30 essais, 45 runs qui appellent
Qwen. D'après les durées de #19 (environ une minute par run), 1 h à 1 h 30 ;
dans l'hypothèse du protocole (3 à 8 minutes par run), 2 h 15 à 6 h ; plus
10 essais si une extension est due. Borne haute théorique : 7 h 30 si chaque
run atteint son délai.

## Résultats

Sections ajoutées après la campagne, jouée sur `cb507fa` (le commit qui
porte le runner et les écarts ci-dessus, arbre propre dans chaque
manifeste). Aucune ligne de ce qui précède n'a été modifiée.

### Déroulé et durée

- Campagne `20260927T190946Z-98125`, de 19:09:46 à 20:07:47 UTC
  (58 min 01 s), 30 essais, verrou du banc pris avant le premier essai et
  libéré après le dernier. Un premier lancement, à 19:09:32, n'a rien
  démarré : la redirection de sa sortie visait le dossier `resultats/`,
  pas encore créé (aucun verrou pris, aucun essai, aucun manifeste).
- Étape « reussites » en fin de campagne : écart 0 sur les trois tâches,
  aucune extension due, aucune jouée.
- Aucun essai invalide, aucun rejeu, aucune paire écartée. Modèle
  `mtplx-qwen38-27b-optimized-speed-fp16` avant et après chaque essai ;
  binaire `6c103f86…0348`, noyau
  `00c9d2d2c40c0f011a9f172b073e3a75235d508d5b1d5671ee67c6c5e5965205`
  (25 lignes chargées) et configuration
  `b1d9853e39cc882634cec8d0a4ea352066a2dfa5a7fea54a2a1f38cf91c6cc9e`
  identiques dans les 30 essais (ceux de #19). Aucune requête d'un autre
  client relevée, `active_requests` au plus 1 à chaque sonde.
- L'estimation annoncée (1 h à 1 h 30) est tenue : essai médian de 65 s
  sans plan, de 145 s avec plan.
- 30 manifestes dans `bench/mesure-plan-approuve/resultats/` (ignoré par
  Git), empreinte de leur liste
  `424ba9b80031823c54ce46c92dc6aa6badca11d54885605d9f81da18b30384fb` ;
  application de la règle dans `resultats/analyse-verdict.json`.

### Résultats bruts, T1 `alertes-stock` (5 paires)

- Sans plan : 5 réussites réelles sur 5, toutes `verified`. Durées murales
  84, 61, 53, 64 et 64 s ; appels d'outils 7, 7, 6, 7 et 7 (34) ; appels au
  modèle 5, 6, 6, 6 et 6 (29) ; fichiers hors périmètre 0.
- Avec plan : 5 réussites réelles sur 5, toutes `verified`. Durées murales
  124, 149, 126, 136 et 141 s ; proposition : appels d'outils 5, 7, 4, 6
  et 6 (28), appels au modèle 4, 7, 4, 5 et 5 (25) ; travail : appels
  d'outils 10, 10, 10, 12 et 12 (54), appels au modèle 8, 10, 9, 7 et 10
  (44) ; fichiers hors périmètre 0. Plans de 3, 3, 2, 4 et 3 étapes,
  toujours `stock.py` et `rapport.py` ; précision et rappel 1 ; aucun
  écart journalisé.

### Résultats bruts, T2 `renommage` (5 paires)

- Sans plan : 5 réussites réelles sur 5, dont 4 `verified`. Durées
  murales 65, 68, 67, 70 et 65 s ; appels d'outils 13, 14, 14, 15 et 15
  (71) ; appels au modèle 5, 8, 8, 8 et 6 (35) ; fichiers hors
  périmètre 0. Paire 3 : renommage fait et tests verts, puis une commande
  de vérification suffixée de `2>/dev/null` suspendue par la politique
  d'accès (« reaches outside the workspace », décision humaine exigée en
  headless) : sortie 4, verdict `blocked`, trois critères non joués ;
  `controle.py` sort 0. Sortie de lui-même, ni délai ni arrêt forcé :
  réussite réelle (écart 8).
- Avec plan : 5 réussites réelles sur 5, toutes `verified`. Durées
  murales 145, 230, 202, 367 et 154 s ; proposition : appels d'outils 9,
  9, 7, 8 et 8 (41), appels au modèle 7, 5, 5, 7 et 5 (29) ; travail :
  appels d'outils 20, 18, 26, 23 et 19 (106), appels au modèle 12, 10,
  23, 20 et 11 (76) ; fichiers hors périmètre 0. Plans de 5, 5, 6, 6 et
  5 étapes, toujours les quatre modules ; précision et rappel 1 ; aucun
  écart journalisé.

### Résultats bruts, T3 `option-separateur` (5 paires)

- Sans plan : 5 réussites réelles sur 5, toutes `verified`. Durées
  murales 65, 51, 65, 51 et 71 s ; appels d'outils 14, 9, 10, 9 et 15 (57) ;
  appels au modèle 10, 6, 7, 5 et 10 (38) ; fichiers hors périmètre 0.
- Avec plan : 5 réussites réelles sur 5, toutes `verified`. Durées
  murales 145, 129, 159, 138 et 129 s ; proposition : appels d'outils 7,
  6, 7, 8 et 7 (35), appels au modèle 5, 4, 5, 6 et 5 (25) ; travail :
  appels d'outils 15, 14, 16, 12 et 15 (72), appels au modèle 13, 10, 12,
  8 et 13 (56) ; fichiers hors périmètre 0. Plans de 4, 4, 5, 3 et
  4 étapes, toujours `config.py`, `format.py` et `docs/usage.md` ;
  précision et rappel 1. Deux écarts journalisés, de nature `steps`, sans
  motif (paires 3 et 5) : dès le début du travail, Qwen réécrit les étapes
  approuvées en formulations plus courtes (`plan set`), sans changer les
  fichiers ; l'hôte les enregistre sans bloquer, comme #29 le prévoit.

### Totaux, par bras (15 essais chacun)

- Réussites réelles : 15 sans plan, 15 avec plan. Accord entre `verified`
  et réussite réelle : 14 sur 15 sans plan (le `blocked` de T2 paire 3),
  15 sur 15 avec plan.
- Fichiers hors du périmètre attendu : 0 dans les deux bras. Aucun
  fichier créé ni modifié hors de `perimetre/<tâche>.txt` dans les
  30 essais, tests et README jamais touchés.
- Appels au modèle : 102 sans plan ; avec plan 255, dont 79 en
  proposition et 176 au travail (rapport 2,5 ; 1,73 pour le seul
  travail).
- Appels d'outils : 162 sans plan ; avec plan 104 en proposition et 232
  au travail, dont 67 appels de l'outil `plan` (61 `done`, 4 `show`,
  2 `set`) : hors outil `plan`, 165 avec plan contre 152 sans.
- Durée murale totale : 964 s sans plan, 2 474 s avec plan (2,6 fois) ;
  `durationMs` cumulés : 945 s de travail sans plan ; 1 076 s de
  proposition et 1 376 s de travail avec plan.

### Faisabilité : Qwen propose-t-il un plan ?

Oui, dans les 15 runs de proposition sur 15, tous sortis par 3. Chaque
plan couvre les trois critères d'acceptation (aucun critère sans preuve
prévue) et nomme exactement les fichiers du périmètre attendu. Qwen lit
les fichiers (3 à 6 lectures), puis propose. Deux runs sur 15 ont eu
besoin d'une seconde proposition : la première écrivait des « \n »
littéraux dans le champ `files` (« "stock.py\\nrapport.py" »), refusée
par l'hôte comme chemin invalide ; Qwen a reproposé dans le même run (en
T1 paire 2, une proposition intermédiaire d'une étape et un fichier,
remplacée par une troisième de trois étapes et deux fichiers, celle qui a
été approuvée). Aucun run de proposition n'a fini sans plan
(`sans-plan.txt` jamais écrit).

### Le point de la revue : `propose` montré sans plan

Sous `--mission`, la description de l'outil `plan` montre l'action
`propose` même au run de travail d'un contrat approuvé sans plan. Dans
les 15 runs de travail du bras sans plan, Qwen n'a jamais appelé
`plan propose` (0 appel, donc aucun refus « already approved without a
plan ») : l'action montrée est restée inerte. Il a tenu la checklist
simple de l'outil dans 2 essais sur 15 (T3 paires 1 et 5 : un `set`,
puis 3 et 5 `done`), sans erreur ; dans les 13 autres, il n'a pas touché
à l'outil `plan`. Aucun `propose` non plus au travail du bras avec plan
(le plan y était déjà approuvé).

### Relecture à la main

Au moins un essai par tâche et par bras, trace, sortie, diff et verdict
indépendant : T1 paire 1 sans (7 outils, 5 appels au modèle, solution
minimale) et avec (proposition de trois étapes avec une preuve par
critère, travail qui coche chaque étape par `plan done`) ; T2 paire 3
sans (suspension par la politique après le travail fait) et paire 4 avec
(367 s : renommage fichier par fichier, une commande `git` en échec dans
le bac, code 128, six `plan done` successifs, un par étape) ; T3 paire 1 sans
(checklist simple, `set` puis trois `done`) et paires 3 et 5 avec (plan
réécrit au début du travail, écart `steps` sans motif). Chaque diff ne
touche que les fichiers du périmètre ; les solutions de T1 utilisent bien
l'inégalité stricte. Le premier essai réel confirme les hypothèses du
runner : ligne `[mission]` d'approbation en tête du travail, `[stats]`
présent, requêtes MTPLX attribuées par consigne et session. Il montre
aussi que Qwen regroupe plusieurs appels d'outils dans une même réponse
(7 outils pour 5 appels au modèle).

### Correction après la campagne, hors règle

La relecture du premier essai avec plan a révélé un défaut du lecteur de
trace de `mesure.py` : après `→ plan done` (ou `set`, `add`), smol affiche
la checklist au lieu d'une ligne « ✓ », et le champ `resultat` de
`appels_plan` prenait alors la ligne « ✓ » d'un appel suivant. Les
comptes par action étaient justes ; rien de ce que la règle lit n'en
dépend (réussite, périmètre, appels, plan proposé, validité). L'arbre
n'a pas été touché pendant la campagne (un arbre modifié aurait écarté
les manifestes suivants). Corrigé ensuite : le résultat se cherche
avant l'appel suivant. La correction est prouvée sur une vraie trace de
la campagne (T1 paire 1 avec : ancien lecteur « ✓ ---- » pour chaque
`done`, nouveau lecteur aucun résultat) et par un cas ajouté à
`test-mesure.sh` (`plan done` au travail), rouge avec l'ancien
`mesure.py` (1 échec, le nouveau cas), vert avec le nouveau (PASS,
29 contrôles). Les manifestes restent tels qu'écrits pendant la
campagne ; les chiffres de ce rapport sur l'outil `plan` sont relus dans
les traces brutes avec le lecteur corrigé.

## Application de la règle (`analyse.py --etape verdict`)

1. Validité : 5 paires valides sur 5 pour chaque tâche (minimum 4).
   Aucun essai invalide, aucun rejeu, aucune paire écartée. Campagne
   concluante.
2. Faisabilité : plan proposé dans 15 runs de proposition sur 15 (seuil
   12). Tenue.
3. Blocages : T1 5 réussites avec plan contre 5 sans, T2 5 contre 5, T3
   5 contre 5 ; aucune tâche à deux réussites d'écart. Total 15 contre 15 :
   pas moins de réussites avec plan. Aucun blocage.
4. Effet favorable : réussites avec plan moins réussites sans plan = 0
   (il en faut au moins +2), non tenu ; fichiers hors périmètre 0 avec
   plan contre 0 sans (l'effet exige au moins 3 sans plan), non tenu.
   Aucun effet démontré.
5. Coût : 255 appels au modèle avec plan (proposition et travail) contre
   102 sans, rapport 2,5, au-delà du seuil de 1,5. Sans objet pour
   l'issue, faute d'effet ; publié.
6. Bruit et extension : écart 0 sur les trois tâches ; aucune extension
   permise ni jouée.
7. Issue : ni effet ni blocage.

## Verdict

Ni effet ni blocage : garder la décision de #29, plan facultatif par
défaut, exigible au cas par cas par `"plan": "required"`. La mesure ne
recommande ni de rendre le plan exigible par défaut sous `--mission`, ni
de déconseiller `"plan": "required"` avec ce modèle : Qwen sait produire
un plan (15 sur 15) et le plan approuvé n'a coûté aucune réussite. La
décision, et tout changement qu'elle appellerait, reviennent à Alex.

Lecture descriptive, hors règle, qui ne change pas le verdict : les trois
tâches ont été réussies dans les 30 essais et aucun essai n'a dérivé hors
du périmètre, dans aucun bras. La mesure ne pouvait donc montrer aucun
effet sur ces deux critères : plafond de réussite et dérive nulle. Le
plan approuvé a en revanche un coût net : 2,5 fois les appels au modèle
et 2,6 fois la durée murale. Sur les 153 appels au modèle en plus, 79
viennent du run de proposition ; les 74 autres, du travail, où 67 des
232 appels d'outils sont des appels de l'outil `plan` (un `plan done` par
étape), alors que les autres appels d'outils sont presque aussi nombreux
que sans plan (165 contre 152). Que la tenue de la checklist explique
l'essentiel de ce surcoût est une hypothèse, non vérifiée. Même avec un
effet démontré, le point 5 aurait écarté l'exigibilité par défaut.

## Limites et non vérifié

- Effet de plafond : 30 réussites sur 30 et aucune dérive de périmètre.
  Ces tâches courtes ne discriminent pas ; le protocole le prévoyait
  (« un plan peut peser davantage sur une tâche longue »). Le résultat
  nul ne prouve pas l'inutilité du plan au-delà de ces tâches, ni ne
  justifie de l'exiger.
- Petits effectifs : 5 paires par tâche, température effective 1,0 du
  serveur ; une machine, un modèle, une fenêtre de contexte.
- Approbation mécanique : l'effet d'une relecture humaine qui refuserait
  ou amenderait un plan n'est pas mesuré.
- Contrats sans champ `plan` (protocole) : le chemin `"plan": "required"`
  n'a pas été exercé avec Qwen.
- Attribution des requêtes MTPLX : dans 7 essais sur 30, `recent` a
  inscrit une ou deux requêtes de moins que `modelCalls` (T1 paires 3 et
  5 avec, T2 paires 1, 3 et 4 avec, T2 paire 3 sans, T3 paire 3 sans),
  comme dans #19 ; la détection d'un autre client reste une borne
  inférieure, doublée par `active_requests` (jamais au-dessus de 1).
- Durées : d'autres agents préparaient des mesures dans d'autres
  worktrees pendant la campagne, sans requête à MTPLX (aucune requête
  étrangère relevée) ; la charge CPU de leurs builds a pu allonger
  certaines durées, qui ne décident pas.
- Les commandes de Qwen et `controle.py` tournent avec le Python 3.9 du
  système ; aucune différence de sens pour ces fixtures (hypothèse, non
  testée séparément).
- Le verdict `blocked` de T2 paire 3 sans plan vient d'une redirection
  vers `/dev/null` suspendue en headless, déjà relevée dans #19 ; compté
  en réussite réelle par l'écart 8, il ne pèse que sur l'accord entre
  verdict et réussite.
- Non vérifié : l'effet du plan sur des tâches longues ou ambiguës, sur
  un autre modèle, avec une relecture humaine, et avec un plan exigé ;
  l'origine exacte du surcoût du travail entre `plan done` et relances du
  harnais (une seule relance « plan has unfinished steps » relevée, T2
  paire 3 avec).
