import Head from 'next/head';
import Link from 'next/link';
import Page from '@/components/ui/Page/Page';

const SECTIONS: { h: string; body: string[] }[] = [
  {
    h: '1. What we collect',
    body: [
      'Curv is designed to need as little of your data as possible. We do not ask for your name, email, or identity documents. When you use the site we may collect:',
    ],
  },
  {
    h: '2. Wallet addresses',
    body: [
      'Your public wallet address is visible to us when you connect a wallet, launch a token, trade, or claim earnings. Wallet addresses are public on the Solana blockchain by design. We store addresses linked to pools you create so we can show your launches, your earnings, and your fee splits.',
    ],
  },
  {
    h: '3. Usage data',
    body: [
      'We log basic technical events such as page views, API requests, and error reports to keep the service reliable and to detect abuse. This includes IP addresses, browser type, and timestamps. Rate limiting data is kept only as long as needed to enforce limits.',
    ],
  },
  {
    h: '4. Cookies and local storage',
    body: [
      'Curv uses browser local storage to remember your preferences, such as your selected wallet and display settings. We do not use third party advertising trackers.',
    ],
  },
  {
    h: '5. What we never collect',
    body: [
      'We never collect seed phrases, private keys, or wallet passwords. Any site or message asking for them is not us. We also do not sell your data, and we do not share it with advertisers.',
    ],
  },
  {
    h: '6. Third parties',
    body: [
      'The site is hosted on Vercel and reads chain data through RPC providers. Those providers process the requests your browser makes, subject to their own privacy policies. Embedded content such as token logos may load from external hosts.',
    ],
  },
  {
    h: '7. Data retention and deletion',
    body: [
      'Pool and transaction records are kept for as long as the service operates, because token pages and fee histories depend on them. If you want usage data linked to your IP address removed, contact us at hello@curvpad.fun and we will delete what we can. On chain records are public and permanent and cannot be deleted by us.',
    ],
  },
  {
    h: '8. Changes',
    body: [
      'This policy may be updated as the product evolves. The version in force is the one published on this page.',
    ],
  },
];

const COLLECT_LIST = [
  'Pages you visit and actions you take, for reliability and abuse prevention',
  'IP address and browser details, for rate limiting and debugging',
  'Preferences you set, stored locally in your browser',
];

export default function PrivacyPage() {
  return (
    <Page>
      <Head>
        <title>Privacy Policy | Curv</title>
        <meta
          name="description"
          content="How Curv handles your data: what we collect, what we never collect, and your rights."
        />
      </Head>
      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-8">
        <h1 className="text-2xl font-bold text-white">Privacy Policy</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-neutral-400">
          Last updated October 4, 2026. Short version: we collect the minimum needed to run the
          launchpad, and we never touch your keys.
        </p>
        <div className="mt-8 space-y-8">
          <section>
            <h2 className="text-[17px] font-semibold text-neutral-100">{SECTIONS[0].h}</h2>
            {SECTIONS[0].body.map((p, i) => (
              <p key={i} className="mt-2 text-[15px] leading-relaxed text-neutral-400">
                {p}
              </p>
            ))}
            <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-neutral-400">
              {COLLECT_LIST.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
          {SECTIONS.slice(1).map((s) => (
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
          Also see the{' '}
          <Link href="/terms" className="text-neutral-200 underline underline-offset-2">
            terms of service
          </Link>{' '}
          and the{' '}
          <Link href="/risks" className="text-neutral-200 underline underline-offset-2">
            risk disclosure
          </Link>
          .
        </p>
      </main>
    </Page>
  );
}
