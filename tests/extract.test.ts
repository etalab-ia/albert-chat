import { writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import {
	extractPages,
	extractWithPdftotext,
	inkRatio,
	pageHasInk,
	renderPageJpeg,
} from "@/scripts/lib/extract";

const PDF = Buffer.from("%PDF-1.7\ncontenu de test\n");
const IMAGE = Buffer.from("jpeg");

/**
 * Mimics a successful `execFile`. The mock must resolve through the callback:
 * `promisify` on the mocked module resolves to whatever value the callback
 * receives, which production calls with `{ stdout, stderr }`.
 */
function execFileOutputs(stdout: string) {
	execFileMock.mockImplementation(
		(
			_file: string,
			_args: string[],
			_options: unknown,
			callback: (
				error: Error | null,
				result?: { stdout: string; stderr: string },
			) => void,
		) => {
			callback(null, { stdout, stderr: "" });
		},
	);
}

function execFileFails(message: string) {
	execFileMock.mockImplementation(
		(
			_file: string,
			_args: string[],
			_options: unknown,
			callback: (error: Error | null) => void,
		) => {
			callback(new Error(message));
		},
	);
}

/** Poppler separates pages with a form feed and ends the output with one. */
function pagesOutput(...pages: string[]): string {
	return `${pages.join("\f")}\f`;
}

/** Builds a P5 rendering whose pixels come from `value`. */
function pgm(
	width: number,
	height: number,
	value: (index: number) => number,
): Buffer {
	const header = Buffer.from(`P5\n${width} ${height}\n255\n`, "latin1");
	const pixels = Buffer.alloc(width * height);
	for (let index = 0; index < pixels.length; index += 1) {
		pixels[index] = value(index);
	}
	return Buffer.concat([header, pixels]);
}

/** Mimics `pdftoppm` writing its rendering under the prefix it is given. */
function execFileWritesPgm(rendering: Buffer) {
	execFileMock.mockImplementation(
		(
			_file: string,
			args: string[],
			_options: unknown,
			callback: (
				error: Error | null,
				result?: { stdout: string; stderr: string },
			) => void,
		) => {
			writeFileSync(`${args.at(-1)}-002.pgm`, rendering);
			callback(null, { stdout: "", stderr: "" });
		},
	);
}

beforeEach(() => {
	execFileMock.mockReset();
});

describe("extractWithPdftotext", () => {
	it("extracts the whole document with a single pdftotext call", async () => {
		execFileOutputs(pagesOutput("page une", "page deux", "page trois"));

		const pages = await extractWithPdftotext(PDF, 3);

		expect(execFileMock).toHaveBeenCalledTimes(1);
		const [file, args] = execFileMock.mock.calls[0];
		expect(file).toBe("pdftotext");
		expect(args.slice(0, 2)).toEqual([
			"-layout",
			expect.stringContaining("input.pdf"),
		]);
		expect(args.at(-1)).toBe("-");
		expect(pages).toEqual([
			{ page: 1, text: "page une" },
			{ page: 2, text: "page deux" },
			{ page: 3, text: "page trois" },
		]);
	});

	it("pads with empty pages when the output holds fewer pages than announced", async () => {
		execFileOutputs(pagesOutput("seule page"));

		const pages = await extractWithPdftotext(PDF, 3);

		expect(pages).toHaveLength(3);
		expect(pages[1]).toEqual({ page: 2, text: "" });
		expect(pages[2]).toEqual({ page: 3, text: "" });
	});

	it("ignores separators past the announced page count", async () => {
		execFileOutputs(pagesOutput("une", "deux", "trois", "quatre"));

		const pages = await extractWithPdftotext(PDF, 2);

		expect(pages).toEqual([
			{ page: 1, text: "une" },
			{ page: 2, text: "deux" },
		]);
	});

	it("does not run the binary for a document without pages", async () => {
		expect(await extractWithPdftotext(PDF, 0)).toEqual([]);
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it("surfaces a pdftotext failure instead of returning empty pages", async () => {
		execFileFails("pdftotext: command failed");

		await expect(extractWithPdftotext(PDF, 2)).rejects.toThrow(
			"command failed",
		);
	});
});

describe("renderPageJpeg", () => {
	it("renders a single page at the resolution the OCR guide recommends", async () => {
		execFileFails("spawn pdftoppm ENOENT");

		await expect(renderPageJpeg("/tmp/guide.pdf", 7)).rejects.toThrow(
			"pdftoppm est introuvable",
		);

		const [file, args] = execFileMock.mock.calls[0];
		expect(file).toBe("pdftoppm");
		expect(args).toEqual([
			"-jpeg",
			"-r",
			"200",
			"-scale-to",
			"1540",
			"-f",
			"7",
			"-l",
			"7",
			"/tmp/guide.pdf",
			expect.stringContaining("page"),
		]);
	});
});

describe("inkRatio", () => {
	it("is zero for a page without a single dark pixel", () => {
		expect(inkRatio(pgm(10, 10, () => 255))).toBe(0);
	});

	it("is the share of dark pixels for a page with content", () => {
		// 25 dark pixels out of 100.
		expect(inkRatio(pgm(10, 10, (index) => (index < 25 ? 0 : 255)))).toBe(0.25);
	});

	it("counts faint antialiased pixels as ink", () => {
		expect(inkRatio(pgm(10, 10, () => 199))).toBe(1);
		expect(inkRatio(pgm(10, 10, () => 200))).toBe(0);
	});

	it("reports a fully inked page for a rendering it cannot parse", () => {
		// The fallback must never drop a page's text.
		expect(inkRatio(Buffer.from("pas un PGM"))).toBe(1);
		expect(inkRatio(Buffer.from("P5\n0 0\n255\n"))).toBe(1);
	});
});

describe("pageHasInk", () => {
	it("renders in grayscale at low resolution for the ink test", async () => {
		execFileWritesPgm(pgm(4, 4, () => 0));

		await pageHasInk("/tmp/guide.pdf", 9);

		const [file, args] = execFileMock.mock.calls[0];
		expect(file).toBe("pdftoppm");
		expect(args.slice(0, 7)).toEqual([
			"-gray",
			"-r",
			"50",
			"-f",
			"9",
			"-l",
			"9",
		]);
		expect(args.at(-2)).toBe("/tmp/guide.pdf");
	});

	it("reports a blank page from a white rendering", async () => {
		execFileWritesPgm(pgm(414, 585, () => 255));

		expect(await pageHasInk("/tmp/guide.pdf", 2)).toBe(false);
	});

	it("reports a page with content from a rendering that has ink", async () => {
		// The lightest real page of the ANSSI vote guide measures 0.0047.
		execFileWritesPgm(pgm(414, 585, (index) => (index < 1133 ? 0 : 255)));

		expect(await pageHasInk("/tmp/guide.pdf", 3)).toBe(true);
	});

	it("reports ink when the page could not be rendered at all", async () => {
		execFileOutputs("");

		expect(await pageHasInk("/tmp/guide.pdf", 4)).toBe(true);
	});

	it("surfaces a missing poppler instead of reporting a blank page", async () => {
		execFileFails("spawn pdftoppm ENOENT");

		await expect(pageHasInk("/tmp/guide.pdf", 5)).rejects.toThrow(
			"pdftoppm est introuvable",
		);
	});
});

describe("extractPages", () => {
	const dense = "a".repeat(400);

	it("uses the text layer and skips OCR when every page is readable", async () => {
		execFileOutputs(pagesOutput(dense, dense));
		const ocr = vi.fn();
		const render = vi.fn(async () => IMAGE);

		const result = await extractPages({
			pdf: PDF,
			pageCount: 2,
			ocr,
			render,
		});

		expect(ocr).not.toHaveBeenCalled();
		expect(render).not.toHaveBeenCalled();
		expect(result.method).toBe("pdf");
		expect(result.pages.map((page) => page.extraction)).toEqual(["pdf", "pdf"]);
		expect(result.ocrFailures).toEqual([]);
	});

	it("re-reads only the pages whose text layer is unusable", async () => {
		execFileOutputs(pagesOutput(dense, "", dense));
		const ocr = vi.fn(async () => "texte OCR de la page 2");
		const render = vi.fn(async () => IMAGE);

		const result = await extractPages({
			pdf: PDF,
			pageCount: 3,
			ocr,
			render,
		});

		expect(render).toHaveBeenCalledTimes(1);
		expect(render).toHaveBeenCalledWith(2);
		expect(ocr).toHaveBeenCalledTimes(1);
		expect(ocr).toHaveBeenCalledWith({ page: 2, image: IMAGE });
		expect(result.method).toBe("mixed");
		expect(result.pages.map((page) => page.extraction)).toEqual([
			"pdf",
			"ocr",
			"pdf",
		]);
		// The readable pages keep their own text: OCR is not allowed to replace a
		// page that already has a good text layer.
		expect(result.pages[0].text).toBe(dense);
		expect(result.pages[1].text).toBe("texte OCR de la page 2");
		expect(result.pages[2].text).toBe(dense);
	});

	it("treats a nearly empty text layer as unusable page by page", async () => {
		// The document average is high, which is exactly the case the old
		// document-level heuristic let through.
		execFileOutputs(pagesOutput(dense, "1", dense, dense));
		const ocr = vi.fn(async () => "schéma légendé");

		const result = await extractPages({
			pdf: PDF,
			pageCount: 4,
			ocr,
			render: async () => IMAGE,
		});

		expect(ocr).toHaveBeenCalledTimes(1);
		expect(ocr).toHaveBeenCalledWith({ page: 2, image: IMAGE });
		expect(result.pages[1]).toEqual({
			page: 2,
			text: "schéma légendé",
			extraction: "ocr",
		});
		expect(result.method).toBe("mixed");
	});

	it("uses OCR for every page of a scanned document", async () => {
		execFileOutputs(pagesOutput("", ""));
		const ocr = vi.fn(async (page: { page: number }) => `page ${page.page}`);

		const result = await extractPages({
			pdf: PDF,
			pageCount: 2,
			ocr,
			render: async () => IMAGE,
		});

		expect(ocr).toHaveBeenCalledTimes(2);
		expect(result.method).toBe("ocr");
		expect(result.pages.map((page) => page.text)).toEqual(["page 1", "page 2"]);
	});

	it("keeps the thin text layer when OCR returns nothing for that page", async () => {
		execFileOutputs(pagesOutput(dense, "Titre de section"));
		const ocr = vi.fn(async () => null);

		const result = await extractPages({
			pdf: PDF,
			pageCount: 2,
			ocr,
			render: async () => IMAGE,
		});

		// A heading is real content: dropping it because OCR found nothing would
		// lose text that the text layer already had.
		expect(result.pages[1]).toEqual({
			page: 2,
			text: "Titre de section",
			extraction: "pdf",
		});
		expect(result.ocrFailures).toEqual([2]);
	});

	it("keeps the rest of the document when OCR fails on one page", async () => {
		execFileOutputs(pagesOutput(dense, "", dense));
		const ocr = vi.fn(async () => {
			throw new Error("Albert OCR indisponible");
		});

		const result = await extractPages({
			pdf: PDF,
			pageCount: 3,
			ocr,
			render: async () => IMAGE,
		});

		// One unreadable page must not cost the whole document its index entry.
		// The document-level call this replaces failed every page at once, which
		// is what kept the ANSSI sync red for weeks.
		expect(result.pages[1]).toEqual({ page: 2, text: "", extraction: "pdf" });
		expect(result.pages[0].text).toBe(dense);
		expect(result.pages[2].text).toBe(dense);
		expect(result.ocrFailures).toEqual([2]);
	});

	it("treats a page that cannot be rasterised as an unread page", async () => {
		execFileOutputs(pagesOutput(dense, "Titre"));
		const ocr = vi.fn();

		const result = await extractPages({
			pdf: PDF,
			pageCount: 2,
			ocr,
			render: async () => {
				throw new Error("pdftoppm est introuvable");
			},
		});

		expect(ocr).not.toHaveBeenCalled();
		expect(result.pages[1]).toEqual({
			page: 2,
			text: "Titre",
			extraction: "pdf",
		});
		expect(result.ocrFailures).toEqual([2]);
	});

	it("does not ask the OCR model to read a blank page", async () => {
		// A blank page makes the OCR model invent text: the ANSSI vote guide's
		// blank page 2 came back as an English document template.
		execFileOutputs(pagesOutput(dense, ""));
		const ocr = vi.fn();

		const result = await extractPages({
			pdf: PDF,
			pageCount: 2,
			ocr,
			render: async () => null,
		});

		expect(ocr).not.toHaveBeenCalled();
		expect(result.pages[1]).toEqual({ page: 2, text: "", extraction: "pdf" });
		expect(result.emptyPages).toEqual([2]);
		// Nothing was lost, so a blank page is not a failed OCR call.
		expect(result.ocrFailures).toEqual([]);
	});

	it("reports the pages that stayed empty because OCR did not cover them", async () => {
		// Page 2 has no text layer and the OCR answer carries nothing for it.
		// The page produces no chunk, so it must be reported instead of vanishing.
		execFileOutputs(pagesOutput(dense, "", dense));
		const ocr = vi.fn(async () => "");

		const result = await extractPages({
			pdf: PDF,
			pageCount: 3,
			ocr,
			render: async () => IMAGE,
		});

		// No page ended up using OCR, so the document is still a text-layer one;
		// the dropped page is reported separately instead of being counted.
		expect(result.method).toBe("pdf");
		expect(result.pages[1]).toEqual({ page: 2, text: "", extraction: "pdf" });
		expect(result.emptyPages).toEqual([2]);
		expect(result.ocrFailures).toEqual([2]);
	});

	it("reports nothing when every page produced text", async () => {
		execFileOutputs(pagesOutput(dense, dense));

		const result = await extractPages({
			pdf: PDF,
			pageCount: 2,
			ocr: vi.fn(),
			render: async () => IMAGE,
		});

		expect(result.emptyPages).toEqual([]);
		expect(result.ocrFailures).toEqual([]);
	});
});
