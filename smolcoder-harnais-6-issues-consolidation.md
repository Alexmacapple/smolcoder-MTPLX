# Consolidation des revues — six issues harnais

Croisement des deux validations indépendantes, réalisé le 2026-09-26 sur le
HEAD `da42044` :

- revue Codex (gpt-5.6, sandbox lecture seule) : verdicts postés en
  commentaire sur les tickets #8 à #13 ;
- revue Qwen 3.8 via MTPLX (session smol en lecture) :
  `smolcoder-harnais-6-issues-revue.md` ;
- document source : `smolcoder-harnais-6-issues.md` (H01 = #8, H02 = #11,
  H03 = #12, H04 = #9, H05 = #10, H06 = #13).

Chaque divergence a été tranchée sur pièce, jamais au vote. Les erreurs
factuelles relevées dans les revues sont nommées en fin de document.

## Verdicts consolidés

- H01 (#8) : à amender — les deux revues convergent.
- H02 (#11) : à amender — les deux revues convergent.
- H03 (#12) : à découper — verdict Codex retenu, conditions Qwen intégrées
  aux sous-tickets.
- H04 (#9) : à amender légèrement — les constats des deux revues convergent,
  seuls les verdicts différaient.
- H05 (#10) : à amender — les deux revues convergent.
- H06 (#13) : à amender — verdict Codex retenu sur preuve (voir « faits
  tranchés »), apports Qwen conservés.

Décision transversale préalable : une décision d'architecture du **stockage
hôte** (hors de portée des outils du modèle) doit précéder H01 — H01
(approbation), H02 (politique) et H05 (verrou, journal) inventent chacun un
état hôte sans en nommer le lieu ; décidés séparément, ils ne composeront
pas. Ouvrir un ticket dédié court.

## Amendements par issue

### H01 (#8) — contrat de mission

1. Nommer le profil renforcé et son opt-in (flag CLI ou configuration) : le
   dernier critère d'acceptation n'est testable qu'après cette décision.
2. Définir le schéma versionné du contrat, son autorité d'approbation
   (interface humaine ou appelant headless, avec support concret) et son
   invalidation par empreinte.
3. Ancrer le stockage du contrat sur la décision « stockage hôte » ; un
   fichier du workspace ne peut jamais être source de contrat.
4. Préciser que « budgets » n'introduit aucun plafond global de contexte
   (décision #4 acquise) ; le budget de pas (`maxSteps`) devra exister comme
   état persistant, il est aujourd'hui un simple argument de constructeur.

### H02 (#11) — politique d'accès

1. Définir l'interface de décision `allow / ask / deny` et son point de
   passage unique : la passerelle actuelle (`gateAndExecute`) ne couvre que
   `run_command` et `task.start` ; les vérifications automatiques
   (`checkProgress`, `verify`) et le terminal web appellent l'exécution sans
   passer par elle. Le critère « même décision partout » doit énumérer ces
   quatre surfaces.
2. Préciser le modèle de secrets : aujourd'hui `env: process.env` est
   transmis aux sous-processus (shell, tâches, terminal web) et leurs
   sorties sont relayées sans filtrage. Définir « traces accessibles au
   modèle » (stdout, transcript, `~/.smolcoder/sessions/*`).
3. Réécrire le passage sur les hooks : aucun hook configurable n'existe dans
   le code (`src/events.ts`, bus interne non configurable en v1) — nommer le
   futur point de branchement ou retirer le passage.
4. Trancher le statut du mode `bypass` dans le profil renforcé (autorisé
   avec décision humaine visible, ou exclu) et le lieu de stockage de la
   politique (dépend de la décision « stockage hôte »).
5. Ne pas remplacer la précédence de prompt (#6) par des refus codés en
   dur : les deux couches restent distinctes.

### H03 (#12) — isolation : découpage

Le ticket devient un chapeau ; l'objectif est inchangé, le périmètre est
découpé en quatre sous-tickets séquentiels :

1. Contrat d'exécuteur : une interface unique d'exécution partagée par
   `run_command`, tâches, terminal web et vérifications automatiques, sans
   changement de comportement (préparé par H02).
2. Backend macOS isolé : évaluer un mécanisme natif éprouvé (Seatbelt /
   `sandbox-exec` est la piste sans dépendance) contre le modèle de menace ;
   courte décision d'architecture avant le code.
3. Politique d'empreinte des outils de développement : l'allow-list
   documentée (binaire node, cache npm, registre, répertoires temporaires
   bornés) sans laquelle les critères positifs (`npm test` de fixture,
   serveur de développement) contredisent les négatifs (HOME protégé,
   réseau fermé).
4. Intégration et campagne OS réelle sur macOS : brancher tâches, terminal
   web et vérifications sur l'exécuteur isolé ; décider du lieu des tests OS
   (hors `npm test`, qui doit rester exécutable partout).

### H04 (#9) — verdicts structurés

1. Scinder explicitement : le socle (résultat d'exécution typé, invalidation
   des preuves par empreinte) démarre après H01 ; la garantie
   anti-altération est conditionnelle à H02/H03 et doit être marquée comme
   telle dans les critères pour ne pas être crue acquise.
2. Extraire le résultat typé en premier : le verdict d'acceptation actuel
   est une expression régulière sur une chaîne mêlant logs et statut
   (`src/agent.ts:200`, `src/tools/shell.ts:155`) — la brèche la moins
   chère à fermer du lot.
3. Définir : `not_run` vs `error`, « zéro test », l'identité des
   vérificateurs (empreinte des scripts découverts), et l'emplacement de
   `report.json` — hors du workspace (stockage hôte), sinon la preuve est
   modifiable par l'agent qu'elle juge.

### H05 (#10) — reprise durable

1. Ajouter H03 aux dépendances du tableau (le corps du ticket le requiert
   déjà).
2. Partir de l'existant réel : `SessionSnapshot` persiste déjà plan,
   fichiers touchés, commandes, mode, effort et modèle — l'incrément est le
   journal d'effets (action enregistrée avant effet, résultat observé
   après), pas la persistance générale. Noter que les approbations
   (`alwaysAllowed`) ne sont pas restaurées aujourd'hui.
3. Nommer le support du verrou mono-écrivain et du journal (décision
   « stockage hôte ») et ajouter l'identité d'`AGENTS.md` (empreinte) au
   snapshot — sans ce champ, « signaler les écarts » est invérifiable.
4. Limiter la réconciliation aux fichiers et au diff Git : les tâches de
   fond sont en mémoire et tuées à la sortie (`src/tools/tasks.ts:5`), leur
   état n'est pas récupérable.
5. Remplacer « sans double application » par « aucune reprise automatique
   après un état incertain » ; recadrer « les budgets ne repartent pas de
   zéro » comme dépendant du budget persistant défini en H01.

### H06 (#13) — banc de régression

1. Baseline durable : un dossier par run (horodaté), plus d'écrasement.
   Fait tranché : `resultats/` est ignoré par git (`bench/.gitignore`) —
   décider ce qui est versionné (manifestes et constats, pas les sorties
   volumineuses) ou archivé ailleurs.
2. Manifeste par run : SHA du harnais, identifiant exact du modèle renvoyé
   par le serveur, version MTPLX quand disponible, paramètres réellement
   observés (pas seulement demandés).
3. Statuts machine-lisibles distincts : échec de test, refus de sécurité
   attendu, indisponibilité MTPLX, blocage effectif du harnais vs refus du
   modèle — aujourd'hui tout se lit dans des fichiers texte et des codes de
   sortie mélangés.
4. Exclusivité de campagne : le sondage `active_requests == 0` au départ ne
   verrouille rien pendant les runs — définir un verrou de campagne ou une
   vérification continue, et nommer la commande et le propriétaire du
   déclenchement.
5. Donner le `n` des répétitions appariées et la règle de comparaison
   (le signal est bruité : un essai par case ne décide pas d'une
   régression).

## Ordre final

H06 minimal (baseline) → décision « stockage hôte » → H01 → H02 (le profil
renforcé refuse le shell tant que H03-2 n'existe pas) → H03 en quatre
sous-tickets → H04 → H07 (#19) → H05.

Complément du 2026-09-26 au soir : H07 (#19, P2) ajouté après le socle de
H04 — retours d'outils exploitables et péremption de lecture, recentrage
d'une proposition plus large dont le curateur de contexte est repoussé
(à instruire seulement si le banc montre que Qwen se noie) et dont les
recouvrements avec #8, #9, #10 et #13 ont été renvoyés à ces tickets.

## Faits tranchés et erreurs relevées dans les revues

- `resultats/` : la revue Qwen affirme qu'il est commité (« baseline
  conservée a une case ») ; vérification `git check-ignore` + `git
  ls-files` : le dossier est ignoré, zéro fichier suivi. La revue Codex a
  raison, l'amendement H06-1 en découle.
- Les deux revues citent les mêmes trous de H02 avec les mêmes fichiers
  (passerelle partielle, environnement transmis) : constat considéré comme
  établi.
- La revue Qwen apporte deux faits que Codex n'avait pas : le verdict
  d'acceptation par expression régulière (`src/agent.ts:200`) et le contenu
  réel de `SessionSnapshot` (`src/session.ts:282-295`) — intégrés à H04 et
  H05.

## Exécution (validée par Alex le 2026-09-26)

Amendements reportés en tête du corps des six tickets ; #12 transformé en
chapeau avec ses quatre sous-tickets #15 (contrat d'exécuteur), #16
(backend macOS isolé), #17 (allow-list outils de développement), #18
(intégration et campagne OS) ; ticket préalable #14 « décision
d'architecture du stockage hôte » ouvert. Ordre de réalisation : #13
minimal → #14 → #8 → #11 → #15..#18 → #9 → #10.
