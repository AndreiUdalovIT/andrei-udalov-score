import { runLightCommand } from '../src/server/sync/light-command';

void runLightCommand(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
