import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Legend from './Legend';

describe('Legend', () => {
  it('renders the title and all three exposure classes', () => {
    render(<Legend />);
    expect(screen.getByText('LEGEND')).toBeInTheDocument();
    expect(screen.getByText('HIGH EXPOSURE')).toBeInTheDocument();
    expect(screen.getByText('MEDIUM EXPOSURE')).toBeInTheDocument();
    expect(screen.getByText('LOW EXPOSURE')).toBeInTheDocument();
  });

  it('collapses and expands the items when the header is clicked', async () => {
    const user = userEvent.setup();
    render(<Legend />);

    // Expanded by default — items visible.
    expect(screen.getByText('HIGH EXPOSURE')).toBeInTheDocument();

    // Click the header to collapse.
    await user.click(screen.getByText('LEGEND'));
    expect(screen.queryByText('HIGH EXPOSURE')).not.toBeInTheDocument();

    // Click again to expand.
    await user.click(screen.getByText('LEGEND'));
    expect(screen.getByText('HIGH EXPOSURE')).toBeInTheDocument();
  });
});
