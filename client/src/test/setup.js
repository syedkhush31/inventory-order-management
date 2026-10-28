import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// Each test starts at the root URL, because jsdom keeps the address between tests.
afterEach(() => window.history.replaceState(null, '', '/'));
