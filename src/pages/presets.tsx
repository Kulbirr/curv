import Head from 'next/head';
import Link from 'next/link';
import Page from '@/components/ui/Page/Page';
import { presetViews, type PresetView } from '@/lib/presets';

/**
 * Curve-shape preview drawn from the preset's REAL multipliers
 * (the same numbers the launch flow applies), normalized to the chart box.
 */
function shapePath(shape: number[]): string {
  const min = Math.min(...shape);
  const max = Math.max(...shape);
  const span = max - min || 1;
  const pts = shape.map((m, i) => {
    const x = 4 + (i * 152) / (shape.length - 1);
    const y = 67 - ((m - min) / span) * 59;
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return `M${pts.join(' L')}`;
}

function formatMultiple(v: number): string {
  return `${parseFloat(v.toFixed(2))}x`;
}

function PresetCard({ preset, featured }: { preset: PresetView; featured: boolean }) {
  return (
    <article className={`sc-preset-card${featured ? ' featured' : ''}`}>
      {featured && <span className="sc-preset-badge">Default</span>}
      <h2>{preset.name}</h2>
      <p
        style={{
          margin: '6px 0 0',
          color: '#8b948b',
          fontSize: 10,
          lineHeight: 1.5,
        }}
      >
        {preset.blurb}
      </p>
      <div className="sc-preset-chart">
        <svg
          viewBox="0 0 160 78"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${preset.name} price curve shape`}
        >
          <line x1="4" y1="67" x2="156" y2="67" />
          <line x1="4" y1="8" x2="4" y2="67" />
          <path d={shapePath(preset.shape)} />
        </svg>
        <div>
          <span>Supply</span>
          <span>Price</span>
        </div>
      </div>
      <dl className="sc-preset-parameters">
        <div>
          <dt>Curve segments</dt>
          <dd className="sc-number">{preset.segments}</dd>
        </div>
        <div>
          <dt>End price</dt>
          <dd className="sc-number">{formatMultiple(preset.endMultiple)} start</dd>
        </div>
      </dl>
      <Link
        className={`sc-button ${featured ? 'sc-button-primary' : 'sc-button-secondary'}`}
        href={`/create-pool?preset=${preset.id}`}
      >
        Use this preset
      </Link>
    </article>
  );
}

export default function PresetsPage() {
  const presets = presetViews();
  const defaultId = 'exponential';

  return (
    <Page>
      <Head>
        <title>Curve Presets, Curv</title>
      </Head>
      <main className="sc-presets-page">
        <section className="sc-presets-heading">
          <div>
            <h1>
              Curve <em>Presets</em>
            </h1>
            <p>
              Ready made bonding curves that set the price path your token
              follows to graduation. Pick one to start your launch with it
              applied.
            </p>
          </div>
        </section>
        <section className="sc-presets-grid" aria-label="Curve preset list">
          {presets.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              featured={preset.id === defaultId}
            />
          ))}
        </section>
        <section className="sc-preset-compare">
          <h2>Compare presets</h2>
          <div className="sc-preset-table-wrap">
            <table className="sc-preset-table">
              <thead>
                <tr>
                  <th>Parameter</th>
                  {presets.map((p) => (
                    <th key={p.id}>{p.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>Curve segments</th>
                  {presets.map((p) => (
                    <td key={p.id} className="sc-number">
                      {p.segments}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th>End price multiple</th>
                  {presets.map((p) => (
                    <td key={p.id} className="sc-number">
                      {formatMultiple(p.endMultiple)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </Page>
  );
}
