// Vitest global setup — runs before every test file.
// Adds jest-dom matchers (toBeInTheDocument, toHaveClass, ...) and
// clears the DOM between tests.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
