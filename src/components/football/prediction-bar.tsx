import { cn } from '@/lib/utils';
import type { Outcome } from '@/lib/types/football';

const OUTCOMES: readonly Outcome[] = ['home', 'draw', 'away'];

const SPOKEN: Record<Outcome, string> = {
  home: 'победа хозяев',
  draw: 'ничья',
  away: 'победа гостей',
};

const SEGMENT: Record<Outcome, string> = {
  home: 'bg-chart-home',
  draw: 'bg-chart-draw',
  away: 'bg-chart-away',
};

const ALIGN: Record<Outcome, string> = {
  home: 'justify-start',
  draw: 'justify-center',
  away: 'justify-end',
};

type PredictionBarProps = {
  /** Percentages that already add up to 100. */
  home: number;
  draw: number;
  away: number;
  /** Favorite selected from unrounded model probabilities. */
  favorite: Outcome;
  /** The actual result once the match is over: adds ✓ or ✗ to the favorite. */
  outcome?: Outcome;
  /** The match has started: the prediction is history, so the bar fades. */
  dimmed?: boolean;
  /** `sm` — the narrow mobile column: smaller text, no % sign. */
  size?: 'md' | 'sm';
  className?: string;
};

/** П1 / Х / П2: three numbers over a split bar, the most likely outcome in bold. */
export function PredictionBar({
  home,
  draw,
  away,
  favorite,
  outcome,
  dimmed = outcome !== undefined,
  size = 'md',
  className,
}: PredictionBarProps) {
  const values: Record<Outcome, number> = { home, draw, away };
  const verdict = outcome && (outcome === favorite ? 'hit' : 'miss');
  const title =
    verdict === 'hit'
      ? 'Модель угадала исход'
      : verdict === 'miss'
        ? 'Модель не угадала исход'
        : 'Прогноз до матча';
  const small = size === 'sm';

  return (
    <div
      title={title}
      className={cn('flex flex-col', small ? 'gap-0.75' : 'gap-1', className)}
    >
      <span className="sr-only">
        {`Прогноз: ${OUTCOMES.map((o) => `${SPOKEN[o]} ${values[o]}%`).join(', ')}. Фаворит — ${SPOKEN[favorite]}.`}
        {verdict && ` ${title}.`}
      </span>

      <div
        aria-hidden="true"
        // `leading-*` goes after the size: a later `text-*` resets line height.
        className={cn(
          'grid grid-cols-3',
          small ? 'text-micro' : 'text-caption',
          'leading-3.5',
        )}
      >
        {OUTCOMES.map((o) => (
          <span
            key={o}
            className={cn(
              'flex items-center',
              small ? 'gap-px' : 'gap-0.75',
              ALIGN[o],
              o === favorite
                ? 'font-semibold text-foreground'
                : 'font-normal text-muted-foreground',
            )}
          >
            {small ? values[o] : `${values[o]}%`}
            {o === favorite && verdict && (
              <VerdictMark verdict={verdict} small={small} />
            )}
          </span>
        ))}
      </div>

      <div
        aria-hidden="true"
        className={cn(
          'flex h-1 overflow-hidden rounded-[2px]',
          small ? 'gap-px' : 'gap-0.5',
          dimmed && 'opacity-45',
        )}
      >
        {OUTCOMES.filter((o) => values[o] > 0).map((o) => (
          <span key={o} className={SEGMENT[o]} style={{ flexGrow: values[o] }} />
        ))}
      </div>
    </div>
  );
}

function VerdictMark({
  verdict,
  small,
}: {
  verdict: 'hit' | 'miss';
  small: boolean;
}) {
  const size = small ? 9 : 12;
  return (
    <svg
      data-verdict={verdict}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      strokeWidth={small ? 2.75 : 2.25}
      className={cn('shrink-0', verdict === 'hit' ? 'stroke-win' : 'stroke-loss')}
    >
      <path
        d={verdict === 'hit' ? 'M3 8.5l3.25 3.25L13 4.5' : 'M4 4l8 8M12 4l-8 8'}
      />
    </svg>
  );
}
