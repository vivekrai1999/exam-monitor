// ---------------------------------------------------------------------------
// backend/exam-monitor/adapters/RssbAdapter.ts
// Rajasthan Staff Selection Board (RSSB) News Scraper Adapter
// ---------------------------------------------------------------------------

import { BaseGovernmentScraperAdapter } from './BaseAdapter.ts';
import type { RawNoticeItem, RawAttachment } from '../types.ts';
import { parse as parseHtml } from 'node-html-parser';
import crypto from 'node:crypto';

export class RssbNewsAdapter extends BaseGovernmentScraperAdapter {
  readonly sourceId = 'rssb';
  readonly displayName = 'Rajasthan Staff Selection Board';
  readonly baseUrl = 'https://rssb.rajasthan.gov.in';
  readonly monitoredUrl = 'https://rssb.rajasthan.gov.in/news';

  protected readonly containerSelector = 'table tbody tr, table tr, a[href*="/storage/news_item/"], a[href$=".pdf"]';

  protected async extractItemsFromDom(root: ReturnType<typeof parseHtml>): Promise<RawNoticeItem[]> {
    const notices: RawNoticeItem[] = [];

    const rows = root.querySelectorAll('table tbody tr, table tr, .news-item, .news-row, a[href*="/storage/news_item/"], a[href$=".pdf"]');
    const seenIds = new Set<string>();

    for (const row of rows) {
      // Skip header rows (th), search forms, or rows without links
      if (row.querySelector('th') || row.querySelector('form') || row.querySelector('input')) continue;

      const anchor = row.rawTagName === 'a' ? row : row.querySelector('a');
      if (!anchor) continue;

      const href = anchor.getAttribute('href') || '';
      if (!href) continue;

      // Filter: Only process legitimate news items pointing to official attachments or news routes
      const isNewsLink = href.includes('/storage/news_item/') || href.toLowerCase().endsWith('.pdf') || href.includes('/news/');
      if (!isNewsLink) continue;

      const rowText = row.text.trim();
      const title = (anchor.text.trim() || row.querySelector('.title')?.text.trim() || rowText)
        .replace(/[\u200B-\u200D\uFEFF]/g, '') // Strip zero-width non-joiners
        .replace(/\s+/g, ' ')
        .trim();

      if (!title || title.length < 5) continue;

      // Extract publication date from row text or fallback to unix timestamp in URL
      let publicationDate = this.parseIndianDate(rowText);
      if (!publicationDate) {
        const timestampMatch = href.match(/news_item\/(\d{10})/);
        if (timestampMatch) {
          const unixSec = parseInt(timestampMatch[1], 10);
          if (!isNaN(unixSec) && unixSec > 1500000000) {
            publicationDate = new Date(unixSec * 1000).toISOString().split('T')[0];
          }
        }
      }

      const canonicalUrl = this.resolveAbsoluteUrl(href || this.monitoredUrl);
      const explicitId = this.extractExplicitId(href);

      const attachments: RawAttachment[] = [];
      if (href.toLowerCase().includes('.pdf') || href.toLowerCase().includes('download') || href.toLowerCase().includes('/news/')) {
        attachments.push({
          url: canonicalUrl,
          label: 'Official Notification Document',
          fileType: 'pdf',
        });
      }

      const sourceNoticeId = explicitId || this.generateFallbackId(canonicalUrl, title);
      if (seenIds.has(sourceNoticeId)) continue;
      seenIds.add(sourceNoticeId);

      notices.push({
        sourceNoticeId,
        canonicalUrl,
        title,
        publicationDate,
        attachments,
      });
    }

    return notices;
  }

  private extractExplicitId(url: string): string | null {
    const match = url.match(/newsid=(\d+)/i) || url.match(/\/(\d+)\/?$/);
    return match ? match[1] : null;
  }

  private generateFallbackId(canonicalUrl: string, title: string): string {
    const norm = `${canonicalUrl}:${title.toLowerCase().replace(/\s+/g, ' ')}`;
    return crypto.createHash('sha256').update(norm).digest('hex').substring(0, 24);
  }
}
