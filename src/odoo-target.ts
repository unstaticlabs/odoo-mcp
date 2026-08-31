export const DEFAULT_ODOO_REQUEST_BYTES = 4 * 1024 * 1024;
export const DEFAULT_ODOO_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface OdooTargetOptions {
  allowLocalHttp?: boolean;
  workerOrigin?: string;
}

export class OdooTargetError extends Error {
  readonly code = "invalid_odoo_target";

  constructor(message: string) {
    super(message);
    this.name = "OdooTargetError";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((part) => part >= 0 && part <= 255) && octets[0] === 127;
}

/**
 * Validate and canonicalize an Odoo deployment URL to its origin.
 *
 * Private HTTPS hosts are deliberately accepted. This boundary prevents URL
 * confusion and credential forwarding through redirects; it is not an SSRF
 * allowlist.
 */
export function normalizeOdooOrigin(raw: string, options: OdooTargetOptions = {}): string {
  const candidate = raw.trim();
  if (!candidate) throw new OdooTargetError("Odoo URL is required.");

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new OdooTargetError("Odoo URL must be an absolute HTTPS origin.");
  }

  if (parsed.username || parsed.password) {
    throw new OdooTargetError("Odoo URL must not contain credentials.");
  }
  if (parsed.search) throw new OdooTargetError("Odoo URL must not contain a query string.");
  if (parsed.hash) throw new OdooTargetError("Odoo URL must not contain a fragment.");
  if (parsed.pathname !== "/") throw new OdooTargetError("Odoo URL must be an origin without a path.");
  if (!parsed.hostname) throw new OdooTargetError("Odoo URL must contain a valid hostname.");

  if (parsed.protocol === "http:") {
    if (!options.allowLocalHttp || !isLoopbackHostname(parsed.hostname)) {
      throw new OdooTargetError("Odoo URL must use HTTPS; HTTP is allowed only for explicitly enabled loopback development.");
    }
  } else if (parsed.protocol !== "https:") {
    throw new OdooTargetError("Odoo URL must use HTTPS.");
  }

  const origin = parsed.origin;
  if (origin === "null") throw new OdooTargetError("Odoo URL must have a network origin.");

  if (options.workerOrigin) {
    let workerOrigin: string;
    try {
      workerOrigin = new URL(options.workerOrigin).origin;
    } catch {
      throw new OdooTargetError("Worker origin is malformed.");
    }
    if (origin === workerOrigin) {
      throw new OdooTargetError("Odoo URL must not point to this MCP Worker.");
    }
  }

  return origin;
}

export function allowLocalHttpFromEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function validateOdooDatabase(value: string): string {
  const database = value.trim();
  if (!database || database.length > 128 || /[\u0000-\u001f\u007f]/.test(database)) {
    throw new OdooTargetError("Odoo database must be a non-empty name of at most 128 characters.");
  }
  return database;
}
