import React, { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle, Download, X, Clock, HardDrive } from 'lucide-react';

interface LargeVideoDownloadModalProps {
  fileName: string;
  fileSizeBytes: number;
  signedUrl: string;
  onClose: () => void;
}

const formatFileSize = (bytes: number): string => {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
};

const estimateDownloadTime = (bytes: number): string => {
  // Estimate at 50 Mbps
  const seconds = (bytes * 8) / (50 * 1024 * 1024);
  if (seconds < 60) return `~${Math.round(seconds)} seconds`;
  const minutes = seconds / 60;
  if (minutes < 60) return `~${Math.round(minutes)} minutes`;
  return `~${(minutes / 60).toFixed(1)} hours`;
};

const LargeVideoDownloadModal: React.FC<LargeVideoDownloadModalProps> = ({
  fileName,
  fileSizeBytes,
  signedUrl,
  onClose,
}) => {
  const [downloadStarted, setDownloadStarted] = useState(false);
  const anchorRef = useRef<HTMLAnchorElement>(null);

  const handleStartDownload = () => {
    if (anchorRef.current) {
      anchorRef.current.click();
      setDownloadStarted(true);
      // Revoke blob: URLs (e.g. assembled ZIPs) after a short delay to free memory
      if (signedUrl.startsWith('blob:')) {
        setTimeout(() => URL.revokeObjectURL(signedUrl), 30_000);
      }
    }
  };

  const sizeStr = formatFileSize(fileSizeBytes);
  const timeStr = estimateDownloadTime(fileSizeBytes);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-gray-800 rounded-xl border border-gray-600 shadow-2xl max-w-md w-full p-6">
        {/* Hidden anchor — browser handles the download natively */}
        <a ref={anchorRef} href={signedUrl} download={fileName} className="hidden" />

        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div className="flex items-center space-x-3">
            <div className={`flex items-center justify-center w-11 h-11 rounded-full border ${
              downloadStarted ? 'bg-green-500/20 border-green-500/30' : 'bg-yellow-500/20 border-yellow-500/30'
            }`}>
              {downloadStarted
                ? <CheckCircle className="h-5 w-5 text-green-400" />
                : <AlertTriangle className="h-5 w-5 text-yellow-400" />
              }
            </div>
            <div>
              <h2 className="text-white font-semibold text-lg leading-tight">
                {downloadStarted ? 'Download Started' : 'Large File Download'}
              </h2>
              <p className="text-gray-400 text-xs mt-0.5">
                {downloadStarted ? "Check your browser's download bar" : `${sizeStr} — this may take a while`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors p-1 rounded-md hover:bg-gray-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {downloadStarted ? (
          <div className="bg-green-900/25 border border-green-700/40 rounded-lg p-4 mb-5">
            <p className="text-green-300 text-sm">
              ✅ Your browser's native download manager has taken over. You can safely close this modal and track progress in your browser's download bar.
            </p>
          </div>
        ) : (
          <>
            {/* File info */}
            <div className="bg-gray-700/60 rounded-lg p-4 space-y-3 mb-4">
              <div className="flex justify-between items-center text-sm">
                <span className="text-gray-400 flex items-center">
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                  File
                </span>
                <span className="text-white font-medium truncate ml-4 max-w-[220px] text-right">{fileName}</span>
              </div>
              <div className="border-t border-gray-600/50" />
              <div className="flex justify-between items-center text-sm">
                <span className="text-gray-400 flex items-center">
                  <HardDrive className="h-3.5 w-3.5 mr-1.5" />
                  File size
                </span>
                <span className="text-yellow-300 font-bold text-base">{sizeStr}</span>
              </div>
              <div className="border-t border-gray-600/50" />
              <div className="flex justify-between items-center text-sm">
                <span className="text-gray-400 flex items-center">
                  <Clock className="h-3.5 w-3.5 mr-1.5" />
                  Est. time
                </span>
                <span className="text-gray-300">{timeStr} at 50 Mbps</span>
              </div>
            </div>

            {/* Warning checklist */}
            <div className="bg-yellow-900/25 border border-yellow-700/40 rounded-lg p-3 mb-5">
              <p className="text-yellow-300 font-medium text-sm mb-2">⚠️ Before you download</p>
              <ul className="space-y-1 text-yellow-200/70 text-xs list-disc list-inside leading-relaxed">
                <li>Make sure you have at least <strong className="text-yellow-200">{sizeStr}</strong> of free disk space</li>
                <li>Your browser will download directly to disk — no memory issues</li>
                <li>Progress will appear in your browser's download bar</li>
              </ul>
            </div>
          </>
        )}

        {/* Buttons */}
        <div className="flex space-x-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 bg-gray-700 text-gray-300 rounded-lg hover:bg-gray-600 transition-colors text-sm font-medium"
          >
            {downloadStarted ? 'Close' : 'Cancel'}
          </button>
          {!downloadStarted && (
            <button
              onClick={handleStartDownload}
              className="flex-1 flex items-center justify-center px-4 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium"
            >
              <Download className="h-4 w-4 mr-2" />
              Start Download
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default LargeVideoDownloadModal;
