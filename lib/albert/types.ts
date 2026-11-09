/** Wire types for the subset of the Albert API used by this POC. */

export type ChunkMetadata = {
	/** Generic display title; `guide_title` remains the ANSSI compatibility field. */
	title?: string;
	guide_id?: string;
	guide_title?: string;
	source_url?: string;
	source_sha256?: string;
	/** Written on every new chunk; only the final chunk marks ingestion complete. */
	sync_complete?: boolean;
	/** Generic page provenance; `page` remains the ANSSI compatibility field. */
	page_number?: number;
	page?: number;
	updated?: string;
	collection?: string;
	extraction?: string;
	[key: string]: string | number | boolean | null | undefined;
};

export type AlbertDocument = {
	id: number;
	name: string;
	collection_id: number;
	created: number;
	chunks?: number;
};

export type Chunk = {
	object?: "chunk";
	id: number;
	collection_id: number;
	document_id: number;
	content: string;
	metadata?: ChunkMetadata | null;
};

export type SearchHit = {
	method: "semantic" | "lexical" | "hybrid";
	score: number;
	chunk: Chunk;
};

export type SearchResponse = {
	data: SearchHit[];
};

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

export type OCRPage = {
	index: number;
	markdown?: string | null;
};

export type OCRResponse = {
	pages: OCRPage[];
};
