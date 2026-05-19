import { useToast } from '../contexts/ToastContext';

const TYPE_STYLES = {
  success: 'bg-green-800 border-green-600 text-green-100',
  error: 'bg-red-900 border-red-600 text-red-100',
  warning: 'bg-yellow-900 border-yellow-600 text-yellow-100',
  info: 'bg-gray-800 border-gray-600 text-gray-100',
} as const;

export default function ToastContainer() {
  const { toasts, dismiss } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-full"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={`flex items-start justify-between gap-3 px-4 py-3 rounded-lg border shadow-lg text-sm ${TYPE_STYLES[toast.type]}`}
        >
          <span className="flex-1">{toast.message}</span>
          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss notification"
            className="shrink-0 opacity-70 hover:opacity-100 transition-opacity text-lg leading-none"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
