// ---------------------------------------------------------------------------
// backend/exam-monitor/services/TelegramTemplateFormatter.ts
// Renders rich HTML messages and inline keyboard markups for Telegram
// ---------------------------------------------------------------------------

import type { ExamNotice, NoticeType, GeminiEnrichmentResult } from '../types.ts';

export interface FormattedTelegramPost {
  text: string;
  parse_mode: 'HTML';
  disable_web_page_preview: boolean;
  reply_markup: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
}

export class TelegramTemplateFormatter {
  format(
    notice: ExamNotice,
    boardName: string,
    isUpdate: boolean = false,
    aiEnrichment?: GeminiEnrichmentResult | null
  ): FormattedTelegramPost {
    const title = this.escapeHtml(notice.title);
    const exam = this.escapeHtml(aiEnrichment?.exam_name || notice.examName || 'Rajasthan Competitive Exam');
    const pubDate = notice.publicationDate || 'Recently Released';
    const primaryAttachment = notice.attachments?.[0]?.url;

    // Zero-width tracking token (resolves the network timeout / Two-Army problem)
    const trackingToken = `<a href="https://pyqbox.internal/n/${notice.id}">&#8203;</a>`;

    const header = isUpdate
      ? '🔄 <b>NOTICE AMENDMENT / शुद्धि पत्र</b>'
      : this.getHeaderForType(notice.noticeType);

    const lines: string[] = [
      `${header}${trackingToken}`,
      `🏛 <b>Board:</b> ${this.escapeHtml(boardName)}`,
      `🎯 <b>Exam:</b> ${exam}`,
      `📅 <b>Official Date:</b> ${pubDate}`,
      '',
      `📌 <b>Official Notice:</b> ${title}`,
    ];

    // If Gemini AI enrichment is available, format distinct AI summary block
    if (aiEnrichment && (aiEnrichment.summary_hi || aiEnrichment.summary_en || aiEnrichment.key_points.length > 0)) {
      lines.push('');
      lines.push('🤖 <b>AI Quick Summary / मुख्य बिंदु:</b>');

      if (aiEnrichment.summary_hi) {
        lines.push(`• ${this.escapeHtml(aiEnrichment.summary_hi)}`);
      }
      if (aiEnrichment.summary_en && aiEnrichment.summary_en !== aiEnrichment.summary_hi) {
        lines.push(`• ${this.escapeHtml(aiEnrichment.summary_en)}`);
      }

      for (const pt of aiEnrichment.key_points) {
        lines.push(`▫️ ${this.escapeHtml(pt)}`);
      }

      if (aiEnrichment.vacancies_count) {
        lines.push(`📊 <b>कुल पद (Vacancies):</b> ${aiEnrichment.vacancies_count}`);
      }
      if (aiEnrichment.important_dates.application_deadline) {
        lines.push(`⏳ <b>आवेदन की अंतिम तिथि:</b> ${aiEnrichment.important_dates.application_deadline}`);
      }
      if (aiEnrichment.important_dates.exam_date) {
        lines.push(`⏰ <b>परीक्षा तिथि:</b> ${aiEnrichment.important_dates.exam_date}`);
      }

      lines.push('');
      lines.push('⚠️ <i>नोट: यह संक्षिप्त सारांश AI द्वारा तैयार किया गया है। आवेदन करने से पूर्व आधिकारिक विज्ञप्ति अवश्य पढ़ें।</i>');
    }

    lines.push('');
    if (primaryAttachment) {
      lines.push(`🔗 <a href="${primaryAttachment}"><b>Download Official PDF / दस्तावेज़</b></a>`);
    }
    lines.push('📱 <i>Instant alerts & previous year papers on Pyqbox App</i>');

    const inlineKeyboard: Array<Array<{ text: string; url: string }>> = [];
    if (primaryAttachment) {
      inlineKeyboard.push([{ text: '📥 Download Official PDF', url: primaryAttachment }]);
    }
    inlineKeyboard.push([
      { text: '🌐 Official Portal Page', url: notice.canonicalUrl },
      { text: '📱 Practice on Pyqbox', url: 'https://play.google.com/store/apps/details?id=com.pyqbox' },
    ]);

    return {
      text: lines.join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: false,
      reply_markup: { inline_keyboard: inlineKeyboard },
    };
  }

  private getHeaderForType(type: NoticeType): string {
    switch (type) {
      case 'advertisement':
        return '📢 <b>NEW RECRUITMENT NOTIFICATION</b>';
      case 'exam_date':
        return '⏰ <b>EXAM DATE ANNOUNCEMENT</b>';
      case 'admit_card':
        return '🎟 <b>ADMIT CARD RELEASED</b>';
      case 'answer_key':
        return '🔑 <b>MODEL ANSWER KEY & OBJECTIONS</b>';
      case 'result':
        return '🏆 <b>EXAM RESULT & CUT-OFF ANNOUNCED</b>';
      case 'syllabus':
        return '📚 <b>EXAMINATION SYLLABUS RELEASED</b>';
      case 'corrigendum':
        return '🔄 <b>AMENDMENT / CORRIGENDUM</b>';
      case 'press_note':
        return '📰 <b>OFFICIAL PRESS NOTE</b>';
      default:
        return '📢 <b>OFFICIAL EXAM ANNOUNCEMENT</b>';
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
