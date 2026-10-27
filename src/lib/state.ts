// Server-side workflow state machine. The only place allowed transitions are defined.
export const STATES = [
  'SUBMITTED',
  'TRIAGE',
  'QUEUED',
  'IN_PRODUCTION',
  'QC_REVIEW',
  'APPROVED',
  'DELIVERED',
  'NEEDS_INFO',
  'NEEDS_REVISION',
  'BLOCKED_PROVIDER',
  'FAILED',
  'CANCELLED'
] as const
export type JobState = (typeof STATES)[number]

export const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  SUBMITTED: ['TRIAGE', 'CANCELLED'],
  TRIAGE: ['QUEUED', 'NEEDS_INFO', 'CANCELLED'],
  NEEDS_INFO: ['TRIAGE', 'CANCELLED'],
  QUEUED: ['IN_PRODUCTION', 'CANCELLED'],
  IN_PRODUCTION: ['QC_REVIEW', 'BLOCKED_PROVIDER', 'FAILED', 'CANCELLED'],
  BLOCKED_PROVIDER: ['IN_PRODUCTION', 'QUEUED', 'FAILED', 'CANCELLED'],
  FAILED: ['QUEUED', 'CANCELLED'],
  QC_REVIEW: ['APPROVED', 'NEEDS_REVISION', 'CANCELLED'],
  NEEDS_REVISION: ['IN_PRODUCTION', 'QUEUED', 'CANCELLED'],
  // APPROVED is the ONLY state that may move to DELIVERED.
  APPROVED: ['DELIVERED', 'NEEDS_REVISION', 'CANCELLED'],
  // After delivery the customer may request an eligible revision.
  DELIVERED: ['NEEDS_REVISION'],
  CANCELLED: []
}

export function isState(s: unknown): s is JobState {
  return typeof s === 'string' && (STATES as readonly string[]).includes(s)
}

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

/** Customer-safe status. Internal failures/blocks are never revealed to customers. */
export type CustomerStatus = 'received' | 'needs_info' | 'in_progress' | 'delivered' | 'cancelled'

export function customerStatus(s: JobState): CustomerStatus {
  switch (s) {
    case 'SUBMITTED':
    case 'TRIAGE':
    case 'QUEUED':
      return 'received'
    case 'NEEDS_INFO':
      return 'needs_info'
    case 'DELIVERED':
      return 'delivered'
    case 'CANCELLED':
      return 'cancelled'
    default:
      return 'in_progress'
  }
}

export const STATE_LABEL: Record<JobState, string> = {
  SUBMITTED: 'Submitted',
  TRIAGE: 'Triage',
  QUEUED: 'Queued',
  IN_PRODUCTION: 'In production',
  QC_REVIEW: 'QC review',
  APPROVED: 'Approved',
  DELIVERED: 'Delivered',
  NEEDS_INFO: 'Needs info',
  NEEDS_REVISION: 'Needs revision',
  BLOCKED_PROVIDER: 'Blocked (provider)',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled'
}
