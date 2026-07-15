import { NextRequest, NextResponse } from 'next/server'
import { queueWorker } from '../../../../lib/workers/queueWorker'
import { auth } from '@clerk/nextjs/server'
import { isAuthorizedOperator } from '../../../../lib/security'

export async function POST(request: NextRequest) {
  try {
    const { sessionClaims } = await auth()
    if (!isAuthorizedOperator(request, sessionClaims)) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    if (queueWorker.isWorkerRunning()) {
      return NextResponse.json({
        success: true,
        message: 'Queue worker is already running'
      })
    }

    await queueWorker.start()

    return NextResponse.json({
      success: true,
      message: 'Queue worker started successfully'
    })

  } catch (error) {
    console.error('Failed to start queue worker:', error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      message: 'Failed to start queue worker'
    }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return NextResponse.json({
    success: true,
    isRunning: queueWorker.isWorkerRunning(),
    message: queueWorker.isWorkerRunning() ? 'Queue worker is running' : 'Queue worker is not running'
  })
}
