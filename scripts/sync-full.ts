import { runFullCommand } from '../src/server/sync/full-command';

void runFullCommand(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
