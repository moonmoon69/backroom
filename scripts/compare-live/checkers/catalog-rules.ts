/**
 * Hidden check for T3's catalog, run as a child process: imports src/catalog.ts from the copy at FIXTURE_DIR and
 * prints one line per problem. Exit 0 when the catalog is clean, 1 when it has problems, 2 when it cannot be read.
 *
 * The rules are slow-check's (unique sku like `word-01`, a name, a positive whole price in cents, a whole
 * non-negative stock), plus: the catalog still has all 36 products, and the products that had a problem are still
 * there, so deleting them is not a fix.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The products in the template that had a problem, or shared one: each must still be in the catalog. */
export const KEPT_PRODUCTS = ["Desk lamp", "Floor lamp", "Travel mug"];
export const CATALOG_SIZE = 36;
const SKU_PATTERN = /^[a-z]+-\d{2}$/;

/** Every rule the catalog breaks, as readable lines (empty when the catalog is clean). */
export function catalogProblems(catalog: unknown): string[] {
  if (!Array.isArray(catalog)) return ["CATALOG is not an array"];
  const problems: string[] = [];
  if (catalog.length !== CATALOG_SIZE) problems.push(`expected ${CATALOG_SIZE} products, found ${catalog.length}`);
  const seen = new Map<string, number>();
  const names = new Set<string>();
  for (const [index, entry] of catalog.entries()) {
    const at = `product ${index + 1}`;
    if (entry === null || typeof entry !== "object") {
      problems.push(`${at} is not an object`);
      continue;
    }
    const product = entry as Record<string, unknown>;
    const { sku, name, priceCents, stock } = product;
    if (typeof sku !== "string" || !SKU_PATTERN.test(sku)) problems.push(`${at} has an invalid sku ${JSON.stringify(sku)}`);
    else if (seen.has(sku)) problems.push(`${at} repeats sku "${sku}" of product ${seen.get(sku)}`);
    else seen.set(sku, index + 1);
    if (typeof name !== "string" || name.trim() === "") problems.push(`${at} has no name`);
    else names.add(name);
    if (typeof priceCents !== "number" || !Number.isInteger(priceCents) || priceCents <= 0) {
      problems.push(`${at} has an invalid price ${JSON.stringify(priceCents)}`);
    }
    if (typeof stock !== "number" || !Number.isInteger(stock) || stock < 0) problems.push(`${at} has an invalid stock ${JSON.stringify(stock)}`);
  }
  for (const name of KEPT_PRODUCTS) if (!names.has(name)) problems.push(`"${name}" is missing`);
  return problems;
}

if (import.meta.main) {
  const dir = process.env.FIXTURE_DIR;
  if (!dir) {
    console.error("FIXTURE_DIR is not set");
    process.exit(2);
  }
  let catalog: unknown;
  try {
    const module = (await import(pathToFileURL(join(dir, "src/catalog.ts")).href)) as { CATALOG?: unknown };
    catalog = module.CATALOG;
  } catch (error) {
    console.error(`cannot import src/catalog.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const problems = catalogProblems(catalog);
  for (const problem of problems) console.log(problem);
  if (problems.length === 0) console.log(`catalog OK (${CATALOG_SIZE} products)`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
