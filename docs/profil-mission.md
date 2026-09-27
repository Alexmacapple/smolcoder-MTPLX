# Profil mission — contrat de mission et validation avant écriture

Ticket #8 (H01). Implémente la page `docs/decision-stockage-hote.md` pour
le contrat : `~/.smolcoder/harness/<empreinte-du-workspace>/contract.json`
et `proofs.jsonl`, module propriétaire unique `src/harness/store.ts`.

## Nom retenu et opt-in

- `--mission <contrat.json>` ouvre le profil renforcé ; sans cette option,
  le parcours conversationnel courant est strictement inchangé (mêmes
  outils, même menu de commandes, même état web, aucune écriture dans le
  stockage hôte).
- `--approve <empreinte>` est l'approbation explicite de l'appelant
  headless (avec `-p` uniquement).
- `/approve` et `/mission` n'apparaissent en terminal et en web que sous
  le profil.
- `--propose-plan` (run headless de proposition du plan) et `--approve-plan
  <empreinte>` (approbation du plan avec le contrat) n'existent que sous le
  profil (ticket #29, section « Plan d'implémentation » ci-dessous).

Pourquoi `--mission` : il nomme le concept du ticket (contrat de mission),
se lit de la même façon en français et en anglais, reste cohérent avec les
options anglaises de la CLI (`--verify`, `--mode`, `--effort`) et ne se
confond ni avec `--mode` (permissions de session) ni avec l'outil `plan`
(la checklist modifiable par le modèle). Écartés : `--contrat` et
`--approuver`, seules options françaises d'une CLI anglaise ; `--profile
strict`, qui ouvrirait un système de profils générique non demandé.

## Le contrat

Un fichier JSON écrit par l'appelant, jamais par le modèle, et **hors du
workspace** : un fichier du workspace (ou un lien posé dans le workspace)
est refusé comme source de contrat. Taille maximale 16 Kio. Schéma fermé :
un champ inconnu est refusé.

```json
{
  "schema": "smolcoder/contract/v1",
  "id": "login-redirect",
  "title": "Corriger la redirection après connexion",
  "problem": "Après connexion, l'utilisateur revient sur l'accueil.",
  "outcome": "La page demandée s'affiche après connexion.",
  "users": "Utilisateurs connectés",
  "constraints": ["pas de nouvelle dépendance"],
  "outOfScope": ["refonte du formulaire"],
  "acceptance": ["npm test passe", "un test couvre la redirection"],
  "checks": [{ "command": "npm test", "covers": [1] }],
  "openQuestions": [],
  "baseRevision": null,
  "policyRef": null,
  "budgets": { "maxSteps": 60 }
}
```

Obligatoires : `schema`, `id`, `title`, `problem`, `outcome`, `acceptance`
(au moins un critère), `budgets.maxSteps`. Les sept rubriques du format
d'intention s'y retrouvent (problème, résultat attendu, utilisateurs,
contraintes, hors périmètre, critère observable, questions ouvertes).
`workspace` est rempli par l'hôte (chemin réel) ; s'il est fourni, il doit
désigner le même dossier. `policyRef` est réservé à #11.

`plan` (facultatif, #29) : `"required"` exige un plan d'implémentation
approuvé avec le contrat ; absent, le plan est facultatif (section « Plan
d'implémentation »).

`checks` (facultatif, #9) : les contrôles de l'hôte, chacun une commande
lancée par le harnais dans le bac et les critères qu'elle couvre (numéros de
`acceptance`, à partir de 1 ; un critère est couvert une fois au plus),
avec un délai facultatif `timeoutSeconds` (120 s par défaut). Un critère
qu'aucun contrôle ne couvre reste `not_run (not-covered)` : un run headless
ne sort 0 que si chaque critère est couvert par un contrôle qui passe. Dans
l'exemple, le second critère n'est pas couvert ; le rapport le dit. La
commande n'est pas montrée au modèle, seulement les critères couverts.

L'empreinte du contrat est le SHA-256 de sa forme canonique (clés triées),
workspace compris. Toute modification du contrat change l'empreinte : la
version précédente expire (événement `contract` au journal), la nouvelle
n'est qu'une proposition.

## Parcours préparer → approuver → exécuter

- Headless, préparer : `smol -p "…" --mission contrat.json`. Rien ne tourne,
  aucune question n'est posée : la vue Markdown du contrat s'affiche, une
  ligne `[mission] {…}` donne l'état et l'empreinte sur stderr, sortie 3.
- Headless, approuver et exécuter : `smol -p "…" --mission contrat.json
  --approve <empreinte>`. Une empreinte différente est refusée (sortie 3,
  rien d'enregistré). L'approbation vaut pour cette version exacte du
  contrat : un run suivant sans `--approve` s'exécute tant qu'elle tient.
  Elle fige aussi les entrées du vérificateur (#9) : tests, configuration et
  scripts qui les exécutent, y compris ceux de la commande `--verify` donnée
  avec elle.
- Headless, approuver à nouveau les entrées du vérificateur après une
  modification légitime : `--approve-verifiers <empreinte>`, l'empreinte
  exacte de l'état actuel (champ `verifiers.current` de la ligne `[mission]`,
  qui liste aussi les fichiers changés). Une autre empreinte est refusée
  (sortie 3) ; repasser `--approve` seul ne refige rien.
- Terminal et web : la session affiche le contrat ; l'agent lit et planifie,
  toute écriture et toute commande sont refusées à l'exécution. `/approve`
  montre le contrat puis demande une confirmation humaine liée à
  l'empreinte ; sous un contrat déjà approuvé dont les entrées du
  vérificateur ont changé, il liste les fichiers changés et demande de les
  approuver telles qu'elles sont. `/mission` réaffiche le contrat et son état. En web, le
  contrat ne s'applique qu'aux sessions du workspace visé (`smol --web
  <workspace> --mission contrat.json`) ; un hub déjà lancé ne peut pas le
  recevoir et l'option est refusée.

Avant approbation, seuls `read_file`, `list_files`, `search`, `plan` et
`task` en lecture (`list`, `logs`, `stop`) passent, et la politique d'accès
(ci-dessous) s'applique déjà à ces lectures. Le refus est décidé en
relisant le stockage hôte à chaque appel : un message du modèle, une étape
de plan, un fichier du workspace ou un label de ticket n'y changent rien.

## Politique d'accès (ticket #11)

Sous le profil, chaque action passe, au dernier point avant son effet, par
une seule décision `allow / ask / deny` (`decide`, `src/harness/policy.ts`)
qui porte son motif, l'action, les chemins canoniques (liens résolus) et la
version de la politique. Le contrat décide d'abord (porte ci-dessus), la
politique ensuite. Quatre surfaces, la même décision :

- `run_command` et `task` `start`, comme tout outil du modèle ;
- les vérifications lancées par le harnais (`--verify`, contrôles du projet) ;
- le terminal web : chaque ligne est jugée avant d'atteindre le shell, et
  aucun terminal ne s'ouvre tant que la session du workspace visé n'a pas
  chargé son contrat.

### Lieu et version

`~/.smolcoder/harness/<empreinte-du-workspace>/policy.json`, à côté du
contrat ; sa grammaire vit dans `src/harness/store.ts`, le module
propriétaire du stockage hôte. À la préparation (`--mission`), l'hôte y pose
la politique par défaut si le fichier manque ; celle que l'appelant a écrite
est gardée telle quelle ; une politique illisible n'est jamais écrasée. Elle
est relue à chaque décision. Sa version, `smolcoder/policy/v1@<empreinte>`,
est l'empreinte de son contenu, jamais un champ modifiable : elle figure dans
chaque décision et dans la ligne `[mission]`.

Aucun fichier du workspace n'est lu comme politique. Le stockage hôte est
hors d'atteinte des outils de fichiers (confinement au workspace, liens
compris), et une commande qui le nomme (`.smolcoder`, chemin du dossier de
données) est refusée.

`read_file` connaît deux exceptions nommées, que la décision reconnaît
avant tout chemin du workspace : `fiche:<nom>`, une fiche installée côté
hôte (#30, `docs/decision-fiches-hote.md`), et `log:<n>`, la sortie
complète d'une commande raccourcie, gardée en mémoire par la session (#19).
Un journal gardé est lu sans chemin dans la décision, puisqu'il n'est
jamais un fichier ; un journal inconnu et toute écriture sur `log:<n>` sont
refusés par la décision elle-même.

### Schéma

Fermé, tous les champs obligatoires sauf `network`, `tools`, `git` et
`listen` : une politique partielle est illisible, jamais complétée en
silence. La politique par défaut :

```json
{
  "schema": "smolcoder/policy/v1",
  "paths": { "protect": [".env", ".env.*", ".git"], "except": [".env.example"] },
  "commands": "workspace",
  "tasks": "ask",
  "env": []
}
```

- `paths` : noms de fichier ou de dossier (joker `*`, jamais de `/`),
  comparés sans tenir compte de la casse ; un nom protégé l'est à toute
  profondeur, contenu compris. Un chemin protégé n'est ni lu, ni écrit, ni
  parcouru par `search`, ni nommé par une commande ; `except` lève la
  protection d'un nom précis.
- `commands` (`run_command`, vérifications, terminal web) et `tasks`
  (`task` `start`) : `workspace` reprend la règle du sandbox courant (une
  commande qui reste dans le workspace passe, une commande qui en sort exige
  une décision humaine) ; `ask` exige toujours une décision humaine ; `deny`
  refuse. Aucune valeur n'est plus large que le sandbox courant.
- `env` : variables transmises nommément aux sous-processus, en plus de
  `PATH`, `HOME`, `TERM` et `LANG`.
- `network` (facultatif, #16) : destinations que les commandes isolées
  peuvent joindre, de la forme `localhost:<port>` (par exemple
  `["localhost:5173"]`) ; absent, aucune — son absence ne change pas la
  version d'une politique écrite avant lui. Seatbelt ne sait pas filtrer un
  hôte distant : toute autre forme rend la politique illisible.
- `tools` (facultatif, #17) : dossiers absolus hors du workspace, écrits sous
  leur forme normale, que les commandes isolées lisent et exécutent sans
  jamais les écrire — node installé sous le dossier personnel (nvm), cache
  npm d'une installation hors ligne (`~/.npm/_cacache`), `.git` du dépôt
  principal quand le workspace est un worktree. Un dossier qui contient le
  dossier personnel est refusé au lancement.
- `git` (facultatif, #17) : `"read"` rend le contenu de `.git` lisible par
  les commandes isolées, jamais modifiable (ni commit, ni index, ni hook) ;
  git y tourne sans lire la configuration du compte. Lire `.git`, c'est lire
  `.git/config` : retirer d'abord tout jeton d'une URL de remote.
- `listen` (facultatif, #17) : ports `localhost:<port>` sur lesquels les
  commandes isolées peuvent écouter (serveur de développement). Seatbelt ne
  borne pas l'interface : un serveur qui écoute sur toutes les interfaces
  est joignable du réseau local, ce que dit la ligne d'ouverture.

Ces trois champs, comme `network`, ne règlent que le bac des commandes :
absents, rien n'est accordé et la version de la politique ne change pas.
Justification entrée par entrée et mesures : `docs/allowlist-outils.md`.

La politique par défaut est celle du sandbox courant, en plus strict (secrets
`.env*` et métadonnées `.git` protégés, tâches de fond soumises à décision
humaine), jamais en plus large.

### « ask », refus et erreurs du contrôleur

- Terminal et web : la question habituelle, motif affiché ; « always » ne vaut
  que pour cet appel, et l'état est relu après la réponse.
- Headless : suspension explicite, rien n'est exécuté, une ligne
  `[policy] {…}` part sur stderr, sortie 4.
- Terminal web : la ligne n'est pas exécutée ; ce terminal ne sait pas
  recueillir une décision enregistrée.
- Politique absente, illisible, partielle ou de schéma inconnu : toute action
  est refusée ; un run headless est refusé avant de chercher un modèle
  (sortie 3), sans rien enregistrer.

### Sous-processus, secrets et traces

Sous le profil, les sous-processus (commandes, tâches, vérifications,
terminal web) reçoivent un environnement minimal explicite et un shell sans
profil de connexion : `bash -c`, pas `-lc`, car un `~/.bash_profile` peut
réexporter des secrets. Les sorties ne sont pas filtrées : la garantie tient
à ce que le secret n'entre pas.

Traces accessibles au modèle : ce qu'il reçoit (messages, résultats
d'outils), le transcript (que l'interface web sauvegarde tel quel dans
`~/.smolcoder/sessions/`) et ce que smol affiche (stdout et stderr, sortie
des sous-processus comprise). Le modèle ne lit pas le terminal web, qui reçoit
néanmoins le même environnement minimal.

### Isolation du système (macOS, ticket #16)

Sous le profil, les quatre surfaces lancent leurs commandes par le backend
Seatbelt (`sandbox-exec`), dont le profil est généré depuis la politique à
chaque lancement : lecture de l'allow-list de l'empreinte des outils
(`docs/allowlist-outils.md`) et du workspace, écriture dans le workspace et
un TMPDIR privé à la session, noms protégés et stockage hôte refusés, réseau
fermé sauf les destinations de `network` et les écoutes de `listen`. La
session l'annonce à l'ouverture (`· isolation: macOS Seatbelt …`, avec les
ports d'écoute accordés et leur limite) ; le headless écrit aussi une ligne
`[isolation] {…}` sur stderr.

L'état reste ensuite visible toute la session (#18), relu à chaque rafraîchi
(les écoutes suivent la politique) : dans la ligne d'état du terminal, après
l'état de la mission (`mission approved 3/50 · isolated · listens
localhost:5173`, ou `isolation unavailable` en rouge) ; dans la page web, une
pastille de la barre d'état à côté du mode (verte, « isolated », avec les
écoutes accordées ; rouge, « isolation unavailable — <motif> »), la ligne
d'ouverture complète au survol. Le hub l'expose dans l'état de la session
(`isolation` : `backend`, `state`, `reason`, `listen`, `label`, `line`).
Hors profil, ni l'état, ni la ligne d'état, ni la barre de la page ne
changent : l'absence de pastille distingue le mode historique.

Backend absent ou inopérant (autre système que macOS, `sandbox-exec`
introuvable, sonde en échec, workspace qui contient le dossier personnel) :
la ligne d'ouverture dit `· isolation unavailable (…)` et chaque commande
est refusée avec ce motif ; rien n'est relancé dans le shell non isolé.
Modèle de menace, choix et limites : `docs/decision-backend-isole.md`.
Preuves sur macOS réel : `npm run test:os`.

### Bypass, sortie du profil, hooks, pièces jointes

- Sous le profil, `bypass` n'élargit rien : la politique décide quel que soit
  le mode. Passer en bypass reste un geste humain (shift+tab, `/mode`,
  `--mode`) signalé à l'écran ; aucun outil du modèle ne change le mode.
  Quitter le profil, c'est relancer smol sans `--mission`.
- Aucun hook configurable n'existe (`src/events.ts` est un bus interne) ; le
  futur point de branchement serait `decide`, et un hook proposé par un dépôt
  ne serait jamais exécuté comme code de confiance.
- Les pièces jointes viennent de l'humain (interface web) et sont stockées
  hors du workspace ; aucun outil du modèle n'en crée : elles restent hors
  décision.

## Verdicts et preuves d'acceptation (ticket #9)

Sous le profil, chaque contrôle décisif (contrôles `checks` du contrat,
`--verify`, à défaut contrôles découverts du projet) passe par la décision
d'accès, puis ne tourne que si les entrées du vérificateur sont celles que
l'hôte a figées, et seulement par l'exécuteur isolé. Il laisse au journal un
verdict `passed`, `failed`, `not_run` ou `error`, avec l'empreinte du contrat,
celle des entrées figées et celle des fichiers vérifiés. L'état de la tâche
(`running`, `verified`, `incomplete`, `blocked`, `cancelled`, `uncertain`) en
est dérivé ; la décision humaine d'accepter reste à part, toujours en attente.
Une édition postérieure rend la preuve périmée : elle s'affiche `not_run`,
jamais `passed`.

Le rapport, `report.json` et `report.md` à côté du contrat, est regénéré au
début (état `running`) et à la fin de chaque tour ; chaque session l'annonce
par une ligne `· verdict: …`, le headless par une ligne `[verdict] {…}` sur
stderr. Définitions, mécanisme anti-altération, alternatives et limites :
`docs/decision-preuves-acceptation.md`.

## Plan d'implémentation approuvé avec le contrat (ticket #29)

Le contrat fixe le besoin et la spécification ; le plan fixe la manière de les
réaliser. Sous le profil, l'agent peut proposer avant approbation un plan
structuré, que l'hôte approuve avec le contrat, dans le même geste. Le plan
reste un guide, pas une cage.

### Proposer

Avant approbation, la porte de #8 laisse passer l'outil `plan` comme les
lectures. Sous `--mission` seulement, il a une action de plus, `propose` :

```json
{"action": "propose",
 "steps": "écrire hello.txt\nle relire",
 "files": "hello.txt",
 "risks": "aucun au-delà du contrat",
 "proofs": "2: read_file hello.txt montre bonjour"}
```

- `steps` : l'ordre des travaux, une étape par ligne (20 au plus) ;
- `files` : les fichiers à créer ou modifier, un chemin relatif du workspace
  par ligne (`src/` pour tout un dossier, 50 au plus) ;
- `risks` : risques et contraintes techniques, facultatif ;
- `proofs` : la preuve attendue de chaque critère d'acceptation, une ligne
  `N: preuve` par critère, numéroté comme dans le contrat.

Des champs plats, comme tout l'outil : les petits modèles abîment les objets
imbriqués. L'hôte valide la grammaire (`src/harness/store.ts`), journalise la
proposition (événement `plan` de nature `proposed`, contenu entier, empreinte)
et la pose sur la checklist de l'agent, qui la garde après compaction avec son
détail. Une grammaire refusée (critère inconnu ou donné deux fois, chemin hors
du workspace, aucun fichier, ligne de preuve sans numéro) revient au modèle
comme une erreur qui dit quoi corriger, sans rien enregistrer. Avant
approbation, `set` ou `add` sur un plan proposé en font une nouvelle
proposition : l'hôte approuve toujours la dernière version, celle que montre
`/approve`. Pendant qu'un plan proposé attend l'hôte, la relance « étapes non
finies » ne s'applique pas : aucune étape n'est faisable avant l'approbation.

Hors `--mission`, l'outil `plan` est celui d'avant #29, schéma et réponses
compris. Sous `--mission`, une checklist posée par `set` sans `propose` reste
une simple checklist, sans effet sur l'approbation.

### Preuve attendue par critère

Alignée sur #9 sans la dupliquer : un critère couvert par un contrôle de
l'hôte (`checks`) a déjà sa preuve, que l'hôte produit lui-même ; le plan n'a
rien à y ajouter et ne recopie pas la commande. Pour les autres, le plan
déclare comment ils seront prouvés — une déclaration, jamais une preuve : le
verdict reste celui des contrôles (`docs/decision-preuves-acceptation.md`).

Un critère ni couvert ni prévu est signalé avant approbation : au modèle,
dans la réponse de `propose` (`NO PLANNED PROOF`) ; à l'humain, dans la vue du
plan (« aucune preuve prévue ») et par une ligne d'alerte juste avant la
question de `/approve` ; à l'appelant headless, dans la ligne `[mission]`
(`plan.missingProofs`). Le signalement n'empêche pas d'approuver : l'humain
décide.

### Approuver : les deux empreintes

- Terminal et web : `/approve` montre le contrat, puis le plan proposé (ordre
  des travaux, fichiers, risques, preuve attendue par critère), puis pose une
  seule question : « Approve contract and plan », « Approve contract only »
  (absent si le contrat exige le plan) ou « Cancel ». Approuvés ensemble,
  l'événement `approval` porte l'empreinte du plan (`plan`) et `contract.json`
  la garde dans l'approbation.
- Headless, en deux runs :
  1. `smol -p "…" --mission contrat.json --propose-plan` : l'agent lit et
     propose, en lecture seule (mode `ro` imposé, aucun contrôle
     d'acceptation, aucun pas débité puisque rien n'est approuvé) ; seul un
     contrat proposé l'autorise. Sortie 3 : la vue du contrat et du plan sur
     la sortie standard, la ligne `[mission]` avec `plan.fingerprint` et
     `plan.missingProofs`.
  2. `smol -p "…" --mission contrat.json --approve <contrat> --approve-plan
     <plan>` : les deux empreintes exactes, une seule approbation. Une
     empreinte de plan autre que celle du dernier plan proposé refuse tout,
     contrat compris (sortie 3, rien d'enregistré). `--approve` seul approuve
     le contrat sans le plan, et le message le dit.
- Une approbation par sujet : `--approve` nomme le contrat, `--approve-plan`
  son plan (seulement avec `--approve`, dans le même geste),
  `--approve-verifiers` les entrées du vérificateur (#9, sous un contrat déjà
  approuvé). La nouvelle approbation des entrées garde le plan approuvé tel
  quel ; un plan ne s'approuve jamais après coup, sous un contrat déjà
  approuvé : `--approve-plan` est alors refusé, avec ce motif, comme
  `propose` sous un contrat approuvé sans plan ; sous un contrat approuvé
  avec son plan, `propose` réécrit le plan courant, écart journalisé
  (ci-dessous).
  `--propose-plan` ne se combine avec aucune approbation ni avec `--verify` :
  on approuve dans un run suivant, après avoir lu le plan.

### Facultatif par défaut, exigible par le contrat

Décision : le plan est facultatif. Sans plan proposé, rien ne change — mêmes
vues, même question de `/approve`, même événement `approval`, même
`contract.json`, même rapport, même ligne `[mission]`. Le rendre exigible par
défaut se décidera sur mesure (dernier critère du ticket), pas sur intuition.
Le contrat peut l'exiger, par `"plan": "required"` : l'approbation sans plan
est alors refusée partout (`/approve` le dit sans rien demander ; headless,
sortie 3 avec la marche à suivre, `--propose-plan` d'abord), et le bloc du
contrat demande au modèle de proposer le sien. Le champ absent n'entre pas
dans l'empreinte : les contrats existants gardent la leur.

### Après approbation : écarts journalisés, jamais bloquants

Le plan approuvé guide, il n'enferme pas. Sous un contrat approuvé avec son
plan, trois écarts laissent chacun un événement `plan` de nature `deviation`
au journal, avec l'avant, l'après et le motif donné par l'agent (ou `null`) :

- une écriture (`write_file`, `edit_file`) sur un fichier absent du plan :
  l'écriture a lieu, le modèle reçoit une note qui l'invite à dire pourquoi
  (`plan` `add` avec `files` et `reason`), l'écart est journalisé une fois par
  chemin ; seule la politique d'accès de #11 refuse, comme avant ;
- une étape ajoutée ou retirée (`add`, `set`), ou une rubrique réécrite
  (`propose` après approbation : étapes, fichiers, risques, preuves) : un
  événement par rubrique changée ; `add` accepte `files` et `reason` pour
  ajouter au plan, avec son motif, les fichiers de l'étape ;
- cocher une étape (`done`) ou noter un point d'étape (`checkpoint`) n'est
  pas un écart.

Le plan réécrit ne remplace jamais silencieusement le plan approuvé : la
version approuvée reste dans le journal telle qu'approuvée, l'empreinte de
l'approbation ne change pas, et la version courante se reconstruit en
rejouant les écarts. Les deux restent lisibles : `/mission` montre le plan
approuvé, puis le plan courant s'il diffère, puis la liste des écarts
(« journalisés, jamais bloquants ») ; `report.json` porte une rubrique `plan`
(`approved`, `current`, `deviations`, `missingProofs`) et `report.md` la même,
après le bilan des critères. Un écart ne touche ni l'approbation du contrat,
ni le budget, ni aucun statut de critère : c'est une trace pour la revue.

### Ce que voit le modèle

Le bloc du contrat, relu dans le stockage hôte à chaque tour et après
compaction, porte une ligne `Plan:` seulement quand un plan existe ou est
exigé : proposé (en attente de l'hôte), approuvé (empreinte, fichiers, « un
guide, pas une cage », nombre d'écarts journalisés), ou exigé. La checklist
de l'agent repart, à chaque session sous le même contrat, de la version
courante du plan approuvé (ou de celui qui attend l'approbation), étapes non
cochées ; `/clear` la rétablit, comme le contrat.

## Budget de pas

`budgets.maxSteps` compte les appels au modèle effectués sous un contrat
approuvé. La consommation est persistante (`usage.steps` dans
`contract.json`, hors empreinte) : elle survit aux sessions et suit le même
identifiant de contrat quand une nouvelle version le remplace. Au-delà du
budget, le contrat expire, le tour s'arrête avec une erreur explicite et un
run headless sort en 3. Réapprouver un contrat expiré est refusé ;
l'élargir exige une nouvelle version (nouvelle empreinte) et une nouvelle
approbation. Aucun plafond global de contexte (décision #4) : le schéma
refuse tout autre budget.

## Compaction

Le contrat n'est jamais confié au résumé du modèle : la note de compaction
le reprend en tête, relu dans le stockage hôte au moment de la compaction
(état, empreinte, budget consommé, hors périmètre, critères).

## Codes de sortie headless

- 0 : run terminé sous un contrat toujours approuvé, tâche `verified` (chaque
  critère requis `passed` sur les fichiers actuels, rapport écrit) ;
- 1 : erreur d'usage (options, contrat invalide) ou aucun modèle joignable,
  avant tout tour ;
- 3 : le contrat n'autorise pas l'exécution (proposé, expiré, périmé,
  empreinte refusée, stockage hôte illisible ou de schéma inconnu, journal
  tronqué, politique d'accès illisible, `--approve-verifiers` refusé,
  `--approve-plan` refusé, plan exigé absent) ; il prime sur 4 et 5 quand le
  contrat n'est plus approuvé en fin de run. Un run `--propose-plan` sort
  aussi 3 : le contrat reste proposé, le plan attend l'hôte ;
- 4 : suspendu sur une décision « ask » de la politique d'accès, rien n'a été
  exécuté pour cette action ; il prime sur 5 ;
- 5 (#9) : le run est allé à son terme ou s'est arrêté, mais la tâche n'est
  pas `verified` — critère en échec, non couvert, non exécuté, en erreur,
  preuve périmée, vérificateur modifié, ou rapport non écrit. Avant #9, un
  run en échec sortait 1.

## Limites connues

- L'approbation et la politique ne sont pas une isolation du système (H03,
  #12) : le jugement des commandes lit leur texte, avec des faux négatifs
  connus (`grep -r motif .` lit `.env` sans le nommer, `cd` sans argument
  mène au dossier personnel, substitution de commande) et des faux positifs
  (un message de commit qui cite `.env`). Sur macOS, le backend Seatbelt
  (#16) prive ces faux négatifs d'effet sur ce qu'il protège : le système
  refuse la lecture quel que soit le texte de la commande ; ses limites
  (réseau, écoute, descendants détachés, git) sont dans
  `docs/decision-backend-isole.md` et `docs/allowlist-outils.md`.
- La politique n'est pas liée à l'approbation : l'appelant qui la modifie
  après approbation change les droits sans nouvelle approbation (la version
  figure dans chaque décision). `policyRef` du contrat reste réservé.
- `list_files` montre le nom des fichiers protégés, jamais leur contenu.
  L'`AGENTS.md` du workspace reste modifiable (une consigne, pas un droit) ;
  l'appelant peut l'ajouter à `paths.protect`.
- Pas de verrou : deux sessions simultanées sous le même contrat peuvent
  perdre un débit de pas (verrou mono-écrivain : #10).
- Les événements `verdict` sont produits par chaque contrôle décisif (#9) ;
  leurs limites (ensemble des entrées du vérificateur par convention, zéro
  test reconnu par les résumés des lanceurs courants…) sont dans
  `docs/decision-preuves-acceptation.md`. Les événements `fiche` (#30) le
  sont à chaque lecture d'une fiche installée côté hôte
  (`docs/decision-fiches-hote.md`).
- La suspension headless (sortie 4) est testée par ses briques (agent non
  interactif, rapport de décision), pas par le CLI réel contre un backend.
- Le plan (#29) est déclaratif : aucun contrôle ne vérifie qu'une preuve
  prévue sera produite, aucun juge ne note le plan (hors périmètre du
  ticket). Un run `--propose-plan` appelle le modèle sans débiter le budget
  de pas, le contrat n'étant pas approuvé ; il reste borné par le plafond de
  pas du headless et ne peut rien écrire. La progression du plan (étapes
  cochées) ne survit pas à la session : la reprise (#10) la persistera.
- Les écarts au plan ne voient que les outils de fichiers du modèle : un
  fichier créé ou modifié par une commande (`run_command`, tâche de fond,
  script de build) n'est pas comparé au plan. Une session web reprise
  retrouve ses étapes sauvegardées, qui peuvent différer de la version
  courante du journal jusqu'au prochain changement.
- Le run headless approuvé est testé par le CLI réel sur macOS (#18,
  `test/os/e2e.os.test.js`, dans `npm run test:os`), contre un faux serveur
  OpenAI-compatible local qui joue le modèle : `run_command`, `--verify`,
  tâche de fond et écoute, dans le bac ; et le plan (#29, « H08 OS ») en
  deux runs, `--propose-plan` puis `--approve` avec `--approve-plan`, écart
  journalisé compris. Aucun test ne le lance contre MTPLX.
