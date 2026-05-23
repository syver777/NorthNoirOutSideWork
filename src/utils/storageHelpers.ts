/**
 * Storage limit utilities
 * Centralized functions for managing storage limits across different user plans
 */

/**
 * Get storage limit in GB based on user plan
 * @param planType - User's plan type (free, standard, plus, premium, pro, elite, ultimate, enterprise)
 * @returns Storage limit in GB
 */
export function getStorageLimitGB(planType: string): number {
  // Free plan gets 200 MB (0.195 GB to be precise, but we display as 200 MB)
  if (planType === 'free') return 0.195;
  
  // Elite, Ultimate, and Enterprise get 30 GB
  if (['elite', 'ultimate', 'enterprise'].includes(planType.toLowerCase())) return 30;
  
  // Standard, Plus, Premium, Pro get 15 GB
  return 15;
}

/**
 * Format storage limit for display
 * @param planType - User's plan type
 * @returns Formatted storage limit string (e.g., "200 MB", "15 GB", "30 GB")
 */
export function getStorageLimitFormatted(planType: string): string {
  if (planType === 'free') return '200 MB';
  if (['elite', 'ultimate', 'enterprise'].includes(planType.toLowerCase())) return '30 GB';
  return '15 GB';
}

/**
 * Get storage limit in MB based on user plan
 * @param planType - User's plan type
 * @returns Storage limit in MB
 */
export function getStorageLimitMB(planType: string): number {
  return getStorageLimitGB(planType) * 1024;
}
