// ---------------------------------------------------------------------------
// backend/exam-monitor/services/IngestionCoordinator.ts
// Central Ingestion Coordinator: Manages baseline onboarding, deduplication,
// atomic persistence, change diffs, and multi-channel outbox enqueueing.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import type { SourceAdapter, RawNoticeItem, ExamNotice, TelegramChannelConfig } from '../types.ts';
import { ClassificationEngine } from './ClassificationEngine.ts';
import { GeminiEnrichmentService } from './GeminiEnrichmentService.ts';
import { TelegramTemplateFormatter } from './TelegramTemplateFormatter.ts';

export interface IngestionRunResult {
  sourceId: string;
  status: 'success' | 'failed' | 'locked';
  itemsScanned: number;
  newItemsCount: number;
  updatedItemsCount: number;
  durationMs: number;
  errorMessage?: string;
}

export class IngestionCoordinator {
  private supabase: SupabaseClient;
  private classificationEngine: ClassificationEngine;
  private telegramFormatter: TelegramTemplateFormatter;
  private geminiService: GeminiEnrichmentService;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
    this.classificationEngine = new ClassificationEngine();
    this.telegramFormatter = new TelegramTemplateFormatter();
    this.geminiService = new GeminiEnrichmentService(supabase);
  }

  async runSource(adapter: SourceAdapter): Promise<IngestionRunResult> {
    const startTime = Date.now();
    const sourceId = adapter.sourceId;

    // 1. Try acquiring advisory lock to prevent concurrent runs on same source
    const lockAcquired = await this.tryAcquireAdvisoryLock(sourceId);
    if (!lockAcquired) {
      console.log(`[IngestionCoordinator] Source "${sourceId}" is already being processed by another worker.`);
      return {
        sourceId,
        status: 'locked',
        itemsScanned: 0,
        newItemsCount: 0,
        updatedItemsCount: 0,
        durationMs: Date.now() - startTime,
      };
    }

    try {
      // 2. Fetch source configuration & baseline state
      const { data: sourceConfig } = await this.supabase
        .from('notification_sources')
        .select('*')
        .eq('id', sourceId)
        .single();

      const isBaseline = sourceConfig?.baseline_status === 'pending' || sourceConfig?.baseline_status === 'initializing';

      // 3. Fetch webpage & parse notices
      const fetchResult = await adapter.fetchPage(sourceConfig?.fetch_timeout_ms || 15000);
      const rawNotices = await adapter.parseNotices(fetchResult.html);

      let newItems = 0;
      let updatedItems = 0;

      // 4. Ingest notices in chronological order (oldest first, newest last).
      // Government portals display notices descending (newest at top).
      // We sort oldest-to-newest so they are persisted and enqueued in sequence,
      // ensuring that when dispatched to Telegram and FCM, the newest notice is posted
      // at the very bottom of the feed (most recent update in the chat).
      const chronologicalNotices = this.sortChronologically(rawNotices);

      for (const raw of chronologicalNotices) {
        const { isNew, isUpdated } = await this.processNoticeItem(adapter, raw, isBaseline);
        if (isNew) newItems++;
        if (isUpdated) updatedItems++;
      }

      // 5. Update source baseline status if first run
      if (isBaseline) {
        await this.supabase
          .from('notification_sources')
          .update({
            baseline_status: 'initialized',
            baseline_completed_at: new Date().toISOString(),
            last_successful_poll_at: new Date().toISOString(),
            consecutive_failure_count: 0,
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', sourceId);
      } else {
        await this.supabase
          .from('notification_sources')
          .update({
            last_successful_poll_at: new Date().toISOString(),
            consecutive_failure_count: 0,
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', sourceId);
      }

      const durationMs = Date.now() - startTime;

      // 6. Record telemetry log in polling_runs
      await this.supabase.from('polling_runs').insert({
        source_id: sourceId,
        status: 'success',
        started_at: new Date(startTime).toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
        http_status_code: fetchResult.httpStatus,
        items_scanned: rawNotices.length,
        new_items_count: newItems,
        updated_items_count: updatedItems,
        response_bytes: fetchResult.html.length,
      });

      return {
        sourceId,
        status: 'success',
        itemsScanned: rawNotices.length,
        newItemsCount: newItems,
        updatedItemsCount: updatedItems,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      console.error(`[IngestionCoordinator] Failure on source "${sourceId}":`, err.message);

      // Increment consecutive failure count
      await this.supabase
        .from('notification_sources')
        .update({
          last_error: err.message,
          last_attempted_poll_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', sourceId);

      // Record failed run
      await this.supabase.from('polling_runs').insert({
        source_id: sourceId,
        status: 'failed',
        started_at: new Date(startTime).toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
        error_message: err.message,
        error_stack: err.stack,
      });

      return {
        sourceId,
        status: 'failed',
        itemsScanned: 0,
        newItemsCount: 0,
        updatedItemsCount: 0,
        durationMs,
        errorMessage: err.message,
      };
    } finally {
      await this.releaseAdvisoryLock(sourceId);
    }
  }

  private async processNoticeItem(
    adapter: SourceAdapter,
    raw: RawNoticeItem,
    isBaseline: boolean
  ): Promise<{ isNew: boolean; isUpdated: boolean }> {
    const sourceId = adapter.sourceId;
    const fingerprint = this.computeContentFingerprint(raw);

    // Look for existing record
    const { data: existing } = await this.supabase
      .from('exam_notices')
      .select('id, content_fingerprint, title, publication_date, attachment_urls')
      .eq('source_id', sourceId)
      .eq('source_notice_id', raw.sourceNoticeId)
      .maybeSingle();

    if (!existing) {
      // 1. Completely New Notice
      const classification = this.classificationEngine.classify(raw.title, raw.description);

      const { data: inserted, error } = await this.supabase
        .from('exam_notices')
        .insert({
          source_id: sourceId,
          source_notice_id: raw.sourceNoticeId,
          canonical_url: raw.canonicalUrl,
          title: raw.title,
          publication_date: raw.publicationDate,
          notice_type: classification.noticeType,
          exam_category: classification.category,
          exam_name: classification.examName,
          description: raw.description || null,
          attachment_urls: raw.attachments,
          content_fingerprint: fingerprint,
          classification_confidence: classification.confidence,
          is_active: true,
          status: 'published',
        })
        .select('*')
        .single();

      if (error || !inserted) {
        console.error('[IngestionCoordinator] Insert error:', error?.message);
        return { isNew: false, isUpdated: false };
      }

      // If NOT in baseline mode, enqueue outbox jobs for Telegram and FCM!
      if (!isBaseline) {
        await this.enqueueMultiChannelJobs(adapter, inserted, false);
      }

      return { isNew: true, isUpdated: false };
    }

    // 2. Existing Notice: Check if content changed
    if (existing.content_fingerprint === fingerprint) {
      // Fingerprint matches: Update last_observed_at without notifying
      await this.supabase
        .from('exam_notices')
        .update({ last_observed_at: new Date().toISOString() })
        .eq('id', existing.id);

      return { isNew: false, isUpdated: false };
    }

    // 3. Existing Notice with Fingerprint Change (Material Update)
    const diffSummary = {
      title: { old: existing.title, new: raw.title },
      publication_date: { old: existing.publication_date, new: raw.publicationDate },
      attachments: { old: existing.attachment_urls, new: raw.attachments },
    };

    // Record audit trail
    await this.supabase.from('exam_notice_history').insert({
      notice_id: existing.id,
      previous_fingerprint: existing.content_fingerprint,
      new_fingerprint: fingerprint,
      diff_summary: diffSummary,
    });

    const classification = this.classificationEngine.classify(raw.title, raw.description);

    const { data: updated } = await this.supabase
      .from('exam_notices')
      .update({
        title: raw.title,
        publication_date: raw.publicationDate,
        attachment_urls: raw.attachments,
        content_fingerprint: fingerprint,
        notice_type: classification.noticeType,
        exam_category: classification.category,
        exam_name: classification.examName,
        status: 'updated',
        last_observed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select('*')
      .single();

    if (updated && !isBaseline) {
      await this.enqueueMultiChannelJobs(adapter, updated, true);
    }

    return { isNew: false, isUpdated: true };
  }

  private async enqueueMultiChannelJobs(
    adapter: SourceAdapter,
    rawNotice: any,
    isUpdate: boolean
  ) {
    const jobs: any[] = [];
    const sourceId = (rawNotice.sourceId || rawNotice.source_id || adapter.sourceId).toLowerCase();
    const fingerprint = rawNotice.contentFingerprint || rawNotice.content_fingerprint || '';
    const canonicalUrl = rawNotice.canonicalUrl || rawNotice.canonical_url || '';
    const examCategory = rawNotice.examCategory || rawNotice.exam_category || 'OTHER';
    const noticeType = rawNotice.noticeType || rawNotice.notice_type || 'general';
    const attachments = rawNotice.attachments || rawNotice.attachment_urls || [];
    const examName = rawNotice.examName || rawNotice.exam_name || null;

    const notice: ExamNotice = {
      id: rawNotice.id,
      sourceId,
      sourceNoticeId: rawNotice.sourceNoticeId || rawNotice.source_notice_id,
      canonicalUrl,
      title: rawNotice.title,
      publicationDate: rawNotice.publicationDate || rawNotice.publication_date,
      firstDetectedAt: rawNotice.firstDetectedAt || rawNotice.first_detected_at || new Date(),
      lastObservedAt: rawNotice.lastObservedAt || rawNotice.last_observed_at || new Date(),
      noticeType,
      examCategory,
      examName,
      attachments,
      contentFingerprint: fingerprint,
      isActive: true,
      status: rawNotice.status || 'published',
      classificationConfidence: rawNotice.classificationConfidence || rawNotice.classification_confidence || 0.8,
      rawMetadata: rawNotice.rawMetadata || rawNotice.raw_metadata || {},
    };

    // Optional AI Enrichment via Gemini
    const aiEnrichment = await this.geminiService.enrichNotice(notice);

    // 1. Mobile App FCM Job (Broadcast via Board Topic)
    const fcmTopic = `board_${sourceId}`;
    const fcmIdempotencyKey = crypto
      .createHash('sha256')
      .update(`${notice.id}:fcm:${fcmTopic}:${fingerprint}`)
      .digest('hex');

    jobs.push({
      notice_id: notice.id,
      destination_type: 'fcm_topic',
      destination_target: fcmTopic,
      idempotency_key: fcmIdempotencyKey,
      title: `${adapter.displayName}: ${isUpdate ? 'Notice Updated' : 'New Announcement'}`,
      body: notice.title,
      payload: {
        kind: 'exam_notice',
        notice_id: notice.id,
        source_id: sourceId,
        canonical_url: canonicalUrl,
        attachment_url: attachments?.[0]?.url || '',
      },
    });

    // 2. Telegram Channels Jobs
    const { data: channels } = await this.supabase
      .from('telegram_channels')
      .select('*')
      .eq('is_enabled', true);

    const formattedPost = this.telegramFormatter.format(
      notice,
      adapter.displayName,
      isUpdate,
      aiEnrichment
    );

    for (const channel of (channels || []) as TelegramChannelConfig[]) {
      // Check board filter
      if (channel.filter_source_ids && !channel.filter_source_ids.includes(sourceId)) {
        continue;
      }
      // Check category filter
      if (channel.filter_categories && !channel.filter_categories.includes(examCategory)) {
        continue;
      }
      // Check notice type filter
      if (channel.filter_notice_types && !channel.filter_notice_types.includes(noticeType)) {
        continue;
      }

      const tgIdempotencyKey = crypto
        .createHash('sha256')
        .update(`${notice.id}:tg:${channel.chat_id}:${fingerprint}`)
        .digest('hex');

      jobs.push({
        notice_id: notice.id,
        destination_type: 'telegram_channel',
        destination_target: channel.chat_id,
        idempotency_key: tgIdempotencyKey,
        title: `${adapter.displayName} Alert`,
        body: notice.title,
        payload: {
          text: formattedPost.text,
          parse_mode: formattedPost.parse_mode,
          reply_markup: formattedPost.reply_markup,
          disable_web_page_preview: channel.disable_web_page_preview,
        },
      });
    }

    // Insert all jobs with atomic idempotency
    if (jobs.length > 0) {
      await this.supabase.from('notification_outbox').upsert(jobs, {
        onConflict: 'idempotency_key',
        ignoreDuplicates: true,
      });
    }
  }

  /**
   * Sorts scraped notices in ascending chronological order (oldest first, newest last).
   * Uses publicationDate ascending if available. If dates are equal or missing,
   * preserves reverse-DOM order (items lower in the portal table are older than items at the top).
   */
  private sortChronologically(notices: RawNoticeItem[]): RawNoticeItem[] {
    const indexed = notices.map((notice, index) => ({ notice, originalIndex: index }));
    indexed.sort((a, b) => {
      const dateA = a.notice.publicationDate ? new Date(a.notice.publicationDate).getTime() : 0;
      const dateB = b.notice.publicationDate ? new Date(b.notice.publicationDate).getTime() : 0;

      if (dateA !== dateB && dateA > 0 && dateB > 0) {
        return dateA - dateB;
      }

      // Higher originalIndex was lower on the web page (older)
      return b.originalIndex - a.originalIndex;
    });

    return indexed.map(item => item.notice);
  }

  private computeContentFingerprint(raw: RawNoticeItem): string {
    const normTitle = raw.title.trim().toLowerCase().replace(/\s+/g, ' ');
    const dateStr = raw.publicationDate || 'NO_DATE';
    const attachments = (raw.attachments || [])
      .map(a => a.url.trim().toLowerCase())
      .sort()
      .join(';');
    const desc = (raw.description || '').trim().toLowerCase();

    return crypto
      .createHash('sha256')
      .update(`${normTitle}|${dateStr}|${attachments}|${desc}`)
      .digest('hex');
  }

  private async tryAcquireAdvisoryLock(sourceId: string): Promise<boolean> {
    try {
      const { data } = await this.supabase.rpc('claim_source_advisory_lock', { p_source_id: sourceId });
      return data !== false;
    } catch {
      // Fallback: If custom RPC is not yet created, allow execution
      return true;
    }
  }

  private async releaseAdvisoryLock(sourceId: string): Promise<void> {
    try {
      await this.supabase.rpc('release_source_advisory_lock', { p_source_id: sourceId });
    } catch {
      // Ignore
    }
  }
}
