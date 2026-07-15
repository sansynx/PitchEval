import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import dbConnect from '../../../../lib/mongodb'
import Evaluation from '../../../../lib/models/Evaluation'
import { addToQueue, QUEUES, PersonalEvaluationJob } from '../../../../lib/queue'
import { getInternalAppOrigin, isValidPdfUpload, isWithinRateLimit } from '../../../../lib/security'

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth()
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!isWithinRateLimit(`personal-evaluation:${userId}`, 5, 60_000)) {
      return NextResponse.json({ error: 'Too many evaluation requests. Please wait a minute and try again.' }, { status: 429 })
    }

    await dbConnect()

    const formData = await request.formData()
    const file = formData.get('file') as File
    const domain = formData.get('domain') as string
    const description = (formData.get('description') as string | null) ?? ''


    if (!file) {
      return NextResponse.json({ error: 'File is required' }, { status: 400 })
    }
    
    if (!domain || domain.length > 100 || description.length > 2000) {
      return NextResponse.json({ error: 'Domain is required' }, { status: 400 })
    }
    
    // Validate file type
    if (!await isValidPdfUpload(file)) {
      return NextResponse.json({ error: 'Upload a valid PDF smaller than 10MB' }, { status: 400 })
    }

    // Create evaluation record
    const evaluation = new Evaluation({
      userId,
      type: 'personal',
      fileName: file.name,
      domain,
      description,
      status: 'queued', // Changed from 'processing' to 'queued'
    })

    await evaluation.save()

    // Convert file to buffer for queue
    const fileBuffer = Buffer.from(await file.arrayBuffer())
    
    // Add job to queue instead of direct processing
    const job: PersonalEvaluationJob = {
      type: 'personal',
      evaluationId: evaluation._id.toString(),
      userId,
      fileName: file.name,
      fileBuffer: fileBuffer.toString('base64'),
      domain,
      description
    }

    // Smart processing strategy: Queue first, fallback to direct
    const internalOrigin = getInternalAppOrigin()
    const useQueue = process.env.RABBITMQ_URL && process.env.INTERNAL_API_SECRET && internalOrigin && !process.env.DISABLE_QUEUE
    
    if (useQueue && internalOrigin) {
      try {
        await addToQueue(QUEUES.PERSONAL_EVALUATION, job, 8)
        
        // Trigger queue processing (event-driven, non-blocking)
        const triggerUrl = new URL('/api/queue/trigger', internalOrigin)
        fetch(triggerUrl.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-api-secret': process.env.INTERNAL_API_SECRET
          },
          body: JSON.stringify({ 
            queueName: QUEUES.PERSONAL_EVALUATION,
            maxJobs: 5
          })
        }).catch(error => {
          console.error('Failed to trigger queue processing:', error)
        })

        return NextResponse.json({ 
          evaluationId: evaluation._id.toString(),
          message: 'File uploaded successfully. Added to processing queue...',
          status: 'queued'
        })
        
      } catch (queueError) {
        // Queue unavailable, using direct processing
      }
    }
    
    // Fallback: Direct processing (for Vercel or when queue unavailable)
    // Direct processing mode
    const { processPersonalEvaluation } = await import('../../../../lib/processors/evaluationProcessor')
    
    // Process in background (don't await to avoid timeout)
    processPersonalEvaluation(job).catch(error => {
      console.error('Direct processing failed:', error)
      // Update evaluation status to failed
      import('../../../../lib/mongodb').then(({ default: dbConnect }) => {
        dbConnect().then(() => {
          import('../../../../lib/models/Evaluation').then(({ default: Evaluation }) => {
            Evaluation.findByIdAndUpdate(job.evaluationId, {
              status: 'failed',
              updatedAt: new Date()
            }).catch(console.error)
          })
        })
      })
    })

    return NextResponse.json({ 
      evaluationId: evaluation._id.toString(),
      message: 'File uploaded successfully. Processing started...',
      status: 'processing'
    })

  } catch (error) {
    console.error('Personal evaluation error:', error)
    return NextResponse.json({ 
      error: 'Internal server error', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    }, { status: 500 })
  }
}

// Note: File processing is now handled by the queue worker
// See lib/processors/evaluationProcessor.ts for the actual processing logic
