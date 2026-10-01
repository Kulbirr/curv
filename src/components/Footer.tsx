/**
 * Site footer, styled after the curv-ui spec.
 * Docs points at the FAQ page, which is the current user documentation.
 * Terms and the social channels stay plain text: there are no real URLs to
 * point at yet, and a link to nowhere would be dishonest.
 */
import Link from 'next/link';

export default function Footer() {
  return (
    <footer className="sc-page-foot sc-reference-footer">
      <span>
        curv <i>© 2026 All rights reserved</i>
      </span>
      <div className="sc-footer-socials" aria-label="curv social channels">
        <span>Follow curv</span>
        <b>X</b>
        <b>Discord</b>
        <b>Telegram</b>
      </div>
      <span>
        <Link href="/faqs" prefetch={false}>
          <b>Docs</b>
        </Link>
        <b>Terms</b>
      </span>
    </footer>
  );
}
