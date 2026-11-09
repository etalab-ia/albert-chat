"use client";

import { fr } from "@codegouvfr/react-dsfr";
import { Alert } from "@codegouvfr/react-dsfr/Alert";
import { Button } from "@codegouvfr/react-dsfr/Button";
import { SegmentedControl } from "@codegouvfr/react-dsfr/SegmentedControl";
import { useCallback, useEffect, useRef, useState } from "react";
import { EmbedFrame } from "./embed-frame";

type IntegrationMode = "iframe" | "web-component";

const IFRAME_SNIPPET = `<script src="https://<votre-hote>/embed.js" referrerpolicy="strict-origin-when-cross-origin" defer></script>`;

const WEB_COMPONENT_SNIPPET = `<script type="module" src="https://<votre-hote>/widget.js"></script>
<albert-chat api-url="https://<votre-hote>/api/chat"></albert-chat>`;

/** Custom element registered by the public `/widget.js` module. */
const WIDGET_TAG = "albert-chat";
const WIDGET_SCRIPT_SRC = "/widget.js";
/** Marks the module tag this page appends, so a remount reuses it. */
const WIDGET_SCRIPT_FLAG = "data-anssi-widget-module";

/**
 * Resolves once `/widget.js` has registered `<albert-chat>`. Module-level so the
 * script stays loaded across mode switches: a later switch reuses the
 * definition instead of fetching the bundle again.
 */
let widgetDefinition: Promise<void> | null = null;

function appendWidgetScript(): HTMLScriptElement {
	const script = document.createElement("script");
	script.type = "module";
	script.src = WIDGET_SCRIPT_SRC;
	script.setAttribute(WIDGET_SCRIPT_FLAG, "");
	document.head.appendChild(script);
	return script;
}

/**
 * Loads `/widget.js` as a plain module tag rather than a bundler import: the
 * Next build must not pull the standalone bundle into its own chunks.
 */
function ensureWidgetDefinition(): Promise<void> {
	if (customElements.get(WIDGET_TAG)) return Promise.resolve();
	if (widgetDefinition) return widgetDefinition;

	// Append once: a tag still in flight is reused instead of duplicated.
	const script =
		document.querySelector<HTMLScriptElement>(
			`script[${WIDGET_SCRIPT_FLAG}]`,
		) ?? appendWidgetScript();

	widgetDefinition = new Promise<void>((resolve, reject) => {
		const fail = (message: string) => {
			// A settled tag fires no further events: remove it so a retry
			// appends a fresh one instead of waiting on a dead element.
			script.remove();
			reject(new Error(message));
		};

		script.addEventListener(
			"error",
			() => fail(`Le script ${WIDGET_SCRIPT_SRC} n'a pas pu être chargé.`),
			{ once: true },
		);

		script.addEventListener(
			"load",
			() => {
				// A module script has finished evaluating when `load` fires. If
				// the tag is still undefined here, `whenDefined` below would
				// never settle: fail now rather than wait indefinitely.
				if (!customElements.get(WIDGET_TAG)) {
					fail(
						`Le script ${WIDGET_SCRIPT_SRC} ne définit pas l'élément <${WIDGET_TAG}>.`,
					);
				}
			},
			{ once: true },
		);

		customElements.whenDefined(WIDGET_TAG).then(() => resolve(), reject);
	});

	// A failed load must not poison later attempts: drop the cache so the next
	// call appends a fresh script tag.
	widgetDefinition.catch(() => {
		widgetDefinition = null;
	});

	return widgetDefinition;
}

/**
 * Landing-page section for host integrations: choose between the iframe
 * loader (`/embed.js`) and the web component (`/widget.js`), copy the matching
 * snippet, and try the selected mode live. Exactly one widget is mounted at a
 * time; switching modes unmounts it, which also resets the conversation.
 */
export function IntegrationDemo() {
	const [mode, setMode] = useState<IntegrationMode>("iframe");
	const [loadError, setLoadError] = useState<string | null>(null);
	const hostRef = useRef<HTMLDivElement | null>(null);
	/** Bumped on every attempt and cleanup: stale attempts must not act. */
	const attemptRef = useRef(0);

	const mountWebComponent = useCallback(() => {
		const host = hostRef.current;
		if (!host) return;

		const attempt = ++attemptRef.current;
		setLoadError(null);

		ensureWidgetDefinition().then(
			() => {
				if (attempt !== attemptRef.current || !host.isConnected) return;
				// Created imperatively: the element owns its shadow content, so
				// React never manages the widget's children.
				const widget = document.createElement(WIDGET_TAG);
				widget.setAttribute("api-url", "/api/chat");
				host.replaceChildren(widget);
			},
			(error) => {
				if (attempt !== attemptRef.current) return;
				setLoadError(
					error instanceof Error
						? error.message
						: "Erreur inconnue pendant le chargement du composant.",
				);
			},
		);
	}, []);

	useEffect(() => {
		if (mode !== "web-component") return;

		mountWebComponent();
		const host = hostRef.current;

		return () => {
			// Cancel any pending mount, then let the custom element's own
			// lifecycle clean up once the element is removed.
			attemptRef.current += 1;
			host?.replaceChildren();
		};
	}, [mode, mountWebComponent]);

	return (
		<>
			<SegmentedControl
				name="integration-mode"
				legend="Mode d'intégration"
				hintText="L'assistant en bas à droite suit le sélecteur ; changer de mode remet la conversation à zéro."
				segments={[
					{
						label: "Iframe",
						nativeInputProps: {
							checked: mode === "iframe",
							onChange: () => setMode("iframe"),
						},
					},
					{
						label: "Web Component",
						nativeInputProps: {
							checked: mode === "web-component",
							onChange: () => setMode("web-component"),
						},
					},
				]}
			/>

			{mode === "web-component" && loadError !== null && (
				<>
					<Alert
						severity="error"
						title="Le web component n'a pas pu être chargé"
						description={loadError}
						className={fr.cx("fr-mt-2w")}
					/>
					<Button
						priority="secondary"
						size="small"
						onClick={mountWebComponent}
						className={fr.cx("fr-mt-1w")}
					>
						Réessayer
					</Button>
				</>
			)}

			{/* The box is the <pre> and the <code> stays a plain block inside
                it. Padding on an inline <code> does not grow the <pre>, so
                styling the inner element left the text spilling over its own
                background. */}
			<pre className="mt-3w overflow-x-auto rounded border border-[var(--border-default-grey)] bg-[var(--background-alt-grey)] p-4 font-mono text-[0.8125rem] leading-relaxed text-[var(--text-default-grey)]">
				<code className="block whitespace-pre-wrap break-words">
					{mode === "iframe" ? IFRAME_SNIPPET : WEB_COMPONENT_SNIPPET}
				</code>
			</pre>

			<p className={fr.cx("fr-mt-3w")}>
				Remplacez <code>&lt;votre-hote&gt;</code> par l&apos;adresse du service.
				La clé de l&apos;API Albert reste sur le serveur : elle n&apos;apparaît
				jamais dans la page.
			</p>

			{mode === "iframe" ? <IframeExplanation /> : <WebComponentExplanation />}

			{/* Montage du mode choisi, hors de la partie texte : l'assistant occupe
			    le coin en bas à droite de la fenêtre, et un seul rendu est actif à
			    la fois. */}
			{mode === "iframe" ? <EmbedFrame /> : <div ref={hostRef} />}
		</>
	);
}

function IframeExplanation() {
	return (
		<>
			<h3 className={fr.cx("fr-mt-4w", "fr-h6")}>
				Ce que le script met en place
			</h3>
			<p>
				Le script crée une iframe aux droits limités, puis l&apos;agrandit quand
				la fenêtre s&apos;ouvre.
			</p>
			<ul>
				<li>
					<code>sandbox</code> : le cadre exécute le widget et ouvre les PDF
					cités, mais ne peut pas naviguer à la place de la page hôte, ni lui
					substituer une autre adresse.
				</li>
				<li>
					<code>allow</code> : la caméra, le microphone et la position sont
					refusés. L&apos;assistant n&apos;en a pas besoin.
				</li>
				<li>
					<code>referrerpolicy</code> : la page hôte ne transmet que son adresse
					d&apos;origine au service, jamais le chemin ni les paramètres.
				</li>
				<li>
					Le script n&apos;accepte un message de redimensionnement que s&apos;il
					vient du cadre qu&apos;il a créé, et vérifie son origine et sa forme.
				</li>
			</ul>
			<p>
				La sandbox encadre le contenu de l&apos;iframe, pas le script
				d&apos;intégration : <code>embed.js</code> s&apos;exécute dans la page
				hôte, avec ses privilèges. Une page n&apos;intègre le widget que si elle
				fait confiance au service qui le fournit.
			</p>
			<p>
				Deux réglages décident qui peut afficher quoi. Le service n&apos;accepte
				d&apos;être affiché que par les origines listées dans{" "}
				<code>EMBED_ALLOWED_PARENTS</code> (en-tête <code>frame-ancestors</code>
				). La page hôte doit autoriser le service dans ses propres règles{" "}
				<code>script-src</code>, pour charger le script, et{" "}
				<code>frame-src</code>, pour afficher le cadre.
			</p>
			<p>
				Servi depuis un autre domaine que la page hôte, le cadre est une origine
				distincte : le navigateur lui interdit les cookies et le stockage de la
				page. Sur ce démonstrateur, les deux partagent la même origine.
			</p>
		</>
	);
}

function WebComponentExplanation() {
	return (
		<>
			<h3 className={fr.cx("fr-mt-4w", "fr-h6")}>
				Ce que le web component met en place
			</h3>
			<p>
				L&apos;élément <code>{WIDGET_TAG}</code> rend l&apos;assistant
				directement dans la page hôte, sans iframe : le bouton et la fenêtre
				sont des éléments de la page, dans un Shadow DOM.
			</p>
			<ul>
				<li>
					Le script s&apos;exécute avec les privilèges de la page hôte :
					c&apos;est du code auquel la page doit faire confiance, comme
					n&apos;importe quelle dépendance.
				</li>
				<li>
					Le Shadow DOM sépare les règles CSS internes de celles de la page,
					mais ce n&apos;est pas un bac à sable de sécurité : le JavaScript du
					widget tourne dans la page.
				</li>
			</ul>
			<p>
				Le service refuse par défaut les origines non configurées : listez
				l&apos;origine de la page hôte dans <code>WIDGET_ALLOWED_ORIGINS</code>{" "}
				pour autoriser ses appels à <code>/api/chat</code> (CORS). La page hôte
				doit de son côté autoriser le service dans ses règles{" "}
				<code>script-src</code>, pour charger <code>widget.js</code>,{" "}
				<code>style-src</code>, pour ses styles, et <code>connect-src</code>,
				pour appeler l&apos;API. Sur ce démonstrateur, l&apos;API est appelée
				sur la même origine : ces réglages ne concernent qu&apos;une page hôte
				distante.
			</p>
		</>
	);
}
