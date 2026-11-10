# Albert Chat

Widget de chat qui répond aux questions d'un utilisateur à partir d'un corpus de documents, en citant ses sources. Le corpus vit dans une collection de l'API [Albert](https://albert.api.etalab.gouv.fr/docs), l'API de modèles de langage de l'État. Le widget s'intègre dans une page intranet existante.

Ce dépôt sert deux usages :

- **créer un widget pour un cas d'usage métier**, avec son propre corpus
- **maintenir le démonstrateur ANSSI**, qui interroge les guides publics de l'[ANSSI](https://cyber.gouv.fr)

Les deux usages partagent le même code. Un projet métier n'a besoin ni du corpus ANSSI, ni de son pipeline d'ingestion.

## Ce que fait le widget

L'utilisateur pose une question. Le service interroge la collection Albert, construit un contexte à partir des extraits trouvés, puis demande au modèle de répondre en s'appuyant sur ces extraits. La réponse s'affiche avec la liste des sources, chaque source renvoyant vers le document et sa page.

```
Page hôte
  -> /embed.js ou /widget.js
     -> widget (iframe ou Web Component)
        -> POST /api/chat            (la clé Albert reste côté serveur)
           -> Albert /v1/search      (recherche hybride)
           -> construction du contexte et des citations
           -> Albert /v1/chat/completions (réponse en flux)
        <- flux NDJSON : sources, puis texte de la réponse
```

## Ce qu'il ne fait pas

- **Aucune authentification.** Toute personne qui connaît l'URL peut poser des questions, dans la limite des plafonds anti-abus. C'est une décision de publication à prendre avant la mise en ligne, pas un effet de bord du déploiement.
- **Aucun stockage côté serveur.** L'historique de conversation reste dans l'onglet du navigateur et disparaît au rechargement.
- **Aucune ingestion de documents.** Le widget lit une collection déjà alimentée. Les scripts qui préparent les documents vivent dans le dépôt du projet métier.
- **Aucune gestion fine des droits.** Le corpus interrogé est le même pour tous les utilisateurs.

Voir [Sécurité et limites](docs/4-securite-et-limites.md) pour le détail.

## Par où commencer

| Votre situation                     | Lire                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| Je veux un widget pour mon corpus   | [1. Préparer son corpus](docs/1-preparer-son-corpus.md), puis [2. Déployer](docs/2-deployer.md) |
| Je veux l'afficher dans un intranet | [3. Intégrer dans une page](docs/3-integrer-dans-une-page.md)                                   |
| Je dois décider si c'est publiable  | [4. Sécurité et limites](docs/4-securite-et-limites.md)                                         |
| Je maintiens le démonstrateur ANSSI | [5. Démonstrateur ANSSI](docs/5-demonstrateur-anssi.md)                                         |
| Je contribue au dépôt               | [6. Maintenir le dépôt](docs/6-maintenir-le-depot.md)                                           |

L'ordre compte pour un projet métier. Le corpus et sa vérification viennent avant le premier déploiement : déployer avant que les collections existent donne un widget qui échoue à chaque question, avec deux causes à démêler au lieu d'une.

## Démarrage local

Prérequis : Node 26, pnpm 11, et `poppler-utils` (`pdftotext`, `pdfinfo`) pour les scripts d'ingestion du démonstrateur.

```bash
pnpm install
pre-commit install --install-hooks
cp .env.example .env.local   # renseigner ALBERT_API_KEY et ALBERT_COLLECTION_IDS
pnpm dev
```

La page `/` simule une page intranet et charge le widget depuis `/embed`. La page `/embed` ne contient que le widget.

## Configuration minimale

Deux variables suffisent pour démarrer : `ALBERT_API_KEY`, la clé d'accès à l'API Albert côté serveur, et `ALBERT_COLLECTION_IDS`, la liste des collections interrogées séparées par des virgules. Une liste vide est refusée au démarrage : l'API Albert interpréterait une liste vide comme « toutes les collections accessibles ».

Les autres variables, dont celles qui règlent l'intégration dans une page hôte, sont décrites dans [2. Déployer](docs/2-deployer.md).

## Démonstrateur en ligne

Le démonstrateur ANSSI tourne sur Scaleway : https://chatwidgetf4e894a6-chat-widget.functions.fnc.fr-par.scw.cloud/

Il illustre les deux modes d'intégration. La page de démonstration permet de basculer entre l'iframe et le Web Component, affiche l'extrait correspondant et remplace le widget actif. Changer de mode réinitialise la conversation.

---

✨ Contenu partiellement généré par une IA et vérifié par un agent.
