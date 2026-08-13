import { useEffect, useMemo, useRef, useState } from 'react';

import { formatLength, parseLength, type UnitSystem } from '../../format/units.js';
import { IconCalculator } from './icons.js';
import { SnappySlider } from './SnappySlider.js';

interface Props {
  open: boolean;
  units: UnitSystem;
  roomWidth?: number;
  roomHeight?: number;
  onClose: () => void;
}

type Mode = 'quick' | 'room' | 'seating' | 'spread' | 'stage' | 'convert';
type SpreadMode = 'between' | 'around';

interface CalculationHistoryEntry {
  expression: string;
  result: number;
}

const FOOT = 120;
const METRE = 393.7007874015748;
const round = (value: number, digits = 1) => Number.isFinite(value) ? value.toFixed(digits).replace(/\.0+$/, '') : '—';
const positive = (value: number | null, fallback = 0) => value != null && value > 0 ? value : fallback;

/** A deliberately small arithmetic parser: numbers, parentheses and common calculator operators. */
export function evaluateMath(input: string): number | null {
  const source = input
    .replace(/[×x]/gi, '*')
    .replace(/÷/g, '/')
    .replace(/[−–]/g, '-')
    .replace(/\s+/g, '');
  if (!source) return null;
  let index = 0;
  const expression = (): number | null => {
    let value = term();
    if (value == null) return null;
    while (source[index] === '+' || source[index] === '-') {
      const operator = source[index++];
      const right = term();
      if (right == null) return null;
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  };
  const term = (): number | null => {
    let value = power();
    if (value == null) return null;
    while (source[index] === '*' || source[index] === '/') {
      const operator = source[index++];
      const right = power();
      if (right == null || (operator === '/' && right === 0)) return null;
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  };
  const power = (): number | null => {
    const left = factor();
    if (left == null) return null;
    if (source[index] !== '^') return left;
    index++;
    const right = power();
    return right == null ? null : left ** right;
  };
  const factor = (): number | null => {
    if (source[index] === '+' || source[index] === '-') {
      const sign = source[index++] === '-' ? -1 : 1;
      const value = factor();
      return value == null ? null : sign * value;
    }
    let value: number | null;
    if (source[index] === '(') {
      index++;
      value = expression();
      if (source[index] !== ')') return null;
      index++;
    } else {
      const match = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
      if (!match) return null;
      index += match[0].length;
      value = Number(match[0]);
    }
    while (source[index] === '%') {
      value = value == null ? null : value / 100;
      index++;
    }
    return value;
  };
  const value = expression();
  return value != null && index === source.length && Number.isFinite(value) ? value : null;
}

export default function SpaceCalculator({ open, units, roomWidth, roomHeight, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('quick');
  const [expression, setExpression] = useState('60 * 40');
  const [width, setWidth] = useState(() => roomWidth ? formatLength(roomWidth, units) : units === 'metric' ? '20m' : "60'");
  const [depth, setDepth] = useState(() => roomHeight ? formatLength(roomHeight, units) : units === 'metric' ? '12m' : "40'");
  const [aislePercent, setAislePercent] = useState(20);
  const [areaPerPersonDraft, setAreaPerPersonDraft] = useState('10');
  const areaPerPerson = (() => {
    const n = Number(areaPerPersonDraft);
    return Number.isFinite(n) && n > 0 ? n : 10;
  })();
  const [seatWidth, setSeatWidth] = useState(units === 'metric' ? '50cm' : '20"');
  const [rowSpacing, setRowSpacing] = useState(units === 'metric' ? '90cm' : '3\'');
  const [sideAisle, setSideAisle] = useState(units === 'metric' ? '1.2m' : '4\'');
  const [centreAisle, setCentreAisle] = useState(units === 'metric' ? '1.2m' : '4\'');
  const [itemWidth, setItemWidth] = useState(units === 'metric' ? '1.8m' : '6\'');
  const [minimumGap, setMinimumGap] = useState(units === 'metric' ? '60cm' : '2\'');
  const [spreadCountDraft, setSpreadCountDraft] = useState('8');
  const spreadCount = (() => {
    const n = Number(spreadCountDraft);
    return Number.isFinite(n) && n > 0 ? n : 8;
  })();
  const [spreadMode, setSpreadMode] = useState<SpreadMode>('between');
  const [stageWidth, setStageWidth] = useState(units === 'metric' ? '9.6m' : '32\'');
  const [stageDepth, setStageDepth] = useState(units === 'metric' ? '4.8m' : '16\'');
  const [deckWidth, setDeckWidth] = useState('4\'');
  const [deckDepth, setDeckDepth] = useState('8\'');
  const [convertValue, setConvertValue] = useState(units === 'metric' ? '3m' : "10'");
  const [history, setHistory] = useState<CalculationHistoryEntry[]>([]);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current && roomWidth && roomHeight) {
      setWidth(formatLength(roomWidth, units));
      setDepth(formatLength(roomHeight, units));
    }
    wasOpen.current = open;
  }, [open, roomWidth, roomHeight, units]);

  const result = useMemo(() => {
    const w = positive(parseLength(width, units));
    const d = positive(parseLength(depth, units));
    const areaFeet = (w / FOOT) * (d / FOOT);
    const areaMetres = (w / METRE) * (d / METRE);
    const usableAreaFeet = areaFeet * Math.max(0, 1 - aislePercent / 100);
    const densityCapacity = Math.floor(usableAreaFeet / Math.max(1, areaPerPerson));
    const sw = positive(parseLength(seatWidth, units));
    const rs = positive(parseLength(rowSpacing, units));
    const side = positive(parseLength(sideAisle, units));
    const centre = positive(parseLength(centreAisle, units));
    const rowRun = Math.max(0, w - side * 2 - centre);
    const seatsPerRow = sw ? Math.floor(rowRun / sw) : 0;
    const rows = rs ? Math.floor(Math.max(0, d - side * 2) / rs) : 0;
    const geometryCapacity = seatsPerRow * rows;

    const iw = positive(parseLength(itemWidth, units));
    const gap = positive(parseLength(minimumGap, units));
    const fitCount = iw ? Math.max(0, Math.floor((w + gap) / (iw + gap))) : 0;
    const requestedCount = Math.max(1, Math.floor(spreadCount || 1));
    const spreadRemainder = w - requestedCount * iw;
    const betweenGap = requestedCount > 1 ? spreadRemainder / (requestedCount - 1) : 0;
    const aroundGap = spreadRemainder / (requestedCount + 1);
    const equalGap = spreadMode === 'between' ? betweenGap : aroundGap;

    const stw = positive(parseLength(stageWidth, units));
    const std = positive(parseLength(stageDepth, units));
    const dw = positive(parseLength(deckWidth, units));
    const dd = positive(parseLength(deckDepth, units));
    const across = dw ? Math.ceil(stw / dw) : 0;
    const deep = dd ? Math.ceil(std / dd) : 0;

    const converted = parseLength(convertValue, units);
    return {
      w,
      d,
      areaFeet,
      areaMetres,
      perimeter: 2 * (w + d),
      usableAreaFeet,
      densityCapacity,
      seatsPerRow,
      rows,
      geometryCapacity,
      fitCount,
      equalGap,
      spreadRemainder,
      requestedCount,
      centreSpacing: requestedCount > 1 ? iw + equalGap : 0,
      edgeClearance: spreadMode === 'around' ? equalGap : requestedCount === 1 ? spreadRemainder / 2 : 0,
      across,
      deep,
      decks: across * deep,
      stageAreaFeet: (stw / FOOT) * (std / FOOT),
      converted,
      quick: evaluateMath(expression),
    };
  }, [width, depth, units, aislePercent, areaPerPerson, seatWidth, rowSpacing, sideAisle, centreAisle, itemWidth, minimumGap, spreadCount, spreadMode, stageWidth, stageDepth, deckWidth, deckDepth, convertValue, expression]);

  if (!open) return null;

  const lengthInput = (label: string, value: string, setValue: (value: string) => void) => (
    <label className="calc-field">
      <span>{label}</span>
      <input value={value} onChange={(event) => setValue(event.target.value)} />
    </label>
  );

  const commitExpression = () => {
    const value = evaluateMath(expression);
    if (value == null) return;
    setHistory((current) => [{ expression, result: value }, ...current.filter((entry) => entry.expression !== expression)].slice(0, 6));
    setExpression(String(Number(value.toFixed(8))));
  };

  const pressCalculatorKey = (key: string) => {
    if (key === 'C') {
      setExpression('');
      return;
    }
    if (key === '⌫') {
      setExpression((current) => current.slice(0, -1));
      return;
    }
    if (key === '=') {
      commitExpression();
      return;
    }
    if (key === '±') {
      setExpression((current) => current.startsWith('-(') && current.endsWith(')') ? current.slice(2, -1) : current ? `-(${current})` : '-');
      return;
    }
    setExpression((current) => `${current}${key}`);
  };

  return (
    <aside className="space-calculator" role="complementary" aria-labelledby="space-calculator-title">
        <header className="space-calculator-header">
          <span className="space-calculator-mark"><IconCalculator size={20} /></span>
          <span>
            <small>Quick planning math</small>
            <strong id="space-calculator-title">Space calculator</strong>
          </span>
          <button type="button" onClick={onClose} aria-label="Close space calculator">×</button>
        </header>
        <nav className="space-calculator-tabs" aria-label="Calculator mode">
          {([
            ['quick', 'Quick'],
            ['room', 'Room'],
            ['seating', 'Seating'],
            ['spread', 'Spread'],
            ['stage', 'Stage'],
            ['convert', 'Convert'],
          ] as Array<[Mode, string]>).map(([id, label]) => (
            <button key={id} className={mode === id ? 'is-active' : ''} onClick={() => setMode(id)}>{label}</button>
          ))}
        </nav>
        <div className="space-calculator-body">
          {mode === 'quick' && (
            <>
              <label className="calc-field calc-expression">
                <span>Arithmetic</span>
                <input
                  value={expression}
                  onChange={(event) => setExpression(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitExpression();
                    }
                  }}
                  placeholder="Example: (60 × 40) ÷ 10"
                  autoFocus
                />
              </label>
              <div className="calc-quick-layout">
                <div className="calc-keypad" aria-label="Calculator keypad">
                  {['C', '(', ')', '⌫', '7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '−', '0', '.', '%', '+', '±', '^', '='].map((key) => (
                    <button
                      type="button"
                      key={key}
                      className={`${/[÷×−+^]/.test(key) ? 'is-operator' : ''}${key === '=' ? ' is-equals' : ''}`}
                      onClick={() => pressCalculatorKey(key)}
                      aria-label={key === '⌫' ? 'Delete last character' : key === 'C' ? 'Clear calculation' : key}
                    >
                      {key}
                    </button>
                  ))}
                </div>
                <article className="calc-live-result" aria-live="polite">
                  <small>Result</small>
                  <strong>{result.quick == null ? '—' : round(result.quick, 3)}</strong>
                  <span>Enter or = saves the answer</span>
                </article>
              </div>
              {history.length > 0 && (
                <section className="calc-history" aria-label="Calculation history">
                  <header><strong>Recent calculations</strong><button type="button" onClick={() => setHistory([])}>Clear</button></header>
                  {history.map((entry, index) => (
                    <button type="button" key={`${entry.expression}-${index}`} onClick={() => setExpression(String(entry.result))}>
                      <span>{entry.expression}</span><strong>{round(entry.result, 4)}</strong>
                    </button>
                  ))}
                </section>
              )}
              <p className="calc-caution">Supports +, −, ×, ÷, parentheses, percentages, and powers. Use the planning tabs when dimensions and units matter.</p>
            </>
          )}
          {mode === 'room' && (
            <>
              <div className="calc-fields two">{lengthInput('Width', width, setWidth)}{lengthInput('Depth', depth, setDepth)}</div>
              <div className="calc-results">
                <article><small>Area</small><strong>{round(result.areaFeet)} ft²</strong><span>{round(result.areaMetres)} m²</span></article>
                <article><small>Perimeter</small><strong>{formatLength(result.perimeter, units)}</strong><span>2 × (width + depth)</span></article>
                <article><small>Aspect</small><strong>{result.d ? round(result.w / result.d, 2) : '—'} : 1</strong><span>width to depth</span></article>
              </div>
            </>
          )}
          {mode === 'seating' && (
            <>
              <div className="calc-fields two">{lengthInput('Room width', width, setWidth)}{lengthInput('Room depth', depth, setDepth)}</div>
              <div className="calc-fields three">
                <SnappySlider
                  label="Aisles / circulation"
                  values={[0, 10, 20, 30, 40, 60, 80]}
                  defaultValue={20}
                  min={0}
                  max={80}
                  step={1}
                  suffix="%"
                  compact
                  value={aislePercent}
                  onChange={setAislePercent}
                />
                <label className="calc-field"><span>Area per person</span><input type="number" min="1" value={areaPerPersonDraft} onChange={(event) => setAreaPerPersonDraft(event.target.value)} onBlur={() => { const n = Number(areaPerPersonDraft); if (!Number.isFinite(n) || n < 1) setAreaPerPersonDraft('10'); }} /><em>ft²</em></label>
                {lengthInput('Seat width', seatWidth, setSeatWidth)}
              </div>
              <div className="calc-fields three">{lengthInput('Row spacing', rowSpacing, setRowSpacing)}{lengthInput('Side aisles', sideAisle, setSideAisle)}{lengthInput('Centre aisle', centreAisle, setCentreAisle)}</div>
              <div className="calc-results">
                <article><small>Usable floor</small><strong>{round(result.usableAreaFeet)} ft²</strong><span>after circulation</span></article>
                <article><small>Density estimate</small><strong>{result.densityCapacity.toLocaleString()}</strong><span>usable area ÷ ft²/person</span></article>
                <article><small>Row layout</small><strong>{result.geometryCapacity.toLocaleString()}</strong><span>{result.rows} rows × {result.seatsPerRow} seats</span></article>
              </div>
              <p className="calc-caution">Planning estimate only. Final occupancies, exit widths, accessibility, and fire-code clearances must be verified for the venue and jurisdiction.</p>
            </>
          )}
          {mode === 'spread' && (
            <>
              <div className="calc-fields two">{lengthInput('Available run', width, setWidth)}{lengthInput('Item width', itemWidth, setItemWidth)}</div>
              <div className="calc-fields two">
                <label className="calc-field"><span>Items to spread</span><input type="number" min="1" step="1" value={spreadCountDraft} onChange={(event) => setSpreadCountDraft(event.target.value)} onBlur={() => { const n = Number(spreadCountDraft); if (!Number.isFinite(n) || n < 1) setSpreadCountDraft('8'); }} /></label>
                {lengthInput('Minimum gap', minimumGap, setMinimumGap)}
              </div>
              <div className="calc-spread-mode" role="group" aria-label="Spread method">
                <button type="button" className={spreadMode === 'between' ? 'is-active' : ''} onClick={() => setSpreadMode('between')}>
                  <strong>Space between</strong><span>First and last items touch the run edges</span>
                </button>
                <button type="button" className={spreadMode === 'around' ? 'is-active' : ''} onClick={() => setSpreadMode('around')}>
                  <strong>Space around</strong><span>Equal clearance at both run edges</span>
                </button>
              </div>
              <div className="calc-results">
                <article><small>Maximum that fit</small><strong>{result.fitCount}</strong><span>using the minimum gap</span></article>
                <article className={result.equalGap < 0 ? 'is-warning' : ''}><small>Equal gap</small><strong>{result.equalGap < 0 ? 'Does not fit' : formatLength(result.equalGap, units)}</strong><span>{result.requestedCount} items · {spreadMode === 'between' ? 'between items' : 'around items'}</span></article>
                <article><small>Centre to centre</small><strong>{result.equalGap < 0 || result.requestedCount < 2 ? '—' : formatLength(result.centreSpacing, units)}</strong><span>{result.requestedCount < 2 ? 'add another item to repeat' : 'repeat spacing'}</span></article>
                <article><small>Edge clearance</small><strong>{result.equalGap < 0 ? '—' : formatLength(result.edgeClearance, units)}</strong><span>{spreadMode === 'between' ? 'items align to edges' : 'same at both ends'}</span></article>
              </div>
              {result.requestedCount > 1 && result.equalGap < positive(parseLength(minimumGap, units)) && result.equalGap >= 0 && (
                <p className="calc-caution">This spread fits, but its equal gap is below your minimum. Reduce the item count or use a longer run.</p>
              )}
            </>
          )}
          {mode === 'stage' && (
            <>
              <div className="calc-fields two">{lengthInput('Stage width', stageWidth, setStageWidth)}{lengthInput('Stage depth', stageDepth, setStageDepth)}</div>
              <div className="calc-fields two">{lengthInput('Deck width', deckWidth, setDeckWidth)}{lengthInput('Deck depth', deckDepth, setDeckDepth)}</div>
              <div className="calc-results">
                <article><small>Deck count</small><strong>{result.decks}</strong><span>{result.across} across × {result.deep} deep</span></article>
                <article><small>Stage area</small><strong>{round(result.stageAreaFeet)} ft²</strong><span>nominal footprint</span></article>
                <article><small>Deck orientation</small><strong>{formatLength(positive(parseLength(deckWidth, units)), units)} × {formatLength(positive(parseLength(deckDepth, units)), units)}</strong><span>stock module</span></article>
              </div>
            </>
          )}
          {mode === 'convert' && (
            <>
              <div className="calc-fields one">{lengthInput('Length to convert', convertValue, setConvertValue)}</div>
              <div className="calc-results">
                <article><small>Feet / inches</small><strong>{result.converted == null ? '—' : formatLength(result.converted, 'imperial')}</strong><span>{result.converted == null ? 'Enter a length' : `${round(result.converted / 10, 2)} inches`}</span></article>
                <article><small>Metric</small><strong>{result.converted == null ? '—' : formatLength(result.converted, 'metric')}</strong><span>{result.converted == null ? 'Enter a length' : `${round(result.converted / METRE, 3)} metres`}</span></article>
              </div>
            </>
          )}
        </div>
    </aside>
  );
}
