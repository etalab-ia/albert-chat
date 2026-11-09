"use client";

import type { ChatModelAdapter, ThreadMessage } from "@assistant-ui/react";
import { LIMITS } from "@/lib/limits";
import type { Citation } from "@/lib/rag/citations";
import type { StreamEvent } from "@/lib/rag/stream-protocol";

type ContentPart =
	| { type: "text"; text: string }
	| {
			type: "source";
			sourceType: "url";
			id: string;
			url: string;
			title?: string;
			/** Page of the cited PDF, when the corpus provides one. */
			page?: number | null;
			/** 1-based position of the source in the answer, matching "[n]". */
			marker?: number;
	  };

export type WidgetRunResult = {
	content: ContentPart[];
	metadata?: Record<string, unknown>;
};

/** Extracts the plain text of a thread message, ignoring citations and tools. */
export function messageToText(message: ThreadMessage): string {
	return message.content
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/**
 * Collects the earlier turns of the thread, excluding the message currently
 * being answered (the last one), which travels as `question`. The result is
 * capped at the same bound the server validates, so a long conversation keeps
 * working instead of failing the schema on every later turn.
 */
export function collectHistory(messages: readonly ThreadMessage[]) {
	return messages
		.slice(0, -1)
		.filter(
			(message): message is ThreadMessage & { role: "user" | "assistant" } =>
				message.role === "user" || message.role === "assistant",
		)
		.map((message) => ({ role: message.role, content: messageToText(message) }))
		.filter((message) => message.content.length > 0)
		.slice(-LIMITS.maxHistoryEntries);
}

export function citationsToParts(citations: Citation[]): ContentPart[] {
	return citations.map((citation, index) => ({
		type: "source" as const,
		sourceType: "url" as const,
		id: citation.id,
		// assistant-ui models every source as a URL part. An empty URL is the
		// adapter's excerpt-only representation; the renderer never makes it a link.
		url: citation.url ?? "",
		page: citation.page,
		marker: index + 1,
		title:
			citation.page === null
				? citation.title
				: `${citation.title} — page ${citation.page}`,
	}));
}

/**
 * Streams the answer from /api/chat and yields cumulative assistant content:
 * the citation parts first, then the growing answer text.
 */
export async function* runChat(params: {
	question: string;
	history: Array<{ role: "user" | "assistant"; content: string }>;
	signal?: AbortSignal;
	apiUrl?: string;
}): AsyncGenerator<WidgetRunResult, void, unknown> {
	const response = await fetch(params.apiUrl ?? "/api/chat", {
		method: "POST",
		credentials: "omit",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			question: params.question,
			history: params.history,
		}),
		signal: params.signal,
	});

	if (!response.ok || !response.body) {
		const body = await response.text().catch(() => "");
		let detail = "";
		try {
			const parsed = JSON.parse(body) as { error?: string };
			detail = parsed.error ?? "";
		} catch {
			detail = "";
		}
		throw new Error(detail || `Le service a renvoyé ${response.status}.`);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let sources: ContentPart[] = [];
	let answer = "";
	/** Last answer text already yielded, if any. */
	let emitted: string | null = null;
	let finished = false;

	/**
	 * Parses every complete line currently in `buffer` and yields the cumulative
	 * content after each event. A call after the stream ends also parses the
	 * trailing line, which the caller terminates itself.
	 */
	function* emitPending(): Generator<WidgetRunResult, void, unknown> {
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line) continue;

			let event: StreamEvent;
			try {
				event = JSON.parse(line) as StreamEvent;
			} catch {
				// A truncated or injected line must not kill the answer in progress.
				continue;
			}

			if (event.type === "sources") {
				sources = citationsToParts(event.sources);
				yield { content: [...sources] };
			} else if (event.type === "delta") {
				answer += event.text;
				emitted = answer;
				yield { content: [...sources, { type: "text", text: answer }] };
			} else if (event.type === "error") {
				throw new Error(event.message);
			} else if (event.type === "done") {
				finished = true;
				return;
			}
		}
	}

	try {
		while (!finished) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			yield* emitPending();
		}

		if (!finished) {
			// `decode()` without `stream: true` flushes the bytes the decoder holds
			// back for a multi-byte character split across reads, and the last event
			// may arrive without a trailing newline. Without this, the end of the
			// answer can be lost.
			buffer += decoder.decode();
			if (buffer.length > 0) buffer += "\n";
			yield* emitPending();
		}
	} finally {
		reader.releaseLock();
	}

	// A `done` event already carries the final answer. Otherwise the stream ended
	// on its own: emit the last state only when it has not been sent yet.
	if (!finished && answer !== emitted) {
		yield { content: [...sources, { type: "text", text: answer }] };
	}
}

/** assistant-ui adapter wrapping the streaming fetcher above. */
export function createChatModelAdapter(
	apiUrl = "/api/chat",
	lifetimeSignal?: AbortSignal,
): ChatModelAdapter {
	return {
		async run({ messages, abortSignal }) {
			const latest = messages[messages.length - 1];
			const question = latest ? messageToText(latest) : "";

			if (!question) {
				return { content: [{ type: "text", text: "Posez une question." }] };
			}

			const history = collectHistory(messages);

			let last: WidgetRunResult | undefined;
			for await (const update of runChat({
				question,
				history,
				apiUrl,
				signal: lifetimeSignal
					? AbortSignal.any([abortSignal, lifetimeSignal])
					: abortSignal,
			})) {
				last = update;
			}

			return last ?? { content: [{ type: "text", text: "" }] };
		},
	};
}

export const chatModelAdapter = createChatModelAdapter();
