import { createRoot, type Root } from "react-dom/client";
import { AssistantModal } from "../components/widget/assistant-modal";

const assetBase = new URL(".", import.meta.url);
const defaultApiUrl = new URL("/api/chat", assetBase).href;

function apiUrlFor(value: string | null): string {
	const url = new URL(value || defaultApiUrl, document.baseURI);
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.hash
	) {
		throw new Error(
			"api-url doit être une URL HTTP(S) sans identifiants ni fragment.",
		);
	}
	return url.href;
}

/** Direct React integration. Shadow DOM contains CSS, not security privileges. */
export class AlbertChat extends HTMLElement {
	static observedAttributes = ["api-url"];
	#root: Root | null = null;
	#lifetime: AbortController | null = null;
	#mount: HTMLDivElement;
	#portal: HTMLDivElement;
	#stylesheet: HTMLLinkElement;
	#stylesReady = false;

	constructor() {
		super();
		const shadow = this.attachShadow({ mode: "open" });
		this.#stylesheet = document.createElement("link");
		this.#stylesheet.rel = "stylesheet";
		this.#stylesheet.href = new URL("widget.css", assetBase).href;
		this.#stylesheet.addEventListener("load", () => {
			this.#stylesReady = true;
			this.#render();
		});
		this.#stylesheet.addEventListener("error", () =>
			this.#fail("Le style du widget n'a pas pu être chargé."),
		);
		this.#mount = document.createElement("div");
		this.#portal = document.createElement("div");
		shadow.append(this.#stylesheet, this.#mount, this.#portal);
	}

	connectedCallback() {
		this.#render();
	}

	disconnectedCallback() {
		this.#dispose();
	}

	attributeChangedCallback(
		_name: string,
		oldValue: string | null,
		newValue: string | null,
	) {
		if (oldValue === newValue) return;
		this.#dispose();
		this.#render();
	}

	#dispose() {
		this.#lifetime?.abort();
		this.#lifetime = null;
		this.#root?.unmount();
		this.#root = null;
	}

	#fail(message: string) {
		this.#dispose();
		this.#mount.textContent = message;
		this.#mount.setAttribute("role", "alert");
		this.dispatchEvent(
			new CustomEvent("widget-error", {
				detail: { message },
				bubbles: true,
				composed: true,
			}),
		);
	}

	#render() {
		if (!this.isConnected || !this.#stylesReady || this.#root) return;
		let apiUrl: string;
		try {
			apiUrl = apiUrlFor(this.getAttribute("api-url"));
		} catch (error) {
			this.#fail(error instanceof Error ? error.message : "api-url invalide.");
			return;
		}
		this.#mount.textContent = "";
		this.#mount.removeAttribute("role");
		this.#lifetime = new AbortController();
		this.#root = createRoot(this.#mount);
		this.#root.render(
			<AssistantModal
				apiUrl={apiUrl}
				portalContainer={this.#portal}
				lifetimeSignal={this.#lifetime.signal}
				onOpenChange={(open) =>
					this.dispatchEvent(
						new CustomEvent("open-change", {
							detail: { open },
							bubbles: true,
							composed: true,
						}),
					)
				}
			/>,
		);
	}
}

/** The tag a host page writes. Renaming it is a breaking change for embedders. */
export const WIDGET_TAG = "albert-chat";

if (!customElements.get(WIDGET_TAG))
	customElements.define(WIDGET_TAG, AlbertChat);
