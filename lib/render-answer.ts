/**
 * Splits an answer into blocks for display, dropping the light Markdown models
 * emit even when asked for plain text.
 *
 * The widget renders a small block model (paragraph, bullet, numbered item)
 * rather than Markdown: the corpus answers need emphasis and lists, not links,
 * tables or embedded HTML, and a full Markdown pipeline would execute whatever
 * the model produced.
 */

export type AnswerBlock =
	| { kind: "paragraph"; text: string }
	| { kind: "bullet"; text: string }
	| { kind: "ordered"; text: string; number: number };

/** A run of text that may carry citation markers, ready to render inline. */
export type AnswerSpan =
	| { kind: "text"; text: string }
	| {
			kind: "citation";
			marker: number;
			page: number | null;
			url: string | null;
	  };

export type AnswerSource = {
	marker: number;
	url: string | null;
	page: number | null;
};

export function parseAnswer(raw: string): AnswerBlock[] {
	const text = raw
		.replace(/\r\n?/g, "\n")
		// Emphasis markers: **bold**, __bold__, *italic*, _italic_, `code`.
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/__(.+?)__/g, "$1")
		.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1$2")
		.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1$2")
		.replace(/`([^`\n]+)`/g, "$1")
		// Escape characters the model sometimes emits before punctuation.
		.replace(/\\([.()-])/g, "$1");

	const blocks: AnswerBlock[] = [];
	const lines = text.split("\n");
	let paragraph: string[] = [];

	const flushParagraph = () => {
		const joined = paragraph.join(" ").trim();
		if (joined.length > 0) blocks.push({ kind: "paragraph", text: joined });
		paragraph = [];
	};

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed.length === 0) {
			flushParagraph();
			continue;
		}

		// A heading stands alone, so it must not be folded into the next paragraph.
		const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
		if (heading) {
			flushParagraph();
			blocks.push({ kind: "paragraph", text: heading[1].trim() });
			continue;
		}

		const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
		if (bullet) {
			flushParagraph();
			blocks.push({ kind: "bullet", text: bullet[1].trim() });
			continue;
		}

		const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
		if (ordered) {
			flushParagraph();
			// Keep the model's own number: a list that follows a paragraph starts at
			// block index 1, so numbering from the array position would show "2.".
			blocks.push({
				kind: "ordered",
				text: ordered[2].trim(),
				number: Number.parseInt(ordered[1], 10),
			});
			continue;
		}

		paragraph.push(trimmed);
	}

	flushParagraph();
	return blocks;
}

/**
 * Splits a block of text into plain runs and citation markers, so the markers
 * can be rendered as links to the page they point at rather than as bracketed
 * numbers that refer to a list somewhere else.
 *
 * A marker with no matching source is dropped. The model occasionally emits a
 * number that indexes nothing — a list position, or a reference to an article
 * in the document — and showing it would put a citation in front of the reader
 * that leads nowhere and cannot be checked.
 */
export function parseSpans(
	text: string,
	sources: ReadonlyMap<number, AnswerSource>,
): AnswerSpan[] {
	const spans: AnswerSpan[] = [];
	// One group per marker, and runs of markers such as "[2][3]" collapse into
	// consecutive spans with nothing between them.
	const pattern = /\[(\d{1,2})\]/g;
	let cursor = 0;
	let match = pattern.exec(text);

	while (match !== null) {
		const marker = Number.parseInt(match[1], 10);
		const source = sources.get(marker);

		// Skip the marker itself, keeping any text before it.
		if (match.index > cursor) {
			spans.push({ kind: "text", text: text.slice(cursor, match.index) });
		}
		cursor = match.index + match[0].length;
		match = pattern.exec(text);

		// An unknown number is attached to a source it does not have: leave it out
		// rather than printing a bracketed number the reader cannot follow.
		if (!source) continue;

		spans.push({
			kind: "citation",
			marker,
			page: source.page,
			url: source.url,
		});
	}

	if (cursor < text.length) {
		spans.push({ kind: "text", text: text.slice(cursor) });
	}

	// A dropped marker splits one sentence into two text runs; join neighbours so
	// the caller renders the text as it was written.
	return spans.reduce<AnswerSpan[]>((merged, span) => {
		const previous = merged[merged.length - 1];
		if (span.kind === "text" && previous?.kind === "text") {
			merged[merged.length - 1] = {
				kind: "text",
				text: previous.text + span.text,
			};
			return merged;
		}
		merged.push(span);
		return merged;
	}, []);
}
