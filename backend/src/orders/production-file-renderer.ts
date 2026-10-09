import { Worker } from 'worker_threads';
import { join } from 'path';
import { productionOrderData } from './production-order-data';

export type ProductionParameters = ReturnType<typeof productionOrderData.context>;

export function renderProductionFile(input: string, destination: string, parameters: ProductionParameters, textSize: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let responded = false;
    const worker = new Worker(join(__dirname, 'production-file.worker.js'), {
      workerData: { input, destination, parameters, textSize },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const timer = setTimeout(() => {
      responded = true;
      void worker.terminate().then(() => reject(new Error('Подготовка файла превысила допустимое время')), reject);
    }, 120_000);
    worker.once('message', (message) => {
      responded = true;
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error));
      else resolve();
    });
    worker.once('error', (error) => { clearTimeout(timer); reject(error); });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (!responded) reject(new Error(`Обработчик производства завершился без результата (код ${code})`));
    });
  });
}
