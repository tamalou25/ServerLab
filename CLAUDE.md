# CLAUDE.md — ServerLab

Simulateur desktop d'administration de serveurs (AD DS, DNS, DHCP, GPO, partages)
inspiré de Packet Tracer, pour réviser l'épreuve E6 du BTS SIO SISR.
Tout est **simulé** : aucune VM, aucune commande système réelle.

## Stack

| Couche    | Outil                                                                   |
| --------- | ----------------------------------------------------------------------- |
| Desktop   | Electron 44 + electron-vite 5 (Vite 7)                                  |
| UI        | React 18 + TypeScript strict + Tailwind 4 + Zustand 5                   |
| Topologie | `@xyflow/react` (React Flow 12)                                         |
| Moteur    | TypeScript pur (`src/engine`), deps autorisées : `immer`, `zod`         |
| Tests     | Vitest (moteur) · Playwright `_electron` (E2E)                          |
| Packaging | electron-builder (NSIS + AppImage) · electron-updater (GitHub Releases) |

## Arborescence

```
src/main/      process principal : fenêtre, menu natif, IPC, fichiers .slab, mises à jour
src/preload/   pont contextBridge → window.serverlab (API minimale)
src/shared/    types partagés main/preload/renderer (contrat IPC)
src/renderer/  application React (index.html + src/)
src/engine/    moteur de simulation pur (15 dossiers) :
               audit/ (audit de configuration) · commands/ (commandes nommées, dispatch, patches)
               core/ (horloge, journal d'évènements, GUID, EngineResult) · cyber/ (scénarios de
               cybersécurité, contre-mesures, détection ; scope `cyber`, attaques abstraites uniquement)
               ios/ (équipements Cisco IOS : CLI, switchs, routeurs ; scope `ios`)
               labs/ (chargement et critères des labs) · model/ (schémas zod) · net/ (IPv4, routage, ARP)
               roles/ (registre + 14 modules : dns, dhcp, adds Active Directory, gpo, files NTFS et SMB,
               wsus, iis, rds, hyperv, adcs, dfs, backup, nps, rras)
               serialization/ (fichiers .slab, migrations) · services/ (système de base)
               shell/ (PowerShell, cmd) · sim/ (traces de paquets) · topology/ (équipements et liens)
               tutorial/ (didacticiel guidé)
src/renderer/src/components/desktop/  Bureau simulé : DesktopShell (verrouillage, fenêtres, barre des
               tâches, menu Démarrer), apps.ts (registre des applications, vues des rôles incluses),
               roleViews.ts (apparence des vues de rôles), apps/ (Gestionnaire de serveur, assistants,
               Connexions réseau, Propriétés système…), shell/ (fenêtres, menus)
labs/          labs pédagogiques *.json
tests/engine/  tests Vitest du moteur
tests/e2e/     scénarios Playwright Electron
build/         ressources de packaging (icône originale)
scripts/       scripts utilitaires (génération d'icône…)
```

## Commandes

```bash
npm ci               # installation
npm run dev          # lancement en développement (HMR)
npm run lint         # ESLint + Prettier
npm run format       # Prettier (écrit les fichiers)
npm run typecheck    # tsc sur main/preload, renderer, moteur, tests
npm test             # Vitest (moteur)
npm run test:long    # tests longs (*.long.test.ts, exclus de npm test) : p. ex. tirage des pannes, 100 graines
npm run test:coverage # Vitest avec couverture
npm run perf:measure # mesures de performance du moteur
npm run fixture:slab # écrit le fichier .slab de référence de la version de schéma
npm run build        # build electron-vite → out/
npm run test:e2e     # build + Playwright (sous Linux sans écran : xvfb-run -a npm run test:e2e)
npm run dist         # installeur local via electron-builder → dist/
```

## Règles d'architecture (non négociables)

1. **Source de vérité unique** : tout l'état simulé vit dans `LabState` (moteur).
   L'UI, les consoles et les labs modifient l'état **uniquement par des commandes nommées**
   (`dispatch`, `src/engine/commands/`) qui appellent les actions du moteur. Jamais de logique métier
   dans un composant React.
2. **Moteur pur** : `src/engine` n'importe ni React, ni Electron, ni `node:*`, ni le DOM.
   Fonctions pures `(state, params) => EngineResult` (immer). Pas de `Math.random()` ni `Date.now()` :
   identifiants et MAC dérivés de `state.seq`, temps = `state.clock` (déterministe → testable).
3. **Erreurs métier** : `{ ok: false, error: { code, message } }` avec message **en français**, réaliste.
4. **Sécurité Electron** : `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP stricte,
   preload minimal, arguments IPC validés dans le main, aucun accès disque générique exposé.
   Adresses externes ouvertes par le main uniquement, après liste blanche (`isAllowedExternalUrl`,
   `src/shared/bugReport.ts`, ouverture par `src/main/external.ts`).
5. **Fichiers `.slab`** : JSON versionné (`schemaVersion`), validé par zod, migrations dans
   `src/engine/serialization/migrations.ts`. Toute évolution du format = nouvelle migration
   - nouveau fichier de référence (recette « Faire évoluer le format .slab »).

## Conventions

- Code et commentaires **en français** (identifiants en anglais), README en français.
- Sorties des consoles simulées en français (comme un serveur installé en FR).
- Aucune image ni logo Microsoft ou Cisco. Icônes : `lucide-react` uniquement. Ne jamais utiliser
  « Packet Tracer » ni « Windows » dans le nom ou le logo de l'application. Exception (accord de Gary,
  v2.5) : les noms de modèles (Cisco 1921, 2811, Catalyst 2960, 9200) et la syntaxe IOS peuvent
  apparaître dans les textes, comme sur l'équipement réel.
- Interface : couleurs via les **design tokens** de `src/renderer/src/styles.css` (`bg-panel`, `bg-surface`,
  `text-fg-muted`, `border-line`, `bg-accent`, `text-ok`…), jamais de couleur Tailwind brute dans l'application.
  Thèmes sombre et clair ; Affichage > Thème : Système (par défaut, suit l'OS), Sombre, Clair
  (`shared/theme.ts`). Le Bureau simulé reste en `data-theme="light"`
  et garde sa propre palette « système » (couleurs fixes dans `components/desktop`, `components/apps`, `mmc`).
  Polices : Inter (UI, 13 px) et JetBrains Mono (IP, MAC, consoles), embarquées.
- Raccourcis clavier : catalogue unique `src/shared/shortcuts.ts` (accélérateurs du menu natif et
  aide « Raccourcis clavier ») ; tout nouveau raccourci y est déclaré.
- Commits : Conventional Commits (`feat(engine): …`, `fix(renderer): …`, `test: …`, `ci: …`, `docs: …`).
- Un commit par étape, tests verts avant d'enchaîner.

## Règles de travail (roadmap v1.1 → v2.6.1)

La roadmap est dans `ROADMAP.md` ; ses milestones, labels et issues sont décrits dans
`.github/roadmap/roadmap.json` et créés par le workflow « Roadmap sync » (ne crée que ce qui manque).

- Une issue = une branche `feat/<num>-<slug>` = une PR qui référence l'issue (`Closes #N`).
- Tests Vitest obligatoires pour toute logique du moteur ; CI verte avant de proposer le merge.
- Ne jamais mélanger deux issues dans une même PR.
- Ne jamais commencer un milestone avant que le précédent soit terminé et validé par Gary.
- À la fin de chaque issue : résumé en 3 lignes + comment tester manuellement.
- À la fin de chaque milestone : mise à jour de `CHANGELOG.md`, bump de version, tag `vX.Y.0`.
- Conventional Commits, code commenté en français.
- Aucune image/icône/logo Microsoft ou Cisco, aucune vraie commande système exécutée.
- Équipements IOS (v2.5) : commits avec le scope `ios` (`feat(ios): …`).
- Cybersécurité (v2.6, v2.6.1) : commits avec le scope `cyber` (`feat(cyber): …`). Garde-fou : une attaque est
  simulée de façon **abstraite** — on modélise son résultat sur l'état simulé (compte compromis, événement
  journalisé), jamais l'exploit lui-même. Aucun code offensif réel : pas de vrai bruteforce, pas de dumping
  d'identifiants, pas de charge utile exploitable (voir `docs/fidelite.md`).

### Cibles d'architecture (prérequis v1.1)

- **Modules de rôles** : chaque rôle = un dossier `src/engine/roles/<rôle>` exposant un `RoleModule`
  (id, dépendances, état, cmdlets/outils, vues GUI, critères de lab, tâches de fond, évènements).
- **Commandes** : toute modification d'état = commande nommée `{ type, params }` passant par un
  `dispatch` unique ; annuler/rétablir et journal par patches immer (aucun inverse écrit à la main).
- **Migrations** : un fichier `.slab` de référence par version de schéma, testé.
- **Validation** : tout fichier importé passe par un schéma zod.

## Recettes

### Ajouter une commande (modification déclenchée par l'interface)

1. Écrire ou réutiliser l'action pure `(state, ...args) => EngineResult` dans `src/engine/roles/<rôle>/…`
   (ou `services/`, `topology/`, `net/` pour le système de base).
2. La déclarer dans `src/engine/roles/<rôle>/commands.ts` (ou `commands/catalog.ts` pour le système de
   base) : `'domaine.verbe': def(action, (state, ...args) => 'Libellé FR')`
   (libellé lisible, évalué sur l'état d'avant ; arguments sérialisables). Une action dont le
   résultat n'est pas un `EngineResult` passe par un adaptateur (voir `directory`, `drive`).
3. Côté interface : `runCommand(command('domaine.verbe', ...args))` ; plusieurs commandes liées →
   `batch(libellé, [...])` ; opération rejouée en mode Simulation → `prepare` puis `commit`.
4. Test Vitest dans `tests/engine/commands/` si la commande a une logique propre (adaptateur, composée).

L'annuler/rétablir et le journal viennent des patches immer calculés par `dispatch` : aucun inverse à écrire.

### Ajouter une cmdlet PowerShell

1. Implémenter l'action métier dans `src/engine/roles/<rôle>/` (si elle n'existe pas).
2. Déclarer la cmdlet dans `src/engine/roles/<rôle>/cmdlets.ts` (système de base :
   `shell/ps/cmdlets/`) : nom, paramètres (type, obligatoire, position), handler qui appelle l'action
   → catalogue et complétion Tab dérivés du registre.
3. Test Vitest dans `tests/engine/shell/` : sortie + état identique à l'action GUI.

### Ajouter un rôle

Un rôle ne touche pas au cœur du moteur : tout est déclaré dans son module.

1. Créer `src/engine/roles/<rôle>/` : actions pures, `commands.ts`, `cmdlets.ts` (et `tools.ts`),
   `criteria.ts`, et `index.ts` qui exporte `defineRole({ … })` (contrat : `roles/types.ts`) :
   id, nom, fonctionnalité principale, dépendances (prérequis) et `uses` (autres rôles appelés à
   l'exécution, vérifié par `registry.test.ts`), fonctionnalités installables, état sur le
   serveur (`RoleStateDef` : clé, schéma zod, état initial, accesseur typé dans `state.ts`),
   commandes, cmdlets, outils, vues, critères, tâches de fond, sources d'évènements, services.
2. L'ajouter dans `load()` de `src/engine/roles/registry.ts`, après les rôles dont il dépend.
   Installation, catalogue des consoles, critères de lab, commandes et tâches de fond suivent.
3. Interface : apparence de chaque vue dans `components/desktop/roleViews.ts`, composant dans
   `renderApp.tsx`, icône du rôle (`roleIcon`). Aucune autre liste à compléter.
4. Données sur le serveur nouvelles ou modifiées → recette « Faire évoluer le format .slab ».
5. Tests Vitest dans `tests/engine/` ; `tests/engine/roles/registry.test.ts` vérifie la cohérence
   du registre (dépendances, unicité des noms, état initial).

### Publier une version

1. `git tag vX.Y.Z && git push origin vX.Y.Z` → workflow `release.yml` : vérifications, brouillon,
   installeurs Windows (NSIS) et Linux (AppImage) construits sans jeton d'écriture, puis envoyés
   et publiés par un job sans dépendances npm (droits minimaux, `npm ci --ignore-scripts`).
2. La version de l'application est celle du tag (alignée dans le workflow). Mises à jour :
   `src/main/updater.ts` (electron-updater, releases GitHub publiques, aucun jeton embarqué).

### Faire évoluer le format .slab

Un ancien lab doit toujours s'ouvrir. Les fichiers `tests/engine/serialization/fixtures/vN.slab`
(un par version, jamais modifiés) le garantissent.

1. Modifier le schéma, incrémenter `CURRENT_SCHEMA_VERSION` et ajouter `migrations[N]` (N → N + 1)
   dans `src/engine/serialization/migrations.ts`.
2. Adapter `tests/engine/serialization/reference-lab.ts` si le scénario doit couvrir la nouveauté,
   puis `npm run fixture:slab` : écrit `fixtures/v<N+1>.slab` (refuse d'écraser un fichier existant).
3. Ajouter un test unitaire de la migration dans `tests/engine/serialization/migrations.test.ts` ;
   `npm test` vérifie que chaque fichier de référence s'ouvre, migre et reste utilisable.

### Ajouter un critère de lab

1. Ajouter le type avec `defineCriterion(schéma zod, évaluateur)` dans `src/engine/roles/<rôle>/criteria.ts`
   (système de base : `src/engine/labs/criteria.ts`) ; le schéma des labs en est dérivé.
2. L'utiliser dans `labs/*.json` avec `label` et `hint` (l'indice ne donne jamais la solution).
3. Le test `tests/engine/labs/` applique la solution du lab et exige 100 % de critères validés.
