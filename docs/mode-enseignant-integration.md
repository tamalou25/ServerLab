# Mode enseignant — suivi du chantier isolé

Cette branche est `lab/mode-enseignant`, créée depuis `main`. Le chantier est hors version publiée : ne pas ouvrir de PR vers `main`, ne pas créer de tag, ne pas modifier la version ni le CHANGELOG avant la demande explicite de Gary (« on intègre »).

## État

- [x] Branche longue durée créée depuis `main`.
- [x] Lecture initiale des consignes, feuille de route, suivi de fidélité, moteur des labs, historique/dispatch, sérialisation et composants d’interface demandés.
- [ ] Chantier 1 : formats autonomes, validation, export/import sujet et barème.
- [ ] Chantiers suivants : passation, correction, démonstration et documentation.

## Points d’accroche prévus (aucun changement de fichier existant à ce stade)

| Fichier existant | Ligne | Raison |
|---|---:|---|
| Aucun | — | Le chantier n’a pas encore ajouté de code ni modifié de fichier existant. Les accroches seront recensées précisément au moment où elles seront nécessaires. |

## Intégration ultérieure

- Rebaser sur `origin/main` au début de chaque session et traiter les conflits en gardant `main`, puis réappliquer seulement les accroches documentées.
- Vérifier un drapeau de fonctionnalité désactivé par défaut avant toute intégration ; un merge accidentel ne doit pas activer le mode.
- Les formats `.slabsujet`, `.slabrendu` et `.slabcorrection` doivent rester autonomes, bornés en taille, validés strictement par zod, et avoir leur propre numéro de format/migrations. Aucun changement requis aux `.slab` tant qu’une fonctionnalité ne le nécessite pas.
- Le moteur ne lit pas l’horloge système : l’interface fournit les horodatages.
- À l’intégration seulement : mettre à jour version et CHANGELOG, puis préparer une PR selon la demande de Gary.

## Limites de sécurité à documenter

Une application hors ligne ne peut pas rendre inviolable un examen sur le poste de l’élève. Le code d’activation n’est qu’une protection contre l’activation accidentelle. La correction recalculée par rejeu permet de détecter des incohérences, mais ne prouve pas l’absence de copie, d’aide externe ou d’altération sophistiquée. Les imports devront limiter la taille, les étapes de rejeu et le temps de traitement.
