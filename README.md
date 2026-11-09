# Chat widget ANSSI

Widget de chat RAG pour interroger le corpus public des guides de l'ANSSI depuis une page intranet, via l'API Albert. POC.

Deux intégrations partagent le même composant React et assistant-ui : une iframe et un Web Component sans iframe. La page de démonstration permet de choisir le mode, affiche l'extrait correspondant et remplace le widget actif. Changer de mode réinitialise la conversation.

## Fonctionnement

```
Page intranet hôte
  -> script /embed.js
     -> iframe /embed
        -> assistant-ui (modale flottante, fil de conversation uniquement)
        -> POST /api/chat                    (clé Albert côté serveur)
           -> Albert POST /v1/search         (méthode hybride)
           -> construction du contexte et des citations
           -> Albert POST /v1/chat/completions (flux SSE, gpt-oss-120b)
        <- flux NDJSON : sources, puis deltas de la réponse
```

Le navigateur ne reçoit jamais la clé Albert : seule la route serveur `/api/chat` la lit.

## Citations et numéros de page

Le découpage automatique de l'API Albert ne conserve pas les numéros de page. L'ingestion découpe donc chaque PDF page par page et attache à chaque chunk :

- `page`, le numéro de page ;
- `guide_id`, `guide_title`, `source_url`, `source_sha256`, `collection`, `extraction`.

L'URL de citation (le PDF suivi de `#page=N`, qui ouvre le document à la bonne page) n'est pas stockée : elle se déduit de `source_url` et de `page`, et `buildCitationUrl` est la seule fonction qui la construit. Un seul champ de vérité, donc pas de risque d'URL incohérente entre l'index et l'affichage.

Ces métadonnées sont conservées à l'indexation et restituées par `/v1/search`, ce qui permet au widget d'afficher une liste de sources cliquables sous chaque réponse.

`pdftotext` est appelé une fois pour tout le document et son résultat est découpé sur les sauts de page. La décision de passer par l'OCR est prise page par page : une page dont la couche texte est trop pauvre est relue par l'OCR Albert (`mistral-ocr-2512`), qui renvoie du markdown page par page, tandis que les autres pages gardent leur texte d'origine. Un PDF mixte (certaines pages scannées) est donc indexé en entier ; `extraction` vaut alors `mixed` au niveau du document et `pdf` ou `ocr` au niveau de chaque chunk.

L'OCR est appelé sur le document entier dès qu'une seule page en a besoin, car l'endpoint prend l'URL du PDF et non une page : un PDF mixte coûte donc un OCR complet. Ce coût est accepté, une page scannée oubliée étant invisible dans le corpus.

## Développement

Prérequis : Node 26, pnpm 11, et `poppler-utils` (`pdftotext`, `pdfinfo`) pour l'ingestion.

```bash
pnpm install
pre-commit install --install-hooks
cp .env.example .env.local   # renseigner ALBERT_API_KEY
pnpm dev
```

La page `/` simule une page intranet et charge le widget depuis `/embed`. La page `/embed` ne contient que le widget.

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

## Indexation du corpus

Le catalogue est lu depuis `https://messervices.cyber.gouv.fr/api/guides`. Deux collections publiques sont alimentées, `anssi-guides-fr` et `anssi-guides-en`.

```bash
# Vérification à blanc de l'indexation initiale sur deux documents
pnpm ingest -- --language FR --limit 2 --dry-run

# Indexation initiale des deux langues
pnpm ingest -- --all --concurrency 3

# Vérifie que chaque collection renvoie des chunks avec page et URL de citation
pnpm verify:corpus
```

Le script `pnpm ingest` est réservé à l'alimentation initiale : il réutilise les collections existantes et ajoute des documents sans réconcilier les versions. Repartir de zéro suppose de supprimer les collections côté Albert.

Les identifiants des collections créées doivent être reportés dans `ALBERT_COLLECTION_FR` et `ALBERT_COLLECTION_EN`.

### Synchronisation française

`pnpm sync:anssi-fr` met à jour uniquement `anssi-guides-fr`. La collection anglaise et les documents sans métadonnées du corpus français ne sont pas modifiés.

```bash
# Télécharge les PDF et affiche les décisions, sans écrire dans Albert
pnpm sync:anssi-fr --dry-run

# Synchronisation effective
pnpm sync:anssi-fr --concurrency 2
```

La synchronisation identifie chaque PDF par le couple `guide_id` et `source_url`, car une fiche ANSSI peut contenir plusieurs documents. Elle inventorie toutes les pages de l'API Albert puis télécharge chaque PDF du catalogue pour calculer son SHA-256 : le catalogue ne fournit pas cette empreinte. Chaque chunk porte `source_sha256` en plus des métadonnées de citation. Le dernier chunk indexé porte `sync_complete: true`, ce qui permet à l'exécution suivante de ne pas retenir une indexation interrompue. Comme Albert ne renvoie pas nécessairement ce chunk en dernier, l'inventaire parcourt les pages de chunks pour repérer ce marqueur.

- Si l'empreinte et les métadonnées sont identiques, le document est conservé sans extraction de texte, OCR, création de chunks ou réécriture Albert.
- Un nouveau PDF est indexé. Un PDF ou un titre modifié est réindexé dans un nouveau document ; l'ancienne version n'est supprimée qu'après l'écriture complète de la nouvelle.
- Les documents gérés absents du catalogue et les doublons sont supprimés. Les documents sans `guide_id`, `source_url` et `collection: FR` exploitables sont préservés.
- Les documents historiques sans empreinte sont réindexés une première fois pour les migrer, puis les exécutions suivantes peuvent les laisser inchangés.
- Une erreur de téléchargement, d'extraction, d'OCR ou d'indexation conserve l'ancienne version du guide concerné. Le bilan signale chaque échec et la commande se termine en erreur.

Le workflow `anssi-sync.yml` exécute cette commande chaque jour à 04:17 UTC et sérialise les exécutions. Il ne redéploie pas le widget. Une exécution manuelle depuis l'onglet Actions utilise le mode simulation par défaut ; décocher `dry_run` permet une synchronisation réelle. Le secret GitHub Actions `ALBERT_API_KEY` est requis.

## Projet métier : collections propres

Cette section s'adresse à un projet qui déploie le widget sur son propre corpus. L'ingestion reste **hors de ce dépôt** : les scripts qui préparent les documents vivent dans le dépôt du projet. Le widget ne fait que rechercher dans les collections qu'on lui indique.

Tout ce qui précède sur l'ANSSI décrit le démonstrateur et son pipeline ; ce n'est pas un prérequis pour un projet métier.

### Ce que le projet fournit

1. Une ou plusieurs collections dans l'API Albert, alimentées par ses propres scripts.
2. Une clé `ALBERT_API_KEY` côté serveur, propre au projet.
3. Les identifiants de ces collections, dans `ALBERT_COLLECTION_IDS`.
4. Un hébergement Next.js et, si le widget est intégré à une page hôte, `EMBED_ALLOWED_PARENTS` et `WIDGET_ALLOWED_ORIGINS`.

### Contrat attendu sur les chunks

Le widget lit la métadonnée de chaque chunk. Seul le contenu est obligatoire.

| Champ         | Statut     | Effet                                                                                                                                  |
| ------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `title`       | recommandé | Titre affiché pour la source. À défaut, `guide_title` (ANSSI) puis `Document <id>`.                                                    |
| `source_url`  | optionnel  | Lien cliquable, uniquement s'il s'agit d'une URL absolue `http(s)`. Un lien absent ou invalide n'empêche pas la citation.              |
| `page_number` | optionnel  | Numéro de page affiché et ajouté au fragment `#page=` du lien. Valeur entière strictement positive. `page` reste accepté pour l'ANSSI. |

Un chunk sans `source_url` reste utilisable : il alimente la réponse et s'affiche comme citation sans lien. Les documents sans pagination fiable doivent donc omettre `page_number` plutôt que d'inventer un numéro.

Les chunks qui partagent une même page sont regroupés en une seule citation. Un chunk sans numéro de page n'est jamais regroupé, afin qu'aucun passage ne soit tronqué.

### Vérifier la configuration

```bash
# Lit les variables de l'environnement
pnpm check:config

# Ou depuis un fichier, sans exposer la clé sur la ligne de commande
pnpm check:config -- --env-file .env.production
```

La commande valide la configuration avec le même code que le widget, puis vérifie que la clé atteint chaque collection et qu'elle renvoie du contenu citable. Elle est strictement en lecture seule : elle n'appelle que `/v1/search`, sans création, modification ni suppression. Elle échoue si la configuration est invalide, si la clé est refusée ou si une collection ne renvoie rien.

### Points à décider avant la mise en ligne

- **Public visé.** Le widget n'a pas d'authentification : toute personne qui connaît l'URL peut interroger le corpus, dans la limite des plafonds. Le rendre public est une décision de publication, pas un effet de bord du déploiement.
- **Clé dédiée.** Utiliser une clé propre au projet plutôt qu'une clé personnelle, et ne jamais l'exposer au navigateur.
- **Mise à jour du corpus.** Les documents peuvent changer sans redéployer le widget. En revanche, changer la liste des collections ou les variables d'environnement demande un redéploiement.
- **Liste vide.** Une liste de collections vide est refusée au démarrage : l'API Albert interpréterait une liste vide comme « toutes les collections accessibles ».

## Déploiement

L'application est un Next.js standard (App Router). Elle exige :

- `ALBERT_API_KEY` côté serveur ;
- `ALBERT_COLLECTION_IDS`, la liste des collections interrogées, séparées par des virgules (`ALBERT_COLLECTION_FR` et `ALBERT_COLLECTION_EN` restent acceptées pour le démonstrateur ANSSI) ;
- éventuellement `ALBERT_CHAT_MODEL` (par défaut `gpt-oss-120b`) ;
- éventuellement `EMBED_ALLOWED_PARENTS`, la liste des origines autorisées à afficher `/embed` dans une iframe (voir « Intégration dans une page hôte »). Vide, seule la page `/` du service peut l'afficher.

La variable `ALBERT_BASE_URL` permet de cibler une autre instance de l'API.

Le seul état est celui du fil de conversation, conservé en mémoire du navigateur : aucun stockage serveur, aucune session utilisateur.

## Intégration dans une page hôte

```html
<script src="https://<hote>/embed.js" referrerpolicy="strict-origin-when-cross-origin" defer></script>
```

Remplacez `<hote>` par l'adresse du service. Le script crée l'iframe avec les attributs de sécurité décrits ci-dessous, puis écoute ses messages pour l'agrandir ou la réduire. Il fonctionne aussi bien dans `<head>` que dans `<body>` et ne crée qu'une seule iframe si la balise est chargée deux fois.

Deux réglages côté serveurs complètent l'intégration :

- le service n'accepte d'être affiché que par `'self'` et par les origines listées dans `EMBED_ALLOWED_PARENTS` (en-tête `Content-Security-Policy: frame-ancestors` sur `/embed`) ; une page non listée reçoit un cadre vide. La liste est lue au chargement de la configuration, donc un redéploiement est nécessaire pour la modifier.
- la page hôte doit autoriser l'adresse du widget dans ses propres règles `script-src`, pour charger `/embed.js`, et `frame-src`, pour afficher `/embed`. L'intégration ne demande aucun script en ligne.

Le redimensionnement évite `postMessage(..., "*")` : le widget adresse son message à l'origine du parent, qu'il lit dans `document.referrer`. C'est la raison du `referrerpolicy="strict-origin-when-cross-origin"` sur l'iframe : pour une page hôte sur un autre domaine, le navigateur ne transmet que l'origine, jamais le chemin ni les paramètres ; pour une page de même origine, le widget n'a rien de plus à savoir. L'attribut est aussi présent sur la balise `script`, afin d'appliquer la même règle à la requête `/embed.js`. Si la page hôte impose `referrerpolicy="no-referrer"`, le référent est vide et le message retombe sur `"*"` — il ne contient alors que l'état ouvert/fermé.

La liste des parents est volontairement limitée à des origines nues : une entrée avec un chemin ou une requête ne restreindrait pas `frame-ancestors` comme elle en a l'air, et un joker (`https://*.exemple.gouv.fr`) serait accepté par l'en-tête mais jamais reconnu par le widget, qui compare des origines entières. Ces entrées sont écartées au chargement ; il faut lister chaque page hôte.

### Web Component sans iframe

```html
<script type="module" src="https://<hote>/widget.js"></script>
<anssi-chat api-url="https://<hote>/api/chat"></anssi-chat>
```

Le navigateur n'a besoin d'aucun framework installé : `widget.js` embarque React, ReactDOM et assistant-ui, sans Next.js ni DSFR. Il charge `widget.css` à côté de son propre fichier et place le panneau et ses styles dans un Shadow DOM. Les deux fichiers et `widget.js.LEGAL.txt` sont générés par `pnpm dev` et `pnpm build`, puis inclus dans l'image. Pour les auto-héberger, copier ces trois fichiers ensemble, conserver les mentions de licence et renseigner explicitement `api-url` vers le serveur du service. Sans attribut, l'API est `/api/chat` sur l'origine du script.

Configurer `WIDGET_ALLOWED_ORIGINS` avec les origines hôtes autorisées, séparées par des virgules, au démarrage du service. Une modification exige un redémarrage, pas un rebuild. Aucun joker ni origine opaque `null` n'est accepté par l'API. Les appels de même origine fonctionnent sans configuration. Les fichiers publics `widget.js` et `widget.css` autorisent le chargement depuis toute origine, sans cookies : ils ne contiennent aucun secret. Cette ouverture ne donne pas accès à l'API. La page hôte doit autoriser le service dans `script-src`, `style-src` et `connect-src`; `frame-src` n'est pas nécessaire. L'API autorise uniquement les pré-vérifications CORS pour POST avec `Content-Type`, sans cookies ni en-tête d'authentification. Les erreurs et `Retry-After` restent lisibles par les hôtes autorisés.

`api-url` accepte une URL HTTP(S), relative à la page ou absolue, sans identifiants ni fragment. Changer cet attribut ou retirer l'élément annule la requête active et réinitialise la conversation. Le même élément peut être réinséré. Les événements `open-change` (`detail.open`) et `widget-error` (`detail.message`) remontent vers la page; ne pas y transmettre de secrets. Éviter plusieurs assistants flottants sur une même page : ils occupent le même coin de fenêtre.

**Différence de sécurité :** le Shadow DOM isole les styles, pas les privilèges JavaScript. Le composant s'exécute avec ceux de la page hôte et n'a ni sandbox, ni politique de permissions propre. Utiliser une version revue et maîtrisée par l'intégrateur, idéalement auto-hébergée; une URL distante mutable implique de faire confiance à chaque mise à jour. Les contrôles CORS ne sont pas une authentification et ne remplacent pas les plafonds serveur. L'iframe sur une origine distincte reste l'option qui sépare les DOM et les stockages d'origine.

Le composant React partagé `AssistantModal` accepte également `apiUrl`; il est utilisé directement par les deux modes, mais aucun paquet npm React n'est publié à ce stade. Dans une application React, ses dépendances et styles doivent être intégrés par l'application, et les portails doivent rester dans le conteneur stylé.

### Vérification navigateur

La comparaison de même origine utilise l'en-tête `Host` et le protocole externe `X-Forwarded-Proto` fourni par le reverse proxy; celui-ci doit maîtriser ces en-têtes. Ce contrôle n'est pas une authentification.

```bash
pnpm exec playwright install chromium
pnpm build
pnpm test:browser
```

Les tests utilisent uniquement des réponses simulées ou des requêtes invalides, sans appeler Albert. Le serveur de test autorise uniquement l'origine de la page HTML de test, qui interdit les iframes et applique des styles hostiles pour vérifier le bundle distribué. Les tests couvrent les citations, l'échappement du texte, les portails, le démontage, la validation d'URL et le changement de mode. Cette origine de test n'est pas à ajouter à la configuration de production.

## Sécurité

- La clé Albert reste côté serveur ; elle n'est jamais incluse dans un bundle client.
- L'iframe est confinée par `sandbox` : scripts et origine (nécessaires pour appeler `/api/chat`), ouverture des PDF cités dans un nouvel onglet. Ni navigation de la fenêtre hôte, ni formulaires, ni fenêtres modales, ni téléchargements. Sur une page hôte d'un autre domaine, du code exécuté dans `/embed` ne peut donc pas rediriger l'utilisateur ni recouvrir l'interface. Sur la page de démonstration, l'iframe est de même origine : un bac à sable ne sépare pas deux documents de même origine, c'est le domaine distinct qui apporte cette séparation.
- `/embed.js` s'exécute dans l'origine de la page hôte, en dehors de la sandbox de l'iframe. La page doit donc faire confiance au service qui fournit ce script : la sandbox ne protège pas contre une compromission du chargeur lui-même.
- Les API de l'appareil sont refusées deux fois : par l'attribut `allow` de l'iframe et par l'en-tête `Permissions-Policy` du service (caméra, micro, position, capture d'écran, lecture du presse-papiers, paiement, USB…). Une iframe de même origine hériterait sinon des droits de la page hôte.
- `/embed` porte `frame-ancestors` (qui peut l'afficher) et `/` porte `frame-ancestors 'none'` plus `frame-src 'self'` (la page de démonstration ne se laisse pas encadrer et n'encadre que son propre widget). Les autres en-têtes : `X-Content-Type-Options: nosniff` et `Referrer-Policy: strict-origin-when-cross-origin`.
- Les messages de redimensionnement sont filtrés des deux côtés : la page hôte vérifie `event.source` **et** `event.origin` ainsi que la forme du message, et le widget adresse son message à une origine précise plutôt qu'à `"*"`.
- Une politique de sécurité du contenu complète (scripts, styles) reste à écrire : le bootstrap DSFR utilise un script en ligne, qui demande soit un nonce par requête, soit un rendu dynamique. Les règles ci-dessus ne couvrent que l'encadrement.
- La route `/api/chat` valide la requête (longueur de question, historique borné) avant tout appel amont.
- Deux plafonds protègent la route : 10 questions par minute et par client, et 500 questions par jour pour l'ensemble du service. Les deux refusent avec un code 429 avant tout appel amont, donc une salve coûte une réponse JSON et non une recherche plus une complétion. Les plafonds se règlent par `ABUSE_MAX_PER_CLIENT` et `ABUSE_MAX_PER_DAY`.
- Le plafond par client s'appuie sur `X-Real-IP` puis sur la première adresse `X-Forwarded-For`. Ces en-têtes sont contrôlés par le client lorsque le service est joignable directement : c'est une mesure d'équité, pas une authentification. Le plafond quotidien, lui, borne réellement le coût total.
- Les documents ouverts par les citations le sont avec `rel="noopener noreferrer"`.
- pnpm impose un délai minimum d'une semaine avant d'accepter une nouvelle version de paquet (`minimumReleaseAge: 10080`), échoue si aucune version mature ne correspond ou si les dates de publication manquent, et revérifie le lockfile à l'installation (`trustLockfile: false`). Les scripts de build sont refusés sauf pour les outils explicitement listés dans `allowBuilds`, et les dépendances transitives exotiques sont refusées. Seules des exceptions exactes et documentées dans `pnpm-workspace.yaml` peuvent contourner ce délai.
- `gitleaks` s'exécute en pre-commit et `cve-lite` en pre-push (`.pre-commit-config.yaml`), après `pre-commit install --install-hooks`. CVE Lite utilise le pin exact de `devDependencies` et analyse tout le lockfile avec `pnpm exec cve-lite . --fail-on high`. Le workflow `gitleaks.yml` ajoute un scan complet de l'historique sur chaque PR et chaque push sur `main`, avec binaire et empreinte vérifiés.
- Biome assure le formatage et le lint général. ESLint reste comme couche de compatibilité Next.js : 32 règles React/Next pertinentes n'ont pas d'équivalent dans Biome 2.5.9, dont plusieurs contrôles React Hooks et dix règles Next.js. Les deux sont exécutés par `pnpm lint` et par la CI, plutôt que de supprimer ces protections.
- OSV-Scanner compare les dépendances de chaque pull request à sa branche cible et échoue si elle introduit une nouvelle vulnérabilité. Un scan hebdomadaire et un scan à chaque push sur `main` alimentent aussi Code Scanning, sans bloquer sur les vulnérabilités déjà présentes.
- Dependabot est actif (`.github/dependabot.yml`), avec un délai de 7 jours avant de proposer une version publiée. Il couvre npm, pre-commit, GitHub Actions et Docker ; ses mises à jour de sécurité ne sont pas soumises à ce délai.

Les workflows sont versionnés dans `.github/workflows/`. Le hook `gitleaks` reste local : il ne protège que les postes où `pre-commit install --install-hooks` a été lancé.

`release-please.yml` maintient une PR de release à partir des Conventional Commits. Les versions restent sur `0.1.0`, `0.2.0`, etc. avec `bump-minor-pre-major: true`. Le passage à `1.0.0` exige une décision explicite et un commit `Release-As: 1.0.0`. Cette configuration ne déclenche aucun déploiement automatique supplémentaire.

## Limites du POC

- Pas d'authentification sur `/api/chat` : toute personne qui connaît l'URL peut poser des questions, dans la limite des plafonds ci-dessus.
- Les compteurs des plafonds vivent en mémoire du processus. Ils sont donc propres à chaque instance : si le service est un jour déployé sur plusieurs instances, il faudra un stockage partagé, sinon la limite effective est multipliée par le nombre d'instances.
- L'historique de conversation reste dans le navigateur ; un rechargement le perd.
- La synchronisation française doit télécharger chaque PDF pour détecter un changement de contenu, mais seuls les documents modifiés sont extraits et réindexés.
- Les PDF scannés dépendent de la qualité de l'OCR.

## Déploiement (Scaleway Serverless Containers)

Le conteneur tourne sur Scaleway, en `fr-par`, avec `min_scale: 0` et `max_scale: 1`. Il écoute sur le port 8080.

Deux points ont coûté du temps et méritent d'être connus avant de redéployer :

- **`HOSTNAME=0.0.0.0` est obligatoire.** Le serveur standalone de Next lit `process.env.HOSTNAME` et l'utilise comme adresse d'écoute. Un conteneur renseigne `HOSTNAME` avec son propre identifiant, que le DNS de Scaleway ne résout pas : le conteneur démarre, écrit `Ready`, et n'écoute sur rien. Scaleway signale alors `Container is unable to start OR is not listening on port 8080`. Le nom d'hôte se résout quand on teste en local avec Podman, ce qui rend le diagnostic trompeur.
- **`PORT` est un nom réservé** et Scaleway refuse de le définir. Le port se règle par le champ `port` de la ressource, pas par l'environnement.

Le champ d'image de l'API s'appelle `image` (et non `registry_image`), et les limites s'expriment en `memory_limit_bytes` et `mvcpu_limit`. Le `timeout` est une durée au format protobuf, donc une chaîne comme `"300s"`.

La nomenclature du registre est `rg.<region>.scw.cloud/<espace>/<image>:<tag>`. Le pipeline utilise cette référence complète pour pousser l'image et pour renseigner le champ `image` du conteneur.

Le secret `ALBERT_API_KEY` est stocké comme variable d'environnement secrète : l'API le renvoie haché en argon2id, ce qui est le comportement attendu et non une corruption de la valeur.

## CI/CD

Le workflow `ci-cd.yml` exécute ESLint, TypeScript, les tests Vitest et le build Next.js sur chaque pull request et chaque push sur `main`. Sur `main`, le job `deploy` démarre seulement après la réussite de ces vérifications. Il construit et publie une image taguée `sha-<SHA complet du commit>`, met à jour le conteneur avec `scw container container update --wait`, vérifie l'image et l'état `ready` avec `scw container container get`, puis contrôle les réponses HTTP de `/`, `/embed` et `/embed.js`. Un dépassement de délai ou un échec de ces vérifications fait échouer le workflow.

L'action officielle `scaleway/action-scw` installe et configure le CLI Scaleway avec une version explicitement épinglée. Le pipeline n'appelle donc pas directement l'API Scaleway : seules les vérifications HTTP publiques utilisent `curl`.

Le déploiement requiert quatre secrets GitHub Actions, avec les noms idiomatiques Scaleway :

- `SCW_ACCESS_KEY` ;
- `SCW_SECRET_KEY` ;
- `SCW_ORGANIZATION_ID` ;
- `SCW_PROJECT_ID`.

Le déploiement utilise uniquement les secrets Scaleway. `ALBERT_API_KEY` reste configuré dans Scaleway pour l'application et séparément dans GitHub Actions pour le workflow de synchronisation du corpus ; il n'est pas nécessaire à la compilation ni aux tests.

---

✨ Contenu partiellement généré par une IA et vérifié par un agent.
