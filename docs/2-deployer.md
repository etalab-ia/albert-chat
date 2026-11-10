# Déployer

Le service est une application Next.js standard (App Router), livrée en image de conteneur. Cette page décrit les variables d'environnement, le déploiement du conteneur sur Scaleway, et la liste de contrôle pour un fork.

## Variables d'environnement

Obligatoires :

| Variable                | Rôle                                                    |
| ----------------------- | ------------------------------------------------------- |
| `ALBERT_API_KEY`        | clé d'accès à l'API Albert, lue uniquement côté serveur |
| `ALBERT_COLLECTION_IDS` | collections interrogées, séparées par des virgules      |

`ALBERT_COLLECTION_FR` et `ALBERT_COLLECTION_EN` restent acceptées pour le démonstrateur ANSSI. Elles ne servent que si `ALBERT_COLLECTION_IDS` n'est pas définie.

Optionnelles :

| Variable                 | Valeur par défaut                   | Rôle                                                              |
| ------------------------ | ----------------------------------- | ----------------------------------------------------------------- |
| `ALBERT_BASE_URL`        | `https://albert.api.etalab.gouv.fr` | cibler une autre instance de l'API                                |
| `ALBERT_CHAT_MODEL`      | `gpt-oss-120b`                      | modèle de génération                                              |
| `EMBED_ALLOWED_PARENTS`  | vide                                | origines autorisées à afficher `/embed` dans une iframe           |
| `WIDGET_ALLOWED_ORIGINS` | vide                                | origines autorisées à appeler `/api/chat` depuis le Web Component |
| `ABUSE_MAX_PER_CLIENT`   | `10`                                | questions par client et par fenêtre                               |
| `ABUSE_CLIENT_WINDOW_MS` | `60000`                             | durée de la fenêtre par client                                    |
| `ABUSE_MAX_PER_DAY`      | `500`                               | questions par jour pour tout le service                           |

Deux différences de portée entre les variables d'intégration :

- `EMBED_ALLOWED_PARENTS` est lue au chargement de la configuration, donc un redéploiement est nécessaire pour la modifier.
- `WIDGET_ALLOWED_ORIGINS` est lue à chaque requête, donc un redémarrage du service suffit.

Vide, `EMBED_ALLOWED_PARENTS` n'autorise que la page `/` du service à afficher le widget. Vide, `WIDGET_ALLOWED_ORIGINS` n'autorise que les appels de même origine.

Le seul état applicatif est le fil de conversation, conservé en mémoire du navigateur. Le service n'a ni session utilisateur ni base de données.

## Déployer son propre widget

Cette liste est destinée à un fork. L'ordre compte : le corpus et sa vérification viennent avant le premier déploiement, sinon le widget se déploie sur une configuration qui échouera à la première question.

**1. Préparer les collections** dans le dépôt du projet, avec ses propres scripts d'ingestion, puis relever leurs identifiants. Voir [1. Préparer son corpus](1-preparer-son-corpus.md).

**2. Vérifier avant de déployer :**

```bash
git clone <votre fork>
cd albert-chat && pnpm install
ALBERT_API_KEY=… ALBERT_COLLECTION_IDS=… pnpm check:config
```

La commande est en lecture seule et n'écrit rien dans Albert. Elle échoue si la clé est refusée, si un identifiant est faux, ou si une collection ne renvoie aucun extrait affichable.

**3. Créer le conteneur** dans votre espace Scaleway, puis relever son identifiant, celui de la ressource de conteneurs (_namespace_), et le chemin d'image dans votre registre.

**4. Renseigner les secrets et les variables** du dépôt (Settings → Secrets and variables → Actions).

Secrets :

| Secret                                  | Contenu                                                       |
| --------------------------------------- | ------------------------------------------------------------- |
| `ALBERT_API_KEY`                        | clé du projet, lue seulement par la synchronisation du corpus |
| `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`      | clé d'API Scaleway                                            |
| `SCW_ORGANIZATION_ID`, `SCW_PROJECT_ID` | portée de la clé                                              |

Variables :

| Variable            | Rôle                                | Si absente                                    |
| ------------------- | ----------------------------------- | --------------------------------------------- |
| `SCW_CONTAINER_ID`  | conteneur à mettre à jour           | celui du démonstrateur ANSSI                  |
| `SCW_NAMESPACE_ID`  | espace de conteneurs                | celui du démonstrateur ANSSI                  |
| `SCW_IMAGE_BASE`    | chemin d'image complet, sans le tag | `rg.fr-par.scw.cloud/albert-chat/albert-chat` |
| `SCW_REGISTRY_HOST` | hôte du registre                    | `rg.fr-par.scw.cloud`                         |
| `SCW_REGION`        | région Scaleway                     | `fr-par`                                      |

Chaque variable a pour repli la valeur du démonstrateur, pour que ce dépôt continue de se déployer sans configuration supplémentaire. **Sur un fork, renseigner les cinq variables.** Sans elles, le déploiement s'arrête à l'étape « Verify the Scaleway project and container », dont le message évoque les identifiants alors que le problème est l'identifiant du conteneur. L'étape « Check Scaleway configuration » affiche les valeurs retenues, ce qui rend l'erreur lisible.

Le chemin d'image `rg.fr-par.scw.cloud/albert-chat/albert-chat` désigne l'espace de noms du registre Scaleway et le dépôt d'images, indépendants du nom du dépôt GitHub. Les replis ci-dessus pointent vers les ressources du démonstrateur, qui existent : un repli laissé sur une ressource supprimée ne se voit qu'au moment où il sert, sous la forme d'un échec à l'étape « Verify the Scaleway project and container » alors que le problème est un identifiant périmé.

**5. Configurer l'environnement du conteneur** : `ALBERT_API_KEY`, `ALBERT_COLLECTION_IDS`, et le cas échéant `ALBERT_BASE_URL`, `ALBERT_CHAT_MODEL`, `EMBED_ALLOWED_PARENTS`, `WIDGET_ALLOWED_ORIGINS`.

**6. Pousser sur `main`.** Le pipeline exécute lint, types, tests et build, puis construit et publie l'image, met à jour le conteneur et vérifie `/`, `/embed`, `/embed.js`, `/widget.js` et `/widget.css`.

Deux workflows ne concernent que le démonstrateur et n'ont pas à être activés sur un fork : la synchronisation quotidienne du corpus ANSSI, déjà neutralisée hors du dépôt d'origine, et release-please, qui suppose un historique de versions à maintenir.

L'élément personnalisé s'appelle `<albert-chat>` pour tous les projets : le nom ne mentionne aucun corpus particulier. Les libellés visibles (« Assistant ANSSI », les suggestions de départ) restent propres au démonstrateur et se modifient dans `components/widget/`. Un fork les adapte à son corpus.

## Déploiement sur Scaleway

Le conteneur tourne sur Scaleway, en `fr-par`, avec `min_scale: 0` et `max_scale: 1`. Il écoute sur le port 8080. Avec `min_scale: 0`, la première question après une période d'inactivité paie un démarrage à froid. Pour une démonstration, poser une question avant de commencer, sinon la première réponse visible arrive après une longue attente.

Mesures relevées sur le démonstrateur le 9 novembre 2026 : environ 1,2 seconde pour afficher la page une fois l'instance chaude, et environ 12 secondes pour une question complète, recherche et génération comprises.

Quatre points ont coûté du temps et méritent d'être connus avant de redéployer.

**`HOSTNAME=0.0.0.0` est obligatoire.** Le serveur standalone de Next lit `process.env.HOSTNAME` et l'utilise comme adresse d'écoute. Un conteneur renseigne `HOSTNAME` avec son propre identifiant, que le DNS de Scaleway ne résout pas : le conteneur démarre, écrit `Ready`, et n'écoute sur rien. Scaleway signale alors `Container is unable to start OR is not listening on port 8080`. Le nom d'hôte se résout quand on teste en local avec Podman, ce qui rend le diagnostic trompeur.

**`PORT` est un nom réservé** et Scaleway refuse de le définir. Le port se règle par le champ `port` de la ressource, pas par l'environnement.

**Les noms de champs de l'API ne sont pas ceux qu'on attend.** Le champ d'image s'appelle `image`, et non `registry_image`. Les limites s'expriment en `memory_limit_bytes` et `mvcpu_limit`. Le `timeout` est une durée au format protobuf, donc une chaîne comme `"300s"`.

**La nomenclature du registre** est `rg.<region>.scw.cloud/<espace>/<image>:<tag>`. Le pipeline utilise cette référence complète pour pousser l'image et pour renseigner le champ `image` du conteneur.

Le secret `ALBERT_API_KEY` est stocké comme variable d'environnement secrète. L'API le renvoie haché en argon2id : c'est le comportement attendu, pas une corruption de la valeur.

## Pipeline d'intégration et de déploiement

Le workflow `ci-cd.yml` exécute ESLint, TypeScript, les tests Vitest et le build Next.js sur chaque pull request et chaque push sur `main`. Sur `main`, le job `deploy` démarre seulement après la réussite de ces vérifications. Il construit et publie une image taguée `sha-<SHA complet du commit>`, met à jour le conteneur avec `scw container container update --wait`, vérifie l'image et l'état `ready` avec `scw container container get`, puis contrôle les réponses HTTP de `/`, `/embed`, `/embed.js`, `/widget.js` et `/widget.css`. Un dépassement de délai ou un échec de ces vérifications fait échouer le workflow.

L'action officielle `scaleway/action-scw` installe et configure le CLI Scaleway avec une version explicitement épinglée. Le pipeline n'appelle donc pas directement l'API Scaleway : seules les vérifications HTTP publiques utilisent `curl`.

Le déploiement utilise uniquement les secrets Scaleway. `ALBERT_API_KEY` reste configuré dans Scaleway pour l'application, et séparément dans GitHub Actions pour la synchronisation du corpus ANSSI. Il n'est nécessaire ni à la compilation ni aux tests.

Suite : [3. Intégrer dans une page](3-integrer-dans-une-page.md)

---

✨ Contenu partiellement généré par une IA et vérifié par un agent.
