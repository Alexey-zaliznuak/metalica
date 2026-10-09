import { parentPort, workerData } from 'worker_threads';
import { generateImagePreviews } from './image-preview';

void (async () => {
  try {
    const input = typeof workerData.input === 'string' ? workerData.input : Buffer.from(workerData.input);
    parentPort!.postMessage(await generateImagePreviews(input));
  } catch (error) {
    parentPort!.postMessage({ error: (error as Error).message });
  }
})();
