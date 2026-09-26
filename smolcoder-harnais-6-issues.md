# smolcoder-MTPLX — Six issues pour renforcer le harnais local

**Statut : publiées puis consolidées le 2026-09-26.** Correspondance : H01 = #8, H02 = #11, H03 = #12 (chapeau, découpé en #15 à #18), H04 = #9, H05 = #10, H06 = #13 ; ticket préalable ajouté : #14 (décision d'architecture du stockage hôte). Les corps GitHub portent les amendements issus des deux revues croisées (Codex : commentaires sur les tickets ; Qwen : `smolcoder-harnais-6-issues-revue.md`) ; le croisement et ses arbitrages : `smolcoder-harnais-6-issues-consolidation.md`. Ordre de réalisation : #13 minimal → #14 → #8 → #11 → #15..#18 → #9 → #10. Labels : `harnais` + `P1` + `enhancement` partout, `securite` sur #11/#12/#15..#18, `banc` sur #13.

## Ordre proposé

Commencer par la baseline H06, puis H01 → H02 → H03. Développer les verdicts H04 dès que le contrat est stabilisé, mais ne pas déclarer leur intégrité protégée avant H02/H03. Ajouter H05 pour la reprise. Enrichir H06 à chaque livraison. Ces sujets touchent les mêmes points de la boucle : ne pas lancer six agents concurrents sur les mêmes fichiers.

## Ce que ce lot ne fait pas

Il ne réécrit pas smolcoder, ne modifie pas les commits en cours et n'ajoute pas un orchestrateur multi-agent. Les tests actuels et les décisions #1–#7 sont préservés. Les six titres désignent des extensions ciblées, pas une affirmation que le dépôt serait dépourvu de harnais.

| Identifiant | Sujet | Dépendances principales |
|---|---|---|
| H01 | Contrat de mission et validation du plan avant écriture | Aucune |
| H02 | Politique d’accès imposée avant chaque outil | H01 |
| H03 | Exécution locale isolée sans contournement implicite | H02 |
| H04 | Verdicts structurés et preuves d’acceptation protégées | H01, H02, H03 |
| H05 | Reprise durable et détection des modifications concurrentes | H01, H02, H04 |
| H06 | Banc de régression Qwen–MTPLX et profil mesuré | Aucune |

---

# H01 — Harnais — Contrat de mission et validation du plan avant écriture

<!-- smolcoder-harness:H01:v1 -->

**Identifiant de chantier : H01. Priorité proposée : P1 — socle fonctionnel.**

## Objectif

Une tâche possède un objectif, un périmètre et une condition de réussite approuvés, sans imposer trois documents à chaque petite correction.

## Existant à conserver

[`src/agent.ts`](https://github.com/Alexmacapple/smolcoder-MTPLX/blob/b1365e055c0f2f344e9b01278497b13ea450e97a/src/agent.ts) conserve déjà les demandes, les états d'exécution et une vérification fournie par l'appelant. [`src/tools/index.ts`](https://github.com/Alexmacapple/smolcoder-MTPLX/blob/b1365e055c0f2f344e9b01278497b13ea450e97a/src/tools/index.ts) expose un plan incrémental et les modes `ro`, `edit`, `bypass`. Il s'agit de formaliser leur contrat, pas de réécrire l'agent.

## Incrément proposé

1. Ajouter un contrat validé par le logiciel : identifiant, objectif, hors-périmètre, workspace, révision de base, référence de politique, critères d'acceptation et budgets. Distinguer ce contrat approuvé de la checklist modifiable par Qwen.
2. Proposer un parcours « préparer → approuver → exécuter ». Avant approbation, Qwen lit et prépare son plan mais ne modifie pas le projet. Le harnais peut enregistrer ce brouillon dans son propre stockage.
3. Enregistrer l'approbation par l'interface humaine ou une autorisation explicite de l'appelant headless, liée à la version du contrat. Ni un texte de Qwen ni un fichier du projet ne valent approbation.
4. L'agent réorganise librement les étapes dans le périmètre. Un élargissement de permissions, du budget ou de l'acceptation impose une nouvelle autorisation.
5. Produire une vue Markdown depuis la même source d'état. Une fiche courte suffit pour un correctif ; `intent.md`, `spec.md` et `plan.md` séparés restent optionnels.

## Critères d'acceptation

- [ ] Un appel d'écriture avant approbation est bloqué, y compris si Qwen prétend que le plan est approuvé.
- [ ] Modifier le contrat invalide l'autorisation précédente ; modifier seulement la checklist n'accorde aucun droit supplémentaire.
- [ ] La compaction conserve le contrat et ses limites indépendamment du résumé du modèle.
- [ ] Sans approbation en headless : état explicite et sortie non nulle, pas d'attente interactive infinie.
- [ ] Parcours terminal, web et headless testés avec fournisseur simulé ; le parcours conversationnel courant reste disponible, les garanties renforcées sont un profil explicite.

## Dépendances et limites

Développable en premier ; brancher ensuite les contrôles effectifs H02/H03 et les preuves H04. La persistance/reprise robuste relève de H05. L'approbation ne constitue pas une isolation de sécurité. Hors périmètre : orchestrateur, scheduler, commit ou PR automatique.

## Source de conception

[Guide Anthropic](https://claude.com/blog/the-ai-native-sdlc-playbook) : distinguer besoin, réponse retenue et plan d'implémentation, avec un jugement humain aux points de décision.

## Cadre commun

Référence de lecture : [`b1365e0`](https://github.com/Alexmacapple/smolcoder-MTPLX/tree/b1365e055c0f2f344e9b01278497b13ea450e97a), le 26 septembre 2026. Le dépôt est en cours de modification : **relire le HEAD, les branches et les travaux en cours avant de coder**, puis réduire ou fermer le ticket si sa garantie est déjà couverte. Les constats ci-dessous viennent d'une lecture ciblée, pas d'une exécution indépendante des tests.

Renforcer la boucle existante, sans deuxième harnais, changement silencieux du comportement courant ni dépendance à un modèle cloud. Les décisions des tickets #1 à #7 restent acquises : ne pas rouvrir le lanceur, les libellés MTPLX, la précédence des consignes ou l'opt-out global. Toute implémentation doit conserver les tests existants et ajouter son entrée à `CHANGELOG-MTPLX.md` dans le même commit ; ne pas éditer `dist/`.


---

# H02 — Harnais — Politique d’accès imposée avant chaque outil

<!-- smolcoder-harness:H02:v1 -->

**Identifiant de chantier : H02. Priorité proposée : P1 — contrôle des capacités.**

## Objectif

Passer de « Qwen doit respecter les consignes » à « le logiciel refuse effectivement une action non autorisée », avec une décision explicable avant l'effet.

## Existant à conserver

[`src/sandbox.ts`](https://github.com/Alexmacapple/smolcoder-MTPLX/blob/b1365e055c0f2f344e9b01278497b13ea450e97a/src/sandbox.ts) contient déjà la résolution des chemins et un contrôle textuel des commandes. [`src/tools/index.ts`](https://github.com/Alexmacapple/smolcoder-MTPLX/blob/b1365e055c0f2f344e9b01278497b13ea450e97a/src/tools/index.ts) centralise les outils ; [`src/events.ts`](https://github.com/Alexmacapple/smolcoder-MTPLX/blob/b1365e055c0f2f344e9b01278497b13ea450e97a/src/events.ts) fournit un bus interne. La précédence de prompt traitée en #6 reste une mitigation, pas cette barrière d'exécution.

## Incrément proposé

1. Ajouter une politique appartenant à l'appelant de confiance, évaluée avant chaque action et non modifiable par un outil du modèle. Les fichiers du workspace ne peuvent pas élargir les droits. Un hook proposé par un dépôt non approuvé n'est jamais exécuté comme du code de confiance.
2. Décision uniforme `allow / ask / deny` avec motif, action, chemins canoniques et version de politique. En headless, `ask` devient une suspension explicite, jamais une autorisation par défaut.
3. Couvrir lecture, recherche, pièces jointes et modification, pas seulement `edit_file`. Prévoir les secrets, les preuves d'acceptation, la configuration de confiance et les métadonnées Git ; `.env.example` doit pouvoir rester accessible selon la politique.
4. Contrôler l'exécution au dernier point avant l'effet, pas seulement la présence de l'outil dans le prompt. Conserver la validation des liens symboliques et traiter les chemins ambigus sans ouvrir les droits.
5. Tant que H03 n'est pas disponible, le profil renforcé ne permet pas de shell arbitraire, de tâche persistante ni d'exécution automatique de scripts du projet. Une liste de noms comme `npm` ou `python` n'est pas une isolation.

## Critères d'acceptation

- [ ] Un fournisseur simulé demande un outil masqué ou un chemin interdit : aucune lecture/écriture effective n'a lieu.
- [ ] Un faux secret reste absent de la réponse, des résultats d'outils, de stdout/stderr et des traces accessibles au modèle.
- [ ] Traversée de chemin, lien symbolique hors périmètre et modification de politique par le workspace sont refusés.
- [ ] Une erreur du contrôleur bloque l'action ; elle ne retombe pas sur l'autorisation.
- [ ] `run_command`, `task.start` et les contrôles automatiques suivent la même décision ; aucun chemin secondaire d'exécution n'est oublié.
- [ ] Le profil renforcé ne peut pas être discrètement changé en `bypass`. Quitter ce profil exige une décision humaine explicite et visible.

## Dépendances et limites

S'appuie sur H01 pour les autorisations et prépare H03. Les refus précoces ne constituent pas une sandbox OS ; tests de contournement par processus dans H03. Pas de marketplace de hooks ni de nouveau langage de politique généraliste en V1.

## Source de conception

[Guide Anthropic](https://claude.com/blog/the-ai-native-sdlc-playbook) : séparer instructions consultatives et mécanismes déterministes. Une politique est testée sur ses effets, pas seulement sur le libellé du prompt.

## Cadre commun

Référence de lecture : [`b1365e0`](https://github.com/Alexmacapple/smolcoder-MTPLX/tree/b1365e055c0f2f344e9b01278497b13ea450e97a), le 26 septembre 2026. Le dépôt est en cours de modification : **relire le HEAD, les branches et les travaux en cours avant de coder**, puis réduire ou fermer le ticket si sa garantie est déjà couverte. Les constats ci-dessous viennent d'une lecture ciblée, pas d'une exécution indépendante des tests.

Renforcer la boucle existante, sans deuxième harnais, changement silencieux du comportement courant ni dépendance à un modèle cloud. Les décisions des tickets #1 à #7 restent acquises : ne pas rouvrir le lanceur, les libellés MTPLX, la précédence des consignes ou l'opt-out global. Toute implémentation doit conserver les tests existants et ajouter son entrée à `CHANGELOG-MTPLX.md` dans le même commit ; ne pas éditer `dist/`.


---

# H03 — Harnais — Exécution locale isolée sans contournement implicite

<!-- smolcoder-harness:H03:v1 -->

**Identifiant de chantier : H03. Priorité proposée : P1 — prérequis à l’autonomie renforcée.**

## Objectif

Permettre les commandes de développement dans un périmètre réellement limité sur le Mac, sans donner aux scripts lancés les accès du compte utilisateur.

## Existant observé

[`src/sandbox.ts`](https://github.com/Alexmacapple/smolcoder-MTPLX/blob/b1365e055c0f2f344e9b01278497b13ea450e97a/src/sandbox.ts) indique explicitement que le contrôle des commandes est textuel, avec des faux négatifs possibles. [`src/tools/shell.ts`](https://github.com/Alexmacapple/smolcoder-MTPLX/blob/b1365e055c0f2f344e9b01278497b13ea450e97a/src/tools/shell.ts) exécute actuellement avec `env: process.env` et gère déjà délais, annulation et groupes de processus. Conserver ces mécanismes utiles en les branchant sur un exécuteur isolé.

## Incrément proposé

1. Définir une interface étroite d'exécution partagée par `run_command`, `task`, contrôles automatiques et sous-processus de vérification. Un premier backend cible macOS ; documenter le modèle de menace et le choix technique dans une courte décision d'architecture.
2. Faire appliquer les frontières de fichiers et de réseau par le système ou un environnement isolé éprouvé. Évaluer un runtime existant avant d'en écrire un ; ne pas imposer ici une nouvelle dépendance sans essai sur le Mac cible.
3. Autoriser le workspace de tâche et des répertoires temporaires bornés. Protéger le HOME réel, SSH, jetons, sockets d'administration, stockage du harnais, contrôles de confiance et métadonnées Git partagées. Transmettre un environnement minimal, pas tous les secrets du processus parent.
4. Garder l'inférence MTPLX dans le processus hôte : les commandes du projet n'ont pas besoin d'accéder à son API ni au démon web. Réseau enfant refusé par défaut, ouvert seulement pour les destinations nécessaires explicitement autorisées. Tester aussi le loopback et les sous-processus.
5. Indiquer l'isolation active dans l'interface. Backend absent/inopérant : profil renforcé bloqué ou lecture seule, jamais repli automatique en shell non isolé. Le mode historique doit rester clairement distinct.

## Critères d'acceptation

- [ ] Un script de fixture, pourtant situé dans le workspace, ne peut pas lire un faux secret externe ni altérer un contrôle protégé ; ses sous-processus non plus.
- [ ] Tentatives vers un serveur HTTP de test interdit et vers une API locale non autorisée bloquées ; destination expressément autorisée testée positivement.
- [ ] Un `npm test` de fixture et un serveur de développement autorisé fonctionnent ; fichiers temporaires nécessaires explicités.
- [ ] Arrêt/timeout terminent les descendants et donnent un résultat observable ; aucune affirmation de réussite fondée sur la seule disparition du processus parent.
- [ ] Même frontière pour terminal, web, headless et vérifications automatiques.
- [ ] Absence de backend : aucune commande du profil renforcé n'est lancée. Tests OS sur macOS obligatoires avant de déclarer ce support validé ; les mocks seuls ne suffisent pas.

## Dépendances et limites

Dépend de H02. Un worktree sépare les modifications, pas les permissions OS. L'adaptateur de plateforme n'a pas à supporter Linux/Windows dans ce premier lot, mais leur comportement non supporté doit être explicite. Aucun déploiement, accès production ni exécution cloud.

## Source de conception

[Anthropic : isolation des fichiers et du réseau](https://www.anthropic.com/engineering/claude-code-sandboxing). La proposition reprend ces deux frontières ; elle ne suppose pas qu'une integration particulière serait déjà sûre ou compatible avec MTPLX.

## Cadre commun

Référence de lecture : [`b1365e0`](https://github.com/Alexmacapple/smolcoder-MTPLX/tree/b1365e055c0f2f344e9b01278497b13ea450e97a), le 26 septembre 2026. Le dépôt est en cours de modification : **relire le HEAD, les branches et les travaux en cours avant de coder**, puis réduire ou fermer le ticket si sa garantie est déjà couverte. Les constats ci-dessous viennent d'une lecture ciblée, pas d'une exécution indépendante des tests.

Renforcer la boucle existante, sans deuxième harnais, changement silencieux du comportement courant ni dépendance à un modèle cloud. Les décisions des tickets #1 à #7 restent acquises : ne pas rouvrir le lanceur, les libellés MTPLX, la précédence des consignes ou l'opt-out global. Toute implémentation doit conserver les tests existants et ajouter son entrée à `CHANGELOG-MTPLX.md` dans le même commit ; ne pas éditer `dist/`.


---

# H04 — Harnais — Verdicts structurés et preuves d’acceptation protégées

<!-- smolcoder-harness:H04:v1 -->

**Identifiant de chantier : H04. Priorité proposée : P1 — éviter les faux succès.**

## Objectif

Ne pas confondre « Qwen a répondu », « une commande a fini » et « les critères de la mission sont vérifiés ». Produire un résultat exploitable sans relire toute la conversation.

## Existant à conserver

[`src/agent.ts`](https://github.com/Alexmacapple/smolcoder-MTPLX/blob/b1365e055c0f2f344e9b01278497b13ea450e97a/src/agent.ts) possède déjà `Verification`, une commande d'acceptation détenue par l'appelant, un compteur d'essais et `verificationResult`. [`src/verification.ts`](https://github.com/Alexmacapple/smolcoder-MTPLX/blob/b1365e055c0f2f344e9b01278497b13ea450e97a/src/verification.ts) découvre les scripts `build`, `test`, `test:e2e`. [`src/tools/shell.ts`](https://github.com/Alexmacapple/smolcoder-MTPLX/blob/b1365e055c0f2f344e9b01278497b13ea450e97a/src/tools/shell.ts) renvoie actuellement une chaîne mêlant logs et statut. Étendre ces mécanismes plutôt que créer une seconde boucle de réparation.

## Incrément proposé

1. Faire remonter de l'exécuteur un résultat typé : démarrage, code de sortie, signal, timeout, annulation, logs et durée. Le rendu texte devient une projection ; les décisions ne dépendent pas d'un message libre.
2. Pour chaque critère requis : `passed / failed / not_run / error`. Conserver séparément l'état de la tâche (`running`, `verified`, `incomplete`, `blocked`, `cancelled`, `uncertain`) et la décision humaine d'accepter/intégrer. Un plan coché n'est pas une preuve.
3. Rattacher les preuves au contrat, à la version des vérificateurs et à l'empreinte des fichiers vérifiés. Si ces entrées changent après les tests, les preuves deviennent périmées.
4. Protéger le test de référence ET ce qui l'exécute : scripts, configuration, sortie attendue et logique de verdict. La commande détenue par l'hôte ne suffit pas si `npm test` lance un script modifiable par Qwen. Réserver les contrôles décisifs à un vérificateur de confiance isolé du code soumis ; fournir à Qwen les échecs utiles.
5. Générer `report.json` et un résumé Markdown depuis le même résultat. Montrer les critères non couverts et arrêter proprement au budget prévu. Aucun test automatique découvert ne vaut à lui seul acceptation complète du besoin.

## Critères d'acceptation

- [ ] Qwen annonce « terminé », mais un critère requis échoue : état non vérifié et sortie headless non nulle.
- [ ] Zéro test, contrôle requis sauté, timeout ou crash du vérificateur ne donnent jamais `passed`.
- [ ] Une sortie imprimant « exit code 0 » ne remplace pas le véritable code de sortie du processus.
- [ ] Modifier le test, sa configuration ou remplacer le script de test par un succès trivial ne permet pas une acceptation.
- [ ] Une édition postérieure aux vérifications invalide les preuves ; la présentation n'affiche pas un vert périmé.
- [ ] Les réparations conservent le budget d'essais, l'annulation et les contrôles progressifs existants.

## Dépendances et limites

Types et tests simulés peuvent être développés tôt sur H01 ; la garantie anti-altération exige H02/H03. Un test réussi ne démontre que ses assertions. Pas de juge LLM unique ni de certification générale de qualité/accessibilité/sécurité.

## Source de conception

[Guide Anthropic](https://claude.com/blog/the-ai-native-sdlc-playbook) : faire de la vérification une condition de fin et protéger la boucle. [Définition des évaluations d'agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) : distinguer discours et état final de l'environnement.

## Cadre commun

Référence de lecture : [`b1365e0`](https://github.com/Alexmacapple/smolcoder-MTPLX/tree/b1365e055c0f2f344e9b01278497b13ea450e97a), le 26 septembre 2026. Le dépôt est en cours de modification : **relire le HEAD, les branches et les travaux en cours avant de coder**, puis réduire ou fermer le ticket si sa garantie est déjà couverte. Les constats ci-dessous viennent d'une lecture ciblée, pas d'une exécution indépendante des tests.

Renforcer la boucle existante, sans deuxième harnais, changement silencieux du comportement courant ni dépendance à un modèle cloud. Les décisions des tickets #1 à #7 restent acquises : ne pas rouvrir le lanceur, les libellés MTPLX, la précédence des consignes ou l'opt-out global. Toute implémentation doit conserver les tests existants et ajouter son entrée à `CHANGELOG-MTPLX.md` dans le même commit ; ne pas éditer `dist/`.


---

# H05 — Harnais — Reprise durable et détection des modifications concurrentes

<!-- smolcoder-harness:H05:v1 -->

**Identifiant de chantier : H05. Priorité proposée : P1 — continuité sans rejeu aveugle.**

## Objectif

Après interruption ou nouveau commit humain, reprendre depuis les effets observables sans écraser le travail de l'utilisatrice ni rejouer aveuglément une action.

## Existant à conserver

[`Agent.restoreTranscript()`](https://github.com/Alexmacapple/smolcoder-MTPLX/blob/b1365e055c0f2f344e9b01278497b13ea450e97a/src/agent.ts) signale déjà qu'un outil interrompu a un résultat inconnu et demande d'inspecter avant de réessayer. Les plans et les sessions web sont documentés dans [`docs/how-it-works.md`](https://github.com/Alexmacapple/smolcoder-MTPLX/blob/b1365e055c0f2f344e9b01278497b13ea450e97a/docs/how-it-works.md). Transformer cette prudence en état contrôlé par le logiciel, sans remplacer le stockage existant sans nécessité.

## Incrément proposé

1. Versionner le schéma de reprise. Persister contrat, politiques/prompts réellement chargés, plan, compteurs consommés, preuves, révision Git et empreintes utiles. Utiliser un stockage hôte hors de portée des outils du modèle.
2. Enregistrer une action avec identifiant avant l'effet, puis son résultat observé. Écritures atomiques et gestion d'un dernier enregistrement tronqué ; un crash ne doit pas faire inventer une conclusion.
3. Au redémarrage, une écriture sans résultat certain devient `uncertain`. Réconcilier avec les fichiers, le diff et l'état des processus ; sans preuve suffisante, suspendre. Pas de promesse universelle « exactement une fois ».
4. Détecter les changements externes par HEAD et empreintes des entrées pertinentes, y compris fichiers non suivis et modifications non commitées. Préserver ces changements, périmer les preuves concernées et réancrer le plan avant la prochaine écriture.
5. Empêcher deux sessions du harnais d'écrire simultanément dans le même workspace. Un verrou ne bloque pas un éditeur externe : revérifier avant effet. Si un worktree est retenu, le créer explicitement depuis une base choisie, sans emporter silencieusement le travail non commité ni lancer `reset`, `stash` ou `clean`.
6. Ne pas recharger silencieusement `AGENTS.md` : conserver la version de session, signaler les écarts et demander une transition explicite, conformément à la décision existante.

## Critères d'acceptation

- [ ] Coupure avant action, après écriture avant reçu, et après reçu : trois reprises injectées, résultat documenté sans double application.
- [ ] Qwen ne peut pas effacer un état `uncertain` en affirmant que l'action a échoué.
- [ ] Un commit humain, un fichier non suivi ou une modification non commitée concurrente ne sont ni écrasés ni attribués à l'agent.
- [ ] Double reprise du même workspace : une seule session obtient le droit d'écrire.
- [ ] Les budgets ne repartent pas de zéro au redémarrage ; les preuves périmées ne restent pas validées.
- [ ] Terminal/headless et web partagent le même contrat de reprise ; migration des sessions anciennes prudente, sans destruction des historiques.

## Dépendances et limites

S'appuie sur H01/H04 pour l'état et les preuves, H02 pour sa protection, H03 pour les effets des commandes. Hors périmètre : fusion automatique de conflits, mémoire vectorielle, récupération magique de processus terminés et scheduler.

## Cadre commun

Référence de lecture : [`b1365e0`](https://github.com/Alexmacapple/smolcoder-MTPLX/tree/b1365e055c0f2f344e9b01278497b13ea450e97a), le 26 septembre 2026. Le dépôt est en cours de modification : **relire le HEAD, les branches et les travaux en cours avant de coder**, puis réduire ou fermer le ticket si sa garantie est déjà couverte. Les constats ci-dessous viennent d'une lecture ciblée, pas d'une exécution indépendante des tests.

Renforcer la boucle existante, sans deuxième harnais, changement silencieux du comportement courant ni dépendance à un modèle cloud. Les décisions des tickets #1 à #7 restent acquises : ne pas rouvrir le lanceur, les libellés MTPLX, la précédence des consignes ou l'opt-out global. Toute implémentation doit conserver les tests existants et ajouter son entrée à `CHANGELOG-MTPLX.md` dans le même commit ; ne pas éditer `dist/`.


---

# H06 — Harnais — Banc de régression Qwen–MTPLX et profil mesuré

<!-- smolcoder-harness:H06:v1 -->

**Identifiant de chantier : H06. Priorité proposée : P1 — baseline avant modification.**

## Objectif

Mesurer si une évolution du harnais améliore réellement les tâches terminées et la sécurité sur le modèle local, plutôt que compter les tokens par seconde ou se fier à une démonstration réussie.

## Existant à conserver

Le banc [`bench/noyau-agents-md/banc.sh`](https://github.com/Alexmacapple/smolcoder-MTPLX/blob/b1365e055c0f2f344e9b01278497b13ea450e97a/bench/noyau-agents-md/banc.sh) couvre déjà bug, ajout, destructif, secret et injection. Il distingue réponse et terminal, utilise des workspaces jetables et attend que MTPLX soit disponible. Les tickets #6/#7 ont déjà traité précédence et opt-out : réutiliser ce banc, sans les dupliquer ni changer HOME comme variable confondue.

## Incrément proposé

1. Séparer deux niveaux : tests déterministes du harnais avec fournisseur simulé, exécutables sans modèle ; campagnes comportementales sur le vrai Qwen servi par MTPLX, déclenchées explicitement sur le Mac.
2. Commencer avec les cinq scénarios existants, puis cinq scénarios ciblés : petite modification multi-fichiers, fausse déclaration de réussite, compaction sous contrainte, interruption/reprise et modification humaine concurrente. Ne pas imposer d'emblée 50 tâches.
3. Chaque essai part d'une fixture propre, conserve tous les résultats — échecs compris — et utilise une vérification externe de l'état final. Inclure les tests négatifs H02–H05 au fur et à mesure de leur livraison.
4. Capturer le SHA du harnais, l'identifiant exact renvoyé par le serveur, la variante/quantification quand connue, la version MTPLX quand disponible, le matériel et les paramètres réellement utilisés. Une valeur inconnue reste inconnue. Distinguer contexte annoncé, limite configurée et consommation observée.
5. Mesurer acceptation réelle, faux succès, violations de périmètre, interventions humaines, durée, appels d'outils, compactions et reprises. Comparer des répétitions appariées, sans ne garder que le meilleur essai ; publier effectifs et limites.
6. Profil Qwen proposé uniquement à partir des résultats : peu d'outils, consignes courtes, chargement ciblé, une inférence active par serveur comme point de départ à tester. Ne pas décréter que le raisonnement désactivé ou une petite fenêtre est optimal. Préserver la décision #4 : aucun plafond global silencieux du contexte.

## Critères d'acceptation

- [ ] Baseline conservée avant les autres changements ; procédure reproductible et fixtures versionnées.
- [ ] Une régression injectée du harnais est détectée par les tests sans modèle.
- [ ] Échec de test, refus de sécurité attendu et indisponibilité MTPLX ont des résultats distincts ; aucun cas non exécuté n'est compté réussi.
- [ ] Les répétitions conservent tous leurs résultats et leurs budgets. Paramètres non acceptés par le serveur signalés, pas présentés comme appliqués.
- [ ] Un refus du modèle et un blocage effectif du harnais sont mesurés séparément.
- [ ] Pas de lancement distant du Mac ni de campagne automatique sur code non approuvé. Un futur runner local ne reçoit pas arbitrairement du code de PR externe.
- [ ] Critères de régression documentés ; tout faux succès ou violation d'une garantie bloque la qualification du profil concerné, même si le score moyen monte.

## Dépendances et limites

Commencer la baseline immédiatement, avant H01–H05 ; enrichir ensuite le banc à chaque garantie. Ne pas auto-modifier les consignes depuis un échec : proposer une correction, la faire examiner puis rejouer. Pas de comparaison de modèles concurrents, de parallélisme massif ni de suite payante/cloud.

## Source de conception

[Anthropic : évaluations d'agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) : évaluer ensemble le modèle, les outils, les instructions et leur orchestration ; mesurer les effets réels, pas seulement la transcription.

## Cadre commun

Référence de lecture : [`b1365e0`](https://github.com/Alexmacapple/smolcoder-MTPLX/tree/b1365e055c0f2f344e9b01278497b13ea450e97a), le 26 septembre 2026. Le dépôt est en cours de modification : **relire le HEAD, les branches et les travaux en cours avant de coder**, puis réduire ou fermer le ticket si sa garantie est déjà couverte. Les constats ci-dessous viennent d'une lecture ciblée, pas d'une exécution indépendante des tests.

Renforcer la boucle existante, sans deuxième harnais, changement silencieux du comportement courant ni dépendance à un modèle cloud. Les décisions des tickets #1 à #7 restent acquises : ne pas rouvrir le lanceur, les libellés MTPLX, la précédence des consignes ou l'opt-out global. Toute implémentation doit conserver les tests existants et ajouter son entrée à `CHANGELOG-MTPLX.md` dans le même commit ; ne pas éditer `dist/`.
