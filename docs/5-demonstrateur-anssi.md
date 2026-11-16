# Démonstrateur ANSSI

Cette page décrit le démonstrateur livré avec le dépôt : il interroge le corpus public des guides de l'ANSSI. Rien ici n'est nécessaire à un projet métier. Le démonstrateur sert de référence de fonctionnement et de banc d'essai pour les évolutions du widget.

## Citations et numéros de page

Le découpage automatique de l'API Albert ne conserve pas les numéros de page. L'ingestion découpe donc chaque PDF page par page et attache à chaque extrait les métadonnées de citation : `page`, `guide_id`, `guide_title`, `source_url`, `source_sha256`, `collection` et `extraction`.

L'URL de citation, le PDF suivi de `#page=N` qui ouvre le document à la bonne page, n'est pas stockée. Elle se déduit de `source_url` et de `page`, et `buildCitationUrl` est la seule fonction qui la construit.

Ces métadonnées sont conservées à l'indexation et restituées par `/v1/search`, ce qui permet au widget d'afficher une liste de sources cliquables sous chaque réponse.

## Extraction du texte et OCR

`pdftotext` est appelé une fois pour tout le document et son résultat est découpé sur les sauts de page. La décision de passer par l'OCR est prise page par page : une page dont la couche texte est trop pauvre est rendue en image (200 DPI, plus grand côté ramené à 1540 px) puis relue par l'OCR Albert (`openweight-ocr`, via `/v1/chat/completions`), qui renvoie du markdown. Les autres pages gardent leur texte d'origine. Un PDF mixte, avec certaines pages scannées, est donc indexé en entier. `extraction` vaut alors `mixed` au niveau du document, et `pdf` ou `ocr` au niveau de chaque extrait.

L'OCR est appelé page par page, et non sur le document entier : une page illisible ne coûte donc que cette page. Quand une page ne peut pas être lue, elle garde sa couche texte pauvre et le guide est indexé sans elle ; le sync la signale en avertissement (`pages non lues par l'OCR: 2, 5`) sans faire échouer la tâche planifiée.

Une page blanche est détectée avant l'appel et n'est pas envoyée au modèle. Sans ce contrôle, le modèle comble le vide par du texte inventé : la page 2, blanche, du guide sur le vote par Internet revenait sous la forme d'un gabarit de document en anglais (« Contributor A », « 123 Main St, Anytown, USA ») qui serait entré dans le corpus comme du contenu du guide. La détection est un rendu en niveaux de gris à basse résolution dont on compte les pixels sombres ; sur les 151 pages de ce guide, la page blanche mesure 0 et la page la plus claire 0,0047.

## Indexation initiale

Le catalogue est lu depuis `https://messervices.cyber.gouv.fr/api/guides`. Deux collections publiques sont alimentées, `anssi-guides-fr` et `anssi-guides-en`.

```bash
# Vérification à blanc de l'indexation initiale sur deux documents
pnpm ingest -- --language FR --limit 2 --dry-run

# Indexation initiale des deux langues
pnpm ingest -- --all --concurrency 3

# Vérifie que chaque collection renvoie des extraits avec page et URL de citation
pnpm verify:corpus
```

Le script `pnpm ingest` est réservé à l'alimentation initiale : il réutilise les collections existantes et ajoute des documents sans réconcilier les versions. Repartir de zéro suppose de supprimer les collections côté Albert.

Les identifiants des collections créées doivent être reportés dans `ALBERT_COLLECTION_FR` et `ALBERT_COLLECTION_EN`.

## Synchronisation du corpus français

`pnpm sync:anssi-fr` met à jour uniquement `anssi-guides-fr`. La collection anglaise et les documents sans métadonnées du corpus français ne sont pas modifiés.

```bash
# Télécharge les PDF et affiche les décisions, sans écrire dans Albert
pnpm sync:anssi-fr --dry-run

# Synchronisation effective
pnpm sync:anssi-fr --concurrency 2
```

La synchronisation identifie chaque PDF par le couple `guide_id` et `source_url`, car une fiche ANSSI peut contenir plusieurs documents. Elle inventorie toutes les pages de l'API Albert, puis télécharge chaque PDF du catalogue pour calculer son SHA-256 : le catalogue ne fournit pas cette empreinte. Chaque extrait porte `source_sha256` en plus des métadonnées de citation. Le dernier extrait indexé porte `sync_complete: true`, ce qui permet à l'exécution suivante de ne pas retenir une indexation interrompue. Comme Albert ne renvoie pas nécessairement cet extrait en dernier, l'inventaire parcourt les pages pour repérer ce marqueur.

Ce que fait la synchronisation selon le cas :

- empreinte et métadonnées identiques : le document est conservé sans extraction de texte, OCR, découpage ni réécriture Albert
- nouveau PDF : il est indexé
- PDF ou titre modifié : il est réindexé dans un nouveau document, et l'ancienne version n'est supprimée qu'après l'écriture complète de la nouvelle
- document géré absent du catalogue, ou doublon : il est supprimé
- document sans `guide_id`, `source_url` ou `collection: FR` exploitable : il est préservé
- document historique sans empreinte : il est réindexé une première fois pour le migrer, puis laissé tel quel lors des exécutions suivantes

Une erreur de téléchargement, d'extraction, d'OCR ou d'indexation conserve l'ancienne version du guide concerné. Le bilan signale chaque échec et la commande se termine en erreur.

Le workflow `anssi-sync.yml` exécute cette commande chaque jour à 04:17 UTC et sérialise les exécutions. Il ne redéploie pas le widget. Une exécution manuelle depuis l'onglet Actions utilise le mode simulation par défaut ; décocher `dry_run` permet une synchronisation réelle. Le secret GitHub Actions `ALBERT_API_KEY` est requis.

## Limites du démonstrateur

La synchronisation doit télécharger chaque PDF pour détecter un changement de contenu, mais seuls les documents modifiés sont extraits et réindexés.

Les PDF scannés dépendent de la qualité de l'OCR.

---

✨ Contenu partiellement généré par une IA et vérifié par un agent.
