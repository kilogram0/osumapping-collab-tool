import { makeClampedOnChange } from '../utils/timeInput';

interface TimeInputProps {
  label: string;
  minutesId: string;
  secondsId: string;
  millisId: string;
  minutes: string;
  seconds: string;
  millis: string;
  onChangeMinutes: (v: string) => void;
  onChangeSeconds: (v: string) => void;
  onChangeMillis: (v: string) => void;
}

export default function TimeInput({
  label,
  minutesId,
  secondsId,
  millisId,
  minutes,
  seconds,
  millis,
  onChangeMinutes,
  onChangeSeconds,
  onChangeMillis,
}: TimeInputProps) {
  return (
    <div>
      <span className="block text-sm font-medium text-gray-300 mb-1">{label}</span>
      <div className="flex gap-2">
        <div className="flex-1">
          <label htmlFor={minutesId} className="sr-only">{label} Minutes</label>
          <input
            id={minutesId}
            type="number"
            value={minutes}
            onChange={makeClampedOnChange(onChangeMinutes)}
            min={0}
            className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
            placeholder="0"
          />
          <span className="text-xs text-gray-400 mt-1 block">Minutes</span>
        </div>
        <div className="flex-1">
          <label htmlFor={secondsId} className="sr-only">{label} Seconds</label>
          <input
            id={secondsId}
            type="number"
            value={seconds}
            onChange={makeClampedOnChange(onChangeSeconds, 59)}
            min={0}
            max={59}
            className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
            placeholder="0"
          />
          <span className="text-xs text-gray-400 mt-1 block">Seconds</span>
        </div>
        <div className="flex-1">
          <label htmlFor={millisId} className="sr-only">{label} Milliseconds</label>
          <input
            id={millisId}
            type="number"
            value={millis}
            onChange={makeClampedOnChange(onChangeMillis, 999)}
            min={0}
            max={999}
            className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
            placeholder="0"
          />
          <span className="text-xs text-gray-400 mt-1 block">Ms</span>
        </div>
      </div>
    </div>
  );
}
