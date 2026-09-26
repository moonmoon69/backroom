/**
 * A page's name in its header, as a small breadcrumb: where it lives (its project, or "Browsers"), then its name.
 * Small and plain, so it reads as the page's title beside the sidebar's "T3 Rooms" rather than as a second logo, and
 * always there, so switching rooms or threads (from the collapsed rail too) shows where you landed.
 */
export function PageTitle({ context, contextTitle, name, mono }: { context: string | null; contextTitle?: string | undefined; name: string; mono?: boolean }) {
  return (
    <h1 className="page-title">
      {context ? (
        <>
          <span className="page-crumb" title={contextTitle ?? context}>
            {context}
          </span>
          <span className="page-crumb-sep" aria-hidden="true">
            /
          </span>
        </>
      ) : null}
      <span className={`page-name${mono ? " mono" : ""}`} title={name}>
        {name}
      </span>
    </h1>
  );
}
