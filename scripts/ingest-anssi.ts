/**
 * Indexes the public ANSSI catalogue into two Albert collections, one per
 * language.
 *
 * Usage:
 *   pnpm ingest -- --language FR
 *   pnpm ingest -- --language EN --dry-run
 *   pnpm ingest -- --all --limit 10
 *
 * The script is resumable by design: it only creates collections when they do
 * not already exist, and it never deletes an indexed document. The one
 * exception is a document whose chunks could not all be written: it is removed
 * so a failed guide never stays searchable with part of its text. Re-running
 * the script adds the catalogue's current PDFs; a full rebuild means deleting
 * the collections first.
 */
import { AlbertClient } from "../lib/albert/client";
import {
	extractPdfSources,
	fetchCatalogue,
	groupByLanguage,
	type PdfSource,
} from "./lib/catalogue";
import { readSetting, requireSetting } from "./lib/env";
import { type IngestOutcome, ingestSource } from "./lib/ingest";

const COLLECTION_NAMES = {
	FR: "anssi-guides-fr",
	EN: "anssi-guides-en",
} as const;

type Language = keyof typeof COLLECTION_NAMES;

type Options = {
	languages: Language[];
	dryRun: boolean;
	limit?: number;
	concurrency: number;
	envFile?: string;
};

function parseArgs(argv: string[]): Options {
	let languages: Language[] = [];
	let dryRun = false;
	let limit: number | undefined;
	let concurrency = 2;
	let envFile: string | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];

		if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--all") {
			languages = ["FR", "EN"];
		} else if (arg === "--language" || arg === "--lang") {
			const value = argv[index + 1]?.toUpperCase();
			index += 1;
			if (value !== "FR" && value !== "EN") {
				throw new Error("--language attend FR ou EN");
			}
			languages.push(value);
		} else if (arg === "--limit") {
			limit = Number.parseInt(argv[index + 1] ?? "", 10);
			index += 1;
			if (!Number.isFinite(limit) || limit <= 0) {
				throw new Error("--limit attend un entier positif");
			}
		} else if (arg === "--concurrency") {
			concurrency = Number.parseInt(argv[index + 1] ?? "", 10);
			index += 1;
			if (!Number.isFinite(concurrency) || concurrency <= 0) {
				throw new Error("--concurrency attend un entier positif");
			}
		} else if (arg === "--env-file") {
			envFile = argv[index + 1];
			index += 1;
			if (!envFile) throw new Error("--env-file attend un chemin");
		} else {
			throw new Error(`Option inconnue: ${arg}`);
		}
	}

	if (languages.length === 0) languages = ["FR"];

	return { languages, dryRun, limit, concurrency, envFile };
}

async function ensureCollection(
	client: AlbertClient,
	language: Language,
	dryRun: boolean,
): Promise<number> {
	const name = COLLECTION_NAMES[language];
	const existing = await client.findCollectionByName(name);
	if (existing) return existing.id;

	const description =
		language === "FR"
			? "Guides publics de l'ANSSI (contenus en français) — POC widget de chat RAG"
			: "ANSSI public guides (English content) — RAG chat widget POC";

	if (dryRun) {
		console.log(`[dry-run] collection ${name} serait créée`);
		return -1;
	}

	const created = await client.createCollection({
		name,
		description,
		visibility: "public",
	});
	console.log(`collection ${name} créée (id ${created.id})`);
	return created.id;
}

/** Runs tasks with a bounded number in flight. */
async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;

	const runners = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (true) {
				const index = next;
				next += 1;
				if (index >= items.length) return;
				results[index] = await worker(items[index], index);
			}
		},
	);

	await Promise.all(runners);
	return results;
}

function summarize(outcomes: IngestOutcome[]) {
	const indexed = outcomes.filter((item) => item.status === "indexed");
	const skipped = outcomes.filter((item) => item.status === "skipped");
	const failed = outcomes.filter((item) => item.status === "failed");

	const chunkTotal = indexed.reduce(
		(sum, item) => sum + (item.status === "indexed" ? item.chunks : 0),
		0,
	);
	const ocrCount = indexed.filter(
		(item) => item.status === "indexed" && item.extraction !== "pdf",
	).length;

	console.log(
		`\nBilan: ${indexed.length} indexés (${chunkTotal} chunks, ${ocrCount} via OCR), ` +
			`${skipped.length} ignorés, ${failed.length} échecs`,
	);

	for (const item of skipped) {
		console.log(`  ignoré  ${item.guideId}: ${item.reason}`);
	}
	for (const item of failed) {
		console.log(`  échec   ${item.guideId}: ${item.reason}`);
	}

	return failed.length;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));

	const client = new AlbertClient({
		baseUrl:
			readSetting("ALBERT_BASE_URL", options.envFile) ??
			"https://albert.api.etalab.gouv.fr",
		apiKey: requireSetting("ALBERT_API_KEY", options.envFile),
	});

	const entries = await fetchCatalogue();
	const grouped = groupByLanguage(extractPdfSources(entries));

	console.log(
		`Catalogue: ${grouped.FR.length} PDF FR, ${grouped.EN.length} PDF EN`,
	);

	let failures = 0;

	for (const language of options.languages) {
		const collectionId = await ensureCollection(
			client,
			language,
			options.dryRun,
		);

		const sources: PdfSource[] = options.limit
			? grouped[language].slice(0, options.limit)
			: grouped[language];

		console.log(
			`\n[${language}] ${sources.length} documents vers ${COLLECTION_NAMES[language]}`,
		);

		const outcomes = await mapWithConcurrency(
			sources,
			options.concurrency,
			async (source, index) => {
				const outcome = await ingestSource({
					source,
					collectionId,
					client,
					dryRun: options.dryRun,
				});
				const position = `${index + 1}/${sources.length}`;
				if (outcome.status === "indexed") {
					console.log(
						`  [${position}] ok ${outcome.guideId} — ${outcome.chunks} chunks, ` +
							`${outcome.pages} pages (${outcome.extraction})`,
					);
					if (outcome.pagesWithoutText.length > 0) {
						console.log(
							`      pages sans texte: ${outcome.pagesWithoutText.join(", ")}`,
						);
					}
					if (outcome.ocrFailedPages.length > 0) {
						console.log(
							`      pages non lues par l'OCR: ${outcome.ocrFailedPages.join(", ")}`,
						);
					}
				} else if (outcome.status === "skipped") {
					console.log(
						`  [${position}] ignoré ${outcome.guideId}: ${outcome.reason}`,
					);
				} else {
					console.log(
						`  [${position}] échec ${outcome.guideId}: ${outcome.reason}`,
					);
				}
				return outcome;
			},
		);

		failures += summarize(outcomes);
	}

	if (failures > 0) {
		console.error(`\n${failures} document(s) en échec.`);
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
