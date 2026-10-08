/** The header line that tally 0.x printed above every report. */
export function legacyBanner(version: string): string {
  return `== tally ${version} ==`;
}
