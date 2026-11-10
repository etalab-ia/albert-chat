import { expect, test } from "@playwright/test";

test("standalone artifact renders without an iframe and contains CSS and portals", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/api/chat", (route) =>
		route.fulfill({
			contentType: "application/x-ndjson",
			headers: { "Access-Control-Allow-Origin": "http://127.0.0.1:4311" },
			body: `${JSON.stringify({
				type: "sources",
				sources: [
					{
						id: "1",
						title: "Guide",
						url: "https://example.org/guide.pdf#page=2",
						page: 2,
					},
					{ id: "2", title: "Note interne", url: null, page: null },
				],
			})}\n${JSON.stringify({ type: "delta", text: "Réponse sûre <script>alert(1)</script> [1][2]." })}\n{"type":"done"}\n`,
		}),
	);
	await page.goto("http://127.0.0.1:4311");
	const widget = page.locator("albert-chat");
	const trigger = widget.getByRole("button", {
		name: "Ouvrir l'assistant ANSSI",
	});
	await expect(trigger).toBeVisible();
	await expect(page.locator("iframe")).toHaveCount(0);
	await expect(trigger).toHaveCSS("background-color", "rgb(0, 0, 145)");
	await expect(page.locator("#host")).toHaveCSS(
		"background-color",
		"rgb(255, 0, 0)",
	);
	await trigger.click();
	const input = widget.getByRole("textbox", { name: "Votre question" });
	await expect(input).toBeVisible();
	await input.fill("Question de test");
	await widget.getByRole("button", { name: "Envoyer" }).click();
	await expect(
		widget.getByText("Réponse sûre", { exact: false }),
	).toBeVisible();
	const citation = widget.getByRole("link", {
		name: "Source 1, ouvrir la page 2",
	});
	await expect(citation).toHaveAttribute(
		"href",
		"https://example.org/guide.pdf#page=2",
	);
	await expect(citation).toHaveAttribute("rel", "noopener noreferrer");
	const excerptCitation = widget.getByTitle("Source 2, le document cité");
	await expect(excerptCitation).toBeVisible();
	await expect(excerptCitation).not.toHaveAttribute("href");
	await expect(widget.getByRole("link", { name: /^Source / })).toHaveCount(1);
	expect(
		await page.evaluate(
			() =>
				document.querySelectorAll("[data-radix-popper-content-wrapper]").length,
		),
	).toBe(0);
	await page.keyboard.press("Escape");
	await expect(input).not.toBeVisible();
	await widget.evaluate((element) => {
		element.remove();
		document.body.append(element);
	});
	await expect(trigger).toBeVisible();
	await trigger.click();
	await expect(input).toBeVisible();
	expect(errors).toEqual([]);
});

test("endpoint changes reject executable URLs and allow recovery", async ({
	page,
}) => {
	await page.goto("http://127.0.0.1:4311");
	const widget = page.locator("albert-chat");
	await expect(
		widget.getByRole("button", { name: "Ouvrir l'assistant ANSSI" }),
	).toBeVisible();
	await widget.evaluate((element) =>
		element.setAttribute("api-url", "javascript:alert(1)"),
	);
	await expect(widget.getByRole("alert")).toContainText("HTTP(S)");
	await widget.evaluate((element) =>
		element.setAttribute("api-url", "http://127.0.0.1:4310/api/chat"),
	);
	await expect(
		widget.getByRole("button", { name: "Ouvrir l'assistant ANSSI" }),
	).toBeVisible();
});

test("landing selector switches the actual integration and snippet", async ({
	page,
}) => {
	await page.goto("/");
	const sameOriginStatus = await page.evaluate(
		async () =>
			(
				await fetch("/api/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ question: "" }),
				})
			).status,
	);
	expect(sameOriginStatus).toBe(400);
	await expect(page.locator("iframe[data-anssi-widget]")).toHaveCount(1);
	await page
		.locator("label")
		.filter({ hasText: /^Web Component$/ })
		.click();
	await expect(
		page.getByRole("radio", { name: "Web Component", exact: true }),
	).toBeChecked();
	await expect(page.locator("iframe")).toHaveCount(0);
	await expect(
		page
			.locator("albert-chat")
			.getByRole("button", { name: "Ouvrir l'assistant ANSSI" }),
	).toBeVisible();
	await expect(page.locator("pre")).toContainText("<albert-chat");
	await page
		.locator("label")
		.filter({ hasText: /^Iframe$/ })
		.click();
	await expect(page.locator("albert-chat")).toHaveCount(0);
	await expect(page.locator("iframe[data-anssi-widget]")).toHaveCount(1);
	await expect(page.locator("pre")).toContainText("embed.js");
});

test("real API CORS accepts configured hosts and refuses others before processing", async ({
	page,
	request,
}) => {
	await page.goto("http://127.0.0.1:4311");
	const result = await page.evaluate(async () => {
		const response = await fetch("http://127.0.0.1:4310/api/chat", {
			method: "POST",
			credentials: "omit",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ question: "" }),
		});
		return { status: response.status, body: await response.json() };
	});
	expect(result.status).toBe(400);
	expect(result.body.error).toBe("Question invalide.");
	const denied = await request.post("/api/chat", {
		headers: { Origin: "https://evil.example" },
		data: { question: "test" },
	});
	expect(denied.status()).toBe(403);
	expect(denied.headers()["access-control-allow-origin"]).toBeUndefined();
	const asset = await request.get("/widget.js", {
		headers: { Origin: "https://evil.example" },
	});
	expect(asset.status()).toBe(200);
	// Downloading public client code does not confer API access.
	expect(asset.headers()["access-control-allow-origin"]).toBe("*");
	expect(asset.headers()["access-control-allow-credentials"]).toBeUndefined();
});

test("mobile panel fits the viewport and still accepts typing inside Shadow DOM", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("http://127.0.0.1:4311");
	const widget = page.locator("albert-chat");
	await widget
		.getByRole("button", { name: "Ouvrir l'assistant ANSSI" })
		.click();
	const input = widget.getByRole("textbox", { name: "Votre question" });
	await input.fill("Bonjour");
	await expect(input).toHaveValue("Bonjour");
	const panel = await widget
		.locator("[data-radix-popper-content-wrapper]")
		.boundingBox();
	if (!panel) throw new Error("Expected a visible panel");
	expect(panel.x).toBeGreaterThanOrEqual(0);
	expect(panel.x + panel.width).toBeLessThanOrEqual(390);
	expect(panel.y).toBeGreaterThanOrEqual(0);
	expect(panel.y + panel.height).toBeLessThanOrEqual(844);
});

/**
 * The launcher must sit in the same place whichever integration a host picks.
 * It used to be 32px from the corner in iframe mode (the loader inset the frame
 * by 16px and the widget inset itself by another 16px) and 16px in web
 * component mode, so switching mode visibly moved the button.
 */
test("launcher keeps one corner offset across both integration modes", async ({
	page,
}) => {
	const viewport = { width: 1200, height: 800 };
	await page.setViewportSize(viewport);
	await page.goto("/");

	const offset = (box: {
		x: number;
		y: number;
		width: number;
		height: number;
	}) => ({
		right: Math.round(viewport.width - (box.x + box.width)),
		bottom: Math.round(viewport.height - (box.y + box.height)),
	});

	const iframeLauncher = page
		.frameLocator("iframe[data-anssi-widget]")
		.getByRole("button", { name: "Ouvrir l'assistant ANSSI" });
	await expect(iframeLauncher).toBeVisible();
	const iframeBox = await iframeLauncher.boundingBox();
	if (!iframeBox) throw new Error("Expected a visible iframe launcher");
	const iframeOffset = offset(iframeBox);

	await page
		.locator("label")
		.filter({ hasText: /^Web Component$/ })
		.click();
	const webLauncher = page
		.locator("albert-chat")
		.getByRole("button", { name: "Ouvrir l'assistant ANSSI" });
	await expect(webLauncher).toBeVisible();
	const webBox = await webLauncher.boundingBox();
	if (!webBox) throw new Error("Expected a visible web component launcher");
	const webOffset = offset(webBox);

	// Same 16px inset in both modes, and identical button size.
	expect(iframeOffset).toEqual({ right: 16, bottom: 16 });
	expect(webOffset).toEqual(iframeOffset);
	expect(Math.round(webBox.width)).toBe(Math.round(iframeBox.width));
});

/**
 * An open panel used to keep the closed state's chat bubble, so the launcher
 * gave no visual hint that it now closes the panel.
 */
test("launcher icon and label reflect the open state", async ({ page }) => {
	await page.goto("http://127.0.0.1:4311");
	const widget = page.locator("albert-chat");
	const open = widget.getByRole("button", { name: "Ouvrir l'assistant ANSSI" });
	await expect(open).toBeVisible();
	const closedIcon = await open.locator("svg path").getAttribute("d");

	await open.click();
	const close = widget.getByRole("button", {
		name: "Réduire l'assistant ANSSI",
	});
	await expect(close).toBeVisible();
	const openIcon = await close.locator("svg path").getAttribute("d");

	// Distinct glyphs, and the icon must not be the header's cross either.
	expect(openIcon).not.toBe(closedIcon);
	expect(openIcon).not.toBe("M6 6l12 12M18 6L6 18");

	await close.click();
	await expect(open).toBeVisible();
	expect(await open.locator("svg path").getAttribute("d")).toBe(closedIcon);
});

// The iframe route used to share the landing page's root layout, which loaded
// DSFR. DSFR's unlayered `button` reset beat Tailwind's layered utilities, so
// the launcher lost its blue background on hover (a white icon on a pale
// circle) and the send button lost it entirely. /embed now has its own root
// layout without DSFR; these assertions are what failed before that split.
test("iframe route keeps widget styling free of the site design system", async ({
	page,
}) => {
	await page.goto("/embed");
	const launcher = page.getByRole("button", {
		name: "Ouvrir l'assistant ANSSI",
	});
	await expect(launcher).toBeVisible();

	await expect(launcher).toHaveCSS("background-color", "rgb(0, 0, 145)");
	await launcher.hover();
	await expect(launcher).toHaveCSS("background-color", "rgb(0, 0, 145)");
	// The icon must stay legible against the blue that hover no longer removes.
	await expect(launcher.locator("svg")).toHaveCSS(
		"stroke",
		"rgb(255, 255, 255)",
	);

	// DSFR would resolve the body font to Marianne; the widget declares Arial.
	await expect(page.locator("body")).toHaveCSS(
		"font-family",
		/^Arial,\s*Helvetica,\s*sans-serif$/,
	);

	await launcher.click();
	const send = page.getByRole("button", { name: "Envoyer" });
	await expect(send).toHaveCSS("background-color", "rgb(0, 0, 145)");

	// DSFR gives every paragraph a 24px bottom margin, which pushed the panel
	// header off-centre. Tailwind preflight resets it to 0 instead.
	const title = page.locator('[role="dialog"]').locator("p").first();
	await expect(title).toHaveCSS("margin-bottom", "0px");
});
