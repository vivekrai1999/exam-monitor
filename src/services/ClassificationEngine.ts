// ---------------------------------------------------------------------------
// backend/exam-monitor/services/ClassificationEngine.ts
// Deterministic rule-based exam and notice-type classification engine
// ---------------------------------------------------------------------------

import type { ExamCategory, NoticeType } from '../types.ts';

export interface ClassificationResult {
  category: ExamCategory;
  noticeType: NoticeType;
  examName: string | null;
  confidence: number;
}

const CATEGORY_RULES: { category: ExamCategory; patterns: RegExp[]; examName: string }[] = [
  {
    category: 'RAS',
    patterns: [/\bras\b/i, /\brts\b/i, /rajasthan administrative services/i, /संयुक्त प्रतियोगी परीक्षा.*ras/i, /राज्य सेवा.*ras/i],
    examName: 'Rajasthan State and Subordinate Services Combined Comp. Exam (RAS/RTS)',
  },
  {
    category: 'SI',
    patterns: [/\bsi\b/i, /sub[-\s]?inspector/i, /उप निरीक्षक/i, /platoon commander/i],
    examName: 'Sub Inspector / Platoon Commander Exam',
  },
  {
    category: 'CET_GRADUATE',
    patterns: [/cet.*graduate/i, /समान पात्रता परीक्षा.*स्नातक/i, /common eligibility test.*graduate/i],
    examName: 'Common Eligibility Test (Graduate Level)',
  },
  {
    category: 'CET_SENIOR_SECONDARY',
    patterns: [/cet.*senior secondary/i, /समान पात्रता परीक्षा.*12वीं/i, /cet.*10\+2/i, /cet.*sr/i],
    examName: 'Common Eligibility Test (Senior Secondary Level)',
  },
  {
    category: 'LDC',
    patterns: [/\bldc\b/i, /clerk grade[-\s]?ii/i, /कनिष्ठ सहायक/i, /junior assistant/i],
    examName: 'LDC / Junior Assistant Exam',
  },
  {
    category: 'PATWAR',
    patterns: [/patwar/i, /पटवार/i],
    examName: 'Patwari Recruitment Exam',
  },
  {
    category: 'REET',
    patterns: [/reet/i, /रीट/i, /primary.*teacher/i, /तृतीय श्रेणी शिक्षक/i],
    examName: 'Rajasthan Eligibility Examination for Teachers (REET)',
  },
  {
    category: 'CONSTABLE',
    patterns: [/constable/i, /कांस्टेबल/i, /police constable/i],
    examName: 'Rajasthan Police Constable Recruitment',
  },
  {
    category: 'TEACHER',
    patterns: [/first grade teacher/i, /second grade teacher/i, /वरिष्ठ अध्यापक/i, /प्राध्यापक/i, /school lecturer/i],
    examName: 'School Lecturer / Senior Teacher Grade Exam',
  },
];

const NOTICE_TYPE_RULES: { type: NoticeType; patterns: RegExp[] }[] = [
  { type: 'admit_card', patterns: [/admit card/i, /pravesh patra/i, /प्रवेश पत्र/i, /hall ticket/i] },
  { type: 'answer_key', patterns: [/answer key/i, /model answer/i, /उत्तर कुंजी/i, /objection/i, /आपत्ति/i] },
  { type: 'exam_date', patterns: [/exam date/i, /time table/i, /schedule/i, /परीक्षा तिथि/i, /दिनांक/i, /postpone/i, /स्थगित/i] },
  { type: 'result', patterns: [/result/i, /marks/i, /cutoff/i, /cut-off/i, /परिणाम/i, /चयन सूची/i, /merit list/i] },
  { type: 'syllabus', patterns: [/syllabus/i, /scheme of exam/i, /पाठ्यक्रम/i] },
  { type: 'corrigendum', patterns: [/corrigendum/i, /amendment/i, /शुद्धि पत्र/i, /संशोधन/i] },
  { type: 'advertisement', patterns: [/advertisement/i, /vigyapti/i, /विज्ञप्ति/i, /notification no/i, /recruitment/i] },
  { type: 'press_note', patterns: [/press note/i, /प्रेस नोट/i, /press release/i] },
];

export class ClassificationEngine {
  classify(title: string, description?: string): ClassificationResult {
    const text = `${title} ${description || ''}`.toLowerCase();

    // 1. Determine Exam Category
    let detectedCategory: ExamCategory = 'OTHER';
    let detectedExamName: string | null = null;
    let categoryConfidence = 0.50;

    for (const rule of CATEGORY_RULES) {
      if (rule.patterns.some(regex => regex.test(text))) {
        detectedCategory = rule.category;
        detectedExamName = rule.examName;
        categoryConfidence = 0.95;
        break;
      }
    }

    // 2. Determine Notice Type
    let detectedType: NoticeType = 'general';
    let typeConfidence = 0.50;

    for (const rule of NOTICE_TYPE_RULES) {
      if (rule.patterns.some(regex => regex.test(text))) {
        detectedType = rule.type;
        typeConfidence = 0.95;
        break;
      }
    }

    const overallConfidence = Number(((categoryConfidence + typeConfidence) / 2).toFixed(2));

    return {
      category: detectedCategory,
      noticeType: detectedType,
      examName: detectedExamName,
      confidence: overallConfidence,
    };
  }
}
