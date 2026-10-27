// ---------------------------------------------------------------------------
// backend/exam-monitor/adapters/BaseAdapter.ts
// Abstract base adapter for government portal HTML scraping
// ---------------------------------------------------------------------------

import type { SourceAdapter, FetchResult, RawNoticeItem } from '../types.ts';
import { parse as parseHtml } from 'node-html-parser';
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns';
import { URL } from 'node:url';

// Force Node to prefer IPv4 over IPv6.
// Rajasthan government portals (rpsc/rssb.rajasthan.gov.in) silently drop IPv6 SYN packets,
// causing dual-stack Happy Eyeballs in cloud runners (GitHub Actions) to hang and time out.
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

export abstract class BaseGovernmentScraperAdapter implements SourceAdapter {
  abstract readonly sourceId: string;
  abstract readonly displayName: string;
  abstract readonly baseUrl: string;
  abstract readonly monitoredUrl: string;

  protected abstract readonly containerSelector: string;
  protected abstract extractItemsFromDom(root: ReturnType<typeof parseHtml>): Promise<RawNoticeItem[]>;

  async fetchPage(timeoutMs: number = 30000): Promise<FetchResult> {
    let lastError: any = null;
    // Attempt request with 1 automatic retry
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await this.httpRequestWithLegacySsl(this.monitoredUrl, this.getRequestHeaders(), timeoutMs);

        if (result.status >= 500) {
          throw new Error(`[${this.sourceId}] Server error HTTP ${result.status}`);
        }
        if (result.status === 429) {
          throw new Error(`[${this.sourceId}] Rate limited HTTP 429 by government server`);
        }
        if (result.status === 403) {
          throw new Error(`[${this.sourceId}] Forbidden HTTP 403 (possible WAF/IP block)`);
        }

        return {
          html: result.body,
          httpStatus: result.status,
          responseHeaders: result.headers,
          fetchedAt: new Date(),
        };
      } catch (err: any) {
        lastError = err;
        if (attempt === 1) {
          console.warn(`[${this.sourceId}] Fetch attempt 1 failed (${err.message}). Retrying in 2s...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    throw lastError;
  }

  private httpRequestWithLegacySsl(
    urlStr: string,
    headers: Record<string, string>,
    timeoutMs: number = 30000
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      // 0x00040000 = SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION (required for RSSB OpenSSL 3 handshakes)
      const agent = isHttps
        ? new https.Agent({
            family: 4,
            secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT | 0x00040000,
            rejectUnauthorized: false,
          })
        : undefined;

      const req = client.request(
        url.toString(),
        {
          method: 'GET',
          headers,
          agent,
          family: 4, // Strictly force IPv4
          timeout: timeoutMs,
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, url).toString();
            return this.httpRequestWithLegacySsl(redirectUrl, headers, timeoutMs).then(resolve, reject);
          }

          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            const headersObj: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (v) headersObj[k] = Array.isArray(v) ? v.join(', ') : v;
            }
            resolve({
              status: res.statusCode || 200,
              headers: headersObj,
              body,
            });
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`[${this.sourceId}] Request timed out after ${timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.end();
    });
  }

  validateResponse(result: FetchResult): boolean {
    if (!result.html || result.html.length < 200) return false;
    const root = parseHtml(result.html);
    const container = root.querySelector(this.containerSelector);
    return container !== null;
  }

  async parseNotices(html: string): Promise<RawNoticeItem[]> {
    const root = parseHtml(html);

    if (!this.validateResponse({ html, httpStatus: 200, responseHeaders: {}, fetchedAt: new Date() })) {
      throw new Error(
        `[${this.sourceId}] ParserContractViolationError: Required selector "${this.containerSelector}" not found in HTML.`
      );
    }

    const items = await this.extractItemsFromDom(root);
    return items.map(item => this.normalizeNotice(item));
  }

  normalizeNotice(raw: RawNoticeItem): RawNoticeItem {
    return {
      ...raw,
      title: raw.title.replace(/\s+/g, ' ').trim(),
      canonicalUrl: this.resolveAbsoluteUrl(raw.canonicalUrl),
      attachments: (raw.attachments || []).map(att => ({
        ...att,
        url: this.resolveAbsoluteUrl(att.url),
        label: att.label.trim(),
      })),
    };
  }

  protected resolveAbsoluteUrl(relativeOrAbsolute: string): string {
    if (!relativeOrAbsolute) return this.baseUrl;
    try {
      return new URL(relativeOrAbsolute, this.baseUrl).toString();
    } catch {
      return relativeOrAbsolute;
    }
  }

  protected parseIndianDate(rawDate: string | null | undefined): string | null {
    if (!rawDate) return null;
    const cleaned = rawDate.trim();
    // Matches DD/MM/YYYY, DD-MM-YYYY, or DD.MM.YYYY
    const match = cleaned.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
    if (!match) return null;
    const [, day, month, year] = match;
    const d = day.padStart(2, '0');
    const m = month.padStart(2, '0');
    return `${year}-${m}-${d}`;
  }

  protected getRequestHeaders(): Record<string, string> {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    };
  }
}
