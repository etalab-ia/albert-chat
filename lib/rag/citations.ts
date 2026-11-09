import type { ChunkMetadata, SearchHit } from "@/lib/albert/types";
import { LIMITS } from "@/lib/config";

export type Citation = {
	id: string;
	title: string;
	page: number | null;
	/** Null when the corpus supplies no safe URL; the excerpt remains citable. */
	url: string | null;
	score: number;
};

export type ContextBlock = {
	marker: string;
	citation: Citation;
	content: string;
};

/**
 * Builds a URL that opens a PDF at a given page. The `#page=` fragment is
 * honoured by browsers' built-in PDF viewers and by most intranet PDF plugins.
 */
export function buildCitationUrl(
	sourceUrl: string,
	page: number | null,
): string {
	if (page === null) return sourceUrl;
	// Split on the first "#" only: a fragment may itself contain "#", and
	// `split("#", 2)` would truncate it.
	const hashIndex = sourceUrl.indexOf("#");
	const base = hashIndex === -1 ? sourceUrl : sourceUrl.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : sourceUrl.slice(hashIndex + 1);

	if (!fragment) return `${base}#page=${page}`;
	// A fragment that already sets the page wins: appending a second `page=`
	// gives `#page=5&page=3`, where viewers honour the first value.
	if (/(?:^|&)page=/.test(fragment)) return sourceUrl;
	return `${base}#${fragment}&page=${page}`;
}

function parsePage(value: unknown): number | null {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return value;
	}
	if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) ? parsed : null;
	}
	return null;
}

/** Accepts the generic provenance name and the ANSSI pipeline's legacy field. */
function readPage(metadata: ChunkMetadata | null | undefined): number | null {
	return parsePage(metadata?.page_number) ?? parsePage(metadata?.page);
}

function readTitle(hit: SearchHit): string {
	const metadata = hit.chunk.metadata ?? {};
	for (const candidate of [metadata.title, metadata.guide_title]) {
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			return candidate.trim();
		}
	}
	return `Document ${hit.chunk.document_id}`;
}

/**
 * Only absolute http(s) sources become links. Unsafe or absent URLs do not
 * discard the chunk: its content can still ground an answer safely.
 */
function readSourceUrl(metadata: ChunkMetadata): string | null {
	const sourceUrl = metadata.source_url;
	if (typeof sourceUrl !== "string") return null;
	const trimmed = sourceUrl.trim();
	return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function sourceKey(hit: SearchHit, page: number | null, url: string | null) {
	const {
		collection_id: collectionId,
		document_id: documentId,
		id,
	} = hit.chunk;
	// Without page provenance, merging chunks would truncate unrelated passages
	// at the block size limit. Keep each chunk addressable instead.
	if (page === null)
		return JSON.stringify(["chunk", collectionId, documentId, id]);
	return JSON.stringify(
		url === null
			? ["document-page", collectionId, documentId, page]
			: ["url-page", url],
	);
}

function describeHit(hit: SearchHit) {
	const metadata = hit.chunk.metadata ?? {};
	const page = readPage(metadata);
	const sourceUrl = readSourceUrl(metadata);
	const url = sourceUrl === null ? null : buildCitationUrl(sourceUrl, page);
	return {
		id: `${hit.chunk.collection_id}-${hit.chunk.document_id}-${hit.chunk.id}`,
		title: readTitle(hit),
		page,
		url,
		key: sourceKey(hit, page, url),
	};
}

/** Turns raw search hits into numbered citations, with or without links. */
export function toCitations(hits: SearchHit[]): Citation[] {
	const byKey = new Map<string, Citation>();

	for (const hit of hits) {
		const source = describeHit(hit);
		const existing = byKey.get(source.key);
		if (existing) {
			existing.score = Math.max(existing.score, hit.score);
			continue;
		}

		byKey.set(source.key, {
			id: source.id,
			title: source.title,
			page: source.page,
			url: source.url,
			score: hit.score,
		});
	}

	return [...byKey.values()].sort((left, right) => right.score - left.score);
}

/**
 * Builds the numbered context blocks that the model is asked to cite.
 *
 * Hits sharing a page are merged into a single block, so block N and source N
 * are the same document: the marker the model writes, e.g. [3], indexes the
 * source list the interface renders. Without the merge, two chunks from one
 * page would produce two markers pointing at one source and shift every
 * following marker.
 */
export function buildContextBlocks(hits: SearchHit[]): ContextBlock[] {
	const blocks: ContextBlock[] = [];
	const blockByKey = new Map<string, ContextBlock>();

	for (const hit of hits) {
		const content = hit.chunk.content.trim();
		if (content.length === 0) continue;

		const source = describeHit(hit);
		const existing = blockByKey.get(source.key);

		if (existing) {
			if (existing.content.length < LIMITS.maxChunkCharacters) {
				existing.content = `${existing.content}\n\n${content}`.slice(
					0,
					LIMITS.maxChunkCharacters,
				);
			}
			continue;
		}

		const block: ContextBlock = {
			marker: `[${blocks.length + 1}]`,
			citation: {
				id: source.id,
				title: source.title,
				page: source.page,
				url: source.url,
				score: hit.score,
			},
			content: content.slice(0, LIMITS.maxChunkCharacters),
		};

		blocks.push(block);
		blockByKey.set(source.key, block);
	}

	return blocks;
}

/** The sources of an answer, in the order its markers refer to. */
export function blocksToSources(blocks: ContextBlock[]): Citation[] {
	return blocks.map((block) => block.citation);
}
