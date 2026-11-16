import { describe, expect, it, vi } from "vitest";
import { AlbertClient, AlbertError } from "@/lib/albert/client";

function sseResponse(frames: string[]): Response {
	const body = frames.join("");
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

async function collect(iterator: AsyncGenerator<string>): Promise<string> {
	let output = "";
	for await (const delta of iterator) output += delta;
	return output;
}

describe("AlbertClient.streamChat", () => {
	it("concatenates content deltas", async () => {
		const response = sseResponse([
			'data: {"choices":[{"delta":{"content":"Bon"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"jour"}}]}\n\n',
			"data: [DONE]\n\n",
		]);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

		const client = new AlbertClient({
			baseUrl: "https://albert.test",
			apiKey: "sk-test",
		});

		const text = await collect(
			client.streamChat({
				messages: [{ role: "user", content: "q" }],
				model: "m",
			}),
		);
		expect(text).toBe("Bonjour");
		vi.unstubAllGlobals();
	});

	it("ignores reasoning deltas", async () => {
		const response = sseResponse([
			'data: {"choices":[{"delta":{"reasoning":"je réfléchis"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"Réponse"}}]}\n\n',
			"data: [DONE]\n\n",
		]);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

		const client = new AlbertClient({
			baseUrl: "https://albert.test",
			apiKey: "sk-test",
		});

		const text = await collect(
			client.streamChat({
				messages: [{ role: "user", content: "q" }],
				model: "m",
			}),
		);
		expect(text).toBe("Réponse");
		expect(text).not.toContain("réfléchis");
		vi.unstubAllGlobals();
	});

	it("reassembles a frame split across reads", async () => {
		const encoder = new TextEncoder();
		const chunks = [
			'data: {"choices":[{"delta":{"content":"moi',
			'tié"}}]}\n\ndata: [DONE]\n\n',
		];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(stream, { status: 200 })),
		);

		const client = new AlbertClient({
			baseUrl: "https://albert.test",
			apiKey: "sk-test",
		});

		const text = await collect(
			client.streamChat({
				messages: [{ role: "user", content: "q" }],
				model: "m",
			}),
		);
		expect(text).toBe("moitié");
		vi.unstubAllGlobals();
	});

	it("ignores a malformed frame instead of failing the stream", async () => {
		const response = sseResponse([
			"data: {not json}\n\n",
			'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
			"data: [DONE]\n\n",
		]);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

		const client = new AlbertClient({
			baseUrl: "https://albert.test",
			apiKey: "sk-test",
		});

		const text = await collect(
			client.streamChat({
				messages: [{ role: "user", content: "q" }],
				model: "m",
			}),
		);
		expect(text).toBe("ok");
		vi.unstubAllGlobals();
	});
});

describe("AlbertClient error handling", () => {
	it("raises AlbertError carrying the API detail", async () => {
		vi.stubGlobal(
			"fetch",
			// A fresh Response per call: a reused one is already consumed on read.
			vi
				.fn()
				.mockImplementation(() =>
					Promise.resolve(
						new Response('{"detail":"collection inconnue"}', { status: 404 }),
					),
				),
		);

		const client = new AlbertClient({
			baseUrl: "https://albert.test",
			apiKey: "sk-test",
		});

		await expect(
			client.search({ query: "q", collectionIds: [1] }),
		).rejects.toBeInstanceOf(AlbertError);

		await expect(
			client.search({ query: "q", collectionIds: [1] }),
		).rejects.toMatchObject({
			status: 404,
			detail: '{"detail":"collection inconnue"}',
		});
		vi.unstubAllGlobals();
	});

	it("never puts the key in the URL", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ data: [] }));
		vi.stubGlobal("fetch", fetchMock);

		const client = new AlbertClient({
			baseUrl: "https://albert.test/",
			apiKey: "sk-secret",
		});
		await client.search({ query: "q", collectionIds: [1] });

		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("https://albert.test/v1/search");
		expect(String(url)).not.toContain("sk-secret");
		const headers = init?.headers as Record<string, string> | undefined;
		expect(headers?.Authorization).toBe("Bearer sk-secret");
		vi.unstubAllGlobals();
	});
});

describe("AlbertClient.addChunks", () => {
	it("splits into batches of 64", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({}));
		vi.stubGlobal("fetch", fetchMock);

		const client = new AlbertClient({
			baseUrl: "https://albert.test",
			apiKey: "sk-test",
		});

		const chunks = Array.from({ length: 130 }, (_, index) => ({
			content: `chunk ${index}`,
			metadata: { page: index + 1 },
		}));

		await client.addChunks(42, chunks);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		const sizes = fetchMock.mock.calls.map(
			([, init]) => JSON.parse(String(init?.body)).chunks.length,
		);
		expect(sizes).toEqual([64, 64, 2]);
		vi.unstubAllGlobals();
	});
});

describe("AlbertClient document inventory", () => {
	it("paginates the complete document list", async () => {
		const page = (offset: number, count: number) =>
			Array.from({ length: count }, (_, index) => ({
				id: offset + index + 1,
				name: `${offset + index + 1}.pdf`,
				collection_id: 7,
				created: 1,
			}));
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ data: page(0, 100) }))
			.mockResolvedValueOnce(Response.json({ data: page(100, 1) }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new AlbertClient({
			baseUrl: "https://albert.test",
			apiKey: "sk-test",
		});

		const documents = await client.listDocuments(7);

		expect(documents).toHaveLength(101);
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			"https://albert.test/v1/documents?collection_id=7&limit=100&offset=0",
			"https://albert.test/v1/documents?collection_id=7&limit=100&offset=100",
		]);
		vi.unstubAllGlobals();
	});

	it("finds completion metadata when Albert does not return the final chunk last", async () => {
		const chunks = Array.from({ length: 100 }, (_, index) => ({
			metadata: {
				source_sha256: "abc",
				page: index + 1,
				sync_complete: index === 74,
			},
		}));
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ data: chunks }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new AlbertClient({
			baseUrl: "https://albert.test",
			apiKey: "sk-test",
		});

		await expect(client.getDocumentMetadata(42, 128)).resolves.toEqual({
			source_sha256: "abc",
			page: 75,
			sync_complete: true,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toBe(
			"https://albert.test/v1/documents/42/chunks?limit=100&offset=0",
		);
		vi.unstubAllGlobals();
	});

	it("scans later chunk pages for a completion marker", async () => {
		const firstPage = Array.from({ length: 100 }, (_, index) => ({
			metadata: { source_sha256: "abc", page: index + 1, sync_complete: false },
		}));
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ data: firstPage }))
			.mockResolvedValueOnce(
				Response.json({
					data: [{ metadata: { source_sha256: "abc", sync_complete: true } }],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new AlbertClient({
			baseUrl: "https://albert.test",
			apiKey: "sk-test",
		});

		await expect(client.getDocumentMetadata(42, 101)).resolves.toEqual({
			source_sha256: "abc",
			sync_complete: true,
		});
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			"https://albert.test/v1/documents/42/chunks?limit=100&offset=0",
			"https://albert.test/v1/documents/42/chunks?limit=100&offset=100",
		]);
		vi.unstubAllGlobals();
	});

	it("keeps source metadata for an incomplete document", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				data: [{ metadata: { source_sha256: "abc", sync_complete: false } }],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new AlbertClient({
			baseUrl: "https://albert.test",
			apiKey: "sk-test",
		});

		await expect(client.getDocumentMetadata(42, 1)).resolves.toEqual({
			source_sha256: "abc",
			sync_complete: false,
		});
		vi.unstubAllGlobals();
	});

	it("does not request chunks for an empty document", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const client = new AlbertClient({
			baseUrl: "https://albert.test",
			apiKey: "sk-test",
		});
		await expect(client.getDocumentMetadata(42, 0)).resolves.toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});

describe("AlbertClient.ocrPage", () => {
	const page = Buffer.from("jpeg-bytes");

	it("sends one page to the documented OCR route with the guide's settings", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				choices: [{ message: { content: "texte de la page" } }],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const client = new AlbertClient({
				baseUrl: "https://albert.test",
				apiKey: "sk-test",
			});

			await expect(client.ocrPage({ image: page })).resolves.toBe(
				"texte de la page",
			);

			const [url, init] = fetchMock.mock.calls[0];
			expect(String(url)).toBe("https://albert.test/v1/chat/completions");
			const body = JSON.parse(String(init?.body));
			expect(body.model).toBe("openweight-ocr");
			expect(body.messages[0].content[0]).toEqual({
				type: "image_url",
				image_url: { url: `data:image/jpeg;base64,${page.toString("base64")}` },
			});
			expect(body).toMatchObject({
				max_tokens: 4096,
				temperature: 0.2,
				top_p: 0.9,
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("returns null when the model answers without content", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ choices: [{ message: {} }] }));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const client = new AlbertClient({
				baseUrl: "https://albert.test",
				apiKey: "sk-test",
			});
			await expect(client.ocrPage({ image: page })).resolves.toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("retries a transient busy response and returns the successful OCR", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({ detail: "Model is too busy" }, { status: 503 }),
			)
			.mockResolvedValueOnce(
				Response.json({ choices: [{ message: { content: "page lue" } }] }),
			);
		vi.stubGlobal("fetch", fetchMock);
		vi.useFakeTimers();
		try {
			const client = new AlbertClient({
				baseUrl: "https://albert.test",
				apiKey: "sk-test",
			});
			const pending = client.ocrPage({ image: page });
			const assertion = expect(pending).resolves.toBe("page lue");
			await vi.runAllTimersAsync();
			await assertion;
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("does not retry a permanent OCR request error", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json({ detail: "Invalid image" }, { status: 400 }),
			);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const client = new AlbertClient({
				baseUrl: "https://albert.test",
				apiKey: "sk-test",
			});
			await expect(client.ocrPage({ image: page })).rejects.toMatchObject({
				status: 400,
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("AlbertClient.streamChat CRLF framing", () => {
	async function textFrom(body: string): Promise<string> {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
		);
		const client = new AlbertClient({
			baseUrl: "https://albert.test",
			apiKey: "sk-test",
		});
		const text = await collect(
			client.streamChat({
				messages: [{ role: "user", content: "q" }],
				model: "m",
			}),
		);
		vi.unstubAllGlobals();
		return text;
	}

	it("parses CRLF-framed events instead of dropping the answer", async () => {
		const body = [
			'data: {"choices":[{"delta":{"content":"Bon"}}]}',
			"",
			'data: {"choices":[{"delta":{"content":"jour"}}]}',
			"",
			"data: [DONE]",
			"",
		].join("\r\n");
		expect(await textFrom(body)).toBe("Bonjour");
	});

	it("parses LF framing", async () => {
		const body =
			'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
		expect(await textFrom(body)).toBe("ok");
	});
});
