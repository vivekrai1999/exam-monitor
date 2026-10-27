// ---------------------------------------------------------------------------
// backend/exam-monitor/adapters/RpscAdapter.ts
// Rajasthan Public Service Commission (RPSC) News Scraper Adapter
// ---------------------------------------------------------------------------

import { BaseGovernmentScraperAdapter } from './BaseAdapter.ts';
import type { RawNoticeItem, RawAttachment } from '../types.ts';
import { parse as parseHtml } from 'node-html-parser';
import crypto from 'node:crypto';

export class RpscNewsAdapter extends BaseGovernmentScraperAdapter {
  readonly sourceId: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly monitoredUrl: string;

  constructor(options?: {
    sourceId?: string;
    displayName?: string;
    baseUrl?: string;
    monitoredUrl?: string;
  }) {
    super();
    this.sourceId = options?.sourceId || 'rpsc';
    this.displayName = options?.displayName || 'Rajasthan Public Service Commission';
    this.baseUrl = options?.baseUrl || 'https://rpsc.rajasthan.gov.in';
    this.monitoredUrl = options?.monitoredUrl || 'https://rpsc.rajasthan.gov.in/news';
  }

  // RPSC renders news items inside div.linkContainer, #tblNews, or news tables
  protected readonly containerSelector = 'div.linkContainer, #tblNews, .news-list, table';

  protected async extractItemsFromDom(root: ReturnType<typeof parseHtml>): Promise<RawNoticeItem[]> {
    const notices: RawNoticeItem[] = [];

    // 1. Check linkContainer (standard RPSC DotNetNuke container)
    const linkContainers = root.querySelectorAll('div.linkContainer');
    if (linkContainers.length > 0) {
      for (const container of linkContainers) {
        const anchors = container.querySelectorAll('a');
        for (const anchor of anchors) {
          const item = this.parseAnchorNotice(anchor, container);
          if (item) notices.push(item);
        }
      }
    }

    // 2. Check table rows if linkContainer returned few items
    if (notices.length === 0) {
      const rows = root.querySelectorAll('#tblNews tr, table.table tr, table tr');
      for (const row of rows) {
        const anchor = row.querySelector('a');
        if (!anchor) continue;

        const cells = row.querySelectorAll('td');
        let dateText = '';
        if (cells.length >= 2) {
          dateText = cells[0].text.trim();
        } else {
          dateText = row.querySelector('.date, .badge, span')?.text.trim() || '';
        }

        const title = anchor.text.trim();
        const href = anchor.getAttribute('href') || '';
        if (!title || title.length < 5) continue;

        const publicationDate = this.parseIndianDate(dateText);
        const canonicalUrl = this.resolveAbsoluteUrl(href);
        const explicitId = this.extractExplicitId(href);

        const attachments: RawAttachment[] = [];
        if (href.toLowerCase().includes('.pdf') || href.toLowerCase().includes('/static/')) {
          attachments.push({
            url: canonicalUrl,
            label: 'Official Press Note / Notice PDF',
            fileType: 'pdf',
          });
        }

        const sourceNoticeId = explicitId || this.generateFallbackId(canonicalUrl, title);

        notices.push({
          sourceNoticeId,
          canonicalUrl,
          title,
          publicationDate,
          attachments,
        });
      }
    }

    return notices;
  }

  private parseAnchorNotice(anchor: ReturnType<typeof parseHtml>, parent: ReturnType<typeof parseHtml>): RawNoticeItem | null {
    const title = anchor.text.replace(/\s+/g, ' ').trim();
    const href = anchor.getAttribute('href') || '';
    if (!title || title.length < 5) return null;

    // Look for date inside anchor or preceding/sibling span
    const dateSpan = anchor.querySelector('span, .date, .badge') || parent.querySelector('span, .date');
    const dateText = dateSpan?.text.trim() || '';
    const publicationDate = this.parseIndianDate(dateText);

    const canonicalUrl = this.resolveAbsoluteUrl(href);
    const explicitId = this.extractExplicitId(href);

    const attachments: RawAttachment[] = [];
    if (href.toLowerCase().includes('.pdf') || href.toLowerCase().includes('/static/')) {
      attachments.push({
        url: canonicalUrl,
        label: 'Official Press Note / Notice PDF',
        fileType: 'pdf',
      });
    }

    const sourceNoticeId = explicitId || this.generateFallbackId(canonicalUrl, title);

    return {
      sourceNoticeId,
      canonicalUrl,
      title,
      publicationDate,
      attachments,
    };
  }

  private extractExplicitId(url: string): string | null {
    const match = url.match(/[?&]id=(\d+)/i) || url.match(/\/(\d+)\/?$/);
    return match ? match[1] : null;
  }

  private generateFallbackId(canonicalUrl: string, title: string): string {
    const norm = `${canonicalUrl}:${title.toLowerCase().replace(/\s+/g, ' ')}`;
    return crypto.createHash('sha256').update(norm).digest('hex').substring(0, 24);
  }
}
