import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import dbConnect from '../../../../lib/mongodb'
import Hackathon from '../../../../lib/models/Hackathon'
import Evaluation from '../../../../lib/models/Evaluation'
import TemplateAnalysis from '../../../../lib/models/TemplateAnalysis'
import { addToQueue, QUEUES, HackathonEvaluationJob } from '../../../../lib/queue'
import { analyzeTemplateStructure } from '../../../../lib/ai/templateAnalysis'
import { v4 as uuidv4 } from 'uuid'
import { getInternalAppOrigin, hasValidWeights, isValidPdfUpload, isWithinRateLimit, MAX_HACKATHON_FILES } from '../../../../lib/security'

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth()
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!isWithinRateLimit(`hackathon-evaluation:${userId}`, 2, 10 * 60_000)) {
      return NextResponse.json({ error: 'Too many bulk evaluation requests. Please wait before starting another batch.' }, { status: 429 })
    }

    await dbConnect()

    const formData = await request.formData()
    const hackathonName = (formData.get('hackathonName') as string | null) ?? ''
    const tracks = (formData.get('tracks') as string | null) ?? ''
    const additionalInfo = (formData.get('additionalInfo') as string | null) ?? ''
    let weights: unknown
    try {
      weights = JSON.parse(formData.get('weights') as string)
    } catch {
      return NextResponse.json({ error: 'Invalid scoring weights' }, { status: 400 })
    }

    
    // Handle template upload
    const templateFile = formData.get('templateFile') as File | null
    const templateAnalysisData = formData.get('templateAnalysis') as string | null
    
    const files = formData.getAll('files') as File[]

    if (!hackathonName.trim() || hackathonName.length > 120 || tracks.length > 1000 || additionalInfo.length > 2000 || files.length === 0 || files.length > MAX_HACKATHON_FILES || !hasValidWeights(weights)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (!(await Promise.all(files.map(file => isValidPdfUpload(file)))).every(Boolean)) {
      return NextResponse.json({ error: 'Every submission must be a valid PDF smaller than 10MB' }, { status: 400 })
    }

    if (templateFile && !await isValidPdfUpload(templateFile)) {
      return NextResponse.json({ error: 'The template must be a valid PDF smaller than 10MB' }, { status: 400 })
    }

    if (templateAnalysisData && templateAnalysisData.length > 50_000) {
      return NextResponse.json({ error: 'Template analysis payload is too large' }, { status: 400 })
    }

    // Process template if provided
    let templateAnalysisId: string | null = null
    let parsedTemplateAnalysis = null
    
    if (templateFile && templateAnalysisData) {
      try {
        parsedTemplateAnalysis = JSON.parse(templateAnalysisData)
        
        // Create template analysis record
        const templateAnalysis = new TemplateAnalysis({
          hackathonId: '', // Will be set after hackathon is created
          userId,
          templateFileName: templateFile.name,
          structure: parsedTemplateAnalysis.structure,
          theme: parsedTemplateAnalysis.theme,
          additionalContext: parsedTemplateAnalysis.additionalContext,
          fingerprint: parsedTemplateAnalysis.fingerprint,
        })
        
        await templateAnalysis.save()
        templateAnalysisId = templateAnalysis._id.toString()
      } catch (error) {
        console.error('Failed to save template analysis:', error)
        console.log(`⚠️ Continuing hackathon creation without template analysis for: ${hackathonName}`)
        // Continue without template analysis if it fails - system remains functional
      }
    } else if (templateFile) {
      // If template file is provided but no analysis, analyze it now
      try {
        const analysis = await analyzeTemplateStructure(templateFile, additionalInfo || undefined)
        
        const templateAnalysis = new TemplateAnalysis({
          hackathonId: '', // Will be set after hackathon is created
          userId,
          templateFileName: templateFile.name,
          structure: analysis.structure,
          theme: analysis.theme,
          additionalContext: analysis.additionalContext,
          fingerprint: analysis.fingerprint,
        })
        
        await templateAnalysis.save()
        templateAnalysisId = templateAnalysis._id.toString()
        parsedTemplateAnalysis = analysis
        
        console.log(`✅ Template analysis completed for hackathon: ${hackathonName}`)
      } catch (error) {
        console.error('Failed to analyze template:', error)
        console.log(`⚠️ Continuing hackathon creation without template analysis for: ${hackathonName}`)
        // Continue without template analysis if it fails - system remains functional
      }
    }

    // Create hackathon record
    const hackathon = new Hackathon({
      userId,
      name: hackathonName,
      tracks: tracks.split(',').map(t => t.trim()).filter(Boolean),
      weights,
      additionalInfo,
      status: 'processing',
      templateAnalysis: templateAnalysisId || undefined,
    })

    await hackathon.save()
    
    // Update template analysis with hackathon ID
    if (templateAnalysisId) {
      await TemplateAnalysis.findByIdAndUpdate(templateAnalysisId, {
        hackathonId: hackathon._id.toString()
      })
    }

    // Generate batch ID for tracking
    const batchId = uuidv4()
    const internalOrigin = getInternalAppOrigin()
    const useQueue = Boolean(process.env.RABBITMQ_URL && process.env.INTERNAL_API_SECRET && internalOrigin && !process.env.DISABLE_QUEUE)

    // Create evaluation records and queue jobs for each file
    const evaluationPromises = files.map(async (file, index) => {
      const evaluation = new Evaluation({
        userId,
        type: 'hackathon',
        fileName: file.name,
        domain: 'hackathon',
        hackathonId: hackathon._id.toString(),
        status: 'queued', // Changed from 'processing' to 'queued'
      })
      
      await evaluation.save()
      
      // Convert file to buffer for queue
      const fileBuffer = Buffer.from(await file.arrayBuffer())
      
      // Create job for queue
      const job: HackathonEvaluationJob = {
        type: 'hackathon',
        evaluationId: evaluation._id.toString(),
        hackathonId: hackathon._id.toString(),
        userId,
        fileName: file.name,
        fileBuffer: fileBuffer.toString('base64'),
        weights,
        batchId,

        templateAnalysisId: templateAnalysisId || undefined,
        templateAnalysis: parsedTemplateAnalysis || undefined,
        includeTemplateValidation: templateAnalysisId ? true : false
      }

      if (useQueue) {
        const priority = Math.max(1, 10 - index)
        await addToQueue(QUEUES.HACKATHON_EVALUATION, job, priority)
      } else {
        const { processHackathonEvaluation } = await import('../../../../lib/processors/evaluationProcessor')
        processHackathonEvaluation(job).catch(error => console.error('Direct hackathon processing failed:', error))
      }
      
      return evaluation._id.toString()
    })

    const evaluationIds = await Promise.all(evaluationPromises)
    
    // Update hackathon with evaluation IDs
    hackathon.evaluations = evaluationIds
    await hackathon.save()

    if (useQueue && internalOrigin) {
      const triggerUrl = new URL('/api/queue/trigger', internalOrigin)
      fetch(triggerUrl.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-api-secret': process.env.INTERNAL_API_SECRET || ''
        },
        body: JSON.stringify({ queueName: QUEUES.HACKATHON_EVALUATION, maxJobs: Math.min(files.length, 10) })
      }).catch(error => console.error('Failed to trigger bulk queue processing:', error))
    }

    return NextResponse.json({ 
      hackathonId: hackathon._id.toString(),
      batchId,
      totalFiles: files.length,
      message: useQueue ? `${files.length} files uploaded successfully. Added to processing queue...` : `${files.length} files uploaded successfully. Processing started...`,
      status: useQueue ? 'queued' : 'processing'
    })

  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Note: File processing is now handled by the queue worker
// See lib/processors/evaluationProcessor.ts for the actual processing logic
