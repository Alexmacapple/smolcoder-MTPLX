# Décision d'architecture — le stockage hôte du harnais

Statut : rédigée le 2026-09-26 sur le pré-arbitrage validé par Alex (ticket
#14) ; la fusion de la pull request qui porte cette page vaut acceptation.
S'en écarter ensuite exige une nouvelle validation.

## Problème

H01 (contrat de mission), H02 (politique d'accès), H04 (preuves
d'acceptation) et H05 (verrou, journal) ont chacun besoin d'un état qui
survit aux sessions et reste hors de portée des outils du modèle. Décidés
séparément, ces états ne composeraient pas entre terminal, web, headless,
reprise et migration.

## Décision

### Lieu

`~/.smolcoder/harness/<empreinte-du-workspace>/` — sous le dossier de
données existant de smolcoder, jamais dans le workspace. L'empreinte du
workspace est le SHA-256 du chemin réel (realpath) du workspace, tronqué à
seize caractères hexadécimaux : stable à travers les liens symboliques,
sans collision pratique, lisible dans un `ls`.

### Contenu

Trois fichiers par workspace, pas plus (le troisième ajouté par #11,
conformément à la rubrique « conséquences » ci-dessous ; #9 y ajoute deux
projections, `report.json` et `report.md`, et #10 le verrou `lock` et
l'enregistrement de reprise `resume.json`, voir « Amendements ») :

- `contract.json` — le contrat de mission approuvé (motif A, plein).
  Schéma versionné (`smolcoder/contract/v1`), statuts fermés
  `proposed | approved | expired`, et l'approbation liée à l'empreinte du
  contrat : toute modification du contrat invalide l'approbation.
- `policy.json` — la politique d'accès et sa version (ajouté par #11,
  même grammaire, module propriétaire commun).
- `proofs.jsonl` — journal en ajout seul (motifs B plein et C minimal) :
  une ligne JSON par événement, six types exactement (le quatrième
  ajouté par #30, le cinquième par #29, le sixième par #10, voir
  « Amendements ») — `contract`
  (création ou changement d'état d'un contrat), `approval` (qui, quand,
  quelle empreinte), `verdict` (résultat d'une vérification, avec
  l'empreinte des fichiers vérifiés au moment du verdict ; champs fixés
  par #9, voir « Amendements »), `fiche`
  (lecture d'une fiche de méthode installée : son nom, l'empreinte du
  contenu servi et celle du contrat), `plan` (plan d'implémentation
  proposé par l'agent, contenu entier et empreinte, puis chaque écart au
  plan approuvé), `effect` (journal d'effets : chaque action du modèle
  enregistrée avant son effet, puis son résultat, et l'état incertain
  qu'en constate l'hôte à la reprise). Un verdict dont
  les fichiers ont changé depuis est périmé par construction : la
  péremption se constate en comparant les empreintes, elle n'est jamais un
  champ modifiable.

### Règles d'écriture et de lecture

- Écritures atomiques (fichier temporaire puis renommage), en réutilisant
  le motif éprouvé de `src/web/store.ts`.
- Un seul module du code possède la grammaire de ces fichiers — schéma,
  statuts, validation — et tous les consommateurs passent par lui : les
  portes ne peuvent pas dériver vers des interprétations différentes.
- Fail-closed : un fichier illisible, un schéma inconnu ou une dernière
  ligne tronquée du journal sont des états explicites (`unreadable`,
  `unknown-schema`, `truncated-tail`), jamais ignorés, jamais convertis en
  succès. Bornes dures de lecture (taille maximale par fichier) pour
  qu'une corruption ne coûte pas la session.
- États discrets uniquement, jamais de score : le stockage décrit des
  faits (`approved`, `expired`, `stale`), il ne note rien.

### Exclusions actées

Pas de base de données, pas de signature cryptographique (la cérémonie
Loriq n'est pas importée), pas de journal transactionnel par action — le
registre par action reste une décision de H05 (#10), à prendre à ce
moment-là, éclairée par l'usage réel des trois événements minimaux.

## Motifs empruntés — lecture des artefacts Loriq (sans dépendance)

Conformément au ticket, les trois artefacts ont été lus avant rédaction :

- `runtime/behavior_contract.py` : un module unique possède la grammaire
  (« one module owns the grammar »), chemin de contrôle fixe, schéma
  versionné, statuts fermés, bornes de lecture fail-closed — repris tels
  quels dans les règles ci-dessus.
- `tools/mutation_ledger.py` et `docs/mutation-ledger/` : le journal
  append-only lisible (`proofs.jsonl`, une ligne par événement) qui « rend
  la pourriture lisible au moment où quelqu'un regarde », les états
  discrets sans score, et la leçon des deux lectures (un vert périmé ne se
  détecte que si la trace porte de quoi le dater) — repris dans le format
  du journal et la péremption par empreinte.
- `runtime/validate.py` : la validation comme liste de contrôles à états
  discrets, fail-closed — reprise dans les règles de lecture.

Rien n'est importé ni exécuté depuis Loriq : smolcoder reste autonome.

## Conséquences pour les tickets

- #8 (contrat) : implémente `contract.json` et son module propriétaire ;
  l'autorité d'approbation écrit l'événement `approval` ; ni un texte du
  modèle, ni un fichier du workspace, ni un label de ticket n'écrivent
  dans ce stockage.
- #11 (politique) : la politique et sa version vivront dans ce dossier
  (fichier à définir par le ticket, même grammaire, même module ou module
  frère).
- #9 (preuves) : les verdicts et l'empreinte des fichiers vérifiés vont
  dans `proofs.jsonl` ; `report.json`, s'il existe, est une projection
  regénérable, jamais la source.
- #10 (reprise) : le verrou mono-écrivain par workspace vit dans le même
  dossier (`lock` avec PID et horodatage) ; le journal d'effets par
  action, s'il est décidé, étendra `proofs.jsonl` avec de nouveaux types
  d'événements versionnés.

## Alternatives écartées

- Stockage dans le workspace (`.smolcoder/` local au projet) : modifiable
  par les outils du modèle — contraire à l'objectif même.
- Base SQLite : transactionnelle mais opaque à l'humain et dépendance de
  plus ; le JSONL se lit avec les yeux et se répare à la main.
- Signature SSH des approbations (motif Loriq complet) : la cérémonie a un
  coût opérationnel vécu et documenté ; l'empreinte non signée suffit au
  modèle de menace local (l'adversaire est un agent confiné, pas un humain
  hostile avec accès au compte).

## Critère de validation

Cette page est acceptée quand la pull request qui la porte est fusionnée
par Alex. Les tickets #8, #9, #11 et #10 la référencent alors comme source
de vérité du stockage hôte au lieu de redéfinir chacun le leur.

## Amendements

### 2026-09-27 — ticket #30 : quatrième événement du journal, `fiche`

Écart déclaré à « trois types exactement ». Sous `--mission`, chaque
lecture d'une fiche de méthode installée côté hôte (`fiche:<nom>`,
`docs/decision-fiches-hote.md`) laisse au journal une ligne
`{"schema": "smolcoder/proof/v1", "type": "fiche", "at": …, "fingerprint":
<empreinte du contrat>, "name": <nom>, "sha256": <empreinte du contenu
servi>}`. Même grammaire, même module propriétaire (`src/harness/store.ts`),
champs fermés ; l'événement est écrit avant que la fiche soit servie, et un
journal qui refuse l'écriture empêche la lecture (fail-closed). Le schéma
reste `smolcoder/proof/v1` : un lecteur antérieur à #30 classe déjà un type
inconnu en `unknown-schema`, comme le prévoit la règle de lecture.

Pourquoi ce journal plutôt qu'un fichier de plus : la version d'une fiche
lue est une preuve rattachée au contrat de la session, comme l'approbation
et le verdict ; un quatrième fichier par workspace dupliquerait l'ajout seul,
les bornes et la réparation à la main. Écarté : un registre des lectures
hors mission, faute de stockage hôte hors profil.

Hors de cette décision, dit pour qu'il n'y ait pas d'écart silencieux : les
fiches installées vivent dans `~/.smolcoder/fiches/`, à côté de `harness/`
et non dedans. Ce n'est pas du stockage du harnais (ni contrat, ni
politique, ni preuve) ; sa grammaire appartient à `src/fiches.ts`. Comme
tout `~/.smolcoder`, le dossier reste refusé aux commandes isolées.

Cet amendement est accepté par la fusion de la pull request du ticket #30.

### 2026-09-27 — ticket #9 : verdicts, vérificateurs figés, rapport

Écarts déclarés, tous dans le module propriétaire `src/harness/store.ts`,
même grammaire, schémas inchangés (`smolcoder/contract/v1`,
`smolcoder/proof/v1`) : les champs ajoutés sont facultatifs et un lecteur
antérieur refuse un champ inconnu (fail-closed), comme le prévoient les
règles de lecture. Définitions et mécanisme :
`docs/decision-preuves-acceptation.md`.

- `contract.json`, le contrat : champ facultatif `checks`, liste de
  `{"command", "covers": [numéros de critères], "timeoutSeconds"?}` — les
  contrôles de l'hôte qui couvrent des critères `acceptance`, chaque critère
  couvert une fois au plus. Absent, il n'entre pas dans la forme canonique :
  l'empreinte des contrats existants ne change pas.
- `contract.json`, l'approbation : champ facultatif `verifiers`,
  `{"digest", "files": {chemin relatif: SHA-256 ou null}, "commands": […]}`
  — les entrées du vérificateur figées par cette approbation, 1 000 chemins
  au plus pour tenir sous la borne de 256 Kio ; `digest` est l'empreinte de
  `files` et se vérifie à la lecture. Absent ou `null` : entrées non figées
  (approbation antérieure à #9, ou bornes dépassées), aucun contrôle décisif
  ne peut alors passer. Une nouvelle approbation des seules entrées, sous un
  contrat déjà approuvé, remplace ce champ.
- Événement `approval` : champ facultatif `verifiers`, l'empreinte figée
  (ou `null`). Chaque nouvelle approbation des entrées ajoute un événement
  `approval`.
- Événement `verdict` : champs fermés `fingerprint` (le contrat),
  `criteria` (identifiants des critères couverts), `command`, `owner`
  (`contract`, `caller` ou `project`), `status` (`passed`, `failed`,
  `not_run`, `error`), `cause` (motif fermé, `null` pour `passed`
  seulement), `attempt`, `exit` (`{status, code, signal, durationMs}` de
  l'exécuteur, ou `null` sans processus), `tests` (nombre exécuté, ou
  `null`), `verifiers` (empreinte figée), `files` (empreinte des fichiers
  vérifiés) et `changes` facultatif (entrées changées, 50 au plus). Précision
  sur « au moment du verdict » : l'empreinte des fichiers est celle que laisse
  la séquence de contrôles de la tentative, portée par tous ses verdicts.
- Deux fichiers de plus, des projections et non des sources : `report.json`
  (schéma `smolcoder/report/v1`) et `report.md`, rendus du même objet,
  regénérés par l'hôte au début et à la fin de chaque tour du profil, écrits
  atomiquement, jamais relus par le code. Les statuts des critères se
  regénèrent depuis `proofs.jsonl`, le contrat et l'état constaté du
  workspace ; l'issue du tour (annulé, suspendu, erreur) n'est portée que
  par le rapport.

Pourquoi ces lieux plutôt qu'un fichier de plus pour les entrées figées :
elles appartiennent à l'approbation, qu'elles qualifient, et l'écriture
atomique de `contract.json` les garde cohérentes avec elle ; un fichier
séparé exigerait de réconcilier deux écritures. Écarté : écrire le rapport
dans le workspace, où l'agent qu'il juge pourrait le modifier.

Cet amendement est accepté par la fusion de la pull request du ticket #9.

### 2026-09-27 — ticket #29 : plan d'implémentation, cinquième événement `plan`

Deux natures, `proposed` (le plan proposé) et `deviation` (un écart après
approbation) ; le rapport de #9 gagne une rubrique du plan, projection comme
le reste, seulement quand un plan existe ou que le contrat l'exige.

Écarts déclarés à « quatre types exactement » et à la grammaire de
`contract.json`, tous dans le module propriétaire `src/harness/store.ts`,
schémas inchangés (`smolcoder/contract/v1`, `smolcoder/proof/v1`). Les champs
ajoutés sont facultatifs et absents sans plan : sans plan proposé,
`contract.json` et le journal s'écrivent exactement comme avant. Parcours et
décisions : `docs/profil-mission.md`, section du ticket #29.

- Cinquième type d'événement, `plan`, de nature `proposed` :
  `{"schema": "smolcoder/proof/v1", "type": "plan", "at": …, "fingerprint":
  <empreinte du contrat>, "kind": "proposed", "plan": <empreinte du plan>,
  "content": {"steps": […], "files": […], "risks": […], "proofs":
  [{"criterion": <numéro>, "proof": …}]}}` — le plan structuré que l'agent
  propose avant approbation, contenu entier. Champs fermés et bornés : 1 à 20
  étapes, 1 à 50 fichiers (chemins relatifs du workspace, sans `..`, 300
  caractères au plus, `dossier/` pour tout un dossier), 20 risques au plus, une
  preuve prévue par critère au plus (numéro du critère dans `acceptance`),
  lignes de 500 caractères au plus. L'empreinte du plan est le SHA-256 de la
  forme canonique de son contenu et de l'empreinte du contrat : le même texte
  sous une autre version du contrat est un autre plan. Elle se vérifie à la
  lecture ; une ligne retouchée à la main rend le journal illisible
  (fail-closed). Une proposition identique à la précédente n'ajoute rien.
- Même type, de nature `deviation`, après approbation :
  `{"schema", "type": "plan", "at", "fingerprint", "kind": "deviation",
  "plan": <empreinte du plan approuvé>, "change": "file" | "steps" | "files"
  | "risks" | "proofs", "before": […], "after": […], "reason": <motif de
  l'agent> | null}` — un écart au plan approuvé, jamais un refus. `file` : un
  fichier écrit par `write_file` ou `edit_file` hors des fichiers du plan
  (`before` vide, `after` le seul chemin écrit), une fois par chemin ; les
  autres : une rubrique du plan réécrite par l'agent, avant et après (les
  preuves en lignes « N: preuve »), 50 lignes de 1 024 caractères au plus,
  motif de 500 caractères au plus. La version approuvée n'est jamais
  réécrite ; la version courante se reconstruit en rejouant les écarts sur
  elle, dans l'ordre du journal.
- Événement `approval` : champ facultatif `plan`, l'empreinte du plan approuvé
  avec le contrat. Absent : contrat approuvé sans plan.
- `contract.json`, l'approbation : même champ facultatif `plan`, écrit
  atomiquement avec elle. La nouvelle approbation des seules entrées du
  vérificateur (#9) le garde tel quel : une approbation par sujet.
- `contract.json`, le contrat : champ facultatif `plan`, seule valeur
  `"required"` — l'hôte n'approuve alors ce contrat qu'avec un plan. Absent,
  il n'entre pas dans la forme canonique : l'empreinte des contrats existants
  ne change pas.

- `report.json` et `report.md` : rubrique facultative `plan` (état,
  empreinte, version approuvée ou proposée, version courante si l'agent l'a
  réécrite, critères sans preuve prévue, écarts), absente sans plan ni
  exigence. Elle n'entre dans aucun statut.

Pourquoi le journal plutôt qu'un fichier `plan.json` : le plan approuvé doit
rester lisible tel qu'il a été approuvé, même quand l'agent réécrit ensuite sa
checklist ; l'ajout seul le garantit par construction, là où un fichier
réécrit atomiquement devrait tenir lui-même ses versions, et dupliquerait les
bornes, la lecture fail-closed et la réparation à la main du journal. Le
contenu approuvé se relit dans la proposition journalisée dont l'empreinte est
celle de l'approbation ; l'empreinte, elle, vit dans l'approbation, qu'elle
qualifie, comme les entrées figées du vérificateur. Écarté : un `plan.md` dans
le workspace, à la manière du guide cité par le ticket — l'agent qu'il guide
pourrait réécrire le plan approuvé.

Compatibilité, dite pour qu'il n'y ait pas d'écart silencieux : un binaire
antérieur à #29 classe un journal qui contient un événement `plan` en
`unknown-schema`, et un `contract.json` dont l'approbation porte `plan` en
`unreadable` (champ inconnu) — refus explicites, comme le prévoient les règles
de lecture, jamais une approbation perdue en silence.

Cet amendement est accepté par la fusion de la pull request du ticket #29.

### 2026-09-27 — ticket #10 : sixième événement `effect`, lignes synchronisées

Écart déclaré à « cinq types exactement », dans le module propriétaire
`src/harness/store.ts`, schéma inchangé (`smolcoder/proof/v1`). C'est le
journal d'effets que la rubrique « conséquences » réservait à #10 ; décision
complète : `docs/decision-reprise-durable.md`.

- Sixième type d'événement, `effect`, quatre natures (`kind`) fermées :
  `intent` (écrit avant l'effet : `id` de douze caractères hexadécimaux,
  `session`, `call` — l'identifiant de l'appel d'outil —, `tool` parmi
  `write_file`, `edit_file`, `run_command`, `task` ; pour un fichier `path`
  relatif au workspace, `before` et `expected`, empreintes SHA-256 ou null ;
  pour une commande `command`, 2 000 caractères au plus), `result` (après
  l'effet : `status` `ok` ou `error`, `observed`, première ligne du retour de
  l'outil sur 300 caractères au plus, `after` facultatif pour un fichier),
  `uncertain` (écrit par l'hôte à l'ouverture d'une session pour une
  intention sans résultat : `evidence` parmi `before`, `expected`, `neither`,
  `none`, et `current` facultatif) et `resolved` (la décision de l'hôte :
  `by`, une des autorités d'approbation). Champs fermés et bornés ; `fingerprint`
  reste l'empreinte du contrat de la session qui écrit.
- Toute ligne du journal est désormais écrite puis synchronisée sur le disque
  (`fsync`) avant que l'appelant ne continue : une intention précède toujours
  son effet. Le fichier est créé en mode 0600.

Pourquoi le journal existant plutôt qu'un fichier d'effets : la règle de la
rubrique « conséquences » ; un seul journal garde un seul ordre, une seule
borne et une seule réparation à la main. Le coût : chaque effet ajoute deux
lignes (quelques centaines d'octets), loin de la borne de 8 Mio pour une
mission ; la borne atteinte refuse l'intention, donc l'effet (fail-closed).

Compatibilité : un binaire antérieur à #10 lit un journal qui contient un
événement `effect` comme `unknown-schema`, refus explicite prévu par les
règles de lecture.

Cet amendement est accepté par la fusion de la pull request du ticket #10.

### 2026-09-27 — ticket #10 : verrou `lock` et enregistrement `resume.json`

Deux fichiers de plus dans le dossier du workspace, grammaire dans le module
propriétaire `src/harness/store.ts`. Le premier est celui que la rubrique
« conséquences » réservait à #10 ; le second est un écart déclaré à « trois
fichiers ». Décision complète : `docs/decision-reprise-durable.md`.

- `lock` (`smolcoder/lock/v1`) : `pid`, `host`, `session` (douze caractères
  hexadécimaux), `surface` (`terminal`, `web`, `headless`), `since`. Créé
  exclusivement (`O_EXCL`, mode 0600, synchronisé) par la session qui ouvre
  le profil ; retiré par elle seule à sa fin (la session qui l'a posé,
  vérifiée à la relecture). Un verrou dont le processus n'existe plus sur
  cette machine est remplacé atomiquement puis relu ; un verrou vivant n'est
  jamais pris ; un verrou illisible refuse toute écriture jusqu'à réparation
  à la main. Il ne bloque pas un éditeur externe : la session revérifie avant
  chaque effet.
- `resume.json` (`smolcoder/resume/v1`) : l'état que la dernière session a
  laissé — `at`, `session`, `surface`, `contract` (empreinte), `head` (révision
  Git lue dans `.git`), `files` (`digest`, l'empreinte globale de #9, et
  `entries`, l'empreinte de chaque fichier, null au-delà de 5 000 fichiers),
  `instructions` (empreintes des deux `AGENTS.md`), `plan` (empreinte du plan
  en vigueur et checklist cochée), `steps` (budget consommé). Écrit
  atomiquement par la session qui tient le verrou, à l'ouverture, en fin de
  tour et à sa fin ; borne de lecture 4 Mio. Une référence pour constater ce
  qui a changé depuis, jamais une source de droit : le contrat, le budget,
  les preuves et les effets restent dans `contract.json` et `proofs.jsonl`.

Pourquoi un fichier plutôt qu'un événement du journal : cet état est réécrit
à chaque tour, et seul le dernier compte ; en ajout seul, il gonflerait le
journal de l'empreinte de tout le workspace à chaque tour et rapprocherait la
borne de 8 Mio. Un fichier perdu ou illisible ne retire aucun droit : la
session suivante le dit et repart de l'état constaté.

Cet amendement est accepté par la fusion de la pull request du ticket #10.

### 2026-09-27 — ticket #10 : politique liée à l'approbation

Deux champs facultatifs, dans le module propriétaire `src/harness/store.ts`,
schémas inchangés ; un lecteur antérieur refuse un champ inconnu, comme le
prévoient les règles de lecture.

- `contract.json`, l'approbation, et l'événement `approval` : champ
  facultatif `policy`, la version de la politique d'accès en vigueur à
  l'approbation (`smolcoder/policy/v1@<16 hexadécimaux>`). Absent :
  approbation antérieure à #10, ou politique illisible alors. La nouvelle
  approbation des seules entrées du vérificateur (#9) le garde.
- Événement `effect` de nature `intent` : champ facultatif `policy`, la
  version de la décision qui a permis l'effet.
- `policyRef` du contrat, réservé depuis #8, prend son sens : la version exacte
  de la politique avec laquelle le contrat est approuvé ; une autre version en
  vigueur ne décide de rien. Aucun changement de grammaire (le champ était
  déjà un texte facultatif, dans l'empreinte) : un `policyRef` qui n'est pas
  une version ne correspond jamais, et tout est refusé (fail-closed).

Pourquoi l'approbation plutôt qu'un fichier de plus : la version qualifie
l'approbation, comme les entrées figées du vérificateur et le plan approuvé.

Cet amendement est accepté par la fusion de la pull request du ticket #10.
