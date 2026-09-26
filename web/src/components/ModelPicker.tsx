/**
 * The model picker, laid out like T3 Code's: a rail of providers (favourites first) beside a search field and the
 * chosen provider's models. Fed by /api/t3/catalog and /api/t3/providers; disabled providers are omitted.
 *
 * - Typing searches every provider at once (name, slug, aliases, provider).
 * - Legacy models sit behind one "Legacy models" row per provider, as in T3.
 * - Favourites are the room's own (T3 keeps its favourites in its client, not on the server), stored in this browser.
 * - Keys, with the cursor in the search field: ↑/↓ move, Enter chooses, ←/→ change provider while the field is
 *   empty, Alt+1…9 choose by position, Escape closes.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { ApiError, useProviders } from "../api.ts";
import type { CatalogEntry, ModelSelection, ProviderInfo } from "../types.ts";
import { MOBILE_QUERY, useMediaQuery } from "../useMediaQuery.ts";
import { entryKey, loadCatalog, selectionFor } from "./catalog.ts";
import { Popover } from "./Popover.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { ProviderLine } from "./Providers.tsx";
import { useToast } from "./Toast.tsx";
import { ChevronIcon, SearchIcon, StarIcon } from "./icons.tsx";

// ---- favourites: a set of entry keys in localStorage, shared by every picker on the page ----
const FAVORITES_KEY = "t3rooms.modelFavorites";
let favoriteKeys: ReadonlySet<string> | null = null;
const favoriteListeners = new Set<() => void>();

function readFavorites(): ReadonlySet<string> {
  if (favoriteKeys) return favoriteKeys;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    favoriteKeys = new Set(Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : []);
  } catch {
    favoriteKeys = new Set();
  }
  return favoriteKeys;
}

function toggleFavorite(key: string): void {
  const next = new Set(readFavorites());
  if (!next.delete(key)) next.add(key);
  favoriteKeys = next;
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
  } catch {
    // Private mode or a full store: the favourite lasts for this page.
  }
  for (const listener of favoriteListeners) listener();
}

function subscribeFavorites(listener: () => void): () => void {
  // Another tab changed them: read again.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== FAVORITES_KEY) return;
    favoriteKeys = null;
    listener();
  };
  favoriteListeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    favoriteListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const useFavorites = (): ReadonlySet<string> => useSyncExternalStore(subscribeFavorites, readFavorites);

/** Default first, legacy last, otherwise the server's order. */
const rankEntry = (entry: CatalogEntry): number => (entry.isDefault ? 0 : entry.isLegacy ? 2 : 1);

interface ProviderGroup {
  instanceId: string;
  name: string;
  driver: string | undefined;
  provider: ProviderInfo | undefined;
  entries: CatalogEntry[];
}

/** The rail's first section; provider sections are named by their instance id. */
const FAVORITES = "\u0000favorites";

type Row = { kind: "model"; entry: CatalogEntry } | { kind: "legacy"; count: number };

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const jumpLabel = (position: number): string => (isMac ? `⌥${position}` : `Alt+${position}`);

export function ModelPicker({
  value,
  onChange,
  id,
  providerFilter,
}: {
  value: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
  id?: string;
  /** When set, only this provider instance is offered (T3 cannot switch a thread's provider). */
  providerFilter?: string;
}) {
  const { toast } = useToast();
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const { providers } = useProviders(true);
  const favorites = useFavorites();
  const sheet = useMediaQuery(MOBILE_QUERY);
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<string>(FAVORITES);
  const [query, setQuery] = useState("");
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useMemo(() => `model-list-${Math.random().toString(36).slice(2, 8)}`, []);

  useEffect(() => {
    let cancelled = false;
    loadCatalog()
      .then((entries) => {
        if (!cancelled) setCatalog(entries);
      })
      .catch((error) => {
        if (!cancelled) {
          setCatalog([]);
          toast(error instanceof ApiError ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const providerById = useMemo(() => new Map((providers ?? []).map((p) => [p.instanceId, p])), [providers]);

  const groups = useMemo<ProviderGroup[]>(() => {
    const map = new Map<string, ProviderGroup>();
    for (const entry of catalog ?? []) {
      if (providerFilter && entry.instanceId !== providerFilter) continue;
      const provider = providerById.get(entry.instanceId);
      if (provider && !provider.enabled) continue;
      const name = entry.providerName ?? provider?.displayName ?? entry.instanceId;
      const group = map.get(entry.instanceId) ?? { instanceId: entry.instanceId, name, driver: entry.driver, provider, entries: [] };
      group.entries.push(entry);
      map.set(entry.instanceId, group);
    }
    for (const group of map.values()) {
      group.entries = group.entries
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => rankEntry(a.entry) - rankEntry(b.entry) || a.index - b.index)
        .map((x) => x.entry);
    }
    return [...map.values()];
  }, [catalog, providerById, providerFilter]);

  const groupById = useMemo(() => new Map(groups.map((g) => [g.instanceId, g])), [groups]);
  const all = useMemo(() => groups.flatMap((g) => g.entries), [groups]);
  const favoriteEntries = useMemo(() => all.filter((entry) => favorites.has(entryKey(entry))), [all, favorites]);
  const sections = useMemo(() => [FAVORITES, ...groups.map((g) => g.instanceId)], [groups]);

  // Pick a sensible initial model once the catalog is in: the first default entry, else the first entry.
  useEffect(() => {
    if (value || all.length === 0) return;
    const first = all.find((e) => e.isDefault) ?? all[0];
    if (first) onChange(selectionFor(first));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all]);

  const selected = value ? (catalog ?? []).find((e) => e.instanceId === value.instanceId && e.model === value.model) : undefined;
  const selectedKey = selected ? entryKey(selected) : null;
  const searching = query.trim().length > 0;

  const rows = useMemo<Row[]>(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length > 0) {
      return all
        .filter((entry) => {
          const text = [entry.label, entry.model, groupById.get(entry.instanceId)?.name ?? "", ...(entry.aliases ?? [])].join(" ").toLowerCase();
          return terms.every((term) => text.includes(term));
        })
        .map((entry) => ({ kind: "model", entry }));
    }
    if (section === FAVORITES) return favoriteEntries.map((entry) => ({ kind: "model", entry }));
    const entries = groupById.get(section)?.entries ?? [];
    const legacy = entries.filter((e) => e.isLegacy);
    const list: Row[] = entries.filter((e) => !e.isLegacy).map((entry) => ({ kind: "model", entry }));
    if (legacy.length > 0) {
      list.push({ kind: "legacy", count: legacy.length });
      if (legacyOpen) list.push(...legacy.map((entry): Row => ({ kind: "model", entry })));
    }
    return list;
  }, [all, favoriteEntries, groupById, legacyOpen, query, section]);

  const modelRows = useMemo(() => rows.flatMap((row) => (row.kind === "model" ? [row.entry] : [])), [rows]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  const choose = (entry: CatalogEntry) => {
    onChange(selectionFor(entry));
    close(true);
  };

  const showSection = (next: string) => {
    setSection(next);
    setQuery("");
    setLegacyOpen(next !== FAVORITES && selected?.instanceId === next && selected.isLegacy === true);
    if (!sheet) input.current?.focus();
  };

  const openPicker = () => {
    const first = favoriteEntries.length > 0 ? FAVORITES : (selected && groupById.has(selected.instanceId) ? selected.instanceId : (groups[0]?.instanceId ?? FAVORITES));
    setSection(first);
    setQuery("");
    setLegacyOpen(first !== FAVORITES && selected?.isLegacy === true);
    setOpen(true);
  };

  // On a phone the keyboard would cover the sheet it opens over, so the field waits for a tap there.
  useEffect(() => {
    if (!open || sheet) return;
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, sheet]);

  // A new list (opened, another provider, another search) starts at the chosen model, else at the top.
  useEffect(() => {
    if (!open) return;
    const index = rows.findIndex((row) => row.kind === "model" && entryKey(row.entry) === selectedKey);
    setActive(index >= 0 ? index : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, section, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!wrapper.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>(`#${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  const activate = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "legacy") setLegacyOpen((v) => !v);
    else choose(row.entry);
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
    if (digit && (event.altKey || event.metaKey || event.ctrlKey)) {
      const entry = modelRows[Number(digit) - 1];
      if (entry) {
        event.preventDefault();
        choose(entry);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && query.length === 0) {
      event.preventDefault();
      const at = sections.indexOf(section);
      const next = sections[Math.max(0, Math.min(sections.length - 1, at + (event.key === "ArrowRight" ? 1 : -1)))];
      if (next !== undefined && next !== section) showSection(next);
    } else if (event.key === "Enter") {
      event.preventDefault();
      activate(rows[active]);
    } else if (event.key === "Escape" || event.key === "Tab") {
      // Escape closes the list, not the dialog around it.
      event.stopPropagation();
      if (event.key === "Escape") event.preventDefault();
      close(true);
    }
  };

  const sectionGroup = !searching && section !== FAVORITES ? groupById.get(section) : undefined;
  let position = 0;

  return (
    <div className="model-picker" ref={wrapper}>
      <button
        ref={trigger}
        type="button"
        id={id}
        className="model-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!catalog}
        onClick={() => (open ? setOpen(false) : openPicker())}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openPicker();
          }
        }}
      >
        {!catalog ? (
          <span className="muted">Loading catalog…</span>
        ) : catalog.length === 0 ? (
          <span className="muted">Catalog is empty</span>
        ) : selected ? (
          <>
            <ProviderIcon driver={selected.driver} instanceId={selected.instanceId} name={selected.providerName ?? selected.instanceId} size={14} />
            <span className="model-label" title={`${selected.providerName ?? selected.instanceId} · ${selected.model}`}>
              {selected.label || selected.model}
            </span>
          </>
        ) : (
          <span className="muted">Choose a model…</span>
        )}
        <span className="spacer" />
        <ChevronIcon dir={open ? "up" : "down"} />
      </button>
      {open ? (
        // At the document level, like the other menus: inside a dialog it would be cut off by the dialog's edges.
        <Popover anchor={trigger} menuRef={menuRef} className="model-menu" role="dialog" onClose={() => setOpen(false)} menuProps={{ "aria-label": "Choose a model", onKeyDown: onKey }}>
          <div className="model-rail" role="toolbar" aria-label="Providers" aria-orientation="vertical">
            {sections.map((name) => {
              const group = groupById.get(name);
              const label = group ? group.name : "Favorites";
              return (
                <button
                  key={name}
                  type="button"
                  tabIndex={-1}
                  className={`model-rail-button${!searching && section === name ? " on" : ""}`}
                  aria-pressed={!searching && section === name}
                  aria-label={label}
                  title={label}
                  // The search field keeps the cursor: the rail only changes what it lists.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => showSection(name)}
                >
                  {group ? <ProviderIcon driver={group.driver} instanceId={group.instanceId} name={group.name} size={18} /> : <StarIcon filled />}
                </button>
              );
            })}
          </div>
          <div className="model-pane">
            <label className="model-search">
              <SearchIcon />
              <input
                ref={input}
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
                aria-label="Search models"
                placeholder="Search models..."
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {sectionGroup?.provider ? (
              <div className="model-section-head">
                <ProviderLine provider={sectionGroup.provider} />
              </div>
            ) : null}
            <div className="model-list" id={listId} role="listbox" aria-label={searching ? "Matching models" : (sectionGroup?.name ?? "Favorites")}>
              {rows.length === 0 ? (
                <p className="model-empty muted">{searching ? "No models match." : section === FAVORITES ? "No favorites yet. Star a model to keep it here." : "No models for this provider."}</p>
              ) : null}
              {rows.map((row, index) => {
                if (row.kind === "legacy") {
                  return (
                    <div
                      key="legacy"
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={false}
                      aria-expanded={legacyOpen}
                      className={`model-row model-legacy-toggle${index === active ? " active" : ""}`}
                      onMouseEnter={() => setActive(index)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        setLegacyOpen((v) => !v);
                      }}
                    >
                      <span className="model-row-main">
                        <span className="model-row-title">Legacy models</span>
                        <span className="model-row-sub">{row.count} models</span>
                      </span>
                      <ChevronIcon dir={legacyOpen ? "down" : "right"} />
                    </div>
                  );
                }
                const { entry } = row;
                const key = entryKey(entry);
                const group = groupById.get(entry.instanceId);
                const providerName = group?.name ?? entry.providerName ?? entry.instanceId;
                const favorite = favorites.has(key);
                position += 1;
                const jump = !sheet && position <= 9 ? jumpLabel(position) : null;
                return (
                  <div
                    key={key}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={key === selectedKey}
                    className={`model-row${index === active ? " active" : ""}${key === selectedKey ? " selected" : ""}${entry.isLegacy ? " legacy" : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(entry);
                    }}
                    title={entry.aliases && entry.aliases.length > 0 ? `aliases: ${entry.aliases.join(", ")}` : undefined}
                  >
                    <span className="model-row-main">
                      <span className="model-row-title">
                        <span className="model-label">{entry.label || entry.model}</span>
                        {entry.badge ? <span className="model-badge">{entry.badge}</span> : null}
                        {entry.isDefault ? <span className="tag mono tag-default">default</span> : null}
                      </span>
                      <span className="model-row-sub">
                        <ProviderIcon driver={entry.driver ?? group?.driver} instanceId={entry.instanceId} name={providerName} size={12} />
                        <span>{providerName}</span>
                        <span className="model-slug mono">{entry.model}</span>
                      </span>
                    </span>
                    {jump ? <kbd className="model-jump">{jump}</kbd> : null}
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`model-star${favorite ? " on" : ""}`}
                      aria-pressed={favorite}
                      aria-label={favorite ? `Remove ${entry.label || entry.model} from favorites` : `Add ${entry.label || entry.model} to favorites`}
                      title={favorite ? "Remove from favorites" : "Add to favorites"}
                      onMouseDown={(event) => {
                        // Starring is not choosing, and the search field keeps the cursor.
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={() => toggleFavorite(key)}
                    >
                      <StarIcon filled={favorite} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
