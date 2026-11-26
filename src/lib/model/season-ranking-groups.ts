export type SeasonRankingEntry = {
  readonly teamId: number;
  /** Criterion values in priority order, with larger values ranked higher. */
  readonly criteria: readonly (number | null)[];
};

export type SeasonRankingGroup = {
  from: number;
  to: number;
  /** Canonical display order within this group. */
  teamIds: number[];
  reason: 'resolved' | 'equal-criteria' | 'missing-criterion';
  /** Zero-based priority index when a comparison needs additional data. */
  missingCriterion: number | null;
};

type WorkingGroup = {
  entries: SeasonRankingEntry[];
  missingCriterion: number | null;
};

/**
 * Group possible positions using the caller's ordered ranking criteria.
 * Entries supply equally sized non-empty criterion sequences in the same
 * priority order, with unique positive team IDs.
 * Encode a lower-is-better criterion by negating its supplied values.
 * A null value stops refinement of its tied group at that criterion.
 * Later criteria are applied after equality on each earlier criterion.
 * Equal entries share an inclusive position range, ready for further rules.
 * Return fresh groups and member arrays in canonical order.
 */
export function groupSeasonRankings(
  entries: readonly SeasonRankingEntry[],
): SeasonRankingGroup[] {
  if (entries.length === 0) return [];
  const criterionCount = entries[0]!.criteria.length;
  const seen = new Set<number>();
  const copied = Array.from(entries, (entry) => {
    if (
      !Number.isSafeInteger(entry.teamId) ||
      entry.teamId <= 0 ||
      seen.has(entry.teamId)
    ) {
      throw new RangeError('ranking team IDs must be unique positive safe integers');
    }
    seen.add(entry.teamId);
    const criteria = Array.from(entry.criteria);
    if (
      criterionCount === 0 ||
      criteria.length !== criterionCount ||
      criteria.some((value) => value !== null && !Number.isFinite(value))
    ) {
      throw new RangeError(
        'ranking entries require equally sized non-empty finite or null criteria',
      );
    }
    return { teamId: entry.teamId, criteria };
  });
  copied.sort((left, right) => left.teamId - right.teamId);

  let groups: WorkingGroup[] = [{ entries: copied, missingCriterion: null }];
  for (let index = 0; index < criterionCount; index += 1) {
    groups = groups.flatMap((group) => {
      if (group.entries.length === 1 || group.missingCriterion !== null) {
        return [group];
      }
      if (group.entries.some((entry) => entry.criteria[index] === null)) {
        return [{ entries: group.entries, missingCriterion: index }];
      }

      const sorted = [...group.entries].sort((left, right) => {
        const leftValue = left.criteria[index]!;
        const rightValue = right.criteria[index]!;
        if (leftValue === rightValue) return left.teamId - right.teamId;
        return leftValue > rightValue ? -1 : 1;
      });
      const partitions: WorkingGroup[] = [];
      for (const entry of sorted) {
        const last = partitions[partitions.length - 1];
        if (
          last === undefined ||
          last.entries[0]!.criteria[index] !== entry.criteria[index]
        ) {
          partitions.push({ entries: [entry], missingCriterion: null });
        } else {
          last.entries.push(entry);
        }
      }
      return partitions;
    });
    if (
      groups.every(
        (group) => group.entries.length === 1 || group.missingCriterion !== null,
      )
    ) {
      break;
    }
  }

  let position = 1;
  return groups.map((group) => {
    const from = position;
    const to = from + group.entries.length - 1;
    position = to + 1;
    let reason: SeasonRankingGroup['reason'] = 'equal-criteria';
    if (group.entries.length === 1) reason = 'resolved';
    if (group.missingCriterion !== null) reason = 'missing-criterion';
    return {
      from,
      to,
      teamIds: group.entries.map((entry) => entry.teamId),
      reason,
      missingCriterion: group.missingCriterion,
    };
  });
}
