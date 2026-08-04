/**
 * SnappySlider — marked range control with snap points, typed value, and
 * double-click reset. Styled for Groundplan panels (no Tailwind).
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

    const [internalValue, setInternalValue] = useState(defaultValue);
    const currentValue = value ?? internalValue;
    const [inputValue, setInputValue] = useState(formatNumber(currentValue, computedStep));
    const isOutOfBounds = currentValue < sliderMin || currentValue > sliderMax;
    const sliderPercentage =
      ((clamp(currentValue, sliderMin, sliderMax) - sliderMin) / span) * 100;

    const liveValueRef = useRef(currentValue);
    liveValueRef.current = currentValue;

    useEffect(() => {
      if (value !== undefined) {
        setInternalValue(value);
        setInputValue(formatNumber(value, computedStep));
      }
    }, [value, computedStep]);

    useEffect(() => {
      if (resetKey === undefined) return;
      setInternalValue(defaultValue);
      setInputValue(formatNumber(defaultValue, computedStep));
    }, [resetKey, defaultValue, computedStep]);

    const publish = useCallback(
      (next: number, end = false) => {
        setInternalValue(next);
        setInputValue(formatNumber(next, computedStep));
        onChange(next);
        if (end) onChangeEnd?.(next);
      },
      [computedStep, onChange, onChangeEnd],
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
      [
        span,
        sliderMin,
        sliderMax,
        snapping,
        defaultValueArray,
        snappingThreshold,
        computedStep,
      ],
    );

    useEffect(() => {
      const slider = sliderRef.current;
      if (!slider || disabled) return;

      const handleMouseDown = (event: MouseEvent) => {
        event.preventDefault();
        publish(resolveFromClientX(event.clientX));
        document.body.style.userSelect = 'none';

        const handleMouseMove = (move: MouseEvent) => {
          publish(resolveFromClientX(move.clientX));
        };
        const handleMouseUp = () => {
          document.removeEventListener('mousemove', handleMouseMove);
          document.body.style.userSelect = '';
          onChangeEnd?.(liveValueRef.current);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp, { once: true });
      };

      const handleTouchStart = (event: TouchEvent) => {
        event.preventDefault();
        const touch = event.touches[0];
        if (!touch) return;
        publish(resolveFromClientX(touch.clientX));

        const handleTouchMove = (move: TouchEvent) => {
          const next = move.touches[0];
          if (next) publish(resolveFromClientX(next.clientX));
        };
        const handleTouchEnd = () => {
          document.removeEventListener('touchmove', handleTouchMove);
          onChangeEnd?.(liveValueRef.current);
        };

        document.addEventListener('touchmove', handleTouchMove, { passive: false });
        document.addEventListener('touchend', handleTouchEnd, { once: true });
      };

      const handleDoubleClick = () => {
        publish(defaultValue, true);
      };

      slider.addEventListener('mousedown', handleMouseDown);
      slider.addEventListener('touchstart', handleTouchStart, { passive: false });
      slider.addEventListener('dblclick', handleDoubleClick);
      return () => {
        slider.removeEventListener('mousedown', handleMouseDown);
        slider.removeEventListener('touchstart', handleTouchStart);
        slider.removeEventListener('dblclick', handleDoubleClick);
        document.body.style.userSelect = '';
      };
    }, [disabled, publish, resolveFromClientX, defaultValue, onChangeEnd]);

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
