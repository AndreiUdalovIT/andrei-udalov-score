import { describe, expect, it } from 'vitest';

import { getCompetitionSeasonConfig } from './competition-seasons';

describe('competition season configuration', () => {
  it('switches the Champions League main-stage format in 2024/25', () => {
    expect(getCompetitionSeasonConfig('CL', 2023)).toMatchObject({
      format: 'groups',
      teamCount: 32,
      matchdays: 6,
    });
    expect(getCompetitionSeasonConfig('CL', 2024)).toMatchObject({
      format: 'league-phase',
      teamCount: 36,
      matchdays: 8,
    });
  });

  it('leaves unconfigured seasons unknown', () => {
    expect(getCompetitionSeasonConfig('CL', 2022)).toBeUndefined();
    expect(getCompetitionSeasonConfig('CL', 2027)).toBeUndefined();
  });
});
