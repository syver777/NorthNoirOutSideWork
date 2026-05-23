import React, { useState, useEffect } from 'react';
import { Upload, FileText, RefreshCw, X, Brain, Sparkles, CheckCircle2, AlertCircle, Star, Zap, Users, BookOpen, Palette, Calendar, ChevronDown } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import DashboardLayout from '../components/DashboardLayout';
import RatingWheel from '../components/RatingWheel';
import { performComparison, ComparisonResult } from '../utils/generator';
import { useIsLegacyPlan } from '../hooks/useIsLegacyPlan';
import { getPlanMaxTokens } from '../data/planMaxTokens';
import { Listbox, Transition } from '@headlessui/react';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

interface StoryDocument {
  id: string;
  title: string;
  is_corrected: boolean;
  is_prompted?: boolean;
  created_at: string;
  file_path: string;
  content?: string;
  word_count?: number;
  file_size?: number | null;
  group_id: string;
}

interface TokenInfo {
  tokensUsed: number;
  tokensRemaining: number;
}

// Constants
const MAX_WORD_COUNT = 40000;
const MAX_FILE_SIZE_MB = 1;
const OPERATION_TIMEOUT = 3600000;
const RETRY_DELAY = 2000;
const MAX_RETRIES = 10;

// Utility function to validate file names
const validateFileName = (fileName: string): string | null => {
  const validFileNameRegex = /^[a-zA-Z0-9\s\-_.]+$/;
  if (!validFileNameRegex.test(fileName)) {
    const invalidChars = fileName
      .split('')
      .filter(char => !/[a-zA-Z0-9\s\-_.]/.test(char))
      .join(', ');
    return `File name contains invalid characters: ${invalidChars}. Only alphanumeric characters, spaces, hyphens, underscores, and dots are allowed.`;
  }
  return null;
};

// Check network status
const checkNetworkStatus = (): boolean => {
  return navigator.onLine;
};

// Timeout wrapper
const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Operation "${operation}" timed out after ${timeoutMs / 1000} seconds`)), timeoutMs);
    }),
  ]);
};

// Retry wrapper with exponential backoff
const withRetry = async <T extends unknown>(operation: () => Promise<T>, operationName: string, maxRetries: number = MAX_RETRIES): Promise<T> => {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      if (error.message.includes('Failed to fetch')) {
        console.warn(`Network error (attempt ${attempt}/${maxRetries}) for ${operationName}: ${error.message}`);
      } else if (error.status === 500) {
        console.error(`Server error (attempt ${attempt}/${maxRetries}) for ${operationName}: HTTP 500 Internal Server Error`);
      } else if (error.message.includes('timeout')) {
        console.error(`Timeout error (attempt ${attempt}/${maxRetries}) for ${operationName}: ${error.message}`);
      } else {
        console.warn(`Error (attempt ${attempt}/${maxRetries}) for ${operationName}: ${error.message}`);
      }
      if ((error.message.includes('Failed to fetch') || error.status === 500 || error.message.includes('timeout') || error.message.includes('429') || error.message.includes('503')) && attempt < maxRetries) {
        const delay = RETRY_DELAY * Math.pow(1.5, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error(`Failed to complete ${operationName} after ${maxRetries} attempts: ${lastError.message}`);
};

const evaluationCategories = [
  { key: 'pacing', label: 'Pacing', icon: Zap, color: 'text-blue-500' },
  { key: 'consistency', label: 'Consistency', icon: CheckCircle2, color: 'text-green-500' },
  { key: 'characterDevelopment', label: 'Character Development', icon: Users, color: 'text-purple-500' },
  { key: 'plotCoherence', label: 'Plot Coherence', icon: BookOpen, color: 'text-yellow-500' },
  { key: 'toneAndAtmosphere', label: 'Tone & Atmosphere', icon: Palette, color: 'text-pink-500' },
  { key: 'overallQuality', label: 'Overall Quality', icon: Star, color: 'text-orange-500' },
];

const EvaluationSection = ({ review, label }: { review: any, label: string }) => (
  <div className="space-y-6">
    <div className="text-center">
      <h3 className="text-lg font-semibold text-white mb-2">{label}</h3>
      <RatingWheel rating={review.rating} label={label} />
      <p className="mt-2 text-text-muted text-sm">{review.wordCount} words</p>
    </div>
    <div className="space-y-4">
      <h4 className="text-sm font-medium text-text-secondary">Evaluation</h4>
      <div className="space-y-3">
        {evaluationCategories.map(({ key, label, icon: Icon, color }) => (
          <div key={key} className="bg-surface-card rounded-xl p-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${color}`} />
                <p className={`text-xs font-medium ${color}`}>{label}</p>
              </div>
              {key !== 'overallQuality' && (
                <span className="text-xs font-semibold text-text-secondary">{review[key].rating}/10</span>
              )}
            </div>
            <p className="text-text-secondary text-sm">
              {key === 'overallQuality' ? review[key] : review[key].text}
            </p>
          </div>
        ))}
      </div>
    </div>
  </div>
);

export default function Compare() {
  const { isLegacy } = useIsLegacyPlan();
  const [documents, setDocuments] = useState<StoryDocument[]>([]);
  const [selectedDoc1, setSelectedDoc1] = useState<string>('');
  const [selectedDoc2, setSelectedDoc2] = useState<string>('');
  const [uploadedDoc1, setUploadedDoc1] = useState<File | null>(null);
  const [uploadedDoc2, setUploadedDoc2] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [comparing, setComparing] = useState(false);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doc1Label, setDoc1Label] = useState<string>('Document 1');
  const [doc2Label, setDoc2Label] = useState<string>('Document 2');
  const [userId, setUserId] = useState<string | null>(null);
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [storageUsed, setStorageUsed] = useState<number | null>(null);
  const [estimatedTokens, setEstimatedTokens] = useState<number>(0);
  const [userTokenBalance, setUserTokenBalance] = useState<number>(0);

  // Plan maximum tokens based on plan_type
  const planMaxTokens: Record<string, number> = {
    free: 400000,
    standard: 4000000,
    plus: 6000000,
    premium: 10000000,
    pro: 25000000,
    elite: 50000000,
    ultimate: 75000000,
    enterprise: 125000000,
  };

  // Token estimation constants from Generator.tsx
  const STORY_GENERATION_TOKENS_PER_WORD = 1.33;

  // Estimate tokens for story comparison (from Generator.tsx)
  const estimateComparisonTokens = (originalWordCount: number, correctedWordCount: number) => {
    const originalInputTokens = originalWordCount * STORY_GENERATION_TOKENS_PER_WORD + 200; // System prompt + original story
    const correctedInputTokens = correctedWordCount * STORY_GENERATION_TOKENS_PER_WORD + 200; // System prompt + corrected story
    const comparisonInputTokens = (originalWordCount + correctedWordCount) * STORY_GENERATION_TOKENS_PER_WORD + 300; // System prompt + both stories

    const originalOutputTokens = 400; // ~300 words for original story evaluation
    const correctedOutputTokens = 400; // ~300 words for corrected story evaluation
    const comparisonOutputTokens = 530; // ~400 words for comparison section

    const totalInputTokens = originalInputTokens + correctedInputTokens + comparisonInputTokens;
    const totalOutputTokens = originalOutputTokens + correctedOutputTokens + comparisonOutputTokens;

    return Math.round(totalInputTokens * 0.25 + totalOutputTokens); // Unified token formula
  };

  // Calculate word count from text
  const calculateWordCount = (text: string): number => {
    return text.trim().split(/\s+/).filter(word => word.length > 0).length;
  };

  // Fetch user documents, storage usage, and token balance
  useEffect(() => {
    const fetchUserAndDocuments = async () => {
      try {
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
          setError('Authentication error');
          setLoading(false);
          return;
        }

        setUserId(user.id);

        // Fetch user plan and token balance
        const { data: planData, error: planError } = await supabase
          .from('user_plans')
          .select('plan_type, tokens_used, rollover_tokens')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .single();

        if (planError) {
          throw new Error(`Failed to fetch user plan: ${planError.message}`);
        }

        const planType = planData?.plan_type || 'free';
        const tokensUsed = planData?.tokens_used || 0;
        const rolloverTokens = planData?.rollover_tokens || 0;
        const planMax = getPlanMaxTokens(planType, isLegacy);
        setUserTokenBalance(planMax + rolloverTokens - tokensUsed);

        // Fetch documents
        const { data, error: fetchError } = await supabase
          .from('story_documents')
          .select('*, file_size, group_id')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        if (fetchError) throw fetchError;

        // Calculate storage usage
        let totalSize = 0;
        if (data && data.length > 0) {
          for (const doc of data) {
            if (doc.file_size == null || doc.file_size === 0) {
              try {
                const { data: fileData, error: storageError } = await supabase.storage
                  .from('stories')
                  .download(doc.file_path);
                if (storageError) {
                  console.error(`Failed to fetch size for ${doc.file_path}:`, storageError);
                  continue;
                }
                const size = (await fileData.arrayBuffer()).byteLength;
                const { error: updateError } = await supabase
                  .from('story_documents')
                  .update({ file_size: size })
                  .eq('id', doc.id);
                if (updateError) {
                  console.error(`Failed to update file_size for ${doc.id}:`, updateError);
                } else {
                  doc.file_size = size;
                }
              } catch (err: any) {
                console.error(`Error processing ${doc.file_path}:`, err);
              }
            }
            totalSize += doc.file_size || (doc.word_count * 1.5);
          }
        }

        const totalSizeMB = totalSize / (1024 * 1024);
        const formattedSize = totalSizeMB > 0 && totalSizeMB < 0.05 ? 0.1 : Number(totalSizeMB.toFixed(totalSizeMB < 1 ? 1 : 2));
        setStorageUsed(formattedSize);
        setDocuments(data || []);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchUserAndDocuments();
  }, []);

  // Estimate token usage when two documents are selected or uploaded
  useEffect(() => {
    const calculateEstimatedTokens = async () => {
      let doc1WordCount = 0;
      let doc2WordCount = 0;

      if (selectedDoc1 && selectedDoc2) {
        const doc1 = documents.find(doc => doc.id === selectedDoc1);
        const doc2 = documents.find(doc => doc.id === selectedDoc2);
        if (doc1 && doc2) {
          doc1WordCount = doc1.word_count || 0;
          doc2WordCount = doc2.word_count || 0;
        }
      } else if (uploadedDoc1 && uploadedDoc2) {
        try {
          const doc1Content = await uploadedDoc1.text();
          const doc2Content = await uploadedDoc2.text();
          doc1WordCount = calculateWordCount(doc1Content);
          doc2WordCount = calculateWordCount(doc2Content);
        } catch (err: any) {
          console.error('Error calculating word count for uploaded files:', err);
          setError('Failed to estimate token usage for uploaded files');
          return;
        }
      }

      if (doc1WordCount > 0 && doc2WordCount > 0) {
        const estimated = estimateComparisonTokens(doc1WordCount, doc2WordCount);
        setEstimatedTokens(estimated);
      } else {
        setEstimatedTokens(0);
      }
    };

    calculateEstimatedTokens();
  }, [selectedDoc1, selectedDoc2, uploadedDoc1, uploadedDoc2, documents]);

  // Handle file upload with validation, word count, and storage
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>, docNumber: number) => {
    const file = event.target.files?.[0];
    if (!file) return;
  
    // Clear previous analysis data
    setComparison(null);
    setTokenInfo(null);
    setEstimatedTokens(0);
    setError(null);
  
    // Validate file type
    if (file.type !== 'text/plain' && !file.name.endsWith('.txt')) {
      setError('Please upload a valid .txt file');
      return;
    }
  
    // Validate file name for invalid characters
    const fileNameError = validateFileName(file.name);
    if (fileNameError) {
      setError(fileNameError);
      return;
    }
  
    // Validate file size
    const maxFileSizeBytes = MAX_FILE_SIZE_MB * 1024 * 1024;
    if (file.size > maxFileSizeBytes) {
      setError(`File size exceeds limit. Maximum allowed: ${Math.round(maxFileSizeBytes / 1024)} KB`);
      return;
    }
  
    if (!userId) {
      setError('Authentication error');
      return;
    }
  
    // Read file content for word count
    let fileContent: string;
    try {
      fileContent = await file.text();
    } catch (err: any) {
      setError('Failed to read file content');
      return;
    }
  
    const wordCount = calculateWordCount(fileContent);
  
    // Check word count limit
    if (wordCount > MAX_WORD_COUNT) {
      setError(`File exceeds the maximum word count limit of ${MAX_WORD_COUNT} words. Your file has ${wordCount} words.`);
      return;
    }
  
    // Generate unique group_id for this upload
    const uniqueGroupId = crypto.randomUUID();
  
    // Generate file path with unique group_id
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${file.name.replace(/\s+/g, '-')}_${timestamp}.txt`;
    const filePath = `documents/${userId}/${uniqueGroupId}/${fileName}`;
  
    try {
      // Upload file to Supabase storage with retry
      const { error: uploadError } = await withRetry(
        () => withTimeout(
          supabase.storage
            .from('stories')
            .upload(filePath, file, {
              contentType: 'text/plain',
              upsert: true,
            }),
          OPERATION_TIMEOUT,
          'uploadFile'
        ),
        'uploadFile'
      );
  
      if (uploadError) {
        throw new Error(`Failed to upload file: ${uploadError.message}`);
      }
  
      // Insert document metadata into story_documents with retry
      const { data, error: insertError } = await withRetry(
        () => withTimeout(
          supabase
            .from('story_documents')
            .insert({
              id: crypto.randomUUID(),
              user_id: userId,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              file_path: filePath,
              title: file.name.replace(/\.txt$/, ''),
              description: 'Uploaded document for comparison',
              word_count: wordCount,
              version: 1,
              is_corrected: false,
              is_prompted: false,
              group_id: uniqueGroupId,
              variant: 1,
              file_size: file.size,
            })
            .select()
            .single(),
          OPERATION_TIMEOUT,
          'insertDocument'
        ),
        'insertDocument'
      );
  
      if (insertError) {
        // Cleanup: remove uploaded file if metadata insertion fails
        await withRetry(
          () => withTimeout(
            supabase.storage.from('stories').remove([filePath]),
            OPERATION_TIMEOUT,
            'removeFile'
          ),
          'removeFile'
        );
        throw new Error(`Failed to save document metadata: ${insertError.message}`);
      }
  
      // Update state
      if (docNumber === 1) {
        setUploadedDoc1(file);
        setDoc1Label(file.name);
        setSelectedDoc1('');
      } else {
        setUploadedDoc2(file);
        setDoc2Label(file.name);
        setSelectedDoc2('');
      }
  
      // Refresh documents list with retry
      const { data: updatedDocs, error: fetchError } = await withRetry(
        () => withTimeout(
          supabase
            .from('story_documents')
            .select('*, file_size, group_id')
            .eq('user_id', userId)
            .order('created_at', { ascending: false }),
          OPERATION_TIMEOUT,
          'fetchDocuments'
        ),
        'fetchDocuments'
      );
  
      if (fetchError) throw fetchError;
      setDocuments(updatedDocs || []);
  
      // Update storage usage
      const totalSize = (updatedDocs || []).reduce((sum, doc) => sum + (doc.file_size || (doc.word_count * 1.5)), 0);
      const totalSizeMB = totalSize / (1024 * 1024);
      const formattedSize = totalSizeMB > 0 && totalSizeMB < 0.05 ? 0.1 : Number(totalSizeMB.toFixed(totalSizeMB < 1 ? 1 : 2));
      setStorageUsed(formattedSize);
    } catch (err: any) {
      setError(err.message || 'Failed to upload file');
    }
  };

  // Extract text from .txt file
  const extractTextFromTxt = async (file: File): Promise<string> => {
    try {
      return await file.text();
    } catch (err: any) {
      throw new Error(`Failed to extract text from uploaded file: ${err.message}`);
    }
  };

  // Fetch document content from Supabase storage
  const fetchDocContent = async (filePath: string): Promise<string> => {
    const { data, error } = await supabase
      .storage
      .from('stories')
      .download(filePath);

    if (error) throw new Error(`Failed to download document: ${error.message}`);

    try {
      const text = await data.text();
      return text;
    } catch (err: any) {
      throw new Error(`Failed to extract text from downloaded file: ${err.message}`);
    }
  };

  // Fetch token information
  const fetchTokenInfo = async (): Promise<{ plan_max: number; tokens_used: number; plan_type: 'free' | 'standard' | 'plus' | 'premium' | 'pro' | 'elite' | 'ultimate' | 'enterprise' }> => {
    if (!userId) throw new Error('Authentication error');
    const { data, error } = await supabase
      .rpc('get_user_token_usage', { user_id_param: userId });
    if (error) throw error;
    if (data && data[0]) {
      const usage = data[0];
      return {
        plan_max: (getPlanMaxTokens(usage.plan_type, isLegacy)) + (usage.rollover_tokens || 0),
        tokens_used: usage.tokens_used,
        plan_type: usage.plan_type,
      };
    }
    // Default to free plan if no data
    return {
      plan_max: 400000,
      tokens_used: 0,
      plan_type: 'free',
    };
  };

  // Update token usage with the new formula
  const updateTokenUsage = async (inputTokens: number, outputTokens: number) => {
    if (!userId) throw new Error('Authentication error');

    const totalTokens = Math.round(inputTokens * 0.25 + outputTokens);

    const { data: plan, error: selectError } = await supabase
      .from('user_plans')
      .select('id, tokens_used, plan_type, rollover_tokens')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (selectError && selectError.code !== 'PGRST116') {
      throw new Error(`Failed to fetch user plan: ${selectError.message}`);
    }

    const currentTokensUsed = plan?.tokens_used || 0;
    const rolloverTokens = plan?.rollover_tokens || 0;
    const planMax = getPlanMaxTokens(plan?.plan_type ?? "free", isLegacy);

    const newTokensUsed = currentTokensUsed + totalTokens;

    if (newTokensUsed > planMax + rolloverTokens) {
      throw new Error(`Insufficient tokens. You need ${totalTokens.toLocaleString()} tokens, but only ${(planMax + rolloverTokens - currentTokensUsed).toLocaleString()} remain. Please upgrade your plan at https://x.ai/grok for more tokens.`);
    }

    if (plan) {
      const { error: updateError } = await supabase
        .from('user_plans')
        .update({
          tokens_used: newTokensUsed,
          updated_at: new Date().toISOString(),
        })
        .eq('id', plan.id)
        .eq('user_id', userId);

      if (updateError) {
        throw new Error(`Failed to update token usage: ${updateError.message}`);
      }
    } else {
      const newPlan = {
        user_id: userId,
        plan_type: 'free',
        tokens_allocated: 400000,
        tokens_used: totalTokens,
        rollover_tokens: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        current_period_start: new Date().toISOString(),
        current_period_end: null,
        is_active: true,
      };
      const { error: insertError } = await supabase.from('user_plans').insert(newPlan);

      if (insertError) {
        throw new Error(`Failed to insert new plan: ${insertError.message}`);
      }
    }

    return totalTokens;
  };

  // Handle document comparison
  const handleCompare = async () => {
    if (!userId) {
      setError('Authentication error');
      return;
    }

    if (estimatedTokens > userTokenBalance) {
      setError(`Comparing documents requires approximately ${estimatedTokens.toLocaleString()} tokens, but you only have ${userTokenBalance.toLocaleString()} tokens available. Please upgrade your plan at https://x.ai/grok for more tokens.`);
      return;
    }

    setComparing(true);
    setError(null);

    try {
      let doc1Content: string;
      let doc2Content: string;
      let doc1WordCount: number | undefined;
      let doc2WordCount: number | undefined;

      if (selectedDoc1 && selectedDoc2) {
        const doc1 = documents.find(doc => doc.id === selectedDoc1);
        const doc2 = documents.find(doc => doc.id === selectedDoc2);
        if (!doc1 || !doc2) throw new Error('Selected documents not found');

        setDoc1Label(`${doc1.title}`);
        setDoc2Label(`${doc2.title}`);
        doc1WordCount = doc1.word_count;
        doc2WordCount = doc2.word_count;

        doc1Content = await fetchDocContent(doc1.file_path);
        doc2Content = await fetchDocContent(doc2.file_path);
      } else if (uploadedDoc1 && uploadedDoc2) {
        doc1Content = await extractTextFromTxt(uploadedDoc1);
        doc2Content = await extractTextFromTxt(uploadedDoc2);
        doc1WordCount = calculateWordCount(doc1Content);
        doc2WordCount = calculateWordCount(doc2Content);
      } else {
        throw new Error('Please select two documents or upload two .txt files to compare');
      }

      const [result, inputTokens, outputTokens] = await performComparison(
        doc1Content,
        doc2Content,
        userId,
        crypto.randomUUID(),
        () => false,
        'sonnet',
        1,
        isLegacy
      );

      if (doc1WordCount !== undefined) result.doc1WordCount = doc1WordCount;
      if (doc2WordCount !== undefined) result.doc2WordCount = doc2WordCount;

      const totalTokens = await updateTokenUsage(inputTokens, outputTokens);

      const { plan_max, tokens_used } = await fetchTokenInfo();
      const tokensRemaining = plan_max - tokens_used;

      setTokenInfo({
        tokensUsed: totalTokens,
        tokensRemaining,
      });

      setComparison(result);
    } catch (err: any) {
      setError(err.message || 'Failed to compare documents');
    } finally {
      setComparing(false);
    }
  };

  // Reset comparison state
  const resetComparison = () => {
    setComparison(null);
    setSelectedDoc1('');
    setSelectedDoc2('');
    setUploadedDoc1(null);
    setUploadedDoc2(null);
    setDoc1Label('Document 1');
    setDoc2Label('Document 2');
    setTokenInfo(null);
    setEstimatedTokens(0);
  };

  // Format date for display
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  // Format number for display
  const formatNumber = (num: number) => {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(1)}M`;
    }
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1)}K`;
    }
    return num.toString();
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-red-500"></div>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8" style={{ zoom: 1.1 }}>
        {/* Atmospheric gradient background */}
        <div className="pointer-events-none absolute inset-0 -top-20 overflow-hidden" aria-hidden="true">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120%] h-[500px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(220,38,38,0.14)_0%,transparent_70%)]" />
          <div className="absolute top-40 left-0 w-[40%] h-[300px] bg-[radial-gradient(ellipse_80%_80%_at_20%_50%,rgba(59,130,246,0.07)_0%,transparent_60%)]" />
          <div className="absolute top-60 right-0 w-[35%] h-[250px] bg-[radial-gradient(ellipse_80%_80%_at_80%_50%,rgba(34,197,94,0.06)_0%,transparent_60%)]" />
        </div>

        <div className="relative mb-8 dash-animate-in">
          <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Compare Stories</h1>
          <div className="mt-2">
            <p className="text-text-secondary">Compare different versions of your stories or analyze uploaded .txt files</p>
            <p className="text-text-muted text-sm mt-1">{formatNumber(userTokenBalance)} tokens remaining</p>
          </div>
        </div>

        {error && (
          <div className="p-5 rounded-2xl bg-[--color-status-error-bg] border border-[--color-status-error-border] mb-6">
            <div className="flex items-center space-x-3">
              <div className="flex-shrink-0 h-10 w-10 rounded-full bg-[--color-status-error-bg] flex items-center justify-center">
                <AlertCircle className="h-5 w-5 text-status-error" />
              </div>
              <div>
                <h3 className="text-lg font-display font-semibold text-status-error">Error</h3>
                <p className="text-sm mt-0.5 text-white/70">{error}</p>
              </div>
            </div>
          </div>
        )}

        {!comparison ? (
          <div className="space-y-6">
            <div className="rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card p-6">
              <h2 className="text-xl font-semibold text-white mb-4">Select Documents to Compare</h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-2">
                    First Document (Select from Saved or Upload)
                  </label>
                  <Listbox
                    value={selectedDoc1}
                    onChange={(value) => {
                      setSelectedDoc1(value);
                      setUploadedDoc1(null);
                      setDoc1Label('Document 1');
                    }}
                    disabled={uploadedDoc1 !== null}
                  >
                    {({ open }) => (
                      <div className="relative">
                        <Listbox.Button className={`relative w-full bg-surface-input border border-white/[0.13] rounded-md px-4 py-2.5 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-900/60 shadow-sm transition-all duration-200 ${uploadedDoc1 !== null ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                          <span className="block truncate">
                            {selectedDoc1
                              ? documents.find(doc => doc.id === selectedDoc1)?.title
                              : 'Select a document'}
                          </span>
                          <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                            <ChevronDown className={`h-5 w-5 text-text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
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
                          <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-card border border-border-card rounded-md shadow-lg max-h-60 overflow-auto focus:outline-none">
                            {documents.filter(doc => doc.version === 1 || doc.version === 2).length === 0 ? (
                              <div className="py-2 px-4 text-text-muted text-sm">
                                No documents available
                              </div>
                            ) : (
                              documents
                                .filter(doc => doc.version === 1 || doc.version === 2)
                                .map((doc) => (
                                  <Listbox.Option
                                    key={doc.id}
                                    value={doc.id}
                                    className={({ active, selected }) =>
                                      `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${
                                        active ? 'bg-white/10 text-white' : 'text-text-secondary'
                                      } ${selected ? 'font-medium' : 'font-normal'}`
                                    }
                                  >
                                    {({ selected }) => (
                                      <>
                                        <div className="flex flex-col">
                                          <span className={selected ? 'font-medium' : 'font-normal'}>
                                            {doc.title}
                                          </span>
                                          <span className="text-sm text-text-muted flex items-center">
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
                                ))
                            )}
                          </Listbox.Options>
                        </Transition>
                      </div>
                    )}
                  </Listbox>
                  <div className="relative mt-2">
                    <div className="flex items-center justify-center w-full">
                      <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-border-card border-dashed rounded-xl cursor-pointer bg-surface-input hover:bg-white/10 transition-colors">
                        <div className="flex flex-col items-center justify-center pt-5 pb-6">
                          <Upload className="w-8 h-8 mb-3 text-text-muted" />
                          <p className="mb-2 text-sm text-text-muted">
                            <span className="font-semibold">Click to upload</span> or drag and drop
                          </p>
                          <p className="text-xs text-text-muted">TXT files only (max 1024 KB)</p>
                        </div>
                        <input
                          type="file"
                          className="hidden"
                          accept=".txt"
                          onChange={(e) => handleFileUpload(e, 1)}
                          disabled={selectedDoc1 !== ''}
                        />
                      </label>
                    </div>
                    {uploadedDoc1 && (
                      <div className="mt-2 flex items-center justify-between bg-surface-card p-2 rounded-xl">
                        <span className="text-sm text-text-secondary">{uploadedDoc1.name}</span>
                        <button
                          onClick={() => {
                            setUploadedDoc1(null);
                            setDoc1Label('Document 1');
                          }}
                          className="text-text-muted hover:text-white"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-2">
                    Second Document (Select from Saved or Upload)
                  </label>
                  <Listbox
                    value={selectedDoc2}
                    onChange={(value) => {
                      setSelectedDoc2(value);
                      setUploadedDoc2(null);
                      setDoc2Label('Document 2');
                    }}
                    disabled={uploadedDoc2 !== null}
                  >
                    {({ open }) => (
                      <div className="relative">
                        <Listbox.Button className={`relative w-full bg-surface-input border border-white/[0.13] rounded-md px-4 py-2.5 text-left text-white focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-900/60 shadow-sm transition-all duration-200 ${uploadedDoc2 !== null ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                          <span className="block truncate">
                            {selectedDoc2
                              ? documents.find(doc => doc.id === selectedDoc2)?.title
                              : 'Select a document'}
                          </span>
                          <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                            <ChevronDown className={`h-5 w-5 text-text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
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
                          <Listbox.Options className="absolute z-10 mt-1 w-full bg-surface-card border border-border-card rounded-md shadow-lg max-h-60 overflow-auto focus:outline-none">
                            {documents.filter(doc => doc.version === 1 || doc.version === 2).length === 0 ? (
                              <div className="py-2 px-4 text-text-muted text-sm">
                                No documents available
                              </div>
                            ) : (
                              documents
                                .filter(doc => doc.version === 1 || doc.version === 2)
                                  .map((doc) => (
                                    <Listbox.Option
                                      key={doc.id}
                                      value={doc.id}
                                      className={({ active, selected }) =>
                                        `relative cursor-pointer select-none py-2 px-4 flex justify-between items-center ${
                                          active ? 'bg-white/10 text-white' : 'text-text-secondary'
                                        } ${selected ? 'font-medium' : 'font-normal'}`
                                      }
                                    >
                                    {({ selected }) => (
                                      <>
                                        <div className="flex flex-col">
                                          <span className={selected ? 'font-medium' : 'font-normal'}>
                                            {doc.title}
                                          </span>
                                          <span className="text-sm text-text-muted flex items-center">
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
                                ))
                            )}
                          </Listbox.Options>
                        </Transition>
                      </div>
                    )}
                  </Listbox>
                  <div className="relative mt-2">
                    <div className="flex items-center justify-center w-full">
                      <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-border-card border-dashed rounded-xl cursor-pointer bg-surface-input hover:bg-white/10 transition-colors">
                        <div className="flex flex-col items-center justify-center pt-5 pb-6">
                          <Upload className="w-8 h-8 mb-3 text-text-muted" />
                          <p className="mb-2 text-sm text-text-muted">
                            <span className="font-semibold">Click to upload</span> or drag and drop
                          </p>
                          <p className="text-xs text-text-muted">TXT files only (max {Math.round(Math.min(1, (10 - (storageUsed || 0))) * 1024)} KB)</p>
                        </div>
                        <input
                          type="file"
                          className="hidden"
                          accept=".txt"
                          onChange={(e) => handleFileUpload(e, 2)}
                          disabled={selectedDoc2 !== ''}
                        />
                      </label>
                    </div>
                    {uploadedDoc2 && (
                      <div className="mt-2 flex items-center justify-between bg-surface-card p-2 rounded-xl">
                        <span className="text-sm text-text-secondary">{uploadedDoc2.name}</span>
                        <button
                          onClick={() => {
                            setUploadedDoc2(null);
                            setDoc2Label('Document 2');
                          }}
                          className="text-text-muted hover:text-white"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-6 space-y-4">
                {(selectedDoc1 || uploadedDoc1) && (selectedDoc2 || uploadedDoc2) && estimatedTokens > 0 && (
                  <div>
                    <p className="text-sm font-medium text-text-secondary mb-2">Estimated Token Usage</p>
                    <p className="text-sm text-text-muted">Comparison: {formatNumber(estimatedTokens)} tokens</p>
                    {estimatedTokens > userTokenBalance && (
                      <div className="bg-yellow-900/50 text-yellow-200 p-4 rounded-xl mt-2">
                        <div className="flex items-center space-x-2 text-yellow-500 mb-2">
                          <AlertCircle className="h-5 w-5" />
                          <h3 className="text-lg font-medium">Warning</h3>
                        </div>
                        <p>
                          The estimated token usage for Comparison ({formatNumber(estimatedTokens)} tokens) exceeds your remaining balance of {formatNumber(userTokenBalance)} tokens. Please upgrade your plan at <a href="https://northnoir.com/pricing" className="underline text-status-error">Pricing</a> to proceed.
                        </p>
                      </div>
                    )}
                  </div>
                )}
                <button
                  onClick={handleCompare}
                  disabled={comparing || (!(selectedDoc1 || uploadedDoc1) || !(selectedDoc2 || uploadedDoc2)) || estimatedTokens > userTokenBalance}
                  className="w-full flex justify-center items-center px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {comparing ? (
                    <>
                      <RefreshCw className="animate-spin h-5 w-5 mr-2" />
                      Comparing...
                    </>
                  ) : (
                    'Compare Documents'
                  )}
                </button>

                {comparing && (
                  <div className="bg-surface-card rounded-xl p-4 space-y-3">
                    <div className="flex items-center space-x-3 text-text-secondary">
                      <Brain className="h-5 w-5 text-status-error animate-pulse" />
                      <span>Analyzing document structure and content...</span>
                    </div>
                    <div className="flex items-center space-x-3 text-text-secondary">
                      <Sparkles className="h-5 w-5 text-status-error animate-pulse" />
                      <span>Evaluating writing quality...</span>
                    </div>
                    <p className="text-sm text-text-muted">This could take 1–3 minutes.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <h3 className="text-lg font-medium text-white">Story Comparison</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <EvaluationSection
                review={{
                  ...comparison.doc1Review,
                  rating: comparison.doc1Rating,
                  wordCount: comparison.doc1WordCount,
                }}
                label={doc1Label}
              />
              <EvaluationSection
                review={{
                  ...comparison.doc2Review,
                  rating: comparison.doc2Rating,
                  wordCount: comparison.doc2WordCount,
                }}
                label={doc2Label}
              />
            </div>
            <div className="bg-surface-card rounded-xl p-4">
              <h4 className="text-sm font-medium text-text-secondary mb-2">Summary</h4>
              <p className="text-text-secondary">{comparison.summary}</p>
            </div>
            {tokenInfo && (
              <div className="bg-surface-card rounded-xl p-4">
                <h4 className="text-sm font-medium text-text-secondary mb-2">Token Usage</h4>
                <p className="text-text-secondary text-sm">
                  This comparison used <span className="font-semibold text-status-error">{formatNumber(tokenInfo.tokensUsed)}</span> tokens.
                </p>
                <p className="text-text-secondary text-sm">
                  You have <span className="font-semibold text-green-500">{formatNumber(tokenInfo.tokensRemaining)}</span> tokens remaining.
                </p>
              </div>
            )}
            <div className="flex justify-end">
              <button
                onClick={resetComparison}
                className="flex items-center px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors shadow-sm"
              >
                <RefreshCw className="h-5 w-5 mr-2" />
                Compare Different Documents
              </button>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

