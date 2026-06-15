import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import Modal from './Modal';

describe('Modal', () => {
  it('renders the dialog with labelled title and content', () => {
    render(
      <Modal open ariaLabelledBy="modal-title" onClose={vi.fn()}>
        <h2 id="modal-title">Modal Title</h2>
        <p>Modal content</p>
      </Modal>,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Modal Title')).toBeInTheDocument();
    expect(screen.getByText('Modal content')).toBeInTheDocument();
  });

  it('calls onClose when the backdrop is clicked', async () => {
    const onClose = vi.fn();
    render(
      <Modal open ariaLabelledBy="modal-title" onClose={onClose}>
        <h2 id="modal-title">Title</h2>
      </Modal>,
    );

    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when Escape is pressed', async () => {
    const onClose = vi.fn();
    render(
      <Modal open ariaLabelledBy="modal-title" onClose={onClose}>
        <h2 id="modal-title">Title</h2>
      </Modal>,
    );

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close on backdrop click when closeOnBackdrop is false', async () => {
    const onClose = vi.fn();
    render(
      <Modal open ariaLabelledBy="modal-title" onClose={onClose} closeOnBackdrop={false}>
        <h2 id="modal-title">Title</h2>
      </Modal>,
    );

    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close on Escape when closeOnEscape is false', async () => {
    const onClose = vi.fn();
    render(
      <Modal open ariaLabelledBy="modal-title" onClose={onClose} closeOnEscape={false}>
        <h2 id="modal-title">Title</h2>
      </Modal>,
    );

    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('restores focus to the previously focused element when unmounted', async () => {
    const onClose = vi.fn();

    function Wrapper({ showModal }: { showModal: boolean }) {
      return (
        <>
          <button type="button">Trigger</button>
          {showModal && (
            <Modal open ariaLabelledBy="modal-title" onClose={onClose}>
              <h2 id="modal-title">Title</h2>
              <input />
            </Modal>
          )}
        </>
      );
    }

    const { rerender } = render(<Wrapper showModal={false} />);
    const trigger = screen.getByRole('button', { name: /trigger/i });
    await userEvent.click(trigger);
    expect(document.activeElement).toBe(trigger);

    rerender(<Wrapper showModal />);
    // The modal should have moved focus into the panel on open.
    expect(document.activeElement).not.toBe(trigger);

    rerender(<Wrapper showModal={false} />);
    expect(document.activeElement).toBe(trigger);
  });
});
