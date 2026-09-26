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

### (à suivre) — `AGENTS.md` français

`AGENTS.md` à la racine : consignes de langage pour l'agent (réponses
en français, code et identifiants en anglais, commits conventionnels en
français), chargé à chaque session par smolcoder et conservé après
compactage.

## Hors dépôt (machine locale)

- Fork créé : `Alexmacapple/smolcoder-MTPLX`.
- Déclaration du host MTPLX dans `~/.smolcoder.json`.
- LaunchAgent `com.alex.smolcoder-web` pour `smol --web` (démon,
  log `~/.smolcoder-web.log`, port 7433, clé imprimée au démarrage).
- Lanceur `launch-smol-mtplx.command` dans `~/Claude/lanceurs/`
  (`--web`, `--test`, session dans le fork).
