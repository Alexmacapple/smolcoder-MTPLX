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
