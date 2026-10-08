/**
 * What a ring card's page reads (src/pages/[...lang]/ring/[number].astro):
 * the card, if its holder shares it, from the accounts database.
 */
import { env } from 'cloudflare:workers';
import { cardImagePath, cardVersion, publicCard, sharedCard } from '../../api/rings/store';
import type { CardLang, RingCard } from './ring-card';

/** A shared card in one language, and where its picture is (on this site). */
export async function loadCard(number: number, lang: CardLang): Promise<{ card: RingCard; image: string } | null> {
  const shared = await sharedCard(env.DB, number);
  if (!shared) return null;
  const card = publicCard(shared, lang);
  return { card, image: cardImagePath(card, await cardVersion(card)) };
}
