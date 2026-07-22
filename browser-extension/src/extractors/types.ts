export interface ExtractedRecognizedFields {
  company: string | null;
  role: string | null;
  city: string | null;
  salaryMinK: number | null;
  salaryMaxK: number | null;
  salaryPeriod: string | null;
  experienceRequirement: string | null;
  educationRequirement: string | null;
}

export interface ExtractedPage {
  pageTitle: string | null;
  visibleText: string;
  recognizedFields: ExtractedRecognizedFields | null;
}

export const EMPTY_RECOGNIZED_FIELDS: ExtractedRecognizedFields = {
  company: null,
  role: null,
  city: null,
  salaryMinK: null,
  salaryMaxK: null,
  salaryPeriod: null,
  experienceRequirement: null,
  educationRequirement: null,
};
