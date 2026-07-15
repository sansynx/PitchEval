import { NextResponse } from 'next/server'
import { initializeServices } from '../../../lib/startup'
import { queueWorker } from '../../../lib/workers/queueWorker'
import { auth } from '@clerk/nextjs/server'
import { isAuthorizedOperator } from '../../../lib/security'

export async function GET() {
  try {
    // Check queue worker status
    const isWorkerRunning = queueWorker.isWorkerRunning()

    return NextResponse.json({
      success: true,
      status: 'healthy',
      services: {
        queueWorker: {
          running: isWorkerRunning,
          enabled: process.env.START_QUEUE_WORKER === 'true' || process.env.NODE_ENV === 'production'
        }
      },
      timestamp: new Date().toISOString()
    })

  } catch (error) {
    console.error('Health check failed:', error)
    return NextResponse.json({
      success: false,
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const { sessionClaims } = await auth()
    if (!isAuthorizedOperator(request, sessionClaims)) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    console.log('🔄 Manual service initialization requested...')
    
    // Force re-initialization
    await initializeServices()
    
    return NextResponse.json({
      success: true,
      message: 'Services initialized successfully',
      queueWorkerRunning: queueWorker.isWorkerRunning()
    })

  } catch (error) {
    console.error('Manual initialization failed:', error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}
