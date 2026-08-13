/**
 * SnappySlider — marked range control with snap points, typed value, and
 * double-click reset. Styled for Groundplan panels (no Tailwind).
 *
 * While dragging, the thumb tracks local state immediately so the UI stays
 * live even when the parent `value` updates asynchronously.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type LabelHTMLAttributes,
} from 'react';

export interface SnappySliderProps {
  values: number[];
  defaultValue: number;
  value?: number;
  resetKey?: number;
  snapping?: boolean;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  /** Fired when a drag or typed edit finishes (blur / pointer up). */
  onChangeEnd?: (value: number) => void;
  config?: {
    snappingThreshold?: number;
    labelFormatter?: (value: number) => string;
  };
  label: string;
  prefix?: string;
  suffix?: string;
  className?: string;
  disabled?: boolean;
  compact?: boolean;
}

function formatNumber(value: number, step = 1): string {
  const numValue = Number(value);
  if (Number.isNaN(numValue)) return '0';
  const decimalPlaces = step.toString().split('.')[1]?.length || 0;
  if (decimalPlaces === 0 && Number.isInteger(numValue)) return String(numValue);
  return numValue.toFixed(decimalPlaces);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export const SnappySlider = forwardRef<HTMLDivElement, SnappySliderProps>(
  function SnappySlider(
    {
      values,
      defaultValue,
      value,
      resetKey,
      snapping = true,
      min: providedMin,
      max: providedMax,
      step,
      onChange,
      onChangeEnd,
      config = {},
      label,
      prefix,
      suffix,
      className,
      disabled = false,
      compact = false,
    },
    ref,
  ) {
    const sliderRef = useRef<HTMLDivElement>(null);
    const labelId = useId();
    const { snappingThreshold = 1, labelFormatter } = config;

    const defaultValueArray = [...values, defaultValue].sort((a, b) => a - b);
    const inputMin = providedMin ?? Math.min(...defaultValueArray);
    const inputMax = providedMax ?? Math.max(...defaultValueArray);
    const sliderValues =
      providedMin !== undefined && providedMax !== undefined
        ? defaultValueArray.filter((v) => v >= providedMin && v <= providedMax)
        : defaultValueArray;
    const sliderMin = Math.min(...sliderValues);
    const sliderMax = Math.max(...sliderValues);
    const computedStep = step ?? (/\bduration\b/i.test(label) ? 1 : 0.1);
    const span = Math.max(sliderMax - sliderMin, Number.EPSILON);

    const [internalValue, setInternalValue] = useState(value ?? defaultValue);
    const [dragging, setDragging] = useState(false);
    const draggingRef = useRef(false);
    const liveValueRef = useRef(internalValue);
    const onChangeRef = useRef(onChange);
    const onChangeEndRef = useRef(onChangeEnd);
    onChangeRef.current = onChange;
    onChangeEndRef.current = onChangeEnd;

    // Prefer local value while dragging so the thumb never waits on parent IPC/state.
    const currentValue = dragging || value === undefined ? internalValue : value;
    const [inputValue, setInputValue] = useState(formatNumber(currentValue, computedStep));
    const isOutOfBounds = currentValue < sliderMin || currentValue > sliderMax;
    const sliderPercentage =
      ((clamp(currentValue, sliderMin, sliderMax) - sliderMin) / span) * 100;

    liveValueRef.current = currentValue;

    useEffect(() => {
      if (draggingRef.current) return;
      if (value === undefined) return;
      setInternalValue(value);
      setInputValue(formatNumber(value, computedStep));
    }, [value, computedStep]);

    useEffect(() => {
      if (resetKey === undefined) return;
      draggingRef.current = false;
      setDragging(false);
      setInternalValue(defaultValue);
      setInputValue(formatNumber(defaultValue, computedStep));
    }, [resetKey, defaultValue, computedStep]);

    const publish = useCallback(
      (next: number, end = false) => {
        liveValueRef.current = next;
        setInternalValue(next);
        setInputValue(formatNumber(next, computedStep));
        onChangeRef.current(next);
        if (end) onChangeEndRef.current?.(next);
      },
      [computedStep],
    );

    const resolveFromClientX = useCallback(
      (clientX: number): number => {
        const slider = sliderRef.current;
        if (!slider) return liveValueRef.current;
        const rect = slider.getBoundingClientRect();
        const percentage = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
        const rawValue = percentage * span + sliderMin;

        if (snapping) {
          const snapPoints = [...new Set([...defaultValueArray, liveValueRef.current])].sort(
            (a, b) => a - b,
          );
          const closest = snapPoints.reduce((prev, curr) =>
            Math.abs(curr - rawValue) < Math.abs(prev - rawValue) ? curr : prev,
          );
          if (Math.abs(closest - rawValue) <= snappingThreshold) return closest;
        }

        const stepped = Math.round(rawValue / computedStep) * computedStep;
        return clamp(stepped, sliderMin, sliderMax);
      },
      [span, sliderMin, sliderMax, snapping, defaultValueArray, snappingThreshold, computedStep],
    );

    const publishRef = useRef(publish);
    const resolveRef = useRef(resolveFromClientX);
    publishRef.current = publish;
    resolveRef.current = resolveFromClientX;

    useEffect(() => {
      const slider = sliderRef.current;
      if (!slider || disabled) return;

      const endDrag = () => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        setDragging(false);
        document.body.style.userSelect = '';
        onChangeEndRef.current?.(liveValueRef.current);
      };

      const handlePointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        event.preventDefault();
        draggingRef.current = true;
        setDragging(true);
        document.body.style.userSelect = 'none';
        try {
          slider.setPointerCapture(event.pointerId);
        } catch {
          /* capture optional */
        }
        publishRef.current(resolveRef.current(event.clientX));
      };

      const handlePointerMove = (event: PointerEvent) => {
        if (!draggingRef.current) return;
        event.preventDefault();
        publishRef.current(resolveRef.current(event.clientX));
      };

      const handlePointerUp = (event: PointerEvent) => {
        if (!draggingRef.current) return;
        try {
          slider.releasePointerCapture(event.pointerId);
        } catch {
          /* already released */
        }
        endDrag();
      };

      const handleDoubleClick = () => {
        publishRef.current(defaultValue, true);
      };

      slider.addEventListener('pointerdown', handlePointerDown);
      slider.addEventListener('pointermove', handlePointerMove);
      slider.addEventListener('pointerup', handlePointerUp);
      slider.addEventListener('pointercancel', handlePointerUp);
      slider.addEventListener('dblclick', handleDoubleClick);
      return () => {
        slider.removeEventListener('pointerdown', handlePointerDown);
        slider.removeEventListener('pointermove', handlePointerMove);
        slider.removeEventListener('pointerup', handlePointerUp);
        slider.removeEventListener('pointercancel', handlePointerUp);
        slider.removeEventListener('dblclick', handleDoubleClick);
        if (draggingRef.current) {
          draggingRef.current = false;
          document.body.style.userSelect = '';
        }
      };
    }, [disabled, defaultValue]);

    const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
      setInputValue(event.target.value);
    };

    const handleInputBlur = () => {
      const parsed = Number(inputValue);
      if (Number.isNaN(parsed)) {
        setInputValue(formatNumber(currentValue, computedStep));
        return;
      }
      const stepped =
        Math.round(clamp(parsed, inputMin, inputMax) / computedStep) * computedStep;
      publish(stepped, true);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.currentTarget.blur();
        return;
      }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const parsed = Number(inputValue);
      if (Number.isNaN(parsed)) return;
      const delta = (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? computedStep * 10 : computedStep);
      publish(clamp(parsed + delta, inputMin, inputMax), true);
    };

    const displayThumb = labelFormatter
      ? labelFormatter(currentValue)
      : isOutOfBounds
        ? currentValue < sliderMin
          ? `<${formatNumber(sliderMin, computedStep)}`
          : `>${formatNumber(sliderMax, computedStep)}`
        : formatNumber(currentValue, computedStep);

    const rootClass = [
      'snappy-slider',
      compact ? 'is-compact' : '',
      disabled ? 'is-disabled' : '',
      isOutOfBounds ? 'is-out-of-bounds' : '',
      dragging ? 'is-dragging' : '',
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div ref={ref} className={rootClass}>
        <SnappySliderHeader>
          <SnappySliderLabel id={labelId}>{label}</SnappySliderLabel>
          <SnappySliderValue
            value={inputValue}
            onChange={handleInputChange}
            onBlur={handleInputBlur}
            onKeyDown={handleKeyDown}
            prefix={prefix}
            suffix={suffix}
            disabled={disabled}
            aria-labelledby={labelId}
          />
        </SnappySliderHeader>
        <div className="snappy-slider-track-wrap">
          <div
            ref={sliderRef}
            className="snappy-slider-hit"
            role="slider"
            aria-valuemin={sliderMin}
            aria-valuemax={sliderMax}
            aria-valuenow={currentValue}
            aria-labelledby={labelId}
            aria-disabled={disabled || undefined}
            tabIndex={disabled ? -1 : 0}
            onKeyDown={(event) => {
              if (disabled) return;
              if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                event.preventDefault();
                publish(clamp(currentValue - computedStep, sliderMin, sliderMax), true);
              } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                event.preventDefault();
                publish(clamp(currentValue + computedStep, sliderMin, sliderMax), true);
              } else if (event.key === 'Home') {
                event.preventDefault();
                publish(sliderMin, true);
              } else if (event.key === 'End') {
                event.preventDefault();
                publish(sliderMax, true);
              }
            }}
          >
            <div className="snappy-slider-track">
              <div className="snappy-slider-fill" style={{ width: `${sliderPercentage}%` }} />
              {sliderValues.map((mark, index) => {
                if (mark === 0) return null;
                const markPercentage = ((mark - sliderMin) / span) * 100;
                if (markPercentage < 0 || markPercentage > 100) return null;
                return (
                  <div
                    key={`${mark}-${index}`}
                    className="snappy-slider-mark"
                    style={{ left: `${markPercentage}%` }}
                  />
                );
              })}
            </div>

            {sliderValues.includes(0) && sliderMin <= 0 && sliderMax >= 0 && (
              <div
                className="snappy-slider-zero"
                style={{ left: `${((0 - sliderMin) / span) * 100}%` }}
              />
            )}

            <div className="snappy-slider-thumb" style={{ left: `${sliderPercentage}%` }}>
              <span className="snappy-slider-thumb-triangle" />
              <span className="snappy-slider-thumb-square" />
              <span className="snappy-slider-thumb-label">{displayThumb}</span>
            </div>
          </div>
        </div>
      </div>
    );
  },
);

const SnappySliderHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function SnappySliderHeader({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={['snappy-slider-header', className].filter(Boolean).join(' ')}
        {...props}
      />
    );
  },
);

const SnappySliderLabel = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  function SnappySliderLabel({ className, ...props }, ref) {
    return (
      <label
        ref={ref}
        className={['snappy-slider-label', className].filter(Boolean).join(' ')}
        {...props}
      />
    );
  },
);

const SnappySliderValue = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { prefix?: string; suffix?: string }
>(function SnappySliderValue({ className, prefix, suffix, ...props }, ref) {
  const localRef = useRef<HTMLInputElement | null>(null);
  const setRefs = (node: HTMLInputElement | null) => {
    localRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) {
      try {
        Object.assign(ref, { current: node });
      } catch {
        /* ignore immutable refs */
      }
    }
  };
  return (
    <div
      className="snappy-slider-value"
      onClick={() => localRef.current?.focus()}
    >
      {prefix ? <span className="snappy-slider-affix">{prefix}</span> : null}
      <input
        ref={setRefs}
        type="number"
        inputMode="decimal"
        className={['snappy-slider-input', className].filter(Boolean).join(' ')}
        {...props}
      />
      {suffix ? <span className="snappy-slider-affix">{suffix}</span> : null}
    </div>
  );
});

export default SnappySlider;
