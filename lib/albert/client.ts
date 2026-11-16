import type {
	AlbertDocument,
	ChatCompletionResponse,
	ChatMessage,
	Chunk,
	ChunkMetadata,
	OcrPageResult,
	SearchHit,
	SearchResponse,
} from "./types";

export type AlbertConfig = {
	baseUrl: string;
	apiKey: string;
};

/**
 * Output budgets for one OCR page. 4096 is the budget the OCR guide documents
 * and reads an ordinary page; a page that overflows it is retried once with
 * 8192 before being reported as truncated. A 1540 px page costs about 2200
 * prompt tokens, so both stay inside the model's 16384-token context.
 */
const OCR_MAX_TOKENS = 4096;
const OCR_RETRY_MAX_TOKENS = 8192;

/**
 * Minimal Albert API client. Every method here is server-only: the API key must
 * never be bundled into the browser.
 */
export class AlbertClient {
	private readonly baseUrl: string;
	private readonly apiKey: string;

	constructor(config: AlbertConfig) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.apiKey = config.apiKey;
	}

	private async request(
		path: string,
		init: RequestInit = {},
	): Promise<Response> {
		// FormData bodies must keep the multipart boundary that fetch generates, so
		// only JSON payloads get an explicit Content-Type.
		const isFormData = init.body instanceof FormData;

		const response = await fetch(`${this.baseUrl}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				...(init.body && !isFormData
					? { "Content-Type": "application/json" }
					: {}),
				...init.headers,
			},
			cache: "no-store",
		});

		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new AlbertError(
				`Albert ${init.method ?? "GET"} ${path} failed with ${response.status}`,
				response.status,
				detail.slice(0, 500),
			);
		}

		return response;
	}

	async search(params: {
		query: string;
		collectionIds: number[];
		limit?: number;
		method?: "hybrid" | "semantic" | "lexical";
		scoreThreshold?: number;
		signal?: AbortSignal;
	}): Promise<SearchHit[]> {
		const response = await this.request("/v1/search", {
			method: "POST",
			signal: params.signal,
			body: JSON.stringify({
				query: params.query,
				collection_ids: params.collectionIds,
				method: params.method ?? "hybrid",
				limit: params.limit ?? 8,
				...(params.scoreThreshold === undefined
					? {}
					: { score_threshold: params.scoreThreshold }),
			}),
		});

		const payload = (await response.json()) as SearchResponse;
		return payload.data ?? [];
	}

	/**
	 * Streams an assistant answer. Yields content deltas only; reasoning deltas
	 * emitted by models such as gpt-oss-120b are filtered out.
	 */
	async *streamChat(params: {
		messages: ChatMessage[];
		model: string;
		temperature?: number;
		signal?: AbortSignal;
	}): AsyncGenerator<string, void, unknown> {
		const response = await this.request("/v1/chat/completions", {
			method: "POST",
			signal: params.signal,
			body: JSON.stringify({
				model: params.model,
				messages: params.messages,
				stream: true,
				temperature: params.temperature ?? 0.2,
			}),
		});

		if (!response.body) {
			throw new AlbertError("Albert returned an empty stream", 502, "");
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				// Normalise CRLF framing: the SSE spec allows it, and searching for
				// "\n\n" alone would never find a boundary and drop the whole answer.
				buffer += decoder
					.decode(value, { stream: true })
					.replace(/\r\n/g, "\n");

				// SSE frames are separated by a blank line; keep any trailing partial
				// frame in the buffer for the next read.
				let boundary = buffer.indexOf("\n\n");
				while (boundary !== -1) {
					const frame = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const delta = parseSSEFrame(frame);
					if (delta === DONE) return;
					if (delta) yield delta;
					boundary = buffer.indexOf("\n\n");
				}
			}

			buffer += decoder.decode();
			const tail = parseSSEFrame(buffer);
			if (tail && tail !== DONE) yield tail;
		} finally {
			reader.releaseLock();
		}
	}

	async createCollection(params: {
		name: string;
		description?: string;
		visibility?: "public" | "private";
	}): Promise<{ id: number; name: string }> {
		const response = await this.request("/v1/collections", {
			method: "POST",
			body: JSON.stringify({
				name: params.name,
				description: params.description ?? "",
				visibility: params.visibility ?? "public",
			}),
		});
		return (await response.json()) as { id: number; name: string };
	}

	async findCollectionByName(
		name: string,
	): Promise<{ id: number; name: string } | null> {
		// The listing endpoint is paginated (10 by default); filter server-side so a
		// collection is not missed once the account holds more than one page.
		const response = await this.request(
			`/v1/collections?name=${encodeURIComponent(name)}&limit=100`,
		);
		const payload = (await response.json()) as {
			data?: Array<{ id: number; name: string }>;
		};
		return (payload.data ?? []).find((item) => item.name === name) ?? null;
	}

	/** Creates a document without a file, so its chunks can be supplied by hand. */
	async createDocument(params: {
		name: string;
		collectionId: number;
	}): Promise<{ id: number }> {
		// Albert expects multipart/form-data here, not JSON: the optional `file`
		// part is what distinguishes an upload from a hand-filled document.
		const body = new FormData();
		body.set("collection_id", String(params.collectionId));
		body.set("name", params.name);

		const response = await this.request("/v1/documents", {
			method: "POST",
			body,
		});
		return (await response.json()) as { id: number };
	}

	/** Deletes a document and its chunks; used to discard a partial ingestion. */
	async deleteDocument(documentId: number): Promise<void> {
		await this.request(`/v1/documents/${documentId}`, { method: "DELETE" });
	}

	/** Albert accepts at most 64 chunks per call. */
	async addChunks(
		documentId: number,
		chunks: Array<{ content: string; metadata: Chunk["metadata"] }>,
	): Promise<void> {
		const BATCH = 64;
		for (let index = 0; index < chunks.length; index += BATCH) {
			await this.request(`/v1/documents/${documentId}/chunks`, {
				method: "POST",
				body: JSON.stringify({
					chunks: chunks.slice(index, index + BATCH).map((chunk) => ({
						content: chunk.content,
						metadata: chunk.metadata ?? {},
					})),
				}),
			});
		}
	}

	/** Lists every document, following Albert's 100-item page limit. */
	async listDocuments(collectionId: number): Promise<AlbertDocument[]> {
		const documents: AlbertDocument[] = [];
		for (let offset = 0; ; offset += 100) {
			const response = await this.request(
				`/v1/documents?collection_id=${collectionId}&limit=100&offset=${offset}`,
			);
			const payload = (await response.json()) as {
				data?: AlbertDocument[];
			};
			const page = payload.data ?? [];
			documents.push(...page);
			if (page.length < 100) return documents;
		}
	}

	/** Albert can return the final inserted chunk anywhere in its chunk ordering. */
	async getDocumentMetadata(
		documentId: number,
		chunkCount?: number,
	): Promise<ChunkMetadata | null> {
		if (chunkCount === 0) return null;
		const PAGE_SIZE = 100;
		let fallback: ChunkMetadata | null = null;
		for (let offset = 0; ; offset += PAGE_SIZE) {
			const response = await this.request(
				`/v1/documents/${documentId}/chunks?limit=${PAGE_SIZE}&offset=${offset}`,
			);
			const payload = (await response.json()) as { data?: Chunk[] };
			const chunks = payload.data ?? [];
			fallback ??= chunks[0]?.metadata ?? null;
			const completed = chunks.find(
				(chunk) => chunk.metadata?.sync_complete === true,
			);
			if (completed) return completed.metadata ?? null;
			if (chunks.length < PAGE_SIZE) return fallback;
		}
	}

	/**
	 * Reads one page image through the OCR model.
	 *
	 * Albert's default OCR route is `/v1/chat/completions` with
	 * `openweight-ocr`: `/v1/ocr` only serves `mistral-ocr-2512`, which is not
	 * available to every credential. It also takes a whole document, which makes
	 * a single unreadable page fail every other page of that document.
	 *
	 * A page that overflows the output budget comes back as a prefix of itself
	 * with `finish_reason: "length"`. The result says so rather than passing the
	 * prefix off as the whole page, so the ingestion can keep the text it has
	 * and still treat the page as incomplete. The page is sent again with a
	 * larger budget, and the first answer is kept when that attempt fails or
	 * brings back nothing.
	 */
	async ocrPage(params: {
		image: Buffer;
		mediaType?: string;
		model?: string;
	}): Promise<OcrPageResult> {
		const mediaType = params.mediaType ?? "image/jpeg";
		const body = (maxTokens: number) =>
			JSON.stringify({
				model: params.model ?? "openweight-ocr",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image_url",
								image_url: {
									url: `data:${mediaType};base64,${params.image.toString("base64")}`,
								},
							},
						],
					},
				],
				max_tokens: maxTokens,
				temperature: 0.2,
				top_p: 0.9,
			});

		const first = await this.completePage(body(OCR_MAX_TOKENS));
		if (!first.truncated) return first;
		try {
			const retry = await this.completePage(body(OCR_RETRY_MAX_TOKENS));
			if (retry.text?.trim()) return retry;
		} catch {
			// The retry is a second chance at the whole page, not a condition for
			// keeping the first answer: a failure here must not cost the page the
			// prefix already read. Falling through keeps that text and leaves the
			// page reported as partial.
		}
		return first;
	}

	/**
	 * Sends one completion, retrying a transient Albert failure. A busy OCR
	 * model is transient, and a page image is cheap to send again.
	 */
	private async completePage(body: string): Promise<OcrPageResult> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				const response = await this.request("/v1/chat/completions", {
					method: "POST",
					body,
				});
				const payload = (await response.json()) as ChatCompletionResponse;
				const choice = payload.choices?.[0];
				return {
					text: choice?.message?.content ?? null,
					truncated: choice?.finish_reason === "length",
				};
			} catch (error) {
				const retryable =
					error instanceof AlbertError &&
					[429, 502, 503, 504].includes(error.status);
				if (!retryable || attempt === 3) throw error;
				await new Promise((resolve) =>
					setTimeout(resolve, 1000 * 2 ** attempt),
				);
			}
		}
	}
}

export class AlbertError extends Error {
	readonly status: number;
	readonly detail: string;

	constructor(message: string, status: number, detail: string) {
		super(message);
		this.name = "AlbertError";
		this.status = status;
		this.detail = detail;
	}
}

const DONE = Symbol("sse-done");

function parseSSEFrame(frame: string): string | null | typeof DONE {
	let result: string | null | typeof DONE = null;

	for (const line of frame.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (!data) continue;
		if (data === "[DONE]") return DONE;

		let payload: {
			choices?: Array<{
				delta?: { content?: string | null; reasoning?: string | null };
			}>;
		};
		try {
			payload = JSON.parse(data);
		} catch {
			continue;
		}

		const content = payload.choices?.[0]?.delta?.content;
		if (content) result = (result === null ? "" : result) + content;
	}

	return result;
}
