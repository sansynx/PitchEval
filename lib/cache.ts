import { createHash } from 'crypto'
import { getRedisClient } from './redis'

export interface CachedEvaluation {
  scores: {
    feasibility: number
    innovation: number
    impact: number
    clarity: number
    overall: number
  }
  suggestions: string[]
  domain: string
  fileName: string
  createdAt: string
  cacheTimestamp: string
  detectedDomain?: {
    category: string
    confidence: number
    reason: string
  }
}

// Generate cache key from file content
export function generateFileHash(fileBuffer: Buffer, fileName: string): string {
  const hash = createHash('sha256')
  hash.update(fileBuffer)
  hash.update(fileName)
  return hash.digest('hex')
}

// Cache key format: pitch:hash:domain:context
// Context includes tracks, weights, template, etc. to prevent cache collision
export function getCacheKey(
  fileHash: string, 
  domain: string, 
  context?: {
    tracks?: string[]
    weights?: Record<string, number>
    hasTemplate?: boolean
    templateFingerprint?: string
    templateContext?: string
    description?: string
    userId?: string
    evaluationType?: 'personal' | 'hackathon'
  }
): string {
  let key = `pitch:${fileHash}:${domain.toLowerCase()}`
  
  if (context) {
    // Add evaluation type
    if (context.evaluationType) {
      key += `:${context.evaluationType}`
    }
    
    // Add tracks (sorted for consistency)
    if (context.tracks && context.tracks.length > 0) {
      const sortedTracks = [...context.tracks].sort().join(',')
      const tracksHash = createHash('sha256').update(sortedTracks).digest('hex').substring(0, 8)
      key += `:t${tracksHash}`
    }
    
    // Add weights (sorted keys for consistency)
    if (context.weights) {
      const weightsStr = Object.keys(context.weights)
        .sort()
        .map(k => `${k}:${context.weights![k]}`)
        .join(',')
      const weightsHash = createHash('sha256').update(weightsStr).digest('hex').substring(0, 8)
      key += `:w${weightsHash}`
    }
    
    // Add template flag
    if (context.hasTemplate) {
      key += `:tpl`
    }

    for (const value of [context.templateFingerprint, context.templateContext, context.description, context.userId]) {
      if (value) {
        key += `:c${createHash('sha256').update(value).digest('hex').substring(0, 12)}`
      }
    }
  }
  
  return key
}

// Get cached evaluation
export async function getCachedEvaluation(
  fileHash: string, 
  domain: string,
  context?: {
    tracks?: string[]
    weights?: Record<string, number>
    hasTemplate?: boolean
    templateFingerprint?: string
    templateContext?: string
    description?: string
    userId?: string
    evaluationType?: 'personal' | 'hackathon'
  }
): Promise<CachedEvaluation | null> {
  try {
    const redis = await getRedisClient()
    const cacheKey = getCacheKey(fileHash, domain, context)
    
    const cached = await redis.get(cacheKey)
    if (!cached) {
      return null // Cache miss - no logging needed
    }

    const evaluation = JSON.parse(cached) as CachedEvaluation
    
    // Check if cache is still valid (7 days)
    const cacheAge = Date.now() - new Date(evaluation.cacheTimestamp).getTime()
    const maxAge = 7 * 24 * 60 * 60 * 1000 // 7 days
    
    if (cacheAge > maxAge) {
      await redis.del(cacheKey)
      return null // Cache expired
    }

    return evaluation
  } catch (error) {
    // Silently fail - system continues without cache
    return null
  }
}

// Cache evaluation result
export async function setCachedEvaluation(
  fileHash: string,
  domain: string,
  evaluation: Omit<CachedEvaluation, 'cacheTimestamp'>,
  context?: {
    tracks?: string[]
    weights?: Record<string, number>
    hasTemplate?: boolean
    templateFingerprint?: string
    templateContext?: string
    description?: string
    userId?: string
    evaluationType?: 'personal' | 'hackathon'
  }
): Promise<void> {
  try {
    const redis = await getRedisClient()
    const cacheKey = getCacheKey(fileHash, domain, context)
    
    const cacheData: CachedEvaluation = {
      ...evaluation,
      cacheTimestamp: new Date().toISOString()
    }

    // Cache for 7 days
    await redis.setEx(cacheKey, 7 * 24 * 60 * 60, JSON.stringify(cacheData))
  } catch (error) {
    // Silently fail - system continues without caching
  }
}

// Get cache statistics
export async function getCacheStats(): Promise<{
  totalKeys: number
  memoryUsage: string
  hitRate?: number
}> {
  try {
    const redis = await getRedisClient()
    
    const keys = await redis.keys('pitch:*')
    const info = await redis.info('memory')
    
    const memoryMatch = info.match(/used_memory_human:(.+)/)
    const memoryUsage = memoryMatch ? memoryMatch[1].trim() : 'Unknown'

    return {
      totalKeys: keys.length,
      memoryUsage,
    }
  } catch (error) {
    console.error('Cache stats error:', error)
    return {
      totalKeys: 0,
      memoryUsage: 'Unknown'
    }
  }
}

// Clear old cache entries
export async function clearExpiredCache(): Promise<number> {
  try {
    const redis = await getRedisClient()
    const keys = await redis.keys('pitch:*')
    let deletedCount = 0

    for (const key of keys) {
      const cached = await redis.get(key)
      if (cached) {
        const evaluation = JSON.parse(cached) as CachedEvaluation
        const cacheAge = Date.now() - new Date(evaluation.cacheTimestamp).getTime()
        const maxAge = 7 * 24 * 60 * 60 * 1000 // 7 days

        if (cacheAge > maxAge) {
          await redis.del(key)
          deletedCount++
        }
      }
    }

    return deletedCount
  } catch (error) {
    console.error('Cache cleanup error:', error)
    return 0
  }
}
