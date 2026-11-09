import { describe, expect, it } from 'vitest';

import { getCompetitionSeasonConfig } from './competition-seasons';

describe('competition season configuration', () => {
  it('switches the Champions League format and table zones in 2024/25', () => {
    expect(getCompetitionSeasonConfig('CL', 2023)).toMatchObject({
      format: 'groups',
      mainStage: 'GROUP_STAGE',
      teamCount: 32,
      matchdays: 6,
      zones: [
        { from: 1, to: 2, zone: 'ucl' },
        { from: 3, to: 3, zone: 'uel' },
        { from: 4, to: 4, zone: 'releg' },
      ],
    });
    for (const season of [2024, 2025, 2026]) {
      expect(getCompetitionSeasonConfig('CL', season)).toMatchObject({
        format: 'league-phase',
        mainStage: 'LEAGUE_STAGE',
        teamCount: 36,
        matchdays: 8,
        zones: [
          { from: 1, to: 8, zone: 'ucl' },
          { from: 9, to: 24, zone: 'uel' },
          { from: 25, to: 36, zone: 'releg' },
        ],
      });
    }
  });

  it('leaves unconfigured seasons unknown', () => {
    expect(getCompetitionSeasonConfig('CL', 2022)).toBeUndefined();
    expect(getCompetitionSeasonConfig('CL', 2027)).toBeUndefined();
  });
});
