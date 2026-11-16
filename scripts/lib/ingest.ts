import { createHash } from "node:crypto";
import { type AlbertClient, AlbertError } from "../../lib/albert/client";
import type { ChunkMetadata } from "../../lib/albert/types";
import type { PdfSource } from "./catalogue";
import { chunkPageText } from "./chunk";
import {
	assertPdfBuffer,
	countPdfPages,
	downloadPdf,
	type ExtractionMethod,
	extractPages,
	type PageExtraction,
} from "./extract";

export type IngestOutcome =
	| {
			status: "indexed";
			guideId: string;
			documentId: number;
			chunks: number;
			pages: number;
			extraction: ExtractionMethod;
			/** Pages with no text even after OCR; they carry no chunk. */
			pagesWithoutText: number[];
			/** Pages the OCR could not read; they keep their text layer. */
			ocrFailedPages: number[];
			sourceSha256: string;
	  }
	| { status: "skipped"; guideId: string; reason: string }
	| { status: "failed"; guideId: string; reason: string };

/**
 * Downloads one guide PDF, splits it page by page and indexes the chunks as a
 * manually-populated Albert document. Chunk metadata carries the page number and
 * a citation URL that opens the PDF at that page.
 */
export function checksumPdf(pdf: Buffer): string {
	return createHash("sha256").update(pdf).digest("hex");
}

export async function ingestSource(params: {
	source: PdfSource;
	collectionId: number;
	client: Pick<
		AlbertClient,
		"createDocument" | "addChunks" | "deleteDocument" | "ocrPage"
	>;
	dryRun?: boolean;
	/** Reuse a download made by the synchronizer's checksum comparison. */
	pdf?: Buffer;
}): Promise<IngestOutcome> {
	const { source, collectionId, client } = params;

	try {
		const pdf = params.pdf ?? (await downloadPdf(source.pdfUrl));
		assertPdfBuffer(pdf);
		const sourceSha256 = checksumPdf(pdf);

		const pageCount = await countPdfPages(pdf);
		const extracted = await extractPages({
			pdf,
			pageCount,
			ocr: async (page) => client.ocrPage({ image: page.image }),
		});

		const chunks = extracted.pages.flatMap((page) =>
			chunkPageText(page.page, page.text).map((chunk) => ({
				content: chunk.content,
				metadata: buildChunkMetadata(
					source,
					chunk.page,
					page.extraction,
					sourceSha256,
					false,
				),
			})),
		);

		const finalChunk = chunks.at(-1);
		if (finalChunk) {
			finalChunk.metadata = {
				...finalChunk.metadata,
				sync_complete: true,
			};
		}

		if (chunks.length === 0) {
			return {
				status: "skipped",
				guideId: source.guideId,
				reason: "aucun texte extrait",
			};
		}

		if (params.dryRun) {
			return {
				status: "indexed",
				guideId: source.guideId,
				documentId: -1,
				chunks: chunks.length,
				pages: extracted.pages.length,
				extraction: extracted.method,
				pagesWithoutText: extracted.emptyPages,
				ocrFailedPages: extracted.ocrFailures,
				sourceSha256,
			};
		}

		const document = await client.createDocument({
			name: source.pdfUrl.split("/").pop() ?? `${source.guideId}.pdf`,
			collectionId,
		});

		try {
			await client.addChunks(document.id, chunks);
		} catch (error) {
			// Chunks are written in batches, so a failure part-way leaves a document
			// that is already searchable with a fraction of its text while the
			// report says the guide failed. Remove it and keep the original error.
			try {
				await client.deleteDocument(document.id);
			} catch (cleanupError) {
				throw new Error(
					`${describeFailure(error)} (document partiel ${document.id} non supprimé: ` +
						`${describeFailure(cleanupError)})`,
				);
			}
			throw error;
		}

		return {
			status: "indexed",
			guideId: source.guideId,
			documentId: document.id,
			chunks: chunks.length,
			pages: extracted.pages.length,
			extraction: extracted.method,
			pagesWithoutText: extracted.emptyPages,
			ocrFailedPages: extracted.ocrFailures,
			sourceSha256,
		};
	} catch (error) {
		return {
			status: "failed",
			guideId: source.guideId,
			reason: describeFailure(error),
		};
	}
}

/** Keeps the API's own explanation in the report; a bare status code hides it. */
function describeFailure(error: unknown): string {
	if (error instanceof AlbertError) {
		return error.detail ? `${error.message}: ${error.detail}` : error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

export function buildChunkMetadata(
	source: PdfSource,
	page: number,
	extraction: PageExtraction,
	sourceSha256?: string,
	syncComplete?: boolean,
): ChunkMetadata {
	return {
		guide_id: source.guideId,
		guide_title: source.guideTitle,
		source_url: source.pdfUrl,
		...(sourceSha256 ? { source_sha256: sourceSha256 } : {}),
		...(syncComplete === undefined ? {} : { sync_complete: syncComplete }),
		page,
		collection: source.language,
		extraction,
		...(source.updated ? { updated: source.updated.slice(0, 10) } : {}),
	};
}
