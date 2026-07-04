export const JD_IMAGE_OCR_LANGUAGES = 'chi_sim+eng';
export const JD_IMAGE_OCR_OEM_LSTM_ONLY = 1;

type TesseractModule = typeof import('tesseract.js');
type TesseractWorker = Awaited<ReturnType<TesseractModule['createWorker']>>;

function formatOcrError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`OCR failed: ${message}`);
}

export async function performJdImageOcr(file: File): Promise<string> {
  let worker: TesseractWorker | null = null;
  try {
    const { createWorker } = await import('tesseract.js');
    worker = await createWorker(JD_IMAGE_OCR_LANGUAGES, JD_IMAGE_OCR_OEM_LSTM_ONLY);
    const result = await worker.recognize(file);
    return result.data.text.trim();
  } catch (error) {
    throw formatOcrError(error);
  } finally {
    if (worker !== null) {
      await worker.terminate().catch(() => undefined);
    }
  }
}
