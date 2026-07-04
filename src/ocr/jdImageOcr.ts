export const JD_IMAGE_OCR_ENGINE_NOT_CONFIGURED = 'OCR engine not configured';

export class JdImageOcrNotConfiguredError extends Error {
  constructor() {
    super(JD_IMAGE_OCR_ENGINE_NOT_CONFIGURED);
    this.name = 'JdImageOcrNotConfiguredError';
  }
}

export async function performJdImageOcr(_file: File): Promise<string> {
  throw new JdImageOcrNotConfiguredError();
}
