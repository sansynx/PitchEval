import { NextRequest, NextResponse } from 'next/server'
import dbConnect from '@/lib/mongodb'
import { checkRedisHealth } from '@/lib/redis'
import { checkQueueHealth } from '@/lib/queue'
import { auth } from '@clerk/nextjs/server'
import { isAuthorizedOperator } from '@/lib/security'

export async function GET(request: NextRequest) {
  const { sessionClaims } = await auth()
  if (!isAuthorizedOperator(request, sessionClaims)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const healthCheck = {
    timestamp: new Date().toISOString(),
    environment: process.env.VERCEL ? 'vercel' : 'local',
    services: {
      mongodb: { status: 'unknown', error: null as string | null },
      redis: { status: 'unknown', error: null as string | null },
      rabbitmq: { status: 'unknown', error: null as string | null },
      gemini: { status: 'unknown', error: null as string | null }
    }
  }

  // Test MongoDB
  try {
    await dbConnect()
    healthCheck.services.mongodb.status = 'healthy'
    console.log('✅ MongoDB: Healthy')
  } catch (error) {
    healthCheck.services.mongodb.status = 'unhealthy'
    healthCheck.services.mongodb.error = error instanceof Error ? error.message : 'Connection failed'
    console.error('❌ MongoDB: Unhealthy -', healthCheck.services.mongodb.error)
  }

  // Test Redis
  try {
    const redisHealth = await checkRedisHealth()
    if (redisHealth.healthy) {
      healthCheck.services.redis.status = 'healthy'
      console.log('✅ Redis: Healthy')
    } else {
      healthCheck.services.redis.status = 'unhealthy'
      healthCheck.services.redis.error = redisHealth.error || 'Unknown error'
      console.error('❌ Redis: Unhealthy -', healthCheck.services.redis.error)
    }
  } catch (error) {
    healthCheck.services.redis.status = 'unhealthy'
    healthCheck.services.redis.error = error instanceof Error ? error.message : 'Connection failed'
    console.error('❌ Redis: Unhealthy -', healthCheck.services.redis.error)
  }

  // Test RabbitMQ
  try {
    if (process.env.RABBITMQ_URL) {
      const queueHealth = await checkQueueHealth()
      if (queueHealth.healthy) {
        healthCheck.services.rabbitmq.status = 'healthy'
        console.log('✅ RabbitMQ: Healthy')
      } else {
        healthCheck.services.rabbitmq.status = 'unhealthy'
        healthCheck.services.rabbitmq.error = queueHealth.error || 'Unknown error'
        console.error('❌ RabbitMQ: Unhealthy -', healthCheck.services.rabbitmq.error)
      }
    } else {
      healthCheck.services.rabbitmq.status = 'not-configured'
      console.log('⚠️ RabbitMQ: Not configured')
    }
  } catch (error) {
    healthCheck.services.rabbitmq.status = 'unhealthy'
    healthCheck.services.rabbitmq.error = error instanceof Error ? error.message : 'Connection failed'
    console.error('❌ RabbitMQ: Unhealthy -', healthCheck.services.rabbitmq.error)
  }

  // Test Gemini API
  try {
    if (process.env.GEMINI_API_KEY) {
      healthCheck.services.gemini.status = 'configured'
      console.log('✅ Gemini API: Configured')
    } else {
      healthCheck.services.gemini.status = 'not-configured'
      healthCheck.services.gemini.error = 'API key not provided'
      console.error('❌ Gemini API: Not configured')
    }
  } catch (error) {
    healthCheck.services.gemini.status = 'error'
    healthCheck.services.gemini.error = error instanceof Error ? error.message : 'Unknown error'
    console.error('❌ Gemini API: Error -', healthCheck.services.gemini.error)
  }

  // Determine overall health
  const criticalServices = ['mongodb', 'gemini']
  const hasCriticalFailure = criticalServices.some(
    service => healthCheck.services[service as keyof typeof healthCheck.services].status === 'unhealthy'
  )

  const overallStatus = hasCriticalFailure ? 'unhealthy' : 'healthy'

  return NextResponse.json({
    status: overallStatus,
    ...healthCheck
  }, { 
    status: overallStatus === 'healthy' ? 200 : 503 
  })
}
