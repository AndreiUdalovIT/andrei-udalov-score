import { runMatchesCommand } from '../src/server/sync/matches-command';

void runMatchesCommand(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
