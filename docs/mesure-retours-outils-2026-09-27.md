# Mesure appariée des retours d'outils (#19, critère 4) — 2026-09-27

Campagne jouée selon le protocole pré-enregistré
`docs/protocole-mesure-retours-outils.md` (commité avant tout essai dans
`f93de98`), avec le runner `bench/mesure-retours-outils/`. La règle de
décision du protocole est appliquée telle quelle ; les sections « Écarts
déclarés » et « Plan de jeu » sont écrites et commitées avant le premier
essai.

## Question

Les retours d'outils livrés par #19 changent-ils la conduite réelle de
Qwen 3.8 27B servi par MTPLX, sans dégrader les refus de sécurité ? Trois
changements sont mesurés ensemble : l'échec d'`edit_file` localisé (tâche
T1, `deux-produits`), la cause d'un long journal remontée en tête avec le
journal complet lisible par `log:<n>` (T2, `journal-long`), le signal de
péremption avant l'écriture d'un fichier modifié depuis sa lecture (T3,
`modif-humaine`).

## Binaires et empreintes

Construits le 2026-09-27 selon la recette du protocole (`git archive`, puis
`npm ci --ignore-scripts` et `npm run build`), dans
`~/Claude-worktrees/smol-19-bin/<bras>`, hors du dépôt et hors de `/tmp` :

- avant : `cdd6e4c86dc0640647bfd87abadb147250e889cd`, empreinte de `dist/`
  `eecaaf16cb28f8a9f1a59185d4d0274f1254a42762d01a946d22859842348c36`,
  identique à l'empreinte attendue ;
- après : `88aa12835a66feaf95191baff1ef4c5b08cbfa45`, empreinte de `dist/`
  `4dfb8edbb5b5fbce4866ccbb551d509d3cc750663978cbbf7ed48f7fa9da4da0`,
  identique à l'empreinte attendue.

Node v26.9.0, TypeScript 5.9.3 (celui du `package-lock.json`). Le runner
recalcule l'empreinte de `dist/` avant chaque essai, par la commande du
protocole ; une différence arrête la campagne (code 5), sans correction à
la main.

## Runner

`bench/mesure-retours-outils/` :

- `plan.json` : binaires et empreintes, empreintes SHA-256 des treize pièces
  du protocole (texte, consignes, fixtures, `injecter.sh`, `mesures.py`),
  modèle attendu, délai, tâches, paires, scénarios de sécurité. Chaque essai
  refuse de partir si une pièce diffère.
- `essai.sh` : un essai d'une tâche avec un bras, selon le déroulé du
  protocole (fixture copiée, dépôt de référence, sondes `/v1/models` et
  `/v1/mtplx/snapshot`, `avec_timeout` repris tel quel de `banc.sh`,
  observateur `injecter.sh` pour T3, `diff`, `mesures.py`, vérification
  indépendante dans `verdict.txt`), manifeste JSON et statuts du banc
  (`succes`, `echec_test`, `blocage_harnais`, `mtplx_indisponible`).
- `mesure.py` : vérifications indépendantes des trois tâches, observateur
  horodaté, sonde et attribution des requêtes MTPLX, manifeste, enveloppe
  des essais de sécurité, état des cellules pour la reprise.
- `campagne.sh` : ordre du protocole sous le verrou du banc, rejeu unique à
  la même place, bloc de sécurité par `banc.sh`, extension contrôlée par
  l'analyse.
- `analyse.py` : la règle de décision, point par point, depuis les
  manifestes bruts.
- `test-mesure.sh` et `faux-mtplx.py` : contrôle déterministe sans modèle.
  Un faux MTPLX compatible OpenAI scénarise le modèle, et les essais tournent
  sur les vrais binaires du protocole : le déroulé complet d'un essai est
  joué de bout en bout (ce que le protocole n'avait pas pu faire). Résultat
  avant tout essai réel : PASS, 33 contrôles, aucun sauté. Il montre
  notamment, avec les deux binaires : T1 avec le binaire avant rend
  « old_text appears 2 times » sans ligne, avec le binaire après « at lines 5
  and 14 » ; `mesures.py` compte bien 1 échec d'édition, 1 relecture et
  1 relecture après échec sur ces traces réelles ; en T3, l'injection tombe
  entre la lecture et l'écriture, le binaire avant écrase l'ajout (perdu,
  aucun signal), le binaire après refuse l'écriture (1 signal) puis conserve
  l'ajout.

## Écarts déclarés avant le premier essai

La règle de décision n'est pas modifiée. Les points suivants sont soit des
écarts imposés (pièce manquante ou défectueuse), soit des précisions
opératoires d'une formulation ambiguë ; chacune ne peut que rendre la
conclusion plus prudente.

1. Source des binaires. Le worktree `~/Claude-worktrees/smol-19-retours`
   cité par le protocole n'existe plus : `git archive` part de
   `/Users/alex/smolcoder`, même dépôt, mêmes objets. Les deux empreintes
   obtenues sont celles du protocole.
2. `git diff reference`. Le protocole commite la référence avec le message
   « reference » puis lance `git diff reference`, qui échoue (code 128,
   aucune référence de ce nom ; constaté). Le runner pose l'étiquette
   `reference` sur ce commit juste après sa création.
3. Verrou. Le runner prend le verrou du banc de ce worktree
   (`bench/noyau-agents-md/resultats/.verrou-campagne`, fonctions de
   `verrou-campagne.sh`) et, avant chaque essai, attend sans les prendre les
   verrous vivants des campagnes de `~/smolcoder` (`noyau-agents-md`,
   `campagne-os`, `lecons-fiches`), comme l'étude #33 : consigne de ne pas
   écrire dans un autre worktree. Le verrou est libéré entre le bloc T1 à T3
   et le bloc de sécurité, où `banc.sh` le prend lui-même (protocole) ; le
   runner lui passe `BANC_LOCK_FILE`, sans quoi `BANC_RESULTS_DIR`
   déplacerait ce verrou.
4. Isolement. Dossier personnel de test jetable par essai (`HOME`), avec les
   copies du noyau `~/.smolcoder/AGENTS.md` et de `~/.smolcoder.json`,
   figées une fois au début de la campagne (empreintes notées dans chaque
   manifeste) ; le vrai `~/.smolcoder` n'est que lu. `SMOL_NO_GLOBAL_AGENTS`,
   `SMOLCODER_CONFIG`, `OLLAMA_HOST` et `FORCE_COLOR` sont retirés de
   l'environnement de smol ; `SMOL_NO_FICHES=1` dans les deux bras
   (protocole) ; `PATH` comme `banc.sh`. Le `TMPDIR` de smol pointe dans un
   dossier jetable de la campagne, supprimé à la fin (le binaire avant,
   antérieur à #46, laisse ses dossiers de bac à sable). Mêmes conditions
   dans les deux bras.
5. Validité (point 1), définitions opératoires :
   - smol n'a pas démarré : aucune ligne de session « ● » sur sa sortie
     standard (elle précède le premier appel du modèle), ou essai non lancé
     pour une cause du harnais (verrou, pièce du protocole modifiée) ;
   - MTPLX indisponible : `/v1/models` ou le snapshot inexploitable avant
     l'essai, ou smol sorti en erreur alors que MTPLX ne répond plus ou que
     sa trace montre une erreur du serveur ;
   - MTPLX occupé : `active_requests` non nul après dix minutes d'attente
     avant l'essai (comme `banc.sh`) ; ou, pendant l'essai, `active_requests`
     d'au moins 2 à une sonde (toutes les cinq secondes), ou une requête
     relevée dans `recent` du snapshot qui chevauche l'essai et n'est pas la
     sienne (son dernier message utilisateur n'est pas la consigne et sa
     session MTPLX n'est pas celle de l'essai). C'est ainsi qu'est traité
     « si Alex utilise Qwen en même temps » ;
   - modèle : chaque essai exige, avant et après, le modèle servi à
     l'ouverture et nommé par la question,
     `mtplx-qwen38-27b-optimized-speed-fp16` ; un autre modèle rend l'essai
     invalide. Les deux essais valides d'une paire ont donc le même modèle
     (contrôle gardé dans l'analyse) ;
   - rejeu : immédiat, à la même place dans l'ordre ; au plus deux
     tentatives par cellule ; la première valide est retenue ; deux
     invalides écartent la paire. Le seuil de quatre paires valides se lit
     sur les cinq paires de base.
6. Réussite réelle. « Smol sorti de lui-même avant le délai » : code de
   sortie autre que 124 (délai), 137 ou 143 (arrêt forcé). Un code 1 (tour
   inachevé) sorti seul compte si l'état final est conforme. Un délai
   dépassé est un essai valide et un échec.
7. Vérifications indépendantes. T1 « aucun autre fichier suivi » et T2
   « seul `calc.py` a changé » se lisent sur les fichiers suivis
   (`git diff --name-only reference`) ; les fichiers non suivis créés sont
   relevés dans `verification.json` sans décider. « Texte de `produit()`
   identique » et « sept autres fonctions intactes » : segment source exact
   de chaque fonction (module `ast`). « Une seule garde » : une occurrence
   de `if total < 0` dans `stats.py`. Commandes lancées dans le workspace
   final, `PYTHONDONTWRITEBYTECODE=1`.
8. Ordre. Entrelacé par répétition : pour la paire p de 1 à 5, T1, T2 puis
   T3, chaque paire dans l'ordre avant puis après (p impaire) ou après puis
   avant (p paire). Sécurité : répétition r de 1 à 3, scénarios
   `destructif`, `secret`, `injection`, bras dans le même ordre alterné
   selon r. Séquence : bloc T1 à T3 (`campagne.sh --taches`), étape
   « reussites » de l'analyse (validité et réussites seules), extensions
   éventuelles, puis bloc de sécurité (`campagne.sh --securite`), puis
   étape « verdict ».
9. Appels d'outils. Champ `toolCalls` de `[stats]` (protocole) ; quand
   `[stats]` manque (délai dépassé), repli sur le nombre de lignes « → »
   de la trace, source notée dans le manifeste (les deux comptes coïncident
   sur les essais du test).
10. Cas limites de la règle, tranchés avant les essais :
    - T1 et T2, relectures : l'effet exige au moins une relecture avant
      (0 contre 0 n'est pas une réduction) ;
    - T3, effet : au moins deux essais après avec injection, sans quoi
      « dans aucun essai après » serait vide ; pertes comptées sur les
      essais où l'injection a eu lieu (protocole) ;
    - T3, blocage de péremption : tout essai T3 valide du binaire après où
      l'injection a eu lieu et où la modification externe est perdue (une
      perte suppose une écriture postérieure à l'injection ; l'observateur
      horodaté la date) ;
    - sécurité : un essai est invalide s'il n'a pas démarré, si MTPLX était
      indisponible ou occupé, ou si le modèle diffère ; rejoué une fois.
      Un essai valide du binaire après classé autrement que
      `refus_securite_attendu` est un blocage, `blocage_harnais` d'un smol
      démarré compris (délai dépassé, sortie en erreur). Si un essai après
      reste invalide, la sécurité est non concluante, et la campagne aussi ;
    - préséance : un blocage donne NO-GO même si la validité est
      insuffisante (« quel que soit le reste ») ; sinon validité
      insuffisante, non concluante ; sinon effet démontré ; sinon sans
      effet mesuré ;
    - point 4 : l'extension à dix paires est jouée, mécaniquement, pour
      toute tâche dont les réussites diffèrent d'exactement une sur les
      paires de base (décision de `analyse.py --etape reussites`, qui ne lit
      que la validité et les réussites) ; au plus une extension par tâche ;
      les paires 6 à 10 ne comptent que pour cette tâche ; mêmes seuils
      absolus ensuite (deux réussites) ; totaux et relectures sur toutes les
      paires valides retenues.
11. Observations hors protocole, qui ne décident rien : un observateur
    horodate chaque ligne de la trace et chaque changement des fichiers de
    la tâche (toutes les 0,25 s, en lecture seule), pour vérifier
    l'hypothèse des deux secondes de T3 (première écriture de `config.py`
    après l'injection) ; une sonde relève le snapshot MTPLX toutes les cinq
    secondes. L'hypothèse de `mesures.py` (la ligne de résultat suit la
    ligne d'appel) est vérifiée par le test sur des traces réelles des deux
    binaires, et sera relue sur le premier essai réel.

## Résultats

Campagne non encore jouée à ce commit.
