// The small error boundary around one Activity row.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ActivityRowBoundary from './ActivityRowBoundary.jsx';

function Thrower({ message = 'boom' }) {
  throw new Error(message);
}

let errorSpy;
let logSpy;
let warnSpy;

beforeEach(() => {
  // React reports a caught render error to console.error; keep the test output quiet and inspect it instead.
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const wrap = (ui) => render(<ol><li>{ui}</li></ol>);

describe('ActivityRowBoundary', () => {
  test('shows its children when nothing goes wrong', () => {
    wrap(
      <ActivityRowBoundary event={{ type: 'ORDER_CREATED' }}>
        <span>all good</span>
      </ActivityRowBoundary>
    );
    expect(screen.getByText('all good')).toBeInTheDocument();
    expect(screen.queryByText('This event could not be displayed.')).not.toBeInTheDocument();
  });

  test('replaces a row that throws with a short notice and the event type', () => {
    wrap(
      <ActivityRowBoundary event={{ type: 'ORDER_CREATED' }}>
        <Thrower />
      </ActivityRowBoundary>
    );
    expect(screen.getByText('This event could not be displayed.')).toBeInTheDocument();
    expect(screen.getByText('Event type: ORDER_CREATED')).toBeInTheDocument();
  });

  test('copes when the event itself is missing or has no usable type', () => {
    for (const event of [undefined, null, {}, { type: 7 }, 'text']) {
      const { unmount } = wrap(
        <ActivityRowBoundary event={event}>
          <Thrower />
        </ActivityRowBoundary>
      );
      expect(screen.getByText('This event could not be displayed.')).toBeInTheDocument();
      expect(screen.queryByText(/Event type:/)).not.toBeInTheDocument();
      unmount();
    }
  });

  test('a very long type code is cut short', () => {
    wrap(
      <ActivityRowBoundary event={{ type: 'X'.repeat(500) }}>
        <Thrower />
      </ActivityRowBoundary>
    );
    expect(screen.getByText(`Event type: ${'X'.repeat(60)}`)).toBeInTheDocument();
  });

  test('tries again when it is given a new event (for example after a reload)', () => {
    const first = { type: 'ORDER_CREATED' };
    const { rerender } = wrap(
      <ActivityRowBoundary event={first}>
        <Thrower />
      </ActivityRowBoundary>
    );
    expect(screen.getByText('This event could not be displayed.')).toBeInTheDocument();
    const second = { type: 'ORDER_CREATED' };
    rerender(
      <ol>
        <li>
          <ActivityRowBoundary event={second}>
            <span>recovered</span>
          </ActivityRowBoundary>
        </li>
      </ol>
    );
    expect(screen.getByText('recovered')).toBeInTheDocument();
    expect(screen.queryByText('This event could not be displayed.')).not.toBeInTheDocument();
  });

  test('stays on the notice while the same event is shown again', () => {
    const same = { type: 'ORDER_CREATED' };
    const { rerender } = wrap(
      <ActivityRowBoundary event={same}>
        <Thrower />
      </ActivityRowBoundary>
    );
    rerender(
      <ol>
        <li>
          <ActivityRowBoundary event={same}>
            <Thrower />
          </ActivityRowBoundary>
        </li>
      </ol>
    );
    expect(screen.getByText('This event could not be displayed.')).toBeInTheDocument();
  });

  test('does not write the event, or what it contains, to the console', () => {
    const event = { type: 'ORDER_CREATED', details: { customerName: 'Ann Lee' }, actor: { email: 'ann@example.com' } };
    wrap(
      <ActivityRowBoundary event={event}>
        <Thrower message="render failed" />
      </ActivityRowBoundary>
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    const everything = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(everything).not.toMatch(/Ann Lee|ann@example/);
  });

  test('does not show the error message to the user', () => {
    wrap(
      <ActivityRowBoundary event={{ type: 'ORDER_CREATED' }}>
        <Thrower message="secret internal detail" />
      </ActivityRowBoundary>
    );
    expect(document.body.textContent).not.toMatch(/secret internal detail/);
  });
});
