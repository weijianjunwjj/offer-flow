import type { MessageScenario } from '../decision';
import type { JobRecord } from '../storage';

const FORBIDDEN_PLACEHOLDERS = /\b(undefined|null|NaN)\b/g;

function cleanText(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(FORBIDDEN_PLACEHOLDERS, '').replace(/\s+/g, ' ').trim();
}

function shortText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function firstValue(values: readonly unknown[], fallback: string, maxLength = 28): string {
  const value = values.map(cleanText).find((item) => item !== '') ?? fallback;
  return shortText(value, maxLength);
}

function context(record: JobRecord): {
  company: string;
  role: string;
  salary: string;
  matchPoint: string;
  valuePoint: string;
} {
  const report = record.report;
  const opportunity = record.opportunityAnalysis;
  const companyInput = record.companyInput;

  return {
    company: firstValue([record.company], '贵司', 18),
    role: firstValue([record.role], '这个岗位', 24),
    salary: firstValue([record.salaryRange], '薪资和发展空间', 18),
    matchPoint: firstValue(
      [
        report?.techStackMatch,
        report?.projectMatch,
        report?.keywords,
        opportunity?.decisionSummary,
        record.jdText,
      ],
      '相关项目经验',
      30,
    ),
    valuePoint: firstValue(
      [
        companyInput.opportunityNote,
        opportunity?.decisionSummary,
        report?.strengths,
        report?.projectMatch,
      ],
      '岗位方向',
      30,
    ),
  };
}

export function buildMessageTemplate(
  scenario: MessageScenario,
  record: JobRecord,
): string {
  const { company, role, salary, matchPoint, valuePoint } = context(record);

  switch (scenario) {
    case 'first_greeting':
      return `你好，我看到${company}的${role}，和我在${matchPoint}上的经验比较接近。方便的话我可以先发简历，看看是否值得进一步沟通。`;

    case 'second_followup':
      return `你好，我补充跟进一下${role}。我这边主要匹配${matchPoint}，如果岗位还在推进，方便时可以看一下我的简历。`;

    case 'final_unread_followup':
      return `你好，这条我最后跟进一次。${role}如果暂时不合适也没关系，我就不重复打扰了。后续有更匹配的方向也欢迎再联系。`;

    case 'high_salary_low_match_probe':
      return `你好，我关注到${role}的${salary}和${valuePoint}比较有吸引力。虽然不一定完全匹配，但可以先低成本聊 10 分钟，看看是否值得继续。`;

    case 'premium_but_cold_closing':
      return `你好，这个岗位我就先收口了。${company}的${role}我仍然认可，如果现在节奏不合适没关系，后续有合适机会再沟通。`;

    case 'hr_reply_bridge':
      return `你好，收到。为了方便判断，我可以先发简历。也想确认下${role}目前更看重${matchPoint}，以及后续沟通流程。`;

    default: {
      const exhaustive: never = scenario;
      return exhaustive;
    }
  }
}
