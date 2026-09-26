# Conception de modules profonds

Vocabulaire partagé pour concevoir ou restructurer du code : beaucoup de
comportement derrière une petite interface, placée à une couture propre,
testable à travers cette interface. Utilise ces termes exactement.

## Glossaire

- Module : toute chose ayant une interface et une implémentation — fonction,
  classe, paquet. Éviter : composant, service.
- Interface : tout ce qu'un appelant doit savoir pour utiliser le module
  correctement — signature, mais aussi invariants, ordre d'appel, modes
  d'erreur, configuration requise, caractéristiques de performance.
- Implémentation : l'intérieur du module.
- Profondeur : le levier à l'interface — la quantité de comportement qu'un
  appelant (ou un test) exerce par unité d'interface à apprendre. Profond =
  petite interface, grosse implémentation. Superficiel = interface presque
  aussi complexe que l'implémentation (à éviter).
- Couture : l'endroit où l'on peut changer un comportement sans éditer à cet
  endroit ; là où vit l'interface du module. Où placer la couture est une
  décision de conception distincte de ce qu'on met derrière.
- Adaptateur : la chose concrète qui satisfait une interface à une couture —
  un rôle, pas une substance.

## Principes

- La profondeur est une propriété de l'interface, pas de l'implémentation :
  un module profond peut être fait de petites pièces internes — elles ne font
  simplement pas partie de l'interface.
- Le test de suppression : imagine supprimer le module. Si la complexité
  disparaît, c'était un passe-plat. Si elle réapparaît chez N appelants, il
  gagnait sa vie.
- L'interface est la surface de test : appelants et tests traversent la même
  couture. Si tu veux tester au-delà de l'interface, le module a probablement
  la mauvaise forme.
- Un adaptateur = couture hypothétique ; deux adaptateurs = couture réelle.
  N'introduis pas de couture tant que rien ne varie réellement à travers elle.

## Concevoir pour la testabilité

1. Accepte les dépendances, ne les crée pas dans le module
   (`processOrder(order, gateway)` se teste ; `new StripeGateway()` à
   l'intérieur, non).
2. Retourne des résultats plutôt que de produire des effets de bord
   (`calculateDiscount(cart): Discount` se teste ; `applyDiscount(cart): void`
   qui mute, difficilement).
3. Petite surface : moins de méthodes = moins de tests nécessaires ; moins de
   paramètres = mise en place plus simple.

En concevant une interface, demande-toi : puis-je réduire le nombre de
méthodes ? simplifier les paramètres ? cacher plus de complexité à
l'intérieur ?
