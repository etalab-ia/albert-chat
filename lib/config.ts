import { z } from "zod";

const envSchema = z.object({
	ALBERT_API_KEY: z.string().min(1, "ALBERT_API_KEY is required"),
	ALBERT_BASE_URL: z
		.string()
		.url()
		.default("https://albert.api.etalab.gouv.fr"),
	ALBERT_CHAT_MODEL: z.string().default("gpt-oss-120b"),
	ALBERT_COLLECTION_IDS: z.string().optional(),
});

/**
 * The ANSSI-era variables are validated separately: `z.coerce.number()` turns an
 * empty string into `0`, so validating them up front rejected the documented
 * setup of setting only the generic list and leaving these blank.
 */
const legacyCollectionSchema = z.object({
	ALBERT_COLLECTION_FR: z.coerce.number().int().positive().optional(),
	ALBERT_COLLECTION_EN: z.coerce.number().int().positive().optional(),
});

export type AppConfig = {
	apiKey: string;
	baseUrl: string;
	chatModel: string;
	collectionIds: number[];
};

function formatIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
		.join("; ");
}

/** Parses the generic collection list, rejecting partial or lossy numeric IDs. */
function parseCollectionIds(raw: string): number[] {
	const entries = raw.split(",").map((entry) => entry.trim());
	if (entries.some((entry) => !/^[1-9]\d*$/.test(entry))) {
		throw new Error(
			"Invalid server configuration (ALBERT_COLLECTION_IDS must be a comma-separated list of positive integers)",
		);
	}

	const ids = entries.map(Number);
	if (ids.some((id) => !Number.isSafeInteger(id))) {
		throw new Error(
			"Invalid server configuration (ALBERT_COLLECTION_IDS contains an unsafe integer)",
		);
	}

	return [...new Set(ids)];
}

/**
 * Reads and validates the server configuration. Throws a readable error listing
 * the offending variables rather than failing later inside a request.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	const parsed = envSchema.safeParse(env);

	if (!parsed.success) {
		throw new Error(
			`Invalid server configuration (${formatIssues(parsed.error)})`,
		);
	}

	// The generic list replaces the ANSSI-era variables when present. An empty
	// value is an error, not a fallback: searching every accessible collection
	// would expose corpora the deployer did not explicitly select.
	let collectionIds: number[];
	if (parsed.data.ALBERT_COLLECTION_IDS === undefined) {
		const legacy = legacyCollectionSchema.safeParse(env);
		if (!legacy.success) {
			throw new Error(
				`Invalid server configuration (${formatIssues(legacy.error)})`,
			);
		}

		collectionIds = [
			...new Set(
				[
					legacy.data.ALBERT_COLLECTION_FR,
					legacy.data.ALBERT_COLLECTION_EN,
				].filter((id): id is number => typeof id === "number"),
			),
		];
	} else {
		collectionIds = parseCollectionIds(parsed.data.ALBERT_COLLECTION_IDS);
	}

	if (collectionIds.length === 0) {
		throw new Error(
			"Invalid server configuration (set ALBERT_COLLECTION_IDS, or ALBERT_COLLECTION_FR and/or ALBERT_COLLECTION_EN)",
		);
	}

	return {
		apiKey: parsed.data.ALBERT_API_KEY,
		baseUrl: parsed.data.ALBERT_BASE_URL,
		chatModel: parsed.data.ALBERT_CHAT_MODEL,
		collectionIds,
	};
}

/** Public limits shared by the API route and the widget UI. */
export { LIMITS } from "./limits";

/**
 * Abuse controls for a public endpoint with no user accounts.
 *
 * The Albert key sits behind this route, so an open endpoint spends someone
 * else's quota. `maxPerClientPerWindow` keeps one caller from monopolising the
 * service; `maxPerDay` bounds the total even against a distributed flood.
 */
function positiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Overridable from the deployment environment so the caps can be tuned. */
export const ABUSE_LIMITS = {
	maxPerClientPerWindow: positiveInt(process.env.ABUSE_MAX_PER_CLIENT, 10),
	clientWindowMs: positiveInt(process.env.ABUSE_CLIENT_WINDOW_MS, 60_000),
	maxPerDay: positiveInt(process.env.ABUSE_MAX_PER_DAY, 500),
	dayMs: 24 * 60 * 60 * 1000,
} as const;
