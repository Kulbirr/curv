import Head from 'next/head';
import Link from 'next/link';
import Page from '@/components/ui/Page/Page';

const SECTIONS: { h: string; body: string[] }[] = [
  {
    h: '1. What Curv is',
    body: [
      'Curv is a self service token launchpad on Solana. It provides software that lets you create a token, configure a Meteora Dynamic Bonding Curve for it, and trade it until the curve graduates its liquidity into a DAMM v2 pool. Curv does not issue tokens, does not take custody of your assets, and does not operate an exchange. Every transaction is executed by your own wallet signing on chain.',
    ],
  },
  {
    h: '2. Eligibility',
    body: [
      'You must be legally able to use blockchain based services in your jurisdiction. If your local laws restrict or prohibit token launches, trading, or interacting with decentralized protocols, you must not use Curv. It is your responsibility to know your local rules, including tax obligations. Nothing on this site is tax advice.',
    ],
  },
  {
    h: '3. Your wallet, your responsibility',
    body: [
      'You interact with Curv through a non custodial wallet that you control. Curv never sees, stores, or asks for your seed phrase or private keys. If you lose access to your wallet, nobody at Curv can recover your tokens or your earnings. You are responsible for the security of your own devices and wallets.',
    ],
  },
  {
    h: '4. Fees',
    body: [
      'Launching a token costs a pool creation fee plus ordinary Solana network fees. Every trade on a bonding curve pays the trading fee shown on the launch review screen and the token page before you confirm. At graduation a migration fee is taken from the migrating liquidity and split between the creator and Curv exactly as disclosed on the token page. All fees are final once confirmed on chain. Curv shows you the full fee math before you launch so there are no surprises.',
    ],
  },
  {
    h: '5. Creator commitments are permanent',
    body: [
      'Choices you make at launch are written into the pool configuration and signed by your wallet. Fee splits with collaborators, buyback and burn percentages, and the graduation settings cannot be changed after launch. Review the final review screen carefully before you sign.',
    ],
  },
  {
    h: '6. No guarantees',
    body: [
      'Curv makes no promises about token prices, trading volume, graduation, or earnings. A token can lose some or all of its value. Buyback and burn reduces supply but does not guarantee any price outcome. Past activity on the platform says nothing about future results.',
    ],
  },
  {
    h: '7. Acceptable use',
    body: [
      'You agree not to use Curv to launch tokens that impersonate real people, companies, or regulated securities, or to facilitate fraud, money laundering, or any other illegal activity. Curv may hide or delist the interface display of pools that violate this section, but on chain data remains public and outside our control.',
    ],
  },
  {
    h: '8. Third party protocols',
    body: [
      'Curv is built on Meteora programs and the Solana network. Those protocols have their own risks, including bugs, exploits, congestion, and downtime. Curv is not responsible for the behavior of third party protocols, wallets, RPC providers, or price feeds.',
    ],
  },
  {
    h: '9. Limitation of liability',
    body: [
      'To the maximum extent allowed by law, Curv is provided as is, without warranties of any kind. Curv and its operators are not liable for any loss of funds, lost profits, or other damages arising from your use of the platform, including losses caused by smart contract behavior, market movements, or your own errors.',
    ],
  },
  {
    h: '10. Changes',
    body: [
      'These terms may be updated as the product evolves. The version in force is the one published on this page. Continued use of Curv after a change means you accept the updated terms.',
    ],
  },
];

export default function TermsPage() {
  return (
    <Page>
      <Head>
        <title>Terms of Service | Curv</title>
        <meta
          name="description"
          content="The terms of service for using Curv, the Solana token launchpad built on Meteora's Dynamic Bonding Curve."
        />
      </Head>
      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-8">
        <h1 className="text-2xl font-bold text-white">Terms of Service</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-neutral-400">
          Last updated October 4, 2026. Please read these carefully before launching or trading.
        </p>
        <div className="mt-8 space-y-8">
          {SECTIONS.map((s) => (
            <section key={s.h}>
              <h2 className="text-[17px] font-semibold text-neutral-100">{s.h}</h2>
              {s.body.map((p, i) => (
                <p key={i} className="mt-2 text-[15px] leading-relaxed text-neutral-400">
                  {p}
                </p>
              ))}
            </section>
          ))}
        </div>
        <p className="mt-10 text-[15px] leading-relaxed text-neutral-400">
          Questions about these terms? See the{' '}
          <Link href="/risks" className="text-neutral-200 underline underline-offset-2">
            risk disclosure
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
