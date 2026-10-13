# Bibliothèque communautaire de labs

L'application liste et télécharge des labs depuis un **dépôt GitHub public séparé**. Adresse lue par
l'application (`src/shared/library.ts`) :

```
https://raw.githubusercontent.com/tamalou25/serverlab-labs/main/
```

> **État (audit v2.6.2)** : le dépôt `serverlab-labs` n'est pas encore publié (l'index répond 404) ;
> l'onglet Bibliothèque affiche donc une erreur de connexion tant que la mise en place ci-dessous
> n'est pas faite.

## Mise en place (à faire par le propriétaire du dépôt)

1. Créer le dépôt **public** `tamalou25/serverlab-labs` (branche `main`).
2. Y déposer `index.json` à la racine et les labs dans `labs/` (un fichier `labs/<id>.json` par lab).
3. Aucune autre configuration : l'application lit les fichiers bruts (`raw.githubusercontent.com`).

## Format de `index.json`

```json
{
  "formatVersion": 1,
  "labs": [
    {
      "id": "dhcp-avance",
      "title": "DHCP avancé",
      "author": "Gary",
      "difficulty": "Intermédiaire",
      "version": "1.0.0",
      "summary": "Réservations et options d'étendue.",
      "file": "labs/dhcp-avance.json",
      "sha256": "<empreinte SHA-256 du fichier, 64 caractères hexadécimaux>"
    }
  ]
}
```

- Schéma strict (`src/engine/labs/library.ts`) : champ inconnu, identifiant en double, chemin hors de
  `labs/<nom>.json` ou empreinte mal formée → index refusé.
- `id` doit être identique à l'`id` du lab ; `difficulty` : `Débutant`, `Intermédiaire` ou `Avancé` ;
  `version` au format `X.Y.Z`.
- Empreinte : `sha256sum labs/dhcp-avance.json` (Linux) ou `Get-FileHash labs\dhcp-avance.json` (PowerShell,
  en minuscules). À recalculer à chaque modification du lab.

## Sécurité

- Téléchargement par le process principal uniquement, sur la racine ci-dessus (aucune redirection
  suivie, 15 s au plus) : `index.json` (256 Ko au plus) et `labs/<nom>.json` (1 Mo au plus).
- Un lab est refusé si son empreinte SHA-256 diffère de l'index (fichier modifié ou incomplet), s'il ne
  respecte pas le schéma des labs, ou si son identifiant diffère de l'index.
- Un lab n'est que des données (JSON validé par zod) : énoncé Markdown rendu sans HTML, aucun code
  exécuté.
- Tests : la variable `SERVERLAB_LIBRARY_URL` remplace la racine, seulement par un serveur local
  (`http://127.0.0.1:<port>/` ou `http://localhost:<port>/`).

## Créer un lab à partager

Fichier › Ouvrir un lab… › **Créer un lab…** (éditeur de labs), puis **Exporter…** : le fichier JSON
obtenu se dépose tel quel dans `labs/`.
