# Fiches de méthode

Portées depuis les skills de Matt Pocock
([mattpocock/skills](https://github.com/mattpocock/skills), commit `c55ee46`,
licence MIT), condensées en français et adaptées à smolcoder : mono-agent
(pas de sous-agents), renvois par chemin de fichier, conventions du fork.

Lis la fiche AVANT de commencer la tâche correspondante :

- `diagnostic-bugs.md` — bug difficile, régression, « ça casse », lenteur :
  boucle de feedback rouge-capable d'abord, hypothèses classées ensuite.
- `tdd.md` — nouvelle fonctionnalité ou correctif test-first : coutures
  confirmées, rouge avant vert, tranches verticales.
- `revue-de-code.md` — relire un diff avant livraison : deux axes séparés,
  standards (grille de défauts) et spécification.
- `implementer.md` — ordre de travail complet d'une implémentation, du
  cadrage au commit.
- `conception-modules.md` — vocabulaire des modules profonds : interface,
  couture, profondeur, testabilité. À lire quand la forme d'une interface est
  en question.
- `conflits-git.md` — merge ou rebase en conflit : comprendre les deux
  intentions avant de résoudre, jamais d'abandon.

Non portés depuis l'amont (v1) : les skills de pilotage produit (to-spec,
to-tickets, triage, wayfinder, ask-matt, wizard), research et prototype —
pensés pour un humain orchestrant un projet avec sous-agents, hors du rôle
d'ouvrier local de smol. À reconsidérer si le besoin apparaît.
