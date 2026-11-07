import { runScorersCommand } from '../src/server/sync/scorers-command';

void runScorersCommand(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
