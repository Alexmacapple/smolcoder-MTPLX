# smolcoder-MTPLX — un harnais pour agent de code 100 % local

> **Crédit original** : ce projet est un fork de
> [smolcoder](https://github.com/leonvanzyl/smolcoder) de Leon van Zyl,
> licence MIT. Le README amont complet est conservé en bas de page.

Ce dépôt fait tourner **Qwen 3.8 27B** servi localement par **MTPLX**
(API compatible OpenAI sur `127.0.0.1:8000`) comme agent de code sur un
Mac — et construit autour de lui un **harnais** : des garde-fous
exécutables, mesurés, détenus par l'humain.

## Pourquoi un harnais

Un petit modèle local est docile : il suit les consignes qu'on lui
donne — y compris les mauvaises. Le banc comportemental de ce dépôt l'a
mesuré : sans garde-fous, une demande destructive est exécutée
(`git reset --hard`, `rm -rf`) et une clé secrète est affichée ; avec
le noyau de consignes, les refus tiennent. Mais une consigne reste
consultative : ce dépôt transforme donc, ticket après ticket, les
promesses en **mécanismes** — ce que le logiciel refuse effectivement,
ce qu'il prouve, ce qu'il journalise.

## Ce qui est implémenté (au 27 septembre 2026)

- **Détection MTPLX et fenêtre réelle** : `context_length` lu depuis
  `/v1/models` (262 144 au lieu de 4 096 estimés), valeurs aberrantes
  rejetées, modèles compat marqués « servis » et sélectionnables.
- **Consignes à deux étages** : noyau global `~/.smolcoder/AGENTS.md`
  (dix commandements, opt-out `SMOL_NO_GLOBAL_AGENTS=1`) puis
  `AGENTS.md` du projet, blocs séparés avec **précédence de sécurité**
  explicite — validés par campagnes de banc (destructif, secret,
  injection).
- **Profil `--mission`** (opt-in, comportement par défaut inchangé) :
  un **contrat de mission approuvé par l'humain** avant toute
  écriture — stockage hôte hors du workspace
  (`~/.smolcoder/harness/…` : `contract.json`, `policy.json`,
  `proofs.jsonl` en ajout seul), approbation liée à l'empreinte du
  contrat, budget de pas, refus headless explicite. Détail :
  `docs/profil-mission.md` et `docs/decision-stockage-hote.md`.
- **Politique d'accès `allow / ask / deny`** évaluée avant chaque
  effet, sur quatre surfaces (commandes, tâches de fond, terminal web,
  vérifications automatiques), fail-closed, environnement minimal
  transmis aux sous-processus — les secrets de l'hôte n'atteignent
  plus les commandes.
- **Isolation OS sous `--mission` (macOS, Seatbelt)** : commandes,
  tâches de fond, terminal web et vérifications tournent dans un bac
  généré depuis la politique — lecture du système et du workspace,
  écriture du workspace et d'un dossier temporaire privé, réseau fermé
  sauf destinations et écoutes nommées ; backend absent, rien ne tourne ;
  état visible toute la session (ligne d'état, pastille web). Détail :
  `docs/decision-backend-isole.md`, `docs/allowlist-outils.md`, preuves
  `npm run test:os` et campagne archivée `docs/campagne-os-2026-09-27.md`.
- **Verdicts structurés et preuves protégées sous `--mission`** : chaque
  critère du contrat est `passed`, `failed`, `not_run` ou `error`, depuis
  le code de sortie réel, jamais depuis un récit du modèle ; zéro test,
  contrôle sauté, délai ou plantage ne passent jamais. Les tests, leur
  configuration et les scripts qui les exécutent sont figés à
  l'approbation : les modifier bloque l'acceptation jusqu'à une nouvelle
  approbation humaine. Chaque verdict porte les empreintes du contrat, du
  vérificateur et des fichiers vérifiés, périme à la première édition, et
  le rapport (`report.json`, `report.md`, hors du workspace) n'affiche
  jamais un vert périmé ; un run headless non vérifié sort 5. Détail :
  `docs/decision-preuves-acceptation.md`.
- **Retours d'outils exploitables** : un échec d'`edit_file` localise
  les occurrences ambiguës et la ligne où old_text décroche, avec le
  texte actuel ; un long journal de test ou de build garde sa cause
  décisive en tête, journal complet lisible par
  `read_file {"path": "log:<n>"}` ; un fichier modifié depuis sa lecture
  (personne, autre processus, tâche de fond) est signalé avant d'être
  réécrit. Mesure au banc à jouer :
  `docs/protocole-mesure-retours-outils.md`.
- **Plan d'implémentation approuvé avec le contrat (`--mission`)** :
  l'agent propose avant approbation un plan structuré (fichiers, ordre
  des travaux, risques, preuve attendue par critère), que l'humain
  approuve avec le contrat, dans le même geste (`/approve` ; en
  headless, `--propose-plan` puis `--approve-plan`) ; un critère sans
  preuve prévue est signalé. Après approbation, un fichier écrit hors
  plan ou une étape ajoutée ou retirée est journalisé, jamais bloqué, et
  le plan approuvé reste lisible à côté du plan courant (`/mission`,
  rapport). Facultatif par défaut, exigible par le contrat. Mesure au
  banc à jouer : `docs/protocole-mesure-plan-approuve.md`.
- **Banc comportemental reproductible** (`bench/noyau-agents-md/`) :
  un dossier horodaté et un manifeste par run, statuts
  machine-lisibles (succès ≠ refus de sécurité ≠ panne serveur),
  verrou de campagne, répétitions appariées.
- **Fiches de méthode** (`docs/skills/`) : diagnostic de bugs, TDD,
  revue à trois axes (standards, spécification, sécurité), vérification
  finale sans correction, conception de modules, conflits git — portées
  des skills de Matt Pocock, complétées par le guide Anthropic, chargées
  à la demande par l'agent. Sur tout autre projet après
  `smol --install-fiches` : copie dans `~/.smolcoder/fiches/`, index court
  dans le prompt, lecture seule par `read_file {"path": "fiche:tdd"}`,
  chaque lecture tracée au journal sous `--mission`. Détail :
  `docs/decision-fiches-hote.md`.
- **Lanceur macOS** (`launch-smol-mtplx.command`) : interface web par
  défaut avec URL fraîche, session terminal, test de contrôle.

**Chantiers restants**, dans l'ordre : la mesure au banc des
[retours d'outils exploitables](https://github.com/Alexmacapple/smolcoder-MTPLX/issues/19)
(#19, livrés, protocole prêt) et du [plan d'implémentation approuvé avec le contrat](https://github.com/Alexmacapple/smolcoder-MTPLX/issues/29)
(#29, livré, protocole prêt), puis [reprise durable](https://github.com/Alexmacapple/smolcoder-MTPLX/issues/10)
(#10). À part, en attente de décision :
[l'étude AH-00](https://github.com/Alexmacapple/smolcoder-MTPLX/issues/33)
(une leçon de fiche améliore-t-elle Qwen ?), porte d'entrée du
[chantier d'apprentissage](https://github.com/Alexmacapple/smolcoder-MTPLX/issues/34)
(#34). Chaque livraison passe par une pull request, des tests
rouge/vert et une entrée dans `CHANGELOG-MTPLX.md`.

## Installer et lancer

```bash
npm install -g git+https://github.com/Alexmacapple/smolcoder-MTPLX.git
```

Déclarer le host MTPLX dans `~/.smolcoder.json` :

```json
{
  "hosts": [
    { "address": "http://127.0.0.1:8000", "name": "mtplx" }
  ]
}
```

Puis `smol` depuis un dossier de projet — ou, sous contrat :
`smol --mission <contrat.json>` (l'écriture attend l'approbation
humaine). Ce fork est la version de référence pour MTPLX : installer
ce dépôt, pas le paquet amont.

## Sources de vérité

Le journal complet est `CHANGELOG-MTPLX.md` (chaque changement, sa
preuve, son commit). Les décisions d'architecture vivent dans `docs/`,
le dossier du lot harnais dans `smolcoder-harnais-6-issues*.md`.

<details>
<summary><strong>Historique — le fork d'origine (26 septembre 2026)</strong></summary>

> **Crédit original** : ce projet est [smolcoder](https://github.com/leonvanzyl/smolcoder)
> de Leon van Zyl, licence MIT. Tout le contenu ci-dessous est le sien ;
> ce préambule et un seul patch local s'y ajoutent.

Cette branche `main` est un fork fait le 26 septembre 2026 pour faire
tourner smolcoder avec **Qwen 3.8 27B** (variante
`Qwen3.8-27B-MTPLX-Optimized-Speed-FP16`) servi localement par
**MTPLX** sur un Mac Studio M1 Ultra, sans aucun réglage supplémentaire.

**Pourquoi ce fork.** MTPLX sert une API compatible OpenAI sur
`http://127.0.0.1:8000/v1`. Smolcoder ne détecte nativement que
Ollama (port 11434) et LM Studio (port 1234) : un serveur sur le port
8000 ne serait jamais trouvé. Le déclarer comme host dans
`~/.smolcoder.json` suffit pour le raccordement :

```json
{
  "hosts": [
    { "address": "http://127.0.0.1:8000", "name": "mtplx" }
  ]
}
```

Smolcoder interroge `/api/tags`, `/api/v1/models` puis `/v1/models` ;
la réponse OpenAI-compat de MTPLX passe par la branche fallback
« older LM Studio » (backend `lmstudio`), qui appelle
`/v1/chat/completions` en streaming SSE — exactement ce que MTPLX
sert. Aucun adaptateur nouveau n'est nécessaire.

**Ce que ce fork a modifié** (un seul fichier, deux lignes, commit
`0fbdc40`, `src/detect.ts`) : la branche fallback imposait une fenêtre
de contexte de 4 096 tokens à tout serveur non identifié, alors que
MTPLX rapporte `context_length: 262144` dans `/v1/models`. Le patch
lit ce champ quand il est présent et positif ; l'estimation 4 096 ne
s'applique plus qu'en son absence. Résultat mesuré : la session
affiche `ctx 262,144` (usage réel 1 361 tokens après un message,
réserve de réponse 8 192), contre 4 096 avant.

**Installer cette version** :

```bash
npm install -g git+https://github.com/Alexmacapple/smolcoder-MTPLX.git
```

Puis écrire `~/.smolcoder.json` (ci-dessus) et lancer `smol` depuis un
dossier de projet. Ce fork est la version de référence pour MTPLX :
installer ce dépôt, pas le paquet amont.

---

</details>

<details>
<summary><strong>README amont — smolcoder, par Leon van Zyl (anglais)</strong></summary>

# smolcoder

A smol coding agent for the models already running on your machine.

If you have Ollama or LM Studio running, you are two commands away from a coding assistant that reads your code, edits files, runs your tests and starts your dev server. No API key and no config file. Nothing leaves your machine except requests to the model server you chose.

```bash
npm install -g smolcoder
smol
```

## Setup

You need two things.

1. **Node.js 18 or newer** from [nodejs.org](https://nodejs.org).
2. **A local model server.** Either [Ollama](https://ollama.com) with a tool-capable model pulled (`ollama pull qwen3` is a good start), or [LM Studio](https://lmstudio.ai) with a model loaded and its local server running (Developer tab, then Start Server).

Then install smolcoder and start it inside a project:

```bash
npm install -g smolcoder
cd your-project
smol
```

`npx smolcoder` works too if you would rather not install anything globally.

smolcoder finds your server, lists the models you already have, and opens a chat. It remembers the model and permission mode you used last time.

Both servers are found the same way, with nothing to set up: on their usual ports, on a port you changed (LM Studio's is read from its own settings, Ollama's from `OLLAMA_HOST`), inside Docker or Podman containers that publish the port, and on the host machine when smolcoder itself runs in WSL or a container.

If your models run on a different computer, see [Using models on another machine](#using-models-on-another-machine).

## Using it

Type what you want done and press enter. The agent reads files, edits them and runs commands inside your project folder, and says what it is doing as it goes. After it edits files it runs your project's build and test scripts and repairs what fails.

| Key | What it does |
|---|---|
| `/` | Opens the command menu |
| `shift+tab` | Cycles the permission mode: read-only, edit, bypass |
| `esc` | Cancels the running turn, or clears the input |
| `ctrl+c` twice | Quits |

The line under the input shows the mode, the model, the reasoning effort, how full the context window is, and any background tasks.

### Commands

| Command | What it does |
|---|---|
| `/models` | Switch model, or add models from other machines |
| `/mode` | Set the permission mode (`ro`, `edit`, `bypass`) |
| `/effort` | Set reasoning effort (`off`, `low`, `medium`, `high`, `default`) |
| `/plan` | Show the agent's checklist |
| `/context` | Show context window usage |
| `/compact` | Compact the conversation now |
| `/tasks`, `/logs <id>`, `/stop <id>` | Inspect and stop background tasks such as dev servers |
| `/clear` | Start a fresh conversation |
| `/help`, `/exit` | Help and quit |

### Permission modes

| Mode | Files | Commands |
|---|---|---|
| `ro` | read and search only | none |
| `edit` (default) | read, write, edit | run freely inside the project folder; anything reaching outside it asks you first |
| `bypass` | read, write, edit | never asks |

File access stops at the project folder. In edit mode, a command that reaches outside it (another folder, your home directory, a global install) asks for approval first and says why. This is a text check on the command, not an operating-system sandbox, so use read-only mode on code you do not trust.

### Options

```bash
smol                            # current folder
smol path/to/project            # a specific project
smol --model qwen3              # pick a model by partial name
smol --effort off               # no thinking: fastest for long tool loops
smol --mode bypass              # never ask for approval
smol --ctx 16384                # cap the context window
smol --web                      # browser UI (see below)
smol -p "fix the failing test"  # headless: run one prompt, print the transcript, exit
smol -p "build the app" --verify "npm test"   # headless with an acceptance command
```

With `--verify`, the command has to pass before the run counts as done. Failures go back to the agent to repair, six attempts by default. `--verify-attempts 12` allows more.

## Using models on another machine

The models do not have to run on the computer you code on. A desktop with a big GPU can serve a laptop, and you can add as many machines as you have. Everything below happens inside smolcoder. There is no file to edit and no command to run.

### 1. Let the other machine accept connections

Ollama and LM Studio only answer their own computer until you tell them otherwise. Do this once, on the machine that runs the models.

| Server | What to turn on |
|---|---|
| Ollama (Windows, macOS) | Settings → **Expose Ollama to the network** |
| Ollama (Linux, headless) | Set `OLLAMA_HOST=0.0.0.0` for the service and restart it |
| LM Studio | Developer → Local Server → **Serve on Local Network** |

On Windows the firewall asks the first time the server listens on the network. Allow it for Private networks.

### 2. Find it from smolcoder

Open the model picker: type `/models` in the terminal, or click the model name in the web UI. Choose **Find models on another machine**.

- **Search my network** shows the range it is about to search, for example `192.168.1.0/24`, then looks for Ollama and LM Studio on it. This takes a few seconds. Every machine it finds is listed with what it runs, such as `gpu-box (192.168.1.50) · Ollama · 12 models`. Pick one and its models join your list. Pick again to add more.
- **Enter an address** is for machines a search cannot reach: a VPN or Tailscale address, another subnet, or a server on the internet. Type an IP (`192.168.1.50`), a name (`gpu-box.local`), a host and port (`gpu-box:4321`) or a URL (`https://llm.example.com`). For a bare IP or name, smolcoder tries both servers' usual ports and works out which one is there.

If no server is running on your own computer, smolcoder offers to find one on another machine at startup instead of exiting.

### 3. Use it like any other model

Models from other machines appear in the picker with the machine's name next to them, below the ones on your own computer. The status line shows where the current model runs, for example `qwen3:32b ollama @ gpu-box`.

- Added machines are remembered and checked every time smolcoder starts. One that is switched off is skipped, and its models come back when it does.
- The model you used last is remembered together with its machine, so the same model name on two machines is never confused.
- In the web UI, sessions on different machines run at the same time. Sessions on the same machine take turns.
- **Network hosts** in the model picker renames or removes a machine. If one stops answering because your router gave it a new address, **Look for it again** finds it and keeps its name.
- Headless runs (`smol -p`) use the machines you already added. They never search the network.

### Before you add a machine

smolcoder sends your code and prompts to the server you choose, and runs the tool calls that come back. A machine found by a search is never used until you pick it, so only pick machines you trust. For an address outside your own network over plain `http://`, smolcoder warns that the traffic is unencrypted and asks again before adding it.

### If nothing is found

- The server on the other machine is not accepting connections yet. Check step 1, and that the machine is awake.
- On macOS, allow your terminal app under System Settings → Privacy & Security → Local Network. Without that, nothing on the network is visible and no error is shown.
- The search covers the private network your computer is on. On a very large network it searches the 254 addresses around your own. Use **Enter an address** for anything further away.
- A server that needs an API key or login in front of it is not supported yet.

## The web UI

`smol --web` opens a browser UI and prints a private link. The server only listens on your machine, and the link carries a random key.

- **Workspaces and sessions.** The sidebar lists your project folders, each with its own sessions. Run several at once and switch between them while they work.
- **Sessions survive restarts.** Past sessions stay in the sidebar and resume with a click. Transcripts live under `~/.smolcoder/sessions/`. A resumed session keeps the `AGENTS.md` version it was using and says what changed while it was stored ([how it works](docs/how-it-works.md#local-apis-and-failure-recovery)).
- **Paste screenshots and files.** Paste an image with `ctrl+v` or right-click and choose Paste, drop files onto the chat, or click the paperclip. Images go to the model when it can see them, and the chip warns you when it cannot. Text files are added to your message.
- **Browser and terminal panels.** Preview the dev server the agent started, or open a shell in the workspace, next to the chat.
- **One server for everything.** Running `smol --web` in another folder adds it to the UI that is already open.

## Why it works well with local models

Local models are free and private, but they give you less to work with. The context window is small, generation is slower, and long instructions get lost. smolcoder is built around those limits.

- **It stays out of the model's way.** A short system prompt and eight simple tools (four in read-only mode) leave most of the window for your code.
- **It watches the real window.** It asks the server how much context is actually loaded, shows a meter, and keeps room for the reply. A model that advertises a 128k window is often loaded with 4k, and smolcoder budgets for the 4k.
- **It tidies up before the window fills.** Old file reads and command output go first. Only then does it ask the model for a short handover. Your request and the checklist are never summarized away.
- **It keeps the plan outside the conversation.** The to-do list and the notes for the current step live in smolcoder itself, so they survive any summary.
- **It uses the waiting time.** While a long command runs, the same model can prepare that handover in the background. Coding always comes first.
- **It recovers from hiccups.** A stalled stream, a cut-off reply or a tool call that keeps failing gets retried or stopped with a clear message.

The full mechanics are in [docs/how-it-works.md](docs/how-it-works.md): the context budget, compaction, planning, checks, and how this compares with other agents.

## Tips

- **Give it a memory.** Put your conventions and commands in an `AGENTS.md` file at the project root. It is loaded every session and survives compaction.
- **Turn thinking off for long jobs.** `/effort off` leaves more of each reply for tool calls and code.
- **Let it run things in the background.** Dev servers and watchers run as background tasks. Check them with `/tasks` and `/logs`, stop them with `/stop`.
- **Backend notes.** Benchmarks and Ollama versus LM Studio tuning are in [docs/backend-notes.md](docs/backend-notes.md).

## Contributing

Issues and pull requests are welcome at [github.com/leonvanzyl/smolcoder](https://github.com/leonvanzyl/smolcoder). Clone it, run `npm install`, then `npm test`.

## License

[MIT](LICENSE)

</details>
