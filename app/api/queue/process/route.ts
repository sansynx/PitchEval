import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getChannel, QUEUES, getQueueStats, EvaluationJob } from '../../../../lib/queue'
import { processEvaluationJob } from '../../../../lib/processors/evaluationProcessor'
import { isAuthorizedOperator } from '../../../../lib/security'

export async function POST(request: NextRequest) {
  try {
    const { sessionClaims } = await auth()
    const { queueName, maxJobs = 5 } = await request.json()
    
    // Allow internal calls with userId in body, or external calls with auth
    if (!isAuthorizedOperator(request, sessionClaims)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check if queue system is available
    if (!process.env.RABBITMQ_URL) {
      return NextResponse.json({ 
        error: 'Queue system not configured',
        message: 'RabbitMQ URL not provided in environment variables'
      }, { status: 503 })
    }
    
    if (!queueName || !Object.values(QUEUES).includes(queueName)) {
      return NextResponse.json({ error: 'Invalid queue name' }, { status: 400 })
    }

    // Validate maxJobs to prevent abuse
    if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 50) {
      return NextResponse.json({ 
        error: 'Too many jobs requested',
        message: 'Maximum 50 jobs per batch to prevent timeouts'
      }, { status: 400 })
    }

    // Processing queue jobs
    
    let processedCount = 0
    let failedCount = 0
    const startTime = Date.now()
    const maxProcessingTime = process.env.VERCEL ? 50000 : 300000 // 50s for Vercel, 5min for others
    const errors: string[] = []
    
    // Get channel for manual message consumption
    const channel = await getChannel()
    
    // Process jobs one by one until we hit limits
    while (processedCount < maxJobs && (Date.now() - startTime) < maxProcessingTime) {
      try {
        // Check if there are jobs in the queue
        const stats = await getQueueStats(queueName)
        if (stats.messageCount === 0) {
          // Queue is empty
          break
        }
        
        // Manually get one message from the queue
        const msg = await channel.get(queueName, { noAck: false })
        
        if (!msg) {
          // No more messages available
          break
        }
        
        const jobStartTime = Date.now()
        
        try {
          // Parse and process the job
          const job: EvaluationJob = JSON.parse(msg.content.toString())
          
          // Process with timeout protection
          await Promise.race([
            processEvaluationJob(job),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Job timeout')), 45000) // 45s timeout per job
            )
          ])
          
          // Acknowledge successful processing
          channel.ack(msg)
          processedCount++
          console.log(`✅ Completed job: ${job.evaluationId} in ${Date.now() - jobStartTime}ms`)
          
        } catch (jobError) {
          const errorMsg = jobError instanceof Error ? jobError.message : 'Unknown error'
          console.error(`❌ Job processing failed:`, errorMsg)
          
          // Handle retry logic
          const retryCount = (msg.properties.headers?.['x-retry-count'] || 0) + 1
          
          if (retryCount <= 3) {
            // Requeue with retry count
            channel.sendToQueue(queueName, msg.content, {
              persistent: true,
              headers: { 'x-retry-count': retryCount },
              priority: msg.properties.priority || 5
            })
            channel.ack(msg)
            console.log(`🔄 Requeued job (retry ${retryCount}/3)`)
          } else {
            // Max retries reached
            console.error(`❌ Max retries reached for job, removing from queue`)
            channel.ack(msg)
          }
          
          errors.push(errorMsg)
          failedCount++
          
          // Stop if too many failures
          if (failedCount >= 3) {
            console.log(`⚠️ Too many failures (${failedCount}), stopping batch`)
            break
          }
        }
        
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error'
        console.error(`❌ Error in processing loop:`, errorMsg)
        errors.push(errorMsg)
        failedCount++
        
        // Stop if too many failures
        if (failedCount >= 3) {
          console.log(`⚠️ Too many failures (${failedCount}), stopping batch`)
          break
        }
      }
    }
    
    // Check if there are more jobs to process
    const finalStats = await getQueueStats(queueName)
    const hasMoreJobs = finalStats.messageCount > 0
    const processingTime = Date.now() - startTime
    
    return NextResponse.json({
      success: true,
      processedJobs: processedCount,
      failedJobs: failedCount,
      processingTime,
      averageJobTime: processedCount > 0 ? Math.round(processingTime / processedCount) : 0,
      remainingJobs: finalStats.messageCount,
      hasMoreJobs,
      errors: errors.length > 0 ? errors : undefined,
      message: hasMoreJobs 
        ? `Processed ${processedCount} jobs (${failedCount} failed). ${finalStats.messageCount} jobs remaining.`
        : `Processed ${processedCount} jobs (${failedCount} failed). Queue is now empty.`,
      recommendation: hasMoreJobs && failedCount < 3 
        ? 'Continue processing remaining jobs'
        : failedCount >= 3 
        ? 'Check logs for recurring errors before continuing'
        : 'All jobs completed successfully'
    })

  } catch (error) {
    console.error('Queue processing failed:', error)
    return NextResponse.json({ 
      error: 'Queue processing failed', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    }, { status: 500 })
  }
}

// GET endpoint to check queue status
export async function GET(request: NextRequest) {
  try {
    const { sessionClaims } = await auth()
    if (!isAuthorizedOperator(request, sessionClaims)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const queueName = searchParams.get('queue')
    
    if (!queueName || !Object.values(QUEUES).includes(queueName)) {
      return NextResponse.json({ error: 'Invalid queue name' }, { status: 400 })
    }
    
    const stats = await getQueueStats(queueName)
    
    return NextResponse.json({
      queueName,
      messageCount: stats.messageCount,
      consumerCount: stats.consumerCount,
      isEmpty: stats.messageCount === 0
    })
    
  } catch (error) {
    return NextResponse.json({ 
      error: 'Failed to get queue stats',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}
