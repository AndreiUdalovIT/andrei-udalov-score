import { runSeedCommand } from '../src/server/sync/seed-command';

void runSeedCommand(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
