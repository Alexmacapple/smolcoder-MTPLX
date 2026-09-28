# Réservation protégée

Le stock contient une seule place. Deux réservations simultanées ne peuvent
pas toutes les deux réussir. Le verrou garde les opérations d'une
réservation ensemble, y compris pendant l'audit asynchrone.

Le changement candidat déplace l'enregistrement après l'audit, à l'intérieur
du même verrou.
