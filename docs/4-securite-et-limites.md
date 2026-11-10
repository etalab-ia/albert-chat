# Sécurité et limites

Cette page décrit ce que le widget protège, ce qu'il ne protège pas, et les limites connues du service actuel. Elle sert à décider si le widget peut être publié, et à quel public.

## Ce qui protège la clé Albert

La clé Albert reste côté serveur. Seule la route `/api/chat` la lit, et elle n'est jamais incluse dans un bundle client. Le navigateur ne reçoit que les réponses du service.

## Ce qui protège la page hôte

L'iframe est confinée par `sandbox` : scripts et origine sont autorisés, car le widget en a besoin pour appeler `/api/chat` et ouvrir les PDF cités dans un nouvel onglet. En revanche, ni navigation de la fenêtre hôte, ni formulaires, ni fenêtres modales, ni téléchargements. Sur une page hôte d'un autre domaine, du code exécuté dans `/embed` ne peut donc ni rediriger l'utilisateur ni recouvrir l'interface.

Sur la page de démonstration, l'iframe est de même origine. Un bac à sable ne sépare pas deux documents de même origine : c'est le domaine distinct qui apporte cette séparation.

Les API de l'appareil sont refusées deux fois : par l'attribut `allow` de l'iframe et par l'en-tête `Permissions-Policy` du service. La liste couvre la caméra, le micro, la position, la capture d'écran, la lecture du presse-papiers, le paiement, l'USB et les autres interfaces. Sans ce double refus, une iframe de même origine hériterait des droits de la page hôte.

## En-têtes envoyés par le service

- `/embed` porte `frame-ancestors`, qui nomme les origines autorisées à l'afficher.
- `/` porte `frame-ancestors 'none'` et `frame-src 'self'` : la page de démonstration ne se laisse pas encadrer et n'encadre que son propre widget.
- Toutes les routes portent `X-Content-Type-Options: nosniff` et `Referrer-Policy: strict-origin-when-cross-origin`.

## Ce que le chargeur ne protège pas

`/embed.js` s'exécute dans l'origine de la page hôte, en dehors de la sandbox de l'iframe. La page doit donc faire confiance au service qui fournit ce script : la sandbox ne protège pas contre une compromission du chargeur lui-même.

Les messages de redimensionnement sont filtrés des deux côtés. La page hôte vérifie `event.source` et `event.origin` ainsi que la forme du message, et le widget adresse son message à une origine précise plutôt qu'à `"*"`.

Une politique de sécurité du contenu (CSP) complète, couvrant les scripts et les styles, reste à écrire. Le bootstrap DSFR utilise un script en ligne, qui demande soit un nonce par requête, soit un rendu dynamique. Les règles en place ne couvrent que l'encadrement.

## Validation des requêtes et plafonds anti-abus

La route `/api/chat` valide la requête avant tout appel amont : longueur de la question et taille de l'historique sont bornées.

Deux plafonds protègent ensuite la route : 10 questions par minute et par client, et 500 questions par jour pour l'ensemble du service. Les deux refusent avec un code 429 avant tout appel amont, donc une salve coûte une réponse JSON et non une recherche plus une complétion. Les plafonds se règlent par `ABUSE_MAX_PER_CLIENT`, `ABUSE_CLIENT_WINDOW_MS` et `ABUSE_MAX_PER_DAY`.

Le plafond par client s'appuie sur `X-Real-IP` puis sur la première adresse `X-Forwarded-For`. Ces en-têtes sont contrôlés par le client lorsque le service est joignable directement : c'est une mesure d'équité, pas une authentification. Le plafond quotidien, lui, borne réellement le coût total.

Les documents ouverts par les citations le sont avec `rel="noopener noreferrer"`.

## Limites connues du service actuel

- **Pas d'authentification sur `/api/chat`.** Toute personne qui connaît l'URL peut poser des questions, dans la limite des plafonds.
- **Les compteurs des plafonds vivent en mémoire du processus.** Ils sont donc propres à chaque instance. Un déploiement sur plusieurs instances multiplierait la limite effective par le nombre d'instances, et demanderait un stockage partagé.
- **L'historique de conversation reste dans le navigateur.** Un rechargement le perd.
- **`check:config` ne juge pas le corpus.** La commande prouve le câblage, pas l'adéquation des documents aux questions posées. Voir [1. Préparer son corpus](1-preparer-son-corpus.md).
- **Le corpus interrogé est le même pour tous.** Il n'y a ni filtrage par utilisateur, ni gestion de droits.

---

✨ Contenu partiellement généré par une IA et vérifié par un agent.
