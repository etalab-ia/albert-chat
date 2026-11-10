# Préparer son corpus

Le widget ne prépare aucun document : il interroge une collection déjà alimentée dans l'API Albert, et affiche des citations à partir des métadonnées de chaque extrait. Cette page décrit ce que le projet doit fournir, ce que le widget attend des extraits, et comment vérifier la configuration avant de déployer.

## Ce que le projet fournit

1. Une ou plusieurs collections dans l'API Albert, alimentées par les scripts d'ingestion du projet.
2. Une clé `ALBERT_API_KEY` propre au projet, côté serveur.
3. Les identifiants de ces collections, dans `ALBERT_COLLECTION_IDS`.
4. Un hébergement Next.js et, si le widget s'affiche dans une page hôte, deux variables d'intégration : `EMBED_ALLOWED_PARENTS` et `WIDGET_ALLOWED_ORIGINS`.

L'ingestion reste hors de ce dépôt. Les scripts qui préparent les documents, découpent les PDF et écrivent les métadonnées vivent dans le dépôt du projet métier : ils dépendent des formats, du vocabulaire et du rythme de mise à jour propres à chaque corpus.

## Contrat attendu sur les extraits

Le widget lit les métadonnées de chaque extrait. Seul le contenu est obligatoire.

| Champ         | Statut     | Effet                                                                                                                                        |
| ------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`       | recommandé | Titre affiché pour la source. À défaut, `guide_title` puis `Document <id>`.                                                                  |
| `source_url`  | optionnel  | Lien cliquable, utilisé seulement si c'est une URL absolue `http(s)`. Un lien absent ou invalide n'empêche pas la citation.                  |
| `page_number` | optionnel  | Numéro de page affiché et ajouté au fragment `#page=` du lien. Entier strictement positif. `page` reste accepté pour le démonstrateur ANSSI. |

Un extrait sans `source_url` reste utilisable : il alimente la réponse et s'affiche comme citation sans lien. Un corpus sans pagination fiable doit donc omettre `page_number` plutôt que d'inventer un numéro, car un lien qui ouvre le document à la mauvaise page est pire qu'un lien qui ouvre le document.

L'URL de citation n'est pas stockée. Elle se déduit de `source_url` et de `page_number`, et `buildCitationUrl` est la seule fonction qui la construit. Un seul champ de vérité, donc pas d'URL incohérente entre l'index et l'affichage.

## Regroupement des citations

Deux extraits qui partagent une même page forment une seule citation, pour éviter une liste de sources répétitives. Un extrait sans numéro de page n'est jamais regroupé : sans page, regrouper tronquerait des passages sans rapport.

## Vérifier la configuration

```bash
# Lit les variables de l'environnement
pnpm check:config

# Ou depuis un fichier, sans exposer la clé sur la ligne de commande
pnpm check:config -- --env-file .env.production
```

La commande valide la configuration avec le même code que le widget, puis vérifie que la clé atteint chaque collection et qu'elle renvoie du contenu citable. Elle est strictement en lecture seule : elle n'appelle que `/v1/search`, sans création, modification ni suppression. Elle échoue si la configuration est invalide, si la clé est refusée, ou si une collection ne renvoie aucun extrait citable.

## Ce que `check:config` vérifie, et ce qu'il ne vérifie pas

La commande établit que la clé est acceptée, que chaque identifiant de collection existe et que les extraits renvoyés contiennent du texte affichable. Elle ne dit rien de la qualité du corpus.

La recherche hybride d'Albert renvoie des résultats pour n'importe quelle requête, y compris hors sujet : le widget n'applique aucun seuil de score. Une collection sans rapport avec les questions posées passera donc le contrôle. Un succès prouve le câblage, pas l'adéquation du corpus.

Pour juger de l'adéquation, interroger le widget avec quelques questions réelles. Si les extraits ne couvrent pas le sujet, la réponse le dit explicitement plutôt que d'inventer. C'est le comportement attendu, mais il ne remplace pas un corpus adapté.

## Décisions à prendre avant la mise en ligne

- **Public visé.** Le widget n'a pas d'authentification : toute personne qui connaît l'URL peut interroger le corpus, dans la limite des plafonds. Le rendre public est une décision de publication.
- **Clé dédiée.** Utiliser une clé propre au projet plutôt qu'une clé personnelle, et ne jamais l'exposer au navigateur.
- **Mise à jour du corpus.** Les documents peuvent changer sans redéployer le widget. En revanche, changer la liste des collections ou les variables d'environnement demande un redéploiement.
- **Liste vide refusée.** Une liste de collections vide arrête le démarrage. C'est volontaire : l'API Albert interpréterait une liste vide comme « toutes les collections accessibles », donc un corpus que le projet n'a pas choisi.

Suite : [2. Déployer](2-deployer.md)

---

✨ Contenu partiellement généré par une IA et vérifié par un agent.
