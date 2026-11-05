import { runTeamsCommand } from '../src/server/sync/teams-command';

void runTeamsCommand(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
