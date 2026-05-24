import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Timeline from './Timeline';
import type { DecryptedSection } from './SectionList';
import type { DecryptedPost } from '../types';

const SECTIONS: DecryptedSection[] = [
  { id: 's1', name: 'Intro', startTimeMs: 0, endTimeMs: 30000, sortOrder: 0, assignedTo: null },
  { id: 's2', name: 'Kiai 1', startTimeMs: 30000, endTimeMs: 60000, sortOrder: 1, assignedTo: null },
  { id: 's3', name: 'Outro', startTimeMs: 60000, endTimeMs: 90000, sortOrder: 2, assignedTo: null },
];

const POSTS: DecryptedPost[] = [
  {
    id: 'p1',
    difficulty_id: 'd1',
    author_id: 'u1',
    parent_id: null,
    tag: 'suggestion',
    encrypted_body: 'enc:00:15:000 - too close',
    created_at: '2024-01-01T12:00:00Z',
    updated_at: '2024-01-01T12:00:00Z',
    decryptedBody: '00:15:000 - too close',
    extractedMs: 15000,
  },
  {
    id: 'p2',
    difficulty_id: 'd1',
    author_id: 'u2',
    parent_id: null,
    tag: 'problem',
    encrypted_body: 'enc:00:45:000 - offbeat',
    created_at: '2024-01-01T13:00:00Z',
    updated_at: '2024-01-01T13:00:00Z',
    decryptedBody: '00:45:000 - offbeat',
    extractedMs: 45000,
  },
  {
    id: 'p3',
    difficulty_id: 'd1',
    author_id: 'u1',
    parent_id: null,
    tag: 'general',
    encrypted_body: 'enc:Nice map',
    created_at: '2024-01-01T14:00:00Z',
    updated_at: '2024-01-01T14:00:00Z',
    decryptedBody: 'Nice map',
    extractedMs: null,
  },
];

function renderTimeline(props?: Partial<React.ComponentProps<typeof Timeline>>) {
  return render(
    <Timeline
      sections={SECTIONS}
      posts={POSTS}
      songLengthMs={90000}
      selectedSectionId={null}
      onSelectSection={vi.fn()}
      onJumpToPost={vi.fn()}
      {...props}
    />,
  );
}

describe('Timeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the timeline bar', () => {
    renderTimeline();
    expect(screen.getByTestId('timeline-bar')).toBeInTheDocument();
  });

  it('renders section blocks', () => {
    renderTimeline();
    expect(screen.getByTestId('timeline-section-s1')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-section-s2')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-section-s3')).toBeInTheDocument();
  });

  it('renders section names inside blocks', () => {
    renderTimeline();
    expect(screen.getByText('Intro')).toBeInTheDocument();
    expect(screen.getByText('Kiai 1')).toBeInTheDocument();
    expect(screen.getByText('Outro')).toBeInTheDocument();
  });

  it('renders post markers for posts with timestamps', () => {
    renderTimeline();
    expect(screen.getByTestId('timeline-marker-p1')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-marker-p2')).toBeInTheDocument();
  });

  it('does not render markers for posts without timestamps', () => {
    renderTimeline();
    expect(screen.queryByTestId('timeline-marker-p3')).not.toBeInTheDocument();
  });

  it('calls onSelectSection when a section block is clicked', async () => {
    const onSelectSection = vi.fn();
    renderTimeline({ onSelectSection });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('timeline-section-s2'));
    expect(onSelectSection).toHaveBeenCalledTimes(1);
    expect(onSelectSection).toHaveBeenCalledWith('s2');
  });

  it('gives markers the correct background color for each tag', () => {
    const posts: DecryptedPost[] = [
      { id: 'prob', difficulty_id: 'd1', author_id: 'u1', parent_id: null, tag: 'problem',    encrypted_body: '', created_at: '', updated_at: '', decryptedBody: '', extractedMs: 10000 },
      { id: 'sugg', difficulty_id: 'd1', author_id: 'u1', parent_id: null, tag: 'suggestion', encrypted_body: '', created_at: '', updated_at: '', decryptedBody: '', extractedMs: 20000 },
      { id: 'prse', difficulty_id: 'd1', author_id: 'u1', parent_id: null, tag: 'praise',     encrypted_body: '', created_at: '', updated_at: '', decryptedBody: '', extractedMs: 30000 },
      { id: 'genl', difficulty_id: 'd1', author_id: 'u1', parent_id: null, tag: 'general',    encrypted_body: '', created_at: '', updated_at: '', decryptedBody: '', extractedMs: 40000 },
    ];
    renderTimeline({ posts });
    expect(screen.getByTestId('timeline-marker-prob').style.backgroundColor).toBe('rgb(239, 68, 68)');
    expect(screen.getByTestId('timeline-marker-sugg').style.backgroundColor).toBe('rgb(234, 179, 8)');
    expect(screen.getByTestId('timeline-marker-prse').style.backgroundColor).toBe('rgb(59, 130, 246)');
    expect(screen.getByTestId('timeline-marker-genl').style.backgroundColor).toBe('rgb(168, 85, 247)');
  });

  it('calls onJumpToPost when a marker is clicked', async () => {
    const onJumpToPost = vi.fn();
    renderTimeline({ onJumpToPost });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('timeline-marker-p1'));
    expect(onJumpToPost).toHaveBeenCalledTimes(1);
    expect(onJumpToPost).toHaveBeenCalledWith('p1');
  });

  it('highlights the selected section', () => {
    renderTimeline({ selectedSectionId: 's2' });
    const block = screen.getByTestId('timeline-section-s2');
    expect(block.className).toContain('ring-inset');
  });

  it('shows fallback message when songLengthMs is zero', () => {
    renderTimeline({ songLengthMs: 0 });
    expect(screen.getByText(/No timeline available/i)).toBeInTheDocument();
  });

  it('sorts sections by startTimeMs regardless of input order', () => {
    const shuffled = [
      { id: 's2', name: 'Kiai', startTimeMs: 30000, endTimeMs: 60000, sortOrder: 1, assignedTo: null },
      { id: 's1', name: 'Intro', startTimeMs: 0, endTimeMs: 30000, sortOrder: 0, assignedTo: null },
    ];
    renderTimeline({ sections: shuffled });
    const blocks = screen.getAllByRole('button').filter((el) =>
      el.getAttribute('data-testid')?.startsWith('timeline-section-'),
    );
    expect(blocks[0]).toHaveAttribute('data-testid', 'timeline-section-s1');
    expect(blocks[1]).toHaveAttribute('data-testid', 'timeline-section-s2');
  });

  it('gives unassigned sections a grey background via inline style', () => {
    renderTimeline({ sections: [{ id: 's1', name: 'Intro', startTimeMs: 0, endTimeMs: 30000, sortOrder: 0, assignedTo: null }] });
    const block = screen.getByTestId('timeline-section-s1');
    // Unassigned uses oklch with chroma 0 (neutral grey); no alpha channel on a full section.
    expect(block.style.backgroundColor).toContain('oklch');
    expect(block.style.backgroundColor).not.toContain('/ 0.4');
  });

  it('gives two sections assigned to the same user the same color', () => {
    const sections: DecryptedSection[] = [
      { id: 's1', name: 'A', startTimeMs: 0, endTimeMs: 30000, sortOrder: 0, assignedTo: 'user-1' },
      { id: 's2', name: 'B', startTimeMs: 30000, endTimeMs: 60000, sortOrder: 1, assignedTo: 'user-1' },
    ];
    const membersById = new Map([['user-1', { username: 'alice' }]]);
    renderTimeline({ sections, membersById });
    const bg1 = screen.getByTestId('timeline-section-s1').style.backgroundColor;
    const bg2 = screen.getByTestId('timeline-section-s2').style.backgroundColor;
    expect(bg1).toBeTruthy();
    expect(bg1).toEqual(bg2);
  });

  it('gives sections assigned to different users different colors', () => {
    const sections: DecryptedSection[] = [
      { id: 's1', name: 'A', startTimeMs: 0, endTimeMs: 30000, sortOrder: 0, assignedTo: 'user-1' },
      { id: 's2', name: 'B', startTimeMs: 30000, endTimeMs: 60000, sortOrder: 1, assignedTo: 'user-2' },
    ];
    const membersById = new Map([
      ['user-1', { username: 'alice' }],
      ['user-2', { username: 'bob' }],
    ]);
    renderTimeline({ sections, membersById });
    const bg1 = screen.getByTestId('timeline-section-s1').style.backgroundColor;
    const bg2 = screen.getByTestId('timeline-section-s2').style.backgroundColor;
    expect(bg1).toBeTruthy();
    expect(bg2).toBeTruthy();
    expect(bg1).not.toEqual(bg2);
  });

  it('uses a muted background for sections with no hit objects in range', () => {
    const sections: DecryptedSection[] = [
      { id: 's1', name: 'A', startTimeMs: 0, endTimeMs: 30000, sortOrder: 0, assignedTo: 'user-1' },
    ];
    const membersById = new Map([['user-1', { username: 'alice' }]]);
    const sectionHitObjectMap = new Map([['s1', false]]);
    renderTimeline({ sections, membersById, sectionHitObjectMap });
    const block = screen.getByTestId('timeline-section-s1');
    // Muted assigned sections carry an alpha value in their oklch backgroundColor
    expect(block.style.backgroundColor).toContain('/ 0.4');
  });

  it('uses full background for sections that have hit objects in range', () => {
    const sections: DecryptedSection[] = [
      { id: 's1', name: 'A', startTimeMs: 0, endTimeMs: 30000, sortOrder: 0, assignedTo: 'user-1' },
    ];
    const membersById = new Map([['user-1', { username: 'alice' }]]);
    const sectionHitObjectMap = new Map([['s1', true]]);
    renderTimeline({ sections, membersById, sectionHitObjectMap });
    const block = screen.getByTestId('timeline-section-s1');
    expect(block.style.backgroundColor).not.toContain('/ 0.4');
  });

  it('uses full background when section is not yet in the hit-object map', () => {
    const sections: DecryptedSection[] = [
      { id: 's1', name: 'A', startTimeMs: 0, endTimeMs: 30000, sortOrder: 0, assignedTo: 'user-1' },
    ];
    const membersById = new Map([['user-1', { username: 'alice' }]]);
    renderTimeline({ sections, membersById, sectionHitObjectMap: new Map() });
    const block = screen.getByTestId('timeline-section-s1');
    expect(block.style.backgroundColor).not.toContain('/ 0.4');
  });

  it('does not render markers for reply posts even when they have timestamps', () => {
    const posts: DecryptedPost[] = [
      { id: 'root', difficulty_id: 'd1', author_id: 'u1', parent_id: null,     tag: 'suggestion', encrypted_body: '', created_at: '', updated_at: '', decryptedBody: '', extractedMs: 15000 },
      { id: 'repl', difficulty_id: 'd1', author_id: 'u1', parent_id: 'root-id', tag: 'general',    encrypted_body: '', created_at: '', updated_at: '', decryptedBody: '', extractedMs: 20000 },
    ];
    renderTimeline({ posts });
    expect(screen.getByTestId('timeline-marker-root')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-marker-repl')).not.toBeInTheDocument();
  });

  it('shows resolved posts in green with lowest z-index', () => {
    const posts: DecryptedPost[] = [
      { id: 'root', difficulty_id: 'd1', author_id: 'u1', parent_id: null, tag: 'problem', encrypted_body: '', created_at: '', updated_at: '', decryptedBody: '', extractedMs: 15000 },
    ];
    const resolvedPostIds = new Set(['root']);
    renderTimeline({ posts, resolvedPostIds });
    const marker = screen.getByTestId('timeline-marker-root');
    expect(marker.style.backgroundColor).toBe('rgb(34, 197, 94)');
    expect(marker.style.zIndex).toBe('5');
  });

  it('shows unresolved posts in their tag color', () => {
    const posts: DecryptedPost[] = [
      { id: 'root', difficulty_id: 'd1', author_id: 'u1', parent_id: null, tag: 'problem', encrypted_body: '', created_at: '', updated_at: '', decryptedBody: '', extractedMs: 15000 },
    ];
    renderTimeline({ posts });
    const marker = screen.getByTestId('timeline-marker-root');
    expect(marker.style.backgroundColor).toBe('rgb(239, 68, 68)');
  });
});
