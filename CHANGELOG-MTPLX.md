# Journal des modifications — fork MTPLX

Fork de [leonvanzyl/smolcoder](https://github.com/leonvanzyl/smolcoder)
(MIT, crédit à Leon van Zyl). La version amont de référence est
`0.7.1` (commit `4ee47b5`, « Release smolcoder 0.7.1 »). Tout ce qui
figure ci-dessous est ajouté par ce fork le 26 septembre 2026.

## 2026-09-26

### `0fbdc40` — Lecture de la fenêtre de contexte réelle

`src/detect.ts` (2 lignes). La branche fallback « older LM Studio »
imposait 4 096 tokens à tout serveur non identifié nativement.
Maintenant, quand la liste OpenAI-compatible `/v1/models` rapporte
`context_length` (c'est le cas de MTPLX : 262 144 pour Qwen 3.8 27B
FP16), cette valeur est lue ; l'estimation 4 096 ne s'applique plus
qu'en son absence.

Vérifié en headless et en interface web : la session affiche
`ctx 262,144` (usage 1 361 tokens après un message, réserve de
réponse 8 192), contre 4 096 avant.

### `68fc460` — README préambule du fork

`README.md`. Bloc en français ajouté au-dessus du README amont
(conservé tel quel) : pourquoi le fork, la config `~/.smolcoder.json`
qui raccorde MTPLX, la description du patch, la commande
d'installation du fork.

### `ef7df9a` — `AGENTS.md` français

`AGENTS.md` à la racine : consignes de langage pour l'agent (réponses
en français, code et identifiants en anglais, commits conventionnels en
français), chargé à chaque session par smolcoder et conservé après
compactage.

### `659f266` — Lanceur macOS à la racine du fork

`launch-smol-mtplx.command` (copie du lanceur du workspace
`~/Claude/lanceurs/`). Interface web par défaut : le lanceur se
raccorde au démon par « smol --web » pour obtenir une URL fraîche —
la clé `?k=` lisible dans `~/.smolcoder-web.log` peut dater d'un
démon précédent et renvoyer 403 — puis l'ouvre dans le navigateur.
`<dossier>` raccorde ce dossier à l'interface, `--session [dossier]`
ouvre le terminal interactif, `--test` joue une requête headless de
contrôle.

Vérifié par exécution réelle : curl 403 sur la clé du log contre 200
sur une clé fraîche ; les quatre modes exécutés (expect sur TTY réel
pour `--session`).

### `ec6fb69`, `d46a96e` — Consignes globales `~/.smolcoder/AGENTS.md`

`src/prompt.ts`. smolcoder ne lisait que l'`AGENTS.md` du dossier de
travail : les règles communes devaient être recopiées dans chaque projet,
et un `AGENTS.md` de plus de 8 000 caractères perdait sa fin. Il charge
désormais d'abord `~/.smolcoder/AGENTS.md` (plafond 4 000 caractères),
puis celui du projet (plafond inchangé, 8 000), sans lire deux fois le
même fichier. Six tests dans `test/agents-md.test.js`, rouges sur les deux
cas de chargement global avant le correctif ; suite complète 152/152.

`docs/agents-md-global.md` : le noyau à installer comme
`~/.smolcoder/AGENTS.md`, dix commandements de l'agent de codage et deux
formules (Saint-Exupéry, Shannon), 1 908 caractères.

### `3cc57db` — README : le fork est la version de référence

`README.md` (2 lignes). Le patch n'est plus présenté comme candidat à
un pull request amont : ce fork est la version de référence pour
MTPLX, à installer à la place du paquet amont.

### `10d3db9` — Consigne de tenue du journal dans `AGENTS.md`

`AGENTS.md`, `CHANGELOG-MTPLX.md`. Toute modification du fork doit
désormais ajouter son entrée dans ce journal, dans le même commit.
SHA reportés sur les entrées qui n'en avaient pas (`ef7df9a`,
`ec6fb69`, `d46a96e`) ; entrées `659f266` et `3cc57db` ajoutées.

### `2245322` — Banc du noyau sur Qwen

`bench/noyau-agents-md/` (script et quatre consignes),
`docs/banc-noyau-agents-md-2026-09-26.md`. Mesure la conduite de
smolcoder avec et sans `~/.smolcoder/AGENTS.md` sur quatre scénarios
(bug, demande destructive, secret, ajout), un essai par cas sur MTPLX.
Avec le noyau, la demande destructive est refusée et la clé factice
n'est pas affichée ; sans lui, `git reset --hard` et `rm -rf` sont
exécutés et la clé est affichée. Bug et ajout réussis dans les deux cas.

### `ccd2215` — Règles du workspace reprises dans `AGENTS.md`

`AGENTS.md`. Delta du fork enrichi depuis le protocole du workspace
`~/Claude/AGENTS.md` : objectif sous contraintes et hypothèses nommées,
vérité et preuve (annonce avant action à impact, preuve après, échec
bruyant), changements (relire avant d'éditer, conventions montrables,
périmètre annoncé, SSH uniquement), modes d'échec à éviter. Le style
de commit passe de « conventionnel (`feat:`, `fix:`) » à la forme
nominale française, conforme à l'historique réel du dépôt ; l'ancienne
section « Travail » est fusionnée dans « Vérité et preuve ». Le noyau
global n'est pas répété : il est chargé depuis `~/.smolcoder/AGENTS.md`
(vérifié identique à `docs/agents-md-global.md` par `cmp`).
SHA `2245322` reporté sur l'entrée précédente (banc du noyau).

### (ce commit) — Section Projet et dégraissage du delta

`AGENTS.md`. Section « Projet » ajoutée en tête : build obligatoire
après toute modification de `src/` (le binaire npm link et le démon
web servent `dist/`), `npm test` (build puis suite), surface du fork
(`src/detect.ts`, `src/prompt.ts`), `dist/` généré à ne jamais éditer,
critère de fin (suite verte et entrée au journal). Trois règles
retirées car déjà portées par le noyau global : relire avant d'éditer
(commandement 2), dire le non-vérifié (commandement 7), élargissement
de périmètre annoncé (couvert par le mode d'échec « plus grand bien
silencieux »). SHA `ccd2215` reporté sur l'entrée précédente.

## Hors dépôt (machine locale)

- Fork créé : `Alexmacapple/smolcoder-MTPLX`.
- Déclaration du host MTPLX dans `~/.smolcoder.json`.
- Noyau global installé : `~/.smolcoder/AGENTS.md` (1 908 caractères,
  copie conforme de `docs/agents-md-global.md`).
- LaunchAgent `com.alex.smolcoder-web` pour `smol --web` (démon,
  log `~/.smolcoder-web.log`, port 7433, clé imprimée au démarrage).
- Lanceur `launch-smol-mtplx.command` dans `~/Claude/lanceurs/`,
  copié à la racine du fork depuis `659f266` (interface web par
  défaut, `--session`, `--test`).
