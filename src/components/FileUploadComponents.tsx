import React, { useState } from 'react';
import { Upload, X, AlertCircle, Calendar, CheckCircle2, ChevronDown } from 'lucide-react';
import { Listbox, Transition } from '@headlessui/react';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

// Types and Interfaces
interface StoryDocument {
  id: string;
  title: string;
  description?: string;
  is_corrected: boolean;
  version?: number;
  group_id?: string;
  created_at: string;
  file_path: string;
  word_count?: number;
}

interface DocumentSelectorProps {
  documents: StoryDocument[];
  selectedDoc: string;
  onDocChange: (docId: string) => void;
  uploadedDoc: File | null;
  onUploadedDocChange: (file: File | null) => void;
  onFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => void;
  uploadingFile: boolean;
  disabled: boolean;
  error?: string | null;
}

interface FileUploadZoneProps {
  onFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => void;
  uploadingFile: boolean;
  disabled: boolean;
  selectedDoc: string;
}

interface UploadedFileDisplayProps {
  uploadedDoc: File;
  onRemove: () => void;
  disabled: boolean;
}

interface DocumentListboxProps {
  documents: StoryDocument[];
  selectedDoc: string;
  onDocChange: (docId: string) => void;
  disabled: boolean;
  uploadedDoc: File | null;
}

// Constants
const MAX_WORD_COUNT = 70000;
const MAX_FILE_SIZE_MB = 1;

// Helper Functions
const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

// File Upload Zone Component
const FileUploadZone: React.FC<FileUploadZoneProps> = ({
  onFileUpload,
  uploadingFile,
  disabled,
  selectedDoc
}) => {
  return (
    <div className="relative">
      <div className="flex items-center justify-center w-full">
        <label
          className={`flex flex-col items-center justify-center w-full h-32 border-2 border-border border-dashed rounded-lg ${
            disabled || selectedDoc !== '' ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-surface-elevated'
          } bg-surface-elevated transition-colors`}
        >
          <div className="flex flex-col items-center justify-center pt-5 pb-6">
            {uploadingFile ? (
              <>
                <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-accent-text mb-3"></div>
                <p className="text-sm text-text-dim">Uploading...</p>
              </>
            ) : (
              <>
                <Upload className="w-8 h-8 mb-3 text-text-dim" />
                <p className="mb-2 text-sm text-text-dim">
                  <span className="font-semibold">Click to upload</span> or drag and drop
                </p>
                <p className="text-xs text-text-dim">TXT files only (max {MAX_FILE_SIZE_MB * 1024} KB, {MAX_WORD_COUNT.toLocaleString()} words)</p>
              </>
            )}
          </div>
          <input
            type="file"
            className="hidden"
            accept=".txt"
            onChange={onFileUpload}
            disabled={disabled || selectedDoc !== '' || uploadingFile}
          />
        </label>
      </div>
    </div>
  );
};

// Uploaded File Display Component
const UploadedFileDisplay: React.FC<UploadedFileDisplayProps> = ({
  uploadedDoc,
  onRemove,
  disabled
}) => {
  return (
    <div className="mt-2 flex items-center justify-between bg-surface-elevated p-2 rounded-lg">
      <span className="text-sm text-text-muted">{uploadedDoc.name}</span>
      <button
        onClick={onRemove}
        className="text-text-dim hover:text-white disabled:opacity-50"
        disabled={disabled}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
};

// Document Listbox Component
const DocumentListbox: React.FC<DocumentListboxProps> = ({
  documents,
  selectedDoc,
  onDocChange,
  disabled,
  uploadedDoc
}) => {
  return (
    <Listbox
      value={selectedDoc}
      onChange={onDocChange}
      disabled={disabled || uploadedDoc !== null}
    >
      {({ open }) => (
        <div className="relative">
          <Listbox.Button className={`relative w-full bg-surface-input border border-white/[0.13] rounded-xl px-5 py-4 text-left text-white/95 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent transition-all duration-200 ${
            disabled || uploadedDoc !== null ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
          }`}>
            <span className="block truncate">
              {selectedDoc
                ? documents.find(doc => doc.id === selectedDoc)?.title
                : <span className="italic text-text-dim">None - Select a document</span>}
            </span>
            <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
              <ChevronDown className={`h-5 w-5 text-text-dim transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
            </span>
          </Listbox.Button>
          <Transition
            show={open}
            enter="transition ease-out duration-100"
            enterFrom="transform opacity-0 scale-95"
            enterTo="transform opacity-100 scale-100"
            leave="transition ease-in duration-75"
            leaveFrom="transform opacity-100 scale-100"
            leaveTo="transform opacity-0 scale-95"
          >
            <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-dropdown border border-white/[0.08] rounded-xl shadow-lg max-h-44 overflow-auto focus:outline-none">
              {/* None option - allows user to continue without selecting a document */}
              <Listbox.Option
                value=""
                className={({ active, selected }) =>
                  `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${
                    active ? 'bg-surface-elevated text-white' : 'text-text-muted'
                  } ${selected ? 'font-medium' : 'font-normal'}`
                }
              >
                {({ selected }) => (
                  <>
                    <div className="flex flex-col">
                      <span className={`text-sm italic ${selected ? 'font-medium text-text-muted' : 'text-text-dim'}`}>
                        None - Select a document
                      </span>
                    </div>
                    {selected && (
                      <CheckCircle2 className="h-5 w-5 text-status-error" />
                    )}
                  </>
                )}
              </Listbox.Option>
              
              {documents.map((doc) => (
                <Listbox.Option
                  key={doc.id}
                  value={doc.id}
                  className={({ active, selected }) =>
                    `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${
                      active ? 'bg-surface-elevated text-white' : 'text-text-muted'
                    } ${selected ? 'font-medium' : 'font-normal'}`
                  }
                >
                  {({ selected }) => (
                    <>
                      <div className="flex flex-col">
                        <span className={selected ? 'font-medium' : 'font-normal'}>
                          {doc.title}
                        </span>
                        <span className="text-sm text-text-dim flex items-center">
                          <Calendar className="h-4 w-4 mr-1" />
                          {formatDate(doc.created_at)} • {doc.word_count || 'Unknown'} words
                        </span>
                      </div>
                      {selected && (
                        <span className="text-status-error">
                          <CheckCircle2 className="h-5 w-5" />
                        </span>
                      )}
                    </>
                  )}
                </Listbox.Option>
              ))}
              {documents.length === 0 && (
                <div className="py-2 px-4 text-text-dim text-sm">
                  No story documents available
                </div>
              )}
            </Listbox.Options>
          </Transition>
        </div>
      )}
    </Listbox>
  );
};

// Main Document Selector Component
export const DocumentSelector: React.FC<DocumentSelectorProps> = ({
  documents,
  selectedDoc,
  onDocChange,
  uploadedDoc,
  onUploadedDocChange,
  onFileUpload,
  uploadingFile,
  disabled,
  error
}) => {
  const handleDocumentChange = (docId: string) => {
    // Clear uploaded file when selecting document
    if (uploadedDoc) {
      onUploadedDocChange(null);
    }
    onDocChange(docId);
  };

  const handleFileRemove = () => {
    onUploadedDocChange(null);
  };

  return (
    <div className="space-y-4">
        {/* Document Selection */}
        <div>
          <label className="block text-sm font-medium text-text-muted mb-2">Select from Saved Documents</label>
          <DocumentListbox
            documents={documents}
            selectedDoc={selectedDoc}
            onDocChange={handleDocumentChange}
            disabled={disabled}
            uploadedDoc={uploadedDoc}
          />
        </div>

        {/* File Upload */}
        <div>
          <label className="block text-sm font-medium text-text-muted mb-2">Or Upload New Document</label>
          <FileUploadZone
            onFileUpload={onFileUpload}
            uploadingFile={uploadingFile}
            disabled={disabled}
            selectedDoc={selectedDoc}
          />
          {uploadedDoc && (
            <UploadedFileDisplay
              uploadedDoc={uploadedDoc}
              onRemove={handleFileRemove}
              disabled={disabled}
            />
          )}
        </div>

        {/* Error Display */}
        {error && (
          <div className="bg-status-error text-status-error p-3 rounded-lg">
            <div className="flex items-center space-x-2">
              <AlertCircle className="h-5 w-5 text-status-error" />
              <p className="text-sm">{error}</p>
            </div>
          </div>
        )}
    </div>
  );
};


