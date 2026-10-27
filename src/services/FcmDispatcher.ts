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
    const { data: jobs, error } = await this.supabase.rpc('claim_outbox_jobs', {
      p_destination_type: 'fcm_topic',
      batch_size: batchSize,
    });

    if (error) {
      console.error('[FcmDispatcher] Error claiming outbox jobs:', error.message);
      return 0;
    }

    if (!jobs || jobs.length === 0) return 0;

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
}
