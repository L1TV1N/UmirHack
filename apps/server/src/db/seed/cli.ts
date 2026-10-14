import { loadEnvFile, parseConfig } from '../../config';
import { seed } from './run';

loadEnvFile();
const config = parseConfig();
const reset = process.argv.includes('--reset');

seed(config, { reset, platform: !process.argv.includes('--no-platform'), log: (m) => console.log(m) })
  .then((r) => {
    console.log(`Готово: документов ${r.documents}, партий ${r.batches}, движений ${r.movements}`);
    console.log('Учётные записи демо-стенда перечислены в README');
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
