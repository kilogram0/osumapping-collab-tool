import { formatTimestamp } from './extractTimestamp';

export interface AssignmentInput {
  startTimeMs: number;
  endTimeMs: number;
  /** Resolved display name for the assignee (caller maps user id → username). */
  assignee: string;
}

/** A section as stored client-side, before its assignee id is resolved to a name. */
export interface AssignableSection {
  startTimeMs: number;
  endTimeMs: number;
  assignedTo: string | null;
}

export interface AssignmentLabels {
  /** Resolve a user id to a display name, or undefined if the user is unknown. */
  resolveUsername: (userId: string) => string | undefined;
  /** Label for sections with no assignee. */
  unassignedLabel: string;
  /** Label for sections assigned to a user that can no longer be resolved (e.g. removed member). */
  unknownUserLabel: string;
}

/**
 * Resolve each section's `assignedTo` id into a display name for the copy-paste
 * list. Unassigned sections use `unassignedLabel`; sections whose assignee can no
 * longer be resolved (removed/ghost member) use `unknownUserLabel` rather than
 * leaking a raw UUID into the pasted text.
 */
export function toAssignmentInputs(
  sections: AssignableSection[],
  labels: AssignmentLabels,
): AssignmentInput[] {
  return sections.map((s) => ({
    startTimeMs: s.startTimeMs,
    endTimeMs: s.endTimeMs,
    assignee:
      s.assignedTo === null
        ? labels.unassignedLabel
        : labels.resolveUsername(s.assignedTo) ?? labels.unknownUserLabel,
  }));
}

function formatAssignmentLine(s: AssignmentInput): string {
  return `${formatTimestamp(s.startTimeMs)} - ${formatTimestamp(s.endTimeMs)}: ${s.assignee}`;
}

/**
 * Build the copy-paste assignment list, one line per range:
 *
 *   00:00:000 - 00:12:172: CebollaVladimir
 *
 * Sections are sorted by start time, then consecutive sections with the same
 * assignee are merged into a single range so the same name never appears on two
 * subsequent lines. This is the "For Submission" format.
 */
export function buildAssignmentText(sections: AssignmentInput[]): string {
  const sorted = [...sections].sort((a, b) => a.startTimeMs - b.startTimeMs);

  const merged: AssignmentInput[] = [];
  for (const section of sorted) {
    const last = merged[merged.length - 1];
    // Merge only when the ranges are contiguous. osu sections always abut
    // (each section's start is the previous section's end), so same-assignee
    // neighbours collapse; the contiguity guard keeps a genuine gap visible
    // rather than silently swallowing it under a single range.
    if (last && last.assignee === section.assignee && last.endTimeMs === section.startTimeMs) {
      last.endTimeMs = section.endTimeMs;
    } else {
      merged.push({ ...section });
    }
  }

  return merged.map(formatAssignmentLine).join('\n');
}

/**
 * Build a raw copy-paste assignment list with one line per section.
 *
 * Unlike `buildAssignmentText`, consecutive sections assigned to the same user
 * are kept as separate lines. This is useful for pinning in Discord servers to
 * see which individual sections are still unassigned.
 */
export function buildRawAssignmentText(sections: AssignmentInput[]): string {
  const sorted = [...sections].sort((a, b) => a.startTimeMs - b.startTimeMs);
  return sorted.map(formatAssignmentLine).join('\n');
}
