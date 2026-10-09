import { parentPort, workerData } from 'worker_threads';
import { productionImage, productionTextScale } from './production-image';

void (async () => {
  try {
    const { input, destination, parameters, textSize } = workerData;
    const label = parameters.photoNumber ? `${parameters.orderNumber}-${parameters.photoNumber}` : parameters.orderNumber;
    const image = await productionImage(input, label, parameters.articles,
      parameters.comment, productionTextScale(textSize), parameters.deliveryService);
    await image.toFile(destination);
    parentPort!.postMessage({ ready: true });
  } catch (error) {
    parentPort!.postMessage({ error: (error as Error).message });
  }
})();
