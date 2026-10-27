// ---------------------------------------------------------------------------
// backend/exam-monitor/services/FcmDispatcher.ts
// Asynchronous Outbox Worker for Firebase Cloud Messaging (FCM HTTP v1)
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

import fs from 'node:fs';

export class FcmDispatcher {
  private supabase: SupabaseClient;
  private serviceAccount: any = null;

  constructor(
    supabase: SupabaseClient,
    serviceAccountJson?: string
  ) {
    this.supabase = supabase;
    const raw = serviceAccountJson || process.env.FCM_SERVICE_ACCOUNT || '';
    if (raw) {
      try {
        if (typeof raw === 'string' && (raw.endsWith('.json') || raw.startsWith('.') || raw.startsWith('/') || raw.startsWith('\\') || raw.includes(':'))) {
          if (fs.existsSync(raw)) {
            this.serviceAccount = JSON.parse(fs.readFileSync(raw, 'utf8'));
          } else {
            this.serviceAccount = JSON.parse(raw);
          }
        } else {
          this.serviceAccount = typeof raw === 'string' ? JSON.parse(raw) : raw;
        }
      } catch {
        console.warn('[FcmDispatcher] Failed to parse FCM_SERVICE_ACCOUNT JSON.');
      }
    }
  }

  async processBatch(batchSize: number = 20): Promise<number> {
    // 0. Automatically purge any historical notices (> 7 days old) from the outbox
    await this.purgeStalePendingJobs();

    const { data: jobs, error } = await this.supabase.rpc('claim_outbox_jobs', {
      p_destination_type: 'fcm_topic',
      batch_size: batchSize,
    });

    if (error) {
      console.error('[FcmDispatcher] Error claiming outbox jobs:', error.message);
      return 0;
    }

    if (!jobs || jobs.length === 0) return 0;

    // Ensure claimed batch is dispatched chronologically (oldest first, newest last)
    jobs.sort((a, b) => {
      const timeA = new Date(a.next_attempt_at || a.created_at).getTime();
      const timeB = new Date(b.next_attempt_at || b.created_at).getTime();
      if (timeA !== timeB) return timeA - timeB;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    for (const job of jobs) {
      try {
        const messageId = await this.dispatchFcmMessage(job);
        await this.markJobSuccess(job.id, messageId);
      } catch (err: any) {
        await this.handleJobFailure(job, err);
      }
    }

    return jobs.length;
  }

  private async dispatchFcmMessage(job: any): Promise<string> {
    if (!this.serviceAccount) {
      console.warn('[FcmDispatcher] FCM_SERVICE_ACCOUNT missing. Simulating delivery in dev mode.');
      return `mock-fcm-${Date.now()}`;
    }

    const token = await this.getGoogleAccessToken();
    const projectId = this.serviceAccount.project_id;
    const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

    const message: any = {
      notification: {
        title: job.title,
        body: job.body,
      },
      data: Object.fromEntries(
        Object.entries(job.payload || {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
      ),
      android: {
        priority: 'high',
        notification: {
          channel_id: 'exam_alerts_high',
          color: '#1E3A8A',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    if (job.destination_type === 'fcm_topic') {
      message.topic = job.destination_target;
    } else {
      message.token = job.destination_target;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });

    const json = await response.json();

    if (!response.ok) {
      const err: any = new Error(json.error?.message || `FCM error ${response.status}`);
      err.statusCode = response.status;
      err.responseBody = JSON.stringify(json);
      throw err;
    }

    return json.name || `projects/${projectId}/messages/${Date.now()}`;
  }

  private async getGoogleAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claim = {
      iss: this.serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };

    const base64Url = (obj: object) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url');

    const unsignedToken = `${base64Url(header)}.${base64Url(claim)}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsignedToken);
    const signature = signer.sign(this.serviceAccount.private_key, 'base64url');
    const jwt = `${unsignedToken}.${signature}`;

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    const json = await res.json();
    return json.access_token;
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

    const { data: job } = await this.supabase
      .from('notification_outbox')
      .select('destination_type, destination_target')
      .eq('id', jobId)
      .maybeSingle();

    if (job) {
      await this.supabase.from('notification_delivery_attempts').insert({
        outbox_id: jobId,
        destination_type: job.destination_type,
        destination_target: job.destination_target,
        status: 'success',
        response_code: 200,
        response_body: JSON.stringify({ message_id: messageId }),
      });
    }
  }

  private async handleJobFailure(job: any, err: any) {
    const nextAttempts = (job.attempt_count || 0) + 1;
    const isTerminal = nextAttempts >= (job.max_attempts || 5);
    const backoffSeconds = Math.min(300, Math.pow(2, nextAttempts) * 10);
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

    // Audit log attempt
    await this.supabase.from('notification_delivery_attempts').insert({
      outbox_id: job.id,
      destination_type: job.destination_type,
      destination_target: job.destination_target,
      status: 'failure',
      response_code: err.statusCode || 500,
      response_body: err.responseBody || null,
      error_message: err.message,
    });
  }

  private async markJobSkipped(jobId: string, reason: string): Promise<void> {
    try {
      await this.supabase
        .from('notification_outbox')
        .update({
          status: 'skipped',
          last_error: reason,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);
    } catch (err: any) {
      console.warn(`[FcmDispatcher] Error marking job ${jobId} as skipped:`, err.message);
    }
  }

  private async purgeStalePendingJobs(): Promise<void> {
    try {
      const { data: pendingJobs } = await this.supabase
        .from('notification_outbox')
        .select('id, notice_id')
        .eq('status', 'pending')
        .eq('destination_type', 'fcm_topic')
        .limit(300);

      if (!pendingJobs || pendingJobs.length === 0) return;

      const noticeIds = [...new Set(pendingJobs.map((j: any) => j.notice_id))];
      const { data: notices } = await this.supabase
        .from('exam_notices')
        .select('id, publication_date')
        .in('id', noticeIds);

      const noticeMap = new Map((notices || []).map((n: any) => [n.id, n.publication_date]));
      const now = Date.now();
      const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
      const staleIds: string[] = [];

      for (const job of pendingJobs) {
        const pubDateStr = noticeMap.get(job.notice_id);
        if (pubDateStr) {
          const pubTime = new Date(pubDateStr).getTime();
          if (!isNaN(pubTime) && (now - pubTime) > maxAgeMs) {
            staleIds.push(job.id);
          }
        }
      }

      if (staleIds.length > 0) {
        console.log(`[FcmDispatcher] Auto-purging ${staleIds.length} stale historical jobs (> 7 days old)...`);
        await this.supabase
          .from('notification_outbox')
          .update({
            status: 'skipped',
            last_error: 'Purged: Historical notice older than 7 days',
            updated_at: new Date().toISOString(),
          })
          .in('id', staleIds);
      }
    } catch (err: any) {
      console.warn('[FcmDispatcher] Error purging stale jobs:', err.message);
    }
  }
}
