(() => {
	const script = document.currentScript;
	if (!script) return;

	let widgetUrl;
	try {
		widgetUrl = new URL("/embed", script.src);
	} catch {
		return;
	}

	const widgetOrigin = widgetUrl.origin;
	const shouldAutoMount = script.dataset?.anssiAutoMount !== "false";
	const existingController = window.__anssiWidget;
	if (existingController) {
		if (shouldAutoMount) existingController.mount();
		return;
	}

	let frame = null;
	let onMessage = null;
	let mountPending = false;

	function onDocumentReady() {
		mountPending = false;
		mount();
	}

	function destroy() {
		if (mountPending) {
			document.removeEventListener("DOMContentLoaded", onDocumentReady);
			mountPending = false;
		}
		if (onMessage) {
			window.removeEventListener("message", onMessage);
			onMessage = null;
		}
		if (frame) {
			frame.remove();
			frame = null;
		}
	}

	function mount() {
		if (document.readyState === "loading") {
			if (!mountPending) {
				mountPending = true;
				document.addEventListener("DOMContentLoaded", onDocumentReady, {
					once: true,
				});
			}
			return;
		}

		// Keep one frame and one listener across duplicate loads and React remounts.
		if (frame?.isConnected) return;
		destroy();

		const nextFrame = document.createElement("iframe");
		frame = nextFrame;
		nextFrame.src = widgetUrl.href;
		nextFrame.title = "Assistant ANSSI";
		nextFrame.setAttribute("data-anssi-widget", "");
		nextFrame.setAttribute(
			"sandbox",
			"allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox",
		);
		nextFrame.setAttribute(
			"allow",
			"camera 'none'; microphone 'none'; geolocation 'none'",
		);
		nextFrame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");

		Object.assign(nextFrame.style, {
			position: "fixed",
			// Flush to the corner on purpose: the widget inside the frame applies
			// its own 16px inset. Insetting the frame as well put the launcher
			// 32px from the edge in iframe mode and 16px in web component mode,
			// so switching integration moved the button.
			right: "0",
			bottom: "0",
			width: "88px",
			height: "88px",
			border: "0",
			zIndex: "50",
			background: "transparent",
			transition: "width 160ms ease, height 160ms ease",
		});

		onMessage = (event) => {
			if (event.origin !== widgetOrigin) return;
			if (event.source !== nextFrame.contentWindow) return;

			const data = event.data;
			if (data?.source !== "anssi-widget" || data.type !== "resize") {
				return;
			}
			if (typeof data.open !== "boolean") return;

			nextFrame.style.width = data.open ? "420px" : "88px";
			nextFrame.style.height = data.open ? "620px" : "88px";
		};

		// Listen before attaching the frame so even an immediate resize announcement
		// from the widget cannot be missed.
		window.addEventListener("message", onMessage);
		document.body.appendChild(nextFrame);
	}

	// next/script caches the asset, so a remount needs a controller rather than a
	// second script evaluation. Kept after destroy to support that remount.
	window.__anssiWidget = { mount, destroy };
	if (shouldAutoMount) mount();
})();
