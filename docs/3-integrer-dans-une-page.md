# Intégrer dans une page

Le widget existe en deux modes. L'**iframe** charge une page du service dans un cadre : elle sépare le DOM, les styles et le stockage de la page hôte. Le **Web Component** s'insère directement dans le DOM de la page : plus léger à intégrer, mais il partage les privilèges JavaScript de l'hôte.

Recommandation pour un premier déploiement : prendre l'iframe, qui isole davantage. Le Web Component se justifie quand la page hôte impose une intégration sans cadre, ou quand le widget doit partager le contexte visuel de la page.

## Iframe

```html
<script src="https://<hote>/embed.js" referrerpolicy="strict-origin-when-cross-origin" defer></script>
```

Remplacez `<hote>` par l'adresse du service. Le script crée l'iframe avec les attributs de sécurité décrits ci-dessous, puis écoute ses messages pour l'agrandir ou la réduire. Il fonctionne aussi bien dans `<head>` que dans `<body>` et ne crée qu'une seule iframe si la balise est chargée deux fois.

Deux réglages côté serveur complètent l'intégration.

**Le service n'accepte d'être affiché que par les origines autorisées**, `'self'` plus celles listées dans `EMBED_ALLOWED_PARENTS`. Le contrôle passe par l'en-tête `Content-Security-Policy: frame-ancestors` sur `/embed`, et une page non listée reçoit un cadre vide. La liste est lue au chargement de la configuration, donc un redéploiement est nécessaire pour la modifier.

**La page hôte doit autoriser le service** dans ses propres règles `script-src`, pour charger `/embed.js`, et `frame-src`, pour afficher `/embed`. L'intégration ne demande aucun script en ligne.

### Redimensionnement et référent

Le redimensionnement évite `postMessage(..., "*")` : le widget adresse son message à l'origine du parent, qu'il lit dans `document.referrer`. C'est la raison du `referrerpolicy="strict-origin-when-cross-origin"` sur l'iframe. Pour une page hôte sur un autre domaine, le navigateur ne transmet que l'origine, jamais le chemin ni les paramètres. Pour une page de même origine, le widget n'a rien de plus à savoir.

L'attribut est aussi présent sur la balise `script`, afin d'appliquer la même règle à la requête `/embed.js`. Si la page hôte impose `referrerpolicy="no-referrer"`, le référent est vide et le message retombe sur `"*"` : il ne contient alors que l'état ouvert ou fermé du panneau.

### Limites de la liste d'origines

La liste des parents est volontairement limitée à des origines nues. Une entrée avec un chemin ou une requête ne restreindrait pas `frame-ancestors` comme elle en a l'air. Un joker (`https://*.exemple.gouv.fr`) serait accepté par l'en-tête mais jamais reconnu par le widget, qui compare des origines entières. Ces entrées sont écartées au chargement : il faut lister chaque page hôte.

## Web Component sans iframe

```html
<script type="module" src="https://<hote>/widget.js"></script>
<albert-chat api-url="https://<hote>/api/chat"></albert-chat>
```

Le navigateur n'a besoin d'aucun framework installé : `widget.js` embarque React, ReactDOM et assistant-ui, sans Next.js ni DSFR. Il charge `widget.css` à côté de son propre fichier et place le panneau et ses styles dans un Shadow DOM. Les deux fichiers et `widget.js.LEGAL.txt` sont générés par `pnpm dev` et `pnpm build`, puis inclus dans l'image.

Pour les auto-héberger, copier ces trois fichiers ensemble, conserver les mentions de licence et renseigner explicitement `api-url` vers le serveur du service. Sans attribut, l'API est `/api/chat` sur l'origine du script.

### Configuration côté serveur

Configurer `WIDGET_ALLOWED_ORIGINS` avec les origines hôtes autorisées, séparées par des virgules, au démarrage du service. Une modification exige un redémarrage, pas un rebuild. Aucun joker ni origine opaque `null` n'est accepté. Les appels de même origine fonctionnent sans configuration.

Les fichiers publics `widget.js` et `widget.css` autorisent le chargement depuis toute origine, sans cookies : ils ne contiennent aucun secret. Cette ouverture ne donne pas accès à l'API. La page hôte doit autoriser le service dans `script-src`, `style-src` et `connect-src` ; `frame-src` n'est pas nécessaire. L'API autorise uniquement les pré-vérifications CORS pour POST avec `Content-Type`, sans cookies ni en-tête d'authentification. Les erreurs et `Retry-After` restent lisibles par les hôtes autorisés.

### Comportement de l'élément

`api-url` accepte une URL HTTP(S), relative à la page ou absolue, sans identifiants ni fragment. Changer cet attribut ou retirer l'élément annule la requête active et réinitialise la conversation. Le même élément peut être réinséré. Les événements `open-change` (`detail.open`) et `widget-error` (`detail.message`) remontent vers la page ; ne pas y transmettre de secrets. Éviter plusieurs assistants flottants sur une même page : ils occupent le même coin de fenêtre.

### Différence de sécurité avec l'iframe

Le Shadow DOM isole les styles, pas les privilèges JavaScript. Le composant s'exécute avec ceux de la page hôte et n'a ni sandbox, ni politique de permissions propre. Utiliser une version revue et maîtrisée par l'intégrateur, idéalement auto-hébergée : une URL distante mutable implique de faire confiance à chaque mise à jour. Les contrôles CORS ne sont pas une authentification et ne remplacent pas les plafonds serveur. L'iframe sur une origine distincte reste l'option qui sépare les DOM et les stockages d'origine.

Le composant React partagé `AssistantModal` accepte également `apiUrl`. Il est utilisé directement par les deux modes, mais aucun paquet npm React n'est publié à ce stade. Dans une application React, ses dépendances et styles doivent être intégrés par l'application, et les portails doivent rester dans le conteneur stylé.

## Vérifier l'intégration dans un navigateur

```bash
pnpm exec playwright install chromium
pnpm build
pnpm test:browser
```

Les tests utilisent uniquement des réponses simulées ou des requêtes invalides, sans appeler Albert. Le serveur de test autorise uniquement l'origine de la page HTML de test, qui interdit les iframes et applique des styles hostiles pour vérifier le bundle distribué. Ils couvrent les citations, l'échappement du texte, les portails, le démontage, la validation d'URL et le changement de mode. Cette origine de test n'est pas à ajouter à la configuration de production.

La comparaison de même origine utilise l'en-tête `Host` et le protocole externe `X-Forwarded-Proto` fourni par le reverse proxy ; celui-ci doit maîtriser ces en-têtes. Ce contrôle n'est pas une authentification.

Suite : [4. Sécurité et limites](4-securite-et-limites.md)

---

✨ Contenu partiellement généré par une IA et vérifié par un agent.
