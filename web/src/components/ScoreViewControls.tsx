import { t } from '../lib/i18n';
import { GalleryHorizontal, LayoutGrid, Minus, Plus, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { InfoTip, Label, Popover, Segmented } from './Controls';
import {
  DEFAULT_VIEW, STAFF_MAX, STAFF_MIN, ZOOM_MAX, ZOOM_MIN, clamp, type ScoreLayout, type ViewPrefs,
} from '../lib/view';

const BARS_PER_LINE = [0, 2, 3, 4, 5, 6, 8];

interface Props {
  view: ViewPrefs;
  onChange: (patch: Partial<ViewPrefs>) => void;
}

export function ScoreViewControls({ view, onChange }: Props) {
  const zoomBy = (step: number) => onChange({ zoom: clamp(view.zoom + step, ZOOM_MIN, ZOOM_MAX) });
  const densityChanged = view.staffSize !== DEFAULT_VIEW.staffSize || view.barsPerLine !== DEFAULT_VIEW.barsPerLine;

  return <div className="score-view-controls">
    <Segmented<ScoreLayout>
      label={t("Page layout")}
      value={view.layout}
      className="layout-control"
      options={[
        { value: 'pages', label: <><LayoutGrid size={13} />{t("Pages")}</> },
        { value: 'strip', label: <><GalleryHorizontal size={13} />{t("Side-scroll")}</> },
      ]}
      onChange={layout => onChange({ layout })}
    />
    <InfoTip label={t("page layout")}>{t("Pages scrolls down with pages side by side when space allows; Side-scroll puts them in one horizontal row. Ctrl/⌘ + mouse wheel changes zoom.")}</InfoTip>

    <Popover label={t("Density")} icon={<SlidersHorizontal size={14} />} className="density-control">
      <div className="density-panel">
        <div className="density-row">
          <Label tip={t("Size of the staves on the page. Smaller staves fit more bars on each line and more lines on each page.")}>{t("Staff size")}</Label>
          <span className="density-value">{Math.round(view.staffSize / DEFAULT_VIEW.staffSize * 100)}%</span>
        </div>
        <input
          aria-label={t("Staff size")}
          type="range"
          min={STAFF_MIN}
          max={STAFF_MAX}
          step={2}
          defaultValue={view.staffSize}
          key={view.staffSize}
          onPointerUp={event => onChange({ staffSize: Number(event.currentTarget.value) })}
          onKeyUp={event => onChange({ staffSize: Number(event.currentTarget.value) })}
        />
        <div className="density-row">
          <Label tip={t("Auto lets the engraver break lines by spacing. A number forces exactly that many bars on every line.")}>{t("Bars per line")}</Label>
        </div>
        <div className="chips" role="radiogroup" aria-label={t("Bars per line")}>
          {BARS_PER_LINE.map(count => <button
            key={count}
            type="button"
            role="radio"
            className="chip"
            aria-checked={view.barsPerLine === count}
            onClick={() => onChange({ barsPerLine: count })}
          >{count === 0 ? t("Auto") : count}</button>)}
        </div>
        <button
          type="button"
          className="button ghost small density-reset"
          disabled={!densityChanged}
          onClick={() => onChange({ staffSize: DEFAULT_VIEW.staffSize, barsPerLine: DEFAULT_VIEW.barsPerLine })}
        ><RotateCcw size={13} />{t("Default")}</button>
      </div>
    </Popover>

    <div className="zoom-control glass glass-pill">
      <button className="icon-button" aria-label={t("Zoom out")} disabled={view.zoom <= ZOOM_MIN} onClick={() => zoomBy(-10)}>
        <Minus size={14} />
      </button>
      <button className="zoom-fit" aria-label={t("Reset zoom to 100%")} onClick={() => onChange({ zoom: 100 })}>
        {view.zoom}%
      </button>
      <button className="icon-button" aria-label={t("Zoom in")} disabled={view.zoom >= ZOOM_MAX} onClick={() => zoomBy(10)}>
        <Plus size={14} />
      </button>
    </div>
  </div>;
}
