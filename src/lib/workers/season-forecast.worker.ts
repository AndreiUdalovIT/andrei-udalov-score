import { expose } from 'comlink';

import { createSeasonForecastWorkerApi } from './season-forecast-api';

expose(createSeasonForecastWorkerApi());
