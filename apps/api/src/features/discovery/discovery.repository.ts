import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { discoveryIgnored } from '../../db/schema.ts';

/**
 * The MACs the owner chose to hide from the Discovered section (spec §5.3).
 * The table is tiny, so the whole set is read whenever the document is built
 * and an ignore/unignore takes effect on the next read.
 */
export function createDiscoveryRepository(db: Db) {
  return {
    ignoredMacs(): Set<string> {
      return new Set(
        db
          .select()
          .from(discoveryIgnored)
          .all()
          .map((row) => row.mac),
      );
    },

    /** Idempotent: a second Ignore click changes nothing. */
    ignore(mac: string): void {
      db.insert(discoveryIgnored)
        .values({ mac, ignoredAt: new Date().toISOString() })
        .onConflictDoNothing()
        .run();
    },

    /** Idempotent: unignoring something that is not ignored is fine. */
    unignore(mac: string): void {
      db.delete(discoveryIgnored).where(eq(discoveryIgnored.mac, mac)).run();
    },
  };
}

export type DiscoveryRepository = ReturnType<typeof createDiscoveryRepository>;
