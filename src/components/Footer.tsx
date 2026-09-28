/**
 * Site footer, styled after the curv-ui spec.
 * Social channels are plain text, not links: there are no real URLs to point
 * at yet, and a link to nowhere would be dishonest.
 */
export default function Footer() {
  return (
    <footer className="sc-page-foot sc-reference-footer">
      <span>
        curv <i>© 2024 All rights reserved</i>
      </span>
      <div className="sc-footer-socials" aria-label="curv social channels">
        <span>Follow curv</span>
        <b>X</b>
        <b>Discord</b>
        <b>Telegram</b>
      </div>
      <span>
        <b>Docs</b>
        <b>Terms</b>
      </span>
    </footer>
  );
}
