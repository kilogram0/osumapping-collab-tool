import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Timeline from './Timeline';
import type { DecryptedSection } from './SectionList';
import type { DecryptedPost } from '../types';

const SECTIONS: DecryptedSection[] = [
  { id: 's1', name: 'Intro', startTimeMs: 0, endTimeMs: 30000, sortOrder: 0 },
  { id: 's2', name: 'Kiai 1', startTimeMs: 30000, endTimeMs: 60000, sortOrder: 1 },
  { id: 's3', name: 'Outro', startTimeMs: 60000, endTimeMs: 90000, sortOrder: 2 },
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
    expect(block.className).toContain('ring-2');
  });

  it('shows fallback message when songLengthMs is zero', () => {
    renderTimeline({ songLengthMs: 0 });
    expect(screen.getByText(/No timeline available/i)).toBeInTheDocument();
  });

  it('sorts sections by startTimeMs regardless of input order', () => {
    const shuffled = [
      { id: 's2', name: 'Kiai', startTimeMs: 30000, endTimeMs: 60000, sortOrder: 1 },
      { id: 's1', name: 'Intro', startTimeMs: 0, endTimeMs: 30000, sortOrder: 0 },
    ];
    renderTimeline({ sections: shuffled });
    const blocks = screen.getAllByRole('button').filter((el) =>
      el.getAttribute('data-testid')?.startsWith('timeline-section-'),
    );
    expect(blocks[0]).toHaveAttribute('data-testid', 'timeline-section-s1');
    expect(blocks[1]).toHaveAttribute('data-testid', 'timeline-section-s2');
  });
});
