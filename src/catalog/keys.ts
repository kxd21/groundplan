/**
 * Catalog signing keys, pinned into the application.
 *
 * Pinned rather than fetched: a key collected at runtime could be replaced by
 * whoever is in a position to replace the catalog, which would make the
 * signature prove nothing. These are the only keys whose releases this build
 * will install.
 *
 * More than one is accepted so a key can be rotated without stranding
 * installations that only know the old one — publish under both for a release
 * or two, then retire the old key in a later application update.
 *
 * The public half is safe to publish; it can only verify, never sign.
 */
export const CATALOG_PUBLIC_KEYS = [
  // Primary, generated 2026-07-29.
  'MCowBQYDK2VwAyEABZioderYc6bfARckOvuy/RbOdnXhCPN93eqSqk4J4OE=',
];

/** Where release manifests are published. */
export const CATALOG_MANIFEST_URL =
  'https://github.com/kxd21/groundplan-catalog/releases/latest/download/manifest.json';
