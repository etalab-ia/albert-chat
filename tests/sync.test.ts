import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChunkMetadata } from "@/lib/albert/types";
import type { PdfSource } from "@/scripts/lib/catalogue";
import { checksumPdf } from "@/scripts/lib/ingest";

const mocks = vi.hoisted(() => ({
	downloadPdf: vi.fn(),
	ingestSource: vi.fn(),
}));

vi.mock("@/scripts/lib/extract", () => ({
	downloadPdf: mocks.downloadPdf,
}));
vi.mock("@/scripts/lib/ingest", async () => {
	const actual = await vi.importActual<typeof import("@/scripts/lib/ingest")>(
		"@/scripts/lib/ingest",
	);
	return { ...actual, ingestSource: mocks.ingestSource };
});

import {
	type InventoryDocument,
	type SyncClient,
	syncFrenchGuides,
} from "@/scripts/lib/sync";

const PDF = Buffer.from("%PDF-1.7\noriginal\n");
const UPDATED_PDF = Buffer.from("%PDF-1.7\nupdated\n");
const URL = "https://messervices.cyber.gouv.fr/documents-guides/guide.pdf";

function source(overrides: Partial<PdfSource> = {}): PdfSource {
	return {
		guideId: "guide-1",
		guideTitle: "Guide un",
		language: "FR",
		pdfUrl: URL,
		updated: "2026-10-01T00:00:00.000Z",
		...overrides,
	};
}

function metadata(overrides: Partial<ChunkMetadata> = {}): ChunkMetadata {
	return {
		guide_id: "guide-1",
		guide_title: "Guide un",
		source_url: URL,
		source_sha256: checksumPdf(PDF),
		collection: "FR",
		updated: "2026-10-01",
		...overrides,
	};
}

function document(
	id: number,
	meta: ChunkMetadata | null = metadata(),
): InventoryDocument {
	return {
		id,
		name: `document-${id}.pdf`,
		collection_id: 7,
		created: id,
		metadata: meta,
	};
}

function fakeClient() {
	const calls = {
		created: [] as number[],
		deleted: [] as number[],
		order: [] as string[],
	};
	const client: SyncClient = {
		listDocuments: vi.fn(),
		getDocumentMetadata: vi.fn(),
		createDocument: vi.fn(async ({ collectionId }) => {
			calls.created.push(collectionId);
			calls.order.push("create");
			return { id: 100 };
		}),
		addChunks: vi.fn(),
		ocrPage: vi.fn(),
		deleteDocument: vi.fn(async (id: number) => {
			calls.deleted.push(id);
			calls.order.push(`delete:${id}`);
		}),
	};
	return { client, calls };
}

function indexed(overrides: Record<string, unknown> = {}) {
	return {
		status: "indexed",
		guideId: "guide-1",
		documentId: 100,
		chunks: 2,
		pages: 1,
		extraction: "pdf",
		pagesWithoutText: [],
		ocrFailedPages: [],
		sourceSha256: checksumPdf(UPDATED_PDF),
		...overrides,
	};
}

beforeEach(() => {
	mocks.downloadPdf.mockReset().mockResolvedValue(UPDATED_PDF);
	mocks.ingestSource.mockReset().mockResolvedValue(indexed());
});

describe("syncFrenchGuides", () => {
	it("adds a new PDF and reports its checksum-bearing ingestion", async () => {
		const { client, calls } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source()],
			inventory: [],
			client,
			collectionId: 7,
		});

		expect(report).toMatchObject({ added: 1, deleted: 0, failures: [] });
		expect(mocks.ingestSource).toHaveBeenCalledWith({
			source: source(),
			pdf: UPDATED_PDF,
			client,
			collectionId: 7,
		});
		expect(calls.created).toEqual([]);
	});

	it("leaves an identical PDF indexed without extraction, OCR or writes", async () => {
		mocks.downloadPdf.mockResolvedValue(PDF);
		const { client, calls } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source()],
			inventory: [document(1)],
			client,
			collectionId: 7,
		});

		expect(report).toMatchObject({ unchanged: 1, deleted: 0, failures: [] });
		expect(mocks.ingestSource).not.toHaveBeenCalled();
		expect(client.createDocument).not.toHaveBeenCalled();
		expect(client.addChunks).not.toHaveBeenCalled();
		expect(client.ocrPage).not.toHaveBeenCalled();
		expect(calls.deleted).toEqual([]);
	});

	it("re-extracts a document whose pages could not all be read", async () => {
		// The bytes are unchanged, so only the metadata can notice that the
		// previous run left a page out. Without it the page is never retried.
		mocks.downloadPdf.mockResolvedValue(PDF);
		const { client } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source()],
			inventory: [document(1, metadata({ extraction_complete: false }))],
			client,
			collectionId: 7,
		});

		expect(report).toMatchObject({ replaced: 1, unchanged: 0, failures: [] });
		expect(mocks.ingestSource).toHaveBeenCalledTimes(1);
	});

	it("keeps skipping a document the OCR read in full", async () => {
		mocks.downloadPdf.mockResolvedValue(PDF);
		const { client } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source()],
			inventory: [document(1, metadata({ extraction_complete: true }))],
			client,
			collectionId: 7,
		});

		expect(report).toMatchObject({ unchanged: 1, replaced: 0, failures: [] });
		expect(mocks.ingestSource).not.toHaveBeenCalled();
	});

	it("detects changed bytes even when URL and catalogue date are unchanged", async () => {
		const { client, calls } = fakeClient();
		mocks.ingestSource.mockImplementationOnce(async () => {
			calls.order.push("ingest-complete");
			return indexed();
		});
		const report = await syncFrenchGuides({
			sources: [source()],
			inventory: [document(1)],
			client,
			collectionId: 7,
		});

		expect(report).toMatchObject({ replaced: 1, deleted: 1, failures: [] });
		expect(mocks.ingestSource).toHaveBeenCalledOnce();
		expect(calls.order).toEqual(["ingest-complete", "delete:1"]);
	});

	it("migrates a legacy document without a checksum without leaving a duplicate", async () => {
		mocks.downloadPdf.mockResolvedValue(PDF);
		const { client, calls } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source()],
			inventory: [document(1, metadata({ source_sha256: undefined }))],
			client,
			collectionId: 7,
		});

		expect(report).toMatchObject({ replaced: 1, deleted: 1, failures: [] });
		expect(calls.deleted).toEqual([1]);
	});

	it("replaces metadata when the guide title changes but the PDF does not", async () => {
		mocks.downloadPdf.mockResolvedValue(PDF);
		const { client } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source({ guideTitle: "Nouveau titre" })],
			inventory: [document(1)],
			client,
			collectionId: 7,
		});

		expect(report).toMatchObject({ replaced: 1, deleted: 1, failures: [] });
		expect(mocks.ingestSource).toHaveBeenCalledOnce();
	});

	it("handles several PDFs belonging to one guide independently", async () => {
		const other = source({ pdfUrl: `${URL}?part=2` });
		mocks.downloadPdf.mockImplementation(async (url: string) =>
			url === URL ? PDF : UPDATED_PDF,
		);
		const { client, calls } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source(), other],
			inventory: [
				document(1),
				document(2, metadata({ source_url: other.pdfUrl })),
			],
			client,
			collectionId: 7,
			concurrency: 1,
		});

		expect(report).toMatchObject({
			added: 0,
			replaced: 1,
			unchanged: 1,
			deleted: 1,
			failures: [],
		});
		expect(calls.deleted).toEqual([2]);
	});

	it("deletes disappeared managed documents and preserves unrelated documents", async () => {
		const { client, calls } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source()],
			inventory: [
				document(1),
				document(
					2,
					metadata({ source_url: "https://example.gouv.fr/old.pdf" }),
				),
				document(3, null),
				document(4, metadata({ collection: "EN" })),
			],
			client,
			collectionId: 7,
		});

		expect(report).toMatchObject({
			replaced: 1,
			deleted: 2,
			preservedUnmanaged: 2,
			failures: [],
		});
		expect(calls.deleted).toEqual(expect.arrayContaining([1, 2]));
		expect(calls.deleted).not.toContain(3);
		expect(calls.deleted).not.toContain(4);
	});

	it("keeps the previous document when replacement fails", async () => {
		mocks.ingestSource.mockResolvedValue({
			status: "failed",
			guideId: "guide-1",
			reason: "OCR indisponible",
		});
		const { client, calls } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source()],
			inventory: [document(1)],
			client,
			collectionId: 7,
		});

		expect(report.added).toBe(0);
		expect(report.replaced).toBe(0);
		expect(report.failures).toEqual([
			{ subject: "guide-1", reason: "OCR indisponible" },
		]);
		expect(calls.deleted).toEqual([]);
	});

	it("reports unread OCR pages as warnings without failing the run", async () => {
		mocks.ingestSource.mockResolvedValue(
			indexed({ pagesWithoutText: [2], ocrFailedPages: [2, 5] }),
		);
		const { client } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source()],
			inventory: [],
			client,
			collectionId: 7,
		});

		// A page the OCR could not read leaves a document that is still worth
		// indexing, so it must not turn the whole scheduled run red.
		expect(report).toMatchObject({ added: 1, failures: [] });
		expect(report.warnings).toEqual([
			{ subject: "guide-1", reason: "pages non lues par l'OCR: 2, 5" },
		]);
	});

	it("does not delete an old URL when the replacement at the new URL fails", async () => {
		mocks.ingestSource.mockResolvedValue({
			status: "skipped",
			guideId: "guide-1",
			reason: "aucun texte extrait",
		});
		const { client, calls } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source({ pdfUrl: `${URL}?v=2` })],
			inventory: [document(1)],
			client,
			collectionId: 7,
		});

		expect(report.failures).toHaveLength(1);
		expect(calls.deleted).toEqual([]);
	});

	it("keeps the previous document when the download fails", async () => {
		mocks.downloadPdf.mockRejectedValue(new Error("HTTP 503"));
		const { client, calls } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source()],
			inventory: [document(1)],
			client,
			collectionId: 7,
		});

		expect(report.failures[0]).toMatchObject({ reason: "HTTP 503" });
		expect(mocks.ingestSource).not.toHaveBeenCalled();
		expect(calls.deleted).toEqual([]);
	});

	it("reports a cleanup failure without hiding the successful replacement", async () => {
		const { client } = fakeClient();
		vi.mocked(client.deleteDocument).mockRejectedValue(new Error("HTTP 500"));
		const report = await syncFrenchGuides({
			sources: [source()],
			inventory: [document(1)],
			client,
			collectionId: 7,
		});

		expect(report).toMatchObject({ replaced: 1, deleted: 0 });
		expect(report.failures).toEqual([
			{ subject: "document 1", reason: "HTTP 500" },
		]);
	});

	it("keeps one current duplicate and removes the others without reindexing", async () => {
		mocks.downloadPdf.mockResolvedValue(PDF);
		const { client, calls } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source()],
			inventory: [document(1), document(2)],
			client,
			collectionId: 7,
		});

		expect(report).toMatchObject({ unchanged: 1, deleted: 1, failures: [] });
		expect(calls.deleted).toEqual([1]);
		expect(mocks.ingestSource).not.toHaveBeenCalled();
	});

	it("replaces an incomplete duplicate even when its checksum matches", async () => {
		mocks.downloadPdf.mockResolvedValue(PDF);
		const { client, calls } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source()],
			inventory: [document(1), document(2, metadata({ sync_complete: false }))],
			client,
			collectionId: 7,
		});

		expect(report).toMatchObject({ unchanged: 1, deleted: 1, failures: [] });
		expect(calls.deleted).toEqual([2]);
		expect(mocks.ingestSource).not.toHaveBeenCalled();
	});

	it("dry-run computes decisions but performs no Albert writes or extraction", async () => {
		const { client, calls } = fakeClient();
		const report = await syncFrenchGuides({
			sources: [source()],
			inventory: [
				document(1),
				document(
					2,
					metadata({ source_url: "https://example.gouv.fr/old.pdf" }),
				),
			],
			client,
			collectionId: 7,
			dryRun: true,
		});

		expect(report).toMatchObject({ replaced: 1, deleted: 2, failures: [] });
		expect(mocks.ingestSource).not.toHaveBeenCalled();
		expect(calls.created).toEqual([]);
		expect(calls.deleted).toEqual([]);
		expect(client.createDocument).not.toHaveBeenCalled();
		expect(client.deleteDocument).not.toHaveBeenCalled();
	});
});
