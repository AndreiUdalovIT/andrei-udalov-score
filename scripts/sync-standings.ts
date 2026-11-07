import { runStandingsCommand } from '../src/server/sync/standings-command';

void runStandingsCommand(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
