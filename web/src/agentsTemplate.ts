/** The template in Settings → Agents file (components/AgentsFile.tsx): the textarea's text and what the service has saved. */
export interface TemplateDraft {
  text: string;
  saved: string;
  custom: boolean;
  defaultText: string;
}

/**
 * After a save (or a reset) the service took: `saved` is what it holds now. The textarea takes it only when it still
 * holds what was submitted (`submitted`): typing done while the command ran is kept, as an unsaved draft.
 */
export function templateSaved(current: TemplateDraft, submitted: string, saved: string, custom: boolean): TemplateDraft {
  return { ...current, text: current.text === submitted ? saved : current.text, saved, custom };
}
