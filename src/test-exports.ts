/**
 * Test-support barrel. These re-exports used to live on src/index.ts, but the
 * Workers runtime rejects non-handler exports on the entry module ("Incorrect
 * type for map entry ..."), so anything that isn't a handler or Durable Object
 * class lives here instead. Tests import from this module; wrangler never sees
 * it. Do not add runtime code here.
 */
export {
  callOdoo,
  OdooError,
  classifyOdooError,
  classifyAggregationDiagnosis,
  aggregationDiagnosisFromOdooError,
  normalizeOdooDetails,
  matchInvalidGroupby,
  matchUnsupportedAggregate,
  isRecoverable
} from "./odoo";
export type { OdooErrorCode, AggregationDiagnosisCode, AggregationErrorContext } from "./odoo";
export { mcpAggregationErrorFromException, redactDetails } from "./tools/shared";
export type { AggregationErrorEnvelope } from "./tools/shared";
export { OdooQueue } from "./odoo-queue";
export {
  pickSmartFields,
  searchRecords,
  escapeHtml,
  countRecords,
  resolveFields,
  MODEL_FIELD_PRESETS,
  browseRecords,
  searchRecordsCompact,
  resolveNamedFieldPreset,
  resolveBatchReadFields,
  buildBrowsePageMeta,
  applyBrowseSafeguard,
  NAMED_MODEL_FIELD_PRESETS,
  BROWSE_MAX_PAYLOAD_BYTES,
  BROWSE_MIN_LIMIT,
  resolveCompactFields,
  buildPageMetadata,
  buildCompactReadEnvelope,
  FIELD_PRESET_NAMES,
  FIELD_PRESET_FALLBACKS,
  FIELD_PRESET_MODEL_OVERRIDES,
  zPageMetadata,
  zCompactFieldsBlock,
  zCompactReadEnvelope
} from "./tools/shared";
export type {
  FieldResolution,
  NamedFieldPreset,
  NamedPresetResolution,
  BatchReadFieldsResolution,
  BrowseResult,
  BrowsePageMeta,
  BrowseSafeguardPlan,
  FieldPresetName,
  PageMetadata,
  CompactReadEnvelope,
  CompactFieldResolution,
  CompactFieldsBlock
} from "./tools/shared";
export { parseButtonsFromArch, mergeModelActions, annotateModelActions } from "./tools/read";
export { CURATED_MODEL_ACTIONS } from "./tools/actions-map";
export { normalizeRecord, normalizeRecords, deriveWorkflowStatus } from "./normalizer";
export type { OdooFieldMeta, FieldsMeta, NormalizeOptions } from "./normalizer";
export { TtlCache, getFieldsCached, resolveXmlIdCached, cachedSearchRead, TTL_METADATA_MS, TTL_STRUCTURE_MS, TTL_BALANCE_MS } from "./cache";
export type { CachedFieldMeta, XmlIdResolution } from "./cache";
export { validateOdooCredentials } from "./oauth";
export { McpAgent, AccountingAgent, ProjectsAgent } from "./server";
