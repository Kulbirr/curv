import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  isSignTimeout,
  SIGN_TIMEOUT_MS,
  signingTimeoutMessage,
  withSignTimeout,
} from './sign-timeout'

describe('sign-timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the wrapped value when the promise settles in time', async () => {
    await expect(withSignTimeout(Promise.resolve(42))).resolves.toBe(42)
  })

  it('propagates the wrapped rejection when it settles in time', async () => {
    await expect(
      withSignTimeout(Promise.reject(new Error('user rejected')))
    ).rejects.toThrow('user rejected')
  })

  it('rejects with the sign-timeout sentinel after SIGN_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    const pending = withSignTimeout(new Promise(() => {}))
    const assertion = expect(pending).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(SIGN_TIMEOUT_MS)
    await assertion
    await expect(pending).rejects.toSatisfy(isSignTimeout)
  })

  it('isSignTimeout only matches the sentinel error', () => {
    expect(isSignTimeout(new Error('nope'))).toBe(false)
    expect(isSignTimeout(null)).toBe(false)
    expect(isSignTimeout('string')).toBe(false)
  })

  it('signingTimeoutMessage guides the user to reconnect and retry', () => {
    const msg = signingTimeoutMessage()
    expect(msg).toMatch(/did not answer/i)
    expect(msg).toMatch(/reconnect/i)
  })
})
