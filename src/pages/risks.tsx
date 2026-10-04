import Head from 'next/head';
import Link from 'next/link';
import Page from '@/components/ui/Page/Page';

const RISKS: { h: string; body: string }[] = [
  {
    h: 'Tokens can go to zero',
    body: 'Every token launched on Curv is a volatile crypto asset. Prices are set by supply and demand on the bonding curve and later on the open market. A token can lose part or all of its value quickly. Never trade money you cannot afford to lose.',
  },
  {
    h: 'Smart contract risk',
    body: 'Curv runs on Meteora programs and the Solana blockchain. Smart contracts can contain bugs and can be exploited. An exploit could drain a pool or freeze funds. Audits reduce this risk but never remove it.',
  },
  {
    h: 'Graduation is not guaranteed',
    body: 'A bonding curve graduates only if enough buying pressure fills it. Many tokens never graduate. If a curve never fills, the liquidity stays on the curve and there is no migration to a DAMM v2 pool.',
  },
  {
    h: 'Liquidity lock means no exit for LPs',
    body: 'Graduated pools lock 100% of their liquidity permanently. Nobody, not the creator and not Curv, can withdraw it. That protects traders from rug pulls, but it also means locked liquidity can never be reclaimed.',
  },
  {
    h: 'Buyback and burn is not a price promise',
    body: 'When a creator commits a share of fees to buyback and burn, that slice buys the token and destroys it, reducing supply. Reduced supply does not guarantee a higher price. Do not treat a burn commitment as investment advice or a return promise.',
  },
  {
    h: 'Fee splits and recipients',
    body: 'Creator fee splits are fixed at launch and cannot be changed. If a creator lists collaborators, verify the split on the token page before you buy. Curv executes the split exactly as configured but cannot resolve disputes between collaborators.',
  },
  {
    h: 'Network and wallet risk',
    body: 'Solana congestion can delay or fail transactions. You may pay network fees for transactions that fail. If you lose your wallet keys, your tokens and unclaimed earnings are gone permanently.',
  },
  {
    h: 'Regulatory risk',
    body: 'Crypto regulation differs by country and changes over time. A token that is fine to trade today could face restrictions tomorrow. You are responsible for complying with the laws where you live, including tax reporting.',
  },
  {
    h: 'Scams and impersonation',
    body: 'Anyone can launch a token with any name and ticker. A token named after a real project, person, or stock is not endorsed by them. Always verify the pool address from a source you trust before trading.',
  },
];

export default function RisksPage() {
  return (
    <Page>
      <Head>
        <title>Risk Disclosure | Curv</title>
        <meta
          name="description"
          content="The risks of launching and trading tokens on Curv: volatility, smart contracts, graduation, and regulation."
        />
      </Head>
      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-8">
        <h1 className="text-2xl font-bold text-white">Risk Disclosure</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-neutral-400">
          Crypto is risky. Read this before you launch a token or buy one.
        </p>
        <div className="mt-8 space-y-3">
          {RISKS.map((r) => (
            <details
              key={r.h}
              className="group rounded-2xl border border-neutral-800 bg-neutral-900/40 px-5 py-4 open:bg-neutral-900/70"
            >
              <summary className="cursor-pointer list-none text-[15px] font-semibold text-neutral-100 [&::-webkit-details-marker]:hidden">
                <span className="flex items-center justify-between gap-4">
                  {r.h}
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    className="h-4 w-4 shrink-0 text-neutral-500 transition-transform group-open:rotate-180"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </span>
              </summary>
              <p className="mt-3 text-[15px] leading-relaxed text-neutral-400">{r.body}</p>
            </details>
          ))}
        </div>
        <p className="mt-10 text-[15px] leading-relaxed text-neutral-400">
          This is not financial advice. Also see the{' '}
          <Link href="/terms" className="text-neutral-200 underline underline-offset-2">
            terms of service
          </Link>{' '}
          and the{' '}
          <Link href="/faqs" className="text-neutral-200 underline underline-offset-2">
            FAQs
          </Link>
          .
        </p>
      </main>
    </Page>
  );
}
