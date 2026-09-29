import Head from 'next/head';
import Page from '@/components/ui/Page/Page';

const FAQS: { q: string; a: string }[] = [
  {
    q: 'What is Curv?',
    a: 'Curv is a token launchpad on Solana built on the Meteora Dynamic Bonding Curve. You design the curve shape, the fee schedule, and the graduation. Traders then buy and sell along your curve until it graduates.',
  },
  {
    q: 'How does a launch work?',
    a: 'Connect your wallet, name your token, pick a quote asset, and choose Quick launch or the Pro designer. Your pool goes live on its bonding curve the moment the launch transaction confirms.',
  },
  {
    q: 'What does it cost to launch?',
    a: 'Curv charges no pool creation fee. You only pay ordinary Solana network fees for the launch transaction.',
  },
  {
    q: 'What do creators earn?',
    a: 'Creators earn 0.3% of every bonding curve trade plus half of the migration fee collected at graduation. Earnings accrue automatically and you claim them with a signed transaction from your creator wallet.',
  },
  {
    q: 'What is graduation?',
    a: 'When the bonding curve fills, the pool automatically migrates its liquidity to a DAMM v2 pool, where trading continues with concentrated liquidity.',
  },
  {
    q: 'What can I pair my token with?',
    a: 'SOL, USDC, or any SPL mint you like. On mainnet that includes tokenized stocks such as xStocks.',
  },
  {
    q: 'What are xStocks?',
    a: 'xStocks are tokenized stocks issued by Backed Finance that trade on Solana. They use the Token-2022 token program. Availability depends on your jurisdiction, so check your local rules.',
  },
  {
    q: 'Do Token-2022 quote mints work with Curv?',
    a: 'Not yet proven. Curv has not verified DBC support for Token-2022 quote mints, so prove it with a devnet mock before trying on mainnet.',
  },
  {
    q: 'Quick launch or Pro designer?',
    a: 'Quick launch uses battle tested defaults: 1B supply, an exponential curve starting at 0.0001 quote units, trading fees easing from 5% to 1% over 60 slots, and automatic graduation. The Pro designer gives you full control over the curve shape, fee schedule, and graduation settings.',
  },
  {
    q: 'What is a vanity mint?',
    a: 'Curv keeps a warm pool of pre ground mint addresses ending in "curv". When one is available your launch is instant. Otherwise your browser can grind one locally, or you can launch with a random mint.',
  },
  {
    q: 'Which network is Curv on?',
    a: 'Curv is currently live on Solana devnet. Mainnet support is on the roadmap.',
  },
  {
    q: 'Is this financial advice?',
    a: 'No. Tokens are volatile and smart contracts carry risk. Never trade money you cannot afford to lose, and do your own research before launching or buying.',
  },
];

export default function FaqsPage() {
  return (
    <Page>
      <Head>
        <title>FAQs | Curv</title>
        <meta
          name="description"
          content="Frequently asked questions about launching tokens on Curv: fees, graduation, quote assets, and creator earnings."
        />
      </Head>
      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-8">
        <h1 className="text-2xl font-bold text-white">Frequently asked questions</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-neutral-400">
          Everything you need to know about launching on Curv.
        </p>
        <div className="mt-8 space-y-3">
          {FAQS.map((f) => (
            <details
              key={f.q}
              className="group rounded-2xl border border-neutral-800 bg-neutral-900/40 px-5 py-4 open:bg-neutral-900/70"
            >
              <summary className="cursor-pointer list-none text-[15px] font-semibold text-neutral-100 [&::-webkit-details-marker]:hidden">
                <span className="flex items-center justify-between gap-4">
                  {f.q}
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
              <p className="mt-3 text-[14px] leading-relaxed text-neutral-400">
                {f.a}
              </p>
            </details>
          ))}
        </div>
      </main>
    </Page>
  );
}
