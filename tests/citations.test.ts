import { describe, expect, it } from "vitest";
import type { SearchHit } from "@/lib/albert/types";
import {
	blocksToSources,
	buildCitationUrl,
	buildContextBlocks,
	toCitations,
} from "@/lib/rag/citations";

function hit(overrides: {
	id?: number;
	content?: string;
	metadata?: Record<string, unknown> | null;
	score?: number;
}): SearchHit {
	return {
		method: "hybrid",
		score: overrides.score ?? 0.5,
		chunk: {
			id: overrides.id ?? 1,
			collection_id: 10,
			document_id: 20,
			content: overrides.content ?? "contenu",
			metadata: overrides.metadata as SearchHit["chunk"]["metadata"],
		},
	};
}

describe("buildCitationUrl", () => {
	it("appends a page fragment to a plain URL", () => {
		expect(buildCitationUrl("https://example.org/a.pdf", 7)).toBe(
			"https://example.org/a.pdf#page=7",
		);
	});

	it("returns the URL unchanged when the page is unknown", () => {
		expect(buildCitationUrl("https://example.org/a.pdf", null)).toBe(
			"https://example.org/a.pdf",
		);
	});

	it("appends to an existing fragment rather than discarding it", () => {
		expect(buildCitationUrl("https://example.org/a.pdf#zoom=120", 3)).toBe(
			"https://example.org/a.pdf#zoom=120&page=3",
		);
	});
});

describe("toCitations", () => {
	it("keeps hits without a source URL as excerpt-only citations", () => {
		const citations = toCitations([
			hit({ id: 1, metadata: { page: 1, title: "Note interne" } }),
			hit({
				id: 2,
				metadata: { source_url: "https://example.org/a.pdf", page: 2 },
			}),
		]);
		expect(citations).toHaveLength(2);
		expect(citations[0]).toMatchObject({
			title: "Note interne",
			page: 1,
			url: null,
		});
		expect(citations[1].url).toBe("https://example.org/a.pdf#page=2");
	});

	it("deduplicates the same document page and keeps the best score", () => {
		const metadata = { source_url: "https://example.org/a.pdf", page: 4 };
		const citations = toCitations([
			hit({ id: 1, metadata, score: 0.4 }),
			hit({ id: 2, metadata, score: 0.9 }),
		]);
		expect(citations).toHaveLength(1);
		expect(citations[0].score).toBeCloseTo(0.9);
	});

	it("orders citations by score", () => {
		const citations = toCitations([
			hit({
				id: 1,
				metadata: { source_url: "https://example.org/a.pdf", page: 1 },
				score: 0.2,
			}),
			hit({
				id: 2,
				metadata: { source_url: "https://example.org/b.pdf", page: 9 },
				score: 0.8,
			}),
		]);
		expect(citations.map((citation) => citation.page)).toEqual([9, 1]);
	});

	it("ignores a non-numeric page and keeps the document citable", () => {
		const citations = toCitations([
			hit({
				metadata: { source_url: "https://example.org/a.pdf", page: "n/a" },
			}),
		]);
		expect(citations).toHaveLength(1);
		expect(citations[0].page).toBeNull();
		expect(citations[0].url).toBe("https://example.org/a.pdf");
	});

	it.each([2.5, 0, -2, true])(
		"does not invent a page from invalid provenance: %j",
		(page) => {
			const citations = toCitations([
				hit({ metadata: { page, title: "Note" } }),
			]);
			expect(citations[0].page).toBeNull();
			expect(citations[0].url).toBeNull();
		},
	);

	it("falls back to a stable document identifier", () => {
		const citations = toCitations([
			hit({ metadata: { source_url: "https://example.org/a.pdf", page: 1 } }),
		]);
		expect(citations[0].title).toBe("Document 20");
	});

	it("prefers the generic title and page provenance over legacy fields", () => {
		const citations = toCitations([
			hit({
				metadata: {
					title: "Procédure projet",
					guide_title: "Ancien titre",
					page_number: 8,
					page: 2,
				},
			}),
		]);
		expect(citations[0]).toMatchObject({
			title: "Procédure projet",
			page: 8,
			url: null,
		});
	});
});

describe("buildContextBlocks", () => {
	it("numbers blocks in order and pairs each with its citation", () => {
		const blocks = buildContextBlocks([
			hit({
				id: 1,
				content: "premier",
				metadata: {
					source_url: "https://e.org/a.pdf",
					page: 2,
					guide_title: "Guide A",
				},
			}),
			hit({
				id: 2,
				content: "second",
				metadata: {
					source_url: "https://e.org/a.pdf",
					page: 5,
					guide_title: "Guide A",
				},
			}),
		]);

		expect(blocks.map((block) => block.marker)).toEqual(["[1]", "[2]"]);
		expect(blocks[1].citation.page).toBe(5);
		expect(blocks[1].content).toBe("second");
	});

	it("truncates oversized chunk content", () => {
		const blocks = buildContextBlocks([
			hit({
				content: "x".repeat(5000),
				metadata: { source_url: "https://e.org/a.pdf", page: 1 },
			}),
		]);
		expect(blocks[0].content.length).toBeLessThanOrEqual(1200);
	});

	it("keeps URL-less content in the grounded context", () => {
		const blocks = buildContextBlocks([
			hit({ content: "passage interne", metadata: { page: 3 } }),
		]);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].content).toBe("passage interne");
		expect(blocks[0].citation).toMatchObject({ page: 3, url: null });
	});

	it("merges URL-less chunks only when they share page provenance", () => {
		const blocks = buildContextBlocks([
			hit({ id: 1, content: "premier", metadata: { page: 3 } }),
			hit({ id: 2, content: "second", metadata: { page: 3 } }),
			hit({ id: 3, content: "autre page", metadata: { page: 4 } }),
		]);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].content).toContain("premier");
		expect(blocks[0].content).toContain("second");
	});

	it("does not truncate unrelated chunks whose page is unknown", () => {
		const blocks = buildContextBlocks([
			hit({ id: 1, content: "premier", metadata: { title: "Note" } }),
			hit({ id: 2, content: "second", metadata: { title: "Note" } }),
		]);
		expect(blocks).toHaveLength(2);
		expect(blocks.map((block) => block.content)).toEqual(["premier", "second"]);
		expect(blocks.every((block) => block.citation.url === null)).toBe(true);
	});

	it("merges two chunks from the same page into one block", () => {
		const metadata = {
			source_url: "https://e.org/a.pdf",
			page: 7,
			guide_title: "Guide A",
		};
		const blocks = buildContextBlocks([
			hit({ id: 1, content: "premier extrait", metadata }),
			hit({ id: 2, content: "second extrait", metadata }),
			hit({ id: 3, content: "autre page", metadata: { ...metadata, page: 8 } }),
		]);

		expect(blocks).toHaveLength(2);
		expect(blocks[0].content).toContain("premier extrait");
		expect(blocks[0].content).toContain("second extrait");
		expect(blocks[1].marker).toBe("[2]");
		expect(blocks[1].citation.page).toBe(8);
	});

	it("keeps markers aligned with the source list order", () => {
		const metadata = { source_url: "https://e.org/a.pdf", page: 7 };
		const blocks = buildContextBlocks([
			hit({ id: 1, metadata }),
			hit({ id: 2, metadata }),
			hit({ id: 3, metadata: { ...metadata, page: 9 } }),
		]);
		const sources = blocksToSources(blocks);

		expect(sources).toHaveLength(blocks.length);
		for (const [index, block] of blocks.entries()) {
			// Marker [N] must address source N.
			expect(block.marker).toBe(`[${index + 1}]`);
			expect(sources[index]).toBe(block.citation);
		}
	});
});

describe("citation URL guards", () => {
	it("strips an unsafe source URL without dropping the chunk", () => {
		const citations = toCitations([
			hit({
				id: 1,
				metadata: { source_url: "javascript:alert(1)", page: 1 },
			}),
			hit({ id: 2, metadata: { source_url: "https://e.org/ok.pdf", page: 2 } }),
		]);
		expect(citations).toHaveLength(2);
		expect(citations[0].url).toBeNull();
		expect(citations[1].url).toBe("https://e.org/ok.pdf#page=2");
	});

	it("keeps a fragment that already contains a hash", () => {
		expect(buildCitationUrl("https://e.org/a.pdf#zoom=1#p2", 4)).toBe(
			"https://e.org/a.pdf#zoom=1#p2&page=4",
		);
	});

	it("does not append a second page value", () => {
		expect(buildCitationUrl("https://e.org/a.pdf#page=5", 3)).toBe(
			"https://e.org/a.pdf#page=5",
		);
	});
});
