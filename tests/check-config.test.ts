import { describe, expect, it, vi } from "vitest";
import type { SearchHit } from "@/lib/albert/types";
import type { AppConfig } from "@/lib/config";
import { checkCollection, runCheckConfig } from "@/scripts/check-config";

const HIT: SearchHit = {
	method: "hybrid",
	score: 0.7,
	chunk: {
		id: 1,
		collection_id: 30,
		document_id: 1,
		content: "contenu",
		metadata: { title: "Doc", page: 2, source_url: "https://e.org/a.pdf" },
	},
};

const CONFIG: AppConfig = {
	apiKey: "sk-test",
	baseUrl: "https://albert.example",
	chatModel: "gpt-oss-120b",
	collectionIds: [30, 31],
};

describe("checkCollection", () => {
	it("passes when a probe returns content", async () => {
		const search = vi.fn().mockResolvedValue([HIT]);
		const result = await checkCollection({ search, collectionId: 30 });

		expect(result.ok).toBe(true);
		expect(result.lines[0]).toContain("answered 3/3 probes");
		expect(result.lines.join("\n")).toContain("1 linkable, 1 with a page");
	});

	it("fails when every probe is empty", async () => {
		const search = vi.fn().mockResolvedValue([]);
		const result = await checkCollection({ search, collectionId: 30 });

		expect(result.ok).toBe(false);
		expect(result.lines[0]).toContain("no probe returned content");
	});

	it("reports the upstream error when the credential is rejected", async () => {
		const search = vi
			.fn()
			.mockRejectedValue(new Error("Albert POST /v1/search failed with 401"));
		const result = await checkCollection({ search, collectionId: 30 });

		expect(result.ok).toBe(false);
		expect(result.lines[0]).toContain("failed with 401");
	});

	it("scopes the probe to the single collection under test", async () => {
		const search = vi.fn().mockResolvedValue([HIT]);
		await checkCollection({ search, collectionId: 31 });

		for (const call of search.mock.calls) {
			expect(call[0].collectionIds).toEqual([31]);
		}
	});
});

describe("runCheckConfig", () => {
	it("checks every configured collection and always uses search only", async () => {
		const search = vi.fn().mockResolvedValue([HIT]);
		const createClient = vi.fn().mockReturnValue({ search });

		const result = await runCheckConfig(CONFIG, createClient);

		expect(result.ok).toBe(true);
		expect(createClient).toHaveBeenCalledTimes(1);
		// The read-only guarantee: the client surface used is `search` alone.
		expect(search).toHaveBeenCalled();
		for (const call of search.mock.calls) {
			expect(Object.keys(call[0]).sort()).toEqual([
				"collectionIds",
				"limit",
				"method",
				"query",
			]);
		}
		expect(result.lines[0]).toContain("2 collection(s) -> 30, 31");
	});

	it("fails the run when any collection is empty", async () => {
		const search = vi.fn(
			async ({ collectionIds }: { collectionIds: number[] }) =>
				collectionIds[0] === 30 ? [HIT] : [],
		);

		const result = await runCheckConfig(CONFIG, () => ({ search }));

		expect(result.ok).toBe(false);
		expect(result.lines.join("\n")).toContain("1 collection(s) failed");
	});
});
