import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { calculateMatchProbabilities } from '@/lib/model/match-probabilities';

import { PredictionBar } from './prediction-bar';

const verdictMark = (container: HTMLElement) =>
  container.querySelector('[data-verdict]');

describe('PredictionBar', () => {
  it('makes the most likely outcome bold and the others muted', () => {
    render(<PredictionBar favorite="home" home={46} draw={25} away={29} />);
    expect(screen.getByText('46%')).toHaveClass('font-semibold');
    expect(screen.getByText('25%')).toHaveClass('text-muted-foreground');
    expect(screen.getByText('29%')).toHaveClass('text-muted-foreground');
  });

  it('reads all three numbers as one phrase', () => {
    render(<PredictionBar favorite="home" home={46} draw={25} away={29} />);
    expect(
      screen.getByText(
        'Прогноз: победа хозяев 46%, ничья 25%, победа гостей 29%. Фаворит — победа хозяев.',
      ),
    ).toHaveClass('sr-only');
  });

  it('before the match: no verdict and a full-strength bar', () => {
    const { container } = render(
      <PredictionBar favorite="home" home={46} draw={25} away={29} />,
    );
    expect(verdictMark(container)).toBeNull();
    expect(screen.getByTitle('Прогноз до матча')).toBeInTheDocument();
    expect(container.querySelector('.opacity-45')).toBeNull();
  });

  it('marks a correct prediction with ✓ next to the favorite and fades the bar', () => {
    const { container } = render(
      <PredictionBar favorite="home" home={46} draw={25} away={29} outcome="home" />,
    );
    const mark = verdictMark(container);
    expect(mark).toHaveAttribute('data-verdict', 'hit');
    expect(screen.getByText('46%')).toContainElement(mark as HTMLElement);
    expect(screen.getByText(/Модель угадала исход/)).toHaveClass('sr-only');
    expect(container.querySelector('.opacity-45')).not.toBeNull();
  });

  it('marks a wrong prediction with ✗, still next to the favorite', () => {
    const { container } = render(
      <PredictionBar favorite="home" home={46} draw={25} away={29} outcome="away" />,
    );
    expect(verdictMark(container)).toHaveAttribute('data-verdict', 'miss');
    expect(screen.getByText('46%')).toContainElement(
      verdictMark(container) as HTMLElement,
    );
    expect(screen.getByTitle('Модель не угадала исход')).toBeInTheDocument();
  });

  it('highlights the supplied favorite when displayed percentages tie', () => {
    render(<PredictionBar favorite="away" home={35} draw={30} away={35} />);
    expect(screen.getAllByText('35%')[0]).toHaveClass('font-normal');
    expect(screen.getAllByText('35%')[1]).toHaveClass('font-semibold');
  });

  it('drops the % sign in the narrow mobile size', () => {
    render(
      <PredictionBar favorite="home" home={46} draw={25} away={29} size="sm" />,
    );
    expect(screen.getByText('46')).toBeInTheDocument();
    expect(screen.queryByText('46%')).toBeNull();
  });

  it('uses the raw model favorite for tied labels and post-match verdicts', () => {
    const prediction = calculateMatchProbabilities(1.5, 1.501, {
      tailTolerance: 1e-14,
      maxGoals: 64,
    })!;
    expect(prediction.percentages.home).toBe(prediction.percentages.away);
    expect(prediction.outcomes.away).toBeGreaterThan(prediction.outcomes.home);

    const props = { ...prediction.percentages, favorite: prediction.favorite };
    const { container, rerender } = render(
      <PredictionBar {...props} outcome="away" />,
    );
    const label = `${prediction.percentages.home}%`;
    const labels = screen.getAllByText(label);
    expect(labels[0]).toHaveClass('font-normal');
    expect(labels[1]).toHaveClass('font-semibold');
    expect(verdictMark(container)).toHaveAttribute('data-verdict', 'hit');
    expect(labels[1]).toContainElement(verdictMark(container) as HTMLElement);
    expect(screen.getByText(/Фаворит — победа гостей/)).toHaveClass('sr-only');

    rerender(<PredictionBar {...props} outcome="home" />);
    expect(verdictMark(container)).toHaveAttribute('data-verdict', 'miss');
    expect(screen.getAllByText(label)[1]).toContainElement(
      verdictMark(container) as HTMLElement,
    );
  });
});
