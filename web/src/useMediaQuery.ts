import { useEffect, useState } from "react";

/** Phones and narrow tablets: the drawer takes the full width and the inspector is a sheet (see styles.css). */
export const MOBILE_QUERY = "(max-width: 760px)";
/** Touch-first devices: the on-screen keyboard's Enter inserts a newline; the Send button sends. */
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

export const mediaMatches = (query: string): boolean => typeof window !== "undefined" && window.matchMedia(query).matches;

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => mediaMatches(query));
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}
