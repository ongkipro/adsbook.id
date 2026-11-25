export type CmsVersionInfo = {
  version: string;
  channel: string;
  releaseTag: string;
  coreEngine: string;
  schemaVersion: number;
  lastUpdated: string;
};

export const CMS_VERSION: CmsVersionInfo = {
  // adsbook.id numbers its own releases from 1.0.0, the launch (Paduka,
  // 2026-11-17). It is built on the engine it was forked from, whose releases ended
  // at 1.10.1; their notes live in the repository history and the docs
  // repository's BUILD-LOG, not in this product's "What's new".
  version: "1.0.0",
  channel: "production",
  releaseTag: "2026.11-launch",
  // What the "What's new" footer shows: the product's own words, no vendor names.
  coreEngine: "Edge server-rendered · 348 kota · database per toko",
  schemaVersion: 89,
  lastUpdated: "2026-11-17",
};
