// ---------------------------------------------------------------------------
// backend/exam-monitor/services/TelegramDispatcher.ts
// Asynchronous Outbox Worker for Telegram Channel publishing
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';

export interface TelegramSendMessageOptions {
  chatId: string;
  text: string;
  parseMode?: 'HTML' | 'MarkdownV2';
  disableWebPagePreview?: boolean;
  replyMarkup?: any;
}

export class TelegramDispatcher {
  private supabase: SupabaseClient;
  private botToken: string;

  constructor(
    supabase: SupabaseClient,
    botToken?: string
  ) {
    this.supabase = supabase;
    this.botToken = botToken || process.env.TELEGRAM_BOT_TOKEN || process.env.PYQBOX_BOT_TOKEN || '';
  }

  async processBatch(batchSize: number = 10): Promise<number> {
    if (!this.botToken) {
      console.warn('[TelegramDispatcher] TELEGRAM_BOT_TOKEN not configured. Skipping telegram dispatch.');
      return 0;
    }

    // 1. Claim batch of jobs using RPC executing SKIP LOCKED
    const { data: jobs, error } = await this.supabase.rpc('claim_outbox_jobs', {
      p_destination_type: 'telegram_channel',
      batch_size: batchSize,
    });

    if (error) {
      console.error('[TelegramDispatcher] Error claiming outbox jobs:', error.message);
      return 0;
    }

    if (!jobs || jobs.length === 0) return 0;

    for (const job of jobs) {
      try {
        await this.throttleChannel(job.destination_target);

        const result = await this.sendTelegramMessage({
          chatId: job.destination_target,
          text: job.payload?.text || job.body,
          parseMode: job.payload.parse_mode || 'HTML',
          disableWebPagePreview: job.payload.disable_web_page_preview ?? false,
          replyMarkup: job.payload.reply_markup,
        });

        await this.markJobSuccess(job.id, String(result.message_id));
      } catch (err: any) {
        await this.handleJobFailure(job, err);
      }
    }

    return jobs.length;
  }

  private async throttleChannel(chatId: string) {
    try {
      const { data: channel } = await this.supabase
        .from('telegram_channels')
        .select('last_posted_at, rate_limit_seconds')
        .eq('chat_id', chatId)
        .maybeSingle();

      if (channel?.last_posted_at) {
        const elapsedMs = Date.now() - new Date(channel.last_posted_at).getTime();
        const requiredWaitMs = (channel.rate_limit_seconds || 3) * 1000;
        if (elapsedMs < requiredWaitMs) {
          const waitTime = requiredWaitMs - elapsedMs;
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    } catch {
      // Continue even if rate-limit lookup fails
    }
  }

  private async sendTelegramMessage(options: TelegramSendMessageOptions): Promise<{ message_id: number }> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: options.chatId,
        text: options.text,
        parse_mode: options.parseMode || 'HTML',
        disable_web_page_preview: options.disableWebPagePreview ?? false,
        reply_markup: options.replyMarkup,
      }),
    });

    const json = await response.json();

    if (!response.ok || !json.ok) {
      const err: any = new Error(json.description || `Telegram error ${response.status}`);
      err.errorCode = response.status;
      err.retryAfter = json?.parameters?.retry_after;
      err.responseBody = JSON.stringify(json);
      throw err;
    }

    return json.result;
  }

  private async markJobSuccess(jobId: string, messageId: string) {
    await this.supabase
      .from('notification_outbox')
      .update({
        status: 'delivered',
        provider_message_id: messageId,
        delivered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    // Update channel last_posted_at
    const { data: job } = await this.supabase
      .from('notification_outbox')
      .select('destination_type, destination_target')
      .eq('id', jobId)
      .maybeSingle();

    if (job?.destination_target) {
      await this.supabase
        .from('telegram_channels')
        .update({ last_posted_at: new Date().toISOString() })
        .eq('chat_id', job.destination_target);

      await this.supabase.from('notification_delivery_attempts').insert({
        outbox_id: jobId,
        destination_type: job.destination_type || 'telegram_channel',
        destination_target: job.destination_target,
        status: 'success',
        response_code: 200,
        response_body: JSON.stringify({ message_id: messageId }),
      });
    }
  }

  private async handleJobFailure(job: any, err: any) {
    const nextAttempts = (job.attempt_count || 0) + 1;
    let isTerminal = nextAttempts >= (job.max_attempts || 5);
    let backoffSeconds = Math.min(3600, Math.pow(2, nextAttempts) * 15);

    // If Telegram returned HTTP 429 Too Many Requests, respect retry_after
    if (err.errorCode === 429 && err.retryAfter) {
      backoffSeconds = Number(err.retryAfter) + 5;
    }

    // Terminal errors: 400 Bad Request (syntax/invalid chat), 403 Forbidden (bot kicked)
    if (err.errorCode === 400 || err.errorCode === 403) {
      isTerminal = true;
    }

    const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();

    await this.supabase
      .from('notification_outbox')
      .update({
        status: isTerminal ? 'failed' : 'pending',
        attempt_count: nextAttempts,
        next_attempt_at: nextAttemptAt,
        last_error: err.message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    // Audit log delivery attempt
    await this.supabase.from('notification_delivery_attempts').insert({
      outbox_id: job.id,
      destination_type: job.destination_type,
      destination_target: job.destination_target,
      status: 'failure',
      response_code: err.errorCode || 500,
      response_body: err.responseBody || null,
      error_message: err.message,
    });
  }
}
