import { useEffect, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';

interface RedoFeedbackModalProps {
  open: boolean;
  title?: string;
  description?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (feedback: string) => void;
}

const MAX_FEEDBACK = 250;

export default function RedoFeedbackModal({
  open,
  title = 'Redo',
  description = "Optionally tell us what was wrong with this generation (max 250 chars). Leave blank to redo with the original prompt.",
  confirmLabel = 'Redo',
  onCancel,
  onConfirm,
}: RedoFeedbackModalProps) {
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    if (open) setFeedback('');
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60 backdrop-blur-sm">
      <div className="bg-surface-card border border-border-card rounded-xl p-6 w-full max-w-md shadow-2xl mx-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <button
            onClick={onCancel}
            className="text-text-dim hover:text-white transition-colors"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="text-sm text-text-dim mb-4">{description}</p>
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value.slice(0, MAX_FEEDBACK))}
          maxLength={MAX_FEEDBACK}
          rows={4}
          placeholder="e.g. too dark, wrong angle"
          className="w-full px-3 py-2 bg-surface-elevated border border-border-card rounded-lg text-sm text-white placeholder:text-text-dim focus:outline-none focus:border-status-info resize-none"
        />
        <div className="flex justify-end text-xs text-text-dim mt-1">
          {feedback.length}/{MAX_FEEDBACK}
        </div>
        <div className="flex gap-3 mt-4">
          <button
            onClick={onCancel}
            className="flex-1 py-2 text-sm text-text-dim hover:text-white transition-colors border border-border-card rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(feedback.trim())}
            className="flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium text-white bg-status-info hover:opacity-90 rounded-lg transition-opacity"
          >
            <RotateCcw className="h-4 w-4" />
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
