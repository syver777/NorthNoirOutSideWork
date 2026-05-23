import { RefreshCw, CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';

interface StatusBannerProps {
  variant: 'info' | 'success';
  title: ReactNode;
  subtitle: ReactNode;
  className?: string;
  /** Override the default icon (spinning RefreshCw for info, CheckCircle2 for success) */
  icon?: ReactNode;
}

const config = {
  info: {
    bg: 'bg-[--color-status-info-bg]',
    border: 'border-[--color-status-info-border]',
    textColor: 'text-status-info',
    subtitleColor: 'rgba(96, 165, 250, 0.7)',
    defaultIcon: <RefreshCw className="h-5 w-5 text-status-info animate-spin" />,
  },
  success: {
    bg: 'bg-[--color-status-success-bg]',
    border: 'border-[--color-status-success-border]',
    textColor: 'text-status-success',
    subtitleColor: 'rgba(74, 222, 128, 0.7)',
    defaultIcon: <CheckCircle2 className="h-6 w-6 text-status-success" />,
  },
} as const;

export default function StatusBanner({ variant, title, subtitle, className, icon }: StatusBannerProps) {
  const c = config[variant];
  return (
    <div className={`p-5 rounded-2xl ${c.bg} border ${c.border} mb-6 dash-animate-in ${className ?? ''}`}>
      <div className="flex items-center space-x-3">
        <div className={`flex-shrink-0 h-10 w-10 rounded-full ${c.bg} flex items-center justify-center`}>
          {icon ?? c.defaultIcon}
        </div>
        <div>
          <h3 className={`text-lg font-display font-semibold ${c.textColor}`}>{title}</h3>
          <p className="text-sm mt-0.5" style={{ color: c.subtitleColor }}>{subtitle}</p>
        </div>
      </div>
    </div>
  );
}
