/**
 * T3 Code's newer clients (its iPhone app) put an attached image into the message text as a reference,
 * `![IMG_1.png](t3-context://v1/image/<id>)`, and send the image itself as an attachment. The room shows a message's
 * attachments as images under the text, so image references are dropped from the text; other context references
 * (`[label](t3-context://v1/<kind>/<id>)`) keep their label. A message whose image did not come along says which image
 * it had.
 */
const CONTEXT_REF = /!?\[([^\]]*)\]\(t3-context:\/\/[^)\s]*\)/g;

export function withoutT3ContextRefs(text: string, hasImages: boolean): string {
  if (!text.includes("t3-context://")) return text;
  return text
    .replace(CONTEXT_REF, (ref: string, label: string) => (/^!?\[[^\]]*\]\(t3-context:\/\/v\d+\/image\//.test(ref) ? (hasImages ? "" : `[image: ${label || "image"}]`) : label))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}
