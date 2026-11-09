import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";

function env(collections: Record<string, string | undefined>) {
	return {
		NODE_ENV: "test" as const,
		ALBERT_API_KEY: "sk-test",
		...collections,
	};
}

describe("loadConfig collection selection", () => {
	it("accepts several generic collection IDs and removes duplicates", () => {
		const config = loadConfig(
			env({ ALBERT_COLLECTION_IDS: " 30, 31,30, 32 " }),
		);

		expect(config.collectionIds).toEqual([30, 31, 32]);
	});

	it("uses the generic list instead of the legacy variables when both exist", () => {
		const config = loadConfig(
			env({
				ALBERT_COLLECTION_IDS: "30,31",
				ALBERT_COLLECTION_FR: "10",
				ALBERT_COLLECTION_EN: "11",
			}),
		);

		expect(config.collectionIds).toEqual([30, 31]);
	});

	it("keeps the ANSSI variables as a compatibility path", () => {
		const config = loadConfig(
			env({ ALBERT_COLLECTION_FR: "10", ALBERT_COLLECTION_EN: "11" }),
		);

		expect(config.collectionIds).toEqual([10, 11]);
	});

	it.each(["", " ", ",", "10,", ",10", "10,,11", "ten", "0", "-1", "1.5"])(
		"rejects a malformed generic list: %j",
		(value) => {
			expect(() =>
				loadConfig(
					env({
						ALBERT_COLLECTION_IDS: value,
						ALBERT_COLLECTION_FR: "10",
					}),
				),
			).toThrow(/ALBERT_COLLECTION_IDS/);
		},
	);

	it("rejects an integer too large to represent exactly", () => {
		expect(() =>
			loadConfig(env({ ALBERT_COLLECTION_IDS: "9007199254740992" })),
		).toThrow(/unsafe integer/);
	});

	it("fails closed when no collection is configured", () => {
		expect(() => loadConfig(env({}))).toThrow(/ALBERT_COLLECTION_IDS/);
	});
});
