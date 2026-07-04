import {
  JD_IMAGE_OCR_ENGINE_NOT_CONFIGURED,
  JdImageOcrNotConfiguredError,
  performJdImageOcr,
} from '../src/ocr/jdImageOcr';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

section('JD image OCR adapter');

try {
  await performJdImageOcr({ name: 'boss-jd.png' } as File);
  check('placeholder adapter does not silently succeed', false);
} catch (error) {
  check('placeholder adapter throws configured error class', error instanceof JdImageOcrNotConfiguredError);
  check(
    'placeholder adapter reports explicit engine message',
    (error as Error).message === JD_IMAGE_OCR_ENGINE_NOT_CONFIGURED,
  );
}

section('Summary');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
