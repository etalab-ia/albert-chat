# Maintenir le dépôt

Cette page s'adresse aux personnes qui modifient le code du widget : commandes de développement, contrôles automatiques, dépendances, versions et procédure de renommage.

## Commandes

| Commande             | Effet                                                           |
| -------------------- | --------------------------------------------------------------- |
| `pnpm dev`           | serveur de développement                                        |
| `pnpm build`         | build de production                                             |
| `pnpm build:widget`  | bundle navigateur autonome et feuille de style du Web Component |
| `pnpm test:browser`  | tests Playwright après le build de production                   |
| `pnpm lint`          | Biome et règles Next.js spécifiques avec ESLint                 |
| `pnpm check`         | vérification Biome en mode CI                                   |
| `pnpm format`        | formatage et corrections Biome sûres                            |
| `pnpm typecheck`     | TypeScript                                                      |
| `pnpm test`          | tests Vitest                                                    |
| `pnpm ingest`        | indexation initiale additive du corpus ANSSI                    |
| `pnpm sync:anssi-fr` | synchronisation incrémentale de la collection française         |
| `pnpm verify:corpus` | vérifie citations et numéros de page du corpus ANSSI            |
| `pnpm check:config`  | vérifie en lecture seule la configuration et les collections    |

## Contrôles automatiques

Biome assure le formatage et le lint général. ESLint reste comme couche de compatibilité Next.js : 32 règles React et Next pertinentes n'ont pas d'équivalent dans Biome 2.5.9, dont plusieurs contrôles React Hooks et 10 règles Next.js. Les deux sont exécutés par `pnpm lint` et par la CI, plutôt que de supprimer ces protections.

`gitleaks` s'exécute en pre-commit et `cve-lite` en pre-push (`.pre-commit-config.yaml`), après `pre-commit install --install-hooks`. CVE Lite utilise le pin exact des `devDependencies` et analyse tout le lockfile avec `pnpm exec cve-lite . --fail-on high`. Le workflow `gitleaks.yml` ajoute un scan complet de l'historique sur chaque PR et chaque push sur `main`, avec binaire et empreinte vérifiés.

OSV-Scanner compare les dépendances de chaque pull request à sa branche cible et échoue si elle introduit une nouvelle vulnérabilité. Un scan hebdomadaire et un scan à chaque push sur `main` alimentent aussi Code Scanning, sans bloquer sur les vulnérabilités déjà présentes.

Le hook `gitleaks` reste local : il ne protège que les postes où `pre-commit install --install-hooks` a été lancé.

Les workflows sont versionnés dans `.github/workflows/`.

## Politique de dépendances

pnpm impose un délai minimum d'une semaine avant d'accepter une nouvelle version de paquet (`minimumReleaseAge: 10080`). Il échoue si aucune version mature ne correspond ou si les dates de publication manquent, et revérifie le lockfile à l'installation (`trustLockfile: false`). Les scripts de build sont refusés sauf pour les outils explicitement listés dans `allowBuilds`, et les dépendances transitives exotiques sont refusées. Seules des exceptions exactes et documentées dans `pnpm-workspace.yaml` peuvent contourner ce délai.

Dependabot est actif (`.github/dependabot.yml`), avec un délai de sept jours avant de proposer une version publiée. Il couvre npm, pre-commit, GitHub Actions et Docker. Ses mises à jour de sécurité ne sont pas soumises à ce délai.

## Versions

`release-please.yml` maintient une PR de release à partir des Conventional Commits. Les versions restent sur `0.1.0`, `0.2.0`, etc. avec `bump-minor-pre-major: true`. Le passage à `1.0.0` exige une décision explicite et un commit `Release-As: 1.0.0`. Cette configuration ne déclenche aucun déploiement supplémentaire.

## Renommer le dépôt

Le dépôt s'appelait `chat-widget` et a été renommé `albert-chat` le 10 novembre 2026. GitHub conserve l'identifiant du dépôt lors d'un renommage : les URL existantes redirigent, et ni le conteneur, ni le registre, ni les secrets Scaleway ne changent. Un futur renommage suit la même procédure, avec deux points d'attention.

**Le garde de synchronisation se compare au propriétaire**, `github.repository_owner == 'etalab-ia'`, et non au nom complet. Comparé au nom, il deviendrait faux au renommage et la synchronisation quotidienne cesserait de s'exécuter sans erreur : une tâche ignorée ressemble à un workflow sain.

**Vérifier après le renommage** plutôt que de le supposer. La conclusion du workflow ne suffit pas : une tâche ignorée par sa condition est comptée comme une réussite au niveau du workflow. Il faut interroger la tâche elle-même.

```bash
gh workflow run anssi-sync.yml -f dry_run=true
gh run view --repo <proprietaire>/<depot> --json jobs \
  --jq '.jobs[] | "\(.name) → \(.conclusion)"' \
  "$(gh run list --workflow anssi-sync.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Attendre la fin de l'exécution avant de lire le résultat. La ligne `Synchronize Albert collection` doit afficher `success`. Si elle affiche `skipped`, le garde ne correspond plus. Si le workflow se termine en `success` alors que la tâche est `skipped`, c'est précisément le cas que cette vérification sert à distinguer.

Les URL absolues de `CHANGELOG.md` gardent l'ancien nom : GitHub redirige l'ancien chemin, et les réécrire entrerait en conflit avec release-please à chaque version. Le `"name"` de `package.json` et le `component` de `release-please-config.json` sont passés à `albert-chat` : le premier ne sert qu'au paquet npm local (`pnpm` s'appuie sur le chemin, pas sur ce nom), le second nomme les versions suivantes.

**Le renommage du `component` doit être accompagné d'un tag de continuité.** release-please retrouve la version précédente en comparant le `component` du tag à celui de la configuration : sans le tag `albert-chat-v0.6.0`, il ne reconnaît plus `chat-widget-v0.6.0`, repart de la version du manifeste sans commit de référence, et régénère tout le `CHANGELOG.md` depuis le début. Le tag de continuité a été créé sur le commit de la version 0.6.0. Les anciens tags `chat-widget-v*` restent en place et GitHub continue de servir leurs liens.

Le chemin d'image `rg.fr-par.scw.cloud/chat-widget/chat-widget` et les secrets Scaleway gardent aussi l'ancien nom : ils désignent l'espace de noms du registre et le conteneur, indépendants du nom du dépôt GitHub.

---

✨ Contenu partiellement généré par une IA et vérifié par un agent.
