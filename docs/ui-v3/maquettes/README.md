# Proposition graphique ServerLab

Trois maquettes interactives pour examiner une évolution visuelle de l’interface :

1. **Topologie** : familles d’équipements, zones de réseau, liens orthogonaux et inspecteur.
2. **Mission** : ticket lisible, démarche, topologie et console visibles ensemble, indices progressifs.
3. **Correction** : résultats de classe, détail des objectifs, retour pédagogique et chronologie.

Ouvrir [index.html](index.html). La page est autonome : polices, icônes et captures de référence
sont embarquées. Aucun service distant n’est contacté.

La barre supérieure permet de choisir l’écran, de comparer avec une capture de l’application actuelle,
de changer de thème et de densité. Les captures actuelles et les propositions utilisent des données
différentes : la comparaison porte sur la présentation.

Si le navigateur interdit les fichiers locaux, servir ce dossier avec un serveur HTTP local,
par exemple avec la commande suivante, puis ouvrir la page dans ce navigateur :

    python3 -m http.server --bind 127.0.0.1 8000

## Aperçus

| Écran      | Clair                          | Sombre                          |
| ---------- | ------------------------------ | ------------------------------- |
| Topologie  | [PNG](01-topologie-clair.png)  | [PNG](01-topologie-sombre.png)  |
| Mission    | [PNG](02-mission-clair.png)    | [PNG](02-mission-sombre.png)    |
| Correction | [PNG](03-correction-clair.png) | [PNG](03-correction-sombre.png) |

## Interactions disponibles

- Sélection d’un équipement et mise à jour du résumé.
- Recherche et choix d’une famille d’équipements.
- Élargissement du panneau de lecture.
- Révélation de trois indices, un à un.
- Consultation d’un exemple de bilan.
- Recherche et sélection d’une copie.
- Modification temporaire d’un commentaire.
- Téléchargement d’un CSV et d’un retour texte de démonstration.

Les équipements, personnes, résultats et horaires sont fictifs. Les actions d’administration,
la vérification d’une intervention et le rejeu sont illustratifs. Aucun état réel du moteur
n’est chargé ou modifié ; les exports portent explicitement la mention « maquette ».
Les changements de commentaire restent en mémoire jusqu’au rechargement.

## Vérification

Les trois écrans sont rendus avec Chromium, dans les deux thèmes. Les interactions principales,
le chargement des références, les exports et l’absence de débordement horizontal sont vérifiés
à 1 600 px et à 1 366 px. Les zones longues défilent verticalement. Les aperçus de correction
utilisent une hauteur supérieure pour montrer la chronologie complète.

Les icônes proviennent de Lucide, déjà utilisé par ServerLab. Les polices Inter et JetBrains Mono
proviennent des dépendances existantes. Ces maquettes ajoutent uniquement des fichiers documentaires.
