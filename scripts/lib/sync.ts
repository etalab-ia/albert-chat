import type { AlbertClient } from "../../lib/albert/client";
import type { AlbertDocument, ChunkMetadata } from "../../lib/albert/types";
import type { PdfSource } from "./catalogue";
import { downloadPdf } from "./extract";
import { checksumPdf, ingestSource } from "./ingest";

export type SyncClient = Pick<
	AlbertClient,
	| "listDocuments"
	| "getDocumentMetadata"
	| "createDocument"
	| "addChunks"
	| "deleteDocument"
	| "ocrPage"
>;

export type InventoryDocument = AlbertDocument & {
	metadata: ChunkMetadata | null;
};

type ManagedDocument = InventoryDocument & {
	guideId: string;
	sourceUrl: string;
};

export type SyncAction = "added" | "replaced" | "unchanged";

export type SyncFailure = {
	subject: string;
	reason: string;
};

export type SyncReport = Record<SyncAction, number> & {
	deleted: number;
	preservedUnmanaged: number;
	failures: SyncFailure[];
	/** Non-fatal findings, such as pages the OCR could not read. */
	warnings: SyncFailure[];
};

type SourceResult = {
	action: SyncAction | null;
	deleted: number;
	failures: SyncFailure[];
	warnings: SyncFailure[];
};

function sourceKey(guideId: string, sourceUrl: string): string {
	return JSON.stringify([guideId, sourceUrl]);
}

function managedDocument(document: InventoryDocument): ManagedDocument | null {
	const metadata = document.metadata;
	if (
		metadata?.collection !== "FR" ||
		typeof metadata.guide_id !== "string" ||
		metadata.guide_id.length === 0 ||
		typeof metadata.source_url !== "string" ||
		!/^https?:\/\//i.test(metadata.source_url)
	) {
		return null;
	}
	return {
		...document,
		guideId: metadata.guide_id,
		sourceUrl: metadata.source_url,
	};
}

function matchesSource(
	document: ManagedDocument,
	source: PdfSource,
	sourceSha256: string,
): boolean {
	const metadata = document.metadata;
	return (
		metadata?.source_sha256 === sourceSha256 &&
		metadata.sync_complete !== false &&
		// A document indexed with pages the OCR could not read is re-extracted on
		// the next run: the checksum alone would keep it out of reach forever.
		metadata.extraction_complete !== false &&
		metadata.guide_title === source.guideTitle &&
		metadata.collection === source.language &&
		(metadata.updated ?? null) === (source.updated?.slice(0, 10) ?? null)
	);
}

function failure(subject: string, error: unknown): SyncFailure {
	return {
		subject,
		reason: error instanceof Error ? error.message : String(error),
	};
}

/**
 * A page the OCR could not read is a warning, not a failure: the page keeps its
 * text layer, the document is still indexed, and the run must not fail for it.
 */
function ocrWarnings(
	outcome: { ocrFailedPages: number[] },
	guideId: string,
): SyncFailure[] {
	if (outcome.ocrFailedPages.length === 0) return [];
	return [
		{
			subject: guideId,
			reason: `pages non lues par l'OCR: ${outcome.ocrFailedPages.join(", ")}`,
		},
	];
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from(
		{ length: Math.min(Math.max(1, limit), items.length) },
		async () => {
			while (next < items.length) {
				const index = next;
				next += 1;
				results[index] = await worker(items[index]);
			}
		},
	);
	await Promise.all(runners);
	return results;
}

/** Reads the complete inventory before any mutation is allowed. */
export async function loadInventory(
	client: SyncClient,
	collectionId: number,
	concurrency = 8,
): Promise<InventoryDocument[]> {
	const documents = await client.listDocuments(collectionId);
	return mapWithConcurrency(documents, concurrency, async (document) => ({
		...document,
		metadata: await client.getDocumentMetadata(document.id, document.chunks),
	}));
}

async function deleteDocuments(
	client: SyncClient,
	documents: ManagedDocument[],
	dryRun: boolean,
): Promise<{ deleted: number; failures: SyncFailure[] }> {
	let deleted = 0;
	const failures: SyncFailure[] = [];
	for (const document of documents) {
		if (!dryRun) {
			try {
				await client.deleteDocument(document.id);
			} catch (error) {
				failures.push(failure(`document ${document.id}`, error));
				continue;
			}
		}
		deleted += 1;
	}
	return { deleted, failures };
}

/**
 * Reconciles PDFs, not guide records: one ANSSI guide can contain many PDFs.
 * Every source is downloaded for its content hash, but a matching hash avoids
 * extraction, OCR, embeddings and all Albert writes.
 */
export async function syncFrenchGuides(params: {
	sources: PdfSource[];
	inventory: InventoryDocument[];
	client: SyncClient;
	collectionId: number;
	dryRun?: boolean;
	concurrency?: number;
	onResult?: (source: PdfSource, result: SourceResult) => void;
}): Promise<SyncReport> {
	const {
		sources,
		inventory,
		client,
		collectionId,
		dryRun = false,
		concurrency = 2,
	} = params;
	const managed = inventory
		.map(managedDocument)
		.filter((document): document is ManagedDocument => document !== null);
	const bySource = new Map<string, ManagedDocument[]>();
	for (const document of managed) {
		const key = sourceKey(document.guideId, document.sourceUrl);
		const group = bySource.get(key) ?? [];
		group.push(document);
		bySource.set(key, group);
	}

	const results = await mapWithConcurrency(
		sources,
		concurrency,
		async (source): Promise<SourceResult> => {
			const previous =
				bySource.get(sourceKey(source.guideId, source.pdfUrl)) ?? [];
			let result: SourceResult;
			try {
				const pdf = await downloadPdf(source.pdfUrl);
				const sourceSha256 = checksumPdf(pdf);
				const current = previous
					.filter((document) => matchesSource(document, source, sourceSha256))
					.sort((left, right) => right.id - left.id);
				if (current.length > 0) {
					const retainedId = current[0].id;
					// A previous interrupted run can leave duplicates. Retain one complete
					// current document and clean the others without reindexing anything.
					const cleanup = await deleteDocuments(
						client,
						previous.filter((document) => document.id !== retainedId),
						dryRun,
					);
					result = {
						action: "unchanged",
						warnings: [],
						...cleanup,
					};
				} else if (dryRun) {
					result = {
						action: previous.length > 0 ? "replaced" : "added",
						deleted: previous.length,
						failures: [],
						warnings: [],
					};
				} else {
					const outcome = await ingestSource({
						source,
						pdf,
						client,
						collectionId,
					});
					if (outcome.status !== "indexed") {
						result = {
							action: null,
							deleted: 0,
							failures: [
								{
									subject: source.guideId,
									reason:
										outcome.status === "skipped"
											? `indexation incomplète: ${outcome.reason}`
											: outcome.reason,
								},
							],
							warnings: [],
						};
					} else {
						// Staging first keeps the previous searchable version alive when
						// download, extraction, OCR or a chunk batch fails.
						const cleanup = await deleteDocuments(client, previous, false);
						result = {
							action: previous.length > 0 ? "replaced" : "added",
							warnings: ocrWarnings(outcome, source.guideId),
							...cleanup,
						};
					}
				}
			} catch (error) {
				result = {
					action: null,
					deleted: 0,
					failures: [failure(source.guideId, error)],
					warnings: [],
				};
			}
			params.onResult?.(source, result);
			return result;
		},
	);

	const failedGuideIds = new Set(
		results.flatMap((result, index) =>
			result.failures.some((item) => item.subject === sources[index].guideId)
				? [sources[index].guideId]
				: [],
		),
	);
	const currentKeys = new Set(
		sources.map((source) => sourceKey(source.guideId, source.pdfUrl)),
	);
	const stale = managed.filter(
		(document) =>
			!currentKeys.has(sourceKey(document.guideId, document.sourceUrl)) &&
			!failedGuideIds.has(document.guideId),
	);
	const staleCleanup = await deleteDocuments(client, stale, dryRun);

	const report: SyncReport = {
		added: 0,
		replaced: 0,
		unchanged: 0,
		deleted: staleCleanup.deleted,
		preservedUnmanaged: inventory.length - managed.length,
		failures: [...staleCleanup.failures],
		warnings: [],
	};
	for (const result of results) {
		if (result.action) report[result.action] += 1;
		report.deleted += result.deleted;
		report.failures.push(...result.failures);
		report.warnings.push(...result.warnings);
	}
	return report;
}
