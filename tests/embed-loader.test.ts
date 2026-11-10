import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const loader = readFileSync(
	new URL("../public/embed.js", import.meta.url),
	"utf8",
);
const WIDGET_ORIGIN = "https://widget.example";

type FakeMessage = {
	origin: string;
	source: unknown;
	data: unknown;
};

type FakeFrame = {
	src: string;
	title: string;
	style: Record<string, string>;
	contentWindow: Record<string, never>;
	isConnected: boolean;
	remove: () => void;
	setAttribute: (name: string, value: string) => void;
	getAttribute: (name: string) => string | null;
};

function createFrame(): FakeFrame {
	const attributes = new Map<string, string>();
	return {
		src: "",
		title: "",
		style: {},
		contentWindow: {},
		isConnected: false,
		remove() {
			this.isConnected = false;
		},
		setAttribute(name, value) {
			attributes.set(name, value);
		},
		getAttribute(name) {
			return attributes.get(name) ?? null;
		},
	};
}

function createHarness({
	readyState = "complete",
	scriptSrc = `${WIDGET_ORIGIN}/embed.js`,
	autoMount = true,
}: {
	readyState?: string;
	scriptSrc?: string;
	autoMount?: boolean;
} = {}) {
	const frames: FakeFrame[] = [];
	const messageListeners = new Set<(event: FakeMessage) => void>();
	const domContentLoadedListeners = new Set<() => void>();

	const document = {
		currentScript: {
			src: scriptSrc,
			dataset: { anssiAutoMount: String(autoMount) },
		},
		readyState,
		createElement(tagName: string) {
			if (tagName !== "iframe")
				throw new Error(`Unexpected element: ${tagName}`);
			return createFrame();
		},
		querySelector(selector: string) {
			if (selector !== "iframe[data-anssi-widget]") {
				throw new Error(`Unexpected selector: ${selector}`);
			}
			return (
				frames.find(
					(frame) =>
						frame.isConnected &&
						frame.getAttribute("data-anssi-widget") !== null,
				) ?? null
			);
		},
		body: {
			appendChild(frame: FakeFrame) {
				frame.isConnected = true;
				frames.push(frame);
				return frame;
			},
		},
		addEventListener(type: string, listener: () => void) {
			if (type !== "DOMContentLoaded")
				throw new Error(`Unexpected event: ${type}`);
			domContentLoadedListeners.add(listener);
		},
		removeEventListener(type: string, listener: () => void) {
			if (type !== "DOMContentLoaded")
				throw new Error(`Unexpected event: ${type}`);
			domContentLoadedListeners.delete(listener);
		},
	};

	const window = {
		__anssiWidget: undefined as
			| { mount: () => void; destroy: () => void }
			| undefined,
		addEventListener(type: string, listener: (event: FakeMessage) => void) {
			if (type !== "message") throw new Error(`Unexpected event: ${type}`);
			messageListeners.add(listener);
		},
		removeEventListener(type: string, listener: (event: FakeMessage) => void) {
			if (type !== "message") throw new Error(`Unexpected event: ${type}`);
			messageListeners.delete(listener);
		},
	};

	return {
		frames,
		activeFrames() {
			return frames.filter((frame) => frame.isConnected);
		},
		controller() {
			const controller = window.__anssiWidget;
			if (!controller) throw new Error("Loader controller not initialized");
			return controller;
		},
		load() {
			vm.runInNewContext(loader, { window, document, URL });
		},
		emitDOMContentLoaded() {
			document.readyState = "complete";
			const listeners = [...domContentLoadedListeners];
			domContentLoadedListeners.clear();
			for (const listener of listeners) listener();
		},
		domContentLoadedListenerCount() {
			return domContentLoadedListeners.size;
		},
		emitMessage(event: FakeMessage) {
			for (const listener of messageListeners) listener(event);
		},
		messageListenerCount() {
			return messageListeners.size;
		},
	};
}

function resizeMessage(open: boolean) {
	return { source: "anssi-widget", type: "resize", open };
}

describe("embed loader", () => {
	it("creates the confined iframe from the script URL", () => {
		const harness = createHarness();
		harness.load();

		expect(harness.frames).toHaveLength(1);
		const frame = harness.frames[0];
		expect(frame.src).toBe(`${WIDGET_ORIGIN}/embed`);
		expect(frame.title).toBe("Assistant ANSSI");
		expect(frame.getAttribute("sandbox")).toBe(
			"allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox",
		);
		expect(frame.getAttribute("allow")).toBe(
			"camera 'none'; microphone 'none'; geolocation 'none'",
		);
		expect(frame.getAttribute("referrerpolicy")).toBe(
			"strict-origin-when-cross-origin",
		);
		expect(frame.style).toMatchObject({
			position: "fixed",
			// Flush to the corner: the widget inside the frame applies its own
			// 16px inset, so insetting the frame too moved the launcher.
			right: "0",
			bottom: "0",
			width: "88px",
			height: "88px",
			border: "0",
			zIndex: "50",
		});
	});

	it("waits for the body when loaded during document parsing", () => {
		const harness = createHarness({ readyState: "loading" });
		harness.load();
		expect(harness.frames).toHaveLength(0);

		harness.emitDOMContentLoaded();
		expect(harness.frames).toHaveLength(1);
		expect(harness.messageListenerCount()).toBe(1);
	});

	it("does not duplicate the frame or its listener when loaded twice", () => {
		const harness = createHarness();
		harness.load();
		harness.load();

		expect(harness.frames).toHaveLength(1);
		expect(harness.messageListenerCount()).toBe(1);
	});

	it("resizes only for valid messages from its own frame and origin", () => {
		const harness = createHarness();
		harness.load();
		const frame = harness.frames[0];
		const validEvent = {
			origin: WIDGET_ORIGIN,
			source: frame.contentWindow,
		};

		harness.emitMessage({ ...validEvent, data: resizeMessage(true) });
		expect(frame.style).toMatchObject({ width: "420px", height: "620px" });

		const invalidEvents: FakeMessage[] = [
			{
				origin: "https://attacker.example",
				source: frame.contentWindow,
				data: resizeMessage(false),
			},
			{ origin: WIDGET_ORIGIN, source: {}, data: resizeMessage(false) },
			{ ...validEvent, data: null },
			{ ...validEvent, data: "resize" },
			{ ...validEvent, data: { ...resizeMessage(false), source: "other" } },
			{ ...validEvent, data: { ...resizeMessage(false), type: "other" } },
			{ ...validEvent, data: { ...resizeMessage(false), open: "false" } },
		];
		for (const event of invalidEvents) harness.emitMessage(event);
		expect(frame.style).toMatchObject({ width: "420px", height: "620px" });

		harness.emitMessage({ ...validEvent, data: resizeMessage(false) });
		expect(frame.style).toMatchObject({ width: "88px", height: "88px" });
	});

	it("uses the script origin, including a non-default port", () => {
		const origin = "https://widget.example:8443";
		const harness = createHarness({
			scriptSrc: `${origin}/assets/embed.js?version=1`,
		});
		harness.load();
		const frame = harness.frames[0];

		expect(frame.src).toBe(`${origin}/embed`);
		harness.emitMessage({
			origin,
			source: frame.contentWindow,
			data: resizeMessage(true),
		});
		expect(frame.style).toMatchObject({ width: "420px", height: "620px" });
	});

	it("lets a managed consumer control mounting, including after cleanup", () => {
		const harness = createHarness({ autoMount: false });
		harness.load();
		expect(harness.frames).toHaveLength(0);
		expect(harness.messageListenerCount()).toBe(0);

		harness.controller().mount();
		expect(harness.activeFrames()).toHaveLength(1);
		expect(harness.messageListenerCount()).toBe(1);

		harness.controller().destroy();
		harness.load();
		expect(harness.activeFrames()).toHaveLength(0);
		expect(harness.messageListenerCount()).toBe(0);
	});

	it("destroys the frame and listener, then remounts without reloading the script", () => {
		const harness = createHarness();
		harness.load();
		const firstFrame = harness.frames[0];

		harness.controller().destroy();
		expect(harness.activeFrames()).toHaveLength(0);
		expect(harness.messageListenerCount()).toBe(0);

		harness.controller().destroy();
		expect(harness.activeFrames()).toHaveLength(0);

		harness.controller().mount();
		expect(harness.activeFrames()).toHaveLength(1);
		expect(harness.activeFrames()[0]).not.toBe(firstFrame);
		expect(harness.messageListenerCount()).toBe(1);

		const nextFrame = harness.activeFrames()[0];
		harness.emitMessage({
			origin: WIDGET_ORIGIN,
			source: nextFrame.contentWindow,
			data: resizeMessage(true),
		});
		expect(nextFrame.style).toMatchObject({ width: "420px", height: "620px" });
	});

	it("cancels a pending mount on destroy and can schedule it again", () => {
		const harness = createHarness({ readyState: "loading" });
		harness.load();

		harness.controller().destroy();
		expect(harness.domContentLoadedListenerCount()).toBe(0);
		expect(harness.frames).toHaveLength(0);
		expect(harness.messageListenerCount()).toBe(0);

		harness.controller().mount();
		expect(harness.domContentLoadedListenerCount()).toBe(1);
		harness.emitDOMContentLoaded();
		expect(harness.activeFrames()).toHaveLength(1);
		expect(harness.messageListenerCount()).toBe(1);
	});

	it("replaces an externally removed frame without duplicating its listener", () => {
		const harness = createHarness();
		harness.load();
		harness.frames[0].remove();

		harness.controller().mount();

		expect(harness.activeFrames()).toHaveLength(1);
		expect(harness.frames).toHaveLength(2);
		expect(harness.messageListenerCount()).toBe(1);
	});
});
