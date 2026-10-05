import type { ComponentType } from 'react';
import XIcon from '@/icons/XIcon';
import TwitchIcon from '@/icons/TwitchIcon';
import RedditIcon from '@/icons/RedditIcon';

export type PayoutTypeId = 'wallet' | 'x' | 'twitch' | 'reddit' | 'traders';

export interface PayoutTypeDef {
  id: PayoutTypeId;
  label: string;
  tagline: string;
  howItWorks: string;
  Icon: ComponentType<{ className?: string }>;
}

/**
 * Registry of every way a creator can route their fees.
 * To add a new payout type (YouTube, Instagram, ...), add one entry
 * here with its icon, copy, and form. The picker and the recipient
 * cards render from this list, so nothing else needs to change.
 */
export const PAYOUT_TYPES: PayoutTypeDef[] = [
  {
    id: 'wallet',
    label: 'Wallet',
    tagline: 'Lock a share to a Solana address',
    howItWorks:
      'Paste the recipient\u2019s Solana address and only that wallet can ever claim the share. No verification needed.',
    Icon: ({ className = '' }: { className?: string }) => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden="true">
        <rect x="3" y="6" width="18" height="14" rx="3" />
        <path d="M3 10h18" strokeLinecap="round" />
        <circle cx="17" cy="15" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: 'x',
    label: 'X handle',
    tagline: 'They post a tweet to claim',
    howItWorks:
      'Name their X handle. They post a public tweet from that account containing their claim code and the Solana wallet that should be paid. We verify the tweet and lock the share to that wallet.',
    Icon: XIcon,
  },
  {
    id: 'twitch',
    label: 'Twitch',
    tagline: 'They log in with Twitch to claim',
    howItWorks:
      'Name their Twitch username. They log in with Twitch to prove the account is theirs, then connect the wallet that should be paid and sign once to bind it.',
    Icon: TwitchIcon,
  },
  {
    id: 'reddit',
    label: 'Reddit',
    tagline: 'They log in with Reddit to claim',
    howItWorks:
      'Name their Reddit username. They log in with Reddit to prove the account is theirs, then connect the wallet that should be paid and sign once to bind it.',
    Icon: RedditIcon,
  },
  {
    id: 'traders',
    label: 'Top traders',
    tagline: 'Reward your biggest buyers',
    howItWorks:
      'Reserve a share of your creator fees for the top net buyers at graduation. Winners are picked automatically by buy volume and paid in the normal claim flow.',
    Icon: ({ className = '' }: { className?: string }) => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden="true">
        <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M7 6H4a1 1 0 00-1 1c0 2.5 2 4 4 4M17 6h3a1 1 0 011 1c0 2.5-2 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export function getPayoutType(id: PayoutTypeId): PayoutTypeDef {
  return PAYOUT_TYPES.find((t) => t.id === id) ?? PAYOUT_TYPES[0];
}
