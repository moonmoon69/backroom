/** T3's model catalog as the pickers use it: one shared read per page, and the selection a catalog entry stands for. */
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { CatalogEntry, ModelOptionDescriptor, ModelSelection } from "../types.ts";

/** Default value for one descriptor: the isDefault option (else the first) for selects, defaultValue === true for booleans. */
export function defaultOptionValue(descriptor: ModelOptionDescriptor): unknown {
  if (descriptor.type === "boolean") return descriptor.defaultValue === true;
  const choices = descriptor.options ?? [];
  const preset = choices.find((o) => o.isDefault) ?? choices[0];
  if (preset) return preset.id;
  return descriptor.defaultValue;
}

/** Selection for a catalog entry with every option set explicitly (as T3's own client does); no `options` key without descriptors. */
export function selectionFor(entry: Pick<CatalogEntry, "instanceId" | "model" | "optionDescriptors">): ModelSelection {
  const descriptors = entry.optionDescriptors ?? [];
  if (descriptors.length === 0) return { instanceId: entry.instanceId, model: entry.model };
  return {
    instanceId: entry.instanceId,
    model: entry.model,
    options: descriptors.map((d) => ({ id: d.id, value: defaultOptionValue(d) })),
  };
}

export const entryKey = (entry: Pick<CatalogEntry, "instanceId" | "model">): string => `${entry.instanceId}\u0000${entry.model}`;

// T3's model catalog, shared by every picker and options menu, and read again once a minute old, so a model T3 has
// added since the page loaded turns up the next time a picker opens. `fresh` reads it now (after a model refresh).
const CATALOG_MAX_AGE_MS = 60_000;
let catalogLoad: { at: number; value: Promise<CatalogEntry[]> } | null = null;
let lastCatalog: CatalogEntry[] | null = null;
export function loadCatalog(fresh = false): Promise<CatalogEntry[]> {
  if (fresh || !catalogLoad || Date.now() - catalogLoad.at > CATALOG_MAX_AGE_MS) {
    const value = api.catalog().then(
      (entries) => (lastCatalog = entries),
      (error: unknown) => {
        if (catalogLoad?.value === value) catalogLoad = null;
        throw error;
      },
    );
    catalogLoad = { at: Date.now(), value };
  }
  return catalogLoad.value;
}

/** The last catalog read, to show while a newer one loads. */
export const cachedCatalog = (): CatalogEntry[] | null => lastCatalog;

export function useCatalog(): CatalogEntry[] | null {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(cachedCatalog);
  useEffect(() => {
    let cancelled = false;
    loadCatalog().then(
      (entries) => !cancelled && setCatalog(entries),
      () => !cancelled && setCatalog((current) => current ?? []),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return catalog;
}
