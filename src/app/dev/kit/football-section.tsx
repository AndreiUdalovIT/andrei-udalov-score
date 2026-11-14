import { LocalTime } from '@/components/common/local-time';
import { MatchStatus } from '@/components/football/match-status';
import { PredictionBar } from '@/components/football/prediction-bar';
import { ResultBadge } from '@/components/football/result-badge';
import { TeamLogo } from '@/components/football/team-logo';
import { ZoneBadge } from '@/components/football/zone-badge';
import { MATCH_STATUSES } from '@/lib/types/football';

import { Demo, Section } from './section';

const KICKOFF = '2026-10-24T16:30:00Z';
const SYNCED_AT = '2026-10-24T14:20:00Z';

const NOTES: Partial<Record<(typeof MATCH_STATUSES)[number], React.ReactNode>> = {
  IN_PLAY: (
    <>
      на{' '}
      <LocalTime
        value={SYNCED_AT}
        options={{ hour: '2-digit', minute: '2-digit' }}
      />
    </>
  ),
  SUSPENDED: "62'",
  POSTPONED: '4 ноя',
};

const LOGOS = [
  { label: 'PNG', src: 'https://crests.football-data.org/57.png' },
  { label: 'SVG', src: 'https://crests.football-data.org/86.svg' },
  { label: 'Ошибка', src: 'https://crests.football-data.org/999999.png' },
  { label: 'Нет логотипа', src: null },
] as const;

export function FootballSection() {
  return (
    <Section
      title="Футбольные компоненты"
      note="Время — в часовом поясе браузера; сервер рисует своё, скрипт исправляет до отрисовки."
    >
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Demo label="ResultBadge · В / Н / П">
          <ResultBadge result="W" />
          <ResultBadge result="D" />
          <ResultBadge result="L" />
        </Demo>

        <Demo label="ZoneBadge">
          <ZoneBadge zone="ucl" label="ЛЧ" />
          <ZoneBadge zone="uel" label="ЛЕ" />
          <ZoneBadge zone="uecl" label="ЛК" />
          <ZoneBadge zone="playoff" label="Стыки" />
          <ZoneBadge zone="releg" label="Вылет" />
        </Demo>

        <div className="flex flex-col gap-2 lg:col-span-2">
          <span className="text-caption text-muted-foreground">
            MatchStatus · все статусы API, обычный и узкий (мобильный) вид
          </span>
          <div
            className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3
              lg:grid-cols-6"
          >
            {MATCH_STATUSES.map((status) => (
              <div key={status} className="flex flex-col gap-1.5">
                <span className="font-mono text-[10px] text-subtle-foreground">
                  {status}
                </span>
                <MatchStatus
                  status={status}
                  kickoff={KICKOFF}
                  note={NOTES[status]}
                />
                <MatchStatus
                  status={status}
                  kickoff={KICKOFF}
                  note={NOTES[status]}
                  compact
                />
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 lg:col-span-2">
          <span className="text-caption text-muted-foreground">
            PredictionBar · до матча, угадала, ошиблась, идёт матч, мобильный размер
          </span>
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
            <PredictionBar
              home={46}
              draw={25}
              away={29}
              favorite="home"
              className="w-full max-w-42"
            />
            <PredictionBar
              home={45}
              draw={31}
              away={24}
              favorite="home"
              outcome="home"
              className="w-full max-w-42"
            />
            <PredictionBar
              home={44}
              draw={26}
              away={30}
              favorite="home"
              outcome="draw"
              className="w-full max-w-42"
            />
            <PredictionBar
              home={38}
              draw={27}
              away={35}
              favorite="home"
              dimmed
              className="w-full max-w-42"
            />
            <PredictionBar
              home={46}
              draw={25}
              away={29}
              favorite="home"
              outcome="home"
              size="sm"
              className="w-full max-w-21"
            />
          </div>
        </div>

        <div className="flex flex-col gap-3 lg:col-span-2">
          <span className="text-caption text-muted-foreground">
            TeamLogo · 20 / 24 / 28 / 40
          </span>
          {LOGOS.map((logo) => (
            <div key={logo.label} className="flex items-center gap-4">
              {([20, 24, 28, 40] as const).map((size) => (
                <TeamLogo
                  key={size}
                  src={logo.src}
                  name="Arsenal"
                  tla="ARS"
                  size={size}
                />
              ))}
              <span className="text-caption text-muted-foreground">
                {logo.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
