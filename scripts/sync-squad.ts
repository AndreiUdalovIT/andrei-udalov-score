import { runSquadCommand } from '../src/server/sync/squad-command';

void runSquadCommand(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
