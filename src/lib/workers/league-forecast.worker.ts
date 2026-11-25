import { expose } from 'comlink';

import { createLeagueForecastWorkerApi } from './league-forecast-api';

expose(createLeagueForecastWorkerApi());
