import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JD_IMAGE_OCR_LANGUAGES, performJdImageOcr } from '../src/ocr/jdImageOcr';

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

check('adapter exports OCR function', typeof performJdImageOcr === 'function');
check('adapter uses simplified Chinese + English', JD_IMAGE_OCR_LANGUAGES === 'chi_sim+eng');

const adapterSource = readFileSync(resolve('src/ocr/jdImageOcr.ts'), 'utf8');
check('adapter lazy-loads tesseract.js', adapterSource.includes("await import('tesseract.js')"));
check('adapter does not use macOS-only Vision OCR', !adapterSource.includes('Vision'));
check('adapter does not use Windows-only OCR', !adapterSource.includes('Windows.Media.Ocr'));
check('adapter does not call AI APIs', !adapterSource.includes('openai') && !adapterSource.includes('anthropic'));

section('Summary');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
