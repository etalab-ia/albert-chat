import { describe, expect, it } from "vitest";
import type { ContextBlock } from "@/lib/rag/citations";
import {
	buildChatMessages,
	buildContextMessage,
	SYSTEM_PROMPT,
} from "@/lib/rag/prompt";

const BLOCK: ContextBlock = {
	marker: "[1]",
	citation: {
		id: "1-1",
		title: "Guide d'hygiène",
		page: 12,
		url: "https://example.org/a.pdf#page=12",
		score: 0.9,
	},
	content: "Les mises à jour doivent être appliquées.",
};

describe("buildContextMessage", () => {
	it("uses corpus-neutral grounding wording", () => {
		expect(SYSTEM_PROMPT).not.toContain("ANSSI");
		expect(buildContextMessage([BLOCK])).toContain(
			"Extraits du corpus documentaire:",
		);
	});

	it("states explicitly that no extract is available", () => {
		expect(buildContextMessage([])).toContain("aucun");
	});

	it("includes the guide title and page for each extract", () => {
		const message = buildContextMessage([BLOCK]);
		expect(message).toContain("[1] Guide d'hygiène, page 12");
		expect(message).toContain("Les mises à jour doivent être appliquées.");
	});

	it("omits the page when it is unknown", () => {
		const message = buildContextMessage([
			{ ...BLOCK, citation: { ...BLOCK.citation, page: null } },
		]);
		expect(message).toContain("[1] Guide d'hygiène\n");
	});
});

describe("buildChatMessages", () => {
	it("puts the rules and the context before the conversation", () => {
		const messages = buildChatMessages({
			question: "Quelles mises à jour ?",
			blocks: [BLOCK],
			history: [{ role: "user", content: "Bonjour" }],
		});

		expect(messages.map((message) => message.role)).toEqual([
			"system",
			"system",
			"user",
			"user",
		]);
		expect(messages[messages.length - 1].content).toBe(
			"Quelles mises à jour ?",
		);
	});

	it("drops empty history entries", () => {
		const messages = buildChatMessages({
			question: "q",
			blocks: [],
			history: [
				{ role: "user", content: "   " },
				{ role: "assistant", content: "réponse" },
			],
		});
		expect(messages).toHaveLength(4);
		expect(messages[2].content).toBe("réponse");
	});

	it("keeps only the most recent turns", () => {
		const history = Array.from({ length: 20 }, (_, index) => ({
			role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			content: `tour ${index}`,
		}));

		const messages = buildChatMessages({ question: "q", blocks: [], history });
		const conversation = messages.slice(2);
		expect(conversation).toHaveLength(7);
		expect(conversation[0].content).toBe("tour 14");
	});
});
