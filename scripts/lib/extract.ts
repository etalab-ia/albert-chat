import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PageText } from "./chunk";

const execFileAsync = promisify(execFile);

/** Below this many characters, a page's text layer is unusable (scanned page). */
const MIN_CHARS_PER_PAGE = 80;

/** How one page was turned into text. */
export type PageExtraction = "pdf" | "ocr";

/** How the text of a whole document was obtained. */
export type ExtractionMethod = PageExtraction | "mixed";

/**
 * Extracted page. A document can mix both sources: a PDF with a usable text
 * layer on most pages and scanned inserts only loses the scanned ones.
 */
export type ExtractedPage = PageText & { extraction: PageExtraction };

export type ExtractionResult = {
	pages: ExtractedPage[];
	method: ExtractionMethod;
	/**
	 * Pages whose text layer was too thin and whose OCR result carried no text
	 * either. They produce no chunk, so the ingestion reports them: a page the
	 * OCR did not cover would otherwise disappear from the index in silence.
	 */
	emptyPages: number[];
	/**
	 * Thin pages the OCR did not recover, either because the call failed or
	 * because it came back empty. Those pages keep their thin text layer, and
	 * the ingestion reports them without failing the document.
	 */
	ocrFailures: number[];
};

export async function downloadPdf(url: string): Promise<Buffer> {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) {
		throw new Error(
			`Téléchargement échoué (HTTP ${response.status}) pour ${url}`,
		);
	}
	return Buffer.from(await response.arrayBuffer());
}

/**
 * Extracts text page by page. The text layer is used page by page, and only the
 * pages that carry too little of it are rasterised and re-read through Albert
 * OCR. Deciding on the document average would silently drop the scanned pages of
 * a mixed PDF, and a document-level OCR call would let one unreadable page fail
 * every other page of the same document.
 *
 * `render` is injectable so the per-page loop can be tested without poppler; it
 * defaults to rasterising the PDF at the resolution the OCR guide recommends,
 * and to reporting `null` for a page that carries no ink.
 */
export async function extractPages(params: {
	pdf: Buffer;
	pageCount: number;
	ocr: (page: { page: number; image: Buffer }) => Promise<string | null>;
	render?: (page: number) => Promise<Buffer | null>;
}): Promise<ExtractionResult> {
	const textPages = await extractWithPdftotext(params.pdf, params.pageCount);
	const thinPages = textPages.filter((page) => !hasUsableText(page.text));

	if (thinPages.length === 0) {
		return {
			pages: textPages.map((page) => ({ ...page, extraction: "pdf" as const })),
			method: "pdf",
			emptyPages: [],
			ocrFailures: [],
		};
	}

	const recovered = new Map<number, string>();
	const ocrFailures: number[] = [];

	await withPageRenderer(params.pdf, params.render, async (render) => {
		for (const page of thinPages) {
			let image: Buffer | null;
			try {
				image = await render(page.page);
			} catch {
				ocrFailures.push(page.page);
				continue;
			}

			// A blank page has nothing to read. It keeps its thin text layer and
			// is not counted as a failure: there was nothing to recover.
			if (image === null) continue;

			let markdown: string | null;
			try {
				markdown = await params.ocr({ page: page.page, image });
			} catch {
				// A page the OCR could not read keeps its thin text layer. The rest
				// of the document is still worth indexing, so this is reported
				// rather than thrown.
				ocrFailures.push(page.page);
				continue;
			}
			const text = markdown?.trim() ?? "";
			if (text.length > 0) recovered.set(page.page, text);
			else ocrFailures.push(page.page);
		}
	});

	const pages: ExtractedPage[] = textPages.map((page) => {
		if (hasUsableText(page.text))
			return { ...page, extraction: "pdf" as const };

		// The OCR text wins when it carries something. Otherwise the thin text
		// layer is kept rather than discarded: a page with only a heading still
		// holds real content, and an empty page yields no chunk anyway.
		const markdown = recovered.get(page.page);
		return markdown === undefined
			? { ...page, extraction: "pdf" as const }
			: { page: page.page, text: markdown, extraction: "ocr" as const };
	});

	const usedOcr = pages.some((page) => page.extraction === "ocr");
	const usedTextLayer = pages.some((page) => page.extraction === "pdf");
	return {
		pages,
		method: usedOcr && usedTextLayer ? "mixed" : usedOcr ? "ocr" : "pdf",
		emptyPages: pages
			.filter((page) => page.text.trim().length === 0)
			.map((page) => page.page),
		ocrFailures,
	};
}

/**
 * Runs `fn` with a page renderer. The injected renderer is used as is; the
 * default one writes the PDF to a temporary directory once and rasterises pages
 * from there, so a fully scanned document is not written out once per page.
 */
async function withPageRenderer<T>(
	pdf: Buffer,
	render: ((page: number) => Promise<Buffer | null>) | undefined,
	fn: (render: (page: number) => Promise<Buffer | null>) => Promise<T>,
): Promise<T> {
	if (render) return fn(render);

	const dir = await mkdtemp(join(tmpdir(), "anssi-pdf-"));
	try {
		const pdfPath = join(dir, "input.pdf");
		await writeFile(pdfPath, pdf);
		return await fn((page) => renderPageImage(pdfPath, page));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Longest side of a rendered page, in pixels, as recommended by the OCR guide. */
const OCR_RENDER_MAX_PX = 1540;

/**
 * Rasterises one page of a PDF to JPEG for the OCR model. The guide asks for
 * 200 DPI capped to roughly 1540 pixels on the longest side, aspect ratio kept:
 * `pdftoppm` applies the resolution first and then fits the page to that size.
 */
export async function renderPageJpeg(
	pdfPath: string,
	page: number,
): Promise<Buffer> {
	const dir = await mkdtemp(join(tmpdir(), "anssi-page-"));
	const prefix = join(dir, "page");

	try {
		await execFileAsync(
			"pdftoppm",
			[
				"-jpeg",
				"-r",
				"200",
				"-scale-to",
				String(OCR_RENDER_MAX_PX),
				"-f",
				String(page),
				"-l",
				String(page),
				pdfPath,
				prefix,
			],
			{ maxBuffer: 16 * 1024 * 1024 },
		);

		// pdftoppm names the output after the page number, zero-padded to the
		// width of the page count.
		const rendered = (await readdir(dir)).filter((name) =>
			name.endsWith(".jpg"),
		);
		if (rendered.length === 0) {
			throw new Error(`Rendu introuvable pour la page ${page}.`);
		}
		return await readFile(join(dir, rendered[0]));
	} catch (error) {
		if (error instanceof Error && /ENOENT/.test(error.message)) {
			throw new Error(
				"pdftoppm est introuvable. Installez poppler-utils (pdftotext, pdftoppm, pdfinfo).",
			);
		}
		throw error;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Resolution of the grayscale rendering used to look for ink, in DPI. */
const INK_TEST_DPI = 50;

/** Pixel value at or below which a pixel of the ink test counts as dark. */
const INK_DARK_MAX = 200;

/** Share of a page that must be inked for the page to be worth reading. */
const MIN_INK_RATIO = 0.001;

/**
 * Rasterises one page for the OCR model, or reports `null` when the page is
 * blank. A blank page has nothing to read, and the OCR model answers such an
 * image with invented text: the blank page 2 of the ANSSI vote guide came back
 * as a full English document template ("Contributor A", "123 Main St, Anytown,
 * USA"), which would have entered the corpus as if it were the guide's content.
 * Skipping the page costs one cheap rendering and loses nothing.
 */
export async function renderPageImage(
	pdfPath: string,
	page: number,
): Promise<Buffer | null> {
	if (!(await pageHasInk(pdfPath, page))) return null;
	return renderPageJpeg(pdfPath, page);
}

/**
 * Tells whether a page carries any ink, from a low-resolution grayscale
 * rendering. Measured over all 151 pages of the ANSSI vote guide, the blank page
 * scores 0 and the lightest page with content 0.0047, so the threshold has room
 * on both sides.
 */
export async function pageHasInk(
	pdfPath: string,
	page: number,
): Promise<boolean> {
	const dir = await mkdtemp(join(tmpdir(), "anssi-ink-"));
	const prefix = join(dir, "page");

	try {
		await execFileAsync(
			"pdftoppm",
			[
				"-gray",
				"-r",
				String(INK_TEST_DPI),
				"-f",
				String(page),
				"-l",
				String(page),
				pdfPath,
				prefix,
			],
			{ maxBuffer: 16 * 1024 * 1024 },
		);

		const rendered = (await readdir(dir)).filter((name) =>
			name.endsWith(".pgm"),
		);
		// No rendering means the page could not be inspected. Report ink so the
		// page still reaches the OCR model, whose own failure is reported; the
		// alternative would drop the page in silence.
		if (rendered.length === 0) return true;

		return inkRatio(await readFile(join(dir, rendered[0]))) >= MIN_INK_RATIO;
	} catch (error) {
		if (error instanceof Error && /ENOENT/.test(error.message)) {
			throw new Error(
				"pdftoppm est introuvable. Installez poppler-utils (pdftotext, pdftoppm, pdfinfo).",
			);
		}
		throw error;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Share of dark pixels in a P5 (grayscale) rendering. Input that cannot be
 * parsed reports a fully inked page, so a surprise in the header never drops a
 * page's text.
 */
export function inkRatio(pgm: Buffer): number {
	const match = /^P5\s+(\d+)\s+(\d+)\s+\d+\s/.exec(
		pgm.subarray(0, 32).toString("latin1"),
	);
	if (!match) return 1;

	const width = Number.parseInt(match[1], 10);
	const height = Number.parseInt(match[2], 10);
	const total = width * height;
	if (total === 0) return 1;

	const start = match[0].length;
	const end = Math.min(start + total, pgm.length);
	let dark = 0;
	for (let index = start; index < end; index += 1) {
		if (pgm[index] < INK_DARK_MAX) dark += 1;
	}
	return dark / total;
}

function hasUsableText(text: string): boolean {
	return text.trim().length >= MIN_CHARS_PER_PAGE;
}

/**
 * Extracts every page with a single pdftotext call. Poppler separates pages
 * with a form feed and terminates the output with one, so the stream is split
 * on `\f`; running the binary once per page meant one process per page and
 * turned each individual failure into an empty page.
 */
export async function extractWithPdftotext(
	pdf: Buffer,
	pageCount: number,
): Promise<PageText[]> {
	if (pageCount <= 0) return [];

	const dir = await mkdtemp(join(tmpdir(), "anssi-pdf-"));
	const pdfPath = join(dir, "input.pdf");

	try {
		await writeFile(pdfPath, pdf);

		const { stdout } = await execFileAsync(
			"pdftotext",
			["-layout", pdfPath, "-"],
			{
				maxBuffer: 64 * 1024 * 1024,
			},
		);

		const parts = stdout.split("\f");
		// Drop the empty tail left by the final form feed.
		if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();

		const pages: PageText[] = [];
		for (let index = 0; index < pageCount; index += 1) {
			pages.push({ page: index + 1, text: parts[index] ?? "" });
		}
		return pages;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Reads the page count with `pdfinfo`. Kept separate so a missing poppler
 * install fails with an actionable message instead of a confusing chunk error.
 */
export async function countPdfPages(pdf: Buffer): Promise<number> {
	const dir = await mkdtemp(join(tmpdir(), "anssi-pdf-"));
	const pdfPath = join(dir, "input.pdf");

	try {
		await writeFile(pdfPath, pdf);
		const { stdout } = await execFileAsync("pdfinfo", [pdfPath], {
			maxBuffer: 1024 * 1024,
		});
		const match = /^Pages:\s+(\d+)$/m.exec(stdout);
		if (!match) throw new Error("Nombre de pages introuvable dans pdfinfo.");
		return Number.parseInt(match[1], 10);
	} catch (error) {
		if (error instanceof Error && /ENOENT/.test(error.message)) {
			throw new Error(
				"pdfinfo est introuvable. Installez poppler-utils (pdftotext, pdfinfo).",
			);
		}
		throw error;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export function assertPdfBuffer(pdf: Buffer): void {
	if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
		throw new Error("Le fichier téléchargé n'est pas un PDF.");
	}
}

export async function readTextFile(path: string): Promise<string> {
	return readFile(path, "utf8");
}
