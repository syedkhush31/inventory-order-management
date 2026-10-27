// Pagination on its own, with plain props: no network involved.
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import Pagination from './Pagination.jsx';

function setup(props) {
  const onPageChange = vi.fn();
  render(<Pagination pageSize={25} onPageChange={onPageChange} {...props} />);
  return onPageChange;
}

const previous = () => screen.getByRole('button', { name: 'Previous' });
const next = () => screen.getByRole('button', { name: 'Next' });

describe('first page of several', () => {
  test('shows the range, disables Previous, enables Next', () => {
    setup({ page: 1, total: 60, totalPages: 3 });
    expect(screen.getByText('Showing 1–25 of 60')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(previous()).toBeDisabled();
    expect(next()).toBeEnabled();
  });

  test('Next asks for page 2', () => {
    const onPageChange = setup({ page: 1, total: 60, totalPages: 3 });
    fireEvent.click(next());
    expect(onPageChange).toHaveBeenCalledWith(2);
  });
});

describe('middle page', () => {
  test('enables both buttons and each asks for the neighbouring page', () => {
    const onPageChange = setup({ page: 2, total: 60, totalPages: 3 });
    expect(screen.getByText('Showing 26–50 of 60')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    expect(previous()).toBeEnabled();
    expect(next()).toBeEnabled();

    fireEvent.click(previous());
    fireEvent.click(next());
    expect(onPageChange.mock.calls).toEqual([[1], [3]]);
  });
});

describe('last page', () => {
  test('a partly filled last page shows the right range and disables Next', () => {
    setup({ page: 3, total: 60, totalPages: 3 });
    expect(screen.getByText('Showing 51–60 of 60')).toBeInTheDocument();
    expect(next()).toBeDisabled();
    expect(previous()).toBeEnabled();
  });

  test('a last page with a single item shows "51–51"', () => {
    setup({ page: 3, total: 51, totalPages: 3 });
    expect(screen.getByText('Showing 51–51 of 51')).toBeInTheDocument();
  });

  test('a disabled Next button does not fire', () => {
    const onPageChange = setup({ page: 3, total: 60, totalPages: 3 });
    fireEvent.click(next());
    expect(onPageChange).not.toHaveBeenCalled();
  });
});

describe('single page', () => {
  test('both buttons are disabled and the range covers all results', () => {
    setup({ page: 1, total: 5, totalPages: 1 });
    expect(screen.getByText('Showing 1–5 of 5')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
    expect(previous()).toBeDisabled();
    expect(next()).toBeDisabled();
  });

  test('an exactly full page of 25 still counts as one page', () => {
    setup({ page: 1, total: 25, totalPages: 1 });
    expect(screen.getByText('Showing 1–25 of 25')).toBeInTheDocument();
    expect(next()).toBeDisabled();
  });
});

describe('other states', () => {
  test('renders nothing when there are no results', () => {
    setup({ page: 1, total: 0, totalPages: 0 });
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('disables both buttons while a page is loading', () => {
    setup({ page: 2, total: 60, totalPages: 3, disabled: true });
    expect(previous()).toBeDisabled();
    expect(next()).toBeDisabled();
  });

  test('formats large totals with separators', () => {
    setup({ page: 1, total: 12345, totalPages: 494 });
    expect(screen.getByText('Showing 1–25 of 12,345')).toBeInTheDocument();
  });
});
