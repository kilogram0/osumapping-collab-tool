import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import Input from './Input';

describe('Input', () => {
  it('renders a labelled text input and accepts typing', async () => {
    render(<Input id="name" label="Name" value="" onChange={() => {}} />);
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('calls onChange when the user types', async () => {
    const onChange = vi.fn();
    render(<Input id="name" label="Name" value="" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText(/name/i), 'Alice');
    expect(onChange).toHaveBeenCalledTimes(5);
  });

  it('renders a textarea when multiline is true', () => {
    render(<Input id="desc" label="Description" multiline rows={3} value="" onChange={() => {}} />);
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('rows', '3');
  });

  it('displays an error message and marks the input invalid', () => {
    render(<Input id="name" label="Name" value="" onChange={() => {}} error="Required" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/required/i);
    expect(screen.getByLabelText(/name/i)).toHaveAttribute('aria-invalid', 'true');
  });

  it('renders a hint and associates it with the input', () => {
    render(<Input id="name" label="Name" value="" onChange={() => {}} hint="Use your username" />);
    expect(screen.getByText(/use your username/i)).toHaveAttribute('id', 'name-hint');
    expect(screen.getByLabelText(/name/i)).toHaveAttribute('aria-describedby', 'name-hint');
  });
});
