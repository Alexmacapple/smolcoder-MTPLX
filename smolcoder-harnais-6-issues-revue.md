# Revue des six issues harnais — lecture seule, Qwen 3.8 via MTPLX

**Référence de lecture : HEAD `da42044`** (= `b1365e0` + commit « Lot correctif de la revue
des tickets », qui ne touche que `src/index.ts`, `src/prompt.ts`, le lanceur et le banc).
Les fichiers cités par les issues sont donc dans l'état vérifié ci-dessous. Toute citation
est `fichier:ligne` lue dans ce HEAD ; si une autre revue a lu une autre référence, les
numéros de ligne peuvent différer sans que le fond change.

Méthode : lecture complète de `smolcoder-harnais-6-issues.md` (306 lignes), puis croisement
dans `src/` (agent, tools/index, tools/shell, tools/tasks, sandbox, events, plan,
verification, session, web/store, prompt, index), `docs/how-it-works.md`,
`bench/noyau-agents-md/banc.sh`, `test/`, `scripts/test.cjs` et l'historique git.
Aucune modification, aucun build, aucun test lancé.

## Verdicts en un coup d'œil

| Issue | Sujet | Verdict |
|---|---|---|
| H01 (#8) | Contrat de mission, validation du plan avant écriture | **À amender** |
| H02 (#11) | Politique d'accès avant chaque outil | **À amender** |
| H03 (#12) | Exécution locale isolée | **Valide** |
| H04 (#9) | Verdicts structurés, preuves protégées | **Valide** |
| H05 (#10) | Reprise durable, modifications concurrentes | **À amender** |
| H06 (#13) | Banc de régression Qwen–MTPLX | **Valide** |

## H01 — verdict : À amender

1. **L'existant est fidèlement décrit.** `src/agent.ts:62` porte l'état d'exécution
   (`outcome: "idle" | "running" | "completed" | "cancelled" | "error"`), `:64` le résultat
   de vérification, `:84` la règle « fournie par l'appelant, jamais modifiée par un outil du
   modèle » ; `src/tools/index.ts:16` définit bien `Mode = "ro" | "edit" | "bypass"` avec
   l'outil `plan` incrémental. Rien à corriger.
2. **Critères testables, sauf deux.** Quatre critères sur cinq le sont tels quels : le
   fournisseur scripté existe déjà (`test/agent.test.js:26`) et le headless a déjà une
   sortie non nulle en cas d'échec (`src/index.ts:260`). Flous : (a) le *mécanisme*
   d'approbation — « interface humaine ou autorisation explicite de l'appelant headless »
   sans support défini (flag CLI ? fichier JSON ? prompt interactif ?) ; (b) « les
   garanties renforcées sont un profil explicite » — pas de nom de flag ni de mode, donc le
   dernier critère n'est testable qu'après cette décision d'interface.
3. **Manque : le contrat n'a pas de maison.** Le « budget » du contrat n'existe nulle part :
   `maxSteps` est un argument de constructeur par interface (1000 en session,
   `src/session.ts:358` ; 30 par défaut headless, `src/agent.ts`). « Un élargissement du
   budget impose une nouvelle autorisation » n'a pas de support. Ambiguïté pour un agent
   sous le harnais : tant que `intent.md` « reste optionnel » dans le workspace, rien ne
   dit si un fichier du projet peut être la source d'un contrat — or l'issue exige que « ni
   un texte de Qwen ni un fichier du projet ne valent approbation ».

## H02 — verdict : À amender

1. **L'existant est fidèlement décrit.** `src/sandbox.ts:36` (résolution de chemins,
   hardening symlink par realpath de l'ancêtre existant le plus profond), `:145`
   (`commandEscapesWorkspace`, balayage textuel), `:79` (« false negatives are the accepted
   limit of a text scan ») ; `src/events.ts:3-6` est un bus interne « not user-configurable
   in v1 by design » — les « hooks d'un dépôt non approuvé » n'existent donc tout simplement
   pas : la garantie est trivialement vraie, mais le critère ne dit pas à quoi ils seraient
   branchés s'ils venaient.
2. **Un critère désigne un vrai trou du code actuel ; les autres sont flous.** «
   `run_command`, `task.start` et les contrôles automatiques suivent la même décision » est
   exact et testable : la passerelle n'existe que dans `gateAndExecute`
   (`src/agent.ts:659`), tandis que `checkProgress` (`src/agent.ts:159`) et `verify`
   (`src/agent.ts:200`) appellent `runCommand` sans aucune passe. Flous : « traces
   accessibles au modèle » (quelles surfaces : stdout ? `~/.smolcoder/sessions/*` ?
   transcript ?) et « version de politique » (hash ? numéro ?).
3. **Ambiguïté que le harnais ne peut pas lever : bypass.** `bypass` est un mode courant
   (`src/tools/index.ts:16`, commutable par `/mode` via `onModeCycle` dans
   `src/session.ts`). L'interdit « le profil renforcé ne peut pas être discrètement changé
   en `bypass` » ne dit pas si `bypass` reste *autorisé* dans le profil renforcé ; et
   « politique appartenant à l'appelant de confiance » sans lieu de stockage (argument
   CLI ? fichier ?) rend le critère « modification de politique par le workspace refusée »
   in-testable — il faut nommer le chemin à protéger.

## H03 — verdict : Valide

1. **L'existant observé est exact.** `src/tools/shell.ts:95` (`env: process.env`), `:96`
   (groupe de processus `detached` pour `killTree`), `:75` (délai 120 s) ;
   `src/tools/tasks.ts:33` même `env: process.env` ; `src/sandbox.ts:79` admet la limite du
   balayage textuel. Le ciblage (interface étroite d'exécution partagée par `run_command`,
   `task`, contrôles automatiques et vérification) correspond au code.
2. **Critères réalistes et testables, avec une condition d'intégration.** « Tests OS sur
   macOS obligatoires ; les mocks seuls ne suffisent pas » est testable (Seatbelt
   `sandbox-exec` est natif sur macOS, zéro dépendance — l'« évaluer un runtime existant
   avant d'en écrire un » a une réponse évidente), mais la suite tourne sur `node --test`
   des `test/*.test.js` (`scripts/test.cjs`) : aucune place n'est prévue pour un test OS
   lourd → le lieu de ces tests doit être décidé, sinon le critère est injouable en
   `npm test`.
3. **Le point dur : le positif peut contredire le négatif.** « Un `npm test` de fixture et
   un serveur de développement autorisé fonctionnent » exigent l'accès au binaire node, au
   cache `~/.npm` et au registre — or « protéger le HOME réel » les interdit s'ils ne sont
   pas modélisés explicitement dans la politique. Pour un agent sous le harnais, c'est la
   règle qu'il ne peut pas respecter sans une allow-list de chemins npm documentée dans le
   ticket. Le reste (réseau enfant refusé par défaut, pas de repli automatique en shell non
   isolé, indication d'isolation dans l'UI) est cohérent et testable.

## H04 — verdict : Valide

1. **L'existant est exact — et l'issue sous-déclare la faille.** Le verdict
   d'acceptation est aujourd'hui un *regex appliqué à une chaîne* : `src/agent.ts:200`
   (`/\[exit code 0 in [^\]]+\]\s*$/.test(output)`), appliqué au texte renvoyé par
   `src/tools/shell.ts:155` qui mêle logs et statut — c'est exactement le « le rendu texte
   devient une projection, la décision ne dépend pas d'un message libre » de l'incrément.
   `Verification` détenue par l'appelant (`src/agent.ts:22-26`), compteur d'essais
   (`src/agent.ts:194-195`), découverte `build`/`test`/`test:e2e`
   (`src/verification.ts:19`) : tout est confirmé.
2. **Cinq critères sur six testables ici.** Testables : « terminé » annoncé mais un critère
   échoue → état non vérifié + sortie non nulle ; « exit code 0 » imprimé ne remplace pas
   le code réel ; invalidation des preuves après édition ; conservation du budget
   (`src/agent.ts:195`). *Non testable dans ce dépôt seul* : « modifier le test, sa
   configuration ou le remplacer par un succès trivial ne permet pas une acceptation » — la
   protection contre l'altération exige H02/H03 (l'issue le reconnaît) ; il faut l'expliciter
   comme critère *conditionnel* pour ne pas le croire acquis.
3. **Deux définitions manquent.** « Version des vérificateurs » : le vérificateur est
   découvert par chemin (`src/verification.ts:11`) et n'a aucune identité — hash des
   scripts ? champ `scripts` de `package.json` ? Et `report.json` : dans le workspace
   (donc modifiable par Qwen — or l'issue veut protéger les preuves) ou dans le stockage
   hôte ? Tant que ce n'est pas tranché, « la présentation n'affiche pas un vert périmé »
   n'a pas de surface de preuve définie.

## H05 — verdict : À amender

1. **L'existant est exact et même dépassé par l'issue.** Le message d'incertitude est bien
   là : `src/agent.ts:132` (« Tool execution was interrupted by a restart. Its outcome is
   unknown. Inspect files or command state before retrying… ») ; `docs/how-it-works.md:148`
   dit bien que la session web sauvegarde le plan et que le terminal le garde pour la
   session en cours. Mais le `SessionSnapshot` (`src/session.ts:282-295`) persiste déjà
   `plan`, `filesTouched`, `commandsRun`, `mode`, `effort`, `model`, `backend`, `baseUrl` —
   l'incrément est plus petit que le ticket ne le laisse croire ; et « les approbations ne
   sont pas restaurées » (`src/session.ts:463`, `alwaysAllowed` en mémoire,
   `src/agent.ts:54`) est un fait à inscrire au dossier.
2. **Deux critères sont testables seulement recadrés.** « Les budgets ne repartent pas de
   zéro au redémarrage » suppose un budget *persistant* qui n'existe pas (le compteur
   `steps` est local au tour dans `runTurn`, `src/agent.ts`) : c'est une fonctionnalité
   H01/H05 à nommer comme telle. « Réconcilier avec l'état des processus » est impossible
   pour les tâches de fond : `TaskManager` est en mémoire et « All tasks are killed when
   smolcoder exits » (`src/tools/tasks.ts:5`) → le critère doit se limiter aux fichiers et
   au diff Git.
3. **Un critère est actuellement irréalisable : la dérive d'`AGENTS.md`.** « Conserver la
   version de session, signaler les écarts » est in-testable : le snapshot ne porte aucune
   identité du fichier (ni hash ni mtime, `src/session.ts:282-295`) et le chargement se
   fait dans le constructeur (`src/session.ts:351`) — sans champ ajouté au snapshot,
   personne ne peut comparer « version chargée » et « version sur disque ». Manque aussi le
   choix du verrou (fichier ? pid ?) pour « deux sessions ne peuvent pas écrire dans le
   même workspace ».

## H06 — verdict : Valide

1. **Le banc décrit est le banc réel, ligne pour ligne.** Cinq scénarios
   (`bench/noyau-agents-md/banc.sh:12`), distinction réponse/terminal (`:111-112`),
   workspace jetable hors du dépôt (`:35`), HOME réel conservé avec
   `SMOL_NO_GLOBAL_AGENTS` comme opt-out (`:83-90`, décisions #6/#7), attente de la file
   MTPLX (`:95`, 120 × 5 s sur `active_requests`), constats comparés à la référence Git
   commitée (`:127-129`) — et `resultats/` est déjà commité, si bien que « baseline
   conservée » a une case.
2. **Les critères sont testables sauf deux flous.** Testables : régression injectée
   détectée par les tests sans modèle ; résultats distincts (déjà partiellement : rc 2/3
   distincts du rc de l'exécution) ; paramètres non appliqués signalés, pas présentés
   comme appliqués. Flous : « répétitions appariées » sans donner `n` ni la statistique de
   comparaison ; et « un refus du modèle et un blocage effectif du harnais sont mesurés
   séparément » — aucun support d'aujourd'hui ne distingue les deux (seuls
   `sortie.txt`/`erreurs.txt` existent) : il faut nommer la surface (log d'outils ?
   trace JSON ?).
3. **Manque : l'exclusivité MTPLX pendant la campagne.** Le banc ne verrouille rien — il
   *sonde* `active_requests == 0` avant de démarrer (`:93-98`) : un autre consommateur peut
   lancer une requête en cours de run et biaiser la mesure ; « une inférence active par
   serveur » (proposition de profil) exige un verrou réel ou une vérification en continu.
   Le trigger de campagne « déclenchée explicitement sur le Mac » n'a ni commande ni
   propriétaire nommés.

## Synthèse

1. **Ordre recommandé : H06 (baseline) → H01 → H02 → H03 → H04 → H05**, soit l'ordre du
   lot — mais extraire l'item 1 de H04 (résultat typé de l'exécuteur) dès après H01 : c'est
   la brèche du regex sur texte (`src/agent.ts:200`) la moins chère à fermer, et H02/H03
   s'y appuieront.
2. **Risque le plus gros : H03** promet des critères positifs (`npm test`, serveur de
   dev) que sa propre négation (protéger HOME, réseau fermé) tue sans allow-list
   documentée de l'empreinte npm — sous-estimé, ce ticket devient soit un échec de ses
   propres tests, soit une politique érodée.
3. **Second gros risque** : H01 (approbation), H02 (politique) et H05 (verrou, identité
   `AGENTS.md`) inventent chacun un état hôte sans en nommer le stockage — décidés ticket
   par ticket, ils ne composeront pas entre reprise, web et migration ; une unique
   décision d'architecture du stockage hôte doit précéder H01.
4. Les trois « À amender » (H01, H02, H05) ne demandent que des précisions d'interface
   (mécanisme d'approbation, lieu de la politique, champ d'identité dans le snapshot) —
   leurs garanties de fond sont exactes et compatibles avec le code lu.
5. **Garde-fou transversal** : aucun des six tickets ne peut déclarer « isolé »,
   « protégé » ou « repris » tant que la suite ne tourne pas — `npm test` est la seule
   preuve, et chaque lot doit laisser `CHANGELOG-MTPLX.md` à jour dans le même commit,
   conformément au cadre commun des issues.

## Points de divergence probables pour la consolidation

Pour croiser avec une autre revue (ex. Codex), les points où deux lecteurs honnêtes peuvent
légitimement différer :

- **H01** : « à amender » (mécanisme d'approbation et profil non spécifiés) ou « valide »
  (garanties testables, interfaces à trancher en implémentation).
- **H02** : l'absence de hooks configurables (`src/events.ts:3-6`) rend-elle le critère des
  hooks trivialement acquis, ou doit-il nommer un futur point de branchement ?
- **H03** : « valide » ou « à amender » selon qu'on exige l'allow-list npm dans le ticket ou
  qu'on la laisse à la décision d'architecture qu'il demande.
- **H04** : le critère d'anti-altération est-il un critère de H04 ou une dépendance H02/H03
  (l'issue le dit elle-même ; le risque est de le compter comme acquis).
- **H05** : le fait que `SessionSnapshot` persiste déjà plus que le ticket ne le cite
  (`src/session.ts:282-295`) réduit-il l'incrément au point d'abaisser la priorité ?
- **H06** : le sondage `active_requests` (`banc.sh:93-98)` suffit-il pour l'exclusivité de
  campagne, ou faut-il un verrou ?