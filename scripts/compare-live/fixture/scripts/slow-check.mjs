// Integration check of the product catalog in src/catalog.ts.
//
// Every product is checked in turn; at the end each problem is listed with its line in src/catalog.ts and the
// process exits 1 if there were any. Each run appends a start line and a finish line to .slow-check.log in the
// project root.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "../src/catalog.ts";

/** Time spent on each product. */
const DELAY_MS = 5000;
const SKU_PATTERN = /^[a-z]+-\d{2}$/;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, "src", "catalog.ts");
const logPath = join(root, ".slow-check.log");

function log(event) {
  appendFileSync(logPath, `${new Date().toISOString()} ${event}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

log(`start ${process.pid}`);

const sourceLines = readFileSync(catalogPath, "utf8").split("\n");

/** The 1-based line of src/catalog.ts that declares a product, or 0 when it cannot be found. */
function lineOf(product) {
  const both = sourceLines.findIndex((line) => line.includes(String(product.sku)) && line.includes(String(product.name)));
  if (both >= 0) return both + 1;
  return sourceLines.findIndex((line) => line.includes(String(product.name))) + 1;
}

/** What is wrong with one product, given the line where each sku seen so far was first used. */
function problemsOf(product, firstLineBySku) {
  const problems = [];
  const sku = JSON.stringify(product.sku);
  if (typeof product.sku !== "string" || !SKU_PATTERN.test(product.sku)) {
    problems.push(`invalid sku ${sku}`);
  } else if (firstLineBySku.has(product.sku)) {
    problems.push(`duplicate sku ${sku} (first used at line ${firstLineBySku.get(product.sku)})`);
  }
  if (typeof product.name !== "string" || product.name.trim() === "") {
    problems.push(`${sku} has no name`);
  }
  if (!Number.isInteger(product.priceCents)) {
    problems.push(`${sku} has a price that is not a whole number of cents (${product.priceCents})`);
  } else if (product.priceCents <= 0) {
    problems.push(`${sku} has a non-positive price (${product.priceCents} cents)`);
  }
  if (!Number.isInteger(product.stock) || product.stock < 0) {
    problems.push(`${sku} has an invalid stock count (${product.stock})`);
  }
  return problems;
}

const failures = [];
const firstLineBySku = new Map();

for (const [index, product] of CATALOG.entries()) {
  await sleep(DELAY_MS);
  const line = lineOf(product);
  const problems = problemsOf(product, firstLineBySku);
  if (!firstLineBySku.has(product.sku)) firstLineBySku.set(product.sku, line);
  for (const message of problems) failures.push({ line, message });
  console.log(`checking ${index + 1}/${CATALOG.length} ${product.sku} ... ${problems.length === 0 ? "ok" : "FAIL"}`);
}

for (const { line, message } of failures) console.log(`FAIL src/catalog.ts:${line} ${message}`);

if (failures.length === 0) {
  console.log(`slow-check: catalog OK (${CATALOG.length} products)`);
  log(`finish pass ${process.pid}`);
} else {
  console.log(`slow-check: ${failures.length} problem${failures.length === 1 ? "" : "s"}`);
  log(`finish fail ${process.pid} ${failures.length} problems`);
  process.exitCode = 1;
}
