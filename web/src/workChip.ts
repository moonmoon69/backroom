/** A status bar chip's words (WorkBar.tsx). */

export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Its hover: who, what, and the text whole, which the chip cuts short; a chip that opens nothing is read only here. */
export const chipTitle = (alias: string, what: string, text: string): string => `${alias} · ${what}${text ? `: ${oneLine(text)}` : ""}`;
