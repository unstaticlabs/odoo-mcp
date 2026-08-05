/**
 * In-Worker PDF page slicing, used by `billing.attach_source_pdf`.
 *
 * Pure byte-level helpers over pdf-lib: no Odoo I/O, no rasterization, no OCR, no text
 * extraction. Page numbers on this boundary are 1-based inclusive (what an agent reads off
 * a document); pdf-lib indexes from 0, and that conversion happens here so callers never
 * have to think about it.
 */
import { PDFDocument } from "pdf-lib";

export type PdfPagesErrorCode = "not_pdf" | "invalid_page_range" | "pdf_error";

/** Typed failure so tool code can map straight onto its refusal envelopes. */
export class PdfPagesError extends Error {
  readonly code: PdfPagesErrorCode;
  /** Source page count when it was known at failure time; null when the parse itself failed. */
  readonly pageCount: number | null;

  constructor(code: PdfPagesErrorCode, message: string, pageCount: number | null = null) {
    super(message);
    this.name = "PdfPagesError";
    this.code = code;
    this.pageCount = pageCount;
  }
}

export interface PdfExtractResult {
  bytes: Uint8Array;
  /** Page count of the *source* document, so callers can report it without a second parse. */
  sourcePageCount: number;
}

/** "%PDF" — the file header every PDF starts with. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];

/**
 * How far into the file to look for the header. Real-world PDFs occasionally carry a few
 * junk bytes (a BOM, stray newlines) before `%PDF`; readers tolerate that, so we do too.
 */
const PDF_MAGIC_SCAN_BYTES = 1024;

/**
 * True when the bytes carry a `%PDF` header. This — not the Odoo `mimetype` field, which is
 * whatever the uploader's browser guessed — is what decides whether we treat content as a PDF.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, PDF_MAGIC_SCAN_BYTES + PDF_MAGIC.length) - PDF_MAGIC.length;
  for (let start = 0; start <= limit; start++) {
    let matched = true;
    for (let i = 0; i < PDF_MAGIC.length; i++) {
      if (bytes[start + i] !== PDF_MAGIC[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Load a PDF and walk its page tree in one guarded step. pdf-lib is lenient about `load` —
 * truncated or malformed files parse "successfully" and only blow up on the first real access —
 * so the page count is resolved here rather than left to the caller.
 */
async function loadPdf(bytes: Uint8Array): Promise<{ doc: PDFDocument; pageCount: number }> {
  try {
    // updateMetadata:false keeps pdf-lib from stamping a ModDate on the copy — the output
    // should differ from the source only in which pages it carries.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return { doc, pageCount: doc.getPageCount() };
  } catch (err) {
    throw new PdfPagesError(
      "pdf_error",
      `Could not parse the PDF: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Page count of a PDF. Throws {@link PdfPagesError} `pdf_error` when the bytes will not parse. */
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  return (await loadPdf(bytes)).pageCount;
}

/**
 * Copy the inclusive 1-based page range `[pageFrom, pageTo]` into a fresh single-document PDF.
 * The source bytes are never mutated. Throws {@link PdfPagesError} — `invalid_page_range` for
 * a range that is malformed or runs past the end of the document, `pdf_error` for a parse or
 * copy failure.
 */
export async function extractPdfPages(
  bytes: Uint8Array,
  pageFrom: number,
  pageTo: number
): Promise<PdfExtractResult> {
  if (!Number.isInteger(pageFrom) || !Number.isInteger(pageTo) || pageFrom < 1 || pageTo < 1) {
    throw new PdfPagesError(
      "invalid_page_range",
      `page_from and page_to must be positive integers (got page_from=${pageFrom}, page_to=${pageTo}).`
    );
  }
  if (pageFrom > pageTo) {
    throw new PdfPagesError(
      "invalid_page_range",
      `Inverted page range: page_from (${pageFrom}) must be ≤ page_to (${pageTo}).`
    );
  }

  const { doc: source, pageCount: sourcePageCount } = await loadPdf(bytes);
  if (pageTo > sourcePageCount) {
    throw new PdfPagesError(
      "invalid_page_range",
      `Page range ${pageFrom}-${pageTo} runs past the end of the source PDF, which has ${sourcePageCount} page(s).`,
      sourcePageCount
    );
  }

  try {
    const target = await PDFDocument.create();
    const indices: number[] = [];
    for (let page = pageFrom; page <= pageTo; page++) indices.push(page - 1);
    const copied = await target.copyPages(source, indices);
    for (const page of copied) target.addPage(page);
    return { bytes: await target.save(), sourcePageCount };
  } catch (err) {
    throw new PdfPagesError(
      "pdf_error",
      `Could not extract pages ${pageFrom}-${pageTo}: ${err instanceof Error ? err.message : String(err)}`,
      sourcePageCount
    );
  }
}

/** btoa/atob take binary strings, so bytes are walked in chunks to stay off the call-stack limit. */
const BASE64_CHUNK_BYTES = 0x8000;

/** Encode raw bytes as standard (unpadded-free, `+/`) base64 — the shape Odoo's `datas` expects. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

/** Decode Odoo's base64 `datas` into bytes. Throws {@link PdfPagesError} `pdf_error` on malformed input. */
export function base64ToBytes(base64: string): Uint8Array {
  let binary: string;
  try {
    // Odoo has historically wrapped base64 payloads at 76 columns; strip any whitespace first.
    binary = atob(base64.replace(/\s+/g, ""));
  } catch (err) {
    throw new PdfPagesError(
      "pdf_error",
      `Attachment content was not valid base64: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
