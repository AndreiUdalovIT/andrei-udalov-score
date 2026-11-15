import type { Outcome } from '@/lib/types/football';

const OUTCOMES = ['home', 'draw', 'away'] as const;

/**
 * Normalize outcome probabilities and apportion whole percentages totalling
 * 100. Equal remainders follow home, draw, away order.
 */
export function roundOutcomePercentages(
  probabilities: Readonly<Record<Outcome, number>>,
): Record<Outcome, number> {
  const entries = OUTCOMES.map((outcome, index) => ({
    outcome,
    index,
    value: probabilities[outcome],
  }));
  if (
    entries.some(({ value }) => !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new RangeError(
      'outcome probabilities must be finite and between zero and one',
    );
  }
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  if (total === 0) {
    throw new RangeError('at least one outcome probability must be positive');
  }

  const percentages: Record<Outcome, number> = { home: 0, draw: 0, away: 0 };
  const remainders = entries.map(({ outcome, index, value }) => {
    const quota = (value / total) * 100;
    percentages[outcome] = Math.floor(quota);
    return { outcome, index, remainder: quota - percentages[outcome] };
  });
  remainders.sort(
    (left, right) => right.remainder - left.remainder || left.index - right.index,
  );
  const remaining = 100 - percentages.home - percentages.draw - percentages.away;
  for (const entry of remainders.slice(0, remaining)) {
    percentages[entry.outcome] += 1;
  }
  return percentages;
}
