import { storage } from "../storage";
import type { Merchant } from "@shared/schema";

type EnrichedMerchant = Merchant & { displayPicture: string | null };

export async function enrichMerchantsWithAvatar(merchants: Merchant[]): Promise<EnrichedMerchant[]> {
  return Promise.all(
    merchants.map(async (m) => {
      let displayPicture: string | null = null;
      try {
        const user = await storage.getUserByUsername(m.username);
        if (user) {
          const profile = await storage.getUserProfile(user.id);
          const rawDp = profile?.displayPicture ?? null;
          displayPicture =
            rawDp && /\/api\/imageserver\/image\/[^/]+$/.test(rawDp)
              ? rawDp + "/data"
              : rawDp;
        }
      } catch {
        // silently skip — avatar will fall back to initials
      }
      return { ...m, displayPicture };
    })
  );
}
