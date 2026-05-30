import { describe, it, expect } from 'vitest';
import {
  buildAssignmentText,
  toAssignmentInputs,
  type AssignmentInput,
  type AssignableSection,
  type AssignmentLabels,
} from './sectionAssignments';

describe('buildAssignmentText', () => {
  it('formats each section as MM:SS:MMM - MM:SS:MMM: assignee', () => {
    const sections: AssignmentInput[] = [
      { startTimeMs: 0, endTimeMs: 12172, assignee: 'CebollaVladimir' },
      { startTimeMs: 12172, endTimeMs: 21772, assignee: 'MarcoBrolo' },
    ];
    expect(buildAssignmentText(sections)).toBe(
      '00:00:000 - 00:12:172: CebollaVladimir\n00:12:172 - 00:21:772: MarcoBrolo',
    );
  });

  it('merges consecutive sections by the same assignee into one range', () => {
    const sections: AssignmentInput[] = [
      { startTimeMs: 56572, endTimeMs: 76972, assignee: 'CebollaVladimir' },
      { startTimeMs: 76972, endTimeMs: 88972, assignee: 'Sakorii' },
      { startTimeMs: 88972, endTimeMs: 102172, assignee: 'CebollaVladimir' },
    ];
    // Sakorii sits between the two CebollaVladimir ranges, so they must NOT merge.
    expect(buildAssignmentText(sections)).toBe(
      '00:56:572 - 01:16:972: CebollaVladimir\n01:16:972 - 01:28:972: Sakorii\n01:28:972 - 01:42:172: CebollaVladimir',
    );
  });

  it('does NOT merge same-assignee sections separated by a gap', () => {
    const sections: AssignmentInput[] = [
      { startTimeMs: 0, endTimeMs: 5000, assignee: 'alice' },
      // gap from 5000–8000 (no section); next alice range is not contiguous
      { startTimeMs: 8000, endTimeMs: 12000, assignee: 'alice' },
    ];
    expect(buildAssignmentText(sections)).toBe(
      '00:00:000 - 00:05:000: alice\n00:08:000 - 00:12:000: alice',
    );
  });

  it('collapses two adjacent sections with the same assignee', () => {
    const sections: AssignmentInput[] = [
      { startTimeMs: 0, endTimeMs: 5000, assignee: 'alice' },
      { startTimeMs: 5000, endTimeMs: 10000, assignee: 'alice' },
      { startTimeMs: 10000, endTimeMs: 15000, assignee: 'bob' },
    ];
    expect(buildAssignmentText(sections)).toBe(
      '00:00:000 - 00:10:000: alice\n00:10:000 - 00:15:000: bob',
    );
  });

  it('sorts unordered sections by start time before building', () => {
    const sections: AssignmentInput[] = [
      { startTimeMs: 20000, endTimeMs: 30000, assignee: 'bob' },
      { startTimeMs: 0, endTimeMs: 20000, assignee: 'alice' },
    ];
    expect(buildAssignmentText(sections)).toBe(
      '00:00:000 - 00:20:000: alice\n00:20:000 - 00:30:000: bob',
    );
  });

  it('reproduces the full example from the feature request', () => {
    const sections: AssignmentInput[] = [
      { startTimeMs: 0, endTimeMs: 12172, assignee: 'CebollaVladimir' },
      { startTimeMs: 12172, endTimeMs: 21772, assignee: 'MarcoBrolo' },
      { startTimeMs: 21772, endTimeMs: 37372, assignee: 'Sakorii' },
      { startTimeMs: 37372, endTimeMs: 46972, assignee: 'straweeeeee' },
      { startTimeMs: 46972, endTimeMs: 56572, assignee: 'Radiownd' },
      { startTimeMs: 56572, endTimeMs: 76972, assignee: 'CebollaVladimir' },
      { startTimeMs: 76972, endTimeMs: 88972, assignee: 'Sakorii' },
      { startTimeMs: 88972, endTimeMs: 102172, assignee: 'CebollaVladimir' },
      { startTimeMs: 102172, endTimeMs: 111772, assignee: 'Jurumas' },
      { startTimeMs: 111772, endTimeMs: 121372, assignee: 'MarcoBrolo' },
      { startTimeMs: 121372, endTimeMs: 135772, assignee: 'Radiownd' },
    ];
    expect(buildAssignmentText(sections)).toBe(
      [
        '00:00:000 - 00:12:172: CebollaVladimir',
        '00:12:172 - 00:21:772: MarcoBrolo',
        '00:21:772 - 00:37:372: Sakorii',
        '00:37:372 - 00:46:972: straweeeeee',
        '00:46:972 - 00:56:572: Radiownd',
        '00:56:572 - 01:16:972: CebollaVladimir',
        '01:16:972 - 01:28:972: Sakorii',
        '01:28:972 - 01:42:172: CebollaVladimir',
        '01:42:172 - 01:51:772: Jurumas',
        '01:51:772 - 02:01:372: MarcoBrolo',
        '02:01:372 - 02:15:772: Radiownd',
      ].join('\n'),
    );
  });
});

describe('toAssignmentInputs', () => {
  const labels: AssignmentLabels = {
    resolveUsername: (id) => ({ 'u-1': 'CebollaVladimir', 'u-2': 'Sakorii' }[id]),
    unassignedLabel: 'Unassigned',
    unknownUserLabel: 'Unknown user',
  };

  it('resolves assignedTo ids to usernames', () => {
    const sections: AssignableSection[] = [
      { startTimeMs: 0, endTimeMs: 12172, assignedTo: 'u-1' },
      { startTimeMs: 12172, endTimeMs: 21772, assignedTo: 'u-2' },
    ];
    expect(toAssignmentInputs(sections, labels)).toEqual([
      { startTimeMs: 0, endTimeMs: 12172, assignee: 'CebollaVladimir' },
      { startTimeMs: 12172, endTimeMs: 21772, assignee: 'Sakorii' },
    ]);
  });

  it('uses the unassigned label when assignedTo is null', () => {
    const sections: AssignableSection[] = [{ startTimeMs: 0, endTimeMs: 5000, assignedTo: null }];
    expect(toAssignmentInputs(sections, labels)[0].assignee).toBe('Unassigned');
  });

  it('uses the unknown-user label (not the raw id) for an unresolvable assignee', () => {
    // e.g. a removed/ghost member no longer present in membersById
    const sections: AssignableSection[] = [{ startTimeMs: 0, endTimeMs: 5000, assignedTo: 'u-removed' }];
    expect(toAssignmentInputs(sections, labels)[0].assignee).toBe('Unknown user');
  });

  it('feeds buildAssignmentText so resolved names merge across contiguous sections', () => {
    const sections: AssignableSection[] = [
      { startTimeMs: 0, endTimeMs: 5000, assignedTo: 'u-1' },
      { startTimeMs: 5000, endTimeMs: 10000, assignedTo: 'u-1' },
    ];
    expect(buildAssignmentText(toAssignmentInputs(sections, labels))).toBe(
      '00:00:000 - 00:10:000: CebollaVladimir',
    );
  });
});
