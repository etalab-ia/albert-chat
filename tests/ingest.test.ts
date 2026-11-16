import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlbertClient } from "@/lib/albert/client";
import type { Chunk } from "@/lib/albert/types";
import type { PdfSource } from "@/scripts/lib/catalogue";

const extractMock = vi.hoisted(() => ({
	downloadPdf: vi.fn(),
	countPdfPages: vi.fn(),
	extractPages: vi.fn(),
}));

vi.mock("@/scripts/lib/extract", async () => {
	const actual = await vi.importActual<typeof import("@/scripts/lib/extract")>(
		"@/scripts/lib/extract",
	);
	return { ...actual, ...extractMock };
});

import {
	buildChunkMetadata,
	checksumPdf,
	ingestSource,
} from "@/scripts/lib/ingest";

const SOURCE: PdfSource = {
	guideId: "guide-1",
	guideTitle: "Guide de test",
	language: "FR",
	pdfUrl: "https://example.gouv.fr/guide.pdf",
};

type StoredChunk = { content: string; metadata: Chunk["metadata"] };

/**
 * Stands in for the Albert client. Only the ingestion path matters here: the
 * point is the order of the calls and what happens when a batch fails.
 */
function fakeClient(
	behaviour: { addChunksError?: Error; deleteError?: Error } = {},
) {
	const calls = {
		created: [] as Array<{ name: string; collectionId: number }>,
		added: [] as Array<{ documentId: number; chunks: StoredChunk[] }>,
		deleted: [] as number[],
	};

	const client = {
		createDocument: async (params: { name: string; collectionId: number }) => {
			calls.created.push(params);
			return { id: 42 };
		},
		addChunks: async (documentId: number, chunks: StoredChunk[]) => {
			for (let index = 0; index < chunks.length; index += 64) {
				calls.added.push({
					documentId,
					chunks: chunks.slice(index, index + 64),
				});
			}
			if (behaviour.addChunksError) throw behaviour.addChunksError;
		},
		deleteDocument: async (documentId: number) => {
			calls.deleted.push(documentId);
			if (behaviour.deleteError) throw behaviour.deleteError;
		},
	} as unknown as AlbertClient;

	return { client, calls };
}

beforeEach(() => {
	extractMock.downloadPdf
		.mockReset()
		.mockResolvedValue(Buffer.from("%PDF-1.7\ntest\n"));
	extractMock.countPdfPages.mockReset().mockResolvedValue(2);
	extractMock.extractPages.mockReset().mockResolvedValue({
		pages: [
			{ page: 1, text: "a".repeat(400), extraction: "pdf" },
			{ page: 2, text: "b".repeat(400), extraction: "ocr" },
		],
		method: "mixed",
		emptyPages: [],
		ocrFailures: [],
	});
});

describe("ingestSource", () => {
	it("indexes the document once and reports the mixed extraction", async () => {
		const { client, calls } = fakeClient();

		const outcome = await ingestSource({
			source: SOURCE,
			collectionId: 7,
			client,
		});

		expect(outcome).toEqual({
			status: "indexed",
			guideId: "guide-1",
			documentId: 42,
			chunks: 2,
			pages: 2,
			extraction: "mixed",
			pagesWithoutText: [],
			ocrFailedPages: [],
			sourceSha256: checksumPdf(Buffer.from("%PDF-1.7\ntest\n")),
		});
		expect(calls.created).toEqual([{ name: "guide.pdf", collectionId: 7 }]);
		expect(calls.added).toHaveLength(1);
		expect(calls.deleted).toEqual([]);
	});

	it("records the extraction of each page on its own chunks", async () => {
		const { client, calls } = fakeClient();

		await ingestSource({ source: SOURCE, collectionId: 7, client });

		const [first, second] = calls.added[0].chunks;
		expect(first.metadata?.page).toBe(1);
		expect(first.metadata?.extraction).toBe("pdf");
		expect(second.metadata?.page).toBe(2);
		expect(second.metadata?.extraction).toBe("ocr");
	});

	it("stores no citation_url, so source_url and page stay the only source of truth", async () => {
		const { client, calls } = fakeClient();

		await ingestSource({ source: SOURCE, collectionId: 7, client });

		for (const chunk of calls.added[0].chunks) {
			expect(chunk.metadata).not.toHaveProperty("citation_url");
			expect(chunk.metadata?.source_url).toBe(SOURCE.pdfUrl);
		}
	});

	it("reuses the sync download and stores its SHA-256 on every chunk", async () => {
		const { client, calls } = fakeClient();
		const pdf = Buffer.from("%PDF-1.7\nchecksummed\n");

		await ingestSource({ source: SOURCE, collectionId: 7, client, pdf });

		expect(extractMock.downloadPdf).not.toHaveBeenCalled();
		for (const chunk of calls.added[0].chunks) {
			expect(chunk.metadata?.source_sha256).toBe(checksumPdf(pdf));
		}
	});

	it("marks only the final chunk complete for interrupted-run recovery", async () => {
		const { client, calls } = fakeClient();

		await ingestSource({ source: SOURCE, collectionId: 7, client });

		const chunks = calls.added[0].chunks;
		expect(chunks.at(0)?.metadata?.sync_complete).toBe(false);
		expect(chunks.at(-1)?.metadata?.sync_complete).toBe(true);
		for (const chunk of chunks) {
			expect(chunk.metadata?.source_sha256).toBe(
				checksumPdf(Buffer.from("%PDF-1.7\ntest\n")),
			);
		}
	});

	it("marks the extraction incomplete when a page could not be read", async () => {
		extractMock.extractPages.mockResolvedValue({
			pages: [
				{ page: 1, text: "a".repeat(400), extraction: "pdf" },
				{ page: 2, text: "Titre de section", extraction: "pdf" },
			],
			method: "pdf",
			emptyPages: [],
			ocrFailures: [2],
		});
		const { client, calls } = fakeClient();

		await ingestSource({ source: SOURCE, collectionId: 7, client });

		// The PDF bytes will not change, so this marker is the only thing that
		// brings the missing page back on a later run. It goes on the final
		// chunk, the one the next run reads the document metadata from.
		const chunks = calls.added[0].chunks;
		expect(chunks.at(-1)?.metadata?.extraction_complete).toBe(false);
		expect(chunks.at(0)?.metadata?.extraction_complete).toBeUndefined();
	});

	it("marks the extraction complete when every page was read", async () => {
		const { client, calls } = fakeClient();

		await ingestSource({ source: SOURCE, collectionId: 7, client });

		expect(calls.added[0].chunks.at(-1)?.metadata?.extraction_complete).toBe(
			true,
		);
	});

	it("marks the final chunk of the final batch complete, not an earlier batch", async () => {
		extractMock.extractPages.mockResolvedValue({
			pages: Array.from({ length: 65 }, (_, index) => ({
				page: index + 1,
				text: "a".repeat(400),
				extraction: "pdf",
			})),
			method: "pdf",
			emptyPages: [],
			ocrFailures: [],
		});
		const { client, calls } = fakeClient();

		await ingestSource({ source: SOURCE, collectionId: 7, client });

		expect(calls.added[0].chunks).toHaveLength(64);
		expect(calls.added[1].chunks).toHaveLength(1);
		expect(
			calls.added[0].chunks.every(
				(chunk) => chunk.metadata?.sync_complete === false,
			),
		).toBe(true);
		expect(calls.added[1].chunks[0].metadata?.sync_complete).toBe(true);
	});

	it("deletes the document when a chunk batch fails, leaving nothing searchable", async () => {
		const { client, calls } = fakeClient({
			addChunksError: new Error("Albert POST /chunks failed with 500"),
		});

		const outcome = await ingestSource({
			source: SOURCE,
			collectionId: 7,
			client,
		});

		expect(outcome.status).toBe("failed");
		expect(outcome.status === "failed" && outcome.reason).toContain(
			"failed with 500",
		);
		expect(calls.deleted).toEqual([42]);
	});

	it("says so when the partial document could not be deleted", async () => {
		const { client, calls } = fakeClient({
			addChunksError: new Error("Albert POST /chunks failed with 500"),
			deleteError: new Error("Albert DELETE /documents/42 failed with 403"),
		});

		const outcome = await ingestSource({
			source: SOURCE,
			collectionId: 7,
			client,
		});

		expect(calls.deleted).toEqual([42]);
		expect(outcome.status).toBe("failed");
		// The report must not hide a document that stayed in the collection.
		const reason = outcome.status === "failed" ? outcome.reason : "";
		expect(reason).toContain("failed with 500");
		expect(reason).toContain("document partiel 42");
		expect(reason).toContain("403");
	});

	it("does not create a document when no text was extracted", async () => {
		extractMock.extractPages.mockResolvedValue({
			pages: [],
			method: "pdf",
			emptyPages: [],
			ocrFailures: [],
		});
		const { client, calls } = fakeClient();

		const outcome = await ingestSource({
			source: SOURCE,
			collectionId: 7,
			client,
		});

		expect(outcome).toEqual({
			status: "skipped",
			guideId: "guide-1",
			reason: "aucun texte extrait",
		});
		expect(calls.created).toEqual([]);
	});

	it("creates nothing in dry-run mode", async () => {
		const { client, calls } = fakeClient();

		const outcome = await ingestSource({
			source: SOURCE,
			collectionId: 7,
			client,
			dryRun: true,
		});

		expect(outcome).toMatchObject({
			status: "indexed",
			documentId: -1,
			chunks: 2,
		});
		expect(calls.created).toEqual([]);
		expect(calls.added).toEqual([]);
	});

	it("passes on the pages that produced no text, so the report can name them", async () => {
		extractMock.extractPages.mockResolvedValue({
			pages: [
				{ page: 1, text: "a".repeat(400), extraction: "pdf" },
				{ page: 2, text: "", extraction: "pdf" },
			],
			method: "mixed",
			emptyPages: [2],
			ocrFailures: [],
		});
		const { client } = fakeClient();

		const outcome = await ingestSource({
			source: SOURCE,
			collectionId: 7,
			client,
		});

		expect(outcome.status).toBe("indexed");
		expect(outcome.status === "indexed" && outcome.pagesWithoutText).toEqual([
			2,
		]);
	});

	it("passes on the pages the OCR could not read, so the report can name them", async () => {
		extractMock.extractPages.mockResolvedValue({
			pages: [
				{ page: 1, text: "a".repeat(400), extraction: "pdf" },
				{ page: 2, text: "", extraction: "pdf" },
			],
			method: "pdf",
			emptyPages: [2],
			ocrFailures: [2, 5],
		});
		const { client } = fakeClient();

		const outcome = await ingestSource({
			source: SOURCE,
			collectionId: 7,
			client,
		});

		expect(outcome.status).toBe("indexed");
		expect(outcome.status === "indexed" && outcome.ocrFailedPages).toEqual([
			2, 5,
		]);
	});
});

describe("buildChunkMetadata", () => {
	it("derives everything from the source and the page", () => {
		expect(
			buildChunkMetadata(
				{ ...SOURCE, updated: "2026-10-01T12:00:00Z" },
				12,
				"pdf",
			),
		).toEqual({
			guide_id: "guide-1",
			guide_title: "Guide de test",
			source_url: "https://example.gouv.fr/guide.pdf",
			page: 12,
			collection: "FR",
			extraction: "pdf",
			updated: "2026-10-01",
		});
	});
});
