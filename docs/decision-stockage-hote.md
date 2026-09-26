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
conformément à la rubrique « conséquences » ci-dessous) :

- `contract.json` — le contrat de mission approuvé (motif A, plein).
  Schéma versionné (`smolcoder/contract/v1`), statuts fermés
  `proposed | approved | expired`, et l'approbation liée à l'empreinte du
  contrat : toute modification du contrat invalide l'approbation.
- `policy.json` — la politique d'accès et sa version (ajouté par #11,
  même grammaire, module propriétaire commun).
- `proofs.jsonl` — journal en ajout seul (motifs B plein et C minimal) :
  une ligne JSON par événement, trois types exactement — `contract`
  (création ou changement d'état d'un contrat), `approval` (qui, quand,
  quelle empreinte), `verdict` (résultat d'une vérification, avec
  l'empreinte des fichiers vérifiés au moment du verdict). Un verdict dont
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
