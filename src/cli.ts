// ---------------------------------------------------------------------------
// backend/exam-monitor/cli.ts
// Operational CLI & Worker daemon for Rajasthan Exam Monitor
// ---------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';
import { RpscNewsAdapter } from './adapters/RpscAdapter.ts';
import { RssbNewsAdapter } from './adapters/RssbAdapter.ts';
import { IngestionCoordinator } from './services/IngestionCoordinator.ts';
import { TelegramDispatcher } from './services/TelegramDispatcher.ts';
import { FcmDispatcher } from './services/FcmDispatcher.ts';

function getSupabaseAdmin() {
  try {
    process.loadEnvFile?.();
  } catch {}

  const url = process.env.SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment.');
  }

  return createClient(url, serviceKey);
}

export async function main(args: string[] = process.argv.slice(2)) {
  const command = args[0] || 'help';

  const flag = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    return idx === -1 ? undefined : args[idx + 1];
  };

  switch (command) {
    case 'poll': {
      const sourceArg = flag('source') || 'all';
      const supabase = getSupabaseAdmin();
      const coordinator = new IngestionCoordinator(supabase);

      const adapters = [];
      if (sourceArg === 'rpsc' || sourceArg === 'all') adapters.push(new RpscNewsAdapter());
      if (sourceArg === 'rssb' || sourceArg === 'all') adapters.push(new RssbNewsAdapter());

      console.log(`[CLI] Polling source(s): ${adapters.map(a => a.sourceId).join(', ')}...`);

      for (const adapter of adapters) {
        console.log(`[CLI] Starting poll for ${adapter.displayName}...`);
        const result = await coordinator.runSource(adapter);
        console.log(`[CLI] ${adapter.sourceId} finished: status=${result.status}, scanned=${result.itemsScanned}, new=${result.newItemsCount}, updated=${result.updatedItemsCount}, duration=${result.durationMs}ms`);
      }
      break;
    }

    case 'outbox': {
      const destArg = flag('dest') || 'all';
      const supabase = getSupabaseAdmin();

      if (destArg === 'telegram' || destArg === 'all') {
        const tgDispatcher = new TelegramDispatcher(supabase);
        const count = await tgDispatcher.processBatch(20);
        console.log(`[CLI] Telegram outbox processed: ${count} jobs.`);
      }

      if (destArg === 'fcm' || destArg === 'all') {
        const fcmDispatcher = new FcmDispatcher(supabase);
        const count = await fcmDispatcher.processBatch(20);
        console.log(`[CLI] FCM outbox processed: ${count} jobs.`);
      }
      break;
    }

    case 'reset-baseline': {
      const sourceId = flag('source');
      if (!sourceId) {
        console.error('Please specify --source <rpsc|rssb>');
        process.exit(1);
      }
      const supabase = getSupabaseAdmin();
      await supabase.rpc('reset_source_baseline', { p_source_id: sourceId });
      console.log(`[CLI] Reset baseline for source "${sourceId}". Next scan will silently onboard archive.`);
      break;
    }

    case 'worker': {
      const supabase = getSupabaseAdmin();
      const coordinator = new IngestionCoordinator(supabase);
      const tgDispatcher = new TelegramDispatcher(supabase);
      const fcmDispatcher = new FcmDispatcher(supabase);
      const adapters = [new RpscNewsAdapter(), new RssbNewsAdapter()];

      // Optional manual interval override via flag --interval <seconds> or env
      const intervalFlag = flag('interval');
      const customSec = intervalFlag ? parseInt(intervalFlag, 10) : process.env.POLL_INTERVAL_SECONDS ? parseInt(process.env.POLL_INTERVAL_SECONDS, 10) : undefined;
      const customOverrideMs = customSec && !isNaN(customSec) && customSec > 0 ? customSec * 1000 : undefined;

      console.log('[Worker] Starting Rajasthan Exam Monitor daemon (Intelligent Peak-Hour Scheduler enabled)...');

      // 1. Ingestion poll execution
      let isPolling = false;
      const runPoll = async () => {
        if (isPolling) return;
        isPolling = true;
        try {
          for (const adapter of adapters) {
            try {
              const res = await coordinator.runSource(adapter);
              if (res.newItemsCount > 0 || res.updatedItemsCount > 0) {
                console.log(`[Worker] Detected updates from ${adapter.sourceId}: new=${res.newItemsCount}, updated=${res.updatedItemsCount}`);
              }
            } catch (err: any) {
              console.error(`[Worker] Poll error on ${adapter.sourceId}:`, err.message);
            }
          }
        } finally {
          isPolling = false;
        }
      };

      // 2. Outbox dispatcher loop (every 4 seconds for immediate broadcast)
      const runOutbox = async () => {
        try {
          await tgDispatcher.processBatch(10);
          await fcmDispatcher.processBatch(20);
        } catch (err: any) {
          console.error('[Worker] Outbox error:', err.message);
        }
      };

      // Dynamic scheduler loop adapting to Indian Standard Time (IST)
      const scheduleNextPoll = () => {
        const { intervalMs, mode } = getDynamicPollIntervalMs(customOverrideMs);
        console.log(`[Worker] Next poll in ${Math.round(intervalMs / 1000)}s [Schedule: ${mode}]`);
        setTimeout(async () => {
          await runPoll();
          scheduleNextPoll();
        }, intervalMs);
      };

      // Execute initial poll immediately, then schedule dynamic loops
      await runPoll();
      scheduleNextPoll();

      setInterval(runOutbox, 4000); // 4-second responsive outbox queue
      break;
    }

    default:
      console.log(`
Rajasthan Exam Notification Monitor CLI
Usage:
  npm run poll [-- --source rpsc|rssb|all]
  npm run outbox [-- --dest fcm|telegram|all]
  npm run reset-baseline -- --source <rpsc|rssb>
  npm run worker [-- --interval <seconds>]
`);
  }
}

/**
 * Calculates adaptive polling interval based on Indian Standard Time (IST).
 * Rajasthan government offices (RPSC/RSSB) publish notices during office hours.
 */
export function getDynamicPollIntervalMs(fixedOverrideMs?: number): { intervalMs: number; mode: string } {
  if (fixedOverrideMs && fixedOverrideMs > 0) {
    return { intervalMs: fixedOverrideMs, mode: `Custom Override (${Math.round(fixedOverrideMs / 1000)}s)` };
  }

  // Convert current UTC time to IST (Asia/Kolkata)
  const now = new Date();
  const istFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  });

  const parts = istFormatter.formatToParts(now);
  const hourPart = parts.find(p => p.type === 'hour')?.value;
  const weekdayPart = parts.find(p => p.type === 'weekday')?.value;
  const hour = hourPart ? parseInt(hourPart, 10) : 12;
  const isSunday = weekdayPart === 'Sun';

  // Sunday: Off-peak (10 minutes)
  if (isSunday) {
    return { intervalMs: 10 * 60 * 1000, mode: 'Sunday Off-Peak (10m)' };
  }

  // Peak notice release hours: Mon-Sat, 9:00 AM to 7:30 PM IST (2 minutes)
  // Max delay for new notices drops to ~2 minutes!
  if (hour >= 9 && hour < 20) {
    return { intervalMs: 2 * 60 * 1000, mode: 'Peak Office Hours (2m)' };
  }

  // Evening standby: 8:00 PM to 11:00 PM IST (5 minutes)
  if (hour >= 20 && hour < 23) {
    return { intervalMs: 5 * 60 * 1000, mode: 'Evening Standby (5m)' };
  }

  // Night quiet hours: 11:00 PM to 9:00 AM IST (15 minutes)
  return { intervalMs: 15 * 60 * 1000, mode: 'Night Quiet Hours (15m)' };
}

if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('monitor.mjs')) {
  main().catch(err => {
    console.error('[CLI] Fatal error:', err);
    process.exit(1);
  });
}
