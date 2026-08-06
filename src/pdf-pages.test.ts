import { describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  PdfPagesError,
  base64ToBytes,
  bytesToBase64,
  countPdfPages,
  extractPdfPages,
  looksLikePdf
} from "./pdf-pages";

/**
 * Fixtures are generated rather than committed, so the tests exercise real pdf-lib parsing.
 * Each page gets a unique width (page n is 200+n wide) — pdf-lib exposes no text extraction,
 * so page geometry is how these tests prove an extract kept the *right* pages, not merely the
 * right number of them.
 */
async function makePdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([200 + i, 200]);
    page.drawText(`Page ${i}`, { x: 20, y: 100, size: 24, font });
  }
  return doc.save();
}

/** 1-based source page numbers recovered from the per-page widths {@link makePdf} stamps in. */
async function pageNumbers(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => Math.round(page.getWidth()) - 200);
}

describe("looksLikePdf", () => {
  test("accepts a real PDF header", async () => {
    expect(looksLikePdf(await makePdf(1))).toBe(true);
  });

  test("tolerates leading junk before %PDF", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x0a, 0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    expect(looksLikePdf(bytes)).toBe(true);
  });

  test("rejects non-PDF and empty content", () => {
    expect(looksLikePdf(new TextEncoder().encode("<html><body>nope</body></html>"))).toBe(false);
    expect(looksLikePdf(new Uint8Array(0))).toBe(false);
    expect(looksLikePdf(new Uint8Array([0x25, 0x50]))).toBe(false);
  });

  test("does not scan past the header window", () => {
    const bytes = new Uint8Array(4096);
    bytes.set([0x25, 0x50, 0x44, 0x46], 3000);
    expect(looksLikePdf(bytes)).toBe(false);
  });
});

describe("countPdfPages", () => {
  test("counts single and multi-page documents", async () => {
    expect(await countPdfPages(await makePdf(1))).toBe(1);
    expect(await countPdfPages(await makePdf(7))).toBe(7);
  });

  test("throws a typed pdf_error on unparseable bytes", async () => {
    const err = await countPdfPages(new TextEncoder().encode("not a pdf")).catch((e) => e);
    expect(err).toBeInstanceOf(PdfPagesError);
    expect((err as PdfPagesError).code).toBe("pdf_error");
    expect((err as PdfPagesError).pageCount).toBeNull();
  });

  test("throws a typed pdf_error on empty bytes", async () => {
    const err = await countPdfPages(new Uint8Array(0)).catch((e) => e);
    expect(err).toBeInstanceOf(PdfPagesError);
    expect((err as PdfPagesError).code).toBe("pdf_error");
  });
});

describe("extractPdfPages", () => {
  test("extracts an inclusive interior range and reports the source count", async () => {
    const source = await makePdf(5);
    const { bytes, sourcePageCount } = await extractPdfPages(source, 2, 4);

    expect(sourcePageCount).toBe(5);
    expect(await pageNumbers(bytes)).toEqual([2, 3, 4]);
    expect(looksLikePdf(bytes)).toBe(true);
  });

  test("a single-page range yields exactly that page", async () => {
    const { bytes, sourcePageCount } = await extractPdfPages(await makePdf(3), 2, 2);
    expect(sourcePageCount).toBe(3);
    expect(await pageNumbers(bytes)).toEqual([2]);
  });

  test("the full range round-trips every page in order", async () => {
    const { bytes } = await extractPdfPages(await makePdf(4), 1, 4);
    expect(await pageNumbers(bytes)).toEqual([1, 2, 3, 4]);
  });

  test("leaves the source bytes untouched", async () => {
    const source = await makePdf(3);
    const before = source.slice();
    await extractPdfPages(source, 1, 2);
    expect(source).toEqual(before);
  });

  test("rejects an inverted range before parsing", async () => {
    const err = await extractPdfPages(await makePdf(3), 3, 2).catch((e) => e);
    expect(err).toBeInstanceOf(PdfPagesError);
    expect((err as PdfPagesError).code).toBe("invalid_page_range");
    expect((err as PdfPagesError).message).toContain("Inverted page range");
  });

  test("rejects non-positive and non-integer pages", async () => {
    const source = await makePdf(3);
    for (const [from, to] of [
      [0, 2],
      [-1, 2],
      [1.5, 2]
    ]) {
      const err = await extractPdfPages(source, from, to).catch((e) => e);
      expect((err as PdfPagesError).code).toBe("invalid_page_range");
    }
  });

  test("rejects a range past the end and reports the real page count", async () => {
    const err = await extractPdfPages(await makePdf(3), 2, 9).catch((e) => e);
    expect(err).toBeInstanceOf(PdfPagesError);
    expect((err as PdfPagesError).code).toBe("invalid_page_range");
    expect((err as PdfPagesError).pageCount).toBe(3);
    expect((err as PdfPagesError).message).toContain("3 page(s)");
  });

  test("unparseable bytes surface as pdf_error, not invalid_page_range", async () => {
    const err = await extractPdfPages(new TextEncoder().encode("%PDF-1.4 truncated"), 1, 1).catch((e) => e);
    expect(err).toBeInstanceOf(PdfPagesError);
    expect((err as PdfPagesError).code).toBe("pdf_error");
  });
});

describe("base64 round-trip", () => {
  test("bytes survive an encode/decode cycle", async () => {
    const source = await makePdf(2);
    expect(base64ToBytes(bytesToBase64(source))).toEqual(source);
  });

  test("handles every byte value and empty input", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
    expect(base64ToBytes("")).toEqual(new Uint8Array(0));
  });

  test("chunked encoding matches a single-shot encode past the chunk boundary", () => {
    const big = new Uint8Array(0x8000 * 2 + 17);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });

  test("strips whitespace from wrapped base64", () => {
    const encoded = bytesToBase64(new TextEncoder().encode("hello world"));
    const wrapped = `${encoded.slice(0, 4)}\n  ${encoded.slice(4)}\r\n`;
    expect(new TextDecoder().decode(base64ToBytes(wrapped))).toBe("hello world");
  });

  test("malformed base64 throws a typed pdf_error", () => {
    let caught: unknown;
    try {
      base64ToBytes("!!!not base64!!!");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PdfPagesError);
    expect((caught as PdfPagesError).code).toBe("pdf_error");
  });
});
