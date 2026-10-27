import { describe, it, expect } from 'vitest'
import { canTransition, customerStatus, STATES, TRANSITIONS } from '../src/lib/state'

describe('state machine (pure)', () => {
  it('allows the happy path in order', () => {
    const path = ['SUBMITTED', 'TRIAGE', 'QUEUED', 'IN_PRODUCTION', 'QC_REVIEW', 'APPROVED', 'DELIVERED'] as const
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true)
  })

  it('only APPROVED can move to DELIVERED', () => {
    for (const s of STATES) expect(canTransition(s, 'DELIVERED')).toBe(s === 'APPROVED')
  })

  it('rejects skipping steps', () => {
    expect(canTransition('SUBMITTED', 'IN_PRODUCTION')).toBe(false)
    expect(canTransition('QUEUED', 'QC_REVIEW')).toBe(false)
    expect(canTransition('IN_PRODUCTION', 'APPROVED')).toBe(false)
    expect(canTransition('QC_REVIEW', 'DELIVERED')).toBe(false)
  })

  it('CANCELLED is terminal', () => {
    expect(TRANSITIONS.CANCELLED).toEqual([])
  })

  it('never exposes internal failure states to customers', () => {
    expect(customerStatus('FAILED')).toBe('in_progress')
    expect(customerStatus('BLOCKED_PROVIDER')).toBe('in_progress')
    expect(customerStatus('QC_REVIEW')).toBe('in_progress')
    expect(customerStatus('APPROVED')).toBe('in_progress')
    expect(customerStatus('DELIVERED')).toBe('delivered')
  })
})
