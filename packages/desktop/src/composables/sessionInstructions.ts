import type { ProjectSettings } from "~/types";

/** Note shown next to every project-settings form. */
export const INSTRUCTIONS_NOTE = "保存後に起動する session から効く。動いている session には効かない";

/** Max length (chars) of `instructions` (same limit as the center). */
export const INSTRUCTIONS_MAX = 16_000;

/**
 * What the project-settings form edits: one text per item. A new item (skills, output style, …) is
 * a field here, a section in `ProjectSettingsFields.vue`, and a line in the two functions below.
 */
export interface SettingsDraft {
  instructions: string;
}

export const emptyDraft = (): SettingsDraft => ({ instructions: "" });

/** The form values for the settings the center returned. */
export const draftOf = (s: ProjectSettings): SettingsDraft => ({ instructions: s.instructions ?? "" });

/** The form values as an update body: a blank item is `null` (the center removes it). */
export const toUpdate = (d: SettingsDraft): ProjectSettings => ({
  instructions: d.instructions.trim() ? d.instructions : null,
});

/** Problem with the form values, or null. */
export const draftError = (d: SettingsDraft): string | null =>
  [...d.instructions].length > INSTRUCTIONS_MAX ? `追加指示は ${INSTRUCTIONS_MAX} 文字以内` : null;
