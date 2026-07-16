import { timingSafeEqual } from 'crypto'

export const MAX_PDF_SIZE = 10 * 1024 * 1024
export const MAX_HACKATHON_FILES = 20
const rateLimitBuckets = new Map<string, number[]>()

export function isWithinRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const active = (rateLimitBuckets.get(key) ?? []).filter(timestamp => timestamp > now - windowMs)
  if (active.length >= limit) {
    rateLimitBuckets.set(key, active)
    return false
  }
  active.push(now)
  rateLimitBuckets.set(key, active)
  return true
}

export async function isValidPdfUpload(file: File | null): Promise<boolean> {
  if (!file || !(file instanceof File) || file.type !== 'application/pdf' || file.size < 5 || file.size > MAX_PDF_SIZE) {
    return false
  }

  const signature = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer())
  return signature === '%PDF-'
}

export function hasValidWeights(weights: unknown): weights is Record<'innovation' | 'feasibility' | 'impact' | 'clarity', number> {
  if (!weights || typeof weights !== 'object') return false
  const values = ['innovation', 'feasibility', 'impact', 'clarity'].map(key => (weights as Record<string, unknown>)[key])
  if (!values.every((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100)) {
    return false
  }
  return values.reduce((total, value) => total + value, 0) === 100
}

export function sanitizeDownloadFilename(value: string, fallback = 'download'): string {
  const safe = value.replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 120)
  return safe || fallback
}

export function escapeCsvCell(value: unknown): string {
  const cell = String(value ?? '')
  const formulaSafe = /^[\s]*[=+\-@]/.test(cell) ? `'${cell}` : cell
  return `"${formulaSafe.replace(/"/g, '""')}"`
}

export function isAuthorizedOperator(request: Request, sessionClaims: unknown): boolean {
  const secret = process.env.INTERNAL_API_SECRET
  const presented = request.headers.get('x-internal-api-secret')
  if (secret && presented && secret.length === presented.length && timingSafeEqual(Buffer.from(secret), Buffer.from(presented))) {
    return true
  }

  const claims = sessionClaims as { publicMetadata?: { role?: string }, metadata?: { role?: string }, role?: string } | null
  return claims?.publicMetadata?.role === 'admin' || claims?.metadata?.role === 'admin' || claims?.role === 'admin'
}

export function getInternalAppOrigin(): string | null {
  const configuredUrl = process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined)
  if (!configuredUrl) return null

  try {
    const url = new URL(configuredUrl)
    if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') return null
    return url.origin
  } catch {
    return null
  }
}
