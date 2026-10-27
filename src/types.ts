// ---------------------------------------------------------------------------
// backend/exam-monitor/types.ts
// Domain Types & Contracts for Rajasthan Exam Notification Monitoring System
// ---------------------------------------------------------------------------

export type NoticeType =
  | 'advertisement'
  | 'exam_date'
  | 'admit_card'
  | 'answer_key'
  | 'result'
  | 'syllabus'
  | 'corrigendum'
  | 'press_note'
  | 'general';

export type ExamCategory =
  | 'RAS'
  | 'SI'
  | 'CET_GRADUATE'
  | 'CET_SENIOR_SECONDARY'
  | 'LDC'
  | 'REET'
  | 'PATWAR'
  | 'CONSTABLE'
  | 'TEACHER'
  | 'OTHER';

export interface RawAttachment {
  url: string;
  label: string;
  fileType: 'pdf' | 'doc' | 'zip' | 'link';
  sizeBytes?: number;
}

export interface RawNoticeItem {
  sourceNoticeId: string;
  canonicalUrl: string;
  title: string;
  publicationDate: string | null; // ISO YYYY-MM-DD or null
  description?: string;
  attachments: RawAttachment[];
  rawHtmlSnippet?: string;
}

export interface FetchResult {
  html: string;
  httpStatus: number;
  responseHeaders: Record<string, string>;
  fetchedAt: Date;
}

export interface SourceAdapter {
  readonly sourceId: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly monitoredUrl: string;

  fetchPage(timeoutMs?: number): Promise<FetchResult>;
  validateResponse(result: FetchResult): boolean;
  parseNotices(html: string): Promise<RawNoticeItem[]>;
  normalizeNotice(raw: RawNoticeItem): RawNoticeItem;
}

export interface ExamNotice {
  id: string; // UUID
  sourceId: string;
  sourceNoticeId: string;
  canonicalUrl: string;
  title: string;
  publicationDate: string | null;
  firstDetectedAt: Date;
  lastObservedAt: Date;
  lastModifiedAt?: Date;
  noticeType: NoticeType;
  examCategory: ExamCategory;
  examName: string | null;
  description?: string;
  attachments: RawAttachment[];
  contentFingerprint: string;
  isActive: boolean;
  status: 'published' | 'updated' | 'withdrawn' | 'archived';
  classificationConfidence: number;
  rawMetadata: Record<string, unknown>;
}

export interface TelegramChannelConfig {
  id: string;
  name: string;
  chat_id: string;
  is_enabled: boolean;
  filter_source_ids: string[] | null;
  filter_categories: string[] | null;
  filter_notice_types: string[] | null;
  message_template: string | null;
  parse_mode: 'HTML' | 'MarkdownV2';
  disable_web_page_preview: boolean;
  rate_limit_seconds: number;
  last_posted_at: string | null;
}

export interface OutboxJob {
  id: string;
  notice_id: string;
  destination_type: 'fcm_topic' | 'fcm_token' | 'telegram_channel';
  destination_target: string;
  idempotency_key: string;
  title: string;
  body: string;
  payload: Record<string, any>;
  status: 'pending' | 'processing' | 'delivered' | 'failed' | 'skipped';
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  delivered_at: string | null;
  provider_message_id: string | null;
  last_error: string | null;
}

export interface GeminiEnrichmentResult {
  exam_name: string | null;
  exam_category: ExamCategory;
  notice_type: NoticeType;
  summary_hi: string | null;
  summary_en: string | null;
  key_points: string[];
  important_dates: {
    exam_date: string | null;
    application_deadline: string | null;
    objection_deadline: string | null;
  };
  vacancies_count: number | null;
  confidence_score: number;
}
