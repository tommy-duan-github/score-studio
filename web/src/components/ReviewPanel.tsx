import { ArrowUpRight, Check, ListChecks } from 'lucide-react';
import type { ScoreDoc } from '../lib/types';
import { scrollToMeasure } from '../lib/verovio';
import { InfoTip } from './Controls';
import type { Edit } from './NotePanel';

export function ReviewPanel({ doc, busy, edit }: { doc: ScoreDoc; busy: boolean; edit: Edit }) {
  const remaining = doc.review.filter(item => item.resolved === null).length;
  return <div className="review-panel">
    <div className="panel-heading"><h2>Review</h2><span className="chip">{remaining} open</span>
      <InfoTip label="score review">The engraver flags uncertain musical choices. Jump to a bar, then choose an answer. Applying an answer re-engraves the score and can be undone. Unsupported options are disabled.</InfoTip>
    </div>
    {!doc.review.length && <div className="selection-empty"><ListChecks size={26} /><span>No review items</span></div>}
    {doc.review.map(item => <article className={`review-card ${item.resolved !== null ? 'resolved' : ''}`} key={item.id}>
      <div className="card-heading"><span className={`priority ${item.priority}`} />
        <span>{item.kind}</span><InfoTip label={`${item.kind} review`}>{`${item.priority} priority. ${item.question}`}</InfoTip>
        {item.resolved !== null && <Check size={15} className="resolved-check" />}
      </div>
      {item.measures && <button className="bar-link" onClick={() => item.measures && scrollToMeasure(item.measures[0])}>Bars {item.measures[0]}–{item.measures[1]}<ArrowUpRight size={13} /></button>}
      <p>{item.question}</p>
      <div className="review-options">{item.options.map(option => {
        const unsupported = option.supported === false || option.disabled === true;
        return <div key={option.index}>
          <button className="button ghost small" disabled={busy || unsupported} aria-pressed={item.resolved === option.index}
            onClick={() => void edit([{ op: 'resolve_review', review_id: item.id, option: option.index }], `Review: ${option.label}`)}>{option.label}</button>
          {unsupported && <InfoTip label={option.label}>This option is not supported by the current engraver.</InfoTip>}
        </div>;
      })}</div>
    </article>)}
  </div>;
}
