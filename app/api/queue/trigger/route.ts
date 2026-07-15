import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getInternalAppOrigin, isAuthorizedOperator } from '../../../../lib/security'

export async function POST(request: NextRequest) {
  try {
    const { sessionClaims } = await auth()
    const { queueName = 'personal_evaluation', maxJobs = 10 } = await request.json()
    
    // Allow internal calls with userId in body, or external calls with auth
    if (!isAuthorizedOperator(request, sessionClaims)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    // Trigger queue processing by calling our process endpoint
    const internalOrigin = getInternalAppOrigin()
    if (!internalOrigin) {
      return NextResponse.json({ error: 'Queue processing is not configured with a trusted APP_URL' }, { status: 503 })
    }
    const processUrl = new URL('/api/queue/process', internalOrigin)
    
    const response = await fetch(processUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-api-secret': process.env.INTERNAL_API_SECRET || '' },
      body: JSON.stringify({ queueName, maxJobs })
    })
    
    const result = await response.json()
    
    if (!response.ok) {
      return NextResponse.json(result, { status: response.status })
    }
    
    // If there are more jobs, trigger another processing cycle
    if (result.hasMoreJobs && result.remainingJobs > 0) {
      console.log(`🔄 Triggering next batch: ${result.remainingJobs} jobs remaining`)
      
      // Trigger next batch after a small delay (non-blocking)
      setTimeout(async () => {
        try {
          await fetch(processUrl.toString(), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-api-secret': process.env.INTERNAL_API_SECRET || ''
            },
            body: JSON.stringify({ queueName, maxJobs })
          })
        } catch (error) {
          console.error('Failed to trigger next batch:', error)
        }
      }, 2000) // 2 second delay between batches
    }
    
    return NextResponse.json({
      ...result,
      triggered: true,
      nextBatchScheduled: result.hasMoreJobs
    })

  } catch (error) {
    console.error('Queue trigger failed:', error)
    return NextResponse.json({ 
      error: 'Queue trigger failed', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    }, { status: 500 })
  }
}
