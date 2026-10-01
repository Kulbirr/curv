/**
 * Mobile wallets open an external app to sign. If the user abandons the
 * request there (back button, app switch, no prompt shown), the signing
 * promise may never settle, which would strand the UI on a "waiting for
 * signature" state forever. Bound every wallet signature with a timeout so
 * the user always gets an error and a retry path.
 */
export const SIGN_TIMEOUT_MS = 120_000
export const SIGN_TIMEOUT_SENTINEL = '__CURV_SIGN_TIMEOUT__'

export function withSignTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(SIGN_TIMEOUT_SENTINEL)),
      SIGN_TIMEOUT_MS
    )
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export function isSignTimeout(e: unknown): boolean {
  return e instanceof Error && e.message === SIGN_TIMEOUT_SENTINEL
}

export function signingTimeoutMessage(): string {
  return (
    'The wallet did not answer the signature request. ' +
    'If you left the wallet app, return to this page, reconnect, and try again.'
  )
}
