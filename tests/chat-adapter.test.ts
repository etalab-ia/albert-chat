import type { ThreadMessage } from "@assistant-ui/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	citationsToParts,
	collectHistory,
	createChatModelAdapter,
	messageToText,
	runChat,
	type WidgetRunResult,
} from "@/components/widget/chat-adapter";
import { LIMITS } from "@/lib/config";

/** Minimal thread message: the adapter only reads `role` and text parts. */
function message(
	role: "user" | "assistant",
	text: string,
	extraParts: unknown[] = [],
): ThreadMessage {
	return {
		id: `${role}-${Math.random()}`,
		role,
		createdAt: new Date(),
		content: [{ type: "text", text }, ...extraParts],
		attachments: [],
		metadata: {
			unstable_state: null,
			unstable_annotations: [],
			unstable_data: [],
			steps: [],
			custom: {},
		},
	} as unknown as ThreadMessage;
}

describe("configurable endpoint", () => {
	it("uses the configured URL and never sends host cookies", async () => {
		const mock = vi
			.fn()
			.mockResolvedValue(
				new Response('{"type":"delta","text":"ok"}\n{"type":"done"}\n'),
			);
		vi.stubGlobal("fetch", mock);
		try {
			const updates = [];
			for await (const update of runChat({
				question: "test",
				history: [],
				apiUrl: "https://widget.example.org/api/chat",
			})) {
				updates.push(update);
			}
			expect(updates).toHaveLength(1);
			expect(mock).toHaveBeenCalledWith(
				"https://widget.example.org/api/chat",
				expect.objectContaining({ credentials: "omit", method: "POST" }),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it("aborts an active fetch when the custom element lifetime ends", async () => {
		const lifetime = new AbortController();
		let signal: AbortSignal | undefined;
		const mock = vi.fn().mockImplementation((_url, options: RequestInit) => {
			signal = options.signal as AbortSignal;
			return new Promise((_resolve, reject) =>
				signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				),
			);
		});
		vi.stubGlobal("fetch", mock);
		try {
			const adapter = createChatModelAdapter("/custom", lifetime.signal);
			const result = adapter.run({
				messages: [message("user", "test")],
				abortSignal: new AbortController().signal,
			} as unknown as Parameters<typeof adapter.run>[0]);
			const rejected = expect(result).rejects.toHaveProperty(
				"name",
				"AbortError",
			);
			expect(signal?.aborted).toBe(false);
			lifetime.abort();
			await rejected;
			expect(signal?.aborted).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("messageToText", () => {
	it("keeps text parts and ignores citations", () => {
		const text = messageToText(
			message("assistant", "La MFA est requise.", [
				{
					type: "source",
					sourceType: "url",
					id: "x",
					url: "https://e.org/a.pdf",
				},
			]),
		);
		expect(text).toBe("La MFA est requise.");
	});

	it("joins several text parts", () => {
		expect(
			messageToText(
				message("assistant", "premier", [{ type: "text", text: "second" }]),
			),
		).toBe("premier\nsecond");
	});
});

describe("collectHistory", () => {
	it("excludes the message being answered", () => {
		const history = collectHistory([
			message("user", "question 1"),
			message("assistant", "réponse 1"),
			message("user", "question 2"),
		]);
		expect(history).toEqual([
			{ role: "user", content: "question 1" },
			{ role: "assistant", content: "réponse 1" },
		]);
	});

	it("drops messages without text", () => {
		const history = collectHistory([
			message("user", "   "),
			message("assistant", "utile"),
			message("user", "question"),
		]);
		expect(history).toEqual([{ role: "assistant", content: "utile" }]);
	});

	it("keeps the most recent entries when the thread is long", () => {
		const messages = Array.from({ length: 60 }, (_, index) =>
			message(index % 2 === 0 ? "user" : "assistant", `tour ${index}`),
		);
		const history = collectHistory([...messages, message("user", "question")]);

		// Sending more than the server accepts would fail every later turn.
		expect(history).toHaveLength(LIMITS.maxHistoryEntries);
		expect(history[history.length - 1].content).toBe("tour 59");
	});
});

describe("citationsToParts", () => {
	it("renders the page in the link title", () => {
		const parts = citationsToParts([
			{
				id: "1",
				title: "Guide",
				page: 12,
				url: "https://e.org/a.pdf#page=12",
				score: 0.5,
			},
		]);
		expect(parts).toEqual([
			{
				type: "source",
				sourceType: "url",
				id: "1",
				url: "https://e.org/a.pdf#page=12",
				page: 12,
				marker: 1,
				title: "Guide — page 12",
			},
		]);
	});

	it("numbers the markers in the order the model cites them", () => {
		// The marker is what "[n]" in the answer resolves against, so it must
		// follow the citation order rather than the document id.
		const parts = citationsToParts([
			{
				id: "a",
				title: "Premier",
				page: 3,
				url: "https://e.org/a.pdf#page=3",
				score: 0.9,
			},
			{
				id: "b",
				title: "Second",
				page: null,
				url: "https://e.org/b.pdf",
				score: 0.4,
			},
		]);
		expect(parts.map((part) => "marker" in part && part.marker)).toEqual([
			1, 2,
		]);
		expect(parts.map((part) => "page" in part && part.page)).toEqual([3, null]);
	});

	it("omits the page from the title when it is unknown", () => {
		const [part] = citationsToParts([
			{
				id: "2",
				title: "Guide",
				page: null,
				url: "https://e.org/a.pdf",
				score: 0.1,
			},
		]);
		expect(part).toMatchObject({ type: "source", title: "Guide" });
	});
	it("represents an excerpt-only source without a navigable URL", () => {
		const [part] = citationsToParts([
			{
				id: "10-20-3",
				title: "Note interne",
				page: null,
				url: null,
				score: 0.1,
			},
		]);
		expect(part).toMatchObject({
			type: "source",
			id: "10-20-3",
			url: "",
			title: "Note interne",
		});
	});
});

describe("runChat stream decoding", () => {
	const encoder = new TextEncoder();

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** Serves the given byte chunks as the `/api/chat` response body. */
	function stubChatResponse(chunks: Uint8Array[]) {
		vi.stubGlobal("fetch", async () => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			});
			return new Response(body, { status: 200 });
		});
	}

	function deltaLine(text: string): string {
		return `${JSON.stringify({ type: "delta", text })}\n`;
	}

	async function collectUpdates(): Promise<WidgetRunResult[]> {
		const updates: WidgetRunResult[] = [];
		for await (const update of runChat({ question: "question", history: [] })) {
			updates.push(update);
		}
		return updates;
	}

	function lastText(updates: WidgetRunResult[]): string {
		const part = updates
			.at(-1)
			?.content.find((candidate) => candidate.type === "text");
		return part && part.type === "text" ? part.text : "";
	}

	it("keeps the tail of the answer when the last event has no trailing newline", async () => {
		const head = encoder.encode(deltaLine("début "));
		const last = encoder.encode(
			JSON.stringify({ type: "delta", text: "fin é" }),
		);
		// Split inside the final "é" (two bytes in UTF-8), and end the stream
		// without a newline: without flushing the decoder and terminating the last
		// line, everything after the split is lost.
		const cut = last.lastIndexOf(0xc3);

		stubChatResponse([head, last.slice(0, cut), last.slice(cut)]);

		expect(lastText(await collectUpdates())).toBe("début fin é");
	});

	it("decodes a multi-byte character split across two reads mid-stream", async () => {
		const first = encoder.encode(deltaLine("premier "));
		const second = encoder.encode(deltaLine("second é"));
		const cut = second.lastIndexOf(0xc3);

		stubChatResponse([first, second.slice(0, cut), second.slice(cut)]);

		expect(lastText(await collectUpdates())).toBe("premier second é");
	});

	it("stops at the done event and keeps the answer built so far", async () => {
		stubChatResponse([
			encoder.encode(
				`${deltaLine("réponse")}${JSON.stringify({ type: "done" })}\n`,
			),
			encoder.encode(deltaLine("ignoré")),
		]);

		expect(lastText(await collectUpdates())).toBe("réponse");
	});

	it("emits no duplicate update when the stream ends on a done event", async () => {
		stubChatResponse([
			encoder.encode(
				deltaLine("un") +
					deltaLine("deux") +
					`${JSON.stringify({ type: "done" })}\n`,
			),
		]);

		const updates = await collectUpdates();

		// One update per delta: the final answer must not be sent a third time.
		expect(updates).toHaveLength(2);
		expect(updates.map((update) => lastText([update]))).toEqual([
			"un",
			"undeux",
		]);
	});

	it("emits no duplicate update when the last delta has no trailing newline", async () => {
		stubChatResponse([
			encoder.encode(
				deltaLine("un") + JSON.stringify({ type: "delta", text: "deux" }),
			),
		]);

		const updates = await collectUpdates();

		expect(updates).toHaveLength(2);
		expect(lastText(updates)).toBe("undeux");
	});
});
