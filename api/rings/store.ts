/**
 * Ring cards in the accounts database (db/migrations/0002_ring_cards.sql): a
 * row means its holder has shared their card; it holds what the card shows.
 */
import { CARD_REVISION, plainName, type CardLang, type RingCard } from '../../src/lib/ring-card';
import { avatarKey } from '../avatars';
import { hex } from '../ids';

/** A holder's choices for their card, shared or not. */
export interface CardSettings {
  shared: boolean;
  showName: boolean;
  showImage: boolean;
}

/** A shared card, as stored: the holder's details and what of them it shows. */
export interface SharedCard {
  userId: string;
  number: number;
  name: string;
  image: string | null;
  /** when the account was made: the day the ring was forged */
  since: string;
  showName: boolean;
  showImage: boolean;
}

/** The highest ring number an address may name; anything longer is not a ring. */
export const MAX_NUMBER = 999_999_999;

/** The card of ring `number`, if its holder shares it. */
export async function sharedCard(db: D1Database, number: number): Promise<SharedCard | null> {
  if (!Number.isSafeInteger(number) || number < 10000 || number > MAX_NUMBER) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.number, u.name, u.image, u.created_at, c.show_name, c.show_image
         FROM users u JOIN ring_cards c ON c.user_id = u.id
        WHERE u.number = ?1`,
    )
    .bind(number)
    .first<{ id: string; number: number; name: string; image: string | null; created_at: string; show_name: number; show_image: number }>();
  if (!row) return null;
  return {
    userId: row.id,
    number: row.number,
    name: row.name,
    image: row.image,
    since: row.created_at,
    showName: row.show_name === 1,
    showImage: row.show_image === 1,
  };
}

/** What a holder has chosen for their card; nothing shown and not shared until they say. */
export async function cardSettings(db: D1Database, userId: string): Promise<CardSettings> {
  const row = await db.prepare('SELECT show_name, show_image FROM ring_cards WHERE user_id = ?1').bind(userId).first<{ show_name: number; show_image: number }>();
  return { shared: !!row, showName: row?.show_name === 1, showImage: row?.show_image === 1 };
}

/** Share a holder's card, or change what a shared one shows. True if it was not shared before. */
export async function shareCard(db: D1Database, userId: string, show: { name: boolean; image: boolean }): Promise<boolean> {
  const now = new Date().toISOString();
  const name = show.name ? 1 : 0;
  const image = show.image ? 1 : 0;
  // one transaction: a row is added if there was none, then set either way
  const [added] = await db.batch([
    db
      .prepare('INSERT INTO ring_cards (user_id, show_name, show_image, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT (user_id) DO NOTHING')
      .bind(userId, name, image, now),
    db.prepare('UPDATE ring_cards SET show_name = ?2, show_image = ?3, updated_at = ?4 WHERE user_id = ?1').bind(userId, name, image, now),
  ]);
  return added.meta.changes > 0;
}

/** Stop sharing a holder's card. True if it was shared. */
export async function unshareCard(db: D1Database, userId: string): Promise<boolean> {
  const { meta } = await db.prepare('DELETE FROM ring_cards WHERE user_id = ?1').bind(userId).run();
  return meta.changes > 0;
}

/**
 * The holder's picture for their card: only the copy kept here
 * (/api/avatars/<their id>/...), never a sign-in provider's address.
 */
export function cardAvatar(image: string | null, userId: string): string | null {
  const key = image ? avatarKey(image) : null;
  return key?.startsWith(`avatars/${userId}/`) ? image : null;
}

/** A shared card as the world sees it, in one language. */
export function publicCard(card: SharedCard, lang: CardLang): RingCard {
  return {
    number: card.number,
    name: card.showName ? plainName(card.name).trim() || null : null,
    image: card.showImage ? cardAvatar(card.image, card.userId) : null,
    since: card.since,
    lang,
  };
}

/**
 * Twelve hex digits that change whenever the picture would: part of its
 * address, so the address of a card that changed is a new one.
 */
export async function cardVersion(card: RingCard): Promise<string> {
  const data = JSON.stringify([CARD_REVISION, card.number, card.name, card.image, card.since, card.lang]);
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))).slice(0, 12);
}

/** Where a shared card's picture is: /api/rings/<number>/card-<lang>-<version>.jpg */
export const cardImagePath = (card: RingCard, version: string) => `/api/rings/${card.number}/card-${card.lang}-${version}.jpg`;

/** Where a shared card's page is, in each language. */
export const cardPagePath = (number: number, lang: CardLang) => `${lang === 'zh' ? '/zh' : ''}/ring/${number}/`;
