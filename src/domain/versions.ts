/** Version order, shared by the Updates popup's rows (Backroom, T3, harnesses) and the adapter's managed installs. */

/** Semver order: the core numbers, then the prerelease identifiers; a release is above its prereleases. 0 when either does not parse. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const plain = version.split("+")[0]!;
    const dash = plain.indexOf("-");
    const core = (dash < 0 ? plain : plain.slice(0, dash)).split(".").map(Number);
    return { core, pre: dash < 0 ? [] : plain.slice(dash + 1).split(".") };
  };
  const x = parse(a);
  const y = parse(b);
  if ([...x.core, ...y.core].some((n) => !Number.isInteger(n)) || x.core.length !== 3 || y.core.length !== 3) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! < y.core[i]! ? -1 : 1;
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pNumber = /^\d+$/.test(p);
    const qNumber = /^\d+$/.test(q);
    if (pNumber && qNumber && Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    if (pNumber !== qNumber) return pNumber ? -1 : 1;
    if (!pNumber && p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
